import type { FastifyInstance } from 'fastify';
import {
  getEventsByDate,
  getEventsNextLeague,
  getEventsPastLeague,
  lookupAllTeams,
  lookupAllPlayers,
  lookupPlayer,
  lookupTeam,
  searchTeamsByName,
  searchPlayersByName,
  getStandings,
  SportsDbHttpError,
  type SportsDbEvent,
} from '../services/sportsdb.js';
import { supabase } from '../db/client.js';

// ─── Current MLS season (standings work for soccer only) ─────────────────────
const CURRENT_SEASON: Record<string, string> = {
  '4346': '2025', // MLS
  '4328': '2024-2025', // English Premier League
};

// ─── League IDs ───────────────────────────────────────────────────────────────

const LEAGUE_IDS = {
  NBA: '4387',
  NFL: '4391',
  MLB: '4424',
  NHL: '4380',
  MLS: '4346',
};

const SUPPORTED_LEAGUE_IDS = new Set(Object.values(LEAGUE_IDS));

// Sport-id → TheSportsDB league-id map (the canonical sport keys match
// SportId in services/sportsConfig.ts, all lowercase). Used by the
// /api/games/upcoming/:sport Supabase-with-TheSportsDB-fallback route.
const SPORT_TO_LEAGUE_ID: Record<string, string> = {
  nba: LEAGUE_IDS.NBA,
  nfl: LEAGUE_IDS.NFL,
  mlb: LEAGUE_IDS.MLB,
  nhl: LEAGUE_IDS.NHL,
  mls: LEAGUE_IDS.MLS,
};

// ─── Status mapping ───────────────────────────────────────────────────────────

function mapStatus(strStatus?: string): 'upcoming' | 'live' | 'final' {
  if (!strStatus) return 'upcoming';
  const s = strStatus.toLowerCase();
  if (s === 'ft' || s === 'aet' || s === 'pen' || s === 'final' || s === 'finished') return 'final';
  if (s === 'ns' || s === 'not started') return 'upcoming';
  return 'live';
}

// ─── Shape mapper ─────────────────────────────────────────────────────────────

function mapEvent(e: SportsDbEvent) {
  return {
    id: e.idEvent,
    leagueId: e.idLeague ?? null,
    league: e.strLeague ?? null,
    sport: e.strSport ?? null,
    homeTeam: e.strHomeTeam,
    awayTeam: e.strAwayTeam,
    homeTeamId: e.idHomeTeam ?? null,
    awayTeamId: e.idAwayTeam ?? null,
    homeTeamBadge: e.strHomeTeamBadge ?? null,
    awayTeamBadge: e.strAwayTeamBadge ?? null,
    homeScore: e.intHomeScore ?? null,
    awayScore: e.intAwayScore ?? null,
    status: mapStatus(e.strStatus),
    dateEvent: e.dateEvent ?? null,
    time: e.strTime ?? null,
    timeLocal: e.strTimeLocal ?? null,
    timestamp: e.strTimestamp ?? null,
    venue: e.strVenue ?? null,
    season: e.strSeason ?? null,
  };
}

/**
 * Enrich a finished-game event with best-effort topPerformer + an empty
 * `highlightVideoIds` slot. SportsDB v2's `/list/players/{teamId}` response
 * doesn't include per-game stats; we return a stub performer nominating
 * the winning team's first rostered player as the "top performer" so the
 * client has a populated shape rather than null (and mock-film-room copy
 * still renders). Once a dedicated box-score endpoint is available,
 * replace the body of this function.
 *
 * Highlight video IDs (YouTube) aren't exposed by v2 either; callers that
 * want real links should fetch from `/api/highlights/{entityType}/{name}`
 * which already proxies the highlights service.
 */
function enrichFinishedEvent(e: SportsDbEvent) {
  const base = mapEvent(e);
  const homeScore = Number(e.intHomeScore ?? 0);
  const awayScore = Number(e.intAwayScore ?? 0);
  const winnerIsHome = homeScore >= awayScore;
  return {
    ...base,
    // Stub performer — the client merges this with known-star fallback
    // data if needed. Null-safe so older clients ignore these keys.
    topPerformer: {
      teamId: (winnerIsHome ? e.idHomeTeam : e.idAwayTeam) ?? null,
      teamName: winnerIsHome ? e.strHomeTeam : e.strAwayTeam,
      // name / stats / headline left empty for the client to fill from
      // TEAM_STAR_PLAYERS until a real box-score source ships.
      name: null as string | null,
      stats: null as string | null,
      headline: null as string | null,
      emoji: null as string | null,
      position: null as string | null,
    },
    // Video IDs come from the highlights proxy when requested; this slot
    // stays empty here so the payload shape is predictable.
    highlightVideoIds: [] as string[],
  };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function fetchDayEvents(date: string) {
  const events = await getEventsByDate(date);
  return events.filter(e => !e.idLeague || SUPPORTED_LEAGUE_IDS.has(e.idLeague));
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function gamesRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/games/today
  fastify.get('/api/games/today', async (_req, reply) => {
    try {
      const events = await fetchDayEvents(todayUTC());
      return reply.send({ games: events.map(mapEvent) });
    } catch (err) {
      if (err instanceof SportsDbHttpError) {
        return reply.code(502).send({ error: `TheSportsDB error ${err.status}` });
      }
      throw err;
    }
  });

  // GET /api/games/yesterday — enriched with topPerformer + highlightVideoIds
  //   slots so the HomeScreen "Yesterday's Games" carousel can cut over from
  //   its static mock without a shape mismatch. Both fields may be null/[]
  //   today; the mapper is ready for real box-score data when it lands.
  //
  //   STRICT YESTERDAY-ONLY (May 2026): the date is hardcoded via
  //   `yesterdayUTC()` — there is no `?date=` override. The recap modal in
  //   the client is intentionally scoped to yesterday only; historical
  //   games belong on a separate "stats history" surface, not the recap.
  fastify.get('/api/games/yesterday', async (_req, reply) => {
    try {
      const events = await fetchDayEvents(yesterdayUTC());
      return reply.send({ games: events.map(enrichFinishedEvent) });
    } catch (err) {
      if (err instanceof SportsDbHttpError) {
        return reply.code(502).send({ error: `TheSportsDB error ${err.status}` });
      }
      throw err;
    }
  });

  // GET /api/team/:teamId — scouting-report hero data (team name, colors,
  //   stadium, formed year, description). Fills the gap between what
  //   `/list/teams/{leagueId}` returns and what the scouting modal wants.
  fastify.get<{ Params: { teamId: string } }>('/api/team/:teamId', async (req, reply) => {
    const { teamId } = req.params;
    try {
      const t = await lookupTeam(teamId);
      if (!t) return reply.code(404).send({ error: 'Team not found' });
      return reply.send({
        team: {
          id: t.idTeam,
          name: t.strTeam,
          shortName: t.strTeamShort ?? null,
          badge: t.strBadge ?? null,
          logo: t.strLogo ?? null,
          colour1: t.strColour1 ?? null,
          colour2: t.strColour2 ?? null,
          league: t.strLeague ?? null,
          description: t.strDescriptionEN ?? null,
        },
      });
    } catch (err) {
      if (err instanceof SportsDbHttpError) {
        return reply.code(502).send({ error: `TheSportsDB error ${err.status}` });
      }
      throw err;
    }
  });

  // GET /api/search?q=... — unified team + player search. Runs both v2
  //   search paths in parallel, filters teams to supported leagues so kids
  //   don't see random Eurobasket clubs, and caps each list at 8.
  fastify.get<{ Querystring: { q?: string } }>('/api/search', async (req, reply) => {
    const q = (req.query.q ?? '').trim();
    if (q.length < 1) return reply.send({ teams: [], players: [] });
    try {
      const [rawTeams, rawPlayers] = await Promise.all([
        searchTeamsByName(q),
        searchPlayersByName(q),
      ]);
      const teams = rawTeams
        .filter(t => !t.strLeague || SUPPORTED_LEAGUE_IDS.has(String((t as { idLeague?: string }).idLeague ?? '')) || !(t as { idLeague?: string }).idLeague)
        .slice(0, 8)
        .map(t => ({
          id: t.idTeam,
          name: t.strTeam,
          shortName: t.strTeamShort ?? null,
          badge: t.strBadge ?? null,
          league: t.strLeague ?? null,
          colour1: t.strColour1 ?? null,
          colour2: t.strColour2 ?? null,
        }));
      const players = rawPlayers.slice(0, 8).map(p => ({
        id: p.idPlayer,
        name: p.strPlayer,
        team: p.strTeam ?? null,
        position: p.strPosition ?? null,
        thumb: p.strThumb ?? null,
        nationality: p.strNationality ?? null,
      }));
      return reply.send({ teams, players });
    } catch (err) {
      if (err instanceof SportsDbHttpError) {
        return reply.code(502).send({ error: `TheSportsDB error ${err.status}` });
      }
      throw err;
    }
  });

  // GET /api/teams/:leagueId
  fastify.get<{ Params: { leagueId: string } }>('/api/teams/:leagueId', async (req, reply) => {
    const { leagueId } = req.params;
    try {
      const teams = await lookupAllTeams(leagueId);
      return reply.send({
        teams: teams.map(t => ({
          id: t.idTeam,
          name: t.strTeam,
          shortName: t.strTeamShort ?? null,
          badge: t.strBadge ?? null,
          logo: t.strLogo ?? null,
          colour1: t.strColour1 ?? null,
          colour2: t.strColour2 ?? null,
          league: t.strLeague ?? null,
        })),
      });
    } catch (err) {
      if (err instanceof SportsDbHttpError) {
        return reply.code(502).send({ error: `TheSportsDB error ${err.status}` });
      }
      throw err;
    }
  });

  // GET /api/players/:teamId
  fastify.get<{ Params: { teamId: string } }>('/api/players/:teamId', async (req, reply) => {
    const { teamId } = req.params;
    try {
      const players = await lookupAllPlayers(teamId);
      return reply.send({
        players: players.map(p => ({
          id: p.idPlayer,
          name: p.strPlayer,
          team: p.strTeam ?? null,
          position: p.strPosition ?? null,
          thumb: p.strThumb ?? null,
          nationality: p.strNationality ?? null,
          dateBorn: p.dateBorn ?? null,
          number: p.strNumber ?? null,
          college: p.strCollege ?? null,
          height: (p as any).strHeight ?? null,
          weight: (p as any).strWeight ?? null,
        })),
      });
    } catch (err) {
      if (err instanceof SportsDbHttpError) {
        return reply.code(502).send({ error: `TheSportsDB error ${err.status}` });
      }
      throw err;
    }
  });

  // GET /api/player/:playerId
  fastify.get<{ Params: { playerId: string } }>('/api/player/:playerId', async (req, reply) => {
    const { playerId } = req.params;
    try {
      const p = await lookupPlayer(playerId);
      if (!p) return reply.code(404).send({ error: 'Player not found' });
      return reply.send({
        player: {
          id: p.idPlayer,
          name: p.strPlayer,
          team: p.strTeam ?? null,
          position: p.strPosition ?? null,
          thumb: p.strThumb ?? null,
          cutout: p.strCutout ?? null,
          nationality: p.strNationality ?? null,
          dateBorn: p.dateBorn ?? null,
          number: p.strNumber ?? null,
        },
      });
    } catch (err) {
      if (err instanceof SportsDbHttpError) {
        return reply.code(502).send({ error: `TheSportsDB error ${err.status}` });
      }
      throw err;
    }
  });

  // GET /api/games/upcoming/:sport?days=N — next N days of scheduled games for one sport.
  //
  // Backs the HomeScreen "Upcoming Matchups" carousel and replaces the wave-2
  // TheSportsDB-direct implementation with a Supabase read off the new `games`
  // table populated by jobs/refreshGames.ts. The response shape (`games:
  // ApiGame[]`) matches what apiClient.getUpcomingGames already expects, so
  // the client wave-4 hooks see no breaking change.
  //
  // Fallback: when `games` is empty for the sport (cron hasn't run yet, or
  // wasn't wired for this league — NFL/MLB/NHL today), we transparently fall
  // through to TheSportsDB's getEventsNextLeague so the carousel doesn't go
  // dark mid-rollout. Once the cron is healthy, the Supabase branch wins
  // every call.
  //
  // days clamped to [1, 14]. sport must be lowercase nba|nfl|mlb|nhl|mls.
  fastify.get<{
    Params: { sport: string };
    Querystring: { days?: string };
  }>('/api/games/upcoming/:sport', async (req, reply) => {
    const sport = req.params.sport.toLowerCase();
    const leagueId = SPORT_TO_LEAGUE_ID[sport];
    if (!leagueId) {
      return reply.code(400).send({ error: 'invalid_sport', sport });
    }
    const rawDays = Number(req.query.days ?? 7);
    const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 7, 1), 14);

    const today = todayUTC();
    const horizon = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    })();

    // ─── 1) Try Supabase `live_games` table first. ─────────────────────────
    // (live_games is the new ingest surface from refreshGames.ts; the legacy
    //  v1 `games` table is unrelated — it powers player_game_stats and the
    //  season_player_stats materialized view.)
    //
    // OTA #12 fix: status='scheduled' only (was including 'inprogress',
    // which mixes today's already-tipped games into the "upcoming" carousel
    // and surfaces past-today rows that the cron hasn't flipped to final
    // yet). The Home screen has a separate live-scoreboard surface for
    // inprogress games. Also `.gt('game_date', today)` so today's games
    // don't appear as "upcoming" once it's already 5/13.
    try {
      const { data, error } = await supabase
        .from('live_games')
        .select('id, source, sport, season, game_date, status, home_team, home_team_abbr, away_team, away_team_abbr, source_game_id')
        .eq('sport', sport)
        .eq('status', 'scheduled')
        .gt('game_date', today)
        .lte('game_date', horizon)
        .order('game_date', { ascending: true })
        .limit(200);

      if (!error && data && data.length > 0) {
        // Project to the ApiGame shape the client already understands.
        const games = data.map((row) => ({
          id: row.id as string,
          leagueId,
          league: sport.toUpperCase(),
          sport: sport.toUpperCase(),
          homeTeam: row.home_team as string,
          awayTeam: row.away_team as string,
          homeTeamId: null,
          awayTeamId: null,
          homeTeamBadge: null,
          awayTeamBadge: null,
          homeScore: null,
          awayScore: null,
          status: 'upcoming' as const,
          dateEvent: row.game_date as string,
          time: null,
          timeLocal: null,
          timestamp: null,
          venue: null,
          season: row.season as string,
        }));
        return reply.send({ games });
      }
      // error.code PGRST205 / "schema cache" — table missing. Fall through to
      // TheSportsDB so the client doesn't blank out during the deploy window.
    } catch (err) {
      req.log.warn({ err }, '[games/upcoming] Supabase read failed, falling through to TheSportsDB');
    }

    // ─── 2) Fallback: TheSportsDB live fetch. ──────────────────────────────
    try {
      const events = await getEventsNextLeague(leagueId);
      const filtered = events.filter((e) => {
        const d = (e.dateEvent ?? '').slice(0, 10);
        return d >= today && d <= horizon;
      });
      return reply.send({ games: filtered.map(mapEvent) });
    } catch (err) {
      if (err instanceof SportsDbHttpError) {
        return reply.code(502).send({ error: `TheSportsDB error ${err.status}` });
      }
      throw err;
    }
  });

  // GET /api/games/:gameId/boxscore — per-player line for a single game.
  //
  // Reads `games` for the meta + `game_stats` for the player rows. Returns
  // 404 with `error: 'box_score_not_available'` when either the game isn't
  // in the cache OR no player rows have been ingested yet (real-data-only;
  // FilmRoom renders "Box score not available" rather than synthesizing).
  //
  //   Response shape:
  //     { game: { id, sport, season, gameDate, status, homeTeam, homeTeamAbbr,
  //               homeScore, awayTeam, awayTeamAbbr, awayScore },
  //       players: [{ playerId, playerName, team, stats }] }
  //
  // stats_json shape mirrors player_stats.stats_json — the same per-sport
  // projector in routes/statLines.ts can render either surface.
  fastify.get<{ Params: { gameId: string } }>(
    '/api/games/:gameId/boxscore',
    async (req, reply) => {
      const gameId = decodeURIComponent(req.params.gameId);

      const [{ data: gameRow, error: gErr }, { data: statRows, error: sErr }] = await Promise.all([
        supabase
          .from('live_games')
          .select('id, sport, season, game_date, status, home_team, home_team_abbr, home_score, away_team, away_team_abbr, away_score')
          .eq('id', gameId)
          .maybeSingle(),
        supabase
          .from('live_game_stats')
          .select('player_id, player_name, team, stats_json')
          .eq('game_id', gameId),
      ]);

      if (gErr && gErr.code !== 'PGRST116') {
        if (gErr.code === 'PGRST205' || /schema cache/i.test(gErr.message)) {
          return reply.code(503).send({ error: 'games_table_missing', detail: gErr.message });
        }
        return reply.code(500).send({ error: gErr.message });
      }
      if (sErr && sErr.code !== 'PGRST205' && !/schema cache/i.test(sErr.message)) {
        return reply.code(500).send({ error: sErr.message });
      }
      if (!gameRow || !statRows || statRows.length === 0) {
        return reply.code(404).send({ error: 'box_score_not_available', gameId });
      }

      return reply.send({
        game: {
          id: gameRow.id as string,
          sport: gameRow.sport as string,
          season: gameRow.season as string,
          gameDate: gameRow.game_date as string,
          status: gameRow.status as string,
          homeTeam: gameRow.home_team as string,
          homeTeamAbbr: gameRow.home_team_abbr as string,
          homeScore: gameRow.home_score as number | null,
          awayTeam: gameRow.away_team as string,
          awayTeamAbbr: gameRow.away_team_abbr as string,
          awayScore: gameRow.away_score as number | null,
        },
        players: statRows.map((r) => ({
          playerId: r.player_id as string,
          playerName: (r.player_name as string | null) ?? null,
          team: r.team as string,
          stats: r.stats_json as Record<string, number>,
        })),
      });
    },
  );

  // GET /api/standings/:leagueId — only returns data for soccer leagues (MLS, EPL, etc.)
  fastify.get<{ Params: { leagueId: string } }>('/api/standings/:leagueId', async (req, reply) => {
    const { leagueId } = req.params;
    const season = CURRENT_SEASON[leagueId];
    if (!season) {
      return reply.send({ standings: [], note: 'Standings not available for this league via this API tier' });
    }
    try {
      const rows = await getStandings(leagueId, season);
      return reply.send({
        standings: rows.map(r => ({
          rank: Number(r.intRank),
          teamId: r.idTeam,
          teamName: r.strTeam,
          badge: r.strBadge ?? null,
          played: Number(r.intPlayed ?? 0),
          wins: Number(r.intWin ?? 0),
          losses: Number(r.intLoss ?? 0),
          draws: Number(r.intDraw ?? 0),
          goalsFor: Number(r.intGoalsFor ?? 0),
          goalsAgainst: Number(r.intGoalsAgainst ?? 0),
          goalDiff: Number(r.intGoalDifference ?? 0),
          points: Number(r.intPoints ?? 0),
          form: r.strForm ?? null,
          description: r.strDescription ?? null,
          season: r.strSeason,
        })),
      });
    } catch (err) {
      if (err instanceof SportsDbHttpError) {
        return reply.code(502).send({ error: `TheSportsDB error ${err.status}` });
      }
      throw err;
    }
  });
}
