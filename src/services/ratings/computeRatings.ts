/**
 * computeRatings.ts — per-player rating on the 13-grade A+…F ladder.
 *
 * 13-GRADE LADDER
 * ───────────────
 *   A+ → top 5%       A grades → orange / gold band
 *   A  → 5–10%
 *   A- → 10–20%
 *   B+ → 20–35%       B grades → blue band
 *   B  → 35–50%
 *   B- → 50–65%
 *   C+ → 65–75%       C grades → neutral gray-green band
 *   C  → 75–80%
 *   C- → 80–85%
 *   D+ → 85–90%       D grades → warning orange-red band
 *   D  → 90–95%
 *   D- → 95–98%
 *   F  → bottom 2%    F → red
 *
 * Algorithm:
 *   1. Load the per-(sport × position) grade-band file (`assets/stat-tiers`).
 *   2. For each stat in the file, place the player's value into one of 13
 *      bands; respect `lower_is_better`.
 *   3. Convert each grade to a numeric score (A+ = 13, F = 1).
 *   4. Weight via pgm_stat_resolution.json:
 *        PRIMARY 50%, SECONDARY 30%, TERTIARY 20%.
 *      Stats outside the trio average into the remaining weight (or 0 when
 *      no slack remains). When some prioritized stats are missing the
 *      remaining weights redistribute proportionally so the score isn't
 *      dominated by a single value.
 *   5. Map the weighted 1..13 score back to a grade.
 *
 * MLB ROUTING
 * ───────────
 *   Hitter and pitcher have orthogonal stat shapes. We rate baseball
 *   players against `mlb-hitter.json` and/or `mlb-pitcher.json` based on the
 *   stat shape AND raw position. Two-way players (Ohtani-style) rate under
 *   BOTH; the higher-grade side becomes the canonical `overall_grade` and
 *   the other side is exposed in `secondary_grade`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { League } from '../stats/types.js';

// ─── grade ladder ───────────────────────────────────────────────────────────

export type Grade =
  | 'A+' | 'A' | 'A-'
  | 'B+' | 'B' | 'B-'
  | 'C+' | 'C' | 'C-'
  | 'D+' | 'D' | 'D-'
  | 'F';

export const GRADE_ORDER: Grade[] = [
  'A+', 'A', 'A-',
  'B+', 'B', 'B-',
  'C+', 'C', 'C-',
  'D+', 'D', 'D-',
  'F',
];

/** Numeric score: A+ = 13 (best), F = 1 (worst). Used for weighted average. */
export const GRADE_SCORE: Record<Grade, number> = {
  'A+': 13, 'A': 12, 'A-': 11,
  'B+': 10, 'B': 9,  'B-': 8,
  'C+': 7,  'C': 6,  'C-': 5,
  'D+': 4,  'D': 3,  'D-': 2,
  'F':  1,
};

/** Reverse lookup: numeric (1..13, fractional) → grade. */
export function scoreToGrade(score: number): Grade {
  if (Number.isNaN(score)) return 'F';
  if (score === Infinity) return 'A+';
  if (score === -Infinity) return 'F';
  if (!Number.isFinite(score)) return 'F';
  // Round to nearest grade slot.
  const slot = Math.max(1, Math.min(13, Math.round(score)));
  // GRADE_ORDER[0] is A+ (slot 13), GRADE_ORDER[12] is F (slot 1).
  return GRADE_ORDER[13 - slot];
}

/** Higher grade wins. Returns negative if a is worse than b, 0 if equal. */
export function compareGrade(a: Grade, b: Grade): number {
  return GRADE_SCORE[a] - GRADE_SCORE[b];
}

// ─── public input/output shape ──────────────────────────────────────────────

export interface RatingInput {
  playerId: string;
  sport: League;
  /** Position group in the tier-band sense (e.g. 'qb', 'PG', 'hitter', 'skater', 'fw'). */
  position: string;
  stats: Record<string, number>;
}

export interface StatBreakdown {
  stat: string;
  value: number;
  grade: Grade;
}

export interface RatingResult {
  player_id: string;
  sport: League;
  position: string;
  overall_grade: Grade;
  stat_breakdowns: StatBreakdown[];
  /** Weighted score in [1,13]. Useful for sorting / debugging. */
  score: number;
  /** Confidence in the rating, 0..1. Combines sample-size adequacy with band-density. */
  confidence: number;
  /**
   * For MLB two-way players (Ohtani-style): when the player rated under both
   * hitter and pitcher tier files, the higher-grade side wins. The other
   * side is preserved here so callers can show "also: pitcher (B+, 0.6)".
   */
  secondary_grade?: {
    position: string;
    overall_grade: Grade;
    score: number;
    confidence: number;
  };
  source: 'tier-files-v2';
}

// ─── tier file types ────────────────────────────────────────────────────────

interface GradeBandRaw {
  grade: Grade;
  min: number;
  max: number | null;
  variants: string[];
}

interface StatBlockRaw {
  display_name: string;
  unit: string;
  kid_friendly_name: string;
  retrospective_prefix: string;
  lower_is_better?: boolean;
  /** New schema: `grades`. Older v1 files used `tiers` — see `loadTierFile`. */
  grades?: GradeBandRaw[];
  /** Legacy v1 5-tier shape. We map elite/strong/solid/role/deep_bench to A/B/C/D/F. */
  tiers?: Array<{ name: 'elite' | 'strong' | 'solid' | 'role' | 'deep_bench'; min: number; max: number | null; variants: string[] }>;
  dual_threat_only?: boolean;
  min_value_to_show?: number;
}

interface TierFileRaw {
  league: string;
  position_group: string;
  schema_version?: 'grades-v2' | 'tiers-v1';
  stats: Record<string, StatBlockRaw>;
}

interface ResolutionEntry {
  primary: string;
  secondary: string;
  tertiary: string;
}
interface ResolutionFile {
  stat_resolution: Record<
    string,
    {
      default_primary: string;
      default_secondary: string;
      default_tertiary: string;
      by_position: Record<string, ResolutionEntry>;
    }
  >;
}

// ─── tier-file loader ───────────────────────────────────────────────────────

const REPO_ROOT = (() => {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(cur, 'assets', 'stat-tiers')) && existsSync(path.join(cur, 'data', 'cards'))) {
      return cur;
    }
    cur = path.resolve(cur, '..');
  }
  return process.cwd();
})();

const tierFileCache = new Map<string, TierFileRaw | null>();

export function tierFileSlug(sport: League, positionGroup: string): string {
  const tag = positionGroup.toLowerCase();
  return `${sport}-${tag}`;
}

/**
 * Translate a legacy 5-tier band into 13-grade bands so old files (v1) still
 * load. We map elite→A+/A/A-, strong→B+/B/B-, solid→C+/C/C-, role→D+/D/D-,
 * deep_bench→F. The numeric ranges aren't expanded — within each old band we
 * collapse all 3 sub-grades to the same range and rely on placeBand to pick
 * the first matching band (the middle grade in each cluster).
 */
function legacyTiersToGrades(
  tiers: Array<{ name: 'elite' | 'strong' | 'solid' | 'role' | 'deep_bench'; min: number; max: number | null; variants: string[] }>,
): GradeBandRaw[] {
  const map: Record<string, Grade> = {
    elite: 'A',
    strong: 'B',
    solid: 'C',
    role: 'D',
    deep_bench: 'F',
  };
  return tiers.map((t) => ({
    grade: map[t.name],
    min: t.min,
    max: t.max,
    variants: t.variants,
  }));
}

function normalizeStatBlock(block: StatBlockRaw): StatBlockRaw {
  if (block.grades && block.grades.length > 0) return block;
  if (block.tiers && block.tiers.length > 0) {
    return { ...block, grades: legacyTiersToGrades(block.tiers) };
  }
  return block;
}

function loadTierFile(sport: League, positionGroup: string): TierFileRaw | null {
  const slug = tierFileSlug(sport, positionGroup);
  if (tierFileCache.has(slug)) return tierFileCache.get(slug) ?? null;
  const filePath = path.join(REPO_ROOT, 'assets', 'stat-tiers', `${slug}.json`);
  if (!existsSync(filePath)) {
    tierFileCache.set(slug, null);
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as TierFileRaw;
    // Normalize legacy stat blocks in place.
    for (const k of Object.keys(raw.stats)) {
      raw.stats[k] = normalizeStatBlock(raw.stats[k]);
    }
    tierFileCache.set(slug, raw);
    return raw;
  } catch {
    tierFileCache.set(slug, null);
    return null;
  }
}

let resolutionCache: ResolutionFile | null = null;
function loadResolution(): ResolutionFile | null {
  if (resolutionCache) return resolutionCache;
  const filePath = path.join(REPO_ROOT, 'data', 'cards', 'pgm_stat_resolution.json');
  if (!existsSync(filePath)) return null;
  try {
    resolutionCache = JSON.parse(readFileSync(filePath, 'utf-8')) as ResolutionFile;
    return resolutionCache;
  } catch {
    return null;
  }
}

// ─── grade placement ────────────────────────────────────────────────────────

/** Place a value into the right grade band. lower_is_better is honored by the band shape. */
export function placeBand(value: number, block: StatBlockRaw): Grade {
  const bands = (block.grades && block.grades.length > 0)
    ? block.grades
    : (block.tiers ? legacyTiersToGrades(block.tiers) : []);
  if (bands.length === 0) return 'C';
  for (const b of bands) {
    if (b.max === null) {
      if (value >= b.min) return b.grade;
    } else if (value >= b.min && value <= b.max) {
      return b.grade;
    }
  }
  return 'F';
}

// ─── league → resolution-file sport-key map ─────────────────────────────────

const SPORT_KEY: Record<League, string> = {
  nfl: 'football',
  nba: 'basketball',
  mlb: 'baseball',
  nhl: 'hockey',
  mls: 'soccer',
};

export function lookupStatPriorities(
  sport: League,
  position: string,
): { primary: string; secondary: string; tertiary: string } | null {
  const r = loadResolution();
  if (!r) return null;
  const sportKey = SPORT_KEY[sport];
  const block = r.stat_resolution[sportKey];
  if (!block) return null;
  const upper = position.toUpperCase();
  const found = block.by_position[upper] ?? block.by_position[position];
  if (found) return found;
  if (sport === 'mlb') {
    if (position.toLowerCase() === 'pitcher') return block.by_position.SP ?? null;
    if (position.toLowerCase() === 'hitter') return block.by_position.OF ?? null;
  }
  if (sport === 'nhl') {
    if (position.toLowerCase() === 'goalie') return block.by_position.G ?? null;
    if (position.toLowerCase() === 'skater') return block.by_position.C ?? null;
  }
  if (sport === 'nfl') {
    if (position.toLowerCase() === 'qb') return block.by_position.QB ?? null;
    if (position.toLowerCase() === 'rb') return block.by_position.RB ?? null;
    if (position.toLowerCase() === 'wr-te') return block.by_position.WR ?? null;
    if (position.toLowerCase() === 'defense') return block.by_position.DEF ?? null;
    if (position.toLowerCase() === 'special') return null;
  }
  return {
    primary: block.default_primary,
    secondary: block.default_secondary,
    tertiary: block.default_tertiary,
  };
}

// ─── confidence math ────────────────────────────────────────────────────────

const FULL_SEASON_GAMES: Record<League, number> = {
  nfl: 17,
  nba: 82,
  mlb: 162,
  nhl: 82,
  mls: 34,
};

function computeConfidence(input: RatingInput, breakdownCount: number, tierFileStatCount: number): number {
  const gp = input.stats.games_played;
  const fullSeason = FULL_SEASON_GAMES[input.sport] ?? 82;
  const sampleAdequacy =
    typeof gp === 'number' && Number.isFinite(gp) && gp > 0
      ? Math.min(gp / fullSeason, 1)
      : 0.5;
  const density = tierFileStatCount > 0 ? Math.min(breakdownCount / tierFileStatCount, 1) : 0;
  return Math.max(0, Math.min(1, sampleAdequacy * density));
}

// ─── single-position core ───────────────────────────────────────────────────

interface RatingComputation {
  position: string;
  overall_grade: Grade;
  stat_breakdowns: StatBreakdown[];
  score: number;
  confidence: number;
}

function computeForPosition(
  input: RatingInput,
  positionForTierFile: string,
  positionForResolution: string,
): RatingComputation | null {
  const tierFile = loadTierFile(input.sport, positionForTierFile);
  if (!tierFile) return null;

  const breakdowns: StatBreakdown[] = [];
  const placements: Record<string, Grade> = {};

  for (const [statName, block] of Object.entries(tierFile.stats)) {
    const v = input.stats[statName];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const grade = placeBand(v, block);
    placements[statName] = grade;
    breakdowns.push({ stat: statName, value: v, grade });
  }

  const tierFileStatCount = Object.keys(tierFile.stats).length;

  if (breakdowns.length === 0) {
    return {
      position: positionForTierFile,
      overall_grade: 'F',
      stat_breakdowns: [],
      score: 1,
      confidence: 0,
    };
  }

  const pri = lookupStatPriorities(input.sport, positionForResolution);
  let score: number;

  if (pri) {
    const weights: Array<{ stat: string; weight: number }> = [
      { stat: pri.primary, weight: 0.5 },
      { stat: pri.secondary, weight: 0.3 },
      { stat: pri.tertiary, weight: 0.2 },
    ];
    let weightedSum = 0;
    let totalWeight = 0;
    const weightedStats = new Set<string>();
    for (const w of weights) {
      if (placements[w.stat] !== undefined) {
        weightedSum += GRADE_SCORE[placements[w.stat]] * w.weight;
        totalWeight += w.weight;
        weightedStats.add(w.stat);
      }
    }
    const otherKeys = Object.keys(placements).filter((k) => !weightedStats.has(k));
    if (otherKeys.length > 0) {
      const remaining = Math.max(0, 1 - totalWeight);
      const otherAvg =
        otherKeys.reduce((sum, k) => sum + GRADE_SCORE[placements[k]], 0) / otherKeys.length;
      if (remaining > 0) {
        weightedSum += otherAvg * remaining;
        totalWeight += remaining;
      } else if (totalWeight === 0) {
        weightedSum = otherAvg;
        totalWeight = 1;
      }
    }
    score = totalWeight > 0 ? weightedSum / totalWeight : 1;
  } else {
    const sum = breakdowns.reduce((s, b) => s + GRADE_SCORE[b.grade], 0);
    score = sum / breakdowns.length;
  }

  return {
    position: positionForTierFile,
    overall_grade: scoreToGrade(score),
    stat_breakdowns: breakdowns,
    score: Math.round(score * 100) / 100,
    confidence: Math.round(computeConfidence(input, breakdowns.length, tierFileStatCount) * 100) / 100,
  };
}

// ─── MLB hitter/pitcher routing + two-way players ───────────────────────────

/**
 * Baseball-specific routing.
 *   - Pitchers (SP/RP) use mlb-pitcher.json.
 *   - Hitters use mlb-hitter.json.
 *   - Two-way players (Ohtani-style): we detect by the presence of pitching
 *     stats AND batting stats simultaneously (or by a position list that
 *     includes both pitcher and hitter codes). We rate both sides; the
 *     higher-grade side becomes `overall_grade`, the other lives at
 *     `secondary_grade`. Ties break on score, then confidence.
 */
function computeBaseballRating(input: RatingInput): RatingResult | null {
  const stats = input.stats;
  const isPitcher =
    typeof stats.innings_pitched === 'number' ||
    typeof stats.k_pitcher === 'number' ||
    typeof stats.era === 'number';
  const isHitter =
    typeof stats.avg === 'number' ||
    typeof stats.hits === 'number' ||
    typeof stats.hr === 'number';

  const pos = (input.position || '').toUpperCase();
  const isStaffPitcherByPos = pos === 'SP' || pos === 'RP' || pos === 'PITCHER';

  const ratings: RatingComputation[] = [];

  if (isHitter || (!isStaffPitcherByPos && !isPitcher)) {
    const r = computeForPosition(input, 'hitter', 'hitter');
    if (r) ratings.push(r);
  }
  if (isStaffPitcherByPos || isPitcher) {
    const r = computeForPosition(input, 'pitcher', 'pitcher');
    if (r) ratings.push(r);
  }

  if (ratings.length === 0) return null;

  // Pick the better of the two: higher GRADE wins, ties break on score then confidence.
  ratings.sort((a, b) => {
    const ga = GRADE_SCORE[a.overall_grade];
    const gb = GRADE_SCORE[b.overall_grade];
    if (ga !== gb) return gb - ga;
    if (a.score !== b.score) return b.score - a.score;
    return b.confidence - a.confidence;
  });
  const winner = ratings[0];
  const alt = ratings.length > 1 ? ratings[1] : null;

  return {
    player_id: input.playerId,
    sport: input.sport,
    position: winner.position,
    overall_grade: winner.overall_grade,
    stat_breakdowns: winner.stat_breakdowns,
    score: winner.score,
    confidence: winner.confidence,
    ...(alt
      ? {
          secondary_grade: {
            position: alt.position,
            overall_grade: alt.overall_grade,
            score: alt.score,
            confidence: alt.confidence,
          },
        }
      : {}),
    source: 'tier-files-v2',
  };
}

// ─── public entrypoint ──────────────────────────────────────────────────────

export function computeRating(input: RatingInput): RatingResult | null {
  if (input.sport === 'mlb') {
    return computeBaseballRating(input);
  }
  const r = computeForPosition(input, input.position, input.position);
  if (!r) return null;
  return {
    player_id: input.playerId,
    sport: input.sport,
    position: r.position,
    overall_grade: r.overall_grade,
    stat_breakdowns: r.stat_breakdowns,
    score: r.score,
    confidence: r.confidence,
    source: 'tier-files-v2',
  };
}

/** Test-only: clear caches between tests. */
export function _clearRatingCaches(): void {
  tierFileCache.clear();
  resolutionCache = null;
}

// ─── legacy compatibility surface ───────────────────────────────────────────
// These exports preserve the v1 API so older imports continue to type-check
// while callers migrate. New code should use Grade / overall_grade.

export type TierName = 'elite' | 'strong' | 'solid' | 'role' | 'deep_bench';

/** Bucket a 13-grade letter back into a 5-tier name — used by analytics that
 *  haven't migrated yet (e.g. per-league histograms). */
export function gradeToTier(grade: Grade): TierName {
  if (grade.startsWith('A')) return 'elite';
  if (grade.startsWith('B')) return 'strong';
  if (grade.startsWith('C')) return 'solid';
  if (grade.startsWith('D')) return 'role';
  return 'deep_bench';
}
