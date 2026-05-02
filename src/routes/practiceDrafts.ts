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

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { isDraftModeAllowed } from '../economy/index.js';
import type { SubscriptionTierId } from '../economy/types.js';

const startSchema = z.object({
  draftMode: z.enum(['snake', 'cap']),
});

/**
 * Resolve the caller's subscription tier. Until the auth task wires
 * `request.user.subscription_tier`, fall back to the
 * `x-subscription-tier` header (dev-only convenience) and finally `free`.
 * Same shim pattern used by scoutAsk.ts.
 */
function resolveTier(req: FastifyRequest): SubscriptionTierId {
  const hdr = req.headers['x-subscription-tier'];
  if (hdr === 'starter' || hdr === 'playmaker' || hdr === 'champion') return hdr;
  return 'free';
}

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

    // Tier gate — Free tier may only run snake practice drafts. Cap mode
    // is unlocked starting at Starter. Returns 403 with a friendly envelope
    // the client can render as an upgrade prompt.
    const tier = resolveTier(req);
    if (!isDraftModeAllowed(tier, parsed.data.draftMode)) {
      return reply.code(403).send({
        ok: false,
        error: {
          code: 'DRAFT_MODE_LOCKED',
          message:
            parsed.data.draftMode === 'cap'
              ? 'Cap (auction) drafts unlock with the Starter subscription. Upgrade to try cap mode.'
              : `Your tier doesn't allow ${parsed.data.draftMode} drafts.`,
          tier,
          requested_mode: parsed.data.draftMode,
        },
      });
    }

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
