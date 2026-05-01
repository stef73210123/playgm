/**
 * Server mirror of `src/economy/earnRates.ts`. Authoritative on PP awards
 * because the client UI is informational only — the server records the
 * actual ledger entries.
 */

import { loadEarnRatesSpec } from './loader.js';
import type { EarnRatesSpec, SubscriptionTierId } from './types.js';

let cachedSpec: EarnRatesSpec | null = null;

export function buildEarnRates(raw: unknown): EarnRatesSpec {
  const spec = raw as EarnRatesSpec;
  if (!spec.roster_performance || !spec.daily_engagement) {
    throw new Error('earnRates: missing roster_performance or daily_engagement');
  }
  return spec;
}

function getSpec(): EarnRatesSpec {
  if (!cachedSpec) cachedSpec = buildEarnRates(loadEarnRatesSpec());
  return cachedSpec;
}

type DailyEngagementKey = keyof EarnRatesSpec['daily_engagement'];
type RosterPerformanceKey = Exclude<
  keyof EarnRatesSpec['roster_performance'],
  'performance_bonus_stack_rule'
>;

export type ActivityKey =
  | DailyEngagementKey
  | RosterPerformanceKey
  | 'subscription_daily_boost';

export interface EarnContext {
  subscriptionTier?: SubscriptionTierId;
}

export function getEarnAmount(
  activityKey: ActivityKey,
  context: EarnContext = {},
): number {
  const spec = getSpec();
  if (activityKey === 'subscription_daily_boost') {
    const tier = context.subscriptionTier ?? 'free';
    return spec.subscription_daily_boost[tier] ?? 0;
  }
  if (activityKey in spec.daily_engagement) {
    return spec.daily_engagement[activityKey as DailyEngagementKey];
  }
  if (activityKey in spec.roster_performance) {
    const v = spec.roster_performance[activityKey as RosterPerformanceKey];
    return typeof v === 'number' ? v : 0;
  }
  return 0;
}

export function resolvePerformanceBundle(
  activityKeys: ActivityKey[],
  context: EarnContext = {},
): number {
  const spec = getSpec();
  const rule = spec.roster_performance.performance_bonus_stack_rule;
  let perfMax = 0;
  let perfStack = 0;
  let stackable = 0;
  for (const k of activityKeys) {
    const amt = getEarnAmount(k, context);
    const keyStr = String(k);
    if (keyStr in spec.roster_performance && keyStr !== 'performance_bonus_stack_rule') {
      if (amt > perfMax) perfMax = amt;
      perfStack += amt;
    } else {
      stackable += amt;
    }
  }
  const perf = rule === 'highest_only_no_stack' ? perfMax : perfStack;
  return perf + stackable;
}

export function __setSpecForTests(spec: EarnRatesSpec | null): void {
  cachedSpec = spec;
}
