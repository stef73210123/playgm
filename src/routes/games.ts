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
