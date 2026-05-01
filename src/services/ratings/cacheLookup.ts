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
