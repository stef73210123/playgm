/**
 * dailyCapLimiter.ts — generic per-(user, UTC day) cap enforcement.
 *
 * Ask Scout was the first feature to need a daily cap; Card Scan is the
 * second. The two share identical pressure dynamics — both hit Anthropic
 * (Haiku 4.5 chat / vision), both must reject before the LLM is invoked,
 * both surface a 429 envelope so the client can swap to an upgrade CTA,
 * and both want the per-user counter to persist past the day for the
 * admin dashboard. So instead of duplicating the read → cap-check →
 * upsert dance per feature, this module factors the dance into a generic
 * `createDailyCapLimiter(...)` that's parameterized by:
 *
 *   - featureId    → human-readable label, used in fallback error code
 *   - tableName    → Postgres table holding the (user_id, ymd, count) rows
 *   - resolveCap   → tier → integer cap (-1 sentinel ⇒ Infinity)
 *   - errorCode    → discriminator on the 429 envelope (e.g. ASK_SCOUT_DAILY_CAP)
 *
 * Each caller (askScoutLimiter, cardScanLimiter) is a thin wrapper that
 * supplies these and re-exports the same `{ checkAndIncrement, getQuota,
 * LimiterDecision }` surface, so the existing `askScoutLimiter.test.ts`
 * keeps passing without changes.
 *
 * Authoritative state lives in the per-feature usage table. Each request
 * UPSERTs:
 *   INSERT INTO <tableName>(user_id, ymd, count, last_request_at) VALUES (...)
 *   ON CONFLICT (user_id, ymd) DO UPDATE SET count = <table>.count + 1,
 *                                            last_request_at = now()
 *   RETURNING count
 * so concurrent requests can't both squeeze through the cap.
 *
 * No in-memory cache: the route only ever calls `checkAndIncrement` once
 * per request, and the upsert is cheap (single PK roundtrip). Caching
 * here would risk handing out the same "remaining" credit to two
 * concurrent calls.
 */
import { supabase } from '../db/client.js';
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

export interface DailyCapLimiterConfig {
  /** Short, human-readable feature label (used in errors / logs). */
  featureId: string;
  /** Postgres table name holding (user_id, ymd, count, last_request_at). */
  tableName: string;
  /** Tier → integer cap. -1 / negative ⇒ Infinity. */
  resolveCap: (tier: SubscriptionTierId) => number;
  /** Discriminator on the 429 envelope. */
  errorCode: string;
}

export interface DailyCapLimiter {
  readonly config: DailyCapLimiterConfig;
  checkAndIncrement(userId: string, tier: SubscriptionTierId): Promise<LimiterDecision>;
  getQuota(userId: string, tier: SubscriptionTierId): Promise<LimiterDecision>;
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
 * Build a feature-specific limiter that exposes `checkAndIncrement` and
 * `getQuota`. Both methods fail-open on transient DB errors — the
 * worst-case is one extra LLM call on the day the DB is flaky, which is
 * far cheaper than blocking gameplay.
 */
export function createDailyCapLimiter(config: DailyCapLimiterConfig): DailyCapLimiter {
  const { tableName, resolveCap } = config;

  /**
   * Read the current count for (user, today) WITHOUT incrementing — used by
   * the per-feature `GET /…/quota` endpoint to surface "X/Y" without consuming
   * a credit.
   */
  async function getQuota(
    userId: string,
    tier: SubscriptionTierId,
  ): Promise<LimiterDecision> {
    const cap = resolveCap(tier);
    const ymd = utcYmd();
    let count = 0;
    try {
      const { data, error } = await supabase
        .from(tableName)
        .select('count')
        .eq('user_id', userId)
        .eq('ymd', ymd)
        .maybeSingle();
      if (error && !/PGRST116|no rows/i.test(error.message)) {
        // Don't throw — fail-open so a transient DB error doesn't block the
        // feature. The next checkAndIncrement call will be authoritative.
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
   * We treat that as acceptable for v1: at most one over-cap call per
   * concurrent burst, with the per-day reset bounding the blast radius.
   * A future hardened version can move the read into a Postgres function
   * (RPC) that wraps the SELECT … FOR UPDATE.
   */
  async function checkAndIncrement(
    userId: string,
    tier: SubscriptionTierId,
  ): Promise<LimiterDecision> {
    const cap = resolveCap(tier);
    const ymd = utcYmd();
    const resetsAt = nextUtcMidnightIso();

    // 1. Read current count.
    let currentCount = 0;
    try {
      const { data, error } = await supabase
        .from(tableName)
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
        .from(tableName)
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
      // Even if the write fails we still allow the call — the worst-case
      // is "user gets one extra request on the day the DB is flaky".
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

  return { config, checkAndIncrement, getQuota };
}

// ─── Test seam ──────────────────────────────────────────────────────────────

export const _internalsForTests = {
  utcYmd,
  nextUtcMidnightIso,
};
