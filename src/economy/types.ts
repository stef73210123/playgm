/**
 * Shared types for the server economy / card runtime modules.
 *
 * Mirrors `src/economy/types.ts` on the client. Kept duplicated rather
 * than cross-imported because the server's `rootDir` is `.` (server/) and
 * importing across the boundary would either drag in client deps or
 * require a tsconfig refactor we're not doing in this pass.
 */

export type ContestType =
  | 'alliance'
  | 'regional_alliance'
  | 'regional_external'
  | 'themed_external'
  | 'national'
  | 'championship';

export interface Tier {
  level: number;
  name: string;
  pp_threshold: number;
  color: string;
}

export interface ProgressionSpec {
  version: string;
  tiers: Tier[];
  tier_up_bonus_pp: number;
  contest_gating: Record<ContestType, number>;
}

export type SubscriptionTierId = 'free' | 'starter' | 'playmaker' | 'champion';

export interface EarnRatesSpec {
  version: string;
  roster_performance: {
    roster_scored_base: number;
    best_of_week_bonus: number;
    h2h_alliance_win: number;
    h2h_alliance_loss: number;
    h2h_alliance_tie: number;
    top_25_pct_bonus: number;
    top_10_pct_bonus: number;
    alliance_first_place_bonus: number;
    alliance_contest_win: number;
    regional_contest_top_10: number;
    national_contest_top_10: number;
    tier_up_bonus: number;
    performance_bonus_stack_rule: 'highest_only_no_stack' | 'stack';
  };
  daily_engagement: {
    daily_login: number;
    playpicks_correct: number;
    playpicks_incorrect_answered: number;
    trivia_easy_correct: number;
    trivia_medium_correct: number;
    trivia_hard_correct: number;
    trivia_5_streak_bonus: number;
    practice_draft_completion: number;
  };
  subscription_daily_boost: Record<SubscriptionTierId, number>;
}

export interface SubscriptionPackAllocation {
  pack_id: string;
  count: number;
}

/**
 * Snake = positional draft, single round of pick rotation. Cap = auction-style
 * salary-cap draft (GDD §4). Free tier is restricted to snake; all paid tiers
 * unlock both. Server enforces the gate at draft creation time
 * (practice-drafts + rosters routes).
 */
export type DraftMode = 'snake' | 'cap';

/**
 * Granularity of practice-draft snake-position control:
 *   - none           — auto-assigned, no influence
 *   - random         — re-roll button only
 *   - preferred_slot — soft preference, server best-effort honors
 *   - exact_slot     — hard pin to a specific slot (Champion)
 */
export type DraftPositionControl =
  | 'none'
  | 'random'
  | 'preferred_slot'
  | 'exact_slot';

export interface SubscriptionTierSpec {
  tier_id: SubscriptionTierId;
  name: string;
  monthly_price_usd: number;
  rosters_per_week: number;
  /**
   * Practice drafts allowed per UTC day. -1 = unlimited.
   * Per-day allowance (was per-week before May 2026 rebalance).
   */
  practice_drafts_per_day: number;
  /** Legacy boolean — true if cap is in `draft_modes`. New code: branch on `draft_modes`. */
  cap_mode: boolean;
  /** Allowed draft modes for this tier. Free = ['snake']; paid = ['snake','cap']. */
  draft_modes: DraftMode[];
  /** Free-agent pool size per roster per week (GDD §3.E). */
  fa_pool_size_per_week: number;
  /** Practice-draft slot-picker granularity per tier — see DraftPositionControl. */
  draft_position_control: DraftPositionControl;
  /**
   * Maximum kid profiles a single subscription can host. v2 keeps this at 1
   * for every tier — Family-tier handling deferred until Champion adoption
   * signals real demand for multi-account households.
   */
  family_max_profiles: number;
  monthly_pack_allocation: SubscriptionPackAllocation[];
  card_inventory_cap: number;
  /**
   * Daily PP allowance granted on first login each UTC day. v2 reframes this
   * from "boost on top of base" into the headline daily allowance each tier
   * advertises (200 / 500 / 1000 / 2000). Field name preserved for backward
   * compatibility with earnRates / wallet code.
   */
  daily_pp_boost: number;
  /**
   * Maximum Ask Scout LLM questions per UTC day. 0 = blocked, -1 = unlimited.
   * Bound at the /scout/ask route via askScoutLimiter so over-cap requests
   * never reach Anthropic. v1 caps: free 2 / starter 5 / playmaker 10 /
   * champion 20 — sized to keep marginal Haiku cost negligible while
   * making the upgrade pressure on Free tangible.
   */
  ask_scout_daily_cap: number;
  /**
   * Maximum Card Scan vision calls per UTC day. 0 = blocked, -1 = unlimited.
   * Bound at the /cards/scan route via cardScanLimiter so over-cap requests
   * never reach Anthropic. v1 caps: free 2 / starter 5 / playmaker 10 /
   * champion 20 — sized identically to Ask Scout because both hit the same
   * Haiku 4.5 endpoint and share identical cost-pressure logic.
   */
  card_scan_daily_cap: number;
}

export interface SubscriptionsSpec {
  version: string;
  tiers: SubscriptionTierSpec[];
}

export interface StreakRewardEntry {
  day: number;
  pack_id: string;
  bonus_pp: number;
  bonus_tokens: number;
}

export interface StreakRewardsSpec {
  version: string;
  streak_rewards: StreakRewardEntry[];
  post_30_recurrence: { interval_days: number; pack_id: string };
  subscription_streak_boost: Partial<Record<SubscriptionTierId, string>>;
  streak_save: { cost_usd: number; cost_gems: number; monthly_limit: number };
}

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export type CardSport =
  | 'any'
  | 'basketball'
  | 'baseball'
  | 'football'
  | 'hockey'
  | 'soccer';

export type StatBoostKey = 'PRIMARY' | 'SECONDARY' | 'TERTIARY' | 'ALL';

export interface StatBoost {
  stat: StatBoostKey | string;
  modifier_pct: number;
  conditional?: boolean;
}

export interface AbilityEffect {
  trigger_id: string;
  trigger_params: Record<string, unknown>;
  boost_on_trigger: { stat: StatBoostKey | string; modifier_pct: number }[];
}

export type CardEffect =
  | { type: 'stat_boost'; stat_boosts: StatBoost[] }
  | { type: 'ability'; ability: AbilityEffect }
  | { type: 'hybrid'; stat_boosts: StatBoost[]; ability: AbilityEffect };

export interface CardTemplate {
  template_id: string;
  name: string;
  card_type: 'stat_boost' | 'ability' | 'hybrid';
  rarity: Rarity;
  energy_cost: number;
  sport: CardSport;
  effect: CardEffect;
  display: {
    description_short: string;
    description_long: string;
    scout_callout: string;
  };
}

export interface CardTemplatesSpec {
  version: string;
  card_templates: CardTemplate[];
}

export interface TriggerSpec {
  trigger_id: string;
  name: string;
  description: string;
  data_required: string[];
  params_schema: Record<string, string>;
  evaluator_pseudocode: string;
  approximate_trigger_rate: number;
}

export interface TriggersSpec {
  version: string;
  triggers: TriggerSpec[];
}

export type ResolutionSport = 'basketball' | 'baseball' | 'football' | 'hockey' | 'soccer';

export interface StatResolutionForSport {
  default_primary: string;
  default_secondary: string;
  default_tertiary: string;
  default_stats: string[];
  star_threshold: { stat: string; value: number };
  by_position: Record<
    string,
    { primary: string; secondary: string; tertiary: string }
  >;
}

export interface StatResolutionSpec {
  version: string;
  stat_resolution: Record<ResolutionSport, StatResolutionForSport>;
}

export interface ResolvedStats {
  primary: string;
  secondary: string;
  tertiary: string;
  default_stats: string[];
  star_threshold: { stat: string; value: number };
}

export interface PackGuaranteedSlot {
  slot_index: number;
  minimum_rarity: Rarity;
}

export interface PackDropRates {
  common: number;
  uncommon: number;
  rare: number;
  epic: number;
  legendary: number;
}

export interface PackDef {
  pack_id: string;
  name: string;
  pp_cost: number | null;
  card_count: number;
  drop_rates: PackDropRates;
  guaranteed_slots: PackGuaranteedSlot[];
  sport_diversity_min: number;
  bonus_token_chance: number;
  obtainable_via?: string;
}

export interface PacksSpec {
  version: string;
  packs: PackDef[];
}

export interface PityTimer {
  id: string;
  description: string;
  trigger_threshold: number;
  tracking_unit: string;
  guarantee: string;
  reset_on: string;
}

export interface PityTimersSpec {
  version: string;
  pity_timers: PityTimer[];
}

export interface PityState {
  packs_since_rare_plus: number;
  cards_since_legendary: number;
}

export const INITIAL_PITY_STATE: PityState = {
  packs_since_rare_plus: 0,
  cards_since_legendary: 0,
};
