/**
 * Weekly projection service.
 *
 * Computes `{ gamesCount, projectedPoints }` for a roster by id. The real
 * implementation will:
 *   1. Look up the roster's 8 drafted players.
 *   2. For each player's NHL/NBA/MLB/NFL/MLS team, query SportsDB v2's
 *      `getEventsNextLeague` (already in services/sportsdb.ts) to count
 *      scheduled games inside the current week (Mon → Sun UTC).
 *   3. Multiply each player's season-to-date PPG (from
 *      `pgm_stat_resolution.json` resolution rules) by their team's
 *      remaining games this week, then sum.
 *
 * Until the persistence layer for rosters lands, this stub returns a
 * deterministic plausible pair seeded by the roster id so the client UI
 * has stable values to render. A 1-hour TTL cache prevents redundant
 * recomputation across renders/polling.
 */

export interface WeeklyProjection {
  /** Total upcoming games scheduled this week across the roster's players' teams. */
  gamesCount: number;
  /** Sum of projected points across the roster's players, rounded to 1 decimal. */
  projectedPoints: number;
  /** ISO timestamp until which this value is cached. */
  cachedUntilIso: string;
}

/** TTL for cached projections — 1 hour matches the SportsDB schedule cadence. */
export const WEEKLY_PROJECTION_TTL_MS = 60 * 60 * 1000;

/**
 * Deterministic FNV-ish hash so the same roster id always produces the same
 * stub projection. Avoids importing crypto on the hot path; not security-
 * sensitive.
 */
function hashRosterId(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Plausible game count: 8 players × ~2 games/week each = 16, with ±8
 * variance based on the hash. Always ≥ 4 so empty-week edge cases don't
 * render "0 games" pessimistically.
 */
export function stubGamesCount(rosterId: string): number {
  const h = hashRosterId(rosterId);
  return 8 + (h % 17); // 8..24 inclusive
}

/**
 * Plausible projection: gamesCount × ~12 PPG average, with ±20% variance.
 * Returns a value rounded to 1 decimal. Heuristic mentioned in the spec —
 * "if a player averages 18 PPG and has 4 games, projected = 72."
 */
export function stubProjectedPoints(rosterId: string, games: number): number {
  const h = hashRosterId(rosterId);
  const avgPpg = 9 + ((h >> 8) % 12); // 9..20
  const raw = games * avgPpg;
  // Apply ±15% variance scaled by another hash slice.
  const variancePct = (((h >> 16) % 31) - 15) / 100;
  const value = raw * (1 + variancePct);
  return Math.round(value * 10) / 10;
}

interface CacheEntry {
  value: WeeklyProjection;
  expiresAt: number;
}

const projectionCache = new Map<string, CacheEntry>();

/** Test-only — purge the in-process cache. */
export function _clearWeeklyProjectionCache(): void {
  projectionCache.clear();
}

/**
 * Returns the projection for a roster id. Reads from cache when fresh;
 * recomputes and stores otherwise. The async signature keeps the door open
 * for the real SportsDB-backed implementation without churning callers.
 */
export async function computeWeeklyProjection(
  rosterId: string,
): Promise<WeeklyProjection> {
  const now = Date.now();
  const cached = projectionCache.get(rosterId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const games = stubGamesCount(rosterId);
  const points = stubProjectedPoints(rosterId, games);
  const value: WeeklyProjection = {
    gamesCount: games,
    projectedPoints: points,
    cachedUntilIso: new Date(now + WEEKLY_PROJECTION_TTL_MS).toISOString(),
  };
  projectionCache.set(rosterId, {
    value,
    expiresAt: now + WEEKLY_PROJECTION_TTL_MS,
  });
  return value;
}
