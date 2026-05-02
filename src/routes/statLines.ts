/**
 * routes/statLines.ts — normalized stat-line endpoints for the mobile client.
 *
 * The client is keyed on TheSportsDB IDs and player names + team. Our stat
 * caches in `assets/stat-cache/*.json` are keyed on ESPN external_ids. This
 * route bridges the two so any roster screen can pull a typed, position-aware
 * stat line + 13-grade rating in one call without needing per-player ID
 * resolution.
 *
 * Endpoints:
 *   GET /api/stats/team/:teamName?league=nba
 *     Returns every cached player on that team with a normalized stat line
 *     + grade. The `league` query is optional — if omitted, we scan all 5
 *     caches and concat the hits (useful when a city name matches across
 *     leagues, e.g. "New York").
 *
 *   GET /api/stats/player?name=Stephen+Curry&team=Golden+State+Warriors
 *     Single lookup by name + team. Returns null on miss so callers can
 *     suppress the stat block.
 *
 *   GET /api/stats/player/by-id/:externalId
 *     Lookup by ESPN external_id (e.g. "espn:3975").
 *
 * Stat-line shape: a flat record of {ppg, rpg, apg, spg, bpg, …} keyed by the
 * conventional sport-specific abbreviations the client already understands
 * (mirrors src/types/index.ts:PlayerStats so PlayerCard.pickStats works).
 */
import type { FastifyInstance } from 'fastify';
import {
  findPlayerByName,
  findPlayersByTeam,
  findPlayer,
  getPlayerRating,
  getPlayerStats,
} from '../services/ratings/cacheLookup.js';
import { computeRating, type Grade } from '../services/ratings/computeRatings.js';
import type { League } from '../services/stats/types.js';
import type { PlayerCacheEntry } from '../scripts/pull-stats-shared.js';

// ─── Stat-line projector ────────────────────────────────────────────────────
//
// Translate a per-league stats blob (uses canonical keys like `points`,
// `rebounds`, `passing_yards`) into the client's PlayerStats shape (uses
// keys like `ppg`, `rpg`, `passYards`). Keep the projection per-sport so we
// don't accidentally cross-pollinate (e.g. NBA `goals` would clash with NHL
// `goals` if we did one big map).

interface ClientStatLine {
  // Basketball
  ppg?: number;
  rpg?: number;
  apg?: number;
  spg?: number;
  bpg?: number;
  threePM?: number;
  fgPct?: number;
  ftPct?: number;
  // Football
  passYards?: number;
  passTDs?: number;
  rushYards?: number;
  rushTDs?: number;
  receptions?: number;
  recYards?: number;
  recTDs?: number;
  interceptions?: number;
  // Baseball
  avg?: number;
  homeRuns?: number;
  rbi?: number;
  hits?: number;
  strikeouts?: number;
  era?: number;
  wins?: number;
  // Hockey
  goals?: number;
  assists?: number;
  plusMinus?: number;
  savePct?: number;
  gaa?: number;
  // Soccer
  goalsScored?: number;
  assistsSoccer?: number;
  cleanSheets?: number;
  savesSoccer?: number;
  // Universal
  gamesPlayed?: number;
}

function projectStats(league: League, raw: Record<string, number>): ClientStatLine {
  const s: ClientStatLine = {};
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
      if (typeof raw.passing_yards === 'number')      s.passYards = Math.round(raw.passing_yards);
      if (typeof raw.passing_touchdowns === 'number') s.passTDs   = Math.round(raw.passing_touchdowns);
      if (typeof raw.rushing_yards === 'number')      s.rushYards = Math.round(raw.rushing_yards);
      if (typeof raw.rushing_touchdowns === 'number') s.rushTDs   = Math.round(raw.rushing_touchdowns);
      if (typeof raw.receptions === 'number')         s.receptions= Math.round(raw.receptions);
      if (typeof raw.receiving_yards === 'number')    s.recYards  = Math.round(raw.receiving_yards);
      if (typeof raw.receiving_touchdowns === 'number') s.recTDs  = Math.round(raw.receiving_touchdowns);
      if (typeof raw.interceptions === 'number')      s.interceptions = Math.round(raw.interceptions);
      break;
    case 'mlb':
      if (typeof raw.avg === 'number')  s.avg = round3(raw.avg);
      if (typeof raw.hr === 'number')   s.homeRuns = Math.round(raw.hr);
      if (typeof raw.rbi === 'number')  s.rbi = Math.round(raw.rbi);
      if (typeof raw.hits === 'number') s.hits = Math.round(raw.hits);
      if (typeof raw.k_pitcher === 'number')  s.strikeouts = Math.round(raw.k_pitcher);
      if (typeof raw.era === 'number')   s.era = round2(raw.era);
      if (typeof raw.wins === 'number')  s.wins = Math.round(raw.wins);
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

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

// ─── Public response shape ───────────────────────────────────────────────────

export interface StatLineResponse {
  external_id: string;
  full_name: string;
  team: string;
  team_abbr: string;
  position: string;
  position_group: string;
  jersey_number: number | null;
  league: League;
  stats: ClientStatLine;
  /** Computed via computeRating against per-sport+position tier bands. */
  overall_grade: Grade | null;
  score: number | null;
  confidence: number | null;
}

async function buildResponse(player: PlayerCacheEntry, league: League): Promise<StatLineResponse> {
  const id = player.external_id;
  // Prefer Supabase rating; fall back to in-process compute. Stays best-effort —
  // a cache miss never blocks the stat-line surface.
  let grade: Grade | null = null;
  let score: number | null = null;
  let confidence: number | null = null;
  try {
    const supaRating = await getPlayerRating(id, league);
    if (supaRating) {
      grade = (supaRating.overall_grade ?? supaRating.overall_tier) as Grade;
      const breakdowns_json = supaRating.breakdowns_json as { score?: number; confidence?: number } | null;
      score = typeof breakdowns_json?.score === 'number' ? breakdowns_json.score : null;
      confidence = typeof breakdowns_json?.confidence === 'number' ? breakdowns_json.confidence : null;
    }
  } catch { /* fall through */ }

  if (!grade) {
    const supaStats = await getPlayerStats(id, league).catch(() => null);
    const stats = supaStats?.stats_json ?? player.stats;
    const r = computeRating({
      playerId: id,
      sport: league,
      position: player.position_group,
      stats,
    });
    if (r) {
      grade = r.overall_grade;
      score = r.score;
      confidence = r.confidence;
    }
  }

  return {
    external_id: id,
    full_name: player.full_name,
    team: player.team,
    team_abbr: player.team_abbr,
    position: player.position,
    position_group: player.position_group,
    jersey_number: player.jersey_number ?? null,
    league,
    stats: projectStats(league, player.stats),
    overall_grade: grade,
    score,
    confidence,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function statLineRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { teamName: string }; Querystring: { league?: League } }>(
    '/api/stats/team/:teamName',
    async (req, _reply) => {
      const teamName = decodeURIComponent(req.params.teamName);
      const wantLeague = req.query.league;
      const hits = findPlayersByTeam(teamName).filter(
        (h) => !wantLeague || h.league === wantLeague,
      );
      const out = await Promise.all(hits.map((h) => buildResponse(h.player, h.league)));
      return { team: teamName, count: out.length, players: out };
    },
  );

  fastify.get<{ Querystring: { name?: string; team?: string } }>(
    '/api/stats/player',
    async (req, reply) => {
      const name = (req.query.name ?? '').trim();
      const team = (req.query.team ?? '').trim();
      if (!name) {
        return reply.code(400).send({ error: 'name_required' });
      }
      const hit = findPlayerByName(name, team || undefined);
      if (!hit) {
        return reply.send({ player: null });
      }
      const player = await buildResponse(hit.player, hit.league);
      return { player };
    },
  );

  fastify.get<{ Params: { externalId: string } }>(
    '/api/stats/player/by-id/:externalId',
    async (req, reply) => {
      const id = decodeURIComponent(req.params.externalId);
      const hit = findPlayer(id);
      if (!hit) {
        return reply.code(404).send({ error: 'player_not_found', player_id: id });
      }
      const player = await buildResponse(hit.player, hit.league);
      return { player };
    },
  );
}
