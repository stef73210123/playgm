/**
 * pull-stats-shared.ts — shared helpers for the per-league pull scripts.
 *
 * Mirrors the canonical NFL cache shape:
 *   { league, season, season_label, source, source_url_pattern, fetched_at,
 *     notes, totals: { teams, players, players_with_any_stat,
 *                      by_position_group: {...} },
 *     players: [ { external_id, full_name, ..., stats: {...} } ] }
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EspnAdapter } from '../services/stats/espnAdapter.js';
import { ApiSportsAdapter } from '../services/stats/apisportsAdapter.js';
import { getStatsAdapter } from '../services/stats/index.js';
import { supabase } from '../db/client.js';
import type { League, RosterEntry, StatsAdapter } from '../services/stats/types.js';

/**
 * Manager / coach position abbrevs that ESPN sometimes emits in roster blobs.
 * Matched case-insensitively against `position`. The list intentionally errs
 * on the wide side — adding "Asst" / "Asst." / "Coordinator" catches common
 * staff variants we don't want in the player tier files.
 */
const MANAGER_POSITION_TOKENS = new Set([
  'MGR',
  'HC',
  'OC',
  'DC',
  'STC',
  'AHC',
  'ASST',
  'ASST.',
  'COACH',
  'MANAGER',
  'HEAD COACH',
  'OFFENSIVE COORDINATOR',
  'DEFENSIVE COORDINATOR',
  'SPECIAL TEAMS COORDINATOR',
  'COORDINATOR',
]);

export function isManagerOrCoach(position: string | null | undefined): boolean {
  if (!position) return false;
  const norm = position.trim().toUpperCase();
  if (MANAGER_POSITION_TOKENS.has(norm)) return true;
  // Heuristic: any token containing 'COACH' or 'MANAGER' (e.g. "Pitching Coach",
  // "Bench Coach", "Bullpen Coach", "General Manager") is staff, not a player.
  if (/COACH|MANAGER/.test(norm)) return true;
  return false;
}

/**
 * True when the player has effectively zero stats — every numeric field is 0
 * (or the field is missing) AND games_played is 0/missing. Players with at
 * least one non-zero metric stay.
 */
export function hasOnlyZeroStats(stats: Record<string, number> | undefined | null): boolean {
  if (!stats) return true;
  const entries = Object.entries(stats);
  if (entries.length === 0) return true;
  const gp = stats['games_played'] ?? 0;
  if (gp > 0) return false;
  for (const [, v] of entries) {
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return false;
  }
  return true;
}

export interface FilterResult {
  kept: PlayerCacheEntry[];
  dropped_manager: number;
  dropped_zero_stat: number;
}

/** Apply the manager + zero-stat filter and report counts. */
export function applyCacheFilter(players: PlayerCacheEntry[]): FilterResult {
  const kept: PlayerCacheEntry[] = [];
  let dropped_manager = 0;
  let dropped_zero_stat = 0;
  for (const p of players) {
    if (isManagerOrCoach(p.position)) {
      dropped_manager++;
      continue;
    }
    if (hasOnlyZeroStats(p.stats)) {
      dropped_zero_stat++;
      continue;
    }
    kept.push(p);
  }
  return { kept, dropped_manager, dropped_zero_stat };
}

export interface PlayerCacheEntry {
  external_id: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  team: string;
  team_abbr: string;
  team_color_primary?: string;
  team_color_secondary?: string;
  position: string;
  position_group: string;
  jersey_number?: number | null;
  height_inches?: number | null;
  weight_lb?: number | null;
  date_of_birth?: string | null;
  hometown?: string | null;
  draft_year?: number | null;
  draft_round?: number | null;
  draft_pick_overall?: number | null;
  years_in_league?: number | null;
  is_active?: boolean;
  stats: Record<string, number>;
}

export interface SeasonCache {
  league: League;
  season: number | string;
  season_label: string;
  source: string;
  source_url_pattern: string;
  fetched_at: string;
  notes: string;
  totals: {
    teams: number;
    players: number;
    players_with_any_stat: number;
    by_position_group: Record<string, number>;
  };
  players: PlayerCacheEntry[];
}

const REPO_ROOT = path.resolve(process.cwd(), process.cwd().endsWith('/server') ? '..' : '.');

export function cachePath(filename: string): string {
  const dir = path.join(REPO_ROOT, 'assets', 'stat-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}

/** Atomic write: write to .tmp then rename. Idempotent. */
export function writeCacheAtomic(filePath: string, cache: SeasonCache): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

/** Convert a RosterEntry → cache base row (no stats yet). */
export function rosterToCacheBase(r: RosterEntry): PlayerCacheEntry {
  return {
    external_id: r.id,
    full_name: r.name,
    first_name: r.firstName,
    last_name: r.lastName,
    team: r.team,
    team_abbr: r.teamAbbr,
    team_color_primary: r.teamColorPrimary,
    team_color_secondary: r.teamColorSecondary,
    position: r.position,
    position_group: r.positionGroup,
    jersey_number: r.jerseyNumber ?? null,
    height_inches: r.heightInches ?? null,
    weight_lb: r.weightLb ?? null,
    date_of_birth: r.dateOfBirth ?? null,
    hometown: r.hometown ?? null,
    draft_year: null,
    draft_round: null,
    draft_pick_overall: null,
    years_in_league: r.yearsInLeague ?? null,
    is_active: r.isActive ?? true,
    stats: {},
  };
}

/**
 * Pull all rosters + per-player stats for a league.
 *
 * Concurrency: simple serial loop with a small per-call delay so we don't
 * hammer ESPN. ~5–10 minutes per league for the full pull.
 */
export async function pullLeague(
  league: League,
  opts: { season: string; seasonLabel: string; outFile: string; notes: string; minGamesPlayed?: number },
): Promise<SeasonCache> {
  const adapter: StatsAdapter = getStatsAdapter(league);
  const isEspn = adapter instanceof EspnAdapter;
  const isApiSports = adapter instanceof ApiSportsAdapter;
  // eslint-disable-next-line no-console
  console.log(`[pull:${league}] adapter=${adapter.sourceName} licensed=${adapter.isLicensedForCommercial}`);

  // API-Sports: tell the adapter the season label so its query strings match
  // the cache file. NBA pulls "2025-26" → adapter calls /...&season=2025.
  if (isApiSports && league === 'nba') {
    (adapter as ApiSportsAdapter).nbaSeasonLabel = opts.season;
  }

  // API-Sports: pre-warm a per-team stat cache so we make one /players/statistics
  // call per team rather than one per player. Saves ~95% of quota.
  let teamStatsCache: Map<string, Map<string, { gamesPlayed: number; stats: Record<string, number> }>> | null = null;
  if (isApiSports && league === 'nba') {
    teamStatsCache = new Map();
  }

  const minGP = opts.minGamesPlayed ?? 4;
  const roster = await adapter.fetchLeagueRoster(league);
  // eslint-disable-next-line no-console
  console.log(`[pull:${league}] roster ${roster.length} players across ${new Set(roster.map((r) => r.teamId)).size} teams`);

  const players: PlayerCacheEntry[] = [];
  let i = 0;
  for (const r of roster) {
    i++;
    const base = rosterToCacheBase(r);
    try {
      let projected: { gamesPlayed: number; stats: Record<string, number> };
      if (isApiSports && teamStatsCache && r.teamId) {
        // Bulk: one call per team, then look up by player id.
        let bucket = teamStatsCache.get(r.teamId);
        if (!bucket) {
          bucket = await (adapter as ApiSportsAdapter).fetchTeamSeasonStats(league, r.teamId);
          teamStatsCache.set(r.teamId, bucket);
        }
        projected = bucket.get(r.id) ?? { gamesPlayed: 0, stats: {} };
      } else if (isEspn) {
        projected = await (adapter as EspnAdapter).fetchPlayerProjectedStats(league, r.id, r.positionGroup);
      } else {
        const ss = await adapter.fetchPlayerSeasonStats(league, r.id);
        projected = { gamesPlayed: ss.gamesPlayed, stats: ss.stats };
      }
      base.stats = projected.stats;
      // Filter: include only if games_played >= minGP. Players with no stat
      // page (rookies, IR) end up with empty stats — keep them in roster but
      // mark with games_played: 0 so they're available for cache lookups.
      if (!base.stats.games_played || base.stats.games_played >= minGP || base.stats.games_played === 0) {
        players.push(base);
      } else {
        // Skip (low gp).
        continue;
      }
    } catch {
      // No stat page (rookie / no playing time). Keep the roster row with empty stats.
      players.push(base);
    }
    if (i % 50 === 0) {
      // eslint-disable-next-line no-console
      console.log(`[pull:${league}] ${i}/${roster.length}`);
    }
    // tiny delay — be polite to ESPN
    await new Promise((res) => setTimeout(res, 30));
  }

  // Apply manager + zero-stat filter at write time so the cache is clean
  // by construction. Counts surface in the notes string + totals.
  const before = players.length;
  const { kept, dropped_manager, dropped_zero_stat } = applyCacheFilter(players);
  // eslint-disable-next-line no-console
  console.log(
    `[pull:${league}] filter: kept ${kept.length}/${before}` +
      ` (-${dropped_manager} manager/coach, -${dropped_zero_stat} zero-stat)`,
  );

  const teamCount = new Set(kept.map((p) => p.team_abbr)).size;
  const playersWithAnyStat = kept.filter((p) => Object.keys(p.stats).length > 0).length;
  const byGroup: Record<string, number> = {};
  for (const p of kept) byGroup[p.position_group] = (byGroup[p.position_group] ?? 0) + 1;

  const filterNote =
    `Filter applied: dropped ${dropped_manager} manager/coach + ${dropped_zero_stat}` +
    ` zero-stat (kept ${kept.length}/${before}).`;
  const cache: SeasonCache = {
    league,
    season: opts.season,
    season_label: opts.seasonLabel,
    source: adapter.sourceName === 'espn'
      ? 'espn-public-api'
      : adapter.sourceName === 'apisports'
      ? 'api-sports.io'
      : adapter.sourceName,
    source_url_pattern: adapter.sourceName === 'espn'
      ? 'https://site.api.espn.com/... + https://sports.core.api.espn.com/...'
      : adapter.sourceName === 'apisports'
      ? 'https://v2.nba.api-sports.io/... (NBA), v1.american-football / v1.baseball / v2.hockey / v3.football for others'
      : '',
    fetched_at: new Date().toISOString(),
    notes: `${opts.notes} ${filterNote}`.trim(),
    totals: {
      teams: teamCount,
      players: kept.length,
      players_with_any_stat: playersWithAnyStat,
      by_position_group: byGroup,
    },
    players: kept,
  };
  writeCacheAtomic(opts.outFile, cache);
  // eslint-disable-next-line no-console
  console.log(`[pull:${league}] wrote ${kept.length} players → ${opts.outFile}`);

  // Best-effort dual write to Supabase player_stats. Never fails the pull.
  await dualWritePlayerStats(league, String(opts.season), kept);

  return cache;
}

/**
 * Best-effort upsert of the cleaned player set into Supabase `player_stats`.
 *
 * - Uses the service-role client from `db/client.ts`.
 * - Requires the v1 stats schema (player_stats(player_id, sport, season,
 *   stats_json, fetched_at) — see migrations/001_v1_schema.sql).
 * - Logs and returns on error; the JSON cache remains source of truth.
 */
export async function dualWritePlayerStats(
  league: League,
  season: string,
  players: PlayerCacheEntry[],
): Promise<void> {
  if (process.env.SKIP_SUPABASE_DUAL_WRITE === '1') {
    // eslint-disable-next-line no-console
    console.log('[supabase] dual-write skipped (SKIP_SUPABASE_DUAL_WRITE=1)');
    return;
  }
  if (players.length === 0) return;
  const fetched_at = new Date().toISOString();
  const rows = players.map((p) => ({
    player_id: p.external_id,
    sport: league,
    season,
    stats_json: p.stats,
    fetched_at,
  }));

  // Chunk to keep the request body reasonable (~1000 rows each).
  const CHUNK = 1000;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    try {
      const { error } = await supabase
        .from('player_stats')
        .upsert(slice, { onConflict: 'player_id,sport,season' });
      if (error) {
        // eslint-disable-next-line no-console
        console.error(`[supabase] upsert failed (chunk ${i}/${rows.length}):`, error.message);
        return;
      }
      upserted += slice.length;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[supabase] upsert threw:', e instanceof Error ? e.message : String(e));
      return;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[supabase] upserted ${upserted} rows into player_stats (${league} ${season})`);
}
