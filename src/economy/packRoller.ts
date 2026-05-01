/**
 * Server-authoritative pack roller (card-system.md §3, §8).
 *
 * Given a pack id and the user's current pity state, returns the list of
 * card rarities pulled (one per slot), an updated pity state, and an
 * optional bonus token. Card-template selection (which template inside the
 * rolled rarity) is handled separately by the caller — this module owns
 * the rarity roll only, so persistence layer can decide how to map rarity
 * → template based on player pool availability.
 *
 * Pity rules:
 *   - rare_plus pity (threshold 30 packs): when triggered, the next pack
 *     upgrades one common/uncommon slot to a Rare-or-higher.
 *   - legendary_pity (threshold 150 cards opened without Legendary): when
 *     triggered, the next pack's first Epic+ slot upgrades to Legendary.
 *
 * Both pity counters reset to 0 on the events spec'd in pgm_pity_timers.json.
 *
 * Pure / deterministic given a seeded RNG (`opts.rng`).
 */

import { getPackDef, listPityTimers } from './packs.js';
import type { PackDef, PackDropRates, PityState, Rarity } from './types.js';

const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export interface RollPackOptions {
  /** Deterministic RNG: returns [0,1). Math.random when omitted. */
  rng?: () => number;
}

export interface PackRollResult {
  pack_id: string;
  /** One rarity per card slot (length === pack.card_count). */
  rarities: Rarity[];
  /** True when the pack also granted a bonus token (per pack's bonus_token_chance). */
  bonus_token: boolean;
  /** Updated pity state after this pack was rolled. */
  next_pity_state: PityState;
  /** Diagnostics for tests + observability. Empty array on a vanilla pull. */
  pity_triggers: string[];
}

function rarityAtOrAbove(target: Rarity, candidate: Rarity): boolean {
  return RARITY_ORDER.indexOf(candidate) >= RARITY_ORDER.indexOf(target);
}

function isRarePlus(r: Rarity): boolean {
  return rarityAtOrAbove('rare', r);
}

function isEpicPlus(r: Rarity): boolean {
  return rarityAtOrAbove('epic', r);
}

function rollOne(rates: PackDropRates, rng: () => number): Rarity {
  const total =
    rates.common + rates.uncommon + rates.rare + rates.epic + rates.legendary;
  // Defensive — if rates sum to 0 we'd otherwise pin to 'common'.
  if (total <= 0) return 'common';
  let r = rng() * total;
  if ((r -= rates.common) <= 0) return 'common';
  if ((r -= rates.uncommon) <= 0) return 'uncommon';
  if ((r -= rates.rare) <= 0) return 'rare';
  if ((r -= rates.epic) <= 0) return 'epic';
  return 'legendary';
}

function clampToMin(rolled: Rarity, minimum: Rarity, rng: () => number): Rarity {
  if (rarityAtOrAbove(minimum, rolled)) return rolled;
  // Pull a uniform pick from {minimum, minimum+1, …, legendary}.
  const minIdx = RARITY_ORDER.indexOf(minimum);
  const idx = minIdx + Math.floor(rng() * (RARITY_ORDER.length - minIdx));
  return RARITY_ORDER[Math.min(idx, RARITY_ORDER.length - 1)] ?? minimum;
}

/**
 * Roll a pack server-authoritative.
 *
 * `userPityState` is the user's current pity counters BEFORE this pack;
 * the function returns the updated state in `next_pity_state`. Callers
 * persist that next state.
 */
export function rollPack(
  packId: string,
  userPityState: PityState,
  opts: RollPackOptions = {},
): PackRollResult {
  const pack: PackDef | null = getPackDef(packId);
  if (!pack) throw new Error(`packRoller: unknown pack_id "${packId}"`);
  const rng = opts.rng ?? Math.random;

  const timers = listPityTimers();
  const rarePlusTimer = timers.find((t) => t.id === 'rare_plus');
  const legendaryTimer = timers.find((t) => t.id === 'legendary_pity');
  const rarePlusThreshold = rarePlusTimer?.trigger_threshold ?? 30;
  const legendaryThreshold = legendaryTimer?.trigger_threshold ?? 150;

  // Will the rare_plus pity fire on this pack open?
  const rarePlusFires = userPityState.packs_since_rare_plus + 1 >= rarePlusThreshold;
  // Legendary pity fires when current "cards opened without legendary"
  // count + this pack's card_count would cross the threshold somewhere
  // in this pack. We use the pre-pack count for simplicity — more
  // conservative and matches the spec's "next Epic+ slot upgrades".
  const legendaryFires =
    userPityState.cards_since_legendary >= legendaryThreshold;

  const rarities: Rarity[] = [];
  const triggers: string[] = [];

  // First pass: roll each slot, applying guaranteed_slots minima.
  for (let i = 0; i < pack.card_count; i++) {
    let rolled = rollOne(pack.drop_rates, rng);
    const guarantee = pack.guaranteed_slots.find((g) => g.slot_index === i);
    if (guarantee) {
      const upgraded = clampToMin(rolled, guarantee.minimum_rarity, rng);
      if (upgraded !== rolled) triggers.push(`guaranteed_slot:${i}:${guarantee.minimum_rarity}`);
      rolled = upgraded;
    }
    rarities.push(rolled);
  }

  // Pity overrides — rare_plus first, then legendary (legendary trumps).
  if (rarePlusFires && !rarities.some(isRarePlus)) {
    // Upgrade the FIRST common/uncommon slot to a rare.
    const firstLow = rarities.findIndex((r) => !isRarePlus(r));
    if (firstLow >= 0) {
      rarities[firstLow] = 'rare';
      triggers.push('pity:rare_plus');
    }
  }

  if (legendaryFires && !rarities.includes('legendary')) {
    // Upgrade the first Epic+ slot to a Legendary; if none exists, upgrade
    // the highest-rarity slot.
    let target = rarities.findIndex(isEpicPlus);
    if (target < 0) {
      // pick highest non-legendary slot
      let best = 0;
      for (let i = 1; i < rarities.length; i++) {
        const a = RARITY_ORDER.indexOf(rarities[i]!);
        const b = RARITY_ORDER.indexOf(rarities[best]!);
        if (a > b) best = i;
      }
      target = best;
    }
    rarities[target] = 'legendary';
    triggers.push('pity:legendary');
  }

  // Bonus token roll (independent of card rolls).
  const bonusToken = pack.bonus_token_chance > 0 && rng() < pack.bonus_token_chance;

  // Update pity counters.
  const pulledAnyRarePlus = rarities.some(isRarePlus);
  const pulledAnyLegendary = rarities.some((r) => r === 'legendary');
  const next: PityState = {
    packs_since_rare_plus: pulledAnyRarePlus ? 0 : userPityState.packs_since_rare_plus + 1,
    cards_since_legendary: pulledAnyLegendary
      ? 0
      : userPityState.cards_since_legendary + rarities.length,
  };

  return {
    pack_id: pack.pack_id,
    rarities,
    bonus_token: bonusToken,
    next_pity_state: next,
    pity_triggers: triggers,
  };
}

/** Helper for callers that want to seed a deterministic RNG for tests. */
export function makeSeededRng(seed: number): () => number {
  // Mulberry32 — cheap, decent distribution, keeps pack tests reproducible.
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
