/**
 * Practice draft routes (GDD §5).
 *
 * Stub implementation. Practice drafts are mock drafts against AI — nothing
 * counts toward official weekly lineups or contests. Weekly-reset allocation
 * is enforced server-side (once real).
 *
 * Routes:
 *   GET  /practice-drafts                — allocation + history for the caller
 *   POST /practice-drafts                — start a new practice draft
 *   POST /practice-drafts/:id/save       — save a practice lineup to the locker
 *   POST /practice-drafts/:id/share      — share a saved lineup with the alliance
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const startSchema = z.object({
  draftMode: z.enum(['snake', 'cap']),
});

const saveSchema = z.object({
  nickname: z.string().max(40).optional(),
});

export async function practiceDraftRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/practice-drafts', { preHandler: requireAuth }, async (req, _reply) => {
    const { profileId } = req as AuthenticatedRequest;
    return {
      profileId,
      allocation: {
        weeklyLimit: 1,       // stub — real impl reads subscription entitlements
        usedThisWeek: 0,
        resetsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      history: [],
    };
  });

  fastify.post('/practice-drafts', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { profileId } = req as AuthenticatedRequest;
    return {
      id: `practice_${Date.now()}`,
      profileId,
      draftMode: parsed.data.draftMode,
      difficulty: 'dummy', // stub — server should resolve via age + level
      createdAt: new Date().toISOString(),
      lineup: [],
      saved: false,
    };
  });

  fastify.post<{ Params: { id: string } }>(
    '/practice-drafts/:id/save',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = saveSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      return {
        id: req.params.id,
        saved: true,
        nickname: parsed.data.nickname,
      };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/practice-drafts/:id/share',
    { preHandler: requireAuth },
    async (req, _reply) => {
      return {
        id: req.params.id,
        sharedWithAlliance: true,
        sharedAt: new Date().toISOString(),
      };
    },
  );
}
