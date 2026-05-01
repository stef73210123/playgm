/**
 * stats/types.ts — Multi-provider stats adapter contract.
 *
 * Designed so the runtime can swap from ESPN's unofficial endpoints (free,
 * NOT licensed for commercial use) to a paid commercial provider
 * (TheSportsDB v2, API-Sports, Sportradar) by changing ONE env var.
 *
 * Field shape mirrors the canonical NFL cache (`assets/stat-cache/nfl_season_2025.json`)
 * — the player row carries identity + a flat `stats: Record<string, number>` bag,
 * and the cache-level totals object summarizes counts per position group.
 */

export type League = 'nfl' | 'nba' | 'mlb' | 'nhl' | 'mls';

/**
 * Roster entry — one player on a team. Mirrors the per-player block in the
 * NFL cache minus the `stats: {}` bag (which `fetchPlayerSeasonStats` returns
 * separately).
 */
export interface RosterEntry {
  /** Stable cross-source id, prefixed with the source: 'espn:5084939'. */
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  team: string;
  teamAbbr: string;
  teamId?: string;
  /** Raw position string from the source (e.g. 'QB', 'PG', 'SP'). */
  position: string;
  /**
   * Coarser bucket used by the tier-band files. NFL examples:
   *   qb / rb / wr-te / defense / special / other.
   * NBA: PG/SG/SF/PF/C → mirrors `position` (1-to-1).
   * MLB: hitter / pitcher.
   * NHL: skater / goalie.
   * MLS: fw / mf / df / gk.
   */
  positionGroup: string;
  jerseyNumber?: number | null;
  heightInches?: number | null;
  weightLb?: number | null;
  dateOfBirth?: string | null;
  hometown?: string | null;
  yearsInLeague?: number | null;
  isActive?: boolean;
  teamColorPrimary?: string;
  teamColorSecondary?: string;
}

/**
 * Per-player season stat bag. `stats` is intentionally a flat
 * Record<string, number> so the same shape works across all 5 leagues —
 * the tier-band files identify which keys matter per position group.
 */
export interface SeasonStats {
  playerId: string;
  season: string;
  gamesPlayed: number;
  stats: Record<string, number>;
}

export interface ScheduleEntry {
  gameId: string;
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamId?: string;
  awayTeamId?: string;
  status: string;
}

export interface BoxScore {
  gameId: string;
  players: Array<{ playerId: string; stats: Record<string, number> }>;
}

export interface StatsAdapter {
  /** Pull the whole league roster (every team's active list) in one call. */
  fetchLeagueRoster(league: League): Promise<RosterEntry[]>;
  /** Single player season stats. */
  fetchPlayerSeasonStats(league: League, playerId: string): Promise<SeasonStats>;
  /** Team schedule (regular season). */
  fetchTeamSchedule(league: League, teamId: string): Promise<ScheduleEntry[]>;
  /** Per-game box score. */
  fetchGameBoxScore(league: League, gameId: string): Promise<BoxScore>;

  readonly sourceName: 'espn' | 'thesportsdb' | 'apisports' | 'sportradar';
  /**
   * False for ESPN's site/core APIs (unofficial, ToS-prohibited for paid
   * apps). True for paid providers. Surfaced so the runtime can refuse to
   * fetch in production unless this is true.
   */
  readonly isLicensedForCommercial: boolean;
}
