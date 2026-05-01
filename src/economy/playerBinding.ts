/**
 * Card-to-player binding (card-system.md §6).
 *
 * When a pack is opened, each rolled card is bound to a player from the
 * caller's currently-active rostered players. Binding rules:
 *
 *   - Random selection from the active player pool.
 *   - Rookies are weighted +50% (during their rookie season).
 *   - Sport diversity: when the pack supplies a `sport_diversity_min` ≥ 2,
 *     the binder guarantees at least that many distinct sports across the
 *     pack's cards (when the player pool covers enough sports).
 *
 * Pure / deterministic given a seeded RNG.
 */

export interface BindablePlayer {
  player_id: string;
  sport: string;
  is_rookie?: boolean;
}

export interface BindOptions {
  /** Number of cards to bind. Each card gets exactly one player. */
  cardCount: number;
  /** Sport-diversity guarantee from the pack spec (≥ 0). */
  sportDiversityMin?: number;
  /** Deterministic RNG: returns [0,1). Uses Math.random by default. */
  rng?: () => number;
}

const ROOKIE_WEIGHT = 1.5;

function weightedPick<T>(
  pool: T[],
  weight: (item: T) => number,
  rng: () => number,
): T {
  const total = pool.reduce((s, p) => s + weight(p), 0);
  if (total <= 0) return pool[0]!;
  let r = rng() * total;
  for (const item of pool) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return pool[pool.length - 1]!;
}

/**
 * Bind `cardCount` cards to players from `rosterPlayers`. Honors rookie
 * weighting and the sport-diversity guarantee. Returns one playerId per
 * card slot in order.
 *
 * Throws if `rosterPlayers` is empty — callers should check ownership
 * before binding.
 */
export function bindCardToPlayer(
  rosterPlayers: BindablePlayer[],
  opts: BindOptions,
): string[] {
  if (rosterPlayers.length === 0) {
    throw new Error('playerBinding: empty rosterPlayers');
  }
  const rng = opts.rng ?? Math.random;
  const cardCount = Math.max(0, opts.cardCount | 0);
  const wantSports = Math.min(
    opts.sportDiversityMin ?? 0,
    new Set(rosterPlayers.map((p) => p.sport)).size,
    cardCount,
  );

  const pickedSports = new Set<string>();
  const result: string[] = [];

  // First, satisfy the sport diversity guarantee. We walk the unique sports
  // available and pick one player from each, weighted by rookie status.
  if (wantSports > 0) {
    const sportsRemaining = new Set(rosterPlayers.map((p) => p.sport));
    while (pickedSports.size < wantSports && result.length < cardCount && sportsRemaining.size > 0) {
      const sportArr = [...sportsRemaining];
      const sport = sportArr[Math.floor(rng() * sportArr.length)] ?? sportArr[0];
      if (!sport) break;
      sportsRemaining.delete(sport);
      const candidates = rosterPlayers.filter((p) => p.sport === sport);
      const chosen = weightedPick(
        candidates,
        (p) => (p.is_rookie ? ROOKIE_WEIGHT : 1),
        rng,
      );
      result.push(chosen.player_id);
      pickedSports.add(sport);
    }
  }

  // Fill remaining slots from the full pool with rookie weighting.
  while (result.length < cardCount) {
    const chosen = weightedPick(
      rosterPlayers,
      (p) => (p.is_rookie ? ROOKIE_WEIGHT : 1),
      rng,
    );
    result.push(chosen.player_id);
  }

  return result;
}
