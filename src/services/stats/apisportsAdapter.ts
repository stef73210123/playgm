/**
 * apisportsAdapter.ts — StatsAdapter backed by API-Sports (api-sports.io).
 *
 * Per-league sub-API host:
 *   NFL  → v1.american-football.api-sports.io
 *   NBA  → v2.nba.api-sports.io
 *   MLB  → v1.baseball.api-sports.io
 *   NHL  → v2.hockey.api-sports.io
 *   MLS  → v3.football.api-sports.io  (MLS league id: 253)
 *
 * Auth: header `x-apisports-key: <API_SPORTS_KEY>`. The free tier is 100
 * requests / day per the api-sports.io account dashboard. The pull pipeline
 * is structured to fit a full NBA refresh in ~61 calls (1 teams + 30 rosters
 * with bio + 30 team-level stat aggregations).
 *
 * Schema notes that drive this file:
 *   /teams?league=standard
 *     → { response: [{ id, name, code, city, nbaFranchise, leagues:{standard:{conference, division}} }] }
 *     filter by `nbaFranchise: true` to drop summer-league + historical refs.
 *
 *   /players?team={id}&season={yr}
 *     → roster: [{ id, firstname, lastname, birth:{date,country},
 *                  height:{feets, inches=leftover},
 *                  weight:{pounds},
 *                  college, leagues:{standard:{jersey, active, pos}} }]
 *
 *   /players?id={id}
 *     → same shape, single row.
 *
 *   /players/statistics?team={id}&season={yr}
 *     → all per-game logs for every player on that team in that season.
 *     One call returns ~900-1000 rows for an NBA team. Aggregate to season
 *     averages client-side (see aggregateNbaSeason()).
 *
 *   /games?team={id}&season={yr}
 *     → schedule: [{ id, date:{start}, status:{long},
 *                    teams:{visitors:{id,code}, home:{id,code}},
 *                    scores:{visitors:{points}, home:{points}} }]
 *
 * NBA is the first league wired up. Other leagues throw a friendly
 * "not yet wired" error so a misconfigured per-sport flag fails loud rather
 * than silently returning empty data.
 */
import type {
  StatsAdapter,
  League,
  RosterEntry,
  SeasonStats,
  ScheduleEntry,
  BoxScore,
} from './types.js';

// ─── Host map + season translation ──────────────────────────────────────────

const HOST: Record<League, string> = {
  nfl: 'https://v1.american-football.api-sports.io',
  nba: 'https://v2.nba.api-sports.io',
  mlb: 'https://v1.baseball.api-sports.io',
  nhl: 'https://v2.hockey.api-sports.io',
  mls: 'https://v3.football.api-sports.io',
};

/** PlayGM season label → API-Sports `season` query param. */
function apiSportsSeason(league: League, label: string): string {
  // PlayGM keys NBA/NHL like "2025-26", others as the integer year.
  // API-Sports uses the start year as a single integer for NBA + NHL,
  // and the integer year for NFL + MLB + MLS.
  if (league === 'nba' || league === 'nhl') {
    const m = label.match(/^(\d{4})/);
    return m ? m[1] : label;
  }
  return label;
}

// ─── Quota tracking ─────────────────────────────────────────────────────────

interface QuotaState {
  used: number;
  /** Day-bucket. When the day rolls over we reset `used`. */
  day: string;
  /** Most recent observation from /status. May be undefined until first probe. */
  observedLimitDay?: number;
  /** Most recent observation from /status. */
  observedRemainingDay?: number;
  warned80?: boolean;
}

const quota: QuotaState = { used: 0, day: today() };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function bumpQuota(): void {
  if (quota.day !== today()) {
    quota.day = today();
    quota.used = 0;
    quota.warned80 = false;
  }
  quota.used += 1;
  if (quota.observedLimitDay) {
    const pct = quota.used / quota.observedLimitDay;
    if (pct >= 1) {
      throw new Error(
        `[apisports] daily quota exhausted (${quota.used}/${quota.observedLimitDay}). ` +
          `Falling back to cached data is the caller's responsibility.`,
      );
    }
    if (pct >= 0.8 && !quota.warned80) {
      quota.warned80 = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[apisports] approaching daily quota: ${quota.used}/${quota.observedLimitDay} (${Math.round(pct * 100)}%).`,
      );
    }
  }
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T> {
  const key = process.env.API_SPORTS_KEY;
  if (!key) {
    throw new Error('[apisports] API_SPORTS_KEY env var is not set.');
  }
  bumpQuota();
  // Try x-apisports-key first (api-sports.io direct keys); on 401 fall through
  // to x-rapidapi-key once. Most installs are direct.
  let r = await fetch(url, {
    headers: { 'x-apisports-key': key, 'User-Agent': 'PlayGM-Bot/1.0 (+stats-cache)' },
  });
  if (r.status === 401) {
    r = await fetch(url, {
      headers: { 'x-rapidapi-key': key, 'User-Agent': 'PlayGM-Bot/1.0 (+stats-cache)' },
    });
  }
  if (!r.ok) {
    throw new Error(`[apisports] HTTP ${r.status} ${url}`);
  }
  return r.json() as Promise<T>;
}

interface Envelope<T> {
  response: T;
  errors?: unknown;
  paging?: { current: number; total: number };
}

// ─── NBA types ──────────────────────────────────────────────────────────────

interface NbaTeam {
  id: number;
  name?: string;
  nickname?: string;
  code?: string;
  city?: string;
  nbaFranchise?: boolean;
  allStar?: boolean;
  leagues?: { standard?: { conference?: string; division?: string } };
}

interface NbaPlayer {
  id: number;
  firstname?: string;
  lastname?: string;
  birth?: { date?: string; country?: string };
  nba?: { start?: number; pro?: number };
  /** API returns strings here. `inches` is the leftover, NOT total inches. */
  height?: { feets?: string | null; inches?: string | null; meters?: string | null };
  weight?: { pounds?: string | null; kilograms?: string | null };
  college?: string | null;
  leagues?: { standard?: { jersey?: number | null; active?: boolean; pos?: string | null } };
}

interface NbaPlayerStatRow {
  player: { id: number; firstname?: string; lastname?: string };
  team: { id: number; code?: string; name?: string };
  game?: { id: number };
  points?: number;
  pos?: string;
  min?: string;
  fgm?: number;
  fga?: number;
  fgp?: string;
  ftm?: number;
  fta?: number;
  ftp?: string;
  tpm?: number;
  tpa?: number;
  tpp?: string;
  offReb?: number;
  defReb?: number;
  totReb?: number;
  assists?: number;
  pFouls?: number;
  steals?: number;
  turnovers?: number;
  blocks?: number;
  plusMinus?: string | number;
}

interface NbaGame {
  id: number;
  date?: { start?: string };
  status?: { long?: string; short?: number };
  teams?: { visitors?: NbaTeam; home?: NbaTeam };
  scores?: {
    visitors?: { points?: number; linescore?: string[] };
    home?: { points?: number; linescore?: string[] };
  };
}

// ─── NBA position classification (mirrors espnAdapter.classifyPositionGroup) ─

function classifyNbaPositionGroup(rawPos: string): string {
  const p = (rawPos || '').toUpperCase();
  if (['PG', 'SG', 'SF', 'PF', 'C'].includes(p)) return p;
  if (p === 'G') return 'SG';
  if (p === 'F') return 'SF';
  if (p === 'F-C' || p === 'C-F') return 'PF';
  if (p === 'G-F') return 'SG';
  return p || 'SF';
}

// ─── NBA helpers ────────────────────────────────────────────────────────────

function parseNbaHeightInches(h: NbaPlayer['height']): number | null {
  if (!h) return null;
  const f = Number(h.feets ?? 0);
  const i = Number(h.inches ?? 0);
  if (!Number.isFinite(f) || !Number.isFinite(i)) return null;
  if (f === 0 && i === 0) return null;
  return Math.round(f * 12 + i);
}

function parseNbaWeightLb(w: NbaPlayer['weight']): number | null {
  if (!w) return null;
  const lb = Number(w.pounds ?? 0);
  if (!Number.isFinite(lb) || lb === 0) return null;
  return lb;
}

function parseMin(min: string | undefined): number {
  // API returns "22" or "22:30" — strip seconds if present.
  if (!min) return 0;
  const head = min.split(':')[0];
  const n = Number(head);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Aggregate per-game log rows into season totals + averages keyed by player.
 * Output shape matches PlayGM's NBA cache: avg points/reb/ast/stl/blk/min,
 * fg_pct, ft_pct, three_pm, games_played.
 */
export function aggregateNbaSeason(
  rows: NbaPlayerStatRow[],
): Map<number, { gamesPlayed: number; stats: Record<string, number> }> {
  const byPlayer = new Map<number, { gp: number; sumPts: number; sumReb: number; sumAst: number; sumStl: number; sumBlk: number; sumTpm: number; sumMin: number; sumFgm: number; sumFga: number; sumFtm: number; sumFta: number }>();
  for (const row of rows) {
    const id = row.player?.id;
    if (!id) continue;
    // Skip DNPs / inactive entries: API often emits rows with min='0' and
    // every counting stat 0. Treat min === 0 as DNP.
    const mins = parseMin(row.min);
    if (mins === 0 && (row.points ?? 0) === 0 && (row.totReb ?? 0) === 0 && (row.assists ?? 0) === 0) {
      // DNP — don't count toward GP.
      continue;
    }
    let agg = byPlayer.get(id);
    if (!agg) {
      agg = { gp: 0, sumPts: 0, sumReb: 0, sumAst: 0, sumStl: 0, sumBlk: 0, sumTpm: 0, sumMin: 0, sumFgm: 0, sumFga: 0, sumFtm: 0, sumFta: 0 };
      byPlayer.set(id, agg);
    }
    agg.gp += 1;
    agg.sumPts += row.points ?? 0;
    agg.sumReb += row.totReb ?? 0;
    agg.sumAst += row.assists ?? 0;
    agg.sumStl += row.steals ?? 0;
    agg.sumBlk += row.blocks ?? 0;
    agg.sumTpm += row.tpm ?? 0;
    agg.sumMin += mins;
    agg.sumFgm += row.fgm ?? 0;
    agg.sumFga += row.fga ?? 0;
    agg.sumFtm += row.ftm ?? 0;
    agg.sumFta += row.fta ?? 0;
  }
  const out = new Map<number, { gamesPlayed: number; stats: Record<string, number> }>();
  for (const [id, agg] of byPlayer) {
    const gp = agg.gp;
    const stats: Record<string, number> = {
      games_played: gp,
      points: gp ? round(agg.sumPts / gp, 1) : 0,
      rebounds: gp ? round(agg.sumReb / gp, 1) : 0,
      assists: gp ? round(agg.sumAst / gp, 1) : 0,
      steals: gp ? round(agg.sumStl / gp, 1) : 0,
      blocks: gp ? round(agg.sumBlk / gp, 1) : 0,
      three_pm: gp ? round(agg.sumTpm / gp, 1) : 0,
      minutes: gp ? round(agg.sumMin / gp, 1) : 0,
      fg_pct: agg.sumFga ? round((agg.sumFgm / agg.sumFga) * 100, 1) : 0,
      ft_pct: agg.sumFta ? round((agg.sumFtm / agg.sumFta) * 100, 1) : 0,
      // Counter totals — kept alongside the per-game averages so
      // pull-stats-shared.mergePlayerStints() can sum across stints (mid-season
      // trades, two-way contracts) and recompute averages / rate stats without
      // rounding error. Existing readers ignore unknown keys, so this is
      // additive only.
      points_total:   agg.sumPts,
      rebounds_total: agg.sumReb,
      assists_total:  agg.sumAst,
      steals_total:   agg.sumStl,
      blocks_total:   agg.sumBlk,
      three_pm_total: agg.sumTpm,
      minutes_total:  agg.sumMin,
      fgm_total:      agg.sumFgm,
      fga_total:      agg.sumFga,
      ftm_total:      agg.sumFtm,
      fta_total:      agg.sumFta,
    };
    out.set(id, { gamesPlayed: gp, stats });
  }
  return out;
}

function round(n: number, d: number): number {
  const m = 10 ** d;
  return Math.round(n * m) / m;
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class ApiSportsAdapter implements StatsAdapter {
  readonly sourceName = 'apisports' as const;
  readonly isLicensedForCommercial = true;

  /**
   * Side-effect: probes /status to populate quota observation. Call once
   * before a long pull so the bumpQuota() warnings have a denominator.
   */
  async probeQuota(): Promise<{ limitDay: number; remainingDay: number; plan: string }> {
    // /status is the same shape across all sub-APIs but cheapest to hit on NBA.
    const r = await getJson<Envelope<{ subscription?: { plan?: string }; requests?: { current?: number; limit_day?: number } }>>(
      `${HOST.nba}/status`,
    );
    const limit = r.response?.requests?.limit_day ?? 100;
    const used = r.response?.requests?.current ?? 0;
    quota.observedLimitDay = limit;
    quota.observedRemainingDay = Math.max(0, limit - used);
    return { limitDay: limit, remainingDay: limit - used, plan: r.response?.subscription?.plan ?? 'unknown' };
  }

  async fetchLeagueRoster(league: League): Promise<RosterEntry[]> {
    if (league !== 'nba') {
      throw new Error(`[apisports] fetchLeagueRoster not yet wired for ${league} — only NBA is migrated.`);
    }
    return this.fetchNbaRoster();
  }

  private async fetchNbaRoster(): Promise<RosterEntry[]> {
    const teamsRes = await getJson<Envelope<NbaTeam[]>>(`${HOST.nba}/teams?league=standard`);
    const teams = (teamsRes.response ?? []).filter((t) => t.nbaFranchise && !t.allStar);

    const season = apiSportsSeason('nba', this.nbaSeasonLabel);
    const entries: RosterEntry[] = [];
    for (const t of teams) {
      try {
        const r = await getJson<Envelope<NbaPlayer[]>>(
          `${HOST.nba}/players?team=${t.id}&season=${season}`,
        );
        for (const p of r.response ?? []) {
          const rawPos = p.leagues?.standard?.pos ?? '';
          const fullName = `${p.firstname ?? ''} ${p.lastname ?? ''}`.trim();
          if (!fullName) continue;
          entries.push({
            id: `apisports:${p.id}`,
            name: fullName,
            firstName: p.firstname,
            lastName: p.lastname,
            team: t.name ?? t.nickname ?? '',
            teamAbbr: t.code ?? '',
            teamId: String(t.id),
            position: rawPos,
            positionGroup: classifyNbaPositionGroup(rawPos),
            jerseyNumber: p.leagues?.standard?.jersey ?? null,
            heightInches: parseNbaHeightInches(p.height),
            weightLb: parseNbaWeightLb(p.weight),
            dateOfBirth: p.birth?.date ?? null,
            hometown: p.birth?.country ?? null,
            yearsInLeague: p.nba?.pro ?? null,
            isActive: p.leagues?.standard?.active ?? true,
            // API-Sports doesn't surface team colors — pull-stats-shared
            // copies them from team_color_matrix downstream if missing.
            teamColorPrimary: undefined,
            teamColorSecondary: undefined,
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[apisports:nba] roster fetch failed for team ${t.id} (${t.code}): ${(err as Error).message}`);
      }
    }
    return entries;
  }

  /**
   * The pull pipeline calls fetchPlayerSeasonStats once per player. With
   * 100/day quota that's untenable — instead, the pull script should call
   * fetchTeamSeasonStats() once per team (30 calls total) and read from
   * its returned map. Implement fetchPlayerSeasonStats by warming the team
   * cache lazily.
   */
  async fetchPlayerSeasonStats(league: League, playerId: string): Promise<SeasonStats> {
    if (league !== 'nba') {
      throw new Error(`[apisports] fetchPlayerSeasonStats not yet wired for ${league}.`);
    }
    // Need teamId to do the bulk fetch. The id is `apisports:<num>` and the
    // pull script knows the team — but this entry point does not. Fall back
    // to the per-player game-log endpoint (rare path).
    const id = playerId.replace(/^apisports:/, '');
    const season = apiSportsSeason('nba', this.nbaSeasonLabel);
    const r = await getJson<Envelope<NbaPlayerStatRow[]>>(
      `${HOST.nba}/players/statistics?id=${id}&season=${season}`,
    );
    const agg = aggregateNbaSeason(r.response ?? []);
    const byPlayer = agg.get(Number(id));
    return {
      playerId,
      season,
      gamesPlayed: byPlayer?.gamesPlayed ?? 0,
      stats: byPlayer?.stats ?? {},
    };
  }

  /**
   * Bulk: pull every player's season stats for one team in a single API
   * call. Returns a Map keyed by `apisports:<playerId>`. Used by
   * pull-stats-shared via the optional `fetchTeamSeasonStats` capability.
   */
  async fetchTeamSeasonStats(
    league: League,
    teamId: string,
  ): Promise<Map<string, { gamesPlayed: number; stats: Record<string, number> }>> {
    if (league !== 'nba') {
      throw new Error(`[apisports] fetchTeamSeasonStats not yet wired for ${league}.`);
    }
    const season = apiSportsSeason('nba', this.nbaSeasonLabel);
    const r = await getJson<Envelope<NbaPlayerStatRow[]>>(
      `${HOST.nba}/players/statistics?team=${teamId}&season=${season}`,
    );
    const agg = aggregateNbaSeason(r.response ?? []);
    const out = new Map<string, { gamesPlayed: number; stats: Record<string, number> }>();
    for (const [id, v] of agg) {
      out.set(`apisports:${id}`, v);
    }
    return out;
  }

  /**
   * Mirror of EspnAdapter.fetchPlayerProjectedStats, included so
   * pull-stats-shared can call the same method on either adapter.
   * NBA's `positionGroup` is ignored (the same stat keys apply to all
   * positions); included for interface parity.
   */
  async fetchPlayerProjectedStats(
    league: League,
    playerId: string,
    _positionGroup: string,
  ): Promise<{ gamesPlayed: number; stats: Record<string, number> }> {
    const ss = await this.fetchPlayerSeasonStats(league, playerId);
    return { gamesPlayed: ss.gamesPlayed, stats: ss.stats };
  }

  async fetchTeamSchedule(league: League, teamId: string): Promise<ScheduleEntry[]> {
    if (league !== 'nba') {
      throw new Error(`[apisports] fetchTeamSchedule not yet wired for ${league}.`);
    }
    const season = apiSportsSeason('nba', this.nbaSeasonLabel);
    const r = await getJson<Envelope<NbaGame[]>>(
      `${HOST.nba}/games?team=${teamId}&season=${season}`,
    );
    const out: ScheduleEntry[] = [];
    for (const g of r.response ?? []) {
      out.push({
        gameId: String(g.id),
        date: g.date?.start ?? '',
        homeTeam: g.teams?.home?.code ?? '',
        awayTeam: g.teams?.visitors?.code ?? '',
        homeTeamId: g.teams?.home?.id != null ? String(g.teams.home.id) : undefined,
        awayTeamId: g.teams?.visitors?.id != null ? String(g.teams.visitors.id) : undefined,
        status: g.status?.long ?? 'unknown',
      });
    }
    return out;
  }

  async fetchGameBoxScore(league: League, gameId: string): Promise<BoxScore> {
    if (league !== 'nba') {
      throw new Error(`[apisports] fetchGameBoxScore not yet wired for ${league}.`);
    }
    const r = await getJson<Envelope<NbaPlayerStatRow[]>>(
      `${HOST.nba}/players/statistics?game=${gameId}`,
    );
    const players: BoxScore['players'] = [];
    for (const row of r.response ?? []) {
      if (!row.player?.id) continue;
      const stats: Record<string, number> = {
        points: row.points ?? 0,
        rebounds: row.totReb ?? 0,
        assists: row.assists ?? 0,
        steals: row.steals ?? 0,
        blocks: row.blocks ?? 0,
        three_pm: row.tpm ?? 0,
        fgm: row.fgm ?? 0,
        fga: row.fga ?? 0,
        ftm: row.ftm ?? 0,
        fta: row.fta ?? 0,
        minutes: parseMin(row.min),
      };
      players.push({ playerId: `apisports:${row.player.id}`, stats });
    }
    return { gameId, players };
  }

  /**
   * The PlayGM season label this adapter projects into. Settable so the
   * pull script can pass "2025-26" for NBA, "2024" for backfill, etc.
   * Defaults to current NBA cache key.
   */
  nbaSeasonLabel = '2025-26';
}

export const apisportsAdapter = new ApiSportsAdapter();
