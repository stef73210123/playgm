/**
 * playerMatcher.ts — name-based player lookup across the stat-cache files.
 *
 * The card-scan flow extracts a player name (and optionally team / year /
 * sport) from the photo. This module turns that into a single canonical
 * player by:
 *
 *   1. Loading every `assets/stat-cache/{sport}_*.json` once at boot and
 *      indexing players by a normalized name key.
 *   2. Looking up the scanned name and disambiguating cross-sport collisions
 *      using the optional sport hint, then team if needed.
 *
 * We deliberately avoid fuzzy matching beyond the normalization step so
 * the granted scout card is always for the player the OCR was confident
 * about. Genuine ambiguity surfaces as a `multiple` result and the client
 * presents a small picker.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ─── Sport / league mapping ──────────────────────────────────────────────────
//
// The cardScanLLM Sport enum uses generic names ('basketball', ...) while
// the stat-cache filenames use league codes ('nba', ...). One-to-one map
// covers all five leagues PlayGM ships.
export const SPORT_TO_LEAGUE: Record<string, string> = {
  basketball: 'nba',
  baseball: 'mlb',
  football: 'nfl',
  hockey: 'nhl',
  soccer: 'mls',
};

export const LEAGUE_TO_SPORT: Record<string, string> = Object.fromEntries(
  Object.entries(SPORT_TO_LEAGUE).map(([s, l]) => [l, s]),
);

// ─── Public types ────────────────────────────────────────────────────────────

export interface IndexedPlayer {
  external_id: string;
  full_name: string;
  team: string | null;
  team_abbr: string | null;
  position: string | null;
  league: string;       // 'nba' | 'mlb' | 'nfl' | 'nhl' | 'mls'
  sport: string;        // 'basketball' | ...
}

export type MatchResult =
  | { kind: 'none' }
  | { kind: 'single'; player: IndexedPlayer }
  | { kind: 'multiple'; players: IndexedPlayer[] };

// ─── Normalization ──────────────────────────────────────────────────────────

/** Lowercase + strip everything except [a-z0-9]. Per the spec. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Index loader ───────────────────────────────────────────────────────────

interface RosterIndex {
  byNormalizedName: Map<string, IndexedPlayer[]>;
  builtAt: number;
  fileMtimes: Record<string, number>;
}

let _idx: RosterIndex | null = null;

function findStatCacheDir(): string {
  // Walk up from cwd or this file. Same pattern as the economy loader.
  const candidates = [
    path.resolve(process.cwd(), 'assets/stat-cache'),
    path.resolve(process.cwd(), '../assets/stat-cache'),
    path.resolve(process.cwd(), '../../assets/stat-cache'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`playerMatcher: could not locate assets/stat-cache (cwd=${process.cwd()})`);
}

function buildIndex(): RosterIndex {
  const dir = findStatCacheDir();
  const idx: RosterIndex = {
    byNormalizedName: new Map(),
    builtAt: Date.now(),
    fileMtimes: {},
  };

  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && /^(nba|mlb|nfl|nhl|mls)_/.test(f));
  for (const f of files) {
    const full = path.join(dir, f);
    const league = f.split('_')[0];
    const sport = LEAGUE_TO_SPORT[league] ?? league;
    let parsed: { players?: unknown[] };
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8')) as { players?: unknown[] };
    } catch {
      continue;
    }
    const players = Array.isArray(parsed.players) ? parsed.players : [];
    for (const raw of players) {
      const r = raw as Record<string, unknown>;
      const fullName = typeof r['full_name'] === 'string' ? (r['full_name'] as string) : null;
      if (!fullName) continue;
      const indexed: IndexedPlayer = {
        external_id: String(r['external_id'] ?? `${league}:${fullName}`),
        full_name: fullName,
        team: typeof r['team'] === 'string' ? (r['team'] as string) : null,
        team_abbr: typeof r['team_abbr'] === 'string' ? (r['team_abbr'] as string) : null,
        position: typeof r['position'] === 'string' ? (r['position'] as string) : null,
        league,
        sport,
      };
      const key = normalizeName(fullName);
      const bucket = idx.byNormalizedName.get(key) ?? [];
      bucket.push(indexed);
      idx.byNormalizedName.set(key, bucket);
    }
  }
  return idx;
}

function getIndex(): RosterIndex {
  if (!_idx) _idx = buildIndex();
  return _idx;
}

/** Test seam — drop the cached index and rebuild on next access. */
export function _resetMatcherForTests(): void {
  _idx = null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface MatchInput {
  player_name: string;
  /** OCR sport hint (e.g. 'basketball'). Used to disambiguate name collisions. */
  sport?: string | null;
  /** OCR team string (e.g. 'Lakers' or 'LAL'). Used as a final tiebreaker. */
  team?: string | null;
}

/**
 * Match a scanned player name against the roster index.
 *
 *   - `single` when exactly one player matches across all leagues, or when
 *     the sport/team hints narrow multiple matches down to one.
 *   - `multiple` when name collisions across sports remain after applying
 *     hints — the client shows a picker.
 *   - `none` when no player matches the normalized name at all.
 */
export function matchPlayer(input: MatchInput): MatchResult {
  const key = normalizeName(input.player_name);
  if (!key) return { kind: 'none' };
  const idx = getIndex();
  const candidates = idx.byNormalizedName.get(key);
  if (!candidates || candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'single', player: candidates[0] };

  // Disambiguate by sport hint first.
  let pool = candidates;
  if (input.sport) {
    const sportFiltered = pool.filter((p) => p.sport === input.sport);
    if (sportFiltered.length === 1) return { kind: 'single', player: sportFiltered[0] };
    if (sportFiltered.length > 0) pool = sportFiltered;
  }

  // Then by team string (case-insensitive substring on team or team_abbr).
  if (input.team) {
    const t = input.team.toLowerCase();
    const teamFiltered = pool.filter((p) => {
      return (
        (p.team && p.team.toLowerCase().includes(t)) ||
        (p.team_abbr && p.team_abbr.toLowerCase() === t)
      );
    });
    if (teamFiltered.length === 1) return { kind: 'single', player: teamFiltered[0] };
    if (teamFiltered.length > 0) pool = teamFiltered;
  }

  return { kind: 'multiple', players: pool };
}
