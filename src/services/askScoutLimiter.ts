/**
 * askScoutLimiter.ts — per-(user, UTC day) cap enforcement for /scout/ask.
 *
 * Thin wrapper over the generic `dailyCapLimiter` (see `./dailyCapLimiter.ts`).
 * Caps live in `data/economy/pgm_subscriptions.json#ask_scout_daily_cap`
 *   free: 2 / starter: 5 / playmaker: 10 / champion: 20.
 *
 * Authoritative state is the `ask_scout_usage` table (see
 * `server/migrations/001_v1_schema.sql`). Each request UPSERTs
 *   INSERT INTO ask_scout_usage(user_id, ymd, count, last_request_at)
 *   VALUES (...) ON CONFLICT (user_id, ymd) DO UPDATE SET count = count + 1
 *   RETURNING count
 * so concurrent requests can't both squeeze through the cap.
 *
 * The public surface (`checkAndIncrement`, `getQuota`, `LimiterDecision`,
 * `_internalsForTests`) is preserved verbatim so the existing
 * `askScoutLimiter.test.ts` keeps passing without changes — the refactor
 * is internal-only.
 */
import { getAskScoutDailyCap } from '../economy/subscriptions.js';
import {
  createDailyCapLimiter,
  utcYmd,
  nextUtcMidnightIso,
  type LimiterDecision,
} from './dailyCapLimiter.js';

const limiter = createDailyCapLimiter({
  featureId: 'ask_scout',
  tableName: 'ask_scout_usage',
  resolveCap: getAskScoutDailyCap,
  errorCode: 'ASK_SCOUT_DAILY_CAP',
});

export type { LimiterDecision };

export { utcYmd, nextUtcMidnightIso };

export const checkAndIncrement = limiter.checkAndIncrement;
export const getQuota = limiter.getQuota;

// ─── Test seam ──────────────────────────────────────────────────────────────

export const _internalsForTests = {
  utcYmd,
  nextUtcMidnightIso,
};
