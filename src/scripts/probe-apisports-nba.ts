/**
 * probe-apisports-nba.ts — quick end-to-end sanity check for the new
 * ApiSportsAdapter. Fetches one team's roster + season stats and prints a
 * spot-check for LeBron / Curry / Giannis.
 *
 * Run with: npx tsx --import ./src/env-loader.ts src/scripts/probe-apisports-nba.ts
 *
 * NOT run by cron — manual diagnostic. Burns ~3 API calls per run.
 */
import { apisportsAdapter } from '../services/stats/apisportsAdapter.js';

async function main(): Promise<void> {
  apisportsAdapter.nbaSeasonLabel = '2024-25';
  // Probe quota first so warning thresholds have a denominator.
  const q = await apisportsAdapter.probeQuota();
  console.log(`[probe] quota: plan=${q.plan} limit_day=${q.limitDay} remaining=${q.remainingDay}`);

  // LeBron is on team id 17 (LAL). Fetch the LAL roster + stats and look
  // for him + Russell + Hachimura.
  const lalStats = await apisportsAdapter.fetchTeamSeasonStats('nba', '17');
  console.log(`[probe] LAL season stats: ${lalStats.size} players aggregated`);

  // LeBron's id is 265 across the API.
  const targets = [
    { id: 'apisports:265', name: 'LeBron James' },
    { id: 'apisports:1862', name: 'Rui Hachimura' },
    { id: 'apisports:462', name: "D'Angelo Russell" },
  ];
  for (const t of targets) {
    const s = lalStats.get(t.id);
    if (!s) {
      console.log(`[probe] ${t.name} (${t.id}) — NOT FOUND in team stats`);
      continue;
    }
    console.log(
      `[probe] ${t.name}: gp=${s.gamesPlayed} pts=${s.stats.points} reb=${s.stats.rebounds} ast=${s.stats.assists} fg%=${s.stats.fg_pct} 3pm=${s.stats.three_pm}`,
    );
  }
}

main().catch((e) => {
  console.error('[probe] FAILED:', e);
  process.exit(1);
});
