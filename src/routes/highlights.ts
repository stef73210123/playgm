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

// ─── Route ────────────────────────────────────────────────────────────────────

export async function highlightsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { entityType: string; entityName: string } }>(
    '/api/highlights/:entityType/:entityName',
    async (req, reply) => {
      const { entityType } = req.params;
      const entityName = decodeURIComponent(req.params.entityName);
      try {
        const highlights = await fetchWithCache(entityType, entityName);
        return reply.send({ highlights });
      } catch (err) {
        fastify.log.warn(err, `highlights fetch failed for ${entityType}/${entityName}`);
        return reply.send({ highlights: [] });
      }
    }
  );
}
