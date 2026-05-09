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
import { EspnAdapter, outsToBaseballIp } from '../services/stats/espnAdapter.js';
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

// ─── Stat merge for traded / two-way players ────────────────────────────────
//
// API-Sports emits the same player on multiple rosters when they got traded
// mid-season (Klay Thompson, Pascal Siakam, Buddy Hield in 2024-25) or signed
// a two-way contract — once per stint. The previous dedup picked whichever
// row had more stat keys and dropped the other; that loses an entire stint
// of production. mergePlayerStints fixes this by:
//
//   1. Summing every counter total emitted by the adapter (gp, points_total,
//      fgm_total, … plus per-league counter keys for MLB pitcher / hitter).
//   2. Recomputing per-game averages from the summed totals.
//   3. Recomputing rate stats (fg_pct, ft_pct, era, obp, slg, avg) from the
//      summed counter pairs.
//   4. Picking the "current" team as the last stint in input order
//      (API-Sports iteration is roughly chronological; on tie we prefer the
//      stint with non-zero GP since a roster artifact for an unplayed team
//      sometimes shows up after the real current team).
//   5. Recording every other team in `previous_teams: string[]` (in
//      first-seen order, dedup'd, current team excluded).
//
// All counter / total keys are listed explicitly per league so we never sum
// a key whose semantics aren't summable (e.g. ERA, AVG). Anything not in
// the per-league counter set on the source row is preserved on the chosen
// "current" stint as-is — it'll get overwritten by the recompute step if
// it's a derived value.

interface MergeResult {
  player: PlayerCacheEntry;
  previous_teams: string[];
}

/** Counter keys that are safe to sum across stints, per league. */
const COUNTER_KEYS_BY_LEAGUE: Record<League, readonly string[]> = {
  nba: [
    'games_played',
    'points_total', 'rebounds_total', 'assists_total', 'steals_total',
    'blocks_total', 'three_pm_total', 'minutes_total',
    'fgm_total', 'fga_total', 'ftm_total', 'fta_total',
  ],
  mlb: [
    'games_played',
    // Pitcher
    'wins', 'losses', 'saves', 'k_pitcher',
    'outs_pitched', 'earned_runs', 'walks_allowed', 'hits_allowed',
    // Hitter
    'hits', 'hr', 'rbi', 'runs', 'sb',
    'at_bats', 'walks', 'hit_by_pitch', 'sac_flies', 'total_bases',
  ],
  nfl: [
    'games_played',
    'passing_yards', 'passing_touchdowns', 'interceptions',
    'rushing_yards', 'rushing_touchdowns',
    'receptions', 'receiving_yards', 'receiving_touchdowns', 'targets',
    'tackles', 'sacks', 'ints_def', 'fg_made',
  ],
  nhl: [
    'games_played',
    'goals', 'assists', 'sog', 'plus_minus', 'blocks', 'pim',
    'wins', 'shutouts', 'saves',
  ],
  mls: [
    'games_played',
    'goals', 'assists', 'shots', 'tackles', 'saves', 'clean_sheets',
  ],
};

/** Sum the listed counter keys across `stints` into a fresh stats record. */
function sumCounters(league: League, stints: PlayerCacheEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of COUNTER_KEYS_BY_LEAGUE[league]) {
    let total = 0;
    let any = false;
    for (const s of stints) {
      const v = s.stats?.[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        total += v;
        any = true;
      }
    }
    if (any) out[key] = total;
  }
  return out;
}

/** Round helper — mirrors apisportsAdapter.round. */
function roundN(n: number, d: number): number {
  const m = 10 ** d;
  return Math.round(n * m) / m;
}

/**
 * Recompute per-game averages and rate stats from summed counter totals.
 * Mutates `merged` in place — assumes `sumCounters` has already populated
 * the `*_total` keys (NBA) or the canonical counter keys (MLB / others).
 */
function recomputeDerived(league: League, merged: Record<string, number>): void {
  const gp = merged.games_played ?? 0;
  switch (league) {
    case 'nba': {
      if (gp > 0) {
        merged.points   = roundN((merged.points_total   ?? 0) / gp, 1);
        merged.rebounds = roundN((merged.rebounds_total ?? 0) / gp, 1);
        merged.assists  = roundN((merged.assists_total  ?? 0) / gp, 1);
        merged.steals   = roundN((merged.steals_total   ?? 0) / gp, 1);
        merged.blocks   = roundN((merged.blocks_total   ?? 0) / gp, 1);
        merged.three_pm = roundN((merged.three_pm_total ?? 0) / gp, 1);
        merged.minutes  = roundN((merged.minutes_total  ?? 0) / gp, 1);
      } else {
        merged.points = merged.rebounds = merged.assists = 0;
        merged.steals = merged.blocks = merged.three_pm = merged.minutes = 0;
      }
      const fga = merged.fga_total ?? 0;
      const fta = merged.fta_total ?? 0;
      merged.fg_pct = fga ? roundN(((merged.fgm_total ?? 0) / fga) * 100, 1) : 0;
      merged.ft_pct = fta ? roundN(((merged.ftm_total ?? 0) / fta) * 100, 1) : 0;
      break;
    }
    case 'mlb': {
      // Pitcher: ERA = ER * 9 / IP; convert outs back to baseball-format IP.
      if (typeof merged.outs_pitched === 'number') {
        merged.innings_pitched = roundN(outsToBaseballIp(merged.outs_pitched), 1);
        // True innings (decimal) for ERA / WHIP — outs/3.
        const trueInn = merged.outs_pitched / 3;
        merged.era = trueInn ? roundN(((merged.earned_runs ?? 0) * 9) / trueInn, 2) : 0;
        const baserunners = (merged.walks_allowed ?? 0) + (merged.hits_allowed ?? 0);
        merged.whip = trueInn ? roundN(baserunners / trueInn, 3) : 0;
      }
      // Hitter: avg = H/AB; obp = (H+BB+HBP)/(AB+BB+HBP+SF); slg = TB/AB.
      const ab = merged.at_bats ?? 0;
      if (ab > 0) {
        merged.avg = roundN((merged.hits ?? 0) / ab, 3);
        merged.slg = roundN((merged.total_bases ?? 0) / ab, 3);
        const obpDen = ab + (merged.walks ?? 0) + (merged.hit_by_pitch ?? 0) + (merged.sac_flies ?? 0);
        merged.obp = obpDen
          ? roundN(
              ((merged.hits ?? 0) + (merged.walks ?? 0) + (merged.hit_by_pitch ?? 0)) / obpDen,
              3,
            )
          : 0;
      }
      break;
    }
    // NFL / NHL / MLS counters are already raw season totals; no per-game
    // averaging step needed today. Add cases here when those leagues move
    // to per-game-emitting adapters.
    case 'nfl':
    case 'nhl':
    case 'mls':
      break;
  }
}

/** Pick the "current" stint and return the merged entry + previous_teams. */
export function mergePlayerStints(
  league: League,
  stints: PlayerCacheEntry[],
): MergeResult {
  if (stints.length === 1) {
    return { player: stints[0], previous_teams: [] };
  }
  // Heuristic: API-Sports iteration order is roughly chronological — the
  // last stint is usually the player's current team. If that last entry
  // has zero games played (a roster artifact for an upcoming team that
  // hasn't logged games yet), fall back to the highest-GP stint instead.
  let current = stints[stints.length - 1];
  if ((current.stats?.games_played ?? 0) === 0) {
    for (const s of stints) {
      if ((s.stats?.games_played ?? 0) > (current.stats?.games_played ?? 0)) {
        current = s;
      }
    }
  }
  const previous_teams: string[] = [];
  for (const s of stints) {
    if (s === current) continue;
    if (s.team && !previous_teams.includes(s.team) && s.team !== current.team) {
      previous_teams.push(s.team);
    }
  }
  // Build merged stats: start from current's bag, overwrite the summable
  // keys with the across-stints sums, then recompute per-game / rate stats
  // from those sums.
  const merged: Record<string, number> = { ...(current.stats ?? {}) };
  const summed = sumCounters(league, stints);
  Object.assign(merged, summed);
  recomputeDerived(league, merged);
  // The merged player keeps current's identity / bio; only stats are merged.
  // team_abbr stays current's; previous_teams flows through to the upsert.
  return {
    player: { ...current, stats: merged },
    previous_teams,
  };
}

/**
 * Best-effort upsert of the cleaned player set into Supabase `player_stats`.
 *
 * - Uses the service-role client from `db/client.ts`.
 * - Requires the v1 stats schema + the 011_previous_teams.sql additions
 *   (player_stats(player_id, sport, season, stats_json, fetched_at, team,
 *   team_abbr, previous_teams[], full_name, position, position_group,
 *   jersey_number, bio_json) — see migrations/011_previous_teams.sql).
 * - When a player appears in `players` more than once for the same season
 *   (mid-season trade, two-way contract), mergePlayerStints folds the
 *   stints into a single row with merged counter totals + recomputed
 *   averages and the prior teams listed in previous_teams[].
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

  // Group stints by (player_id, league, season). Preserve input order so
  // mergePlayerStints can apply its "last stint is current team" heuristic.
  const grouped = new Map<string, PlayerCacheEntry[]>();
  for (const p of players) {
    const key = `${p.external_id}|${league}|${season}`;
    let arr = grouped.get(key);
    if (!arr) {
      arr = [];
      grouped.set(key, arr);
    }
    arr.push(p);
  }

  let mergedCount = 0;
  const rows = Array.from(grouped.values()).map((stints) => {
    if (stints.length > 1) mergedCount++;
    const { player, previous_teams } = mergePlayerStints(league, stints);
    return {
      player_id: player.external_id,
      sport: league,
      season,
      stats_json: player.stats,
      fetched_at,
      // Top-level metadata for the team-search route. Indexed in 011.
      team: player.team,
      team_abbr: player.team_abbr,
      previous_teams,
      full_name: player.full_name,
      position: player.position,
      position_group: player.position_group,
      jersey_number: player.jersey_number ?? null,
      bio_json: {
        first_name:        player.first_name ?? null,
        last_name:         player.last_name ?? null,
        height_inches:     player.height_inches ?? null,
        weight_lb:         player.weight_lb ?? null,
        date_of_birth:     player.date_of_birth ?? null,
        hometown:          player.hometown ?? null,
        years_in_league:   player.years_in_league ?? null,
        draft_year:        player.draft_year ?? null,
        draft_round:       player.draft_round ?? null,
        draft_pick_overall: player.draft_pick_overall ?? null,
        is_active:         player.is_active ?? true,
        team_color_primary:   player.team_color_primary ?? null,
        team_color_secondary: player.team_color_secondary ?? null,
      },
    };
  });

  if (mergedCount > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[supabase] merged ${mergedCount} multi-stint player(s) into single rows ` +
        `(traded / two-way) before upsert.`,
    );
  }

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
