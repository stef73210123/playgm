/**
 * backfill-player-career.ts — one-time aggregation: stat-cache → player_career.
 *
 * Run:
 *   cd server && npx tsx --import ./src/env-loader.ts src/scripts/backfill-player-career.ts
 *
 * Source of truth
 * ───────────────
 * Walks every file in `assets/stat-cache/` matching the
 * `<league>_season_<season>.json` naming convention (e.g. nba_season_2025-26.json).
 * For each `external_id` encountered, aggregates across seasons into a single
 * `player_career` row:
 *
 *   - career_stats_json: per-game averages across all seasons for that player.
 *     Counter totals (points_total, fgm_total, etc.) get summed, then divided
 *     by total games played to recompute averages exactly — no rounding drift
 *     from averaging averages.
 *
 *   - teams_played_for: ordered list of every team the player appears under in
 *     the cache files, newest-first. Each entry: { team, team_abbr, year_start,
 *     year_end, is_current }. `year_start`/`year_end` are best-effort from the
 *     season slug — we set year_start to the earliest season the player
 *     appeared with that team and year_end to the latest. `is_current` flips
 *     to true when the team matches the player's most-recent season.
 *
 *   - seasons_played: distinct season slugs the player appears in.
 *
 * NOTE on data sourcing
 * ─────────────────────
 * The JSON cache files were originally seeded by various adapters (TheSportsDB,
 * API-Sports, and historically ESPN). This script reads what's already on disk —
 * no live API calls are made. Per the Build 21 directive, all future cache
 * writes should come from API-Sports only; this script doesn't generate cache
 * data, just aggregates existing files.
 *
 * Idempotency: every write is an upsert on player_id. Safe to re-run.
 *
 * Quota note: zero API-Sports calls. Pure local FS → Supabase.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { supabase } from '../db/client.js';
import type { League } from '../services/stats/types.js';
import type { SeasonCache, PlayerCacheEntry } from './pull-stats-shared.js';

// ─── Repo root resolver (mirrors playerCareer.ts) ──────────────────────────

const REPO_ROOT = (() => {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(cur, 'assets', 'stat-cache'))) return cur;
    cur = path.resolve(cur, '..');
  }
  return process.cwd();
})();

const CACHE_DIR = path.join(REPO_ROOT, 'assets', 'stat-cache');

// ─── Cache walk ────────────────────────────────────────────────────────────

interface SeasonFile {
  league: League;
  season: string;
  filepath: string;
  mtime: number;
}

function listSeasonFiles(): SeasonFile[] {
  if (!existsSync(CACHE_DIR)) return [];
  const out: SeasonFile[] = [];
  for (const name of readdirSync(CACHE_DIR)) {
    const m = /^(nfl|nba|mlb|nhl|mls)_season_([0-9]{4}(?:-[0-9]{2})?)\.json$/i.exec(name);
    if (!m) continue;
    const fp = path.join(CACHE_DIR, name);
    out.push({
      league: m[1].toLowerCase() as League,
      season: m[2],
      filepath: fp,
      mtime: statSync(fp).mtimeMs,
    });
  }
  out.sort((a, b) => (a.season < b.season ? -1 : a.season > b.season ? 1 : 0));
  return out;
}

// ─── Per-league career projector ───────────────────────────────────────────
//
// We aggregate raw counter totals (points_total, fgm_total, …) across seasons
// when available, otherwise fall back to averaging the per-game averages
// across seasons (weighted by games_played). Keys mirror the projector in
// routes/statLines.ts so the client renders the rollup through the same
// StatCell layout the SEASON STATS section uses.

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

interface CareerStats { [key: string]: number }

interface Accumulator {
  gp: number;
  // Sums of totals across seasons. The cache files now persist these alongside
  // the per-game averages (added 2026-05-04 in pull-stats-shared mergePlayerStints).
  totals: Record<string, number>;
  // Fallback: weighted-average accumulators when totals aren't present.
  weighted: Record<string, { sum: number; weight: number }>;
}

function emptyAcc(): Accumulator {
  return { gp: 0, totals: {}, weighted: {} };
}

function addSeason(acc: Accumulator, league: League, raw: Record<string, number>) {
  const gp = Number(raw.games_played ?? 0);
  if (!Number.isFinite(gp) || gp <= 0) return;
  acc.gp += gp;
  // Sum any *_total keys directly.
  for (const [k, v] of Object.entries(raw)) {
    if (!k.endsWith('_total')) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    acc.totals[k] = (acc.totals[k] ?? 0) + v;
  }
  // Weighted-average accumulator for the per-game keys we read on the way out.
  const perGame: string[] =
    league === 'nba' ? ['points', 'rebounds', 'assists', 'steals', 'blocks', 'three_pm', 'fg_pct', 'ft_pct']
    : league === 'nfl' ? ['passing_yards', 'passing_touchdowns', 'rushing_yards', 'rushing_touchdowns',
                          'receptions', 'receiving_yards', 'receiving_touchdowns', 'interceptions']
    : league === 'mlb' ? ['avg', 'hr', 'rbi', 'hits', 'k_pitcher', 'era', 'wins']
    : league === 'nhl' ? ['goals', 'assists', 'plus_minus', 'save_pct', 'gaa', 'wins']
    : ['goals', 'assists', 'clean_sheets', 'saves'];
  for (const k of perGame) {
    const v = Number(raw[k]);
    if (!Number.isFinite(v)) continue;
    const entry = acc.weighted[k] ?? { sum: 0, weight: 0 };
    entry.sum += v * gp;
    entry.weight += gp;
    acc.weighted[k] = entry;
  }
}

function rollupStats(league: League, acc: Accumulator): CareerStats {
  const out: CareerStats = {};
  if (acc.gp === 0) return out;
  out.gamesPlayed = acc.gp;

  // Helper: prefer total/gp when a *_total key is present, else fall back to
  // the weighted average.
  function pick(rawKey: string, totalKey: string, decimals: 1 | 2 | 3 = 1): number | undefined {
    const total = acc.totals[totalKey];
    if (typeof total === 'number' && Number.isFinite(total) && acc.gp > 0) {
      const avg = total / acc.gp;
      return decimals === 1 ? round1(avg) : decimals === 2 ? round2(avg) : round3(avg);
    }
    const w = acc.weighted[rawKey];
    if (w && w.weight > 0) {
      const avg = w.sum / w.weight;
      return decimals === 1 ? round1(avg) : decimals === 2 ? round2(avg) : round3(avg);
    }
    return undefined;
  }

  switch (league) {
    case 'nba': {
      const ppg = pick('points', 'points_total'); if (ppg !== undefined) out.ppg = ppg;
      const rpg = pick('rebounds', 'rebounds_total'); if (rpg !== undefined) out.rpg = rpg;
      const apg = pick('assists', 'assists_total'); if (apg !== undefined) out.apg = apg;
      const spg = pick('steals', 'steals_total'); if (spg !== undefined) out.spg = spg;
      const bpg = pick('blocks', 'blocks_total'); if (bpg !== undefined) out.bpg = bpg;
      const tpm = pick('three_pm', 'three_pm_total'); if (tpm !== undefined) out.threePM = tpm;
      // Percentages: prefer FGM/FGA over averaging fg_pct across seasons.
      const fgm = acc.totals.fgm_total;
      const fga = acc.totals.fga_total;
      if (fgm !== undefined && fga && fga > 0) out.fgPct = round1((fgm / fga) * 100);
      else if (acc.weighted.fg_pct && acc.weighted.fg_pct.weight > 0) {
        out.fgPct = round1(acc.weighted.fg_pct.sum / acc.weighted.fg_pct.weight);
      }
      const ftm = acc.totals.ftm_total;
      const fta = acc.totals.fta_total;
      if (ftm !== undefined && fta && fta > 0) out.ftPct = round1((ftm / fta) * 100);
      else if (acc.weighted.ft_pct && acc.weighted.ft_pct.weight > 0) {
        out.ftPct = round1(acc.weighted.ft_pct.sum / acc.weighted.ft_pct.weight);
      }
      break;
    }
    case 'nfl': {
      const passY = pick('passing_yards', 'passing_yards_total'); if (passY !== undefined) out.passYards = Math.round(passY);
      const passT = pick('passing_touchdowns', 'passing_touchdowns_total'); if (passT !== undefined) out.passTDs = Math.round(passT);
      const rushY = pick('rushing_yards', 'rushing_yards_total'); if (rushY !== undefined) out.rushYards = Math.round(rushY);
      const rushT = pick('rushing_touchdowns', 'rushing_touchdowns_total'); if (rushT !== undefined) out.rushTDs = Math.round(rushT);
      const rec = pick('receptions', 'receptions_total'); if (rec !== undefined) out.receptions = Math.round(rec);
      const recY = pick('receiving_yards', 'receiving_yards_total'); if (recY !== undefined) out.recYards = Math.round(recY);
      const recT = pick('receiving_touchdowns', 'receiving_touchdowns_total'); if (recT !== undefined) out.recTDs = Math.round(recT);
      const ints = pick('interceptions', 'interceptions_total'); if (ints !== undefined) out.interceptions = Math.round(ints);
      break;
    }
    case 'mlb': {
      // For AVG/OBP/SLG we recompute from totals when possible.
      const ab = acc.totals.at_bats_total ?? acc.totals.at_bats;
      const hits = acc.totals.hits_total ?? acc.totals.hits;
      if (typeof ab === 'number' && ab > 0 && typeof hits === 'number') out.avg = round3(hits / ab);
      else { const a = pick('avg', 'avg', 3); if (a !== undefined) out.avg = a; }
      const hr = pick('hr', 'hr_total'); if (hr !== undefined) out.homeRuns = Math.round(hr);
      const rbi = pick('rbi', 'rbi_total'); if (rbi !== undefined) out.rbi = Math.round(rbi);
      const h = pick('hits', 'hits_total'); if (h !== undefined) out.hits = Math.round(h);
      const k = pick('k_pitcher', 'k_pitcher_total'); if (k !== undefined) out.strikeouts = Math.round(k);
      // ERA: prefer ER × 9 / IP-as-outs / 3 over averaging.
      const er = acc.totals.earned_runs_total ?? acc.totals.earned_runs;
      const outsPitched = acc.totals.outs_pitched_total ?? acc.totals.outs_pitched;
      if (typeof er === 'number' && typeof outsPitched === 'number' && outsPitched > 0) {
        out.era = round2((er * 27) / outsPitched);
      } else {
        const e = pick('era', 'era', 2); if (e !== undefined) out.era = e;
      }
      const w = pick('wins', 'wins_total'); if (w !== undefined) out.wins = Math.round(w);
      break;
    }
    case 'nhl': {
      const g = pick('goals', 'goals_total'); if (g !== undefined) out.goals = Math.round(g);
      const a = pick('assists', 'assists_total'); if (a !== undefined) out.assists = Math.round(a);
      const pm = pick('plus_minus', 'plus_minus_total'); if (pm !== undefined) out.plusMinus = Math.round(pm);
      const sp = pick('save_pct', 'save_pct'); if (sp !== undefined) out.savePct = sp;
      const ga = pick('gaa', 'gaa', 2); if (ga !== undefined) out.gaa = ga;
      const w = pick('wins', 'wins_total'); if (w !== undefined) out.wins = Math.round(w);
      break;
    }
    case 'mls': {
      const g = pick('goals', 'goals_total'); if (g !== undefined) out.goalsScored = Math.round(g);
      const a = pick('assists', 'assists_total'); if (a !== undefined) out.assistsSoccer = Math.round(a);
      const cs = pick('clean_sheets', 'clean_sheets_total'); if (cs !== undefined) out.cleanSheets = Math.round(cs);
      const s = pick('saves', 'saves_total'); if (s !== undefined) out.savesSoccer = Math.round(s);
      break;
    }
  }
  return out;
}

// ─── Year extraction from season slug ──────────────────────────────────────

function seasonStartYear(slug: string): number {
  // "2025-26" → 2025; "2025" → 2025; "2024-25" → 2024.
  const m = /^(\d{4})/.exec(slug);
  return m ? Number(m[1]) : 0;
}

function seasonEndYear(slug: string): number {
  // "2025-26" → 2026; "2025" → 2025.
  const m = /^(\d{4})-(\d{2})$/.exec(slug);
  if (m) return 2000 + Number(m[2]);
  return seasonStartYear(slug);
}

// ─── Aggregation ───────────────────────────────────────────────────────────

interface AccumulatorBundle {
  full_name: string;
  league: League;
  acc: Accumulator;
  /** Season slug → { team, team_abbr } first time we saw this player on this team. */
  appearances: Map<string, { team: string; team_abbr: string; season: string }>;
  most_recent_season: string;
  is_active: boolean;
}

async function run(): Promise<void> {
  const files = listSeasonFiles();
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`[backfill-player-career] no season cache files found in ${CACHE_DIR}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[backfill-player-career] scanning ${files.length} season files…`);

  const byPlayer = new Map<string, AccumulatorBundle>();

  for (const f of files) {
    let cache: SeasonCache;
    try {
      cache = JSON.parse(readFileSync(f.filepath, 'utf-8')) as SeasonCache;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[backfill-player-career] parse failed for ${f.filepath}: ${(err as Error).message}`);
      continue;
    }
    for (const p of cache.players as PlayerCacheEntry[]) {
      const id = p.external_id;
      if (!id) continue;
      const cur = byPlayer.get(id) ?? {
        full_name: p.full_name,
        league: f.league,
        acc: emptyAcc(),
        appearances: new Map(),
        most_recent_season: f.season,
        is_active: true,
      };
      cur.full_name = p.full_name;
      cur.league = f.league;
      addSeason(cur.acc, f.league, p.stats);
      // Earliest appearance with this team wins year_start; latest wins year_end.
      const key = `${p.team}|${p.team_abbr}`;
      const prior = cur.appearances.get(key);
      if (!prior || seasonStartYear(f.season) < seasonStartYear(prior.season)) {
        cur.appearances.set(key, { team: p.team, team_abbr: p.team_abbr, season: f.season });
      }
      // Track newest season + activity flag.
      if (seasonStartYear(f.season) > seasonStartYear(cur.most_recent_season)) {
        cur.most_recent_season = f.season;
      }
      cur.is_active = p.is_active !== false;
      byPlayer.set(id, cur);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[backfill-player-career] aggregated ${byPlayer.size} distinct players. Writing to player_career…`);

  // Project + flush in batches of 500.
  const BATCH = 500;
  const all = Array.from(byPlayer.entries());
  let written = 0;
  let failed = 0;

  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH);
    const rows = slice.map(([id, bundle]) => {
      const careerStats = rollupStats(bundle.league, bundle.acc);
      // Build teams_played_for newest-first. We don't have inter-season trade
      // history in a single-file-per-season cache, so each (team) gets a
      // single span covering [first season seen, latest season seen].
      const seasonsByTeam = new Map<string, { team: string; team_abbr: string; seasons: string[] }>();
      for (const [key, v] of bundle.appearances) {
        const e = seasonsByTeam.get(key) ?? { team: v.team, team_abbr: v.team_abbr, seasons: [] };
        e.seasons.push(v.season);
        seasonsByTeam.set(key, e);
      }
      const teamsPlayedFor = Array.from(seasonsByTeam.values()).map((e) => {
        const minSeason = e.seasons.reduce((a, b) => (seasonStartYear(a) < seasonStartYear(b) ? a : b));
        const maxSeason = e.seasons.reduce((a, b) => (seasonEndYear(a) > seasonEndYear(b) ? a : b));
        const isCurrent = maxSeason === bundle.most_recent_season;
        return {
          team: e.team,
          team_abbr: e.team_abbr,
          year_start: seasonStartYear(minSeason),
          year_end: isCurrent ? null : seasonEndYear(maxSeason),
          is_current: isCurrent,
        };
      });
      // Newest-first: is_current first, then year_end descending.
      teamsPlayedFor.sort((a, b) => {
        if (a.is_current && !b.is_current) return -1;
        if (!a.is_current && b.is_current) return 1;
        return (b.year_end ?? 0) - (a.year_end ?? 0);
      });

      const seasonsPlayed = new Set<string>();
      for (const v of bundle.appearances.values()) seasonsPlayed.add(v.season);

      return {
        player_id: id,
        sport: bundle.league,
        full_name: bundle.full_name,
        seasons_played: seasonsPlayed.size,
        career_stats_json: careerStats,
        teams_played_for: teamsPlayedFor,
        is_active: bundle.is_active,
        fetched_at: new Date().toISOString(),
      };
    });

    const { error, count } = await supabase
      .from('player_career')
      .upsert(rows, { onConflict: 'player_id', count: 'exact' });
    if (error) {
      // Table-missing is the deploy-state failure; halt early so we don't
      // hammer Supabase with bad batches.
      if (/schema cache/i.test(error.message)) {
        // eslint-disable-next-line no-console
        console.error(`[backfill-player-career] ABORT — player_career table missing. Run migration 012 first.`);
        process.exit(2);
      }
      failed += rows.length;
      // eslint-disable-next-line no-console
      console.warn(`[backfill-player-career] batch ${i / BATCH} failed: ${error.message}`);
    } else {
      written += count ?? rows.length;
    }
    // eslint-disable-next-line no-console
    console.log(`[backfill-player-career] progress: ${written}/${all.length} (failed=${failed})`);
  }

  // eslint-disable-next-line no-console
  console.log(`[backfill-player-career] DONE — fetched=${all.length} written=${written} failed=${failed}`);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[backfill-player-career] FATAL', err);
  process.exit(1);
});
