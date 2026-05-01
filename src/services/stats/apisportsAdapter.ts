/**
 * apisportsAdapter.ts — STUB. API-Sports (v1.api-sports.io) commercial provider.
 *
 * To implement:
 *   - Read APISPORTS_KEY env var.
 *   - Per-league host:
 *       NFL  → v1.american-football.api-sports.io
 *       NBA  → v2.nba.api-sports.io
 *       MLB  → v1.baseball.api-sports.io
 *       NHL  → v1.hockey.api-sports.io
 *       MLS  → v3.football.api-sports.io
 *   - Map response shape to StatsAdapter contract.
 */
import type {
  StatsAdapter,
  League,
  RosterEntry,
  SeasonStats,
  ScheduleEntry,
  BoxScore,
} from './types.js';

export class ApiSportsAdapter implements StatsAdapter {
  readonly sourceName = 'apisports' as const;
  readonly isLicensedForCommercial = true;

  fetchLeagueRoster(_league: League): Promise<RosterEntry[]> {
    throw new Error('TODO: implement ApiSportsAdapter.fetchLeagueRoster');
  }
  fetchPlayerSeasonStats(_league: League, _playerId: string): Promise<SeasonStats> {
    throw new Error('TODO: implement ApiSportsAdapter.fetchPlayerSeasonStats');
  }
  fetchTeamSchedule(_league: League, _teamId: string): Promise<ScheduleEntry[]> {
    throw new Error('TODO: implement ApiSportsAdapter.fetchTeamSchedule');
  }
  fetchGameBoxScore(_league: League, _gameId: string): Promise<BoxScore> {
    throw new Error('TODO: implement ApiSportsAdapter.fetchGameBoxScore');
  }
}

export const apisportsAdapter = new ApiSportsAdapter();
