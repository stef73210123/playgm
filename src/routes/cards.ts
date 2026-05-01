import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';
import { isCardAvailable } from '../utils/cardLock.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { rollPack, type PityState } from '../economy/index.js';

/**
 * Legacy → v1 pack-id translation. The DB still stores `pack_type` strings
 * from the v0 schema (common / rare / epic / legendary / starter); the v1
 * spec keys packs by `pack_id` (rookie_pack / pro_pack / all_star_pack /
 * mvp_pack / goat_pack). When the DB migrates this map can be removed.
 *
 * TODO(spec card-system.md §3): drop this map once the play_packs schema
 * is migrated to use pack_id.
 */
const LEGACY_PACK_TYPE_TO_ID: Record<string, string> = {
  starter: 'rookie_pack',
  common: 'rookie_pack',
  rare: 'pro_pack',
  epic: 'all_star_pack',
  legendary: 'mvp_pack',
};

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

    // Use the v1 server-authoritative pack roller. Translate the legacy
    // `pack_type` string to a v1 `pack_id`, then call rollPack with the
    // user's current pity state. Pity state isn't yet persisted (table
    // not migrated), so for now we pass a zeroed counter — the roller
    // returns the would-be next state, which a future commit will save.
    const packType = (pack as Record<string, unknown>)['pack_type'] as string;
    const packId = LEGACY_PACK_TYPE_TO_ID[packType] ?? 'rookie_pack';
    const pityState: PityState = { packs_since_rare_plus: 0, cards_since_legendary: 0 };
    const rollResult = rollPack(packId, pityState);

    // Insert new cards. Card slot count now matches the pack spec.
    const cardInserts = rollResult.rarities.map((rarity) => ({
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
