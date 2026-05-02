/**
 * me.ts — authenticated read/write surface for the kid's own data.
 *
 * Every route in here:
 *   - validates the Supabase JWT bearer via requireSupabaseAuth
 *   - operates ONLY on rows where user_id = auth.uid() (or the guest's
 *     synthetic user_id for guest-allowed routes)
 *   - returns a tight response payload — these endpoints sit on every
 *     gameplay loop's hot path so we keep responses small
 *
 * Routes:
 *   GET  /me/state                — full hydration payload (AppContext)
 *   POST /me/pp/credit            — credit PP from a server-trusted source
 *   POST /me/sessions/heartbeat   — bump active session
 *   POST /me/trivia               — record trivia attempt + credit PP
 *   POST /me/cards/apply          — record a card-to-player assignment
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../db/client.js';
import { requireSupabaseAuth, type SupabaseAuthedRequest } from '../middleware/supabaseAuth.js';

const PP_BY_DIFFICULTY: Record<'easy' | 'medium' | 'hard', number> = {
  easy: 5,
  medium: 10,
  hard: 20,
};

export async function meRoutes(server: FastifyInstance): Promise<void> {
  // ── GET /me/state ────────────────────────────────────────────────────────
  server.get('/me/state', { preHandler: requireSupabaseAuth }, async (request) => {
    const { userId, isGuest } = request as SupabaseAuthedRequest;

    // Guests don't have a profiles row yet — return seed defaults so the
    // client lands in Home with sane initial state.
    if (isGuest) {
      return {
        handle: 'guest',
        displayName: 'Guest',
        age: null,
        points: 0,
        lifetimePP: 0,
        streak: 0,
        favoriteTeamIds: [],
      };
    }

    // Pull profile + wallet + streak in parallel.
    const [profileRes, walletRes, streakRes] = await Promise.all([
      supabase.from('profiles').select('handle, display_name, age, favorite_team_ids').eq('id', userId).maybeSingle(),
      supabase.from('pp_wallet').select('current_balance, lifetime_earned').eq('user_id', userId).maybeSingle(),
      supabase.from('streak_state').select('current_streak_days').eq('user_id', userId).maybeSingle(),
    ]);

    return {
      handle: profileRes.data?.handle ?? null,
      displayName: profileRes.data?.display_name ?? null,
      age: profileRes.data?.age ?? null,
      points: walletRes.data?.current_balance ?? 0,
      lifetimePP: walletRes.data?.lifetime_earned ?? 0,
      streak: streakRes.data?.current_streak_days ?? 0,
      favoriteTeamIds: profileRes.data?.favorite_team_ids ?? [],
    };
  });

  // ── POST /me/pp/credit ───────────────────────────────────────────────────
  const CreditSchema = z.object({
    amount: z.number().int().positive().max(10_000),
    source: z.string().min(1).max(64),
  });
  server.post('/me/pp/credit', { preHandler: requireSupabaseAuth }, async (request, reply) => {
    const { userId, isGuest } = request as SupabaseAuthedRequest;
    if (isGuest) {
      // Guests don't earn server-side PP — local-only economy.
      await reply.code(403).send({ error: 'guests_cannot_credit_pp' });
      return;
    }
    const parsed = CreditSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_body' });
      return;
    }
    const { amount, source } = parsed.data;

    // Insert ledger row.
    const { error: ledgerErr } = await supabase.from('pp_events').insert({
      user_id: userId,
      bonus_amount: amount,
      source,
      activity_key: source,
    });
    if (ledgerErr) {
      request.log.error({ err: ledgerErr }, 'pp_events insert failed');
      await reply.code(500).send({ error: 'ledger_failed' });
      return;
    }

    // Upsert wallet — read-modify-write since Supabase JS doesn't expose a
    // single-call increment for non-RPC tables.
    const { data: existing } = await supabase
      .from('pp_wallet')
      .select('current_balance, lifetime_earned')
      .eq('user_id', userId)
      .maybeSingle();
    const newBalance = (existing?.current_balance ?? 0) + amount;
    const newLifetime = (existing?.lifetime_earned ?? 0) + amount;
    const { error: walletErr } = await supabase
      .from('pp_wallet')
      .upsert({
        user_id: userId,
        current_balance: newBalance,
        lifetime_earned: newLifetime,
      });
    if (walletErr) {
      request.log.error({ err: walletErr }, 'pp_wallet upsert failed');
      await reply.code(500).send({ error: 'wallet_failed' });
      return;
    }

    return { balance: newBalance };
  });

  // ── POST /me/sessions/heartbeat ──────────────────────────────────────────
  server.post('/me/sessions/heartbeat', { preHandler: requireSupabaseAuth }, async (request) => {
    const { userId, isGuest } = request as SupabaseAuthedRequest;
    if (isGuest) return { ok: true, guest: true };
    // Insert if no recent row, else update last_seen_at.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h
    const { data: recent } = await supabase
      .from('sessions')
      .select('id')
      .eq('user_id', userId)
      .gte('last_seen_at', since)
      .maybeSingle();
    if (recent?.id) {
      await supabase
        .from('sessions')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', recent.id);
    } else {
      await supabase.from('sessions').insert({
        user_id: userId,
        client_platform: 'mobile',
      });
    }
    return { ok: true };
  });

  // ── POST /me/trivia ──────────────────────────────────────────────────────
  const TriviaSchema = z.object({
    question_id: z.string().min(1).max(128),
    sport: z.string().min(1).max(16),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    is_correct: z.boolean(),
  });
  server.post('/me/trivia', { preHandler: requireSupabaseAuth }, async (request, reply) => {
    const { userId, isGuest } = request as SupabaseAuthedRequest;
    if (isGuest) {
      await reply.code(403).send({ error: 'guests_cannot_persist_trivia' });
      return;
    }
    const parsed = TriviaSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_body' });
      return;
    }
    const { question_id, sport, difficulty, is_correct } = parsed.data;

    // Insert attempt.
    await supabase.from('trivia_attempts').insert({
      user_id: userId,
      question_id,
      sport,
      difficulty,
      is_correct,
    });

    // Credit PP if correct.
    let pp_awarded = 0;
    let balance = 0;
    if (is_correct) {
      pp_awarded = PP_BY_DIFFICULTY[difficulty];
      await supabase.from('pp_events').insert({
        user_id: userId,
        bonus_amount: pp_awarded,
        source: `trivia_${difficulty}_correct`,
        activity_key: `trivia_${difficulty}_correct`,
        source_ref: `trivia:${question_id}`,
      });
      const { data: existing } = await supabase
        .from('pp_wallet')
        .select('current_balance, lifetime_earned')
        .eq('user_id', userId)
        .maybeSingle();
      balance = (existing?.current_balance ?? 0) + pp_awarded;
      const lifetime = (existing?.lifetime_earned ?? 0) + pp_awarded;
      await supabase.from('pp_wallet').upsert({
        user_id: userId,
        current_balance: balance,
        lifetime_earned: lifetime,
      });
    } else {
      const { data: existing } = await supabase
        .from('pp_wallet')
        .select('current_balance')
        .eq('user_id', userId)
        .maybeSingle();
      balance = existing?.current_balance ?? 0;
    }

    return { pp_awarded, balance };
  });

  // ── POST /me/cards/apply ─────────────────────────────────────────────────
  const CardApplySchema = z.object({
    card_id: z.string().min(1).max(128),
    template_id: z.string().min(1).max(64),
    player_id: z.string().min(1).max(64),
  });
  server.post('/me/cards/apply', { preHandler: requireSupabaseAuth }, async (request, reply) => {
    const { userId, isGuest } = request as SupabaseAuthedRequest;
    if (isGuest) {
      await reply.code(403).send({ error: 'guests_cannot_apply_cards' });
      return;
    }
    const parsed = CardApplySchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_body' });
      return;
    }
    const { card_id, template_id, player_id } = parsed.data;
    const { error } = await supabase.from('card_inventory').upsert(
      {
        user_id: userId,
        template_id,
        player_id,
        card_id,
      },
      { onConflict: 'user_id,template_id,player_id', ignoreDuplicates: false },
    );
    if (error) {
      request.log.error({ err: error }, 'card_inventory upsert failed');
      await reply.code(500).send({ error: 'apply_failed' });
      return;
    }
    return { ok: true };
  });
}
