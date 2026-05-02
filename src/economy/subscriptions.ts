/**
 * Server mirror of `src/economy/subscriptions.ts`. Used to gate roster
 * creation, validate cap-mode draft entitlement, and grant monthly pack
 * allocations on renewal.
 */

import { loadSubscriptionsSpec } from './loader.js';
import type {
  SubscriptionPackAllocation,
  SubscriptionTierId,
  SubscriptionTierSpec,
  SubscriptionsSpec,
} from './types.js';

let cachedSpec: SubscriptionsSpec | null = null;

export function buildSubscriptions(raw: unknown): SubscriptionsSpec {
  const spec = raw as SubscriptionsSpec;
  if (!Array.isArray(spec.tiers) || spec.tiers.length === 0) {
    throw new Error('subscriptions: tiers[] missing or empty');
  }
  return spec;
}

function getSpec(): SubscriptionsSpec {
  if (!cachedSpec) cachedSpec = buildSubscriptions(loadSubscriptionsSpec());
  return cachedSpec;
}

export function getSubscription(tierId: SubscriptionTierId): SubscriptionTierSpec {
  const found = getSpec().tiers.find((t) => t.tier_id === tierId);
  if (!found) throw new Error(`subscriptions: unknown tier_id "${tierId}"`);
  return found;
}

export function getMonthlyPackAllocation(
  tierId: SubscriptionTierId,
): SubscriptionPackAllocation[] {
  return getSubscription(tierId).monthly_pack_allocation;
}

export function getDailyBoost(tierId: SubscriptionTierId): number {
  return getSubscription(tierId).daily_pp_boost;
}

export function getInventoryCap(tierId: SubscriptionTierId): number {
  const cap = getSubscription(tierId).card_inventory_cap;
  return cap < 0 ? Number.POSITIVE_INFINITY : cap;
}

/**
 * Maximum Ask Scout LLM questions per UTC day. -1 sentinel → Infinity.
 * Used by server/src/services/askScoutLimiter.ts to gate /scout/ask before
 * the call hits Anthropic.
 */
export function getAskScoutDailyCap(tierId: SubscriptionTierId): number {
  const cap = getSubscription(tierId).ask_scout_daily_cap;
  return cap < 0 ? Number.POSITIVE_INFINITY : cap;
}

/**
 * Maximum Card Scan vision calls per UTC day. -1 sentinel → Infinity.
 * Used by server/src/services/cardScanLimiter.ts to gate /cards/scan before
 * the call hits Anthropic Haiku 4.5 vision. Marginal cost per scan is
 * ~$0.003-0.005 (image bytes + JSON output) so the cap doubles as cost
 * containment + upgrade pressure for the Free tier.
 */
export function getCardScanDailyCap(tierId: SubscriptionTierId): number {
  const cap = getSubscription(tierId).card_scan_daily_cap;
  return cap < 0 ? Number.POSITIVE_INFINITY : cap;
}

export function listTiers(): SubscriptionTierSpec[] {
  return [...getSpec().tiers];
}

export function __setSpecForTests(spec: SubscriptionsSpec | null): void {
  cachedSpec = spec;
}
