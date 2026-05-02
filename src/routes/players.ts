/**
 * routes/players.ts — player rating endpoints.
 *
 *   GET /players/:id/rating
 *     Look up player by external_id ('espn:1234') across the per-league
 *     caches and compute a 13-grade rating (A+ … F).
 *
 *   GET /admin/ratings/distribution
 *     Per-league histogram of overall_grade counts. Used by the admin
 *     dashboard's "Rating Distribution" 13-bar chart.
 */
import type { FastifyInstance } from 'fastify';
import { computeRating, type Grade, GRADE_ORDER } from '../services/ratings/computeRatings.js';
import {
  findPlayer,
  getAllPlayers,
  getCacheCounts,
  getPlayerRating,
  getPlayerStats,
} from '../services/ratings/cacheLookup.js';
import type { League } from '../services/stats/types.js';

const GRADES: Grade[] = GRADE_ORDER;

function emptyDist(): Record<Grade, number> {
  const out = {} as Record<Grade, number>;
  for (const g of GRADE_ORDER) out[g] = 0;
  return out;
}

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
      const breakdowns_json = supaRating.breakdowns_json as
        | {
            stat_breakdowns?: unknown[];
            score?: number;
            confidence?: number;
            secondary_grade?: unknown;
            alternate_rating?: unknown;
            position?: string;
          }
        | null;
      const breakdowns = breakdowns_json?.stat_breakdowns;
      // Accept either column name from the DB row — overall_grade is the
      // post-rename column; overall_tier handles legacy rows that haven't
      // been recomputed yet (mapped 5-tier name → grade letter).
      const grade = (supaRating.overall_grade ?? supaRating.overall_tier) as Grade;
      return {
        player_id: supaRating.player_id,
        sport: supaRating.sport,
        position: breakdowns_json?.position ?? found.player.position_group,
        overall_grade: grade,
        stat_breakdowns: Array.isArray(breakdowns) ? breakdowns : [],
        score: typeof breakdowns_json?.score === 'number' ? breakdowns_json.score : 0,
        confidence: typeof breakdowns_json?.confidence === 'number' ? breakdowns_json.confidence : 0,
        ...(breakdowns_json?.secondary_grade ? { secondary_grade: breakdowns_json.secondary_grade } : {}),
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
      source: supaStats ? 'supabase-stats+computed' : (result.source ?? 'tier-files-v2'),
    };
  });

  fastify.get('/admin/ratings/distribution', async () => {
    const leagues: League[] = ['nfl', 'nba', 'mlb', 'nhl', 'mls'];
    const out: Record<string, Record<Grade, number>> = {};
    for (const league of leagues) {
      const c = getAllPlayers(league);
      if (!c) {
        out[league] = emptyDist();
        continue;
      }
      const dist = emptyDist();
      for (const p of c.players) {
        const r = computeRating({
          playerId: p.external_id,
          sport: league,
          position: p.position_group,
          stats: p.stats,
        });
        if (r) dist[r.overall_grade] = (dist[r.overall_grade] ?? 0) + 1;
      }
      out[league] = dist;
    }
    return {
      generated_at: new Date().toISOString(),
      grades: GRADES,
      distribution: out,
      totals: getCacheCounts(),
    };
  });
}
