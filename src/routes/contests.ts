/**
 * Contest routes (GDD §6).
 *
 * Stub implementation — returns mock data shaped to the client's `Contest` /
 * `ContestEntry` types. Experience-level filtering is applied per GDD §6.D.
 *
 * Routes:
 *   GET  /contests             — contests available to the caller (filtered by level)
 *   POST /contests/:id/enter   — submit a roster (or better-of signal) into a contest
 *   GET  /contests/:id/results — final standings (post-resolution)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const enterSchema = z.object({
  /** Required for external contests; omitted for alliance contests (better-of applies). */
  rosterId: z.string().min(1).optional(),
});

export async function contestsRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── GET /contests — list contests available to the caller ────────────────
  fastify.get('/contests', { preHandler: requireAuth }, async (req, _reply) => {
    const { profileId } = req as AuthenticatedRequest;
    return {
      profileId,
      contests: [], // stub — real impl queries open contests and filters by level band
    };
  });

  // ─── POST /contests/:id/enter — enter a contest ───────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/contests/:id/enter',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = enterSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const { profileId } = req as AuthenticatedRequest;
      return {
        contestId: req.params.id,
        userId: profileId,
        submittedRosterId: parsed.data.rosterId,
        score: 0,
        status: 'entered',
      };
    },
  );

  // ─── GET /contests/:id/results — final standings ──────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/contests/:id/results',
    { preHandler: requireAuth },
    async (req, _reply) => {
      return {
        contestId: req.params.id,
        status: 'pending',
        entries: [],
      };
    },
  );
}
