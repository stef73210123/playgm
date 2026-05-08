/**
 * services/stats/index.ts — adapter selection.
 *
 * Two ways to pick an adapter:
 *
 *   1. Global default (legacy):
 *        STATS_PROVIDER=espn|thesportsdb|apisports
 *      Used when the caller can't pass a league (boot-time, generic helpers).
 *
 *   2. Per-league:
 *        getStatsAdapter('nba')
 *      Reads data/system/data_provider_config.json via dataProviderConfig.ts
 *      so ops can flip one sport to API-Sports without touching code or env.
 *
 * Per-league wins. The legacy `getStatsAdapter()` (no arg) returns the
 * global default and is kept for callers that haven't been updated yet.
 */
import { espnAdapter, EspnAdapter } from './espnAdapter.js';
import { thesportsdbAdapter } from './thesportsdbAdapter.js';
import { apisportsAdapter } from './apisportsAdapter.js';
import type { StatsAdapter, League } from './types.js';
import { getProviderForLeague, type ProviderId, type SportId } from '../dataProviderConfig.js';

export type { League, RosterEntry, SeasonStats, ScheduleEntry, BoxScore, StatsAdapter } from './types.js';
export { EspnAdapter };

const ADAPTERS: Record<ProviderId, StatsAdapter> = {
  espn: espnAdapter,
  thesportsdb: thesportsdbAdapter,
  apisports: apisportsAdapter,
};

let cachedDefaultAdapter: StatsAdapter | null = null;

/**
 * Get the active stats adapter. Pass a league for per-sport routing
 * (preferred); pass nothing to get the legacy global default.
 */
export function getStatsAdapter(league?: League): StatsAdapter {
  if (league) {
    const provider = getProviderForLeague(league as SportId);
    return ADAPTERS[provider] ?? espnAdapter;
  }
  if (cachedDefaultAdapter) return cachedDefaultAdapter;
  const env = (process.env.STATS_PROVIDER ?? 'espn').toLowerCase();
  cachedDefaultAdapter = ADAPTERS[env as ProviderId] ?? espnAdapter;
  return cachedDefaultAdapter;
}

export function resetStatsAdapter(): void {
  cachedDefaultAdapter = null;
}
