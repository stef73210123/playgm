/**
 * pull-nba-stats.ts — fetch the full 2025-26 NBA season cache via ESPN.
 * Output: assets/stat-cache/nba_season_2025-26.json
 */
import { cachePath, pullLeague } from './pull-stats-shared.js';

async function main(): Promise<void> {
  await pullLeague('nba', {
    season: '2025-26',
    seasonLabel: '2025-26 NBA season',
    outFile: cachePath('nba_season_2025-26.json'),
    notes:
      'Built from ESPN public site/core APIs. position_group mirrors raw position (PG/SG/SF/PF/C). ' +
      'Stats per pgm_stat_resolution.json basketball block: points/rebounds/assists/steals/blocks/three_pm/fg_pct/ft_pct/minutes.',
    minGamesPlayed: 4,
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pull:nba] fatal:', err);
  process.exit(1);
});
