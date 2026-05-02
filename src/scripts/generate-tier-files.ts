/**
 * generate-tier-files.ts — reproducibly regenerate per-position tier-band JSON
 * from the per-league season caches in assets/stat-cache.
 *
 * 13-GRADE LADDER (A+ … F)
 * ─────────────────────────
 * Bands are PERCENTILE-BASED on the actual distribution among players with
 * games_played >= 4 (when that field is meaningfully populated). Mapping:
 *
 *   A+ → top 5%       (≥ p95)
 *   A  → 5–10%        (p90–95)
 *   A- → 10–20%       (p80–90)
 *   B+ → 20–35%       (p65–80)
 *   B  → 35–50%       (p50–65)
 *   B- → 50–65%       (p35–50)
 *   C+ → 65–75%       (p25–35)
 *   C  → 75–80%       (p20–25)
 *   C- → 80–85%       (p15–20)
 *   D+ → 85–90%       (p10–15)
 *   D  → 90–95%       (p5–10)
 *   D- → 95–98%       (p2–5)
 *   F  → bottom 2%    (< p2)
 *
 * Inverted for `lower_is_better` stats (ERA, INTs, GAA): A+ ≤ p5, F > p98.
 *
 * Output:
 *   assets/stat-tiers/nfl-{qb,rb,wr-te,defense,special}.json
 *   assets/stat-tiers/nba-{pg,sg,sf,pf,c}.json
 *   assets/stat-tiers/mlb-{hitter,pitcher}.json
 *   assets/stat-tiers/nhl-{skater,goalie}.json
 *   assets/stat-tiers/mls-{fw,mf,df,gk}.json
 *
 * Each tier file embeds a `calibration_source` block documenting whether the
 * percentiles came from the real cache or the historical-default fallback.
 *
 * If a cache file is missing for a league (or the cohort is too small) the
 * script writes a tier file with `notes` explaining how to regenerate, falls
 * back to baked-in default percentiles calibrated to historical league norms,
 * and continues so partial runs still produce a usable fileset.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SeasonCache } from './pull-stats-shared.js';

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

interface GradeBand {
  grade: Grade;
  min: number;
  max: number | null;
  variants: string[];
}

interface StatBlock {
  display_name: string;
  unit: string;
  kid_friendly_name: string;
  retrospective_prefix: string;
  lower_is_better?: boolean;
  grades: GradeBand[];
}

interface TierFile {
  league: string;
  position_group: string;
  last_reviewed: string;
  notes: string;
  schema_version: 'grades-v2';
  /** Structured provenance for the per-stat grade bands. */
  calibration_source: {
    source: 'real-cache-percentiles' | 'fallback-historical-defaults';
    source_file: string | null;
    sample_size: number;
    games_played_filter: number | 'unfiltered';
    computed_at: string;
  };
  sample_sizes: Record<string, number>;
  stats: Record<string, StatBlock>;
}

// ─── repo paths ─────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(process.cwd(), process.cwd().endsWith('/server') ? '..' : '.');
const CACHE_DIR = path.join(REPO_ROOT, 'assets', 'stat-cache');
const TIER_DIR = path.join(REPO_ROOT, 'assets', 'stat-tiers');

if (!existsSync(TIER_DIR)) mkdirSync(TIER_DIR, { recursive: true });

// ─── per-stat template metadata ─────────────────────────────────────────────

interface StatMeta {
  display_name: string;
  unit: string;
  kid_friendly_name: string;
  lower_is_better?: boolean;
}

const STAT_META: Record<string, StatMeta> = {
  // NFL
  passing_yards: { display_name: 'Pass Yds', unit: 'passing yards', kid_friendly_name: 'passing' },
  passing_touchdowns: { display_name: 'Pass TD', unit: 'passing touchdowns', kid_friendly_name: 'touchdown passes' },
  completion_percentage: { display_name: 'Cmp%', unit: 'percent', kid_friendly_name: 'accuracy' },
  interceptions: { display_name: 'INT', unit: 'interceptions', kid_friendly_name: 'turnovers', lower_is_better: true },
  passer_rating: { display_name: 'RTG', unit: 'passer rating', kid_friendly_name: 'efficiency' },
  rushing_yards: { display_name: 'Rush Yds', unit: 'rushing yards', kid_friendly_name: 'rushing' },
  rushing_touchdowns: { display_name: 'Rush TD', unit: 'rushing touchdowns', kid_friendly_name: 'rushing scores' },
  receiving_yards: { display_name: 'Rec Yds', unit: 'receiving yards', kid_friendly_name: 'receiving' },
  receiving_touchdowns: { display_name: 'Rec TD', unit: 'receiving touchdowns', kid_friendly_name: 'catching scores' },
  receptions: { display_name: 'Rec', unit: 'receptions', kid_friendly_name: 'catching' },
  long_pass: { display_name: 'Long', unit: 'longest pass', kid_friendly_name: 'big-play arm' },
  tackles: { display_name: 'TKL', unit: 'tackles', kid_friendly_name: 'defensive work' },
  sacks: { display_name: 'SCK', unit: 'sacks', kid_friendly_name: 'pressure' },
  ints_def: { display_name: 'INT', unit: 'interceptions', kid_friendly_name: 'takeaways' },
  forced_fumbles: { display_name: 'FF', unit: 'forced fumbles', kid_friendly_name: 'punching the ball out' },
  field_goals_made: { display_name: 'FGM', unit: 'field goals', kid_friendly_name: 'kicking' },
  // NBA
  points: { display_name: 'PTS', unit: 'points per game', kid_friendly_name: 'scoring' },
  rebounds: { display_name: 'REB', unit: 'rebounds per game', kid_friendly_name: 'rebounding' },
  assists: { display_name: 'AST', unit: 'assists per game', kid_friendly_name: 'playmaking' },
  steals: { display_name: 'STL', unit: 'steals per game', kid_friendly_name: 'pickpocketing' },
  blocks: { display_name: 'BLK', unit: 'blocks per game', kid_friendly_name: 'rim protection' },
  three_pm: { display_name: '3PM', unit: 'threes per game', kid_friendly_name: 'three-point shooting' },
  fg_pct: { display_name: 'FG%', unit: 'percent', kid_friendly_name: 'shooting percentage' },
  ft_pct: { display_name: 'FT%', unit: 'percent', kid_friendly_name: 'free-throw shooting' },
  // MLB hitter
  avg: { display_name: 'AVG', unit: 'batting average', kid_friendly_name: 'hitting' },
  hits: { display_name: 'H', unit: 'hits', kid_friendly_name: 'base hits' },
  hr: { display_name: 'HR', unit: 'home runs', kid_friendly_name: 'power' },
  rbi: { display_name: 'RBI', unit: 'runs batted in', kid_friendly_name: 'driving runs in' },
  runs: { display_name: 'R', unit: 'runs', kid_friendly_name: 'crossing the plate' },
  sb: { display_name: 'SB', unit: 'stolen bases', kid_friendly_name: 'speed on the bases' },
  // MLB pitcher
  wins: { display_name: 'W', unit: 'wins', kid_friendly_name: 'wins' },
  era: { display_name: 'ERA', unit: 'earned run average', kid_friendly_name: 'run prevention', lower_is_better: true },
  innings_pitched: { display_name: 'IP', unit: 'innings', kid_friendly_name: 'workhorse innings' },
  k_pitcher: { display_name: 'K', unit: 'strikeouts', kid_friendly_name: 'strikeouts' },
  whip: { display_name: 'WHIP', unit: 'walks+hits per inning', kid_friendly_name: 'baserunner control', lower_is_better: true },
  saves: { display_name: 'SV', unit: 'saves', kid_friendly_name: 'closing it out' },
  // NHL skater
  goals: { display_name: 'G', unit: 'goals', kid_friendly_name: 'scoring' },
  sog: { display_name: 'SOG', unit: 'shots on goal', kid_friendly_name: 'shot volume' },
  plus_minus: { display_name: '+/-', unit: 'plus/minus', kid_friendly_name: 'two-way impact' },
  // NHL goalie
  save_pct: { display_name: 'SV%', unit: 'percent', kid_friendly_name: 'save percentage' },
  gaa: { display_name: 'GAA', unit: 'goals against average', kid_friendly_name: 'goals allowed', lower_is_better: true },
  shutouts: { display_name: 'SO', unit: 'shutouts', kid_friendly_name: 'clean games' },
  // MLS
  shots: { display_name: 'SH', unit: 'shots', kid_friendly_name: 'shot creation' },
  clean_sheets: { display_name: 'CS', unit: 'clean sheets', kid_friendly_name: 'shutouts' },
};

// ─── Scout VO lines per stat × grade ────────────────────────────────────────
//
// We collapse the 13 grades into 5 narrative buckets so the Scout VO doesn't
// produce robotic micro-distinctions ("A vs A-" sounds the same in voice):
//   A+/A/A- → "elite" voice
//   B+/B/B- → "strong" voice
//   C+/C/C- → "solid" voice
//   D+/D/D- → "role" voice
//   F       → "deep bench" voice

type VoiceBucket = 'top' | 'high' | 'mid' | 'low' | 'bottom';

function gradeToBucket(grade: Grade): VoiceBucket {
  if (grade.startsWith('A')) return 'top';
  if (grade.startsWith('B')) return 'high';
  if (grade.startsWith('C')) return 'mid';
  if (grade.startsWith('D')) return 'low';
  return 'bottom';
}

function variantsFor(stat: string, grade: Grade): string[] {
  const m = STAT_META[stat];
  const fr = m?.kid_friendly_name ?? stat;
  const lower = m?.lower_is_better === true;
  const bucket = gradeToBucket(grade);
  switch (bucket) {
    case 'top':
      return lower
        ? [
            `his ${fr} of {value} was among the very best in the league.`,
            `he kept ${fr} to just {value}. Top of the league.`,
            `with {value} on his ${fr}, he was in elite company.`,
          ]
        : [
            `he posted {value} in ${fr} — elite production.`,
            `with {value} ${fr}, he was a difference-maker.`,
            `he stacked up {value} in ${fr}. Top of the league.`,
          ];
    case 'high':
      return lower
        ? [
            `his ${fr} of {value} was rock-solid.`,
            `at {value}, his ${fr} was a real strength.`,
          ]
        : [
            `he piled up {value} in ${fr} — a starter-level mark.`,
            `with {value} in ${fr}, he was reliably productive.`,
          ];
    case 'mid':
      return lower
        ? [
            `his ${fr} of {value} held steady.`,
            `at {value}, he kept ${fr} under control.`,
          ]
        : [
            `he had {value} in ${fr}. Steady contribution.`,
            `with {value} in ${fr}, he played his role well.`,
          ];
    case 'low':
      return lower
        ? [`his ${fr} of {value} has room to tighten up.`]
        : [`he chipped in {value} in ${fr} when he got his chances.`];
    case 'bottom':
      return lower
        ? [`his ${fr} is still a work in progress.`]
        : [`he didn't see many ${fr} chances this year.`];
  }
}

// ─── percentile math ────────────────────────────────────────────────────────

/** Interpolated quantile (0..1) over a sorted ASCENDING array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function round(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Build 13-grade percentile bands. For higher-is-better stats we use the
 * sorted-ascending percentiles directly; A+ sits at the top (≥ p95). For
 * lower-is-better stats we invert: A+ sits at the bottom (≤ p5), F at top.
 *
 * The `min`/`max` of each band are inclusive. Adjacent bands are seamed
 * with ±0.01 so floating-point values don't fall into the gap.
 *
 * If the cohort has < 5 values the function returns an empty band list and
 * a 0 sample size — caller should fall through to historical defaults.
 */
function buildBands(values: number[], lowerIsBetter: boolean): { grades: GradeBand[]; sampleSize: number } {
  const filtered = values.filter((v) => Number.isFinite(v));
  const sorted = [...filtered].sort((a, b) => a - b);
  if (sorted.length < 5) return { grades: [], sampleSize: sorted.length };

  if (!lowerIsBetter) {
    // Higher-is-better: thresholds are LOWER bound of each grade.
    const thresholds: Array<{ grade: Grade; cut: number }> = [
      { grade: 'A+', cut: round(quantile(sorted, 0.95)) },
      { grade: 'A',  cut: round(quantile(sorted, 0.90)) },
      { grade: 'A-', cut: round(quantile(sorted, 0.80)) },
      { grade: 'B+', cut: round(quantile(sorted, 0.65)) },
      { grade: 'B',  cut: round(quantile(sorted, 0.50)) },
      { grade: 'B-', cut: round(quantile(sorted, 0.35)) },
      { grade: 'C+', cut: round(quantile(sorted, 0.25)) },
      { grade: 'C',  cut: round(quantile(sorted, 0.20)) },
      { grade: 'C-', cut: round(quantile(sorted, 0.15)) },
      { grade: 'D+', cut: round(quantile(sorted, 0.10)) },
      { grade: 'D',  cut: round(quantile(sorted, 0.05)) },
      { grade: 'D-', cut: round(quantile(sorted, 0.02)) },
    ];
    const grades: GradeBand[] = [];
    grades.push({ grade: 'A+', min: thresholds[0].cut, max: null, variants: [] });
    for (let i = 1; i < thresholds.length; i++) {
      const min = thresholds[i].cut;
      const maxRaw = round(thresholds[i - 1].cut - 0.01);
      const max = round(Math.max(min, maxRaw));
      grades.push({ grade: thresholds[i].grade, min, max, variants: [] });
    }
    const lastCut = thresholds[thresholds.length - 1].cut;
    const fMax = round(Math.max(0, lastCut - 0.01));
    grades.push({ grade: 'F', min: 0, max: fMax, variants: [] });
    return { grades, sampleSize: sorted.length };
  }

  // lower-is-better: A+ at the bottom.
  const thresholds: Array<{ grade: Grade; cut: number }> = [
    { grade: 'A+', cut: round(quantile(sorted, 0.05)) },
    { grade: 'A',  cut: round(quantile(sorted, 0.10)) },
    { grade: 'A-', cut: round(quantile(sorted, 0.20)) },
    { grade: 'B+', cut: round(quantile(sorted, 0.35)) },
    { grade: 'B',  cut: round(quantile(sorted, 0.50)) },
    { grade: 'B-', cut: round(quantile(sorted, 0.65)) },
    { grade: 'C+', cut: round(quantile(sorted, 0.75)) },
    { grade: 'C',  cut: round(quantile(sorted, 0.80)) },
    { grade: 'C-', cut: round(quantile(sorted, 0.85)) },
    { grade: 'D+', cut: round(quantile(sorted, 0.90)) },
    { grade: 'D',  cut: round(quantile(sorted, 0.95)) },
    { grade: 'D-', cut: round(quantile(sorted, 0.98)) },
  ];
  const grades: GradeBand[] = [];
  grades.push({ grade: 'A+', min: 0, max: thresholds[0].cut, variants: [] });
  for (let i = 1; i < thresholds.length; i++) {
    const min = round(thresholds[i - 1].cut + 0.01);
    const max = thresholds[i].cut;
    grades.push({ grade: thresholds[i].grade, min, max: round(Math.max(min, max)), variants: [] });
  }
  const lastCut = thresholds[thresholds.length - 1].cut;
  grades.push({ grade: 'F', min: round(lastCut + 0.01), max: null, variants: [] });
  return { grades, sampleSize: sorted.length };
}

// ─── default percentile vectors (no cache present) ──────────────────────────
//
// 13-percentile vectors keyed sorted-ascending: p2, p5, p10, p15, p20, p25,
// p35, p50, p65, p80, p90, p95, p98. Calibrated to historical league norms.
// Used when the cache for a league hasn't been pulled or the cohort is < 5.

interface FallbackVector {
  p: number[];
  lowerIsBetter?: boolean;
}

/** Synthesize a sorted ascending vector of 50 values matching the 13-percentile shape. */
function expandFallback(p: number[]): number[] {
  const QS = [0.02, 0.05, 0.10, 0.15, 0.20, 0.25, 0.35, 0.50, 0.65, 0.80, 0.90, 0.95, 0.98];
  const N = 200; // enough resolution for the percentile interpolation to match
  const out: number[] = [];
  for (let i = 0; i < N; i++) {
    const q = (i + 0.5) / N;
    // Find surrounding anchors
    let prevIdx = 0;
    let nextIdx = QS.length - 1;
    for (let k = 0; k < QS.length; k++) {
      if (QS[k] <= q) prevIdx = k;
      if (QS[k] >= q) { nextIdx = k; break; }
    }
    if (prevIdx === nextIdx) {
      out.push(p[prevIdx]);
    } else {
      const span = QS[nextIdx] - QS[prevIdx];
      const t = span > 0 ? (q - QS[prevIdx]) / span : 0;
      out.push(p[prevIdx] + (p[nextIdx] - p[prevIdx]) * t);
    }
  }
  return out;
}

const FALLBACKS: Record<string, FallbackVector> = {
  // NFL
  passing_yards:        { p: [0, 50, 100, 200, 350, 600, 900, 1800, 2700, 3400, 3950, 4400, 4800] },
  passing_touchdowns:   { p: [0, 0, 0, 1, 2, 3, 6, 12, 20, 26, 30, 35, 42] },
  completion_percentage:{ p: [40, 50, 55, 58, 60, 62, 64, 65, 66, 68, 70, 72, 75] },
  interceptions:        { p: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18], lowerIsBetter: true },
  passer_rating:        { p: [40, 55, 65, 72, 78, 82, 86, 90, 95, 100, 105, 112, 120] },
  rushing_yards:        { p: [0, 20, 40, 80, 150, 250, 400, 700, 1000, 1200, 1400, 1600, 1800] },
  rushing_touchdowns:   { p: [0, 0, 0, 0, 1, 1, 2, 4, 7, 10, 12, 15, 18] },
  receiving_yards:      { p: [0, 50, 100, 200, 350, 500, 650, 800, 1000, 1200, 1400, 1600, 1800] },
  receiving_touchdowns: { p: [0, 0, 0, 1, 2, 3, 4, 5, 7, 10, 12, 14, 16] },
  receptions:           { p: [0, 5, 10, 18, 25, 35, 45, 60, 75, 90, 100, 110, 130] },
  long_pass:            { p: [10, 15, 20, 25, 30, 35, 42, 50, 58, 65, 72, 80, 90] },
  tackles:              { p: [0, 5, 10, 18, 25, 35, 50, 70, 90, 110, 125, 140, 160] },
  sacks:                { p: [0, 0, 0, 0, 1, 1, 2, 4, 7, 10, 13, 16, 22] },
  ints_def:             { p: [0, 0, 0, 0, 1, 1, 1, 2, 3, 4, 5, 7, 9] },
  forced_fumbles:       { p: [0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 4, 5, 7] },
  field_goals_made:     { p: [0, 2, 5, 8, 12, 16, 20, 24, 28, 32, 36, 40, 45] },
  // NBA per-game
  points:    { p: [2, 4, 5, 7, 8, 10, 12, 15, 18, 22, 26, 29, 33] },
  rebounds:  { p: [1, 2, 2.5, 3, 3.5, 4, 4.5, 5.5, 7, 8.5, 10, 11.5, 13] },
  assists:   { p: [0.4, 0.8, 1, 1.4, 1.8, 2.2, 3, 4, 5.5, 7, 8.5, 10, 12] },
  steals:    { p: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.5, 1.7, 2.0, 2.4] },
  blocks:    { p: [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.7, 1.0, 1.3, 1.6, 2.0, 2.5] },
  three_pm:  { p: [0.2, 0.4, 0.6, 0.8, 1.0, 1.3, 1.6, 2.0, 2.5, 3.0, 3.6, 4.2, 5.0] },
  fg_pct:    { p: [35, 38, 40, 41, 42, 43, 44, 46, 48, 51, 55, 60, 64] },
  ft_pct:    { p: [55, 60, 65, 70, 73, 76, 78, 80, 83, 86, 89, 92, 95] },
  // MLB hitter
  avg:       { p: [0.180, 0.200, 0.215, 0.230, 0.240, 0.245, 0.255, 0.265, 0.275, 0.290, 0.305, 0.320, 0.340] },
  hits:      { p: [5, 15, 30, 45, 60, 75, 95, 125, 145, 165, 180, 195, 215] },
  hr:        { p: [0, 1, 3, 5, 8, 11, 14, 18, 24, 30, 36, 42, 50] },
  rbi:       { p: [3, 8, 15, 25, 35, 45, 60, 75, 90, 105, 115, 125, 140] },
  runs:      { p: [3, 8, 15, 25, 35, 45, 58, 72, 88, 100, 112, 122, 135] },
  sb:        { p: [0, 0, 1, 2, 3, 5, 8, 12, 18, 28, 40, 55, 70] },
  // MLB pitcher
  wins:             { p: [0, 0, 1, 2, 3, 4, 6, 9, 12, 14, 16, 18, 21] },
  era:              { p: [2.2, 2.6, 3.0, 3.3, 3.5, 3.7, 4.0, 4.3, 4.7, 5.2, 5.7, 6.4, 7.5], lowerIsBetter: true },
  innings_pitched:  { p: [10, 25, 45, 60, 75, 90, 110, 135, 155, 175, 190, 205, 215] },
  k_pitcher:        { p: [10, 25, 45, 65, 85, 105, 130, 160, 185, 210, 230, 250, 280] },
  whip:             { p: [1.00, 1.05, 1.10, 1.15, 1.18, 1.22, 1.27, 1.32, 1.40, 1.50, 1.62, 1.75, 1.95], lowerIsBetter: true },
  saves:            { p: [0, 0, 0, 0, 1, 1, 2, 5, 10, 18, 28, 38, 48] },
  // NHL skater
  goals:        { p: [0, 1, 3, 5, 7, 9, 12, 16, 22, 28, 34, 40, 48] },
  sog:          { p: [10, 25, 45, 65, 85, 110, 140, 175, 215, 250, 285, 320, 365] },
  plus_minus:   { p: [-25, -18, -12, -8, -5, -3, -1, 2, 7, 14, 22, 30, 40] },
  // NHL goalie
  save_pct:     { p: [0.870, 0.880, 0.890, 0.895, 0.900, 0.905, 0.910, 0.913, 0.918, 0.925, 0.932, 0.940, 0.950] },
  gaa:          { p: [2.05, 2.20, 2.35, 2.50, 2.60, 2.70, 2.85, 3.00, 3.20, 3.45, 3.75, 4.10, 4.60], lowerIsBetter: true },
  shutouts:     { p: [0, 0, 0, 0, 1, 1, 2, 3, 4, 6, 8, 10, 12] },
  // MLS
  shots:         { p: [0, 2, 4, 7, 10, 14, 20, 28, 38, 50, 60, 72, 88] },
  clean_sheets:  { p: [0, 0, 0, 1, 1, 2, 3, 5, 8, 11, 14, 17, 21] },
};

function bandsFromFallback(stat: string): { grades: GradeBand[]; sampleSize: number } {
  const fb = FALLBACKS[stat];
  if (!fb) return { grades: [], sampleSize: 0 };
  const expanded = expandFallback(fb.p);
  return buildBands(expanded, !!fb.lowerIsBetter);
}

// ─── stats-per-position-group config ────────────────────────────────────────

interface PositionConfig {
  league: string;
  positionGroup: string;
  stats: string[];
}

const POSITION_CONFIGS: PositionConfig[] = [
  // NFL
  { league: 'nfl', positionGroup: 'qb', stats: ['passing_yards', 'passing_touchdowns', 'completion_percentage', 'interceptions', 'passer_rating', 'rushing_yards', 'rushing_touchdowns'] },
  { league: 'nfl', positionGroup: 'rb', stats: ['rushing_yards', 'rushing_touchdowns', 'receptions', 'receiving_yards'] },
  { league: 'nfl', positionGroup: 'wr-te', stats: ['receiving_yards', 'receiving_touchdowns', 'receptions', 'rushing_yards'] },
  { league: 'nfl', positionGroup: 'defense', stats: ['tackles', 'sacks', 'ints_def', 'forced_fumbles'] },
  { league: 'nfl', positionGroup: 'special', stats: ['field_goals_made'] },
  // NBA
  { league: 'nba', positionGroup: 'PG', stats: ['points', 'assists', 'rebounds', 'steals', 'three_pm', 'fg_pct'] },
  { league: 'nba', positionGroup: 'SG', stats: ['points', 'three_pm', 'assists', 'steals', 'fg_pct', 'ft_pct'] },
  { league: 'nba', positionGroup: 'SF', stats: ['points', 'rebounds', 'assists', 'steals', 'three_pm', 'fg_pct'] },
  { league: 'nba', positionGroup: 'PF', stats: ['points', 'rebounds', 'blocks', 'assists', 'fg_pct', 'three_pm'] },
  { league: 'nba', positionGroup: 'C', stats: ['rebounds', 'blocks', 'points', 'assists', 'fg_pct', 'ft_pct'] },
  // MLB
  { league: 'mlb', positionGroup: 'hitter', stats: ['avg', 'hr', 'rbi', 'runs', 'hits', 'sb'] },
  { league: 'mlb', positionGroup: 'pitcher', stats: ['k_pitcher', 'innings_pitched', 'wins', 'era', 'whip', 'saves'] },
  // NHL
  { league: 'nhl', positionGroup: 'skater', stats: ['goals', 'assists', 'sog', 'plus_minus', 'blocks'] },
  { league: 'nhl', positionGroup: 'goalie', stats: ['saves', 'save_pct', 'gaa', 'wins', 'shutouts'] },
  // MLS
  { league: 'mls', positionGroup: 'fw', stats: ['goals', 'shots', 'assists'] },
  { league: 'mls', positionGroup: 'mf', stats: ['assists', 'goals', 'tackles', 'shots'] },
  { league: 'mls', positionGroup: 'df', stats: ['tackles', 'clean_sheets', 'assists'] },
  { league: 'mls', positionGroup: 'gk', stats: ['saves', 'clean_sheets'] },
];

const CACHE_FILES: Record<string, string> = {
  nfl: 'nfl_season_2025.json',
  nba: 'nba_season_2025-26.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

function loadCache(league: string): SeasonCache | null {
  const f = path.join(CACHE_DIR, CACHE_FILES[league]);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf-8')) as SeasonCache;
  } catch {
    return null;
  }
}

/**
 * Position-group filter that handles MLB's bundled hitter/pitcher position
 * coding. Older MLB caches tagged each player with the raw role position
 * (SP/RP/C/1B/...) instead of a `position_group`. If we can't find a direct
 * match, we bucket by stat shape so the hitter and pitcher cohorts always
 * have data to calibrate against.
 */
function filterPlayersForPositionGroup(
  cache: SeasonCache,
  cfg: PositionConfig,
): Array<{ stats: Record<string, number> }> {
  const want = cfg.positionGroup;
  const direct = cache.players.filter((p) => p.position_group === want);
  if (direct.length > 0 || cfg.league !== 'mlb') return direct;

  if (want === 'hitter') {
    return cache.players.filter((p) => {
      const s = p.stats || {};
      return (
        typeof s.avg === 'number' ||
        typeof s.hits === 'number' ||
        typeof s.hr === 'number' ||
        typeof s.rbi === 'number'
      );
    });
  }
  if (want === 'pitcher') {
    return cache.players.filter((p) => {
      const s = p.stats || {};
      return (
        typeof s.innings_pitched === 'number' ||
        typeof s.k_pitcher === 'number' ||
        typeof s.era === 'number'
      );
    });
  }
  return [];
}

function buildTierFile(cfg: PositionConfig): TierFile {
  const cache = loadCache(cfg.league);
  const sample_sizes: Record<string, number> = {};
  const stats: Record<string, StatBlock> = {};

  let positionPlayers: Array<{ stats: Record<string, number> }> = [];
  let gpFilterApplied: number | 'unfiltered' = 'unfiltered';
  if (cache) {
    const groupMatched = filterPlayersForPositionGroup(cache, cfg);
    const gpPresentCount = groupMatched.filter(
      (p) => typeof p.stats.games_played === 'number' && Number.isFinite(p.stats.games_played),
    ).length;
    if (groupMatched.length > 0 && gpPresentCount / groupMatched.length >= 0.25) {
      positionPlayers = groupMatched.filter((p) => (p.stats.games_played ?? 0) >= 4);
      gpFilterApplied = 4;
    } else {
      positionPlayers = groupMatched;
      gpFilterApplied = 'unfiltered';
    }
  }

  const cohortSize = positionPlayers.length;
  // Track real-cache vs fallback at the STAT level. The file's overall
  // provenance is `fallback-historical-defaults` only when every stat fell
  // back. A mixed file is still marked real-cache because most bands come
  // from the live distribution.
  let statsCacheUsed = 0;
  let statsFallbackUsed = 0;

  for (const stat of cfg.stats) {
    const meta = STAT_META[stat] ?? { display_name: stat, unit: stat, kid_friendly_name: stat };
    let bands: GradeBand[];
    let sampleSize = 0;

    if (cache && positionPlayers.length >= 5) {
      const values = positionPlayers
        .map((p) => p.stats[stat])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const built = buildBands(values, !!meta.lower_is_better);
      bands = built.grades;
      sampleSize = built.sampleSize;
      if (bands.length === 0) {
        statsFallbackUsed++;
        const fb = bandsFromFallback(stat);
        bands = fb.grades;
      } else {
        statsCacheUsed++;
      }
    } else {
      statsFallbackUsed++;
      const fb = bandsFromFallback(stat);
      bands = fb.grades;
    }

    for (const band of bands) {
      band.variants = variantsFor(stat, band.grade);
    }

    sample_sizes[stat] = sampleSize;
    stats[stat] = {
      display_name: meta.display_name,
      unit: meta.unit,
      kid_friendly_name: meta.kid_friendly_name,
      retrospective_prefix: 'Last season,',
      ...(meta.lower_is_better ? { lower_is_better: true } : {}),
      grades: bands,
    };
  }

  const fromCache = !!cache && statsCacheUsed > 0;
  const calibration_source: TierFile['calibration_source'] = {
    source: fromCache ? 'real-cache-percentiles' : 'fallback-historical-defaults',
    source_file: cache ? CACHE_FILES[cfg.league] : null,
    sample_size: fromCache ? cohortSize : 0,
    games_played_filter: fromCache ? gpFilterApplied : 'unfiltered',
    computed_at: new Date().toISOString(),
  };

  return {
    league: cfg.league,
    position_group: cfg.positionGroup,
    last_reviewed: new Date().toISOString().slice(0, 10),
    schema_version: 'grades-v2',
    notes: fromCache
      ? `Built from ${CACHE_FILES[cfg.league]} (${cohortSize} ${cfg.positionGroup} players, games_played filter: ${gpFilterApplied === 'unfiltered' ? 'unfiltered (games_played not populated in this cache)' : `>= ${gpFilterApplied}`}). ` +
        `Bands are PERCENTILE-BASED on the actual distribution. ` +
        `13-grade ladder: A+ (top 5%) → F (bottom 2%).`
      : cache
        ? `Cache file ${CACHE_FILES[cfg.league]} present but cohort for position_group=${cfg.positionGroup} was too small (<5 players). Bands fall back to baked-in historical defaults. Re-run \`npm run pull:${cfg.league}\` to refresh roster + stats.`
        : `Cache file ${CACHE_FILES[cfg.league]} not yet present — bands fall back to baked-in historical defaults. Re-run \`npm run pull:${cfg.league}\` then \`npm run generate-tier-files\` to refresh from real data.`,
    calibration_source,
    sample_sizes,
    stats,
  };
}

function fileNameFor(cfg: PositionConfig): string {
  const tag = cfg.positionGroup.toLowerCase();
  return path.join(TIER_DIR, `${cfg.league}-${tag}.json`);
}

async function main(): Promise<void> {
  for (const cfg of POSITION_CONFIGS) {
    const out = fileNameFor(cfg);
    const tier = buildTierFile(cfg);
    writeFileSync(out, JSON.stringify(tier, null, 2), 'utf-8');
    // eslint-disable-next-line no-console
    console.log(
      `[tiers] wrote ${path.relative(REPO_ROOT, out)} — source=${tier.calibration_source.source} n=${tier.calibration_source.sample_size}`,
    );
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[tiers] fatal:', err);
  process.exit(1);
});
