/**
 * scoringFormula.ts — load + apply the configurable scoring formula.
 *
 * Source: `data/economy/pgm_scoring_formula.json` (NEW; admin-editable via
 * /admin/edit/scoring). Five sports, each with its own weight bag. MLB and
 * NHL split by position group (hitter/pitcher, skater/goalie); the others
 * use a single weight set per sport.
 *
 * The stat keys in the formula are the *spec* keys (e.g. `passing_yds`).
 * The on-disk stat caches use *canonical* keys (e.g. `passing_yards`). We
 * resolve via the alias table below so both forms work — a write to either
 * scores correctly.
 *
 * scorePlayerWeek(stats, sport, formula, opts) returns a single fantasy
 * point total. Negative caps clamp downside so an MVP with 12 turnovers
 * isn't penalized into oblivion.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Sport = 'basketball' | 'football' | 'baseball' | 'hockey' | 'soccer';

/**
 * Per-sport weight tables. Positive = additive, negative = penalty. MLB and
 * NHL split by role; the simulator picks the right bag from the player's
 * `position_group`.
 */
export interface ScoringFormulaFile {
  version: string;
  by_sport: {
    basketball: {
      weights: Record<string, number>;
      negative_caps?: Record<string, number>;
      games_per_week?: number;
    };
    football: {
      weights: Record<string, number>;
      negative_caps?: Record<string, number>;
      games_per_week?: number;
    };
    baseball: {
      hitter_weights: Record<string, number>;
      pitcher_weights: Record<string, number>;
      negative_caps?: Record<string, number>;
      games_per_week?: number;
    };
    hockey: {
      skater_weights: Record<string, number>;
      goalie_weights: Record<string, number>;
      negative_caps?: Record<string, number>;
      games_per_week?: number;
    };
    soccer: {
      weights: Record<string, number>;
      negative_caps?: Record<string, number>;
      games_per_week?: number;
    };
  };
  global: {
    roster_size: number;
    min_picks_per_sport: Record<Sport, number>;
    synthetic_user_count: number;
    draft_position_strategy: 'snake' | 'serpentine' | 'linear';
    weekly_energy_budget?: number;
    card_uplift_by_rarity?: Record<string, number>;
    rarity_caps?: {
      rare_per_roster?: number;
      epic_per_roster?: number;
      legendary_per_user_per_week?: number;
    };
    subscription_tier_mix?: Record<string, number>;
    fa_engagement_by_tier?: Record<string, number>;
    fa_pool_size?: number;
    max_bench_size?: number;
  };
}

/** Default games-per-week per sport when the formula omits it. */
export const DEFAULT_GAMES_PER_WEEK: Record<Sport, number> = {
  basketball: 3.5,
  football: 1.0,
  baseball: 6.0,
  hockey: 3.5,
  soccer: 1.5,
};

export function gamesPerWeek(sport: Sport, formula: ScoringFormulaFile): number {
  const v = formula.by_sport[sport].games_per_week;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_GAMES_PER_WEEK[sport];
}

/**
 * Maps spec stat keys → cache stat keys. Either name in the formula JSON
 * resolves correctly when the cache uses the canonical name, so admins can
 * edit either form without breaking things.
 */
const STAT_KEY_ALIASES: Record<string, string[]> = {
  // football
  passing_yds: ['passing_yards', 'passing_yds'],
  passing_tds: ['passing_touchdowns', 'passing_tds'],
  ints: ['interceptions', 'ints'],
  rushing_yds: ['rushing_yards', 'rushing_yds'],
  rushing_tds: ['rushing_touchdowns', 'rushing_tds'],
  receiving_yds: ['receiving_yards', 'receiving_yds'],
  receiving_tds: ['receiving_touchdowns', 'receiving_tds'],
  // baseball
  earned_runs_against: ['earned_runs_against', 'era'],
  // hockey
  shutouts: ['shutouts', 'so'],
  // soccer
  shots: ['shots', 'sh'],
  clean_sheets: ['clean_sheets', 'cs'],
};

function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, '..'),
    path.resolve(cwd, '..', '..'),
    path.resolve(cwd, '..', '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'cards', 'pgm_card_templates.json'))) return c;
  }
  return cwd;
}
const PROJECT_ROOT = findProjectRoot();
export const FORMULA_PATH = path.join(
  PROJECT_ROOT,
  'data',
  'economy',
  'pgm_scoring_formula.json',
);

let cached: { mtime: number; file: ScoringFormulaFile } | null = null;

/** Load + cache the formula file. The cache invalidates when mtime changes. */
export function loadScoringFormula(): ScoringFormulaFile {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const stat = fs.statSync(FORMULA_PATH);
  const mtime = stat.mtimeMs;
  if (cached && cached.mtime === mtime) return cached.file;
  const raw = readFileSync(FORMULA_PATH, 'utf8');
  const parsed = JSON.parse(raw) as ScoringFormulaFile;
  cached = { mtime, file: parsed };
  return parsed;
}

/** For tests: ignore cache + accept an in-memory file. */
export function loadScoringFormulaFromObject(obj: ScoringFormulaFile): ScoringFormulaFile {
  return obj;
}

/** Pull a stat from the bag, trying every alias. Missing → 0. */
function statValue(stats: Record<string, number>, formulaKey: string): number {
  const aliases = STAT_KEY_ALIASES[formulaKey] ?? [formulaKey];
  for (const k of aliases) {
    const v = stats[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

interface ScoreOpts {
  /** Position group from the player row (qb/rb/hitter/pitcher/skater/goalie/…). */
  positionGroup?: string;
}

/** Pick the right weight bag for sports that split by role. */
function weightsFor(
  sport: Sport,
  formula: ScoringFormulaFile,
  positionGroup?: string,
): Record<string, number> {
  if (sport === 'baseball') {
    const isPitcher = (positionGroup ?? '').toLowerCase().includes('pitcher');
    return isPitcher
      ? formula.by_sport.baseball.pitcher_weights
      : formula.by_sport.baseball.hitter_weights;
  }
  if (sport === 'hockey') {
    const isGoalie = (positionGroup ?? '').toLowerCase().includes('goalie');
    return isGoalie
      ? formula.by_sport.hockey.goalie_weights
      : formula.by_sport.hockey.skater_weights;
  }
  if (sport === 'football') return formula.by_sport.football.weights;
  if (sport === 'basketball') return formula.by_sport.basketball.weights;
  return formula.by_sport.soccer.weights;
}

function negativeCaps(sport: Sport, formula: ScoringFormulaFile): Record<string, number> {
  switch (sport) {
    case 'basketball':
      return formula.by_sport.basketball.negative_caps ?? {};
    case 'football':
      return formula.by_sport.football.negative_caps ?? {};
    case 'baseball':
      return formula.by_sport.baseball.negative_caps ?? {};
    case 'hockey':
      return formula.by_sport.hockey.negative_caps ?? {};
    case 'soccer':
      return formula.by_sport.soccer.negative_caps ?? {};
  }
}

/**
 * Score a single player's per-week (or per-season) stat bag through the
 * configured formula. Caps clamp negative contributions so a player can't
 * dig too deep a hole.
 */
export function scorePlayerWeek(
  playerStats: Record<string, number>,
  sport: Sport,
  formula: ScoringFormulaFile,
  opts: ScoreOpts = {},
): number {
  const weights = weightsFor(sport, formula, opts.positionGroup);
  const caps = negativeCaps(sport, formula);
  let total = 0;
  for (const [statKey, weight] of Object.entries(weights)) {
    const v = statValue(playerStats, statKey);
    let contribution = v * weight;
    const cap = caps[statKey];
    if (cap !== undefined && contribution < cap) contribution = cap;
    total += contribution;
  }
  return total;
}

/** Set of every weight key referenced by the formula (across all sport bags). */
export function allWeightKeys(formula: ScoringFormulaFile): Set<string> {
  const out = new Set<string>();
  const add = (rec: Record<string, number> | undefined): void => {
    if (!rec) return;
    for (const k of Object.keys(rec)) out.add(k);
  };
  add(formula.by_sport.basketball.weights);
  add(formula.by_sport.football.weights);
  add(formula.by_sport.baseball.hitter_weights);
  add(formula.by_sport.baseball.pitcher_weights);
  add(formula.by_sport.hockey.skater_weights);
  add(formula.by_sport.hockey.goalie_weights);
  add(formula.by_sport.soccer.weights);
  return out;
}
