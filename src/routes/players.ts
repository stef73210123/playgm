/**
 * routes/players.ts — player rating endpoints.
 *
 *   GET /players/:id/rating
 *     Look up player by external_id ('espn:1234') across the per-league
 *     caches and compute a tier rating.
 *
 *   GET /admin/ratings/distribution
 *     Per-league histogram of overall_tier counts. Used by the admin
 *     dashboard's "Rating Distribution" mini-chart.
 */
import type { FastifyInstance } from 'fastify';
import { computeRating, type TierName } from '../services/ratings/computeRatings.js';
import {
  findPlayer,
  getAllPlayers,
  getCacheCounts,
  getPlayerRating,
  getPlayerStats,
} from '../services/ratings/cacheLookup.js';
import type { League } from '../services/stats/types.js';

const TIERS: TierName[] = ['elite', 'strong', 'solid', 'role', 'deep_bench'];

export async function playersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>('/players/:id/rating', async (req, reply) => {
    const id = req.params.id;
    // Try the JSON cache first to recover (sport, position_group, full
    // stats blob) — those metadata fields are not in player_stats.
    const found = findPlayer(id);
    if (!found) {
      reply.code(404);
      return { error: 'player_not_found', player_id: id };
    }

    // Supabase-first: if a precomputed rating exists, prefer it. The DB row
    // is the freshest source once the refreshStats job is dual-writing.
    const supaRating = await getPlayerRating(id, found.league);
    if (supaRating) {
      const breakdowns = (supaRating.breakdowns_json as { stat_breakdowns?: unknown[] } | null)
        ?.stat_breakdowns;
      return {
        player_id: supaRating.player_id,
        sport: supaRating.sport,
        position: found.player.position_group,
        overall_tier: supaRating.overall_tier as TierName,
        stat_breakdowns: Array.isArray(breakdowns) ? breakdowns : [],
        score: 0,
        source: 'supabase-player-ratings',
      };
    }

    // Otherwise pull stats from Supabase (falling back to the JSON cache)
    // and compute on-demand. The cache `position_group` is required either way.
    const supaStats = await getPlayerStats(id, found.league);
    const stats = supaStats?.stats_json ?? found.player.stats;
    const result = computeRating({
      playerId: found.player.external_id,
      sport: found.league,
      position: found.player.position_group,
      stats,
    });
    if (!result) {
      reply.code(503);
      return {
        error: 'tier_file_missing',
        player_id: id,
        sport: found.league,
        position: found.player.position_group,
      };
    }
    return {
      ...result,
      source: supaStats ? 'supabase-stats+computed' : (result.source ?? 'tier-files-v1'),
    };
  });

  fastify.get('/admin/ratings/distribution', async () => {
    const leagues: League[] = ['nfl', 'nba', 'mlb', 'nhl', 'mls'];
    const out: Record<string, Record<TierName, number>> = {};
    for (const league of leagues) {
      const c = getAllPlayers(league);
      if (!c) {
        out[league] = { elite: 0, strong: 0, solid: 0, role: 0, deep_bench: 0 };
        continue;
      }
      const dist: Record<TierName, number> = { elite: 0, strong: 0, solid: 0, role: 0, deep_bench: 0 };
      for (const p of c.players) {
        const r = computeRating({
          playerId: p.external_id,
          sport: league,
          position: p.position_group,
          stats: p.stats,
        });
        if (r) dist[r.overall_tier] = (dist[r.overall_tier] ?? 0) + 1;
      }
      out[league] = dist;
    }
    return {
      generated_at: new Date().toISOString(),
      tiers: TIERS,
      distribution: out,
      totals: getCacheCounts(),
    };
  });
}
