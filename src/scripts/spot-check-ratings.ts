/**
 * spot-check-ratings.ts — sanity-check well-known players against the
 * tier-band system. Used to verify each league after a tier-file refresh.
 * Run: `npx tsx src/scripts/spot-check-ratings.ts` from server/.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeRating } from '../services/ratings/computeRatings.js';
import type { League } from '../services/stats/types.js';

const REPO_ROOT = (() => {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(cur, 'assets', 'stat-cache'))) return cur;
    cur = path.resolve(cur, '..');
  }
  return process.cwd();
})();

const targets: Array<{ name: string; sport: League }> = [
  { name: 'Aaron Judge', sport: 'mlb' },
  { name: 'Shohei Ohtani', sport: 'mlb' },
  { name: 'Mike Trout', sport: 'mlb' },
  { name: 'Munetaka Murakami', sport: 'mlb' },
  { name: 'Cristopher Sanchez', sport: 'mlb' },
  { name: 'Patrick Mahomes', sport: 'nfl' },
  { name: 'Nikola Jokic', sport: 'nba' },
  { name: 'Shai Gilgeous-Alexander', sport: 'nba' },
  { name: 'Luka Doncic', sport: 'nba' },
  { name: 'Connor McDavid', sport: 'nhl' },
];

const cacheFile: Record<League, string> = {
  nfl: 'nfl_season_2025.json',
  nba: 'nba_season_2025-26.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

const caches: Partial<Record<League, { players: Array<{ external_id: string; full_name: string; position: string; position_group: string; stats: Record<string, number> }> }>> = {};
for (const league of Object.keys(cacheFile) as League[]) {
  const f = path.join(REPO_ROOT, 'assets', 'stat-cache', cacheFile[league]);
  if (existsSync(f)) caches[league] = JSON.parse(readFileSync(f, 'utf-8'));
}

for (const t of targets) {
  const c = caches[t.sport];
  if (!c) {
    console.log(`[skip] ${t.name}: no ${t.sport} cache`);
    continue;
  }
  const p = c.players.find((p) => (p.full_name || '').toLowerCase().includes(t.name.toLowerCase()));
  if (!p) {
    console.log(`[!] ${t.name}: NOT in ${t.sport} cache`);
    continue;
  }
  const r = computeRating({ playerId: p.external_id, sport: t.sport, position: p.position_group, stats: p.stats });
  if (!r) {
    console.log(`[!] ${t.name}: rating null (tier file missing for ${t.sport}/${p.position_group})`);
    continue;
  }
  const alt = r.secondary_grade ? ` (alt:${r.secondary_grade.position}=${r.secondary_grade.overall_grade})` : '';
  console.log(
    `${t.name.padEnd(28)} ${t.sport} ${p.position}/${p.position_group} → ${r.overall_grade.padEnd(3)} score=${r.score} conf=${r.confidence}${alt}`,
  );
  // eslint-disable-next-line no-console
  console.log(`    stats: ${JSON.stringify(p.stats)}`);
}
