/**
 * routes/playerCareer.ts — per-player season-by-season career history.
 *
 * Background
 * ──────────
 * The scouting report's CAREER table previously synthesized prior seasons by
 * perturbing the current-season averages by ±20% (deterministic per player id).
 * That was always a placeholder — the comment in ScoutingReportModal even
 * called it out: "Real career history will replace this when it lands."
 *
 * This route is the seam where real career history plugs in. It scans every
 * file in `assets/stat-cache/` whose name encodes a season (e.g.
 * `nba_season_2024-25.json`, `nfl_season_2024.json`) and aggregates the rows
 * for the requested external_id into a season-by-season array.
 *
 * Today the cache only carries one season per league (the most recent), so the
 * endpoint will normally return a 1-row array with `partial: true`. As we
 * back-fill prior seasons (or wire historical ESPN endpoints into the refresh
 * job), this route picks them up automatically — no client change needed.
 *
 * Endpoint
 * ────────
 *   GET /api/stats/player/by-id/:externalId/career
 *
 * Response shape:
 *   {
 *     player_id: "espn:1966",
 *     league:    "nba",
 *     full_name: "LeBron James",
 *     partial:   true,                          // < 5 seasons available
 *     seasons: [
 *       { season: "2025-26", team: "Los Angeles Lakers", team_abbr: "LAL",
 *         stats: { ppg: 24.3, rpg: 7.6, ... } },
 *       ...
 *     ],
 *   }
 *
 * Returns 404 with `{ error: "player_not_found" }` when the id isn't present
 * in any season cache so the client can render the placeholder copy.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PlayerCacheEntry, SeasonCache } from '../scripts/pull-stats-shared.js';
import type { League } from '../services/stats/types.js';
import { isSportEnabled } from '../services/sportsConfig.js';
import { findPlayer } from '../services/ratings/cacheLookup.js';

// ─── Repo root resolver (mirrors cacheLookup.ts) ────────────────────────────

const REPO_ROOT = (() => {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(cur, 'assets', 'stat-cache'))) return cur;
    cur = path.resolve(cur, '..');
  }
  return process.cwd();
})();

const CACHE_DIR = path.join(REPO_ROOT, 'assets', 'stat-cache');

// ─── Stat-cache file enumeration ────────────────────────────────────────────
//
// File naming convention: `<league>_season_<season>.json`. Season is either a
// single year ("2025") or a split-year string ("2025-26"). We extract the
// season from the filename rather than the file body so multiple-season
// files for the same league aren't silently de-duped on `season_label`.

interface SeasonFile {
  league: League;
  season: string;     // raw season slug from filename (e.g. "2025-26")
  filepath: string;
  mtime: number;
}

function listSeasonFiles(): SeasonFile[] {
  if (!existsSync(CACHE_DIR)) return [];
  const out: SeasonFile[] = [];
  for (const name of readdirSync(CACHE_DIR)) {
    // Match: "<league>_season_<season>.json"
    const m = /^(nfl|nba|mlb|nhl|mls)_season_([0-9]{4}(?:-[0-9]{2})?)\.json$/i.exec(name);
    if (!m) continue;
    const filepath = path.join(CACHE_DIR, name);
    out.push({
      league: m[1].toLowerCase() as League,
      season: m[2],
      filepath,
      mtime: statSync(filepath).mtimeMs,
    });
  }
  // Most-recent first by season slug — string compare works because the
  // year prefix sorts naturally ("2025-26" > "2024-25" > "2024").
  out.sort((a, b) => (a.season < b.season ? 1 : a.season > b.season ? -1 : 0));
  return out;
}

// In-memory cache keyed on filepath + mtime so concurrent requests don't
// re-parse the JSON. Cleared implicitly when the file mtime changes.
interface ParsedFile { mtime: number; data: SeasonCache }
const parsed: Record<string, ParsedFile> = {};
function readSeasonFile(f: SeasonFile): SeasonCache | null {
  const cached = parsed[f.filepath];
  if (cached && cached.mtime === f.mtime) return cached.data;
  try {
    const data = JSON.parse(readFileSync(f.filepath, 'utf-8')) as SeasonCache;
    parsed[f.filepath] = { mtime: f.mtime, data };
    return data;
  } catch {
    return null;
  }
}

// ─── Stat projection — same shape the client renders today ──────────────────
//
// We mirror the projector in routes/statLines.ts on purpose: the client
// already understands these keys, so the career rows render through the
// same StatCell + lookup paths the SEASON STATS section uses. Keep the
// two projectors in lockstep when adding new sport stats.

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

interface CareerStatLine {
  // Basketball
  ppg?: number; rpg?: number; apg?: number; spg?: number; bpg?: number;
  threePM?: number; fgPct?: number; ftPct?: number;
  // Football
  passYards?: number; passTDs?: number; rushYards?: number; rushTDs?: number;
  receptions?: number; recYards?: number; recTDs?: number; interceptions?: number;
  // Baseball
  avg?: number; homeRuns?: number; rbi?: number; hits?: number;
  strikeouts?: number; era?: number; wins?: number;
  // Hockey
  goals?: number; assists?: number; plusMinus?: number;
  savePct?: number; gaa?: number;
  // Soccer
  goalsScored?: number; assistsSoccer?: number; cleanSheets?: number; savesSoccer?: number;
  // Universal
  gamesPlayed?: number;
}

function projectStats(league: League, raw: Record<string, number>): CareerStatLine {
  const s: CareerStatLine = {};
  if (typeof raw.games_played === 'number') s.gamesPlayed = raw.games_played;
  switch (league) {
    case 'nba':
      if (typeof raw.points === 'number')   s.ppg     = round1(raw.points);
      if (typeof raw.rebounds === 'number') s.rpg     = round1(raw.rebounds);
      if (typeof raw.assists === 'number')  s.apg     = round1(raw.assists);
      if (typeof raw.steals === 'number')   s.spg     = round1(raw.steals);
      if (typeof raw.blocks === 'number')   s.bpg     = round1(raw.blocks);
      if (typeof raw.three_pm === 'number') s.threePM = round1(raw.three_pm);
      if (typeof raw.fg_pct === 'number')   s.fgPct   = round1(raw.fg_pct);
      if (typeof raw.ft_pct === 'number')   s.ftPct   = round1(raw.ft_pct);
      break;
    case 'nfl':
      if (typeof raw.passing_yards === 'number')        s.passYards = Math.round(raw.passing_yards);
      if (typeof raw.passing_touchdowns === 'number')   s.passTDs   = Math.round(raw.passing_touchdowns);
      if (typeof raw.rushing_yards === 'number')        s.rushYards = Math.round(raw.rushing_yards);
      if (typeof raw.rushing_touchdowns === 'number')   s.rushTDs   = Math.round(raw.rushing_touchdowns);
      if (typeof raw.receptions === 'number')           s.receptions= Math.round(raw.receptions);
      if (typeof raw.receiving_yards === 'number')      s.recYards  = Math.round(raw.receiving_yards);
      if (typeof raw.receiving_touchdowns === 'number') s.recTDs    = Math.round(raw.receiving_touchdowns);
      if (typeof raw.interceptions === 'number')        s.interceptions = Math.round(raw.interceptions);
      break;
    case 'mlb':
      if (typeof raw.avg === 'number')        s.avg = round3(raw.avg);
      if (typeof raw.hr === 'number')         s.homeRuns = Math.round(raw.hr);
      if (typeof raw.rbi === 'number')        s.rbi = Math.round(raw.rbi);
      if (typeof raw.hits === 'number')       s.hits = Math.round(raw.hits);
      if (typeof raw.k_pitcher === 'number')  s.strikeouts = Math.round(raw.k_pitcher);
      if (typeof raw.era === 'number')        s.era = round2(raw.era);
      if (typeof raw.wins === 'number')       s.wins = Math.round(raw.wins);
      break;
    case 'nhl':
      if (typeof raw.goals === 'number')      s.goals     = Math.round(raw.goals);
      if (typeof raw.assists === 'number')    s.assists   = Math.round(raw.assists);
      if (typeof raw.plus_minus === 'number') s.plusMinus = Math.round(raw.plus_minus);
      if (typeof raw.save_pct === 'number')   s.savePct   = round1(raw.save_pct);
      if (typeof raw.gaa === 'number')        s.gaa       = round2(raw.gaa);
      if (typeof raw.wins === 'number')       s.wins      = Math.round(raw.wins);
      break;
    case 'mls':
      if (typeof raw.goals === 'number')        s.goalsScored   = Math.round(raw.goals);
      if (typeof raw.assists === 'number')      s.assistsSoccer = Math.round(raw.assists);
      if (typeof raw.clean_sheets === 'number') s.cleanSheets   = Math.round(raw.clean_sheets);
      if (typeof raw.saves === 'number')        s.savesSoccer   = Math.round(raw.saves);
      break;
  }
  return s;
}

// ─── Public response shape ───────────────────────────────────────────────────

export interface CareerSeason {
  season: string;          // raw season slug ("2025-26" or "2025")
  season_label: string;    // human-friendly label from the cache file
  team: string;
  team_abbr: string;
  stats: CareerStatLine;
}

export interface CareerResponse {
  player_id: string;
  league: League;
  full_name: string;
  /** True when fewer than 5 seasons are available. The client renders a
   *  small caption ("Only X season(s) of career data available") so the
   *  table doesn't read as wrong-data. */
  partial: boolean;
  seasons: CareerSeason[];
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function playerCareerRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { externalId: string } }>(
    '/api/stats/player/by-id/:externalId/career',
    async (req, reply) => {
      const id = decodeURIComponent(req.params.externalId);

      // Resolve the player's home league via the existing single-season
      // index — saves us scanning every season file when the player only
      // ever appears in one league's caches anyway.
      const hit = findPlayer(id);
      if (!hit) {
        return reply.code(404).send({ error: 'player_not_found', player_id: id });
      }
      if (!isSportEnabled(hit.league)) {
        return reply.code(404).send({ error: 'sport_disabled', reason: 'sport_disabled', sport: hit.league });
      }

      // Walk every season file for this league (newest first) and pick out
      // the player's row when present. A traded player will appear under
      // their team-of-record for that season — we surface whatever the
      // cache stored.
      const seasons: CareerSeason[] = [];
      for (const f of listSeasonFiles()) {
        if (f.league !== hit.league) continue;
        const cache = readSeasonFile(f);
        if (!cache) continue;
        const row: PlayerCacheEntry | undefined = cache.players.find(
          (p) => p.external_id === id,
        );
        if (!row) continue;
        seasons.push({
          season: f.season,
          season_label: cache.season_label ?? `${cache.league.toUpperCase()} ${f.season}`,
          team: row.team,
          team_abbr: row.team_abbr,
          stats: projectStats(hit.league, row.stats),
        });
      }

      // Top 5 most recent — the table only renders 5 rows. listSeasonFiles
      // already returns newest-first, so a slice is enough.
      const top = seasons.slice(0, 5);

      const out: CareerResponse = {
        player_id: id,
        league: hit.league,
        full_name: hit.player.full_name,
        partial: top.length < 5,
        seasons: top,
      };
      return out;
    },
  );
}
