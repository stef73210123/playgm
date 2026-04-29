import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const VALID_PACK_TYPES = ['common', 'rare', 'epic', 'legendary', 'starter'] as const;
type PackType = (typeof VALID_PACK_TYPES)[number];

// Pack costs in play_points
const PACK_COSTS: Record<PackType, number> = {
  starter:   0,
  common:    200,
  rare:      500,
  epic:      1000,
  legendary: 2500,
};

export async function packsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /packs/gift
  const giftSchema = z.object({
    recipientHandle: z.string().min(1).max(40),
    packType: z.enum(VALID_PACK_TYPES),
  });

  fastify.post('/packs/gift', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = giftSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { recipientHandle, packType } = parsed.data;
    const cost = PACK_COSTS[packType];

    // Check sender has enough play_points
    const { data: sender } = await supabase
      .from('profiles')
      .select('play_points')
      .eq('id', profileId)
      .single();

    if (!sender) return reply.code(404).send({ error: 'Sender profile not found' });

    const senderData = sender as Record<string, unknown>;
    if ((senderData['play_points'] as number) < cost) {
      return reply.code(402).send({ error: `Not enough play_points. Need ${cost}.` });
    }

    // Look up recipient
    const { data: recipient } = await supabase
      .from('profiles')
      .select('id')
      .eq('handle', recipientHandle)
      .maybeSingle();

    if (!recipient) return reply.code(404).send({ error: 'Recipient not found' });

    const recipientData = recipient as Record<string, unknown>;

    // Deduct from sender
    await supabase
      .from('profiles')
      .update({ play_points: (senderData['play_points'] as number) - cost })
      .eq('id', profileId);

    // Create pack for recipient
    const { data: pack, error: packErr } = await supabase
      .from('play_packs')
      .insert({ owner_id: recipientData['id'], pack_type: packType })
      .select()
      .single();

    if (packErr) {
      // Refund on failure
      await supabase
        .from('profiles')
        .update({ play_points: (senderData['play_points'] as number) })
        .eq('id', profileId);
      return reply.code(500).send({ error: packErr.message });
    }

    return reply.code(201).send(
      brandingFilter({
        gifted: true,
        packId: (pack as Record<string, unknown>)['id'],
        recipientHandle,
        packType,
        pointsSpent: cost,
      })
    );
  });
}
