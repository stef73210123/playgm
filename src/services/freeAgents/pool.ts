/**
 * services/freeAgents/pool.ts — deterministic per-roster, per-week
 * Free-Agent pool of 20 players.
 *
 * Why deterministic: the FA picker UX shows the same 20 candidates for
 * the entire week-of, so a kid can swap, undo, swap again without the
 * pool reshuffling under them. The pool rolls every Monday at 00:00
 * UTC (lined up with the weekly-draft event).
 *
 * Eligibility (matches the user-facing description):
 *   - Player is in the active league for the roster's sport.
 *   - Player is NOT currently on the kid's active 5 OR their bench
 *     (caller passes in the union via `excludePlayerIds`).
 *   - Player has stats available — i.e. they appear in our per-league
 *     stat cache. Players without stats can't be scored, so we never
 *     surface them as a swap target.
 *
 * Sort: overall_grade DESC (best FAs first). Ties broken by external_id
 * lexicographic so the order is fully reproducible from (seed, week).
 *
 * NOTE: this module is the single seam the routes layer calls. A test
 * can stub `getAllPlayers` via the cacheLookup module to keep itself
 * off-disk.
 */

import { createHash } from 'node:crypto';
import { getAllPlayers } from '../ratings/cacheLookup.js';
import { computeRating, GRADE_ORDER, type Grade } from '../ratings/computeRatings.js';
import type { League } from '../stats/types.js';
import type { PlayerCacheEntry } from '../../scripts/pull-stats-shared.js';

/** Cap on how many FAs a single pool exposes. */
export const FREE_AGENT_POOL_SIZE = 20;

/** A ranked free-agent candidate as the route returns it. */
export interface FreeAgent {
  player_id: string;
  full_name: string;
  team: string;
  team_abbr: string;
  position: string;
  position_group: string;
  sport: League;
  jersey_number: number | null;
  /** v2 13-grade letter (A+ … F). */
  overall_grade: Grade;
  /** Numeric score from computeRating — useful for fine-grained sorts. */
  score: number;
}

/** Inputs to generatePool. Pure function over these inputs. */
export interface PoolInput {
  /** The roster's sport (used to filter the league cache). */
  sport: League;
  /** Stable per-roster seed (rosters.roster_free_agent_seed in Supabase). */
  rosterSeed: string;
  /** ISO Monday-of-current-week (e.g. "2026-04-27"). */
  weekOf: string;
  /** Player ids on the kid's active 5 + bench — never surface these. */
  excludePlayerIds: string[];
  /** Override hook — tests pass a fixture instead of reading from disk. */
  source?: (league: League) => PlayerCacheEntry[] | null;
}

/** Cheap, stable 32-bit hash of a string. */
function hash32(s: string): number {
  // SHA-1 → first 4 bytes. Crypto-grade isn't required here; we want
  // something faster than re-implementing FNV but still stable across
  // Node versions.
  const buf = createHash('sha1').update(s).digest();
  return ((buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!) >>> 0;
}

/**
 * Generate the 20-player FA pool for one (roster, week) tuple. Pure: the
 * same inputs always return the same array (same order, same players).
 */
export function generatePool(input: PoolInput): FreeAgent[] {
  const { sport, rosterSeed, weekOf, excludePlayerIds } = input;
  const exclude = new Set(excludePlayerIds);

  const cache = (input.source ?? defaultSource)(sport);
  if (!cache) return [];

  // 1. Filter to eligible players.
  const eligible: Array<{ player: PlayerCacheEntry; rating: { grade: Grade; score: number } }> = [];
  for (const p of cache) {
    if (exclude.has(p.external_id)) continue;
    // Player must have at least one numeric stat to be scoreable.
    const stats = p.stats ?? {};
    const hasAnyStat = Object.values(stats).some(
      (v) => typeof v === 'number' && Number.isFinite(v) && v !== 0,
    );
    if (!hasAnyStat) continue;
    const r = computeRating({
      playerId: p.external_id,
      sport,
      position: p.position_group,
      stats,
    });
    if (!r) continue;
    eligible.push({
      player: p,
      rating: { grade: r.overall_grade, score: r.score },
    });
  }

  // 2. Rank by grade DESC, then score DESC, then external_id ASC. Pure.
  eligible.sort((a, b) => {
    const ga = GRADE_ORDER.indexOf(a.rating.grade);
    const gb = GRADE_ORDER.indexOf(b.rating.grade);
    if (ga !== gb) return ga - gb; // GRADE_ORDER is best→worst
    if (a.rating.score !== b.rating.score) return b.rating.score - a.rating.score;
    return a.player.external_id.localeCompare(b.player.external_id);
  });

  // 3. Carve a per-(seed, week) slice from the eligible pool. We can't
  //    just take the top 20 — every kid would see the same FAs. Instead
  //    we deterministically rotate the offset using a seed-derived hash
  //    so different rosters see different (but always-overlapping)
  //    slices, and the slice rotates each Monday for the same roster.
  if (eligible.length === 0) return [];

  const seed = `${rosterSeed}|${weekOf}`;
  const rotation = hash32(seed);

  // We always want the strongest FAs to surface, so the offset window
  // is bounded so the slice never wraps past the back of the eligible
  // list. Pool is the top-N of eligible where N is at most 60 (3x the
  // pool size) — that gives the rotation room without ever including
  // a clearly-worse player than the top 60.
  const HEAD_WIDTH = Math.min(eligible.length, FREE_AGENT_POOL_SIZE * 3);
  const head = eligible.slice(0, HEAD_WIDTH);
  if (head.length <= FREE_AGENT_POOL_SIZE) {
    // Few enough that rotation can't help — return all of them in
    // their canonical order so determinism still holds.
    return head.map(toWire);
  }
  const offset = rotation % head.length;
  const out: FreeAgent[] = [];
  for (let i = 0; i < FREE_AGENT_POOL_SIZE; i++) {
    out.push(toWire(head[(offset + i) % head.length]!));
  }
  // Re-sort the picked slice into grade-DESC order so the user sees the
  // best of their slice first regardless of the rotation offset. Rotation
  // determines WHICH 20 they see — not the order within.
  out.sort((a, b) => {
    const ga = GRADE_ORDER.indexOf(a.overall_grade);
    const gb = GRADE_ORDER.indexOf(b.overall_grade);
    if (ga !== gb) return ga - gb;
    if (a.score !== b.score) return b.score - a.score;
    return a.player_id.localeCompare(b.player_id);
  });
  return out;
}

function toWire(row: { player: PlayerCacheEntry; rating: { grade: Grade; score: number } }): FreeAgent {
  const { player, rating } = row;
  return {
    player_id: player.external_id,
    full_name: player.full_name,
    team: player.team,
    team_abbr: player.team_abbr,
    position: player.position,
    position_group: player.position_group,
    sport: detectSport(player) ?? 'nba',
    jersey_number: player.jersey_number ?? null,
    overall_grade: rating.grade,
    score: rating.score,
  };
}

/**
 * Best-effort sport tag. The cache file's filename encodes the league,
 * but the entry rows don't carry it; the caller passes `sport` in. This
 * helper is here only so toWire is self-contained for tests that pass a
 * fixture directly.
 */
function detectSport(_p: PlayerCacheEntry): League | null {
  return null;
}

/** Default source — reads the on-disk per-league cache. */
function defaultSource(league: League): PlayerCacheEntry[] | null {
  const c = getAllPlayers(league);
  return c?.players ?? null;
}
