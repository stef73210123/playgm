/**
 * clean-stat-caches.ts — one-shot pass over every league cache in
 * `assets/stat-cache/` that drops manager / coach rows and players with
 * all-zero stats, then atomically rewrites the file with refreshed totals
 * and an updated `notes` line.
 *
 * Run:
 *   npm run --workspace server clean:caches
 *   # or
 *   cd server && npx tsx --import ./src/env-loader.ts src/scripts/clean-stat-caches.ts
 *
 * Idempotent — running twice with no new pulls leaves the cache unchanged
 * (the filter is the same one applied at write time by pull-stats-shared.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { applyCacheFilter, cachePath, writeCacheAtomic } from './pull-stats-shared.js';
import type { SeasonCache } from './pull-stats-shared.js';
import type { League } from '../services/stats/types.js';

const CACHE_FILES: Record<League, string> = {
  nfl: 'nfl_season_2025.json',
  nba: 'nba_season_2025-26.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

interface PerLeagueReport {
  league: League;
  file: string;
  before: number;
  after: number;
  dropped_manager: number;
  dropped_zero_stat: number;
  changed: boolean;
}

async function cleanOne(league: League): Promise<PerLeagueReport | null> {
  const file = cachePath(CACHE_FILES[league]);
  if (!existsSync(file)) {
    // eslint-disable-next-line no-console
    console.log(`[clean:${league}] missing ${path.basename(file)} — skipped`);
    return null;
  }
  const raw = readFileSync(file, 'utf-8');
  const cache = JSON.parse(raw) as SeasonCache;
  const before = cache.players.length;
  const { kept, dropped_manager, dropped_zero_stat } = applyCacheFilter(cache.players);
  const after = kept.length;
  const changed = dropped_manager + dropped_zero_stat > 0;

  if (!changed) {
    // eslint-disable-next-line no-console
    console.log(`[clean:${league}] no-op (${before} players already clean)`);
    return { league, file, before, after, dropped_manager, dropped_zero_stat, changed };
  }

  const teamCount = new Set(kept.map((p) => p.team_abbr)).size;
  const playersWithAnyStat = kept.filter((p) => Object.keys(p.stats).length > 0).length;
  const byGroup: Record<string, number> = {};
  for (const p of kept) byGroup[p.position_group] = (byGroup[p.position_group] ?? 0) + 1;

  // Strip any prior "Filter applied: ..." sentence; append a fresh one.
  const baseNotes = (cache.notes ?? '').replace(/Filter applied:[^.]*\.\s*/g, '').trim();
  const filterNote =
    `Filter applied: dropped ${dropped_manager} manager/coach + ${dropped_zero_stat}` +
    ` zero-stat (kept ${after}/${before}).`;

  const next: SeasonCache = {
    ...cache,
    notes: `${baseNotes} ${filterNote}`.trim(),
    fetched_at: cache.fetched_at, // preserve the source pull timestamp
    totals: {
      teams: teamCount,
      players: after,
      players_with_any_stat: playersWithAnyStat,
      by_position_group: byGroup,
    },
    players: kept,
  };
  writeCacheAtomic(file, next);
  // eslint-disable-next-line no-console
  console.log(
    `[clean:${league}] ${before} → ${after}` +
      ` (-${dropped_manager} manager/coach, -${dropped_zero_stat} zero-stat)`,
  );
  return { league, file, before, after, dropped_manager, dropped_zero_stat, changed };
}

(async () => {
  const reports: PerLeagueReport[] = [];
  const leagues: League[] = ['nfl', 'nba', 'mlb', 'nhl', 'mls'];
  for (const l of leagues) {
    const r = await cleanOne(l);
    if (r) reports.push(r);
  }
  // eslint-disable-next-line no-console
  console.log('\n=== clean-stat-caches summary ===');
  for (const r of reports) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${r.league.padEnd(4)} ${r.before} → ${r.after}` +
        `  manager=-${r.dropped_manager}  zero_stat=-${r.dropped_zero_stat}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(reports));
})();
