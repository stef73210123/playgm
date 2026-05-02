/**
 * cardScanLimiter.ts — per-(user, UTC day) cap enforcement for /cards/scan.
 *
 * Mirrors askScoutLimiter — both features hit Anthropic and need the same
 * read → cap-check → upsert dance. Both are implemented as thin wrappers
 * over the generic `dailyCapLimiter` (see `./dailyCapLimiter.ts`).
 *
 * Caps live in `data/economy/pgm_subscriptions.json#card_scan_daily_cap`
 *   free: 2 / starter: 5 / playmaker: 10 / champion: 20.
 *
 * Authoritative state is the `card_scan_usage` table (see
 * `server/migrations/001_v1_schema.sql` and `003_card_scan_usage.sql`).
 * Each request UPSERTs (user_id, ymd) with count + 1 RETURNING count, so
 * concurrent vision calls can't both squeeze through the cap.
 *
 * The 429 envelope from /cards/scan uses the discriminator
 *   error.code = "CARD_SCAN_DAILY_CAP"
 * and headers
 *   X-CardScan-Cap, X-CardScan-Remaining, X-CardScan-ResetsAt
 * mirroring the Ask Scout pattern, so the client surface is identical.
 */
import { getCardScanDailyCap } from '../economy/subscriptions.js';
import {
  createDailyCapLimiter,
  utcYmd,
  nextUtcMidnightIso,
  type LimiterDecision,
} from './dailyCapLimiter.js';

const limiter = createDailyCapLimiter({
  featureId: 'card_scan',
  tableName: 'card_scan_usage',
  resolveCap: getCardScanDailyCap,
  errorCode: 'CARD_SCAN_DAILY_CAP',
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
