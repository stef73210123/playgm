/**
 * Trigger evaluator (card-system.md §4 + pgm_triggers.json).
 *
 * Six evaluators, one per trigger_id:
 *   - big_game     — this game's primary stat exceeds the season average
 *   - win_bonus    — player's team won
 *   - hot_hand     — last game's primary stat exceeded season average
 *   - star_game    — this game's primary stat ≥ sport-specific threshold
 *   - stat_stuffer — non-zero in ≥ min_categories stat columns
 *   - rivalry      — opponent.is_rival(scope) is true
 *
 * Each evaluator returns a boolean. Pure functions — caller supplies the
 * stats / context, no I/O.
 */

export interface GameStats {
  /** Sport-specific stat keys → integer values for THIS game. */
  this_game_stats?: Record<string, number>;
  /** Sport-specific stat keys → integer values for the previous game. */
  last_game_stats?: Record<string, number>;
  /** Sport-specific stat keys → season average. */
  season_avg?: Record<string, number>;
  /** Win/loss + sport-specific result data. */
  game_result?: { player_team_won: boolean };
  /** Opponent metadata — must implement is_rival. */
  opponent_meta?: { is_rival: (scope: string) => boolean };
}

export interface BigGameParams { primary_stat: string }
export interface HotHandParams { primary_stat: string }
export interface StarGameParams { primary_stat: string; threshold: number }
export interface StatStufferParams { categories: string[]; min_categories: number }
export interface RivalryParams { scope: string }

/** Default lookup values for spec sentinels (e.g. "SPORT_STAR_THRESHOLD"). */
export interface ResolverContext {
  /** Resolves the spec's "SPORT_STAR_THRESHOLD" sentinel to a number. */
  resolveStarThreshold?: () => number;
  /** Resolves the spec's "SPORT_DEFAULT_STATS" sentinel to a stat-key list. */
  resolveDefaultStats?: () => string[];
}

/** Big game — this_game_stats[primary] > season_avg[primary]. */
export function evaluateBigGame(params: BigGameParams, ctx: GameStats): boolean {
  const a = ctx.this_game_stats?.[params.primary_stat];
  const b = ctx.season_avg?.[params.primary_stat];
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return a > b;
}

/** Win bonus — player's team won. */
export function evaluateWinBonus(_params: Record<string, never>, ctx: GameStats): boolean {
  return ctx.game_result?.player_team_won === true;
}

/** Hot hand — last_game_stats[primary] > season_avg[primary]. */
export function evaluateHotHand(params: HotHandParams, ctx: GameStats): boolean {
  const a = ctx.last_game_stats?.[params.primary_stat];
  const b = ctx.season_avg?.[params.primary_stat];
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return a > b;
}

/** Star game — this_game_stats[primary] ≥ threshold. */
export function evaluateStarGame(
  params: StarGameParams,
  ctx: GameStats,
  resolver: ResolverContext = {},
): boolean {
  const v = ctx.this_game_stats?.[params.primary_stat];
  if (typeof v !== 'number') return false;
  // Threshold can come through as a number OR as the spec sentinel
  // "SPORT_STAR_THRESHOLD" — resolve via the supplied callback when needed.
  let t = params.threshold as number | string;
  if (typeof t === 'string') {
    t = resolver.resolveStarThreshold?.() ?? Number.NaN;
  }
  if (typeof t !== 'number' || Number.isNaN(t)) return false;
  return v >= t;
}

/** Stat stuffer — count(stat in categories where this_game_stats[stat] > 0) ≥ min_categories. */
export function evaluateStatStuffer(
  params: StatStufferParams,
  ctx: GameStats,
  resolver: ResolverContext = {},
): boolean {
  let cats: string[] | undefined = params.categories;
  if (!Array.isArray(cats)) {
    // The spec uses the sentinel "SPORT_DEFAULT_STATS" — resolve via callback.
    cats = resolver.resolveDefaultStats?.();
  }
  if (!Array.isArray(cats) || cats.length === 0) return false;
  const stats = ctx.this_game_stats ?? {};
  let hits = 0;
  for (const c of cats) {
    if ((stats[c] ?? 0) > 0) hits++;
  }
  return hits >= params.min_categories;
}

/** Rivalry — opponent_meta.is_rival(scope). */
export function evaluateRivalry(params: RivalryParams, ctx: GameStats): boolean {
  return ctx.opponent_meta?.is_rival(params.scope) === true;
}

/**
 * Dispatch table — maps a trigger_id to its evaluator. Returns `false`
 * for unknown ids so callers don't throw on a stray template (a spec
 * drift gives a missed-trigger, not a crash).
 */
export function evaluateTrigger(
  triggerId: string,
  params: Record<string, unknown>,
  ctx: GameStats,
  resolver: ResolverContext = {},
): boolean {
  switch (triggerId) {
    case 'big_game':
      return evaluateBigGame(params as unknown as BigGameParams, ctx);
    case 'win_bonus':
      return evaluateWinBonus(params as Record<string, never>, ctx);
    case 'hot_hand':
      return evaluateHotHand(params as unknown as HotHandParams, ctx);
    case 'star_game':
      return evaluateStarGame(params as unknown as StarGameParams, ctx, resolver);
    case 'stat_stuffer':
      return evaluateStatStuffer(params as unknown as StatStufferParams, ctx, resolver);
    case 'rivalry':
      return evaluateRivalry(params as unknown as RivalryParams, ctx);
    default:
      return false;
  }
}
