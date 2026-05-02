/**
 * Multi-roster / weekly-draft routes (GDD §3, §4).
 *
 * Stub implementation — returns mock data shaped to the client's `Roster` /
 * `WeeklyDraftEvent` types in src/types/multiRoster.ts. The real implementation
 * will persist to Supabase, but for now this lets the client wire screens up
 * behind the `multiRoster` / `draftEvent` feature flags.
 *
 * Routes:
 *   GET  /rosters                          — list current-week rosters for the caller
 *   POST /rosters                          — create a new roster in the current week's draft event
 *   GET  /rosters/:id/weekly-projection    — { games_count, projected_points } for the roster (cached 1h)
 *   GET  /drafts/current                   — the caller's in-progress weekly draft event
 *   POST /drafts/:id/pick                  — record a snake-draft pick onto a specific roster
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validateRoster, isDraftModeAllowed, type RosterCard } from '../economy/index.js';
import type { SubscriptionTierId } from '../economy/types.js';
import {
  computeWeeklyProjection,
  type WeeklyProjection,
} from '../services/weeklyProjection.js';

/**
 * Resolve the caller's subscription tier. Same dev shim as practiceDrafts.ts
 * — replace with `request.user.subscription_tier` once the auth task ships.
 */
function resolveTier(req: FastifyRequest): SubscriptionTierId {
  const hdr = req.headers['x-subscription-tier'];
  if (hdr === 'starter' || hdr === 'playmaker' || hdr === 'champion') return hdr;
  return 'free';
}

const pickSchema = z.object({
  rosterId: z.string().min(1),
  playerId: z.string().min(1),
  slot: z.number().int().min(1).max(8),
});

const createRosterSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  draftMode: z.enum(['snake', 'cap']),
});

// Lock-roster validation: checks the four constraints from card-system.md §5.
const lockRosterSchema = z.object({
  rosterId: z.string().min(1),
  cards: z
    .array(
      z.object({
        template_id: z.string().min(1),
        player_id: z.string().min(1),
        inventory_id: z.string().optional(),
      }),
    )
    .max(64),
  legendaryAlreadyPlacedThisWeek: z.number().int().min(0).optional(),
});

function isoMondayOfCurrentWeek(): string {
  const now = new Date();
  const day = now.getUTCDay();             // 0 = Sun
  const diff = (day + 6) % 7;              // distance to previous Monday
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

export async function rostersRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── GET /rosters — list current-week rosters ────────────────────────────
  fastify.get('/rosters', { preHandler: requireAuth }, async (req, _reply) => {
    const { profileId } = req as AuthenticatedRequest;
    return {
      profileId,
      weekOf: isoMondayOfCurrentWeek(),
      rosters: [], // stub — real impl selects from `rosters` table
    };
  });

  // ─── POST /rosters — create a new roster for the current week ─────────────
  fastify.post('/rosters', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createRosterSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { profileId } = req as AuthenticatedRequest;

    // Tier gate — Free tier is snake-only. Cap (auction) drafts unlock at
    // Starter. Server-side enforcement so the client UI can't bypass it.
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
      id: `roster_stub_${Date.now()}`,
      profileId,
      name: parsed.data.name ?? 'New Roster',
      draftMode: parsed.data.draftMode,
      players: [],
      bench: [],
      nightlyFreeAgents: {},
      weekOf: isoMondayOfCurrentWeek(),
      createdAt: new Date().toISOString(),
    };
  });

  // ─── GET /drafts/current — the caller's active weekly draft event ─────────
  fastify.get('/drafts/current', { preHandler: requireAuth }, async (req, _reply) => {
    const { profileId } = req as AuthenticatedRequest;
    return {
      id: `draft_stub_${profileId}`,
      profileId,
      weekOf: isoMondayOfCurrentWeek(),
      mode: 'snake',
      status: 'open',
      rosterIds: [],
      snakePositionByRoster: {},
    };
  });

  // ─── POST /drafts/:id/pick — record a snake-draft pick ────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/drafts/:id/pick',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = pickSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const { rosterId, playerId, slot } = parsed.data;
      return {
        draftId: req.params.id,
        rosterId,
        slot,
        playerId,
        accepted: true,
        recordedAt: new Date().toISOString(),
      };
    },
  );

  // ─── GET /rosters/:id/weekly-projection — games count + projected points
  // Drives the chips on the roster card. Stubbed deterministically from the
  // roster id (real impl reads the roster's drafted players, sums per-player
  // upcoming-games from SportsDB, and weights season-to-date PPG by games
  // remaining this week). Cached in-process with a 1-hour TTL so we don't
  // hit upstream on every render.
  fastify.get<{ Params: { id: string } }>(
    '/rosters/:id/weekly-projection',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;
      if (!id || id.length === 0) {
        return reply.code(400).send({ error: 'roster id required' });
      }
      const result: WeeklyProjection = await computeWeeklyProjection(id);
      return reply.send({
        rosterId: id,
        games_count: result.gamesCount,
        projected_points: result.projectedPoints,
        cachedUntil: result.cachedUntilIso,
      });
    },
  );

  // ─── POST /rosters/lock — server-authoritative roster validation (card-system.md §5)
  // Validates the four constraints (energy budget, per-player cap, rarity
  // caps, cross-roster Legendary cap) before the roster is locked for
  // scoring. Returns 422 with structured error codes on failure.
  fastify.post('/rosters/lock', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = lockRosterSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { profileId } = req as AuthenticatedRequest;

    const cards: RosterCard[] = parsed.data.cards;
    const result = validateRoster(cards, {
      legendaryAlreadyPlacedThisWeek: parsed.data.legendaryAlreadyPlacedThisWeek,
    });

    if (!result.ok) {
      return reply.code(422).send({
        ok: false,
        rosterId: parsed.data.rosterId,
        errors: result.errors,
        totals: result.totals,
      });
    }
    return reply.send({
      ok: true,
      rosterId: parsed.data.rosterId,
      profileId,
      lockedAt: new Date().toISOString(),
      totals: result.totals,
    });
  });
}
