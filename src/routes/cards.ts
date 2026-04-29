import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';
import { isCardAvailable } from '../utils/cardLock.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

// Rarity drop weights for pack opening
const RARITY_WEIGHTS: Record<string, Record<string, number>> = {
  common:    { common: 70, rare: 20, epic: 8,  legendary: 2  },
  rare:      { common: 40, rare: 35, epic: 18, legendary: 7  },
  epic:      { common: 20, rare: 30, epic: 35, legendary: 15 },
  legendary: { common: 10, rare: 20, epic: 35, legendary: 35 },
  starter:   { common: 60, rare: 30, epic: 8,  legendary: 2  },
};

function rollRarity(packType: string): string {
  const weights = RARITY_WEIGHTS[packType] ?? RARITY_WEIGHTS['common']!;
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (const [rarity, weight] of Object.entries(weights)) {
    roll -= weight;
    if (roll <= 0) return rarity;
  }
  return 'common';
}

export async function cardsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /cards
  fastify.get('/cards', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const { data, error } = await supabase
      .from('scout_cards')
      .select('*')
      .eq('owner_id', profileId)
      .order('obtained_at', { ascending: false });

    if (error) return reply.code(500).send({ error: error.message });

    // Attach cooldown info to each card
    const withCooldown = (data ?? []).map((card: Record<string, unknown>) => ({
      ...card,
      cooldown: isCardAvailable(
        card['last_used_at'] ? new Date(card['last_used_at'] as string) : null,
        card['energy'] as number
      ),
    }));

    return reply.send(brandingFilter(withCooldown));
  });

  // POST /cards/open-pack
  const openPackSchema = z.object({ packId: z.string().uuid() });
  fastify.post('/cards/open-pack', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = openPackSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    // Verify pack ownership and that it hasn't been opened yet
    const { data: pack, error: packErr } = await supabase
      .from('play_packs')
      .select('*')
      .eq('id', parsed.data.packId)
      .eq('owner_id', profileId)
      .is('opened_at', null)
      .maybeSingle();

    if (packErr) return reply.code(500).send({ error: packErr.message });
    if (!pack) return reply.code(404).send({ error: 'Pack not found or already opened' });

    // Roll 3 cards
    const CARDS_PER_PACK = 3;
    const rollResults = Array.from({ length: CARDS_PER_PACK }, () =>
      rollRarity((pack as Record<string, unknown>)['pack_type'] as string)
    );

    // Insert new cards
    const cardInserts = rollResults.map((rarity) => ({
      owner_id: profileId,
      rarity,
      energy: 3,
    }));

    const { data: newCards, error: cardsErr } = await supabase
      .from('scout_cards')
      .insert(cardInserts)
      .select();

    if (cardsErr) return reply.code(500).send({ error: cardsErr.message });

    // Mark pack as opened
    await supabase
      .from('play_packs')
      .update({ opened_at: new Date().toISOString(), contents: newCards })
      .eq('id', parsed.data.packId);

    return reply.send(brandingFilter({ cards: newCards ?? [], packId: parsed.data.packId }));
  });
}
