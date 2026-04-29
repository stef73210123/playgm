import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';
import { isCardAvailable } from '../utils/cardLock.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

export async function draftRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /draft
  const createDraftSchema = z.object({
    cardId:     z.string().uuid(),
    entityId:   z.string().min(1),
  });

  fastify.post('/draft', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = createDraftSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { cardId, entityId } = parsed.data;

    // Fetch the card and verify ownership
    const { data: card, error: cardErr } = await supabase
      .from('scout_cards')
      .select('*')
      .eq('id', cardId)
      .eq('owner_id', profileId)
      .maybeSingle();

    if (cardErr) return reply.code(500).send({ error: cardErr.message });
    if (!card) return reply.code(404).send({ error: 'Card not found' });

    const cardData = card as Record<string, unknown>;

    // Check 48-hour cooldown
    const availability = isCardAvailable(
      cardData['last_used_at'] ? new Date(cardData['last_used_at'] as string) : null,
      cardData['energy'] as number
    );
    if (!availability.available) {
      return reply.code(409).send({
        error: availability.reason,
        cooldownEndsAt: availability.cooldownEndsAt,
      });
    }

    // Look up entity name from sports_master_data
    const { data: entity } = await supabase
      .from('sports_master_data')
      .select('name')
      .eq('external_id', entityId)
      .maybeSingle();

    const entityName = entity ? (entity as Record<string, unknown>)['name'] as string : entityId;

    // Create the draft
    const { data: draft, error: draftErr } = await supabase
      .from('active_drafts')
      .insert({
        user_id: profileId,
        card_id: cardId,
        entity_id: entityId,
        entity_name: entityName,
        status: 'LIVE',
      })
      .select()
      .single();

    if (draftErr) return reply.code(500).send({ error: draftErr.message });

    // Lock the card
    await supabase
      .from('scout_cards')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', cardId);

    return reply.code(201).send(brandingFilter(draft));
  });

  // GET /draft/active
  fastify.get('/draft/active', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const { data, error } = await supabase
      .from('active_drafts')
      .select('*')
      .eq('user_id', profileId)
      .in('status', ['PENDING', 'LIVE'])
      .order('created_at', { ascending: false });

    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(brandingFilter(data ?? []));
  });

  // GET /draft/history
  fastify.get('/draft/history', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const { data, error } = await supabase
      .from('active_drafts')
      .select('*')
      .eq('user_id', profileId)
      .in('status', ['COMPLETED', 'CANCELLED'])
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(brandingFilter(data ?? []));
  });
}
