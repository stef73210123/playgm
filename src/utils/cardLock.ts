/**
 * cardLock.ts
 * 48-hour cooldown logic for Scout Cards.
 * Per GDD §3A: once used in a draft, a card enters a 48-hour cooldown.
 */

const COOLDOWN_MS = 48 * 60 * 60 * 1000; // 48 hours

export interface CardAvailability {
  available: boolean;
  cooldownEndsAt: Date | null;
  reason?: string;
}

export function isCardAvailable(
  lastUsedAt: Date | null,
  energy: number
): CardAvailability {
  if (energy <= 0) {
    return {
      available: false,
      cooldownEndsAt: null,
      reason: 'Card has no energy remaining.',
    };
  }

  if (lastUsedAt === null) {
    return { available: true, cooldownEndsAt: null };
  }

  const elapsed = Date.now() - lastUsedAt.getTime();

  if (elapsed < COOLDOWN_MS) {
    const cooldownEndsAt = new Date(lastUsedAt.getTime() + COOLDOWN_MS);
    return {
      available: false,
      cooldownEndsAt,
      reason: `Card is on cooldown until ${cooldownEndsAt.toISOString()}.`,
    };
  }

  return { available: true, cooldownEndsAt: null };
}
