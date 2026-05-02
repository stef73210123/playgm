/**
 * trade.ts — REST endpoints for the PlayGM trade engine.
 *
 *   POST   /trades                — propose a new trade
 *   GET    /trades                — list trades involving the caller (active + history)
 *   GET    /trades/:id            — fetch a single trade
 *   POST   /trades/:id/accept     — counterparty accepts, executes the trade
 *   POST   /trades/:id/reject     — counterparty rejects
 *   POST   /trades/:id/cancel     — proposer withdraws
 *   POST   /trades/preview        — fairness preview (no DB write)
 *
 * The route layer is a thin shell — fairness, caps, lock checks, and DB
 * writes all live in `services/trade/*`.  Auth uses the same handle-based
 * shim as the rest of the routes (see middleware/auth.ts) until full
 * Supabase auth swaps in across the codebase.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  proposeTrade,
  acceptTrade,
  rejectTrade,
  cancelTrade,
  listTradesForUser,
  type ProposeInput,
} from '../services/trade/tradeService.js';
import {
  evaluateFairness,
  type TradeSide,
} from '../services/trade/tradeFairness.js';
import { supabase } from '../db/client.js';

// ─── Validation ──────────────────────────────────────────────────────────────

const gradeSchema = z.enum([
  'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F',
]);

const sideSchema = z.object({
  user_id: z.string().min(1),
  players: z
    .array(z.object({ player_id: z.string().min(1), grade: gradeSchema }))
    .min(1)
    .max(3),
  pp_sweetener: z.number().int().min(0).max(2000).optional(),
});

const proposeSchema = z.object({
  responder_id: z.string().min(1),
  sport: z.string().min(2).max(8),
  league_id: z.string().nullable().optional(),
  side_a: sideSchema,
  side_b: sideSchema,
  season_key: z.string().min(2).max(40),
});

const previewSchema = z.object({
  side_a: sideSchema,
  side_b: sideSchema,
});

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function tradeRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /trades/preview — fairness check, no DB write
  fastify.post('/trades/preview', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = evaluateFairness(parsed.data.side_a as TradeSide, parsed.data.side_b as TradeSide);
    return { ok: true, fairness: result };
  });

  // POST /trades — propose
  fastify.post('/trades', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = proposeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { profileId } = req as AuthenticatedRequest;
    const body = parsed.data;

    if (body.side_a.user_id !== profileId) {
      return reply.code(403).send({ error: 'side_a.user_id must match the caller' });
    }
    if (body.side_b.user_id !== body.responder_id) {
      return reply.code(400).send({ error: 'side_b.user_id must match responder_id' });
    }

    // Pull tier + age from the profile so the service layer can apply
    // the cap + COPPA gates.  Friend-list lookup is best-effort: when the
    // friends table doesn't exist the under-13 trade is blocked outright.
    const { data: proposerProfile } = await supabase
      .from('profiles')
      .select('subscription_tier, age, dob')
      .eq('id', profileId)
      .maybeSingle();
    const tier = (proposerProfile?.subscription_tier ?? 'free') as string;
    const age = computeAge(proposerProfile);
    const under13 = age != null && age < 13;

    let friendIds: string[] = [];
    if (under13) {
      const { data: friends } = await supabase
        .from('friends')
        .select('friend_id')
        .eq('user_id', profileId);
      friendIds = (friends ?? []).map((r: { friend_id: string }) => r.friend_id);
    }

    const input: ProposeInput = {
      proposer_id: profileId,
      responder_id: body.responder_id,
      sport: body.sport,
      league_id: body.league_id ?? null,
      side_a: body.side_a as TradeSide,
      side_b: body.side_b as TradeSide,
      proposer_tier: tier,
      season_key: body.season_key,
      proposer_under_13: under13,
      proposer_friend_ids: friendIds,
    };

    const result = await proposeTrade(input);
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.error, fairness: result.fairness });
    }
    return reply.code(201).send(result);
  });

  // GET /trades — list active + history for the caller
  fastify.get('/trades', { preHandler: requireAuth }, async (req) => {
    const { profileId } = req as AuthenticatedRequest;
    const trades = await listTradesForUser(profileId);
    return {
      ok: true,
      pending: trades.filter((t) => t.status === 'pending'),
      history: trades.filter((t) => t.status !== 'pending'),
    };
  });

  // GET /trades/:id — single trade
  fastify.get<{ Params: { id: string } }>(
    '/trades/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { profileId } = req as AuthenticatedRequest;
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (error || !data) return reply.code(404).send({ error: 'Trade not found' });
      const t = data as unknown as { proposer_id: string; responder_id: string };
      if (t.proposer_id !== profileId && t.responder_id !== profileId) {
        return reply.code(403).send({ error: 'Not a participant' });
      }
      return { ok: true, trade: data };
    },
  );

  // POST /trades/:id/accept
  fastify.post<{ Params: { id: string } }>(
    '/trades/:id/accept',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { profileId } = req as AuthenticatedRequest;
      const result = await acceptTrade(req.params.id, profileId);
      if (!result.ok) return reply.code(400).send(result);
      return result;
    },
  );

  // POST /trades/:id/reject
  fastify.post<{ Params: { id: string } }>(
    '/trades/:id/reject',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { profileId } = req as AuthenticatedRequest;
      const result = await rejectTrade(req.params.id, profileId);
      if (!result.ok) return reply.code(400).send(result);
      return result;
    },
  );

  // POST /trades/:id/cancel
  fastify.post<{ Params: { id: string } }>(
    '/trades/:id/cancel',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { profileId } = req as AuthenticatedRequest;
      const result = await cancelTrade(req.params.id, profileId);
      if (!result.ok) return reply.code(400).send(result);
      return result;
    },
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeAge(profile: { age?: number | null; dob?: string | null } | null): number | null {
  if (!profile) return null;
  if (typeof profile.age === 'number') return profile.age;
  if (typeof profile.dob === 'string') {
    const dob = new Date(profile.dob);
    if (Number.isNaN(dob.getTime())) return null;
    const ms = Date.now() - dob.getTime();
    const years = ms / (365.25 * 24 * 3600 * 1000);
    return Math.floor(years);
  }
  return null;
}
