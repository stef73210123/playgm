/**
 * cacheLookup.ts — find a player in any of the per-league JSON caches.
 *
 * Caches are loaded lazily and held in-memory for the process lifetime —
 * the refresh job (jobs/refreshStats.ts) clears the cache when it rewrites
 * the JSON files.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { League } from '../stats/types.js';
import type { PlayerCacheEntry, SeasonCache } from '../../scripts/pull-stats-shared.js';
import { supabase } from '../../db/client.js';

const REPO_ROOT = (() => {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(cur, 'assets', 'stat-cache'))) return cur;
    cur = path.resolve(cur, '..');
  }
  return process.cwd();
})();

const CACHE_FILES: Record<League, string> = {
  nfl: 'nfl_season_2025.json',
  nba: 'nba_season_2025-26.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

interface LoadedCache { mtime: number; data: SeasonCache }
const loaded: Partial<Record<League, LoadedCache>> = {};

function loadCache(league: League): SeasonCache | null {
  const f = path.join(REPO_ROOT, 'assets', 'stat-cache', CACHE_FILES[league]);
  if (!existsSync(f)) return null;
  const mtime = statSync(f).mtimeMs;
  const cached = loaded[league];
  if (cached && cached.mtime === mtime) return cached.data;
  try {
    const data = JSON.parse(readFileSync(f, 'utf-8')) as SeasonCache;
    loaded[league] = { mtime, data };
    return data;
  } catch {
    return null;
  }
}

export interface CacheLookup {
  league: League;
  player: PlayerCacheEntry;
}

export function findPlayer(playerId: string): CacheLookup | null {
  for (const league of Object.keys(CACHE_FILES) as League[]) {
    const c = loadCache(league);
    if (!c) continue;
    const p = c.players.find((p) => p.external_id === playerId);
    if (p) return { league, player: p };
  }
  return null;
}

export function getCacheCounts(): Record<League, { players: number; lastModified: string | null }> {
  const out = {} as Record<League, { players: number; lastModified: string | null }>;
  for (const league of Object.keys(CACHE_FILES) as League[]) {
    const f = path.join(REPO_ROOT, 'assets', 'stat-cache', CACHE_FILES[league]);
    if (!existsSync(f)) {
      out[league] = { players: 0, lastModified: null };
      continue;
    }
    const c = loadCache(league);
    out[league] = {
      players: c?.players.length ?? 0,
      lastModified: new Date(statSync(f).mtimeMs).toISOString(),
    };
  }
  return out;
}

/**
 * Per-league rating-tier distribution (counts of players in each tier).
 * Computed lazily.
 */
export function getAllPlayers(league: League): { players: PlayerCacheEntry[] } | null {
  const c = loadCache(league);
  if (!c) return null;
  return { players: c.players };
}

export function clearCacheLookups(): void {
  for (const k of Object.keys(loaded) as League[]) {
    delete loaded[k];
  }
}

// ─── Supabase-first read paths (best-effort) ────────────────────────────────
//
// The runtime prefers Supabase `player_stats` / `player_ratings` when the
// migration is applied AND the row exists. If the query errors or returns
// nothing, callers should fall back to the in-memory JSON cache below — see
// routes/players.ts for the wiring.

export interface SupabasePlayerStats {
  player_id: string;
  sport: League;
  season: string;
  stats_json: Record<string, number>;
  fetched_at: string;
}

export interface SupabasePlayerRating {
  player_id: string;
  sport: League;
  season: string;
  /** v2 13-grade letter (A+, A, … F). After the rename migration runs, the
   *  underlying column is `overall_grade`; v1 rows that haven't been
   *  recomputed yet still carry the old 5-tier name in `overall_tier`. */
  overall_grade: string;
  /** @deprecated v1 column name — kept on the type so legacy reads still work. */
  overall_tier?: string;
  breakdowns_json: unknown;
  computed_at: string;
}

/**
 * Try to load player stats from Supabase. Returns null on miss / error so the
 * caller can fall back to the JSON cache. The sport filter is optional — when
 * omitted the lookup keys on (player_id) and grabs the freshest row.
 */
export async function getPlayerStats(
  playerId: string,
  sport?: League,
): Promise<SupabasePlayerStats | null> {
  try {
    let q = supabase.from('player_stats').select('*').eq('player_id', playerId);
    if (sport) q = q.eq('sport', sport);
    const { data, error } = await q.order('fetched_at', { ascending: false }).limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0] as SupabasePlayerStats;
  } catch {
    return null;
  }
}

/** Same shape, but for the ratings table. */
export async function getPlayerRating(
  playerId: string,
  sport?: League,
): Promise<SupabasePlayerRating | null> {
  try {
    let q = supabase.from('player_ratings').select('*').eq('player_id', playerId);
    if (sport) q = q.eq('sport', sport);
    const { data, error } = await q.order('computed_at', { ascending: false }).limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0] as SupabasePlayerRating;
  } catch {
    return null;
  }
}
