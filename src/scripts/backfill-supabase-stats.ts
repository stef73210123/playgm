/**
 * backfill-supabase-stats.ts — push every existing JSON cache into Supabase
 * `player_stats` via the same dual-write helper used by the pull scripts.
 *
 * Run:
 *   cd server && npx tsx --import ./src/env-loader.ts src/scripts/backfill-supabase-stats.ts
 *
 * Idempotent — uses upsert(onConflict: player_id,sport,season). Safe to re-run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { cachePath, dualWritePlayerStats } from './pull-stats-shared.js';
import type { SeasonCache } from './pull-stats-shared.js';
import type { League } from '../services/stats/types.js';

const CACHE_FILES: Record<League, string> = {
  nfl: 'nfl_season_2025.json',
  nba: 'nba_season_2025-26.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

(async () => {
  const leagues: League[] = ['nfl', 'nba', 'mlb', 'nhl', 'mls'];
  for (const league of leagues) {
    const f = cachePath(CACHE_FILES[league]);
    if (!existsSync(f)) {
      // eslint-disable-next-line no-console
      console.log(`[backfill:${league}] cache missing — skip`);
      continue;
    }
    const cache = JSON.parse(readFileSync(f, 'utf-8')) as SeasonCache;
    if (cache.players.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[backfill:${league}] cache empty — skip`);
      continue;
    }
    // eslint-disable-next-line no-console
    console.log(`[backfill:${league}] upserting ${cache.players.length} rows…`);
    await dualWritePlayerStats(league, String(cache.season), cache.players);
  }
})();
