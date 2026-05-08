/**
 * cardLock.ts — server-authoritative scout card availability.
 *
 * 2026-05-03 v4 — finite-use scout card pips (GDD §5b).
 *
 *   • Each scout card has MAX_ENERGY (3) pips representing its remaining
 *     deploys. A deploy = applying the scout card to a player on the
 *     roster. Every deploy decrements the pip count by 1.
 *   • When the pip count reaches 0 the scout card is EXHAUSTED —
 *     permanently spent. No recharge, no cooldown, no time-based logic.
 *   • Owning another copy of the same scout card gives an independent
 *     fresh pip counter; copies are tracked as separate rows in
 *     owned_scout_cards.
 *
 * The schema's `owned_scout_cards.energy` column (INT 0-3 default 3) IS
 * the pip counter. The `last_used_at` column is now analytics-only.
 *
 * Spec: data/economy/pgm_card_energy.json
 */

const MAX_ENERGY = 3;

/** Legacy aliases — kept for back-compat with imports that still expect a
 *  time-based constant. Set to 0 so any caller that still uses them in a
 *  computation falls into the "no cooldown" branch. */
export const RECHARGE_MS = 0;
export const COOLDOWN_MS = 0;
export { MAX_ENERGY };

export interface CardAvailability {
  available: boolean;
  /** Always null under v4 — there is no recharge end time. */
  cooldownEndsAt: Date | null;
  reason?: string;
}

/**
 * Returns deploy availability under the finite-use model.
 * @param _lastUsedAt   No longer consulted; retained for signature stability.
 * @param energy        Pips remaining on the scout card (0..MAX_ENERGY).
 */
export function isCardAvailable(
  _lastUsedAt: Date | null,
  energy: number,
): CardAvailability {
  if (energy > 0) {
    return { available: true, cooldownEndsAt: null };
  }
  return {
    available: false,
    cooldownEndsAt: null,
    reason: 'This scout card is exhausted — scan or earn another to deploy again.',
  };
}

/** True when the scout card has been used up (no pips remain). */
export function isCardRetired(energy: number): boolean {
  return Math.max(0, Math.min(MAX_ENERGY, energy)) === 0;
}

/** Pips remaining, clamped to [0, MAX_ENERGY]. */
export function pipsRemaining(energy: number): number {
  return Math.max(0, Math.min(MAX_ENERGY, energy));
}
