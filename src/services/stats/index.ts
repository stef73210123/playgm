/**
 * services/stats/index.ts — adapter selection.
 *
 * Reads STATS_PROVIDER from process.env. Defaults to 'espn'.
 *   STATS_PROVIDER=espn         → free, unofficial, NOT licensed (default)
 *   STATS_PROVIDER=thesportsdb  → paid commercial, stub
 *   STATS_PROVIDER=apisports    → paid commercial, stub
 */
import { espnAdapter, EspnAdapter } from './espnAdapter.js';
import { thesportsdbAdapter } from './thesportsdbAdapter.js';
import { apisportsAdapter } from './apisportsAdapter.js';
import type { StatsAdapter } from './types.js';

export type { League, RosterEntry, SeasonStats, ScheduleEntry, BoxScore, StatsAdapter } from './types.js';
export { EspnAdapter };

let cachedAdapter: StatsAdapter | null = null;

export function getStatsAdapter(): StatsAdapter {
  if (cachedAdapter) return cachedAdapter;
  const provider = (process.env.STATS_PROVIDER ?? 'espn').toLowerCase();
  switch (provider) {
    case 'thesportsdb':
      cachedAdapter = thesportsdbAdapter;
      break;
    case 'apisports':
      cachedAdapter = apisportsAdapter;
      break;
    case 'espn':
    default:
      cachedAdapter = espnAdapter;
  }
  return cachedAdapter;
}

export function resetStatsAdapter(): void {
  cachedAdapter = null;
}
