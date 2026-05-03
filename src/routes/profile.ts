import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';
import { generateHandle } from '../utils/handleGenerator.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { resolveFeaturesForUser } from '../services/safetyResolver.js';
import { validateUserContent } from '../services/nicknameModeration.js';

const INITIAL_FREE_CARDS = 3;

export async function profileRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /profile
  fastify.get('/profile', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', profileId)
      .single();

    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(brandingFilter(data));
  });

  // GET /me/features
  // Effective per-user feature set — age-based safety matrix layered with
  // any per-user overrides from the dashboard. Cached 5 min per user
  // inside safetyResolver; override writes invalidate. The client uses
  // this as the single source of truth for what to render.
  fastify.get('/me/features', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    try {
      const set = await resolveFeaturesForUser(profileId);
      return reply.send({ ok: true, ...set });
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: err instanceof Error ? err.message : 'failed to resolve features',
      });
    }
  });

  // POST /profile/bootstrap
  fastify.post('/profile/bootstrap', async (_req, reply) => {
    const handle = await generateHandle();

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .insert({ handle })
      .select()
      .single();

    if (profileErr) return reply.code(500).send({ error: profileErr.message });

    // Grant 3 free common Scout Cards
    const cards = Array.from({ length: INITIAL_FREE_CARDS }, () => ({
      owner_id: (profile as { id: string }).id,
      rarity: 'common' as const,
      energy: 3,
    }));

    const { data: newCards, error: cardsErr } = await supabase
      .from('scout_cards')
      .insert(cards)
      .select();

    if (cardsErr) {
      fastify.log.warn(cardsErr, 'bootstrap: failed to insert initial cards');
    }

    return reply.code(201).send(brandingFilter({ profile, cards: newCards ?? [] }));
  });

  // PATCH /profile/initials
  const initialsSchema = z.object({ initials: z.string().length(2) });
  fastify.patch('/profile/initials', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = initialsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { data, error } = await supabase
      .from('profiles')
      .update({ initials: parsed.data.initials.toUpperCase() })
      .eq('id', profileId)
      .select()
      .single();

    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(brandingFilter(data));
  });

  // PATCH /profile/timezone
  const timezoneSchema = z.object({ timezone: z.string().min(1).max(64) });
  fastify.patch('/profile/timezone', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = timezoneSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { data, error } = await supabase
      .from('profiles')
      .update({ timezone: parsed.data.timezone })
      .eq('id', profileId)
      .select()
      .single();

    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(brandingFilter(data));
  });

  // POST /profile/display-name — kid-authored nickname (Bug — COPPA
  // moderation). Pipeline lives in services/nicknameModeration.ts;
  // we persist `display_name_status='approved'` only on success.
  // On rejection we still write the status='rejected' so the admin
  // moderation queue can pick it up for manual review.
  const displayNameSchema = z.object({ display_name: z.string().min(0).max(40) });
  fastify.post('/profile/display-name', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = displayNameSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    // Empty string clears the override → app falls back to username.
    if (parsed.data.display_name.trim() === '') {
      const { error } = await supabase
        .from('profiles')
        .update({ display_name: null, display_name_status: 'pending' })
        .eq('id', profileId);
      if (error) return reply.code(500).send({ error: error.message });
      return reply.send({ status: 'cleared', display_name: null });
    }

    // Pull age for the COPPA-stricter branch.
    const { data: profile, error: profErr } = await supabase
      .from('profiles')
      .select('age, birth_year')
      .eq('id', profileId)
      .single();
    if (profErr) return reply.code(500).send({ error: profErr.message });

    const age =
      (profile as { age?: number; birth_year?: number } | null)?.age ??
      (typeof (profile as { birth_year?: number } | null)?.birth_year === 'number'
        ? new Date().getFullYear() - ((profile as { birth_year: number }).birth_year)
        : null);

    const verdict = await validateUserContent({
      content: parsed.data.display_name,
      age,
      kind: 'display_name',
    });

    const status = verdict.ok ? 'approved' : 'rejected';
    const { error: updErr } = await supabase
      .from('profiles')
      .update({
        display_name: verdict.normalized,
        display_name_status: status,
      })
      .eq('id', profileId);
    if (updErr) return reply.code(500).send({ error: updErr.message });

    return reply.send({
      status,
      display_name: verdict.ok ? verdict.normalized : null,
      reason: verdict.ok ? undefined : verdict.reason,
      stage: verdict.stage,
    });
  });
}
