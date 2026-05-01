/**
 * Duplicate → shard conversion (card-system.md §6).
 *
 * Conversion ratios:
 *   5 Common Shards    → 1 random Common card
 *   5 Uncommon Shards  → 1 random Uncommon card
 *   4 Rare Shards      → 1 random Rare card
 *   3 Epic Shards      → 1 random Epic card
 *   3 Legendary Shards → 1 random Legendary card
 *
 * When a user opens a pack and pulls a (template_id × player_id) pair they
 * already own, the duplicate is converted to one shard of the matching
 * rarity. This module models the conversion side; the redemption side
 * (shards → new card) is left to a future endpoint and only the cost
 * table is exported here.
 */

import { listTemplatesByRarity } from './cards.js';
import type { CardTemplate, Rarity } from './types.js';

/** Per-rarity shard cost to redeem a new random card of that rarity. */
export const SHARD_REDEMPTION_COST: Record<Rarity, number> = {
  common: 5,
  uncommon: 5,
  rare: 4,
  epic: 3,
  legendary: 3,
};

export interface ShardConversionResult {
  rarity: Rarity;
  shards_granted: 1;
}

/**
 * Convert a duplicate card to shards. Always grants exactly 1 shard of the
 * card's rarity — the spec is one-shard-per-duplicate, multi-shard
 * windfalls aren't a thing in v1.
 */
export function convertDuplicateToShards(card: { rarity: Rarity }): ShardConversionResult {
  return { rarity: card.rarity, shards_granted: 1 };
}

/**
 * Pure helper for the shard-redeem flow. Picks a random template of the
 * target rarity using the supplied RNG. Throws if the catalog has no
 * templates at that rarity (shouldn't happen at runtime but is loud
 * during development).
 */
export function pickRandomTemplateForRarity(
  rarity: Rarity,
  rng: () => number = Math.random,
): CardTemplate {
  const candidates = listTemplatesByRarity(rarity);
  if (candidates.length === 0) {
    throw new Error(`shards: no templates of rarity "${rarity}" — spec drift?`);
  }
  const idx = Math.floor(rng() * candidates.length);
  return candidates[Math.min(idx, candidates.length - 1)]!;
}
