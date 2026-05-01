/**
 * espnAdapter.ts — StatsAdapter backed by ESPN's public site/core APIs.
 *
 * WARNING: ESPN's site/core endpoints are NOT licensed for commercial use.
 * They are the right call for development + offline cache-build, but the
 * runtime should swap to a paid adapter (TheSportsDB v2, API-Sports,
 * Sportradar) before the app monetizes. `isLicensedForCommercial` is false
 * here, and the constructor logs a warning when NODE_ENV === 'production'.
 *
 * Endpoint shapes (per ESPN's public surface as of 2026-04):
 *
 *   Roster (list of teams + per-team athletes):
 *     site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams
 *     site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{teamId}/roster
 *
 *   Season stats per athlete:
 *     sports.core.api.espn.com/v2/sports/{sport}/leagues/{league}/seasons/{year}/types/2/athletes/{playerId}/statistics
 *     (types/2 = regular season; types/3 = postseason)
 *
 *   Schedule:
 *     site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{teamId}/schedule
 *
 *   Box score:
 *     site.api.espn.com/apis/site/v2/sports/{sport}/{league}/summary?event={gameId}
 *
 * Per-league sport/league path map:
 *   nfl → football/nfl
 *   nba → basketball/nba
 *   mlb → baseball/mlb
 *   nhl → hockey/nhl
 *   mls → soccer/usa.1
 */
import type {
  StatsAdapter,
  League,
  RosterEntry,
  SeasonStats,
  ScheduleEntry,
  BoxScore,
} from './types.js';

const SPORT_PATH: Record<League, string> = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  mlb: 'baseball/mlb',
  nhl: 'hockey/nhl',
  mls: 'soccer/usa.1',
};

const SEASON_BY_LEAGUE: Record<League, string> = {
  nfl: '2025',
  nba: '2026', // 2025-26 season — ESPN keys by ending year
  mlb: '2026',
  nhl: '2026', // 2025-26 season
  mls: '2026',
};

/** Keys ESPN uses for its `splits.categories[].stats[].name` blob.
 *  Each per-league SeasonStats reader picks the names it cares about. */
type EspnAthleteStats = {
  splits?: {
    categories?: Array<{
      name?: string;
      stats?: Array<{ name?: string; value?: number; displayValue?: string }>;
    }>;
  };
};

async function getJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { 'User-Agent': 'PlayGM-Bot/1.0 (+stats-cache)', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`ESPN HTTP ${r.status}: ${url}`);
  return r.json() as Promise<T>;
}

/**
 * Map an ESPN raw position abbrev → tier-file position group.
 * NFL: qb/rb/wr-te/defense/special/other (matches existing nfl_season_2025.json).
 * NBA: returns the position itself (PG/SG/SF/PF/C).
 * MLB: hitter / pitcher (the tier files are split this way).
 * NHL: skater / goalie.
 * MLS: fw / mf / df / gk.
 */
export function classifyPositionGroup(league: League, rawPos: string): string {
  const p = (rawPos || '').toUpperCase();
  switch (league) {
    case 'nfl': {
      if (p === 'QB') return 'qb';
      if (p === 'RB' || p === 'FB' || p === 'HB') return 'rb';
      if (p === 'WR' || p === 'TE') return 'wr-te';
      if (['DE', 'DT', 'LB', 'CB', 'DB', 'S', 'SS', 'FS', 'NT', 'EDGE', 'OLB', 'ILB', 'MLB'].includes(p)) return 'defense';
      if (['K', 'P', 'LS'].includes(p)) return 'special';
      return 'other';
    }
    case 'nba': {
      if (['PG', 'SG', 'SF', 'PF', 'C'].includes(p)) return p;
      // ESPN sometimes returns 'G', 'F', 'F-G'. Map to closest single position.
      if (p === 'G') return 'SG';
      if (p === 'F') return 'SF';
      if (p === 'F-C' || p === 'C-F') return 'PF';
      return p || 'SF';
    }
    case 'mlb': {
      if (p === 'P' || p === 'SP' || p === 'RP' || p === 'CP') return 'pitcher';
      return 'hitter';
    }
    case 'nhl': {
      if (p === 'G') return 'goalie';
      return 'skater';
    }
    case 'mls': {
      if (p === 'F' || p === 'FW' || p === 'ST') return 'fw';
      if (p === 'M' || p === 'MF') return 'mf';
      if (p === 'D' || p === 'DF') return 'df';
      if (p === 'G' || p === 'GK') return 'gk';
      return 'mf';
    }
  }
}

// ─── Per-league season stat extraction ──────────────────────────────────────
//
// ESPN groups stats under named categories ("passing", "rushing", "defense",
// "general", "offensive", "shooting", "batting", "pitching", "skating",
// "goaltending", etc.). We pull the keys we care about for each league.

function pickStat(blob: EspnAthleteStats, categoryName: string, statName: string): number | undefined {
  const cats = blob.splits?.categories ?? [];
  const cat = cats.find((c) => c.name === categoryName);
  if (!cat) return undefined;
  const stat = cat.stats?.find((s) => s.name === statName);
  return stat?.value;
}

function num(x: number | undefined): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function set(o: Record<string, number>, key: string, value: number | undefined) {
  if (value !== undefined) o[key] = value;
}

function extractStats(league: League, blob: EspnAthleteStats, positionGroup: string): Record<string, number> {
  const o: Record<string, number> = {};
  switch (league) {
    case 'nfl': {
      // Common stat: games_played in 'general'
      set(o, 'games_played', num(pickStat(blob, 'general', 'gamesPlayed')));
      // Passing
      set(o, 'passing_yards', num(pickStat(blob, 'passing', 'passingYards')));
      set(o, 'passing_touchdowns', num(pickStat(blob, 'passing', 'passingTouchdowns')));
      set(o, 'completion_percentage', num(pickStat(blob, 'passing', 'completionPct')));
      set(o, 'interceptions', num(pickStat(blob, 'passing', 'interceptions')));
      set(o, 'passer_rating', num(pickStat(blob, 'passing', 'QBRating')));
      // Rushing
      set(o, 'rushing_yards', num(pickStat(blob, 'rushing', 'rushingYards')));
      set(o, 'rushing_touchdowns', num(pickStat(blob, 'rushing', 'rushingTouchdowns')));
      set(o, 'yards_per_carry', num(pickStat(blob, 'rushing', 'yardsPerRushAttempt')));
      // Receiving
      set(o, 'receptions', num(pickStat(blob, 'receiving', 'receptions')));
      set(o, 'receiving_yards', num(pickStat(blob, 'receiving', 'receivingYards')));
      set(o, 'receiving_touchdowns', num(pickStat(blob, 'receiving', 'receivingTouchdowns')));
      set(o, 'targets', num(pickStat(blob, 'receiving', 'receivingTargets')));
      set(o, 'yards_per_reception', num(pickStat(blob, 'receiving', 'yardsPerReception')));
      // Defense
      set(o, 'tackles', num(pickStat(blob, 'defensive', 'totalTackles')));
      set(o, 'sacks', num(pickStat(blob, 'defensive', 'sacks')));
      set(o, 'ints_def', num(pickStat(blob, 'defensiveInterceptions', 'interceptions')));
      // Special
      if (positionGroup === 'special') {
        set(o, 'fg_made', num(pickStat(blob, 'kicking', 'fieldGoalsMade')));
        set(o, 'fg_pct', num(pickStat(blob, 'kicking', 'fieldGoalPct')));
      }
      return o;
    }
    case 'nba': {
      set(o, 'games_played', num(pickStat(blob, 'general', 'gamesPlayed')));
      set(o, 'points', num(pickStat(blob, 'offensive', 'avgPoints')));
      set(o, 'rebounds', num(pickStat(blob, 'general', 'avgRebounds')));
      set(o, 'assists', num(pickStat(blob, 'offensive', 'avgAssists')));
      set(o, 'steals', num(pickStat(blob, 'defensive', 'avgSteals')));
      set(o, 'blocks', num(pickStat(blob, 'defensive', 'avgBlocks')));
      set(o, 'three_pm', num(pickStat(blob, 'offensive', 'avgThreePointFieldGoalsMade')));
      set(o, 'fg_pct', num(pickStat(blob, 'offensive', 'fieldGoalPct')));
      set(o, 'ft_pct', num(pickStat(blob, 'offensive', 'freeThrowPct')));
      set(o, 'minutes', num(pickStat(blob, 'general', 'avgMinutes')));
      return o;
    }
    case 'mlb': {
      set(o, 'games_played', num(pickStat(blob, 'general', 'gamesPlayed')));
      if (positionGroup === 'pitcher') {
        set(o, 'wins', num(pickStat(blob, 'pitching', 'wins')));
        set(o, 'losses', num(pickStat(blob, 'pitching', 'losses')));
        set(o, 'era', num(pickStat(blob, 'pitching', 'ERA')));
        set(o, 'innings_pitched', num(pickStat(blob, 'pitching', 'innings')));
        set(o, 'k_pitcher', num(pickStat(blob, 'pitching', 'strikeouts')));
        set(o, 'whip', num(pickStat(blob, 'pitching', 'WHIP')));
        set(o, 'saves', num(pickStat(blob, 'pitching', 'saves')));
      } else {
        set(o, 'avg', num(pickStat(blob, 'batting', 'avg')));
        set(o, 'hits', num(pickStat(blob, 'batting', 'hits')));
        set(o, 'hr', num(pickStat(blob, 'batting', 'homeRuns')));
        set(o, 'rbi', num(pickStat(blob, 'batting', 'RBIs')));
        set(o, 'runs', num(pickStat(blob, 'batting', 'runs')));
        set(o, 'sb', num(pickStat(blob, 'batting', 'stolenBases')));
        set(o, 'obp', num(pickStat(blob, 'batting', 'onBasePct')));
        set(o, 'slg', num(pickStat(blob, 'batting', 'slugAvg')));
      }
      return o;
    }
    case 'nhl': {
      set(o, 'games_played', num(pickStat(blob, 'general', 'gamesPlayed')));
      if (positionGroup === 'goalie') {
        set(o, 'saves', num(pickStat(blob, 'goaltending', 'saves')));
        set(o, 'save_pct', num(pickStat(blob, 'goaltending', 'savePct')));
        set(o, 'gaa', num(pickStat(blob, 'goaltending', 'goalsAgainstAverage')));
        set(o, 'wins', num(pickStat(blob, 'goaltending', 'wins')));
        set(o, 'shutouts', num(pickStat(blob, 'goaltending', 'shutouts')));
      } else {
        set(o, 'goals', num(pickStat(blob, 'offensive', 'goals')));
        set(o, 'assists', num(pickStat(blob, 'offensive', 'assists')));
        set(o, 'sog', num(pickStat(blob, 'offensive', 'shotsTotal')));
        set(o, 'plus_minus', num(pickStat(blob, 'general', 'plusMinus')));
        set(o, 'blocks', num(pickStat(blob, 'defensive', 'blockedShots')));
        set(o, 'pim', num(pickStat(blob, 'penalties', 'penaltyMinutes')));
      }
      return o;
    }
    case 'mls': {
      set(o, 'games_played', num(pickStat(blob, 'general', 'appearances')));
      if (positionGroup === 'gk') {
        set(o, 'saves', num(pickStat(blob, 'goalKeeping', 'saves')));
        set(o, 'clean_sheets', num(pickStat(blob, 'goalKeeping', 'cleanSheet')));
      } else {
        set(o, 'goals', num(pickStat(blob, 'offensive', 'totalGoals')));
        set(o, 'assists', num(pickStat(blob, 'offensive', 'goalAssists')));
        set(o, 'shots', num(pickStat(blob, 'offensive', 'shotsTotal')));
        set(o, 'tackles', num(pickStat(blob, 'defensive', 'totalTackles')));
      }
      return o;
    }
  }
}

// ─── Adapter ────────────────────────────────────────────────────────────────

interface EspnTeamRef { id: string; abbreviation?: string; displayName?: string; color?: string; alternateColor?: string }
interface EspnTeamsResponse { sports: Array<{ leagues: Array<{ teams: Array<{ team: EspnTeamRef }> }> }> }
interface EspnRosterAthlete {
  id: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  jersey?: string;
  height?: number;
  weight?: number;
  dateOfBirth?: string;
  birthPlace?: { city?: string; state?: string; country?: string };
  experience?: { years?: number };
  active?: boolean;
  position?: { abbreviation?: string };
}
/**
 * ESPN's roster shape varies by sport:
 *
 *   Wrapped (NFL, MLB, NHL):
 *     { athletes: [{ position: 'offense', items: [athlete, ...] }, ...] }
 *
 *   Flat (NBA, MLS):
 *     { athletes: [athlete, athlete, ...] }
 *
 * `EspnRosterAthletesEntry` is the union — a wrapper or a bare athlete.
 */
type EspnRosterAthletesEntry =
  | { position?: string; items?: EspnRosterAthlete[] }
  | EspnRosterAthlete;

interface EspnRosterResponse {
  team?: EspnTeamRef;
  athletes?: EspnRosterAthletesEntry[];
}

/** True when an entry has an `items` array — i.e. ESPN's NFL/MLB/NHL shape. */
function isWrappedAthletesBlock(
  entry: EspnRosterAthletesEntry,
): entry is { position?: string; items?: EspnRosterAthlete[] } {
  return Array.isArray((entry as { items?: unknown }).items);
}

export class EspnAdapter implements StatsAdapter {
  readonly sourceName = 'espn' as const;
  readonly isLicensedForCommercial = false;

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        '[stats] EspnAdapter active in production — ESPN unofficial endpoints ' +
          'are NOT licensed for commercial use. Set STATS_PROVIDER to a paid ' +
          'provider before public release.',
      );
    }
  }

  async fetchLeagueRoster(league: League): Promise<RosterEntry[]> {
    const sportPath = SPORT_PATH[league];
    const teamsUrl = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams?limit=100`;
    const teamsRes = await getJson<EspnTeamsResponse>(teamsUrl);
    const teams = teamsRes.sports?.[0]?.leagues?.[0]?.teams ?? [];

    const entries: RosterEntry[] = [];
    for (const t of teams) {
      const teamRef = t.team;
      try {
        const rosterUrl = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams/${teamRef.id}/roster`;
        const r = await getJson<EspnRosterResponse>(rosterUrl);
        const blocks = r.athletes ?? [];
        // Flatten both shapes:
        //   wrapped → blocks[i].items[j]   (NFL/MLB/NHL)
        //   flat    → blocks[i] is the athlete itself  (NBA/MLS)
        const items: EspnRosterAthlete[] = [];
        for (const block of blocks) {
          if (isWrappedAthletesBlock(block)) {
            for (const a of block.items ?? []) items.push(a);
          } else if ((block as EspnRosterAthlete).id) {
            items.push(block as EspnRosterAthlete);
          }
        }
        for (const a of items) {
          const rawPos = a.position?.abbreviation ?? '';
          entries.push({
            id: `espn:${a.id}`,
            name: a.fullName ?? `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim(),
            firstName: a.firstName,
            lastName: a.lastName,
            team: teamRef.displayName ?? teamRef.abbreviation ?? '',
            teamAbbr: teamRef.abbreviation ?? '',
            teamId: teamRef.id,
            position: rawPos,
            positionGroup: classifyPositionGroup(league, rawPos),
            jerseyNumber: a.jersey ? Number(a.jersey) || null : null,
            heightInches: a.height ?? null,
            weightLb: a.weight ?? null,
            dateOfBirth: a.dateOfBirth ?? null,
            hometown: a.birthPlace
              ? [a.birthPlace.city, a.birthPlace.state, a.birthPlace.country].filter(Boolean).join(', ')
              : null,
            yearsInLeague: a.experience?.years ?? null,
            isActive: a.active ?? true,
            teamColorPrimary: teamRef.color ? `#${teamRef.color}` : undefined,
            teamColorSecondary: teamRef.alternateColor ? `#${teamRef.alternateColor}` : undefined,
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[stats] roster fetch failed for ${league} team ${teamRef.id}: ${(err as Error).message}`);
      }
    }
    return entries;
  }

  async fetchPlayerSeasonStats(league: League, playerId: string): Promise<SeasonStats> {
    const id = playerId.replace(/^espn:/, '');
    const sportPath = SPORT_PATH[league];
    const [sport, leagueSlug] = sportPath.split('/');
    const season = SEASON_BY_LEAGUE[league];
    const url = `https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${leagueSlug}/seasons/${season}/types/2/athletes/${id}/statistics`;
    const blob = await getJson<EspnAthleteStats>(url);
    // We don't yet know positionGroup here without a prior roster lookup. The
    // pull script knows it and re-projects via extractStats; expose both here.
    const stats: Record<string, number> = {};
    // Best-effort: try to read games_played via 'general' which is consistent
    // across leagues.
    const gp = num(pickStat(blob, 'general', 'gamesPlayed')) ?? num(pickStat(blob, 'general', 'appearances')) ?? 0;
    stats.games_played = gp;
    // Fold in every numeric stat under any category — extractStats can later
    // narrow this down for the cache file.
    for (const cat of blob.splits?.categories ?? []) {
      for (const s of cat.stats ?? []) {
        if (s.name && typeof s.value === 'number' && Number.isFinite(s.value)) {
          // Don't overwrite explicit games_played with a category-internal copy.
          if (s.name === 'gamesPlayed' && stats.games_played) continue;
          stats[`${cat.name ?? 'misc'}.${s.name}`] = s.value;
        }
      }
    }
    return {
      playerId,
      season,
      gamesPlayed: gp,
      stats,
    };
  }

  /**
   * Pull stats for a player and project them through the per-league
   * tier-aligned stat schema. Used by the pull scripts.
   */
  async fetchPlayerProjectedStats(
    league: League,
    playerId: string,
    positionGroup: string,
  ): Promise<{ gamesPlayed: number; stats: Record<string, number> }> {
    const id = playerId.replace(/^espn:/, '');
    const sportPath = SPORT_PATH[league];
    const [sport, leagueSlug] = sportPath.split('/');
    const season = SEASON_BY_LEAGUE[league];
    const url = `https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${leagueSlug}/seasons/${season}/types/2/athletes/${id}/statistics`;
    const blob = await getJson<EspnAthleteStats>(url);
    const stats = extractStats(league, blob, positionGroup);
    const gp = stats.games_played ?? 0;
    return { gamesPlayed: gp, stats };
  }

  async fetchTeamSchedule(league: League, teamId: string): Promise<ScheduleEntry[]> {
    const sportPath = SPORT_PATH[league];
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams/${teamId}/schedule`;
    interface SchedRes { events?: Array<{ id: string; date: string; competitions?: Array<{ competitors?: Array<{ team?: { id?: string; abbreviation?: string }; homeAway?: string }> }>; status?: { type?: { name?: string } } }> }
    const r = await getJson<SchedRes>(url);
    const out: ScheduleEntry[] = [];
    for (const ev of r.events ?? []) {
      const competitors = ev.competitions?.[0]?.competitors ?? [];
      const home = competitors.find((c) => c.homeAway === 'home');
      const away = competitors.find((c) => c.homeAway === 'away');
      out.push({
        gameId: ev.id,
        date: ev.date,
        homeTeam: home?.team?.abbreviation ?? '',
        awayTeam: away?.team?.abbreviation ?? '',
        homeTeamId: home?.team?.id,
        awayTeamId: away?.team?.id,
        status: ev.status?.type?.name ?? 'unknown',
      });
    }
    return out;
  }

  async fetchGameBoxScore(league: League, gameId: string): Promise<BoxScore> {
    const sportPath = SPORT_PATH[league];
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/summary?event=${gameId}`;
    interface SumRes {
      boxscore?: {
        players?: Array<{ statistics?: Array<{ athletes?: Array<{ athlete?: { id?: string }; stats?: string[]; statKeys?: string[] }> }> }>;
      };
    }
    const r = await getJson<SumRes>(url);
    const players: BoxScore['players'] = [];
    for (const team of r.boxscore?.players ?? []) {
      for (const cat of team.statistics ?? []) {
        for (const a of cat.athletes ?? []) {
          if (!a.athlete?.id) continue;
          const stats: Record<string, number> = {};
          const keys = cat.athletes?.[0]?.statKeys ?? [];
          (a.stats ?? []).forEach((v, i) => {
            const key = keys[i];
            const n = Number(v);
            if (key && Number.isFinite(n)) stats[key] = n;
          });
          players.push({ playerId: `espn:${a.athlete.id}`, stats });
        }
      }
    }
    return { gameId, players };
  }
}

export const espnAdapter = new EspnAdapter();
