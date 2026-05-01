/**
 * generate-tier-files.ts — reproducibly regenerate per-position tier-band JSON
 * from the per-league season caches in assets/stat-cache.
 *
 * Tier bands are PERCENTILE-BASED on the actual distribution among players
 * with games_played >= 4 — same methodology as the existing NFL tier files:
 *   elite ≥ 90th, strong 70–90, solid 40–70, role 15–40, deep_bench < 15.
 *
 * Scout VO lines are pulled from the per-stat templates below. They're hand-
 * authored, kid-friendly, and parameterized by stat name + tier — matching
 * the NFL tier file voice (analytical, encouraging, light coaching warmth).
 *
 * Output:
 *   assets/stat-tiers/nba-{pg,sg,sf,pf,c}.json
 *   assets/stat-tiers/mlb-{hitter,pitcher}.json
 *   assets/stat-tiers/nhl-{skater,goalie}.json
 *   assets/stat-tiers/mls-{fw,mf,df,gk}.json
 *
 * If a cache file is missing for a league, the script writes a tier file with
 * a `notes` block explaining how to (re)generate, falls back to baked-in
 * default percentiles calibrated to historical league norms, and continues.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SeasonCache } from './pull-stats-shared.js';

// ─── tier shape ─────────────────────────────────────────────────────────────

interface TierBand {
  name: 'elite' | 'strong' | 'solid' | 'role' | 'deep_bench';
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
  tiers: TierBand[];
}

interface TierFile {
  league: string;
  position_group: string;
  last_reviewed: string;
  notes: string;
  sample_sizes: Record<string, number>;
  stats: Record<string, StatBlock>;
}

// ─── repo paths ─────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(process.cwd(), process.cwd().endsWith('/server') ? '..' : '.');
const CACHE_DIR = path.join(REPO_ROOT, 'assets', 'stat-cache');
const TIER_DIR = path.join(REPO_ROOT, 'assets', 'stat-tiers');

if (!existsSync(TIER_DIR)) mkdirSync(TIER_DIR, { recursive: true });

// ─── per-stat template metadata ─────────────────────────────────────────────
//
// Display name, kid-friendly name, unit string, lower_is_better flag.
// Variants are an array PER tier — picked from the per-stat templates below.

interface StatMeta {
  display_name: string;
  unit: string;
  kid_friendly_name: string;
  lower_is_better?: boolean;
}

const STAT_META: Record<string, StatMeta> = {
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
  // assists already declared above (NBA), reuse meta
  sog: { display_name: 'SOG', unit: 'shots on goal', kid_friendly_name: 'shot volume' },
  plus_minus: { display_name: '+/-', unit: 'plus/minus', kid_friendly_name: 'two-way impact' },
  // blocks already declared
  // NHL goalie
  save_pct: { display_name: 'SV%', unit: 'percent', kid_friendly_name: 'save percentage' },
  gaa: { display_name: 'GAA', unit: 'goals against average', kid_friendly_name: 'goals allowed', lower_is_better: true },
  shutouts: { display_name: 'SO', unit: 'shutouts', kid_friendly_name: 'clean games' },
  // MLS
  shots: { display_name: 'SH', unit: 'shots', kid_friendly_name: 'shot creation' },
  tackles: { display_name: 'TKL', unit: 'tackles', kid_friendly_name: 'defensive work' },
  clean_sheets: { display_name: 'CS', unit: 'clean sheets', kid_friendly_name: 'shutouts' },
};

// ─── Scout VO lines per stat × tier ─────────────────────────────────────────

type TierName = TierBand['name'];

function variantsFor(stat: string, tier: TierName): string[] {
  const m = STAT_META[stat];
  const fr = m?.kid_friendly_name ?? stat;
  const lower = m?.lower_is_better === true;
  switch (tier) {
    case 'elite':
      return lower
        ? [
            `his {kf} of {value} was among the very best in the league.`,
            `he kept {kf} to just {value}. Top of the league.`,
            `with {value} on his {kf}, he was in elite company.`,
          ].map((s) => s.replace(/\{kf\}/g, fr))
        : [
            `he posted {value} in ${fr} — elite production.`,
            `with {value} ${fr}, he was a difference-maker.`,
            `he stacked up {value} in ${fr}. Top of the league.`,
          ];
    case 'strong':
      return lower
        ? [
            `his ${fr} of {value} was rock-solid.`,
            `at {value}, his ${fr} was a real strength.`,
          ]
        : [
            `he piled up {value} in ${fr} — a starter-level mark.`,
            `with {value} in ${fr}, he was reliably productive.`,
          ];
    case 'solid':
      return lower
        ? [
            `his ${fr} of {value} held steady.`,
            `at {value}, he kept ${fr} under control.`,
          ]
        : [
            `he had {value} in ${fr}. Steady contribution.`,
            `with {value} in ${fr}, he played his role well.`,
          ];
    case 'role':
      return lower
        ? [`his ${fr} of {value} has room to tighten up.`]
        : [`he chipped in {value} in ${fr} when he got his chances.`];
    case 'deep_bench':
      return lower
        ? [`his ${fr} is still a work in progress.`]
        : [`he didn't see many ${fr} chances this year.`];
  }
}

// ─── percentile math ────────────────────────────────────────────────────────

/** Interpolated percentile for a sorted ascending array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function buildBands(values: number[], lowerIsBetter: boolean): { tiers: TierBand[]; sampleSize: number } {
  const filtered = values.filter((v) => Number.isFinite(v));
  const sorted = [...filtered].sort((a, b) => a - b);
  if (sorted.length < 5) {
    // Not enough data — emit a placeholder band so the file has structure.
    return { tiers: [], sampleSize: sorted.length };
  }
  let p15: number, p40: number, p70: number, p90: number;
  if (lowerIsBetter) {
    // Lower values are BETTER. Elite = lowest 10%, deep_bench = top 15%.
    p15 = quantile(sorted, 0.85);
    p40 = quantile(sorted, 0.6);
    p70 = quantile(sorted, 0.3);
    p90 = quantile(sorted, 0.1);
  } else {
    p15 = quantile(sorted, 0.15);
    p40 = quantile(sorted, 0.4);
    p70 = quantile(sorted, 0.7);
    p90 = quantile(sorted, 0.9);
  }
  if (lowerIsBetter) {
    return {
      tiers: [
        { name: 'elite', min: 0, max: round(p90), variants: [] },
        { name: 'strong', min: round(p90 + 0.01), max: round(p70), variants: [] },
        { name: 'solid', min: round(p70 + 0.01), max: round(p40), variants: [] },
        { name: 'role', min: round(p40 + 0.01), max: round(p15), variants: [] },
        { name: 'deep_bench', min: round(p15 + 0.01), max: null, variants: [] },
      ],
      sampleSize: sorted.length,
    };
  }
  return {
    tiers: [
      { name: 'elite', min: round(p90), max: null, variants: [] },
      { name: 'strong', min: round(p70), max: round(p90 - 0.01), variants: [] },
      { name: 'solid', min: round(p40), max: round(p70 - 0.01), variants: [] },
      { name: 'role', min: round(p15), max: round(p40 - 0.01), variants: [] },
      { name: 'deep_bench', min: 0, max: round(p15 - 0.01), variants: [] },
    ],
    sampleSize: sorted.length,
  };
}

function round(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// ─── default percentile fallbacks (no cache present) ────────────────────────
//
// Calibrated to historical league norms (rough but defensible).
// Used only when the cache for that league hasn't been pulled yet.

const FALLBACK_BANDS: Record<string, { p15: number; p40: number; p70: number; p90: number; lowerIsBetter?: boolean }> = {
  // NBA per-game
  points: { p15: 4, p40: 8, p70: 14, p90: 22 },
  rebounds: { p15: 2, p40: 3.5, p70: 5.5, p90: 8.5 },
  assists: { p15: 1, p40: 2, p70: 4, p90: 6.5 },
  steals: { p15: 0.4, p40: 0.7, p70: 1.0, p90: 1.5 },
  blocks: { p15: 0.2, p40: 0.4, p70: 0.7, p90: 1.2 },
  three_pm: { p15: 0.5, p40: 1.0, p70: 1.8, p90: 2.8 },
  fg_pct: { p15: 39, p40: 44, p70: 48, p90: 55 },
  ft_pct: { p15: 65, p40: 75, p70: 82, p90: 88 },
  // MLB hitter
  avg: { p15: 0.215, p40: 0.245, p70: 0.275, p90: 0.305 },
  hits: { p15: 30, p40: 70, p70: 130, p90: 170 },
  hr: { p15: 3, p40: 10, p70: 22, p90: 32 },
  rbi: { p15: 15, p40: 40, p70: 75, p90: 100 },
  runs: { p15: 15, p40: 40, p70: 75, p90: 100 },
  sb: { p15: 1, p40: 4, p70: 12, p90: 25 },
  // MLB pitcher
  wins: { p15: 1, p40: 4, p70: 10, p90: 15 },
  era: { p15: 5.5, p40: 4.5, p70: 3.8, p90: 3.0, lowerIsBetter: true },
  innings_pitched: { p15: 25, p40: 70, p70: 140, p90: 180 },
  k_pitcher: { p15: 30, p40: 70, p70: 150, p90: 200 },
  whip: { p15: 1.5, p40: 1.35, p70: 1.2, p90: 1.05, lowerIsBetter: true },
  saves: { p15: 0, p40: 1, p70: 10, p90: 25 },
  // NHL skater
  goals: { p15: 3, p40: 8, p70: 18, p90: 28 },
  // (NHL assists / blocks reuse NBA-named keys — but the values differ)
  // We keep one numeric range per key; for hockey-specific assists use a hockey position group.
  sog: { p15: 30, p40: 80, p70: 150, p90: 230 },
  plus_minus: { p15: -12, p40: -3, p70: 5, p90: 15 },
  // NHL goalie
  save_pct: { p15: 0.89, p40: 0.905, p70: 0.918, p90: 0.93 },
  gaa: { p15: 3.4, p40: 2.95, p70: 2.6, p90: 2.25, lowerIsBetter: true },
  shutouts: { p15: 0, p40: 1, p70: 3, p90: 6 },
  // MLS
  shots: { p15: 4, p40: 12, p70: 30, p90: 55 },
  tackles: { p15: 8, p40: 25, p70: 50, p90: 80 },
  clean_sheets: { p15: 0, p40: 2, p70: 6, p90: 11 },
};

// ─── stats-per-position-group config ────────────────────────────────────────

interface PositionConfig {
  league: string;
  positionGroup: string;
  /** Stats to include in the tier file. Order = display order. */
  stats: string[];
}

const POSITION_CONFIGS: PositionConfig[] = [
  // NBA — same stat menu, different distributions per position
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

// MLS extra meta
STAT_META.assists = STAT_META.assists ?? { display_name: 'A', unit: 'assists', kid_friendly_name: 'setting up plays' };

const CACHE_FILES: Record<string, string> = {
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

function buildTierFile(cfg: PositionConfig): TierFile {
  const cache = loadCache(cfg.league);
  const sample_sizes: Record<string, number> = {};
  const stats: Record<string, StatBlock> = {};

  for (const stat of cfg.stats) {
    const meta = STAT_META[stat] ?? { display_name: stat, unit: stat, kid_friendly_name: stat };
    let bands: TierBand[];
    let sampleSize = 0;

    if (cache) {
      const values = cache.players
        .filter((p) => p.position_group === cfg.positionGroup && (p.stats.games_played ?? 0) >= 4)
        .map((p) => p.stats[stat])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const built = buildBands(values, !!meta.lower_is_better);
      bands = built.tiers;
      sampleSize = built.sampleSize;
    } else {
      // Fallback bands.
      const fb = FALLBACK_BANDS[stat];
      if (fb) {
        if (fb.lowerIsBetter) {
          bands = [
            { name: 'elite', min: 0, max: round(fb.p90), variants: [] },
            { name: 'strong', min: round(fb.p90 + 0.01), max: round(fb.p70), variants: [] },
            { name: 'solid', min: round(fb.p70 + 0.01), max: round(fb.p40), variants: [] },
            { name: 'role', min: round(fb.p40 + 0.01), max: round(fb.p15), variants: [] },
            { name: 'deep_bench', min: round(fb.p15 + 0.01), max: null, variants: [] },
          ];
        } else {
          bands = [
            { name: 'elite', min: round(fb.p90), max: null, variants: [] },
            { name: 'strong', min: round(fb.p70), max: round(fb.p90 - 0.01), variants: [] },
            { name: 'solid', min: round(fb.p40), max: round(fb.p70 - 0.01), variants: [] },
            { name: 'role', min: round(fb.p15), max: round(fb.p40 - 0.01), variants: [] },
            { name: 'deep_bench', min: 0, max: round(fb.p15 - 0.01), variants: [] },
          ];
        }
      } else {
        bands = [];
      }
    }

    // Attach Scout VO variants per tier band
    for (const band of bands) {
      band.variants = variantsFor(stat, band.name);
    }

    sample_sizes[stat] = sampleSize;
    stats[stat] = {
      display_name: meta.display_name,
      unit: meta.unit,
      kid_friendly_name: meta.kid_friendly_name,
      retrospective_prefix: 'Last season,',
      ...(meta.lower_is_better ? { lower_is_better: true } : {}),
      tiers: bands,
    };
  }

  return {
    league: cfg.league,
    position_group: cfg.positionGroup,
    last_reviewed: new Date().toISOString().slice(0, 10),
    notes: cache
      ? `Built from ${CACHE_FILES[cfg.league]}. Bands are PERCENTILE-BASED on the actual distribution of players with games_played >= 4. ` +
        `Tier semantics mirror the NFL files: elite ≈ top 10%, strong ≈ next 20%, solid ≈ next 30%, role ≈ next 25%, deep_bench ≈ bottom 15%.`
      : `Cache file ${CACHE_FILES[cfg.league]} not yet present — bands fall back to baked-in defaults calibrated to historical league norms. Re-run \`npm run pull:${cfg.league}\` then \`npm run generate-tier-files\` to refresh from real data.`,
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
    console.log(`[tiers] wrote ${path.relative(REPO_ROOT, out)}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[tiers] fatal:', err);
  process.exit(1);
});
