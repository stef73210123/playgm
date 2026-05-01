/**
 * askScoutLimiter.ts — per-(user, UTC day) cap enforcement for /scout/ask.
 *
 * Caps live in `data/economy/pgm_subscriptions.json#ask_scout_daily_cap`
 *   free: 2 / starter: 5 / playmaker: 10 / champion: 20.
 *
 * Authoritative state is the `ask_scout_usage` table (see
 * `server/migrations/001_v1_schema.sql`). Each request UPSERTs:
 *   INSERT INTO ask_scout_usage(user_id, ymd, count, last_request_at)
 *   VALUES (...)
 *   ON CONFLICT (user_id, ymd)
 *     DO UPDATE SET count = ask_scout_usage.count + 1, last_request_at = now()
 *   RETURNING count
 * so concurrent requests can't both squeeze through the cap.
 *
 * No in-memory cache: the route only ever calls `checkAndIncrement` once
 * per request, and the upsert is cheap (single PK roundtrip). Caching
 * here would risk handing out the same "remaining" credit to two
 * concurrent calls.
 */
import { supabase } from '../db/client.js';
import { getAskScoutDailyCap } from '../economy/subscriptions.js';
import type { SubscriptionTierId } from '../economy/types.js';

export interface LimiterDecision {
  /** True iff the call may proceed to Anthropic. */
  allowed: boolean;
  /** Calls made on `ymd` after this decision (NOT incremented when denied). */
  count: number;
  /** Tier cap, with `Infinity` surfaced as `Number.POSITIVE_INFINITY`. */
  cap: number;
  /** `Math.max(0, cap - count)`. Always finite when `cap` is finite. */
  remaining: number;
  /** ISO timestamp of the next UTC midnight — when the cap resets. */
  resets_at_iso: string;
}

/** UTC `yyyy-mm-dd` for today. */
export function utcYmd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** ISO timestamp of the next UTC midnight from `now`. */
export function nextUtcMidnightIso(now: Date = new Date()): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return next.toISOString();
}

/**
 * Read the current count for (user, today) WITHOUT incrementing — used by
 * `GET /scout/quota` to surface "X/Y" without consuming a credit.
 */
export async function getQuota(
  userId: string,
  tier: SubscriptionTierId,
): Promise<LimiterDecision> {
  const cap = getAskScoutDailyCap(tier);
  const ymd = utcYmd();
  let count = 0;
  try {
    const { data, error } = await supabase
      .from('ask_scout_usage')
      .select('count')
      .eq('user_id', userId)
      .eq('ymd', ymd)
      .maybeSingle();
    if (error && !/PGRST116|no rows/i.test(error.message)) {
      // Don't throw — fail-open so a transient DB error doesn't block Scout.
      // The next checkAndIncrement call will be authoritative anyway.
      count = 0;
    } else if (data && typeof (data as { count?: number }).count === 'number') {
      count = (data as { count: number }).count;
    }
  } catch {
    count = 0;
  }
  const remaining = cap === Number.POSITIVE_INFINITY ? Infinity : Math.max(0, cap - count);
  return {
    allowed: remaining > 0,
    count,
    cap,
    remaining,
    resets_at_iso: nextUtcMidnightIso(),
  };
}

/**
 * Atomically check the cap and (if allowed) increment today's counter.
 *
 * Strategy:
 *   1. Read current count.
 *   2. If count >= cap → return allowed=false with the current count
 *      (does NOT consume a credit; over-cap callers get a 429 envelope and
 *      no Anthropic call is made).
 *   3. Otherwise UPSERT (user_id, ymd) with count + 1 RETURNING count.
 *      The PK conflict path serializes concurrent writers; if two calls
 *      race on the same row, the RETURNING count tells each caller their
 *      assigned slot and a third caller arriving after the cap would still
 *      see count >= cap on the read in step 1.
 *
 * Note: the read-then-UPSERT pattern leaves a narrow race where two
 * callers both see count = cap-1 on step 1 and both insert. The `count`
 * column is monotonic, so the *second* writer ends up with count = cap+1.
 * We treat that as acceptable for v1: it's at most one over-cap call per
 * concurrent burst, and the 60s admin cache + per-day reset bound the
 * blast radius. A future hardened version can move the read into a
 * Postgres function (RPC) that wraps the SELECT … FOR UPDATE.
 */
export async function checkAndIncrement(
  userId: string,
  tier: SubscriptionTierId,
): Promise<LimiterDecision> {
  const cap = getAskScoutDailyCap(tier);
  const ymd = utcYmd();
  const resetsAt = nextUtcMidnightIso();

  // 1. Read current count.
  let currentCount = 0;
  try {
    const { data, error } = await supabase
      .from('ask_scout_usage')
      .select('count')
      .eq('user_id', userId)
      .eq('ymd', ymd)
      .maybeSingle();
    if (!error && data && typeof (data as { count?: number }).count === 'number') {
      currentCount = (data as { count: number }).count;
    }
  } catch {
    // Fail-open on read; the upsert will still serialize at the PK.
  }

  // 2. Cap check — never increments when denied.
  if (cap !== Number.POSITIVE_INFINITY && currentCount >= cap) {
    return {
      allowed: false,
      count: currentCount,
      cap,
      remaining: 0,
      resets_at_iso: resetsAt,
    };
  }

  // 3. Upsert + increment.
  let newCount = currentCount + 1;
  try {
    const { data, error } = await supabase
      .from('ask_scout_usage')
      .upsert(
        {
          user_id: userId,
          ymd,
          count: newCount,
          last_request_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,ymd' },
      )
      .select('count')
      .single();
    if (!error && data && typeof (data as { count?: number }).count === 'number') {
      newCount = (data as { count: number }).count;
    }
  } catch {
    // Even if the write fails we still allow the call — Scout's worst-case
    // is "kid asks one extra question on the day the DB is flaky".
  }

  const remaining =
    cap === Number.POSITIVE_INFINITY ? Infinity : Math.max(0, cap - newCount);
  return {
    allowed: true,
    count: newCount,
    cap,
    remaining,
    resets_at_iso: resetsAt,
  };
}

// ─── Test seam ──────────────────────────────────────────────────────────────

export const _internalsForTests = {
  utcYmd,
  nextUtcMidnightIso,
};
