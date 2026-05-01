/**
 * Server-authoritative roster validation (card-system.md §5).
 *
 * Verifies the four constraints at roster lock:
 *   1. Energy budget: sum(energy_cost) ≤ 8
 *   2. Per-player limit: ≤ 2 cards per player
 *   3. Rarity caps per roster: ≤ 3 Rare, ≤ 1 Epic
 *   4. Cross-roster Legendary cap: ≤ 1 Legendary per user per week
 *
 * Constraint 4 needs caller-supplied context (already-placed Legendary
 * count this week from other rosters); the helper accepts the ledger so
 * it remains a pure function.
 */

import { getTemplate } from './cards.js';
import type { Rarity } from './types.js';

export const ROSTER_ENERGY_BUDGET = 8;
export const PER_PLAYER_CARD_CAP = 2;
export const PER_ROSTER_RARE_CAP = 3;
export const PER_ROSTER_EPIC_CAP = 1;
export const PER_USER_WEEKLY_LEGENDARY_CAP = 1;

export interface RosterCard {
  /** Power-up template id (e.g. "sb_rare_p15"). */
  template_id: string;
  /** The roster player this card is bound to. */
  player_id: string;
  /** Optional inventory id — used by callers but not checked here. */
  inventory_id?: string;
}

export interface ValidationContext {
  /** How many Legendary cards the user has already placed across OTHER
   *  rosters this scoring week. Cross-roster cap ≤ 1 (spec §5.4). */
  legendaryAlreadyPlacedThisWeek?: number;
}

export interface ValidationResult {
  ok: boolean;
  /**
   * Stable error codes consumers can localize. `ok: true` ⇒ empty.
   * - "ENERGY_BUDGET_EXCEEDED"
   * - "PER_PLAYER_CAP_EXCEEDED"
   * - "RARE_CAP_EXCEEDED"
   * - "EPIC_CAP_EXCEEDED"
   * - "WEEKLY_LEGENDARY_CAP_EXCEEDED"
   * - "UNKNOWN_TEMPLATE"
   */
  errors: { code: string; message: string }[];
  /** Computed totals callers can persist into roster_card_assignments. */
  totals: {
    energy_cost_total: number;
    rare_count: number;
    epic_count: number;
    legendary_count: number;
  };
}

/**
 * Validate a candidate roster (the array of cards the user is trying to
 * lock). The card list must already be resolved against the user's
 * inventory — `validateRoster` doesn't enforce ownership.
 */
export function validateRoster(
  rosterCards: RosterCard[],
  ctx: ValidationContext = {},
): ValidationResult {
  const errors: { code: string; message: string }[] = [];

  let energyTotal = 0;
  let rareCount = 0;
  let epicCount = 0;
  let legendaryCount = 0;
  const cardsPerPlayer = new Map<string, number>();

  for (const card of rosterCards) {
    const tpl = getTemplate(card.template_id);
    if (!tpl) {
      errors.push({
        code: 'UNKNOWN_TEMPLATE',
        message: `Unknown card template "${card.template_id}"`,
      });
      continue;
    }
    energyTotal += tpl.energy_cost;
    if (tpl.rarity === 'rare') rareCount++;
    else if (tpl.rarity === 'epic') epicCount++;
    else if (tpl.rarity === 'legendary') legendaryCount++;

    const prev = cardsPerPlayer.get(card.player_id) ?? 0;
    cardsPerPlayer.set(card.player_id, prev + 1);
  }

  if (energyTotal > ROSTER_ENERGY_BUDGET) {
    errors.push({
      code: 'ENERGY_BUDGET_EXCEEDED',
      message: `Energy total ${energyTotal} exceeds budget ${ROSTER_ENERGY_BUDGET}`,
    });
  }
  for (const [playerId, count] of cardsPerPlayer.entries()) {
    if (count > PER_PLAYER_CARD_CAP) {
      errors.push({
        code: 'PER_PLAYER_CAP_EXCEEDED',
        message: `Player ${playerId} has ${count} cards (cap ${PER_PLAYER_CARD_CAP})`,
      });
    }
  }
  if (rareCount > PER_ROSTER_RARE_CAP) {
    errors.push({
      code: 'RARE_CAP_EXCEEDED',
      message: `Rare count ${rareCount} exceeds cap ${PER_ROSTER_RARE_CAP}`,
    });
  }
  if (epicCount > PER_ROSTER_EPIC_CAP) {
    errors.push({
      code: 'EPIC_CAP_EXCEEDED',
      message: `Epic count ${epicCount} exceeds cap ${PER_ROSTER_EPIC_CAP}`,
    });
  }
  const placedLegendary = (ctx.legendaryAlreadyPlacedThisWeek ?? 0) + legendaryCount;
  if (placedLegendary > PER_USER_WEEKLY_LEGENDARY_CAP) {
    errors.push({
      code: 'WEEKLY_LEGENDARY_CAP_EXCEEDED',
      message:
        `User would have ${placedLegendary} Legendary cards placed this week ` +
        `(cap ${PER_USER_WEEKLY_LEGENDARY_CAP})`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    totals: {
      energy_cost_total: energyTotal,
      rare_count: rareCount,
      epic_count: epicCount,
      legendary_count: legendaryCount,
    },
  };
}

/** Re-export for callers building summaries. */
export type { Rarity };
