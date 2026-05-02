/**
 * highlights.ts
 * GET /api/highlights/:entityType/:entityName
 *
 * Returns up to 5 YouTube highlight video results for a team or player.
 * Results are cached in memory for 24 hours.
 * Exports warmCache() for the daily cron refresh.
 */

import type { FastifyInstance } from 'fastify';
import { searchHighlights, type VideoResult } from '../services/youtubeSearch.js';
import { supabase } from '../db/client.js';
import {
  getPlaylistForPlayer,
  getPlaylistForTeam,
  type PlaylistEntry,
} from '../services/highlights/playlistResolver.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  ts: number;
  data: VideoResult[];
}

export const highlightCache = new Map<string, CacheEntry>();

function cacheKey(entityType: string, entityName: string): string {
  return `${entityType}:${entityName.toLowerCase().trim()}`;
}

async function fetchWithCache(entityType: string, entityName: string): Promise<VideoResult[]> {
  const key = cacheKey(entityType, entityName);
  const cached = highlightCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  const type: 'player' | 'team' | 'game' =
    entityType === 'team' ? 'team' :
    entityType === 'game' ? 'game' :
    'player';
  const data = await searchHighlights(entityName, 5, type);
  highlightCache.set(key, { ts: Date.now(), data });
  return data;
}

// ─── Cron helper ──────────────────────────────────────────────────────────────

// Teams and star players to pre-warm daily so the first user request is instant.
const FEATURED_ENTITIES: Array<{ type: string; name: string }> = [
  // NBA
  { type: 'team', name: 'Los Angeles Lakers' },
  { type: 'team', name: 'Boston Celtics' },
  { type: 'team', name: 'Golden State Warriors' },
  { type: 'team', name: 'Miami Heat' },
  { type: 'team', name: 'Denver Nuggets' },
  // NFL
  { type: 'team', name: 'Kansas City Chiefs' },
  { type: 'team', name: 'Buffalo Bills' },
  { type: 'team', name: 'Philadelphia Eagles' },
  // MLB
  { type: 'team', name: 'New York Yankees' },
  { type: 'team', name: 'Los Angeles Dodgers' },
  // NHL
  { type: 'team', name: 'Colorado Avalanche' },
  { type: 'team', name: 'Edmonton Oilers' },
  // Star players
  { type: 'player', name: 'LeBron James' },
  { type: 'player', name: 'Stephen Curry' },
  { type: 'player', name: 'Nikola Jokic' },
  { type: 'player', name: 'Patrick Mahomes' },
  { type: 'player', name: 'Shohei Ohtani' },
  { type: 'player', name: 'Connor McDavid' },
];

/** Called by the daily cron to refresh highlight cache for featured entities. */
export async function warmHighlightCache(log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }): Promise<void> {
  log.info('[highlights] Starting daily cache warm-up');
  let ok = 0;
  let fail = 0;
  for (const { type, name } of FEATURED_ENTITIES) {
    try {
      const key = cacheKey(type, name);
      // Force refresh by clearing the entry first
      highlightCache.delete(key);
      await fetchWithCache(type, name);
      ok++;
      // Rate-limit: 300ms between requests to avoid hammering YouTube
      await new Promise((r) => setTimeout(r, 300));
    } catch {
      fail++;
    }
  }
  log.info(`[highlights] Cache warm-up done — ${ok} ok, ${fail} failed`);
}

// ─── Curated meta_json lookup ─────────────────────────────────────────────────
//
// SportsDB-backed highlight URLs (populated by `npm run pull:highlights`)
// live on `players.meta_json.video_highlight_url` and
// `teams.meta_json.video_highlight_url`. Looking up by name keeps the
// existing /api/highlights URL contract — the modal already calls this
// path with `entityName`, so we just prepend the curated URL to the
// search-derived list and the existing client renders it.

interface CuratedHit {
  video_url: string;
  // Used as `id` so dedup vs. YouTube search results works.
  // For YouTube URLs we extract the videoId; for everything else we hash.
  id: string;
}

function youTubeIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      // /watch/{id} or /embed/{id} or /shorts/{id}
      const m = u.pathname.match(/\/(?:embed|shorts|watch)\/([\w-]+)/);
      if (m) return m[1];
    }
    if (u.hostname === 'youtu.be') return u.pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
  return null;
}

async function fetchCurated(entityType: string, entityName: string): Promise<CuratedHit | null> {
  const table = entityType === 'team' ? 'teams' : 'players';
  const col = table === 'teams' ? 'full_name' : 'full_name';
  try {
    const { data } = await supabase
      .from(table)
      .select('meta_json')
      .ilike(col, entityName)
      .limit(1)
      .single();
    const url = (data as { meta_json?: { video_highlight_url?: string } } | null)?.meta_json?.video_highlight_url;
    if (typeof url === 'string' && url.startsWith('https://')) {
      const id = youTubeIdFromUrl(url) ?? `curated:${url.slice(0, 64)}`;
      return { video_url: url, id };
    }
  } catch {
    // Non-fatal — fall through to YouTube search.
  }
  return null;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function highlightsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { entityType: string; entityName: string } }>(
    '/api/highlights/:entityType/:entityName',
    async (req, reply) => {
      const { entityType } = req.params;
      const entityName = decodeURIComponent(req.params.entityName);
      try {
        const [curated, searchResults] = await Promise.all([
          fetchCurated(entityType, entityName),
          fetchWithCache(entityType, entityName),
        ]);
        let highlights = searchResults;
        if (curated) {
          // Prepend curated, dedup against search results so we never show
          // the same clip twice.
          const dedup = searchResults.filter((r) => r.id !== curated.id);
          highlights = [
            { id: curated.id, title: 'Latest highlight (SportsDB)', channel: 'SportsDB' },
            ...dedup,
          ];
        }
        return reply.send({ highlights });
      } catch (err) {
        fastify.log.warn(err, `highlights fetch failed for ${entityType}/${entityName}`);
        return reply.send({ highlights: [] });
      }
    },
  );

  // GET /api/team/:sportsdbId/recent-highlights — used by the team profile
  // "Recent Highlights" section. Returns the meta_json.recent_highlights
  // array (newest first), or [] if missing.
  fastify.get<{ Params: { sportsdbId: string } }>(
    '/api/team/:sportsdbId/recent-highlights',
    async (req, reply) => {
      const { sportsdbId } = req.params;
      try {
        const { data, error } = await supabase
          .from('teams')
          .select('meta_json')
          .eq('external_id', sportsdbId)
          .limit(1)
          .single();
        if (error || !data) return reply.send({ highlights: [] });
        const recent = (data as { meta_json?: { recent_highlights?: unknown[] } }).meta_json
          ?.recent_highlights;
        return reply.send({ highlights: Array.isArray(recent) ? recent : [] });
      } catch (err) {
        fastify.log.warn(err, `recent-highlights fetch failed for ${sportsdbId}`);
        return reply.send({ highlights: [] });
      }
    },
  );

  // GET /api/players/:id/highlights/playlist — embeddable 5-video playlist
  // for the in-app HighlightsPlayerModal. Reads meta_json.highlight_playlist
  // when present (populated by `npm run pull:highlights`); falls back to a
  // live resolve when the row hasn't been processed yet.
  fastify.get<{ Params: { id: string }; Querystring: { live?: string } }>(
    '/api/players/:id/highlights/playlist',
    async (req, reply) => {
      const { id } = req.params;
      const live = req.query.live === '1' || req.query.live === 'true';
      try {
        if (!live) {
          const { data } = await supabase
            .from('players')
            .select('meta_json')
            .eq('id', id)
            .limit(1)
            .single();
          const cached = (data as { meta_json?: { highlight_playlist?: PlaylistEntry[] } } | null)
            ?.meta_json?.highlight_playlist;
          if (Array.isArray(cached) && cached.length > 0) {
            return reply.send({ playlist: cached.slice(0, 5), source: 'cached' });
          }
        }
        const playlist = await getPlaylistForPlayer(id, 5);
        return reply.send({ playlist, source: 'live' });
      } catch (err) {
        fastify.log.warn(err, `playlist fetch failed for player ${id}`);
        return reply.send({ playlist: [], source: 'error' });
      }
    },
  );

  // GET /api/teams/:id/highlights/playlist — same as above but team-scoped.
  // Accepts either the internal Supabase id OR the SportsDB external_id —
  // we try internal first, then fall back to external_id lookup.
  fastify.get<{ Params: { id: string }; Querystring: { live?: string } }>(
    '/api/teams/:id/highlights/playlist',
    async (req, reply) => {
      const { id } = req.params;
      const live = req.query.live === '1' || req.query.live === 'true';
      try {
        const { data } = await supabase
          .from('teams')
          .select('id, external_id, meta_json')
          .or(`id.eq.${id},external_id.eq.${id}`)
          .limit(1)
          .single();
        const team = data as { id: string; external_id: string | null; meta_json?: { highlight_playlist?: PlaylistEntry[] } } | null;
        if (!team) return reply.send({ playlist: [], source: 'not_found' });
        if (!live) {
          const cached = team.meta_json?.highlight_playlist;
          if (Array.isArray(cached) && cached.length > 0) {
            return reply.send({ playlist: cached.slice(0, 5), source: 'cached' });
          }
        }
        const playlist = team.external_id
          ? await getPlaylistForTeam(team.external_id, 5)
          : [];
        return reply.send({ playlist, source: 'live' });
      } catch (err) {
        fastify.log.warn(err, `playlist fetch failed for team ${id}`);
        return reply.send({ playlist: [], source: 'error' });
      }
    },
  );
}
