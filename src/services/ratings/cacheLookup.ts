/**
 * cacheLookup.ts — find a player in any of the per-league JSON caches.
 *
 * Caches are loaded lazily and held in-memory for the process lifetime —
 * the refresh job (jobs/refreshStats.ts) clears the cache when it rewrites
 * the JSON files.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { League } from '../stats/types.js';
import type { PlayerCacheEntry, SeasonCache } from '../../scripts/pull-stats-shared.js';
import { supabase } from '../../db/client.js';

const REPO_ROOT = (() => {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(cur, 'assets', 'stat-cache'))) return cur;
    cur = path.resolve(cur, '..');
  }
  return process.cwd();
})();

const CACHE_FILES: Record<League, string> = {
  nfl: 'nfl_season_2025.json',
  nba: 'nba_season_2025-26.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

interface LoadedCache { mtime: number; data: SeasonCache }
const loaded: Partial<Record<League, LoadedCache>> = {};

function loadCache(league: League): SeasonCache | null {
  const f = path.join(REPO_ROOT, 'assets', 'stat-cache', CACHE_FILES[league]);
  if (!existsSync(f)) return null;
  const mtime = statSync(f).mtimeMs;
  const cached = loaded[league];
  if (cached && cached.mtime === mtime) return cached.data;
  try {
    const data = JSON.parse(readFileSync(f, 'utf-8')) as SeasonCache;
    loaded[league] = { mtime, data };
    return data;
  } catch {
    return null;
  }
}

export interface CacheLookup {
  league: League;
  player: PlayerCacheEntry;
}

export function findPlayer(playerId: string): CacheLookup | null {
  for (const league of Object.keys(CACHE_FILES) as League[]) {
    const c = loadCache(league);
    if (!c) continue;
    const p = c.players.find((p) => p.external_id === playerId);
    if (p) return { league, player: p };
  }
  return null;
}

export function getCacheCounts(): Record<League, { players: number; lastModified: string | null }> {
  const out = {} as Record<League, { players: number; lastModified: string | null }>;
  for (const league of Object.keys(CACHE_FILES) as League[]) {
    const f = path.join(REPO_ROOT, 'assets', 'stat-cache', CACHE_FILES[league]);
    if (!existsSync(f)) {
      out[league] = { players: 0, lastModified: null };
      continue;
    }
    const c = loadCache(league);
    out[league] = {
      players: c?.players.length ?? 0,
      lastModified: new Date(statSync(f).mtimeMs).toISOString(),
    };
  }
  return out;
}

/**
 * Per-league rating-tier distribution (counts of players in each tier).
 * Computed lazily.
 */
export function getAllPlayers(league: League): { players: PlayerCacheEntry[] } | null {
  const c = loadCache(league);
  if (!c) return null;
  return { players: c.players };
}

// ─── Name-keyed lookups (for clients that only carry SportsDB IDs) ──────────
//
// The mobile client routes through TheSportsDB for roster discovery and only
// has SportsDB IDs for players, while our stat caches are keyed on ESPN
// external_ids. The fallback path below normalizes a player's name + team
// into a stable key so the client can still pull stats / ratings.

function normalizeName(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[.,'’"`-]/g, '')         // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTeam(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Build name-keyed indexes once per cache load. Cache the index alongside the
// cache mtime so we don't rebuild on every request.
interface NameIndex {
  byNameTeam: Map<string, PlayerCacheEntry & { _league: League }>;
  byName: Map<string, Array<PlayerCacheEntry & { _league: League }>>;
}
const nameIndexes: Partial<Record<League, { mtime: number; idx: NameIndex }>> = {};

function buildNameIndex(league: League): NameIndex | null {
  const cached = loaded[league];
  const indexed = nameIndexes[league];
  if (!cached) return null;
  if (indexed && indexed.mtime === cached.mtime) return indexed.idx;

  const idx: NameIndex = { byNameTeam: new Map(), byName: new Map() };
  for (const p of cached.data.players) {
    const enriched = { ...p, _league: league };
    const k1 = `${normalizeName(p.full_name)}::${normalizeTeam(p.team)}`;
    idx.byNameTeam.set(k1, enriched);
    const k2 = normalizeName(p.full_name);
    if (!idx.byName.has(k2)) idx.byName.set(k2, []);
    idx.byName.get(k2)!.push(enriched);
  }
  nameIndexes[league] = { mtime: cached.mtime, idx };
  return idx;
}

/** Find a player by full name + (optional) team across all caches. */
export function findPlayerByName(
  fullName: string,
  team?: string,
): CacheLookup | null {
  const n = normalizeName(fullName);
  const t = normalizeTeam(team);
  if (!n) return null;
  for (const league of Object.keys(CACHE_FILES) as League[]) {
    if (!loadCache(league)) continue;
    const idx = buildNameIndex(league);
    if (!idx) continue;
    if (t) {
      const hit = idx.byNameTeam.get(`${n}::${t}`);
      if (hit) return { league, player: hit };
    }
    const arr = idx.byName.get(n);
    if (arr && arr.length > 0) return { league, player: arr[0] };
  }
  return null;
}

/** All players on a single team across all caches (case-insensitive). */
export function findPlayersByTeam(team: string): CacheLookup[] {
  const t = normalizeTeam(team);
  if (!t) return [];
  const out: CacheLookup[] = [];
  for (const league of Object.keys(CACHE_FILES) as League[]) {
    const c = loadCache(league);
    if (!c) continue;
    for (const p of c.players) {
      if (normalizeTeam(p.team) === t) out.push({ league, player: p });
    }
  }
  return out;
}

/**
 * Async, Supabase-aware sibling of findPlayersByTeam. Tries the local JSON
 * cache first (great for dev); on miss / empty result, queries the Supabase
 * `player_stats` table populated by dualWritePlayerStats. The Supabase
 * branch matches by `team` (case-insensitive substring), `team_abbr`
 * (case-insensitive equality), and `previous_teams` (case-insensitive
 * substring across array elements). Current-team rows rank ahead of
 * previous-team rows so a search for "Warriors" returns Steph + Draymond
 * (current Warriors) before Klay (former Warrior, now on Dallas).
 *
 * Response shape: each Supabase row is reconstructed into a
 * `PlayerCacheEntry`-compatible object so `buildResponse` in
 * routes/statLines.ts produces the same JSON it would for a JSON-cache hit.
 */
export async function findPlayersByTeamAsync(team: string): Promise<CacheLookup[]> {
  const localHits = findPlayersByTeam(team);
  if (localHits.length > 0) return localHits;
  return findPlayersByTeamSupabase(team);
}

/** Async sibling of findPlayer (Supabase fallback on cache miss). */
export async function findPlayerAsync(playerId: string): Promise<CacheLookup | null> {
  const local = findPlayer(playerId);
  if (local) return local;
  try {
    const { data, error } = await supabase
      .from('player_stats')
      .select('*')
      .eq('player_id', playerId)
      .order('fetched_at', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return supabaseRowToLookup(data[0] as SupabasePlayerStatsRow);
  } catch {
    return null;
  }
}

/**
 * Async sibling of findPlayerByName. The local cache path is the fast
 * path; the Supabase fallback uses `full_name` ILIKE + optional team
 * filter. Returns the first match.
 */
export async function findPlayerByNameAsync(
  fullName: string,
  team?: string,
): Promise<CacheLookup | null> {
  const local = findPlayerByName(fullName, team);
  if (local) return local;
  const n = fullName.trim();
  if (!n) return null;
  try {
    let q = supabase.from('player_stats').select('*').ilike('full_name', n);
    if (team && team.trim()) q = q.ilike('team', `%${team.trim()}%`);
    const { data, error } = await q.limit(1);
    if (error || !data || data.length === 0) return null;
    return supabaseRowToLookup(data[0] as SupabasePlayerStatsRow);
  } catch {
    return null;
  }
}

export function clearCacheLookups(): void {
  for (const k of Object.keys(loaded) as League[]) {
    delete loaded[k];
  }
}

// ─── Supabase team-search ───────────────────────────────────────────────────

/** Shape of a row coming back from `select * from player_stats`. */
interface SupabasePlayerStatsRow {
  player_id: string;
  sport: League;
  season: string;
  stats_json: Record<string, number>;
  fetched_at: string;
  team: string | null;
  team_abbr: string | null;
  previous_teams: string[] | null;
  full_name: string | null;
  position: string | null;
  position_group: string | null;
  jersey_number: number | null;
  bio_json: Record<string, unknown> | null;
}

function rowToCacheEntry(row: SupabasePlayerStatsRow): PlayerCacheEntry {
  const bio = row.bio_json ?? {};
  const num = (k: string): number | null => {
    const v = (bio as Record<string, unknown>)[k];
    return typeof v === 'number' ? v : null;
  };
  const str = (k: string): string | null => {
    const v = (bio as Record<string, unknown>)[k];
    return typeof v === 'string' ? v : null;
  };
  return {
    external_id: row.player_id,
    full_name: row.full_name ?? row.player_id,
    first_name: str('first_name') ?? undefined,
    last_name: str('last_name') ?? undefined,
    team: row.team ?? '',
    team_abbr: row.team_abbr ?? '',
    team_color_primary: str('team_color_primary') ?? undefined,
    team_color_secondary: str('team_color_secondary') ?? undefined,
    position: row.position ?? '',
    position_group: row.position_group ?? '',
    jersey_number: row.jersey_number ?? null,
    height_inches: num('height_inches'),
    weight_lb: num('weight_lb'),
    date_of_birth: str('date_of_birth'),
    hometown: str('hometown'),
    draft_year: num('draft_year'),
    draft_round: num('draft_round'),
    draft_pick_overall: num('draft_pick_overall'),
    years_in_league: num('years_in_league'),
    is_active: typeof (bio as Record<string, unknown>).is_active === 'boolean'
      ? Boolean((bio as Record<string, unknown>).is_active)
      : true,
    stats: row.stats_json ?? {},
  };
}

function supabaseRowToLookup(row: SupabasePlayerStatsRow): CacheLookup {
  return { league: row.sport, player: rowToCacheEntry(row) };
}

async function findPlayersByTeamSupabase(team: string): Promise<CacheLookup[]> {
  const search = team.trim();
  if (!search) return [];
  const ilikePat = `%${search}%`;
  // Two queries combined client-side:
  //  1. Current-team / abbreviation match — uses the lower(team) and
  //     lower(team_abbr) functional indexes from migration 011.
  //  2. Previous-team match — pulled via a coarse "has non-empty
  //     previous_teams" filter, then refined in code with a substring scan
  //     over the array elements. With ~600 NBA + ~750 MLB rows this is
  //     trivial; we revisit if the previous_teams histogram grows.
  let currentRows: SupabasePlayerStatsRow[] = [];
  let prevRowsRaw: SupabasePlayerStatsRow[] = [];
  try {
    const { data, error } = await supabase
      .from('player_stats')
      .select('*')
      .or(`team.ilike.${ilikePat},team_abbr.ilike.${search}`);
    if (!error && data) currentRows = data as SupabasePlayerStatsRow[];
  } catch { /* fall through — empty */ }
  try {
    const { data, error } = await supabase
      .from('player_stats')
      .select('*')
      .neq('previous_teams', '{}');
    if (!error && data) prevRowsRaw = data as SupabasePlayerStatsRow[];
  } catch { /* fall through — empty */ }

  const seen = new Set<string>(currentRows.map((r) => `${r.player_id}|${r.sport}|${r.season}`));
  const lowerSearch = search.toLowerCase();
  const prevRows = prevRowsRaw.filter((r) => {
    const k = `${r.player_id}|${r.sport}|${r.season}`;
    if (seen.has(k)) return false;
    const arr = r.previous_teams ?? [];
    return arr.some((p) => typeof p === 'string' && p.toLowerCase().includes(lowerSearch));
  });

  return [...currentRows, ...prevRows].map(supabaseRowToLookup);
}

// ─── Supabase-first read paths (best-effort) ────────────────────────────────
//
// The runtime prefers Supabase `player_stats` / `player_ratings` when the
// migration is applied AND the row exists. If the query errors or returns
// nothing, callers should fall back to the in-memory JSON cache below — see
// routes/players.ts for the wiring.

export interface SupabasePlayerStats {
  player_id: string;
  sport: League;
  season: string;
  stats_json: Record<string, number>;
  fetched_at: string;
}

export interface SupabasePlayerRating {
  player_id: string;
  sport: League;
  season: string;
  /** v2 13-grade letter (A+, A, … F). After the rename migration runs, the
   *  underlying column is `overall_grade`; v1 rows that haven't been
   *  recomputed yet still carry the old 5-tier name in `overall_tier`. */
  overall_grade: string;
  /** @deprecated v1 column name — kept on the type so legacy reads still work. */
  overall_tier?: string;
  breakdowns_json: unknown;
  computed_at: string;
}

/**
 * Try to load player stats from Supabase. Returns null on miss / error so the
 * caller can fall back to the JSON cache. The sport filter is optional — when
 * omitted the lookup keys on (player_id) and grabs the freshest row.
 */
export async function getPlayerStats(
  playerId: string,
  sport?: League,
): Promise<SupabasePlayerStats | null> {
  try {
    let q = supabase.from('player_stats').select('*').eq('player_id', playerId);
    if (sport) q = q.eq('sport', sport);
    const { data, error } = await q.order('fetched_at', { ascending: false }).limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0] as SupabasePlayerStats;
  } catch {
    return null;
  }
}

/** Same shape, but for the ratings table. */
export async function getPlayerRating(
  playerId: string,
  sport?: League,
): Promise<SupabasePlayerRating | null> {
  try {
    let q = supabase.from('player_ratings').select('*').eq('player_id', playerId);
    if (sport) q = q.eq('sport', sport);
    const { data, error } = await q.order('computed_at', { ascending: false }).limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0] as SupabasePlayerRating;
  } catch {
    return null;
  }
}
