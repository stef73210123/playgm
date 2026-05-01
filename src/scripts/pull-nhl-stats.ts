/**
 * pull-nhl-stats.ts — fetch the full 2025-26 NHL season cache via ESPN.
 * Output: assets/stat-cache/nhl_season_2025-26.json
 */
import { cachePath, pullLeague } from './pull-stats-shared.js';

async function main(): Promise<void> {
  await pullLeague('nhl', {
    season: '2025-26',
    seasonLabel: '2025-26 NHL season',
    outFile: cachePath('nhl_season_2025-26.json'),
    notes:
      'Built from ESPN public site/core APIs. position_group is skater|goalie. ' +
      'Skater stats: goals/assists/sog/plus_minus/blocks/pim. Goalie stats: saves/save_pct/gaa/wins/shutouts.',
    minGamesPlayed: 4,
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pull:nhl] fatal:', err);
  process.exit(1);
});
