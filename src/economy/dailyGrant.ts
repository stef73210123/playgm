/**
 * Server mirror of `src/economy/dailyGrant.ts`. Keeps the daily PP grant
 * computation identical between client (which fires the optimistic
 * addPlayPoints update) and server (which records the canonical
 * pp_events row via /me/pp/credit).
 */

import { getEarnAmount } from './earnRates.js';
import type { SubscriptionTierId } from './types.js';

export function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function computeDailyPpGrant(
  tier: SubscriptionTierId,
  lastClaimIso: string | null | undefined,
  now: Date = new Date(),
): number {
  if (lastClaimIso) {
    const last = new Date(lastClaimIso);
    if (!Number.isNaN(last.getTime()) && dayKey(last) === dayKey(now)) {
      return 0;
    }
  }
  return getEarnAmount('subscription_daily_boost', { subscriptionTier: tier });
}
