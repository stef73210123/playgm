/**
 * thesportsdbAdapter.ts — STUB. TheSportsDB v2 commercial provider.
 *
 * To implement:
 *   - Read SPORTSDB_V2_KEY (already used by `services/sportsdb.ts` for
 *     team/player lookups) and call the stat endpoints under
 *     thesportsdb.p.rapidapi.com or thesportsdb.com/api/v2.
 *   - Map league → competition id (NBA 4387 / NFL 4391 / MLB 4424 / NHL 4380 / MLS 4346).
 *   - Project response into the StatsAdapter shape.
 */
import type {
  StatsAdapter,
  League,
  RosterEntry,
  SeasonStats,
  ScheduleEntry,
  BoxScore,
} from './types.js';

export class TheSportsDbAdapter implements StatsAdapter {
  readonly sourceName = 'thesportsdb' as const;
  readonly isLicensedForCommercial = true;

  fetchLeagueRoster(_league: League): Promise<RosterEntry[]> {
    throw new Error('TODO: implement TheSportsDbAdapter.fetchLeagueRoster');
  }
  fetchPlayerSeasonStats(_league: League, _playerId: string): Promise<SeasonStats> {
    throw new Error('TODO: implement TheSportsDbAdapter.fetchPlayerSeasonStats');
  }
  fetchTeamSchedule(_league: League, _teamId: string): Promise<ScheduleEntry[]> {
    throw new Error('TODO: implement TheSportsDbAdapter.fetchTeamSchedule');
  }
  fetchGameBoxScore(_league: League, _gameId: string): Promise<BoxScore> {
    throw new Error('TODO: implement TheSportsDbAdapter.fetchGameBoxScore');
  }
}

export const thesportsdbAdapter = new TheSportsDbAdapter();
