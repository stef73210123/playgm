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

export function listTiers(): SubscriptionTierSpec[] {
  return [...getSpec().tiers];
}

export function __setSpecForTests(spec: SubscriptionsSpec | null): void {
  cachedSpec = spec;
}
