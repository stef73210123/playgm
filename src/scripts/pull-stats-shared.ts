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
import { getStatsAdapter } from '../services/stats/index.js';
import type { League, RosterEntry } from '../services/stats/types.js';

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
  const adapter = getStatsAdapter();
  const isEspn = adapter instanceof EspnAdapter;
  // eslint-disable-next-line no-console
  console.log(`[pull:${league}] adapter=${adapter.sourceName} licensed=${adapter.isLicensedForCommercial}`);

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
      if (isEspn) {
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

  const teamCount = new Set(players.map((p) => p.team_abbr)).size;
  const playersWithAnyStat = players.filter((p) => Object.keys(p.stats).length > 0).length;
  const byGroup: Record<string, number> = {};
  for (const p of players) byGroup[p.position_group] = (byGroup[p.position_group] ?? 0) + 1;

  const cache: SeasonCache = {
    league,
    season: opts.season,
    season_label: opts.seasonLabel,
    source: 'espn-public-api',
    source_url_pattern: 'https://site.api.espn.com/... + https://sports.core.api.espn.com/...',
    fetched_at: new Date().toISOString(),
    notes: opts.notes,
    totals: {
      teams: teamCount,
      players: players.length,
      players_with_any_stat: playersWithAnyStat,
      by_position_group: byGroup,
    },
    players,
  };
  writeCacheAtomic(opts.outFile, cache);
  // eslint-disable-next-line no-console
  console.log(`[pull:${league}] wrote ${players.length} players → ${opts.outFile}`);
  return cache;
}
