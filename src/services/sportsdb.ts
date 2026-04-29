/**
 * sportsdb.ts — server-side TheSportsDB v2 client.
 *
 * Auth model: v2 takes the key in an `X-API-KEY` header (v1-style key-in-path
 * is gone). The key comes from SPORTSDB_V2_KEY; if unset, we fall back to a
 * known-good dev key so the server keeps working in local/dev environments.
 *
 * Response-wrapper keys changed from v1 → v2:
 *   v1 { teams } / { events } / { results } / { player }
 *   v2 { list }  / { schedule } / { search } / { lookup } / { livescore }
 *
 * Empty-result semantics: v2 returns HTTP 200 with { Message: "No data found" }
 * instead of `null` or an empty array. We treat that as an empty result.
 *
 * All responses still pass through brandingFilter so downstream branding
 * scrubs continue to apply.
 */

import { brandingFilter } from './branding.js';

// ─── Typed HTTP error ───────────────────────────────────────────────────────

export class SportsDbHttpError extends Error {
  constructor(
    public readonly status: number,
    path: string,
  ) {
    super(`TheSportsDB error ${status} for ${path}`);
    this.name = 'SportsDbHttpError';
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

const DEV_FALLBACK_KEY = '238797';
const API_KEY = process.env['SPORTSDB_V2_KEY'] ?? DEV_FALLBACK_KEY;
const BASE_URL = 'https://www.thesportsdb.com/api/v2/json';

console.log(
  `[sportsdb] Using TheSportsDB v2 (key: ${API_KEY === DEV_FALLBACK_KEY ? 'dev-fallback' : API_KEY.slice(0, 4) + '***'})`,
);

// ─── Shared types ───────────────────────────────────────────────────────────

export interface SportsDbTeam {
  idTeam: string;
  strTeam: string;
  strTeamShort?: string;
  strBadge?: string;
  strLogo?: string;
  strColour1?: string;
  strColour2?: string;
  strLeague?: string;
  strDescriptionEN?: string;
}

export interface SportsDbPlayer {
  idPlayer: string;
  idTeam?: string;
  strPlayer: string;
  strTeam?: string;
  strPosition?: string;
  strThumb?: string;
  strCutout?: string;
  strNationality?: string;
  dateBorn?: string;
  strNumber?: string;
  strCollege?: string;
  // Extended bio (populated by /lookup/player/{id}; sometimes absent on /list/players)
  strHeight?: string;            // e.g. "6 ft 8 in" or "203 cm"
  strWeight?: string;            // e.g. "224 lbs" or "102 kg"
  strBirthLocation?: string;
  strDescriptionEN?: string;     // long-form bio
  strSigning?: string;           // signing year
  strKit?: string;
  strAgent?: string;
  strHandedness?: string;        // batting/throwing hand for MLB; shooting hand for NHL
  strSide?: string;              // soccer foot dominance
  strSport?: string;
  strStatus?: string;            // 'Active' / 'Retired'
  strWage?: string;
  intYear?: string;              // year drafted (sometimes)
  dateSigned?: string;
}

/** Single-player /lookup/eventstats per-game stat row. Shape varies per sport. */
export interface SportsDbEventStat {
  idEventStat?: string;
  idEvent: string;
  idPlayer?: string;
  idTeam?: string;
  strPlayer?: string;
  strTeam?: string;
  intMinutes?: string;
  intGoals?: string;
  intAssists?: string;
  /** Free-form per-sport stats live in this raw bag. We coerce to JSON on insert. */
  [key: string]: string | undefined;
}

export interface SportsDbLiveScore {
  idEvent: string;
  strEvent: string;
  strHomeTeam: string;
  strAwayTeam: string;
  idHomeTeam?: string;
  idAwayTeam?: string;
  intHomeScore?: string | null;
  intAwayScore?: string | null;
  strStatus?: string;
  dateEvent?: string;
  strTime?: string;
  strLeague?: string;
  /** Full sport name from TheSportsDB (e.g. "Basketball", "American Football") */
  strSport?: string;
}

export interface SportsDbEvent {
  idEvent: string;
  idLeague?: string;
  strLeague?: string;
  strSport?: string;
  strEvent: string;
  idHomeTeam?: string;
  idAwayTeam?: string;
  strHomeTeam: string;
  strAwayTeam: string;
  strHomeTeamBadge?: string;
  strAwayTeamBadge?: string;
  intHomeScore?: string | null;
  intAwayScore?: string | null;
  strStatus?: string;
  strPostponed?: string;
  dateEvent?: string;
  strTime?: string;
  strTimeLocal?: string;
  strTimestamp?: string;
  strVenue?: string;
  strSeason?: string;
}

export interface SportsDbStanding {
  idStanding: string;
  intRank: string;
  idTeam: string;
  strTeam: string;
  strBadge?: string;
  idLeague: string;
  strLeague: string;
  strSeason: string;
  strForm?: string;
  strDescription?: string;
  intPlayed?: string;
  intWin?: string;
  intLoss?: string;
  intDraw?: string;
  intGoalsFor?: string;
  intGoalsAgainst?: string;
  intGoalDifference?: string;
  intPoints?: string;
  dateUpdated?: string;
}

// ─── HTTP helper ────────────────────────────────────────────────────────────

/** v2 uses `{ Message: "No data found" }` instead of 404 for empty queries. */
function isMessageEnvelope(data: unknown): boolean {
  return !!data && typeof data === 'object' && 'Message' in (data as object);
}

async function sdbFetch<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { 'X-API-KEY': API_KEY },
  });
  if (!res.ok) {
    throw new SportsDbHttpError(res.status, path);
  }
  // Some v2 endpoints (e.g. standings for NBA) return HTTP 200 with an empty
  // body. Treat that as an empty envelope so callers don't crash on
  // JSON.parse('').
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as T;
  return brandingFilter(data);
}

/**
 * Convenience wrapper: returns empty result (per the `empty` factory) instead
 * of throwing when the endpoint responds with "No data found". HTTP errors
 * still throw.
 */
async function sdbFetchList<TKey extends string, TItem>(
  path: string,
  key: TKey,
): Promise<TItem[]> {
  const data = await sdbFetch<Record<TKey, TItem[]> | { Message: string }>(path);
  if (isMessageEnvelope(data)) return [];
  const arr = (data as Record<TKey, TItem[]>)[key];
  return Array.isArray(arr) ? arr : [];
}

/**
 * Coerce numeric IDs (v2 quirk — ids come back as JS numbers, our types
 * declare them as strings) on a shallow clone. Works on any object because
 * the wire shape is `Record<string, unknown>` before typing.
 */
function coerceStringIds<T>(obj: T, idKeys: readonly string[]): T {
  const src = obj as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  for (const k of idKeys) {
    const v = src[k];
    if (v != null && typeof v !== 'string') out[k] = String(v);
  }
  return out as unknown as T;
}

// ─── API functions ──────────────────────────────────────────────────────────

export async function getLiveScores(sport = 'basketball'): Promise<SportsDbLiveScore[]> {
  const items = await sdbFetchList<'livescore', SportsDbLiveScore>(
    `/livescore/${encodeURIComponent(sport)}`,
    'livescore',
  );
  return items.map(e =>
    coerceStringIds(e, ['idEvent', 'idHomeTeam', 'idAwayTeam']) as SportsDbLiveScore,
  );
}

export async function getLastEventsForTeam(teamId: string): Promise<SportsDbLiveScore[]> {
  const items = await sdbFetchList<'schedule', SportsDbLiveScore>(
    `/schedule/previous/team/${encodeURIComponent(teamId)}`,
    'schedule',
  );
  return items.map(e =>
    coerceStringIds(e, ['idEvent', 'idHomeTeam', 'idAwayTeam']) as SportsDbLiveScore,
  );
}

/**
 * Player search — v2 `/search/player/{name}`. Fuzzy, case-insensitive across
 * the full name (matches v1 `searchplayers.php` behavior closely enough).
 */
export async function searchPlayers(name: string): Promise<SportsDbPlayer[]> {
  const items = await sdbFetchList<'search', SportsDbPlayer>(
    `/search/player/${encodeURIComponent(name)}`,
    'search',
  );
  return items.map(p => coerceStringIds(p, ['idPlayer']) as SportsDbPlayer);
}

export async function lookupAllTeams(leagueId: string): Promise<SportsDbTeam[]> {
  const items = await sdbFetchList<'list', SportsDbTeam>(
    `/list/teams/${encodeURIComponent(leagueId)}`,
    'list',
  );
  return items.map(t => coerceStringIds(t, ['idTeam']) as SportsDbTeam);
}

// ─── Event queries ──────────────────────────────────────────────────────────
//
// v1's `eventsday.php?d=YYYY-MM-DD` doesn't have a clean v2 equivalent that I
// could find during migration probing. For now we synthesize "events on date
// D" from the per-league next + previous schedules and filter by date — this
// covers the app's actual usage (today's games, yesterday's games) without a
// new endpoint discovery. If a proper v2 by-date endpoint surfaces, route
// `getEventsByDate` there.

export async function getEventsByDate(date: string): Promise<SportsDbEvent[]> {
  // Supported leagues — keep this in sync with the Sport enum.
  const leagueIds = ['4387', '4391', '4424', '4380', '4346']; // NBA/NFL/MLB/NHL/MLS
  const windows = await Promise.all(
    leagueIds.flatMap(id => [getEventsNextLeague(id), getEventsPastLeague(id)]),
  );
  const all = windows.flat();
  return all.filter(e => e.dateEvent === date);
}

export async function getEventsNextLeague(leagueId: string): Promise<SportsDbEvent[]> {
  const items = await sdbFetchList<'schedule', SportsDbEvent>(
    `/schedule/next/league/${encodeURIComponent(leagueId)}`,
    'schedule',
  );
  return items.map(e =>
    coerceStringIds(e, ['idEvent', 'idHomeTeam', 'idAwayTeam', 'idLeague']) as SportsDbEvent,
  );
}

export async function getEventsPastLeague(leagueId: string): Promise<SportsDbEvent[]> {
  const items = await sdbFetchList<'schedule', SportsDbEvent>(
    `/schedule/previous/league/${encodeURIComponent(leagueId)}`,
    'schedule',
  );
  return items.map(e =>
    coerceStringIds(e, ['idEvent', 'idHomeTeam', 'idAwayTeam', 'idLeague']) as SportsDbEvent,
  );
}

// ─── Standings ──────────────────────────────────────────────────────────────

export async function getStandings(leagueId: string, season: string): Promise<SportsDbStanding[]> {
  // v2 path: /list/table/{leagueId}/{season}
  const items = await sdbFetchList<'table', SportsDbStanding>(
    `/list/table/${encodeURIComponent(leagueId)}/${encodeURIComponent(season)}`,
    'table',
  );
  return items.map(s => coerceStringIds(s, ['idTeam', 'idLeague']) as SportsDbStanding);
}

// ─── Player queries ─────────────────────────────────────────────────────────

export async function lookupAllPlayers(teamId: string): Promise<SportsDbPlayer[]> {
  const items = await sdbFetchList<'list', SportsDbPlayer>(
    `/list/players/${encodeURIComponent(teamId)}`,
    'list',
  );
  return items.map(p => coerceStringIds(p, ['idPlayer']) as SportsDbPlayer);
}

export async function lookupPlayer(playerId: string): Promise<SportsDbPlayer | null> {
  const items = await sdbFetchList<'lookup', SportsDbPlayer>(
    `/lookup/player/${encodeURIComponent(playerId)}`,
    'lookup',
  );
  const first = items[0];
  return first ? (coerceStringIds(first, ['idPlayer', 'idTeam']) as SportsDbPlayer) : null;
}

/**
 * Per-game player stats (box score). Coverage varies per sport — best on
 * NBA/NFL, sparse on MLB/NHL/MLS. v2 path: `/lookup/eventstats/{eventId}`,
 * envelope key is `eventstats`.
 */
export async function getEventStats(eventId: string): Promise<SportsDbEventStat[]> {
  const items = await sdbFetchList<'eventstats', SportsDbEventStat>(
    `/lookup/eventstats/${encodeURIComponent(eventId)}`,
    'eventstats',
  );
  return items.map(s =>
    coerceStringIds(s, ['idEventStat', 'idEvent', 'idPlayer', 'idTeam']) as SportsDbEventStat,
  );
}

/**
 * Full team lookup by SportsDB team id. Used for the scouting-report hero
 * (accurate team colors, stadium, formed year, description, etc. that the
 * `/list/teams/{leagueId}` payload omits).
 */
export async function lookupTeam(teamId: string): Promise<SportsDbTeam | null> {
  const items = await sdbFetchList<'lookup', SportsDbTeam>(
    `/lookup/team/${encodeURIComponent(teamId)}`,
    'lookup',
  );
  const first = items[0];
  return first ? (coerceStringIds(first, ['idTeam']) as SportsDbTeam) : null;
}

/**
 * Unified team + player search. v2 `/search/team/{q}` matches first-word
 * prefixes case-sensitively on the leading letter (e.g. "chicago" hits,
 * "celtics" doesn't). `/search/player/{q}` is more forgiving. We run both
 * in parallel and merge the results so callers don't have to.
 */
export async function searchTeamsByName(query: string): Promise<SportsDbTeam[]> {
  const items = await sdbFetchList<'search', SportsDbTeam>(
    `/search/team/${encodeURIComponent(query)}`,
    'search',
  );
  return items.map(t => coerceStringIds(t, ['idTeam']) as SportsDbTeam);
}

export async function searchPlayersByName(query: string): Promise<SportsDbPlayer[]> {
  const items = await sdbFetchList<'search', SportsDbPlayer>(
    `/search/player/${encodeURIComponent(query)}`,
    'search',
  );
  return items.map(p => coerceStringIds(p, ['idPlayer']) as SportsDbPlayer);
}
