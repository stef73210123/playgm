/**
 * Multi-roster / weekly-draft routes (GDD §3, §4).
 *
 * Stub implementation — returns mock data shaped to the client's `Roster` /
 * `WeeklyDraftEvent` types in src/types/multiRoster.ts. The real implementation
 * will persist to Supabase, but for now this lets the client wire screens up
 * behind the `multiRoster` / `draftEvent` feature flags.
 *
 * Routes:
 *   GET  /rosters              — list current-week rosters for the caller
 *   POST /rosters              — create a new roster in the current week's draft event
 *   GET  /drafts/current       — the caller's in-progress weekly draft event
 *   POST /drafts/:id/pick      — record a snake-draft pick onto a specific roster
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validateRoster, type RosterCard } from '../economy/index.js';

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
