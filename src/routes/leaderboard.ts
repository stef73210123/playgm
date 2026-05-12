/**
 * Leaderboard route.
 *
 * Exposes GET /leaderboard returning the top N profiles ranked by
 * play_points (configurable via `?limit=`, capped at 100). Scope is
 * intentionally narrow — the richer badge/trend data shown on the
 * client's LeaderboardScreen is still served from mock data in
 * `src/data/mockLeaderboard.ts` while per-user historical aggregates are
 * not yet tracked server-side. This endpoint is the first live slice.
 */

import type { FastifyInstance } from 'fastify';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';

export async function leaderboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/leaderboard', async (req, reply) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 100);

    // 2026-05-12 — was `select(..., level, ...)` which referenced a column that
    // doesn't exist (profiles has level_tier + level_index; see schema.sql:383–384).
    // Endpoint was returning 500 on every call → client falling through to
    // mockLeaderboard.ts. Switched to level_index (the numeric 0-12 ladder) and
    // surfaced level_tier too so the client can render either the number or the
    // tier name without a second round-trip.
    const { data, error } = await supabase
      .from('profiles')
      .select('id, handle, level_index, level_tier, gm_grade, play_points, streak, pp')
      .order('play_points', { ascending: false })
      .limit(limit);

    if (error) return reply.code(500).send({ error: error.message });

    const rows = (data ?? []).map((row, idx) => {
      const r = row as Record<string, unknown>;
      // level surfaced as the numeric index + 1 so the client gets a 1-13
      // value matching its existing User.level shape, plus the tier name
      // verbatim for surfaces that want "All-Star" instead of "8".
      const levelIndex = (r['level_index'] as number | null) ?? 0;
      return {
        rank: idx + 1,
        id: r['id'] as string,
        handle: r['handle'] as string,
        level: levelIndex + 1,
        levelTier: (r['level_tier'] as string | null) ?? 'Peewee',
        gmGrade: (r['gm_grade'] as string | null) ?? 'C',
        playPoints: (r['play_points'] as number | null) ?? 0,
        streak: (r['streak'] as number | null) ?? 0,
        pp: (r['pp'] as number | null) ?? 0,
      };
    });

    return reply.send(brandingFilter({ entries: rows }));
  });
}
