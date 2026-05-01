/**
 * pull-mlb-stats.ts — fetch the full 2026 MLB season cache via ESPN.
 * Output: assets/stat-cache/mlb_season_2026.json
 */
import { cachePath, pullLeague } from './pull-stats-shared.js';

async function main(): Promise<void> {
  await pullLeague('mlb', {
    season: '2026',
    seasonLabel: '2026 MLB season',
    outFile: cachePath('mlb_season_2026.json'),
    notes:
      'Built from ESPN public site/core APIs. position_group is hitter|pitcher (the tier files split this way). ' +
      'Hitter stats: avg/hits/hr/rbi/runs/sb/obp/slg. Pitcher stats: wins/losses/era/innings_pitched/k_pitcher/whip/saves.',
    minGamesPlayed: 4,
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pull:mlb] fatal:', err);
  process.exit(1);
});
