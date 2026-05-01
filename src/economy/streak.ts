/**
 * Server mirror of `src/economy/streak.ts`. Same upgrade rules: Champion
 * upgrades every reward, Playmaker only on days 7/14/21/30.
 */

import { loadStreakRewardsSpec } from './loader.js';
import type {
  StreakRewardEntry,
  StreakRewardsSpec,
  SubscriptionTierId,
} from './types.js';

let cachedSpec: StreakRewardsSpec | null = null;

export function buildStreakRewards(raw: unknown): StreakRewardsSpec {
  const spec = raw as StreakRewardsSpec;
  if (!Array.isArray(spec.streak_rewards) || spec.streak_rewards.length === 0) {
    throw new Error('streak: streak_rewards[] missing');
  }
  if (!spec.post_30_recurrence) throw new Error('streak: post_30_recurrence missing');
  return spec;
}

function getSpec(): StreakRewardsSpec {
  if (!cachedSpec) cachedSpec = buildStreakRewards(loadStreakRewardsSpec());
  return cachedSpec;
}

const PACK_TIER_LADDER = ['rookie_pack', 'pro_pack', 'all_star_pack', 'mvp_pack'] as const;

function upgradeOnePackTier(packId: string): string {
  const idx = PACK_TIER_LADDER.indexOf(packId as (typeof PACK_TIER_LADDER)[number]);
  if (idx < 0) return packId;
  return PACK_TIER_LADDER[Math.min(idx + 1, PACK_TIER_LADDER.length - 1)] ?? packId;
}

const PLAYMAKER_BOOST_DAYS = new Set([7, 14, 21, 30]);

export function getStreakReward(
  day: number,
  subscriptionTier: SubscriptionTierId,
): StreakRewardEntry | null {
  if (day <= 0) return null;
  const spec = getSpec();
  let baseEntry: StreakRewardEntry | null =
    spec.streak_rewards.find((e) => e.day === day) ?? null;
  if (!baseEntry && day > 30) {
    const interval = spec.post_30_recurrence.interval_days;
    if (interval > 0 && (day - 30) % interval === 0) {
      baseEntry = {
        day,
        pack_id: spec.post_30_recurrence.pack_id,
        bonus_pp: 0,
        bonus_tokens: 0,
      };
    }
  }
  if (!baseEntry) return null;
  const shouldUpgrade =
    subscriptionTier === 'champion' ||
    (subscriptionTier === 'playmaker' && PLAYMAKER_BOOST_DAYS.has(day));
  if (!shouldUpgrade) return baseEntry;
  return { ...baseEntry, pack_id: upgradeOnePackTier(baseEntry.pack_id) };
}

export function listScheduledDays(): number[] {
  return getSpec().streak_rewards.map((e) => e.day).sort((a, b) => a - b);
}

export function __setSpecForTests(spec: StreakRewardsSpec | null): void {
  cachedSpec = spec;
}
