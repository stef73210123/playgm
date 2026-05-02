/**
 * highlights/playlistResolver.ts — assemble a 5-video, embeddable
 * highlight playlist for a player or team.
 *
 * Pipeline:
 *   1. Pull up to 15 candidate events from TheSportsDB
 *      (`fetchTeamHighlights`). The 15 figure gives us ~3× headroom
 *      against the YouTube embeddability filter — empirically ~20–30%
 *      of TheSportsDB's strVideo URLs are flagged "playback on other
 *      websites disabled" so 15 candidates → 10–12 keepers → cap at 5.
 *   2. Extract YouTube video IDs from each strVideo URL. Drop URLs
 *      that aren't YouTube (rare, but TheSportsDB occasionally surfaces
 *      cdn-hosted clips for older NHL games).
 *   3. Batch-check embeddability via YouTube Data API v3.
 *   4. Sort by `played_on` desc and return the top `limit` (default 5).
 *
 * For PLAYERS: we resolve the player → team mapping by reading
 * `players.team_id → teams.external_id` in Supabase. Personal player
 * highlight URLs (from `meta_json.video_highlight_url`) are layered
 * in as the FIRST playlist entry when present, since SportsDB curates
 * those as the hero clip per player.
 *
 * Persistence: writes the resolved playlist to
 * `meta_json.highlight_playlist: PlaylistEntry[]` (capped at 5) and
 * `meta_json.highlight_playlist_resolved_at`. The pull-highlights
 * script and the daily refresh cron both call into this resolver.
 *
 * TTL: 7 days. Beyond that we re-resolve so freshly-played games
 * eventually push old clips out.
 */

import { fetchTeamHighlights, type TeamHighlightEvent } from '../sportsdb/highlights.js';
import { checkEmbeddability, youtubeIdFromUrl } from '../youtube/embeddability.js';
import { supabase } from '../../db/client.js';

export interface PlaylistEntry {
  /** YouTube video ID (11 chars). */
  video_id: string;
  /** Original TheSportsDB event title — e.g. "Lakers vs Warriors". */
  title: string;
  /** ISO date the game was played, or null when SportsDB omits it. */
  played_on: string | null;
  /** Always true for items returned by the resolver — embedded for the
   *  client so it can short-circuit any local filtering. */
  embeddable: true;
  /** Set when the playlist entry came from a player's curated channel
   *  (`meta_json.video_highlight_url`) rather than a per-game clip. */
  source?: 'curated' | 'team_event';
}

const PLAYLIST_TTL_DAYS = 7;
const PLAYLIST_TTL_MS = PLAYLIST_TTL_DAYS * 24 * 60 * 60 * 1000;

// 2026-05-02 design: client now renders a 10-card horizontal carousel
// instead of a 5-chip strip. Pull 25 candidates for the same ~2.5×
// embeddability headroom we used at the 5-clip target (15/5 vs 25/10).
const CANDIDATES_TO_PULL = 25;
const DEFAULT_PLAYLIST_LIMIT = 10;

interface PlayerRow {
  id: string;
  external_id: string | null;
  full_name: string | null;
  team_id: string | null;
  meta_json: Record<string, unknown> | null;
}

interface TeamRow {
  id: string;
  external_id: string | null;
  full_name: string | null;
  meta_json: Record<string, unknown> | null;
}

// ─── Internal: candidate → playlist filtering ──────────────────────────────

function eventsToCandidates(events: TeamHighlightEvent[]): Array<TeamHighlightEvent & { video_id: string }> {
  const out: Array<TeamHighlightEvent & { video_id: string }> = [];
  for (const e of events) {
    const id = youtubeIdFromUrl(e.video_url);
    if (id) out.push({ ...e, video_id: id });
  }
  return out;
}

function dedupByVideoId<T extends { video_id: string }>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of arr) {
    if (seen.has(c.video_id)) continue;
    seen.add(c.video_id);
    out.push(c);
  }
  return out;
}

function sortByPlayedOnDesc<T extends { played_on: string | null }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => {
    const at = a.played_on ? Date.parse(a.played_on) : 0;
    const bt = b.played_on ? Date.parse(b.played_on) : 0;
    return bt - at;
  });
}

/**
 * Core: take up to 15 candidates, filter by embeddability, return the
 * top `limit` most recent. Pure function — no DB writes.
 */
async function buildPlaylistFromCandidates(
  candidates: Array<TeamHighlightEvent & { video_id: string }>,
  limit: number,
): Promise<PlaylistEntry[]> {
  if (candidates.length === 0) return [];

  const ids = candidates.map((c) => c.video_id);
  const status = await checkEmbeddability(ids);

  const keepers = candidates.filter((c) => status.get(c.video_id)?.embeddable);
  const sorted = sortByPlayedOnDesc(dedupByVideoId(keepers));
  return sorted.slice(0, limit).map((c) => ({
    video_id: c.video_id,
    title: c.event_name,
    played_on: c.played_on,
    embeddable: true as const,
    source: 'team_event' as const,
  }));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a playlist for a single team. Pulls 15 candidates from TheSportsDB
 * → embeddability filter → top 5.
 */
export async function getPlaylistForTeam(
  sportsdbTeamId: string,
  limit = DEFAULT_PLAYLIST_LIMIT,
): Promise<PlaylistEntry[]> {
  if (!sportsdbTeamId) return [];
  const events = await fetchTeamHighlights(sportsdbTeamId, CANDIDATES_TO_PULL);
  const candidates = eventsToCandidates(events);
  return buildPlaylistFromCandidates(candidates, limit);
}

/**
 * Build a playlist for a player. Resolves the player's team in Supabase
 * (or accepts an explicit `sportsdbTeamId` to skip the lookup), then
 * delegates to getPlaylistForTeam. If the player has a curated
 * `meta_json.video_highlight_url`, that clip is layered in as the FIRST
 * entry (after embeddability check) so it leads the kid's experience.
 */
export async function getPlaylistForPlayer(
  playerId: string,
  limit = DEFAULT_PLAYLIST_LIMIT,
): Promise<PlaylistEntry[]> {
  if (!playerId) return [];

  const { data: pdata, error: perr } = await supabase
    .from('players')
    .select('id, external_id, full_name, team_id, meta_json')
    .eq('id', playerId)
    .limit(1)
    .single();
  if (perr || !pdata) return [];
  const player = pdata as PlayerRow;

  // Curated player clip from meta_json.video_highlight_url → FIRST entry.
  const curatedUrl = (player.meta_json as { video_highlight_url?: string } | null)?.video_highlight_url;
  const curatedId = typeof curatedUrl === 'string' ? youtubeIdFromUrl(curatedUrl) : null;

  // Resolve team for the per-game candidates.
  let teamSportsdbId: string | null = null;
  if (player.team_id) {
    const { data: tdata } = await supabase
      .from('teams')
      .select('external_id')
      .eq('id', player.team_id)
      .limit(1)
      .single();
    teamSportsdbId = (tdata as { external_id?: string } | null)?.external_id ?? null;
  }

  const teamPlaylist = teamSportsdbId
    ? await getPlaylistForTeam(teamSportsdbId, limit)
    : [];

  // If we have a curated clip, embed-check it and stick it on top.
  if (curatedId) {
    const status = await checkEmbeddability([curatedId]);
    if (status.get(curatedId)?.embeddable) {
      const head: PlaylistEntry = {
        video_id: curatedId,
        title: `${player.full_name ?? 'Player'} — Highlights`,
        played_on: null,
        embeddable: true,
        source: 'curated',
      };
      const tail = teamPlaylist.filter((e) => e.video_id !== curatedId);
      return [head, ...tail].slice(0, limit);
    }
  }
  return teamPlaylist;
}

// ─── DB persistence ─────────────────────────────────────────────────────────

/**
 * Refresh-and-persist a single team's playlist into Supabase. Idempotent:
 * if the existing meta_json.highlight_playlist_resolved_at is < TTL old
 * AND `force` is false, we leave the row alone.
 *
 * Returns the playlist that's now in the DB (whether freshly resolved or
 * the cached one we kept).
 */
export async function refreshTeamPlaylist(
  team: TeamRow,
  opts: { force?: boolean; limit?: number } = {},
): Promise<PlaylistEntry[]> {
  if (!team.external_id) return [];
  const force = opts.force ?? false;
  const limit = opts.limit ?? DEFAULT_PLAYLIST_LIMIT;
  const meta = team.meta_json ?? {};
  const existing = (meta as { highlight_playlist?: PlaylistEntry[] }).highlight_playlist;
  const resolvedAt = (meta as { highlight_playlist_resolved_at?: string }).highlight_playlist_resolved_at;
  if (!force && Array.isArray(existing) && resolvedAt && Date.parse(resolvedAt) > Date.now() - PLAYLIST_TTL_MS) {
    return existing.slice(0, limit);
  }
  const playlist = await getPlaylistForTeam(team.external_id, limit);
  const newMeta = {
    ...meta,
    highlight_playlist: playlist,
    highlight_playlist_resolved_at: new Date().toISOString(),
  };
  const { error: uerr } = await supabase.from('teams').update({ meta_json: newMeta }).eq('id', team.id);
  if (uerr) {
    console.warn(`[playlistResolver] team update failed for ${team.full_name}: ${uerr.message}`);
  }
  return playlist;
}

export async function refreshPlayerPlaylist(
  player: PlayerRow,
  opts: { force?: boolean; limit?: number } = {},
): Promise<PlaylistEntry[]> {
  const force = opts.force ?? false;
  const limit = opts.limit ?? DEFAULT_PLAYLIST_LIMIT;
  const meta = player.meta_json ?? {};
  const existing = (meta as { highlight_playlist?: PlaylistEntry[] }).highlight_playlist;
  const resolvedAt = (meta as { highlight_playlist_resolved_at?: string }).highlight_playlist_resolved_at;
  if (!force && Array.isArray(existing) && resolvedAt && Date.parse(resolvedAt) > Date.now() - PLAYLIST_TTL_MS) {
    return existing.slice(0, limit);
  }
  const playlist = await getPlaylistForPlayer(player.id, limit);
  const newMeta = {
    ...meta,
    highlight_playlist: playlist,
    highlight_playlist_resolved_at: new Date().toISOString(),
  };
  const { error: uerr } = await supabase.from('players').update({ meta_json: newMeta }).eq('id', player.id);
  if (uerr) {
    console.warn(`[playlistResolver] player update failed for ${player.full_name}: ${uerr.message}`);
  }
  return playlist;
}

// ─── Test seam ──────────────────────────────────────────────────────────────

/**
 * Test-only: build playlist directly from supplied events, bypassing
 * SportsDB. Used by playlistResolver.test.ts so we can exercise the
 * embeddability filter + sort + dedup without a real network round-trip.
 */
export async function _buildPlaylistForTests(
  events: TeamHighlightEvent[],
  limit = DEFAULT_PLAYLIST_LIMIT,
): Promise<PlaylistEntry[]> {
  return buildPlaylistFromCandidates(eventsToCandidates(events), limit);
}

export const PLAYLIST_TTL_DAYS_EXPORTED = PLAYLIST_TTL_DAYS;
export const CANDIDATES_TO_PULL_EXPORTED = CANDIDATES_TO_PULL;
