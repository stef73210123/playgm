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

/**
 * Legacy entitlement shape for /subscription consumers. Kept for backward
 * compatibility with the client's `SubscriptionEntitlements` type — new
 * fields (draft_modes, fa_pool_size_per_week, draft_position_control)
 * live on the canonical spec at `data/economy/pgm_subscriptions.json`
 * and should be read via `getSubscription()` server-side.
 *
 * v2 (subscription rebalance, May 2026):
 *   - rosters: 1 (free) / 3 (starter) / 6 (playmaker) / 12 (champion). The
 *     legacy `rostersPerWeek` field collapses to 2 / 3 to match the historical
 *     2 | 3 union — clients reading new code should use the spec directly.
 *   - practice drafts: 1 / 5 / 15 / -1 (unlimited)
 *   - deepDivesUnlocked: TRUE for every tier — all scouting is free now.
 */
const TIER_ENTITLEMENTS = {
  free:      { rostersPerWeek: 2, practiceDraftsPerWeek: 1,  capModeUnlocked: false, deepDivesUnlocked: true },
  starter:   { rostersPerWeek: 3, practiceDraftsPerWeek: 5,  capModeUnlocked: true,  deepDivesUnlocked: true },
  playmaker: { rostersPerWeek: 3, practiceDraftsPerWeek: 15, capModeUnlocked: true,  deepDivesUnlocked: true },
  champion:  { rostersPerWeek: 3, practiceDraftsPerWeek: -1, capModeUnlocked: true,  deepDivesUnlocked: true },
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
