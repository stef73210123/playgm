/**
 * routes/schedule.ts — weekly schedule endpoints + 6-hour cache.
 *
 * Powers the FA / Draft "this player has 2 games this week" badge and the
 * roster screen's projected-points chip. We hit ESPN's unofficial scoreboard
 * endpoint (already used elsewhere in the app) and cache the rolling 7-day
 * window per league. The cron refreshes every 6 hours so we never hit ESPN
 * per-request.
 *
 * Endpoints:
 *   GET /api/schedule/:sport/this-week
 *     Returns every game from today (UTC midnight) → +7 days for the given
 *     league. Each entry carries home/away team names, status, and a UTC
 *     ISO timestamp the client can format locally.
 *
 *   GET /api/schedule/team/:teamName/this-week?league=nba
 *     Filtered to a single team — used by the FA badge to count a player's
 *     games this week without the client having to scan the league list.
 *
 *   GET /api/schedule/today
 *     All leagues, today only — used by Home and Roster cards.
 *
 * Cache: in-memory map keyed on `${league}:${YYYY-MM-DD}`. Each league's
 * weekly snapshot survives until the cron repopulates it. On cold start we
 * lazily refresh on first request.
 */
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import cron from 'node-cron';
import type { League } from '../services/stats/types.js';

// ─── ESPN endpoint mapping ──────────────────────────────────────────────────
//
// site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates=YYYYMMDD
// returns the day's events in a public-but-unofficial JSON format. We hit it
// once per (league × day) inside the 6-hour refresh, then memoize.

const ESPN_SPORT: Record<League, { sport: string; league: string }> = {
  nfl: { sport: 'football',   league: 'nfl' },
  nba: { sport: 'basketball', league: 'nba' },
  mlb: { sport: 'baseball',   league: 'mlb' },
  nhl: { sport: 'hockey',     league: 'nhl' },
  mls: { sport: 'soccer',     league: 'usa.1' },
};

// ─── Public response shape ──────────────────────────────────────────────────

export interface ScheduleGame {
  gameId: string;
  league: League;
  date: string;        // YYYY-MM-DD (UTC)
  startUtc: string;    // ISO timestamp
  status: 'upcoming' | 'live' | 'final';
  homeTeam: string;
  awayTeam: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  homeScore: number | null;
  awayScore: number | null;
  venue: string | null;
}

interface WeekCacheEntry {
  fetchedAt: number;
  games: ScheduleGame[];
}

// In-memory cache: key = league. Each entry holds 7 days from the date the
// cron last ran. Stale-while-revalidate semantics — if the cron lags we'll
// still serve the cached snapshot and the next tick will refresh.
const weekCache: Partial<Record<League, WeekCacheEntry>> = {};

const DAY_MS = 24 * 60 * 60 * 1000;

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function ymdDashed(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mapStatus(state: string | undefined): 'upcoming' | 'live' | 'final' {
  if (!state) return 'upcoming';
  const s = state.toLowerCase();
  if (s === 'post' || s === 'final') return 'final';
  if (s === 'in') return 'live';
  return 'upcoming';
}

interface EspnScoreboard {
  events?: Array<{
    id: string;
    date: string;
    competitions?: Array<{
      venue?: { fullName?: string };
      competitors?: Array<{
        homeAway: 'home' | 'away';
        score?: string | number;
        team?: { displayName?: string; abbreviation?: string };
      }>;
      status?: { type?: { state?: string } };
    }>;
  }>;
}

async function fetchEspnDay(league: League, date: Date): Promise<ScheduleGame[]> {
  const meta = ESPN_SPORT[league];
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/${meta.sport}/${meta.league}/scoreboard` +
    `?dates=${ymd(date)}&limit=200`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = (await res.json()) as EspnScoreboard;
    if (!data.events || data.events.length === 0) return [];
    const out: ScheduleGame[] = [];
    for (const ev of data.events) {
      const c = ev.competitions?.[0];
      if (!c) continue;
      const home = c.competitors?.find((t) => t.homeAway === 'home');
      const away = c.competitors?.find((t) => t.homeAway === 'away');
      if (!home || !away) continue;
      const homeScore = home.score === undefined || home.score === '' ? null : Number(home.score);
      const awayScore = away.score === undefined || away.score === '' ? null : Number(away.score);
      out.push({
        gameId: ev.id,
        league,
        date: ymdDashed(date),
        startUtc: ev.date,
        status: mapStatus(c.status?.type?.state),
        homeTeam: home.team?.displayName ?? '',
        awayTeam: away.team?.displayName ?? '',
        homeTeamAbbr: home.team?.abbreviation ?? '',
        awayTeamAbbr: away.team?.abbreviation ?? '',
        homeScore: Number.isFinite(homeScore) ? homeScore : null,
        awayScore: Number.isFinite(awayScore) ? awayScore : null,
        venue: c.venue?.fullName ?? null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function refreshLeagueWeek(league: League, log?: FastifyBaseLogger): Promise<void> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const all: ScheduleGame[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() + i * DAY_MS);
    const day = await fetchEspnDay(league, d);
    all.push(...day);
  }
  weekCache[league] = { fetchedAt: Date.now(), games: all };
  log?.info(`[schedule] ${league}: cached ${all.length} games`);
}

async function refreshAllLeagues(log?: FastifyBaseLogger): Promise<void> {
  const leagues: League[] = ['nfl', 'nba', 'mlb', 'nhl', 'mls'];
  // Stagger 1s apart to be polite to ESPN.
  for (const lg of leagues) {
    await refreshLeagueWeek(lg, log);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function ensureFresh(league: League): Promise<WeekCacheEntry> {
  const cur = weekCache[league];
  // Stale = older than 7 hours (cron is 6h, give it 1h slack).
  if (cur && Date.now() - cur.fetchedAt < 7 * 60 * 60 * 1000) return cur;
  await refreshLeagueWeek(league);
  return weekCache[league] ?? { fetchedAt: Date.now(), games: [] };
}

// ─── Cron: refresh every 6 hours ────────────────────────────────────────────

export function startScheduleRefreshJobs(log: FastifyBaseLogger): void {
  // Kick once at boot so we're warm before the first request hits us.
  void refreshAllLeagues(log).catch((err) => log.error(err, '[schedule] initial warmup failed'));

  // Every 6 hours, on the hour. America/New_York keeps human-readable
  // alignment with the rest of our refresh cadence.
  cron.schedule('0 */6 * * *', () => {
    void refreshAllLeagues(log).catch((err) => log.error(err, '[schedule] cron refresh failed'));
  }, { timezone: 'America/New_York' });

  log.info('[schedule] cron job registered (every 6h)');
}

// ─── Helpers exposed to other server modules ────────────────────────────────

/** True when `team` plays at least one game in the cached week. Used by the
 *  weekly-projection surface. */
export async function teamHasGameThisWeek(league: League, team: string): Promise<boolean> {
  const e = await ensureFresh(league);
  const tn = team.toLowerCase();
  return e.games.some(
    (g) =>
      g.homeTeam.toLowerCase() === tn ||
      g.awayTeam.toLowerCase() === tn ||
      g.homeTeamAbbr.toLowerCase() === tn ||
      g.awayTeamAbbr.toLowerCase() === tn,
  );
}

/** Count a team's games this week. Used for the FA "next game in X days" badge. */
export async function teamWeeklyGameCount(league: League, team: string): Promise<number> {
  const e = await ensureFresh(league);
  const tn = team.toLowerCase();
  return e.games.filter(
    (g) =>
      g.homeTeam.toLowerCase() === tn ||
      g.awayTeam.toLowerCase() === tn ||
      g.homeTeamAbbr.toLowerCase() === tn ||
      g.awayTeamAbbr.toLowerCase() === tn,
  ).length;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function scheduleRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { sport: string } }>('/api/schedule/:sport/this-week', async (req, reply) => {
    const sport = req.params.sport.toLowerCase();
    if (!(sport in ESPN_SPORT)) {
      return reply.code(404).send({ error: 'unsupported_league', sport });
    }
    const league = sport as League;
    const e = await ensureFresh(league);
    return {
      league,
      fetchedAt: new Date(e.fetchedAt).toISOString(),
      count: e.games.length,
      games: e.games,
    };
  });

  fastify.get<{ Params: { teamName: string }; Querystring: { league?: League } }>(
    '/api/schedule/team/:teamName/this-week',
    async (req, reply) => {
      const teamName = decodeURIComponent(req.params.teamName);
      const league = req.query.league;
      if (!league) {
        return reply.code(400).send({ error: 'league_required' });
      }
      if (!(league in ESPN_SPORT)) {
        return reply.code(404).send({ error: 'unsupported_league', league });
      }
      const e = await ensureFresh(league);
      const tn = teamName.toLowerCase();
      const games = e.games.filter(
        (g) =>
          g.homeTeam.toLowerCase() === tn ||
          g.awayTeam.toLowerCase() === tn ||
          g.homeTeamAbbr.toLowerCase() === tn ||
          g.awayTeamAbbr.toLowerCase() === tn,
      );
      const now = Date.now();
      const upcoming = games.filter((g) => new Date(g.startUtc).getTime() >= now);
      const next = upcoming[0] ?? null;
      const daysUntilNext = next
        ? Math.max(0, Math.round((new Date(next.startUtc).getTime() - now) / DAY_MS))
        : null;
      return {
        team: teamName,
        league,
        gameCount: games.length,
        upcomingCount: upcoming.length,
        next,
        daysUntilNext,
        games,
      };
    },
  );

  fastify.get('/api/schedule/today', async (_req, _reply) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayStr = ymdDashed(today);
    const leagues: League[] = ['nfl', 'nba', 'mlb', 'nhl', 'mls'];
    const out: ScheduleGame[] = [];
    for (const lg of leagues) {
      const e = await ensureFresh(lg);
      out.push(...e.games.filter((g) => g.date === todayStr));
    }
    return {
      date: todayStr,
      count: out.length,
      games: out,
    };
  });
}
