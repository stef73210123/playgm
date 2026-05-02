/**
 * recompute-ratings.ts — recompute every cached player's rating against the
 * current tier-band files, dual-write to Supabase `player_ratings`, and print
 * a per-league before/after summary.
 *
 *   Usage:
 *     # All leagues (default), dry-run + summary only
 *     npx tsx src/scripts/recompute-ratings.ts
 *
 *     # Single league, write to Supabase
 *     LEAGUES=mlb WRITE=1 npx tsx src/scripts/recompute-ratings.ts
 *
 *     # All five leagues, write to Supabase, suppress per-player output
 *     WRITE=1 SUMMARY_ONLY=1 npx tsx src/scripts/recompute-ratings.ts
 *
 * Reads from `assets/stat-cache/<league>_season_<season>.json` — same
 * authoritative cache the runtime uses. UPSERTs into player_ratings keyed by
 * (player_id, sport, season). Skips Supabase when SKIP_SUPABASE_DUAL_WRITE=1
 * (matching the convention in pull-stats-shared.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeRating, type Grade, GRADE_ORDER } from '../services/ratings/computeRatings.js';
import type { League } from '../services/stats/types.js';
import { supabase } from '../db/client.js';
import type { SeasonCache } from './pull-stats-shared.js';

const REPO_ROOT = (() => {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(cur, 'assets', 'stat-cache'))) return cur;
    cur = path.resolve(cur, '..');
  }
  return process.cwd();
})();

const CACHE_FILES: Record<League, string> = {
  nfl: 'nfl_season_2025.json',
  nba: 'nba_season_2025-26.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

const ALL_LEAGUES: League[] = ['nfl', 'nba', 'mlb', 'nhl', 'mls'];

interface RatingRow {
  player_id: string;
  sport: League;
  season: string;
  /** 13-grade letter — column renamed from `overall_tier` in 002_grade_rename.sql. */
  overall_grade: Grade;
  breakdowns_json: unknown;
  computed_at: string;
}

/** Build a fresh per-grade counter (A+, A, A-, …, F) all zeroed. */
function emptyGradeHistogram(): Record<Grade, number> {
  const out = {} as Record<Grade, number>;
  for (const g of GRADE_ORDER) out[g] = 0;
  return out;
}

const KNOWN_PLAYER_NAMES = [
  'Patrick Mahomes',
  'Nikola Jokic',
  'Shai Gilgeous-Alexander',
  'Luka Doncic',
  'Aaron Judge',
  'Shohei Ohtani',
  'Mike Trout',
  'Munetaka Murakami',
  'Cristopher Sanchez',
  'Connor McDavid',
];

async function processLeague(
  league: League,
  write: boolean,
  summaryOnly: boolean,
): Promise<{ league: League; computed: number; written: number; grades: Record<Grade, number>; confidenceMin: number; confidenceMax: number; spotChecks: string[] }> {
  const f = path.join(REPO_ROOT, 'assets', 'stat-cache', CACHE_FILES[league]);
  if (!existsSync(f)) {
    return {
      league,
      computed: 0,
      written: 0,
      grades: emptyGradeHistogram(),
      confidenceMin: 0,
      confidenceMax: 0,
      spotChecks: [`(no cache file at ${f})`],
    };
  }
  const cache = JSON.parse(readFileSync(f, 'utf-8')) as SeasonCache;
  const season = String(cache.season);
  const rows: RatingRow[] = [];
  const grades = emptyGradeHistogram();
  let confidenceMin = 1;
  let confidenceMax = 0;
  const spotChecks: string[] = [];
  const knownLower = new Set(KNOWN_PLAYER_NAMES.map((n) => n.toLowerCase()));

  for (const p of cache.players) {
    const r = computeRating({
      playerId: p.external_id,
      sport: league,
      position: p.position_group,
      stats: p.stats,
    });
    if (!r) continue;
    grades[r.overall_grade] = (grades[r.overall_grade] ?? 0) + 1;
    if (r.confidence < confidenceMin) confidenceMin = r.confidence;
    if (r.confidence > confidenceMax) confidenceMax = r.confidence;
    rows.push({
      player_id: r.player_id,
      sport: league,
      season,
      overall_grade: r.overall_grade,
      breakdowns_json: {
        position: r.position,
        score: r.score,
        confidence: r.confidence,
        stat_breakdowns: r.stat_breakdowns,
        ...(r.secondary_grade ? { secondary_grade: r.secondary_grade } : {}),
      },
      computed_at: new Date().toISOString(),
    });
    // Spot checks: surface known names regardless of summary_only.
    for (const tn of knownLower) {
      if ((p.full_name || '').toLowerCase().includes(tn)) {
        spotChecks.push(
          `${p.full_name.padEnd(28)} ${league} ${p.position}/${p.position_group} → ${r.overall_grade.padEnd(3)} score=${r.score} conf=${r.confidence}${r.secondary_grade ? ` alt=${r.secondary_grade.position}:${r.secondary_grade.overall_grade}` : ''}`,
        );
      }
    }
  }

  let written = 0;
  if (write && rows.length > 0 && process.env.SKIP_SUPABASE_DUAL_WRITE !== '1') {
    const CHUNK = 500;
    // Pre-migration the column is still `overall_tier` (5-tier). If the DB
    // refuses the new column name we map back to the 5-tier bucket so the
    // dual-write keeps working through the migration window.
    let columnState: 'grade' | 'tier' = 'grade';
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const payload = columnState === 'grade'
        ? slice
        : slice.map((r) => ({
            player_id: r.player_id,
            sport: r.sport,
            season: r.season,
            overall_tier: gradeLetterToLegacyTier(r.overall_grade),
            breakdowns_json: r.breakdowns_json,
            computed_at: r.computed_at,
          }));
      const { error } = await supabase
        .from('player_ratings')
        .upsert(payload, { onConflict: 'player_id,sport,season' });
      if (error) {
        // If the new column doesn't exist yet, retry once with the legacy column name.
        if (columnState === 'grade' && /column .*overall_grade/i.test(error.message)) {
          columnState = 'tier';
          // eslint-disable-next-line no-console
          console.warn(`[ratings] ${league}: overall_grade column missing — falling back to overall_tier (run 002_grade_rename.sql to upgrade).`);
          i -= CHUNK; // retry this slice
          continue;
        }
        // eslint-disable-next-line no-console
        console.error(`[ratings] ${league} chunk ${i}/${rows.length} failed:`, error.message);
        break;
      }
      written += slice.length;
    }
  }

  function gradeLetterToLegacyTier(g: Grade): string {
    if (g.startsWith('A')) return 'elite';
    if (g.startsWith('B')) return 'strong';
    if (g.startsWith('C')) return 'solid';
    if (g.startsWith('D')) return 'role';
    return 'deep_bench';
  }
  if (!summaryOnly) {
    // eslint-disable-next-line no-console
    console.log(`[ratings] ${league}: computed ${rows.length}, grades=${JSON.stringify(grades)}`);
  }
  return { league, computed: rows.length, written, grades, confidenceMin, confidenceMax, spotChecks };
}

async function main(): Promise<void> {
  const requested = (process.env.LEAGUES || 'nfl,nba,mlb,nhl,mls')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is League => (ALL_LEAGUES as string[]).includes(s));
  const write = process.env.WRITE === '1';
  const summaryOnly = process.env.SUMMARY_ONLY === '1';

  if (write && process.env.SKIP_SUPABASE_DUAL_WRITE === '1') {
    // eslint-disable-next-line no-console
    console.log('[ratings] WRITE=1 but SKIP_SUPABASE_DUAL_WRITE=1 — skipping Supabase upsert.');
  }

  const results = [];
  for (const lg of requested) {
    // eslint-disable-next-line no-console
    console.log(`[ratings] processing ${lg}...`);
    const r = await processLeague(lg, write, summaryOnly);
    results.push(r);
  }

  // eslint-disable-next-line no-console
  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${r.league}: computed=${r.computed} written=${r.written} confidence=[${r.confidenceMin.toFixed(2)}..${r.confidenceMax.toFixed(2)}] grades=${JSON.stringify(r.grades)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log('\n=== SPOT CHECKS (well-known players) ===');
  for (const r of results) {
    for (const sc of r.spotChecks) console.log(`  ${sc}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[ratings] fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
