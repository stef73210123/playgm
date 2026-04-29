import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';
import { generateHandle } from '../utils/handleGenerator.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

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
}
