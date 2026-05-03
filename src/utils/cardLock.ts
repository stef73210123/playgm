/**
 * cardLock.ts — server-authoritative card availability.
 *
 * 2026-05-03 — single-pip / 24h recharge model (GDD §5).
 * Each card has a single energy pip. Once spent, the card auto-recharges
 * back to MAX_ENERGY=1 after RECHARGE_MS has elapsed since lastUsedAt.
 * No separate "depleted vs cooldown" state — the two collapse into one
 * recharge window.
 *
 * Spec: data/economy/pgm_card_energy.json
 */

const RECHARGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENERGY = 1;

/** Backwards-compatible alias — older callers still import COOLDOWN_MS. */
export const COOLDOWN_MS = RECHARGE_MS;
export { RECHARGE_MS, MAX_ENERGY };

export interface CardAvailability {
  available: boolean;
  cooldownEndsAt: Date | null;
  reason?: string;
}

export function isCardAvailable(
  lastUsedAt: Date | null,
  energy: number
): CardAvailability {
  // Already at full charge → ready immediately, regardless of lastUsedAt.
  if (energy >= MAX_ENERGY) {
    return { available: true, cooldownEndsAt: null };
  }

  // Energy is 0 (or otherwise <1). If recharge timer has expired since
  // last use, treat as ready — the persisted energy field will be
  // reconciled to MAX_ENERGY on next write.
  if (lastUsedAt === null) {
    return { available: true, cooldownEndsAt: null };
  }

  const elapsed = Date.now() - lastUsedAt.getTime();

  if (elapsed >= RECHARGE_MS) {
    return { available: true, cooldownEndsAt: null };
  }

  const cooldownEndsAt = new Date(lastUsedAt.getTime() + RECHARGE_MS);
  return {
    available: false,
    cooldownEndsAt,
    reason: `Card recharging until ${cooldownEndsAt.toISOString()}.`,
  };
}
