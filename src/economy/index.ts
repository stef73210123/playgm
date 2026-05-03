/**
 * Server economy / card runtime — typed facade.
 *
 * All server routes that need to award PP, validate rosters, roll packs,
 * convert duplicates, or evaluate ability triggers should import from
 * here so the spec → runtime path is one indirection.
 */

export * from './types.js';

export {
  buildProgression,
  listTiers,
  getTierForPP,
  getTierUpBonus,
  contestGate,
} from './progression.js';

export {
  buildEarnRates,
  getEarnAmount,
  resolvePerformanceBundle,
} from './earnRates.js';
export type { ActivityKey, EarnContext } from './earnRates.js';

export {
  computeDailyPpGrant,
  dayKey,
} from './dailyGrant.js';

export {
  buildSubscriptions,
  getSubscription,
  getMonthlyPackAllocation,
  getDailyBoost,
  getInventoryCap,
  getAskScoutDailyCap,
  getCardScanDailyCap,
  getDraftModes,
  isDraftModeAllowed,
  getFAPoolSize,
  getDraftPositionControl,
  listTiers as listSubscriptionTiers,
} from './subscriptions.js';

export {
  buildStreakRewards,
  getStreakReward,
  listScheduledDays,
} from './streak.js';

export {
  buildCardTemplates,
  buildTriggers,
  buildStatResolution,
  getTemplate,
  listAllTemplates,
  listTemplatesByRarity,
  getTrigger,
  getStatResolution,
} from './cards.js';

export {
  buildPacks,
  buildPityTimers,
  getPackDef,
  listPacks,
  listPityTimers,
} from './packs.js';

export {
  validateRoster,
  ROSTER_ENERGY_BUDGET,
  PER_PLAYER_CARD_CAP,
  PER_ROSTER_RARE_CAP,
  PER_ROSTER_EPIC_CAP,
  PER_USER_WEEKLY_LEGENDARY_CAP,
} from './validation.js';
export type {
  RosterCard,
  ValidationContext,
  ValidationResult,
} from './validation.js';

export { rollPack, makeSeededRng } from './packRoller.js';
export type { PackRollResult, RollPackOptions } from './packRoller.js';

export { bindCardToPlayer } from './playerBinding.js';
export type { BindablePlayer, BindOptions } from './playerBinding.js';

export {
  convertDuplicateToShards,
  pickRandomTemplateForRarity,
  SHARD_REDEMPTION_COST,
} from './shards.js';
export type { ShardConversionResult } from './shards.js';

export {
  evaluateTrigger,
  evaluateBigGame,
  evaluateWinBonus,
  evaluateHotHand,
  evaluateStarGame,
  evaluateStatStuffer,
  evaluateRivalry,
} from './triggerEvaluator.js';
export type {
  GameStats,
  BigGameParams,
  HotHandParams,
  StarGameParams,
  StatStufferParams,
  RivalryParams,
  ResolverContext,
} from './triggerEvaluator.js';
