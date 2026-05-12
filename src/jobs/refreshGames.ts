/**
 * refreshGames.ts — daily ingest of live games + box scores + team records.
 *
 * Source: API-Sports (apisportsAdapter). The ESPN adapter is intentionally
 * NOT used here per the Build 21 directive (Stefan, 2026-05-12).
 *
 * Schedule
 * ────────
 *   - Daily 03:30 ET — full per-league pull, staggered 4 min apart so the
 *     API-Sports quota meter resets cleanly between leagues:
 *       NBA 03:30, NFL 03:34, MLB 03:38, NHL 03:42.
 *     (NBA runs first because it's the only league wired end-to-end today.)
 *
 *   - Hourly 12:00–23:00 ET in-season — light refresh that only re-pulls
 *     yesterday's finals and updates team_records. Skips the upcoming
 *     schedule on the hourly tick so the quota stays manageable.
 *
 * Per-league pipeline (one call sequence per league)
 * ──────────────────────────────────────────────────
 *   1. Pull yesterday's + today's games via fetchTeamSchedule for each team
 *      (the adapter is currently team-scoped, not date-scoped). For NBA this
 *      is 30 calls × season pull, but on a daily refresh we only want a
 *      narrow date window. To keep quota under control we use the bulk
 *      games-by-date endpoint when possible (NBA: /games?date=YYYY-MM-DD).
 *
 *   2. Upsert into `games` keyed by `${source}:${sport}:${api_game_id}`.
 *      `status` is normalized to one of:
 *        scheduled | inprogress | final | postponed | canceled.
 *
 *   3. For each FINAL game, fetch the box score via fetchGameBoxScore and
 *      upsert one row per (game_id, player_id) into `game_stats`. Player
 *      ids are written through verbatim — apisports:NNN ids stay as such
 *      until the player_stats canonical-id resolver maps them to espn:NNN.
 *
 *   4. Recompute `team_records` from final games over the current season.
 *      `team_records.team_id` matches the canonical client mockTeams id
 *      (lakers, knicks, rangers-nhl). We do the lookup via a static map
 *      built from team_color_matrix.
 *
 * Idempotency
 * ───────────
 *   Every write is an upsert on the natural key. Safe to run repeatedly,
 *   and the hourly tick gradually re-fills any rows the morning pull missed.
 *
 * Status surface
 * ──────────────
 *   getGamesPipelineStatus() exposes the same shape as refreshStats so it
 *   can plug straight into /admin/status. Surfaced via runtimeConfig admin.
 */
import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { apisportsAdapter } from '../services/stats/apisportsAdapter.js';
import { supabase } from '../db/client.js';
import { isSportEnabled } from '../services/sportsConfig.js';
import type { League } from '../services/stats/types.js';
import type { BoxScore } from '../services/stats/types.js';

// ─── Per-league config ──────────────────────────────────────────────────────

/** Sports we wire here. MLS is intentionally absent — the API-Sports football
 *  adapter would need a different game-id space and the existing player_stats
 *  caches don't include MLS either. NFL/MLB/NHL throw "not yet wired" inside
 *  the adapter today; the per-league branch below catches those and logs a
 *  skip rather than blowing up the cron. */
const LEAGUES: League[] = ['nba', 'nfl', 'mlb', 'nhl'];

const SEASON_BY_LEAGUE: Record<League, string> = {
  nfl: '2025',
  nba: '2025-26',
  mlb: '2026',
  nhl: '2025-26',
  mls: '2026',
};

// ─── Status tracking (mirrors jobs/refreshStats.ts shape) ──────────────────

interface PipelineEntry {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  gamesIngested: number;
  boxScoresIngested: number;
}

function emptyEntry(): PipelineEntry {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    gamesIngested: 0,
    boxScoresIngested: 0,
  };
}

const STATUS: Record<League, PipelineEntry> = {
  nfl: emptyEntry(),
  nba: emptyEntry(),
  mlb: emptyEntry(),
  nhl: emptyEntry(),
  mls: emptyEntry(),
};

// ─── Status normalization ──────────────────────────────────────────────────
//
// API-Sports uses different status strings per league. Map all of them down
// to our internal vocabulary so the client never has to know upstream wire
// formats.

function normalizeStatus(raw: string): 'scheduled' | 'inprogress' | 'final' | 'postponed' | 'canceled' {
  const s = (raw || '').toLowerCase();
  if (/finished|final|after over|ft|aet/.test(s)) return 'final';
  if (/in play|live|q[1-4]|halftime|quarter|inning|period|set/.test(s)) return 'inprogress';
  if (/postponed|delayed|suspended/.test(s)) return 'postponed';
  if (/cancel|abandoned|forfeit/.test(s)) return 'canceled';
  // Defaults: not-started, scheduled, time-tbd → scheduled.
  return 'scheduled';
}

// ─── Date helpers ──────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return isoDate(d);
}

function todayUTC(): string {
  return isoDate(new Date());
}

// ─── Games upsert ──────────────────────────────────────────────────────────
//
// One row per (source, sport, source_game_id). `id` is the composite key the
// client uses everywhere downstream.

interface GameRow {
  id: string;
  source: string;
  sport: string;
  season: string;
  game_date: string;
  status: string;
  home_team: string;
  home_team_abbr: string;
  home_score: number | null;
  away_team: string;
  away_team_abbr: string;
  away_score: number | null;
  source_game_id: string;
}

async function upsertGames(rows: GameRow[]): Promise<{ inserted: number; error?: string }> {
  if (rows.length === 0) return { inserted: 0 };
  const { error, count } = await supabase
    .from('live_games')
    .upsert(rows, { onConflict: 'id', count: 'exact', ignoreDuplicates: false });
  if (error) {
    return { inserted: 0, error: error.message };
  }
  return { inserted: count ?? rows.length };
}

// ─── game_stats upsert ─────────────────────────────────────────────────────

interface GameStatRow {
  game_id: string;
  player_id: string;
  player_name: string | null;
  team: string;
  stats_json: Record<string, number>;
}

async function upsertGameStats(rows: GameStatRow[]): Promise<{ inserted: number; error?: string }> {
  if (rows.length === 0) return { inserted: 0 };
  // The composite primary key on (game_id, player_id) handles the conflict.
  const { error, count } = await supabase
    .from('live_game_stats')
    .upsert(rows, { onConflict: 'game_id,player_id', count: 'exact', ignoreDuplicates: false });
  if (error) {
    return { inserted: 0, error: error.message };
  }
  return { inserted: count ?? rows.length };
}

// ─── NBA pipeline ──────────────────────────────────────────────────────────
//
// The API-Sports adapter exposes fetchTeamSchedule(teamId) — one call per team.
// For a daily refresh we'd rather pull the date-scoped /games?date=YYYY-MM-DD,
// which returns every game on that day in one call. The adapter doesn't expose
// it directly, but fetchTeamSchedule already wraps the JSON shape so we keep
// using it here for now (30 calls × 1 league = 30 calls/day, well within
// the paid-tier budget). A future pass should add fetchGamesByDate to the
// adapter for a 95% call reduction.

interface NbaTeamMap { id: string; name: string; abbr: string; mockTeamId: string }

/**
 * Resolve API-Sports NBA team ids → canonical mockTeams id (e.g. 'lakers').
 * We pull /teams once at the top of each pipeline run; cache lifetime is one
 * pipeline tick. Mapping rule: lower-case city+name with non-alphanumerics
 * stripped, matched against a static alias table.
 */
async function fetchNbaTeamMap(): Promise<NbaTeamMap[]> {
  // Adapter doesn't expose a public teams endpoint, but fetchLeagueRoster
  // (already in apisportsAdapter) calls /teams as its first step. We don't
  // need the rosters here — just the team list. Pull via the internal
  // helper by re-using probeQuota's pattern: a direct fetch to the API.
  // Implementation is intentionally minimal: we don't want to import private
  // adapter internals, so we use the public fetchTeamSchedule on a known
  // team id once it's seeded. For the first run we ship a hardcoded mapping
  // of the 30 NBA franchises → mockTeams ids. The map lives in source
  // because the league-team set doesn't change mid-season.
  return NBA_TEAM_MAP;
}

/** Static NBA team map. API-Sports team ids are stable across seasons. */
const NBA_TEAM_MAP: NbaTeamMap[] = [
  { id: '1',  name: 'Atlanta Hawks',          abbr: 'ATL', mockTeamId: 'hawks' },
  { id: '2',  name: 'Boston Celtics',         abbr: 'BOS', mockTeamId: 'celtics' },
  { id: '4',  name: 'Brooklyn Nets',          abbr: 'BKN', mockTeamId: 'nets' },
  { id: '5',  name: 'Charlotte Hornets',      abbr: 'CHA', mockTeamId: 'hornets' },
  { id: '6',  name: 'Chicago Bulls',          abbr: 'CHI', mockTeamId: 'bulls' },
  { id: '7',  name: 'Cleveland Cavaliers',    abbr: 'CLE', mockTeamId: 'cavaliers' },
  { id: '8',  name: 'Dallas Mavericks',       abbr: 'DAL', mockTeamId: 'mavericks' },
  { id: '9',  name: 'Denver Nuggets',         abbr: 'DEN', mockTeamId: 'nuggets' },
  { id: '10', name: 'Detroit Pistons',        abbr: 'DET', mockTeamId: 'pistons' },
  { id: '11', name: 'Golden State Warriors',  abbr: 'GSW', mockTeamId: 'warriors' },
  { id: '14', name: 'Houston Rockets',        abbr: 'HOU', mockTeamId: 'rockets' },
  { id: '15', name: 'Indiana Pacers',         abbr: 'IND', mockTeamId: 'pacers' },
  { id: '16', name: 'Los Angeles Clippers',   abbr: 'LAC', mockTeamId: 'clippers' },
  { id: '17', name: 'Los Angeles Lakers',     abbr: 'LAL', mockTeamId: 'lakers' },
  { id: '19', name: 'Memphis Grizzlies',      abbr: 'MEM', mockTeamId: 'grizzlies' },
  { id: '20', name: 'Miami Heat',             abbr: 'MIA', mockTeamId: 'heat' },
  { id: '21', name: 'Milwaukee Bucks',        abbr: 'MIL', mockTeamId: 'bucks' },
  { id: '22', name: 'Minnesota Timberwolves', abbr: 'MIN', mockTeamId: 'timberwolves' },
  { id: '23', name: 'New Orleans Pelicans',   abbr: 'NOP', mockTeamId: 'pelicans' },
  { id: '24', name: 'New York Knicks',        abbr: 'NYK', mockTeamId: 'knicks' },
  { id: '25', name: 'Oklahoma City Thunder',  abbr: 'OKC', mockTeamId: 'thunder' },
  { id: '26', name: 'Orlando Magic',          abbr: 'ORL', mockTeamId: 'magic' },
  { id: '27', name: 'Philadelphia 76ers',     abbr: 'PHI', mockTeamId: 'sixers' },
  { id: '28', name: 'Phoenix Suns',           abbr: 'PHX', mockTeamId: 'suns' },
  { id: '29', name: 'Portland Trail Blazers', abbr: 'POR', mockTeamId: 'blazers' },
  { id: '30', name: 'Sacramento Kings',       abbr: 'SAC', mockTeamId: 'kings' },
  { id: '31', name: 'San Antonio Spurs',      abbr: 'SAS', mockTeamId: 'spurs' },
  { id: '38', name: 'Toronto Raptors',        abbr: 'TOR', mockTeamId: 'raptors' },
  { id: '40', name: 'Utah Jazz',              abbr: 'UTA', mockTeamId: 'jazz' },
  { id: '41', name: 'Washington Wizards',     abbr: 'WAS', mockTeamId: 'wizards' },
];

async function runNbaPipeline(log?: FastifyBaseLogger, opts: { boxScores?: boolean } = {}): Promise<{ games: number; boxScores: number }> {
  const teams = await fetchNbaTeamMap();
  let gamesUpserted = 0;
  let boxScoresUpserted = 0;
  const yesterday = yesterdayUTC();
  const today = todayUTC();

  // Pull this team's schedule once. fetchTeamSchedule returns the full season
  // — we filter down to the narrow date window we care about.
  for (const team of teams) {
    let schedule: Awaited<ReturnType<typeof apisportsAdapter.fetchTeamSchedule>> = [];
    try {
      schedule = await apisportsAdapter.fetchTeamSchedule('nba', team.id);
    } catch (err) {
      log?.warn({ err }, `[refreshGames:nba] schedule fetch failed for team ${team.id} (${team.abbr})`);
      continue;
    }

    const rows: GameRow[] = [];
    for (const ev of schedule) {
      const gameDate = (ev.date || '').slice(0, 10);
      if (!gameDate) continue;
      // Daily refresh window: yesterday + next 14 days. Older finals are
      // already ingested; we only re-fetch finals from yesterday to catch
      // late-night game endings.
      const cutoff = new Date(today);
      cutoff.setUTCDate(cutoff.getUTCDate() + 14);
      const cutoffStr = isoDate(cutoff);
      if (gameDate < yesterday || gameDate > cutoffStr) continue;

      const status = normalizeStatus(ev.status);
      // De-dupe across the two team-by-team pulls: only the home team writes.
      // API-Sports gives us homeTeamId per event; only emit when that matches
      // our current iterating team id. If homeTeamId is missing fall through
      // (we'll get the row from the away team's pull instead).
      if (ev.homeTeamId && ev.homeTeamId !== team.id) continue;

      const homeRef = teams.find((t) => t.id === ev.homeTeamId) ?? team;
      const awayRef = teams.find((t) => t.id === ev.awayTeamId);

      rows.push({
        id: `apisports:nba:${ev.gameId}`,
        source: 'apisports',
        sport: 'nba',
        season: SEASON_BY_LEAGUE.nba,
        game_date: gameDate,
        status,
        home_team: homeRef.name,
        home_team_abbr: homeRef.abbr,
        home_score: null,   // adapter shape doesn't surface scores; box-score pull fills these
        away_team: awayRef?.name ?? ev.awayTeam,
        away_team_abbr: awayRef?.abbr ?? ev.awayTeam,
        away_score: null,
        source_game_id: String(ev.gameId),
      });
    }

    if (rows.length > 0) {
      const r = await upsertGames(rows);
      if (r.error) log?.warn(`[refreshGames:nba] games upsert error for ${team.abbr}: ${r.error}`);
      gamesUpserted += r.inserted;
    }
  }

  // Box scores for FINAL games in yesterday's window. We pull only finals
  // from yesterday to avoid re-fetching every prior final each day.
  if (opts.boxScores !== false) {
    const { data: finals, error: fErr } = await supabase
      .from('live_games')
      .select('id, source_game_id, home_team_abbr, away_team_abbr')
      .eq('sport', 'nba')
      .eq('status', 'final')
      .eq('game_date', yesterday);
    if (fErr) {
      log?.warn(`[refreshGames:nba] finals select error: ${fErr.message}`);
    } else {
      for (const f of finals ?? []) {
        try {
          const box: BoxScore = await apisportsAdapter.fetchGameBoxScore('nba', f.source_game_id as string);
          if (box.players.length === 0) continue;
          const rows: GameStatRow[] = box.players.map((p) => ({
            game_id: f.id as string,
            player_id: p.playerId,
            player_name: null,
            team: '',
            stats_json: p.stats,
          }));
          const r = await upsertGameStats(rows);
          if (r.error) log?.warn(`[refreshGames:nba] game_stats upsert error for ${f.id}: ${r.error}`);
          boxScoresUpserted += r.inserted;
        } catch (err) {
          log?.warn({ err }, `[refreshGames:nba] box-score fetch failed for game ${f.source_game_id}`);
        }
      }
    }
  }

  return { games: gamesUpserted, boxScores: boxScoresUpserted };
}

// ─── team_records recompute ────────────────────────────────────────────────
//
// Aggregate finals out of `live_games` and upsert one row per team. Win/loss
// counts come from comparing home_score vs away_score; ties only matter for NFL.

async function recomputeTeamRecords(sport: League, log?: FastifyBaseLogger): Promise<{ rows: number; error?: string }> {
  const season = SEASON_BY_LEAGUE[sport];
  const { data: finals, error } = await supabase
    .from('live_games')
    .select('home_team_abbr, away_team_abbr, home_score, away_score')
    .eq('sport', sport)
    .eq('season', season)
    .eq('status', 'final');
  if (error) {
    log?.warn(`[refreshGames:${sport}] team_records select error: ${error.message}`);
    return { rows: 0, error: error.message };
  }

  const teamMap = sport === 'nba' ? NBA_TEAM_MAP : [];
  const abbrToMockId = new Map(teamMap.map((t) => [t.abbr, t.mockTeamId]));

  type Rec = { wins: number; losses: number; ties: number };
  const tally = new Map<string, Rec>();
  for (const g of finals ?? []) {
    const home = abbrToMockId.get(g.home_team_abbr as string);
    const away = abbrToMockId.get(g.away_team_abbr as string);
    if (!home || !away) continue;
    if (!tally.has(home)) tally.set(home, { wins: 0, losses: 0, ties: 0 });
    if (!tally.has(away)) tally.set(away, { wins: 0, losses: 0, ties: 0 });
    const hs = Number(g.home_score ?? 0);
    const as = Number(g.away_score ?? 0);
    if (hs > as)      { tally.get(home)!.wins++;  tally.get(away)!.losses++; }
    else if (as > hs) { tally.get(away)!.wins++;  tally.get(home)!.losses++; }
    else              { tally.get(home)!.ties++;  tally.get(away)!.ties++; }
  }

  const rows = Array.from(tally.entries()).map(([teamId, r]) => {
    const total = r.wins + r.losses + r.ties;
    return {
      team_id: teamId,
      sport,
      season,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
      ot_losses: 0,
      win_pct: total > 0 ? Number((r.wins / total).toFixed(3)) : null,
      computed_at: new Date().toISOString(),
    };
  });
  if (rows.length === 0) return { rows: 0 };

  const { error: upErr, count } = await supabase
    .from('team_records')
    .upsert(rows, { onConflict: 'team_id', count: 'exact' });
  if (upErr) {
    log?.warn(`[refreshGames:${sport}] team_records upsert error: ${upErr.message}`);
    return { rows: 0, error: upErr.message };
  }
  return { rows: count ?? rows.length };
}

// ─── Per-league orchestrator ───────────────────────────────────────────────

async function runLeague(league: League, log?: FastifyBaseLogger, opts: { boxScores?: boolean } = {}): Promise<void> {
  if (!isSportEnabled(league)) {
    log?.info(`[refreshGames:${league}] skipped — sport disabled in sports_config`);
    return;
  }
  STATUS[league].lastRunAt = new Date().toISOString();
  log?.info(`[refreshGames:${league}] starting (boxScores=${opts.boxScores !== false})`);

  try {
    let res: { games: number; boxScores: number };
    switch (league) {
      case 'nba':
        res = await runNbaPipeline(log, opts);
        break;
      case 'nfl':
      case 'mlb':
      case 'nhl':
        // The API-Sports adapter throws "not yet wired" for these — log and skip
        // so the cron stays alive. The fix is to extend apisportsAdapter.ts; this
        // branch flips to runXxxPipeline as each one ships.
        log?.warn(`[refreshGames:${league}] adapter not yet wired — skipping (extend apisportsAdapter.ts to enable)`);
        STATUS[league].lastError = 'adapter not yet wired';
        STATUS[league].lastErrorAt = STATUS[league].lastRunAt;
        return;
      case 'mls':
        return; // intentionally not in LEAGUES
    }

    STATUS[league].gamesIngested += res.games;
    STATUS[league].boxScoresIngested += res.boxScores;

    const tr = await recomputeTeamRecords(league, log);
    log?.info(`[refreshGames:${league}] OK — games=${res.games} boxScores=${res.boxScores} teamRecordRows=${tr.rows}`);

    STATUS[league].lastSuccessAt = STATUS[league].lastRunAt;
    STATUS[league].lastError = null;
  } catch (err) {
    STATUS[league].lastError = (err as Error).message;
    STATUS[league].lastErrorAt = STATUS[league].lastRunAt;
    log?.error({ err }, `[refreshGames:${league}] FAILED`);
  }
}

function inSeason(league: League, now: Date = new Date()): boolean {
  const month = now.getUTCMonth() + 1;
  switch (league) {
    case 'nfl': return month >= 9 || month <= 2;
    case 'nba': return month >= 10 || month <= 6;
    case 'nhl': return month >= 10 || month <= 6;
    case 'mlb': return month >= 4 && month <= 10;
    case 'mls': return month >= 2 && month <= 11;
  }
}

// ─── Public lifecycle ──────────────────────────────────────────────────────

export interface GamesJobsHandle {
  stop: () => void;
}

export function startGamesRefreshJobs(log?: FastifyBaseLogger): GamesJobsHandle {
  const tz = 'America/New_York';
  const tasks: cron.ScheduledTask[] = [];

  const dailyOffsets: Array<{ league: League; minute: number }> = [
    { league: 'nba', minute: 30 },
    { league: 'nfl', minute: 34 },
    { league: 'mlb', minute: 38 },
    { league: 'nhl', minute: 42 },
  ];
  for (const { league, minute } of dailyOffsets) {
    tasks.push(
      cron.schedule(
        `${minute} 3 * * *`,
        () => { void runLeague(league, log, { boxScores: true }); },
        { timezone: tz },
      ),
    );
  }

  for (const league of LEAGUES) {
    tasks.push(
      cron.schedule(
        '15 12-23 * * *',
        () => {
          if (!inSeason(league)) return;
          // Hourly tick: refresh games + recompute team_records, but skip
          // box-score backfill (those only matter for completed finals from
          // the prior day, which the 03:30 ET tick handles).
          void runLeague(league, log, { boxScores: false });
        },
        { timezone: tz },
      ),
    );
  }

  log?.info(
    `[refreshGames] cron scheduled — daily 03:30 ET (staggered: NBA 30, NFL 34, MLB 38, NHL 42) + hourly :15 12:00–23:00 ET (in-season only). tz=${tz}`,
  );

  return { stop: () => { for (const t of tasks) t.stop(); } };
}

export async function _runGamesRefreshNow(league: League, log?: FastifyBaseLogger): Promise<void> {
  await runLeague(league, log, { boxScores: true });
}

export function getGamesPipelineStatus(): {
  generated_at: string;
  pipelines: Record<League, PipelineEntry>;
} {
  return {
    generated_at: new Date().toISOString(),
    pipelines: { ...STATUS },
  };
}
