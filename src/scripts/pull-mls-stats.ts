/**
 * pull-mls-stats.ts — fetch the full 2026 MLS season cache via ESPN.
 * Output: assets/stat-cache/mls_season_2026.json
 *
 * NOTE: ESPN's soccer endpoint uses path slug `usa.1` for MLS. Stats keys differ
 * from the other leagues — `appearances` instead of `gamesPlayed`, `goalKeeping`
 * category instead of `goaltending`. Adapter handles the projection.
 */
import { cachePath, pullLeague } from './pull-stats-shared.js';

async function main(): Promise<void> {
  await pullLeague('mls', {
    season: '2026',
    seasonLabel: '2026 MLS season',
    outFile: cachePath('mls_season_2026.json'),
    notes:
      'Built from ESPN public site/core APIs (path slug usa.1 for MLS). position_group is fw|mf|df|gk. ' +
      'Outfield stats: goals/assists/shots/tackles. Goalkeeper stats: saves/clean_sheets.',
    minGamesPlayed: 4,
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pull:mls] fatal:', err);
  process.exit(1);
});
