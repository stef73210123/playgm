/**
 * computeRatings.ts — per-player tier rating.
 *
 * Algorithm:
 *   1. Load the tier-band file for (sport × position_group).
 *   2. For each stat in the tier file, place the player's value into one of
 *      the 5 bands (elite / strong / solid / role / deep_bench) — respect
 *      lower_is_better.
 *   3. Convert each band to a numeric score (elite=5, strong=4, solid=3,
 *      role=2, deep_bench=1).
 *   4. Weight via pgm_stat_resolution.json:
 *        PRIMARY 50%, SECONDARY 30%, TERTIARY 20%.
 *      Stats outside the primary/secondary/tertiary trio also count, equally
 *      averaged into the remainder so the score isn't dominated by a single
 *      stat. The 50/30/20 weighting applies when those stats exist; if some
 *      are missing we redistribute proportionally among what's available.
 *   5. Map the 1..5 weighted score to a tier:
 *        score >= 4.5 → elite
 *        score >= 3.5 → strong
 *        score >= 2.5 → solid
 *        score >= 1.5 → role
 *        else         → deep_bench
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { League } from '../stats/types.js';

export type TierName = 'elite' | 'strong' | 'solid' | 'role' | 'deep_bench';

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
  tier: TierName;
}

export interface RatingResult {
  player_id: string;
  sport: League;
  position: string;
  overall_tier: TierName;
  stat_breakdowns: StatBreakdown[];
  /** Numeric score in [1,5]. Useful for sorting / debugging. */
  score: number;
  source: 'tier-files-v1';
}

interface TierBandRaw {
  name: TierName;
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
  tiers: TierBandRaw[];
  /** dual_threat_only / min_value_to_show — only consider for the breakdown VO line, not for the rating math. */
  dual_threat_only?: boolean;
  min_value_to_show?: number;
}

interface TierFileRaw {
  league: string;
  position_group: string;
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
  // The server code runs from <repo>/server (dev: cwd) or <repo>/server/dist (build).
  // Walk up until we find a folder containing both `assets` and `data`.
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

/**
 * Map sport + position → tier-file slug.
 * NFL position group is already lowercased like 'qb', 'wr-te'. NBA uses raw
 * position 'PG'. MLB hitter/pitcher. NHL skater/goalie. MLS fw/mf/df/gk.
 */
export function tierFileSlug(sport: League, positionGroup: string): string {
  const tag = positionGroup.toLowerCase();
  // NFL: nfl-qb / nfl-rb / nfl-wr-te / nfl-defense / nfl-special.
  // The tier files are named `<sport>-<positionGroup>.json`.
  return `${sport}-${tag}`;
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
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as TierFileRaw;
    tierFileCache.set(slug, data);
    return data;
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

// ─── tier placement ─────────────────────────────────────────────────────────

/** Place a value into the right band. lower_is_better is honored. */
export function placeBand(value: number, block: StatBlockRaw): TierName {
  if (!block.tiers || block.tiers.length === 0) return 'solid';
  for (const t of block.tiers) {
    const min = t.min;
    const max = t.max;
    if (max === null) {
      if (value >= min) return t.name;
    } else if (value >= min && value <= max) {
      return t.name;
    }
  }
  // Fallback: pick the lowest band (deep_bench) if value is below all minima
  // (shouldn't happen with min:0 + max:null sentinel pair).
  return 'deep_bench';
}

const TIER_SCORE: Record<TierName, number> = {
  elite: 5,
  strong: 4,
  solid: 3,
  role: 2,
  deep_bench: 1,
};

function scoreToTier(score: number): TierName {
  if (score >= 4.5) return 'elite';
  if (score >= 3.5) return 'strong';
  if (score >= 2.5) return 'solid';
  if (score >= 1.5) return 'role';
  return 'deep_bench';
}

// ─── league → resolution-file sport-key map ─────────────────────────────────

const SPORT_KEY: Record<League, string> = {
  nfl: 'football',
  nba: 'basketball',
  mlb: 'baseball',
  nhl: 'hockey',
  mls: 'soccer',
};

/**
 * Resolution lookup → primary/secondary/tertiary stat names for this position.
 * Falls back to the sport-level defaults. May return null for sports without
 * a block (shouldn't happen for the 5 we support).
 */
export function lookupStatPriorities(sport: League, position: string): { primary: string; secondary: string; tertiary: string } | null {
  const r = loadResolution();
  if (!r) return null;
  const sportKey = SPORT_KEY[sport];
  const block = r.stat_resolution[sportKey];
  if (!block) return null;
  // pgm_stat_resolution.json is keyed by raw position (QB / PG / SP / C / FW).
  // We use the position string the caller passed — usually the raw position
  // for NBA/MLS, position_group ('qb' uppercase variant) for NFL, 'hitter' or
  // 'pitcher' for MLB, etc. Try a case-insensitive match against the block.
  const upper = position.toUpperCase();
  const found = block.by_position[upper] ?? block.by_position[position];
  if (found) return found;
  // hitter/pitcher aren't keys in the resolution file (it has 1B/2B/SP/RP).
  // Map them to representative entries.
  if (sport === 'mlb') {
    if (position.toLowerCase() === 'pitcher') return block.by_position.SP ?? null;
    if (position.toLowerCase() === 'hitter') return block.by_position.OF ?? null;
  }
  if (sport === 'nhl') {
    if (position.toLowerCase() === 'goalie') return block.by_position.G ?? null;
    if (position.toLowerCase() === 'skater') return block.by_position.C ?? null;
  }
  if (sport === 'nfl') {
    // NFL positions in resolution file: QB / RB / WR / TE / DEF
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

// ─── core ───────────────────────────────────────────────────────────────────

export function computeRating(input: RatingInput): RatingResult | null {
  const tierFile = loadTierFile(input.sport, input.position);
  if (!tierFile) return null;

  const breakdowns: StatBreakdown[] = [];
  const placements: Record<string, TierName> = {};

  for (const [statName, block] of Object.entries(tierFile.stats)) {
    const v = input.stats[statName];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const tier = placeBand(v, block);
    placements[statName] = tier;
    breakdowns.push({ stat: statName, value: v, tier });
  }

  if (breakdowns.length === 0) {
    // Player exists but no measurable stats. Rate as deep_bench but flag.
    return {
      player_id: input.playerId,
      sport: input.sport,
      position: input.position,
      overall_tier: 'deep_bench',
      stat_breakdowns: [],
      score: 1,
      source: 'tier-files-v1',
    };
  }

  // Weight via PRIMARY/SECONDARY/TERTIARY.
  const pri = lookupStatPriorities(input.sport, input.position);
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
        weightedSum += TIER_SCORE[placements[w.stat]] * w.weight;
        totalWeight += w.weight;
        weightedStats.add(w.stat);
      }
    }
    // Average other stats (un-prioritized) into the remainder.
    const otherKeys = Object.keys(placements).filter((k) => !weightedStats.has(k));
    if (otherKeys.length > 0) {
      const remaining = Math.max(0, 1 - totalWeight);
      const otherAvg = otherKeys.reduce((sum, k) => sum + TIER_SCORE[placements[k]], 0) / otherKeys.length;
      if (remaining > 0) {
        weightedSum += otherAvg * remaining;
        totalWeight += remaining;
      } else if (totalWeight === 0) {
        // No prioritized stats matched — fall back to flat average.
        weightedSum = otherAvg * 1;
        totalWeight = 1;
      }
    }
    score = totalWeight > 0 ? weightedSum / totalWeight : 1;
  } else {
    // No resolution entry — flat average across all matched stats.
    const sum = breakdowns.reduce((s, b) => s + TIER_SCORE[b.tier], 0);
    score = sum / breakdowns.length;
  }

  return {
    player_id: input.playerId,
    sport: input.sport,
    position: input.position,
    overall_tier: scoreToTier(score),
    stat_breakdowns: breakdowns,
    score: Math.round(score * 100) / 100,
    source: 'tier-files-v1',
  };
}

/** Test-only: clear caches between tests. */
export function _clearRatingCaches(): void {
  tierFileCache.clear();
  resolutionCache = null;
}
