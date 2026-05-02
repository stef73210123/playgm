/**
 * sportsdb/highlights.ts — premium highlight URLs from TheSportsDB.
 *
 * Auth: same `SPORTSDB_V2_KEY` as ../sportsdb.ts (premium tier required for
 * `strYoutube` on player lookups + reliable `strVideo` on schedule events).
 * If the key is missing or the API responds 401, callers see a `null` /
 * empty array (graceful degrade) and one warn-level log line — they should
 * NOT crash the daily refresh cron.
 *
 * Endpoints used (all premium-tier on TheSportsDB):
 *   - GET /api/v2/json/lookup/player/{idPlayer}
 *       envelope: { lookup: [Player] } where Player.strYoutube is the
 *       canonical highlight URL (often empty for non-stars — see notes
 *       below for fallback strategy).
 *   - GET /api/v2/json/schedule/previous/team/{idTeam}
 *       envelope: { schedule: [Event] } where each Event.strVideo is a
 *       YouTube URL (very high coverage on NBA / NFL / MLB / NHL,
 *       sparse on MLS).
 *   - GET /api/v2/json/schedule/league/{idLeague}/{season}
 *       envelope: { schedule: [Event] } — full-season events for league
 *       latest-highlights query.
 *
 * Cache: 60-minute in-memory LRU keyed on the request path. Highlight
 * URLs change ~once a game (i.e. ~once per day per team), so 60 min is
 * a safe TTL for game-day pages without thrashing TheSportsDB.
 */

import { brandingFilter } from '../branding.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const DEV_FALLBACK_KEY = '238797';
const API_KEY = process.env['SPORTSDB_V2_KEY'] ?? DEV_FALLBACK_KEY;
const BASE_URL = 'https://www.thesportsdb.com/api/v2/json';

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { ts: number; data: unknown }>();

// One-time auth probe — populated lazily on the first call so a totally
// unconfigured server doesn't wedge module init.
let authProbed = false;
let authOk: boolean | null = null;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlayerHighlightLookup {
  /** Resolved YouTube URL or null when SportsDB has no value. */
  youtube_url: string | null;
  /** Optional Instagram / Twitter for future use — we read them once
   *  while we're already round-tripping the player lookup. */
  instagram_url?: string | null;
  twitter_url?: string | null;
}

export interface TeamHighlightEvent {
  event_id: string;
  event_name: string;
  video_url: string;
  played_on: string | null;
}

interface RawPlayerLookup {
  idPlayer?: string | number;
  strPlayer?: string;
  strYoutube?: string | null;
  strInstagram?: string | null;
  strTwitter?: string | null;
}

interface RawScheduleEvent {
  idEvent?: string | number;
  strEvent?: string;
  strVideo?: string | null;
  dateEvent?: string | null;
}

// ─── Internal HTTP ──────────────────────────────────────────────────────────

async function sdbGet<T>(path: string): Promise<T | null> {
  // Cache hit?
  const cached = cache.get(path);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data as T;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'X-API-KEY': API_KEY },
    });
  } catch (err) {
    console.warn(`[sportsdb/highlights] network error for ${path}:`, (err as Error).message);
    return null;
  }

  if (res.status === 401 || res.status === 403) {
    if (!authProbed || authOk !== false) {
      console.warn(
        `[sportsdb/highlights] AUTH FAILED (HTTP ${res.status}) for ${path} — ` +
          `is SPORTSDB_V2_KEY a valid premium key?`,
      );
    }
    authProbed = true;
    authOk = false;
    return null;
  }

  if (res.status === 404) {
    return null;
  }

  if (res.status === 429) {
    console.warn(`[sportsdb/highlights] rate-limited (429) for ${path} — backing off`);
    return null;
  }

  if (!res.ok) {
    console.warn(`[sportsdb/highlights] HTTP ${res.status} for ${path}`);
    return null;
  }

  let parsed: T;
  try {
    const text = await res.text();
    parsed = (text ? JSON.parse(text) : ({} as T)) as T;
  } catch {
    return null;
  }
  parsed = brandingFilter(parsed);

  authProbed = true;
  if (authOk === null) authOk = true;
  cache.set(path, { ts: Date.now(), data: parsed });
  return parsed;
}

function isHttps(u: unknown): u is string {
  return typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Look up a single player's highlight URL by their TheSportsDB idPlayer.
 * Returns null when the API is unreachable or the player has no YouTube
 * channel populated. Callers that want a fallback should use
 * `fetchTeamHighlights(teamId, 1)` and synthesize a player → team link.
 */
export async function fetchPlayerHighlight(
  sportsdbPlayerId: string,
): Promise<PlayerHighlightLookup> {
  if (!sportsdbPlayerId) return { youtube_url: null };
  const path = `/lookup/player/${encodeURIComponent(sportsdbPlayerId)}`;
  const data = await sdbGet<{ lookup?: RawPlayerLookup[] }>(path);
  const first = data?.lookup?.[0];
  if (!first) return { youtube_url: null };

  // SportsDB strYoutube comes in a few shapes:
  //   - "" (empty string — most common for role players)
  //   - "youtube.com/@kingjames" (no protocol)
  //   - "https://www.youtube.com/watch?v=…"
  // We canonicalize to a full https URL or null. Anything that doesn't
  // smell like a URL after normalization is treated as missing.
  const raw = (first.strYoutube ?? '').trim();
  let yt: string | null = null;
  if (raw) {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      yt = raw.replace(/^http:/, 'https:');
    } else if (/^(www\.)?youtube\.com|^youtu\.be|^@/.test(raw)) {
      yt = `https://${raw.replace(/^@/, 'www.youtube.com/@')}`;
    }
  }
  if (yt && !isHttps(yt)) yt = null;

  const ig = (first.strInstagram ?? '').trim() || null;
  const tw = (first.strTwitter ?? '').trim() || null;
  return {
    youtube_url: yt,
    instagram_url: ig ? (ig.startsWith('http') ? ig : `https://${ig}`) : null,
    twitter_url: tw ? (tw.startsWith('http') ? tw : `https://${tw}`) : null,
  };
}

/**
 * Last N events with `strVideo` for a TeamSportsDB id. Returns most-recent
 * first. Empty array when SportsDB has no recent highlights — this is
 * common for offseason teams (e.g. NFL teams in May).
 */
export async function fetchTeamHighlights(
  sportsdbTeamId: string,
  limit = 5,
): Promise<TeamHighlightEvent[]> {
  if (!sportsdbTeamId) return [];
  const path = `/schedule/previous/team/${encodeURIComponent(sportsdbTeamId)}`;
  const data = await sdbGet<{ schedule?: RawScheduleEvent[] }>(path);
  const events = data?.schedule ?? [];
  const out: TeamHighlightEvent[] = [];
  for (const e of events) {
    if (!isHttps(e.strVideo)) continue;
    out.push({
      event_id: String(e.idEvent ?? ''),
      event_name: String(e.strEvent ?? '').slice(0, 200),
      video_url: e.strVideo as string,
      played_on: e.dateEvent ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Latest events with strVideo for a whole league + season. Used by the
 * scheduled-task warmup so the dashboard "recent league activity" card
 * surfaces highlights even before any team has been clicked.
 */
export async function fetchLatestLeagueHighlights(
  leagueId: string,
  season: string,
  limit = 25,
): Promise<TeamHighlightEvent[]> {
  if (!leagueId) return [];
  const path = `/schedule/league/${encodeURIComponent(leagueId)}/${encodeURIComponent(season)}`;
  const data = await sdbGet<{ schedule?: RawScheduleEvent[] }>(path);
  const events = data?.schedule ?? [];
  const out: TeamHighlightEvent[] = [];
  // schedule/league returns chronological asc; reverse so newest first.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!isHttps(e.strVideo)) continue;
    out.push({
      event_id: String(e.idEvent ?? ''),
      event_name: String(e.strEvent ?? '').slice(0, 200),
      video_url: e.strVideo as string,
      played_on: e.dateEvent ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Surfaces auth-probe state for /admin/status. Returns null when no
 * upstream call has been made yet this process, true on success, false
 * on a confirmed 401/403.
 */
export function getHighlightsAuthState(): boolean | null {
  return authOk;
}

/** Test-only — drop the cache between unit tests. */
export function _resetHighlightsCacheForTests(): void {
  cache.clear();
  authProbed = false;
  authOk = null;
}
