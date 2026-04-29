/**
 * Subscription routes (GDD §8).
 *
 * Stub implementation — no real billing provider wired up yet. Routes accept
 * intent and return updated subscription state; production implementation will
 * delegate to Stripe / Apple IAP / Google Play Billing.
 *
 * Routes:
 *   GET  /subscription                — current tier + entitlements for the caller
 *   POST /subscription/upgrade        — upgrade to a paid tier (stub: records intent)
 *   POST /subscription/cancel         — cancel at renewal
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const upgradeSchema = z.object({
  tier: z.enum(['starter', 'playmaker', 'champion']),
});

const TIER_ENTITLEMENTS = {
  free:      { rostersPerWeek: 2, practiceDraftsPerWeek: 1,  capModeUnlocked: false, deepDivesUnlocked: false },
  starter:   { rostersPerWeek: 3, practiceDraftsPerWeek: 5,  capModeUnlocked: true,  deepDivesUnlocked: true  },
  playmaker: { rostersPerWeek: 3, practiceDraftsPerWeek: 10, capModeUnlocked: true,  deepDivesUnlocked: true  },
  champion:  { rostersPerWeek: 3, practiceDraftsPerWeek: -1, capModeUnlocked: true,  deepDivesUnlocked: true  },
} as const;

export async function subscriptionRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── GET /subscription — current tier + entitlements ─────────────────────
  fastify.get('/subscription', { preHandler: requireAuth }, async (req, _reply) => {
    const { profileId } = req as AuthenticatedRequest;
    // Stub: every new profile starts Free.
    return {
      profileId,
      tier: 'free' as const,
      renewsAt: null,
      pending: false,
      entitlements: TIER_ENTITLEMENTS.free,
    };
  });

  // ─── POST /subscription/upgrade — upgrade intent ──────────────────────────
  fastify.post('/subscription/upgrade', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = upgradeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { profileId } = req as AuthenticatedRequest;
    const { tier } = parsed.data;
    // Stub — real impl creates a billing session and returns a checkout URL.
    return {
      profileId,
      tier,
      pending: true,
      entitlements: TIER_ENTITLEMENTS[tier],
      renewsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      checkoutUrl: null, // populated once billing provider is wired
    };
  });

  // ─── POST /subscription/cancel — cancel at renewal ────────────────────────
  fastify.post('/subscription/cancel', { preHandler: requireAuth }, async (req, _reply) => {
    const { profileId } = req as AuthenticatedRequest;
    return {
      profileId,
      cancellationScheduled: true,
      effectiveAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  });
}
