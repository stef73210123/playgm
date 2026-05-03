/**
 * refreshStats.ts — scheduled stats refresh for all 5 leagues.
 *
 * Schedule (America/New_York):
 *   - 04:00 ET — full refresh, staggered 5 min apart per league:
 *       NFL 04:00, NBA 04:05, MLB 04:10, NHL 04:15, MLS 04:20.
 *   - 05:00 ET — premium SportsDB highlights backfill (idempotent, only
 *     refreshes rows where meta_json.video_highlight_pulled_at is missing
 *     OR older than 30 days). Runs after the stats refresh so any teams
 *     newly inserted by populate are picked up the same morning.
 *   - Hourly 12:00–23:00 ET on game days, only for leagues with active games.
 *
 * Idempotency: each per-league refresh writes to a .tmp file then renames
 * (handled inside `pullLeague`), so concurrent reads of the cache file
 * never see a partial JSON document.
 *
 * Persistence: per-league `lastRunAt` / `lastSuccessAt` / `playerCount` are
 * tracked in an in-memory `pipelineStatus` map. Surfaced via /admin/status
 * under the `data_pipelines` key. After the migration in Step 6 is applied,
 * this will dual-write to a `pipeline_runs` table.
 */
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { pullLeague, cachePath } from '../scripts/pull-stats-shared.js';
import { clearCacheLookups } from '../services/ratings/cacheLookup.js';
import { isSportEnabled } from '../services/sportsConfig.js';
import type { League } from '../services/stats/types.js';

interface PipelineEntry {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  playerCount: number;
  /** Last 24 hours: { successes, failures }. */
  recent24h: { successes: number; failures: number };
}

const STATUS: Record<League, PipelineEntry> = {
  nfl: emptyEntry(),
  nba: emptyEntry(),
  mlb: emptyEntry(),
  nhl: emptyEntry(),
  mls: emptyEntry(),
};

function emptyEntry(): PipelineEntry {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    playerCount: 0,
    recent24h: { successes: 0, failures: 0 },
  };
}

/** Runs in-process: a list of (timestamp, league, success) for the rolling 24h window. */
const runHistory: Array<{ ts: number; league: League; success: boolean }> = [];

function pruneHistory(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (runHistory.length > 0 && runHistory[0].ts < cutoff) runHistory.shift();
}

function recordRun(league: League, success: boolean, err?: Error): void {
  pruneHistory();
  runHistory.push({ ts: Date.now(), league, success });
  const e = STATUS[league];
  e.lastRunAt = new Date().toISOString();
  if (success) {
    e.lastSuccessAt = e.lastRunAt;
    e.lastError = null;
  } else {
    e.lastErrorAt = e.lastRunAt;
    e.lastError = err?.message ?? 'unknown error';
  }
  // Refresh recent24h totals
  e.recent24h = {
    successes: runHistory.filter((r) => r.league === league && r.success).length,
    failures: runHistory.filter((r) => r.league === league && !r.success).length,
  };
}

const LEAGUE_OPTS: Record<League, { season: string; seasonLabel: string; outFile: string; notes: string }> = {
  nfl: {
    season: '2025',
    seasonLabel: '2025 NFL season',
    outFile: cachePath('nfl_season_2025.json'),
    notes: 'Refreshed by jobs/refreshStats.ts.',
  },
  nba: {
    season: '2025-26',
    seasonLabel: '2025-26 NBA season',
    outFile: cachePath('nba_season_2025-26.json'),
    notes: 'Refreshed by jobs/refreshStats.ts.',
  },
  mlb: {
    season: '2026',
    seasonLabel: '2026 MLB season',
    outFile: cachePath('mlb_season_2026.json'),
    notes: 'Refreshed by jobs/refreshStats.ts.',
  },
  nhl: {
    season: '2025-26',
    seasonLabel: '2025-26 NHL season',
    outFile: cachePath('nhl_season_2025-26.json'),
    notes: 'Refreshed by jobs/refreshStats.ts.',
  },
  mls: {
    season: '2026',
    seasonLabel: '2026 MLS season',
    outFile: cachePath('mls_season_2026.json'),
    notes: 'Refreshed by jobs/refreshStats.ts.',
  },
};

/** Run the per-league pull. Updates STATUS and clears in-memory cache. */
async function runRefresh(league: League, log?: FastifyBaseLogger): Promise<void> {
  // Skip leagues the admin has disabled in sports_config.json. Cache is hot
  // (60s) so a flip in the editor is picked up by the next cron tick. Saves
  // wasted API calls + stops half-broken pipelines (e.g. MLS) from polluting
  // STATUS with failures while we wait on a real data source.
  if (!isSportEnabled(league)) {
    log?.info(`[refreshStats:${league}] skipped — sport disabled in sports_config`);
    return;
  }
  log?.info(`[refreshStats:${league}] starting`);
  try {
    const cache = await pullLeague(league, LEAGUE_OPTS[league]);
    STATUS[league].playerCount = cache.players.length;
    recordRun(league, true);
    clearCacheLookups();
    log?.info(`[refreshStats:${league}] OK (${cache.players.length} players)`);
  } catch (err) {
    recordRun(league, false, err as Error);
    log?.error({ err }, `[refreshStats:${league}] FAILED`);
  }
}

/**
 * Quick "is this league in season?" check for game-day hourly refreshes.
 * Conservative: returns true year-round for NBA/NHL/NFL/MLS during their
 * months; MLB Apr–Oct. The cron only fires Mon–Sun, so just gate by month.
 */
function inSeason(league: League, now: Date = new Date()): boolean {
  const month = now.getUTCMonth() + 1; // 1..12
  switch (league) {
    case 'nfl': return month >= 9 || month <= 2;
    case 'nba': return month >= 10 || month <= 6;
    case 'nhl': return month >= 10 || month <= 6;
    case 'mlb': return month >= 4 && month <= 10;
    case 'mls': return month >= 2 && month <= 11;
  }
}

export interface RefreshJobsHandle {
  /** Stop all scheduled tasks. Used in tests. */
  stop: () => void;
}

/**
 * Wire up the cron schedule. Returns a handle that can stop all jobs.
 *
 * Daily 04:00 ET full refresh, staggered 5 min apart:
 *   NFL 04:00, NBA 04:05, MLB 04:10, NHL 04:15, MLS 04:20.
 *
 * Hourly 12:00–23:00 ET on every day, gated by inSeason(league).
 */
export function startStatsRefreshJobs(log?: FastifyBaseLogger): RefreshJobsHandle {
  const tz = 'America/New_York';
  const tasks: cron.ScheduledTask[] = [];

  const dailyOffsets: Array<{ league: League; minute: number }> = [
    { league: 'nfl', minute: 0 },
    { league: 'nba', minute: 5 },
    { league: 'mlb', minute: 10 },
    { league: 'nhl', minute: 15 },
    { league: 'mls', minute: 20 },
  ];

  for (const { league, minute } of dailyOffsets) {
    const expr = `${minute} 4 * * *`;
    tasks.push(
      cron.schedule(
        expr,
        () => {
          void runRefresh(league, log);
        },
        { timezone: tz },
      ),
    );
  }

  // Hourly 12:00–23:00 ET, in-season only.
  for (const league of Object.keys(LEAGUE_OPTS) as League[]) {
    tasks.push(
      cron.schedule(
        '0 12-23 * * *',
        () => {
          if (!inSeason(league)) return;
          void runRefresh(league, log);
        },
        { timezone: tz },
      ),
    );
  }

  // 05:00 ET — premium SportsDB highlights backfill. Runs the
  // `pull-highlights` script as a child process so it inherits all the
  // env-loader plumbing (Supabase + SPORTSDB_V2_KEY) without us having
  // to re-import the script's main inside the long-lived server. The
  // script itself is idempotent — only refreshes rows where
  // meta_json.video_highlight_pulled_at is missing OR > 30 days old.
  tasks.push(
    cron.schedule(
      '0 5 * * *',
      () => {
        void runHighlightsRefresh(log);
      },
      { timezone: tz },
    ),
  );

  // 06:00 ET Sunday — weekly forced refresh of meta_json.highlight_playlist.
  // The daily 05:00 ET cron only refreshes records whose
  // video_highlight_pulled_at is stale; the weekly job re-resolves every
  // record's playlist (--force) so YouTube embeddability flips (channel
  // takes a clip private, etc.) propagate within 7 days.
  tasks.push(
    cron.schedule(
      '0 6 * * 0',
      () => {
        void runHighlightsRefresh(log, ['--force']);
      },
      { timezone: tz },
    ),
  );

  log?.info(
    `[refreshStats] cron scheduled — daily 04:00 ET (stats, staggered 5 min) + 05:00 ET (highlights) + Sun 06:00 ET (forced playlist refresh) + hourly 12:00–23:00 ET (in-season only). tz=${tz}`,
  );

  return {
    stop: () => {
      for (const t of tasks) t.stop();
    },
  };
}

// ─── SportsDB highlights pipeline ───────────────────────────────────────────

interface HighlightsStatus {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Last full output line — captured as a debugging breadcrumb. */
  lastSummary: string | null;
}

const HIGHLIGHTS_STATUS: HighlightsStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastSummary: null,
};

function runHighlightsRefresh(log?: FastifyBaseLogger, extraArgs: string[] = []): Promise<void> {
  return new Promise((resolve) => {
    HIGHLIGHTS_STATUS.lastRunAt = new Date().toISOString();
    log?.info(`[refreshStats:highlights] starting${extraArgs.length ? ` (args: ${extraArgs.join(' ')})` : ''}`);
    // tsx with the env-loader — same invocation path as `npm run pull:highlights`.
    const cwd = path.resolve(process.cwd());
    const child = spawn(
      'npx',
      ['tsx', '--import', './src/env-loader.ts', 'src/scripts/pull-highlights.ts', ...extraArgs],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let lastLine = '';
    child.stdout.on('data', (b: Buffer) => {
      const s = b.toString();
      lastLine = s.trim().split('\n').pop() ?? lastLine;
    });
    child.stderr.on('data', (b: Buffer) => {
      log?.warn({ msg: b.toString().trim() }, '[refreshStats:highlights] stderr');
    });
    child.on('close', (code) => {
      const ts = new Date().toISOString();
      if (code === 0) {
        HIGHLIGHTS_STATUS.lastSuccessAt = ts;
        HIGHLIGHTS_STATUS.lastError = null;
        HIGHLIGHTS_STATUS.lastSummary = lastLine;
        log?.info(`[refreshStats:highlights] OK — ${lastLine}`);
      } else {
        HIGHLIGHTS_STATUS.lastError = `exit ${code}`;
        log?.error(`[refreshStats:highlights] FAILED exit=${code}`);
      }
      resolve();
    });
  });
}

/** Used by tests + admin status surfaces. */
export async function _runHighlightsRefreshNow(log?: FastifyBaseLogger): Promise<void> {
  await runHighlightsRefresh(log);
}

export function getHighlightsPipelineStatus(): HighlightsStatus {
  return { ...HIGHLIGHTS_STATUS };
}

/** /admin/status surface. */
export function getDataPipelinesStatus(): {
  generated_at: string;
  cron_schedule: { daily: string; hourly: string; tz: string };
  pipelines: Record<League, PipelineEntry & { successRate24h: number }>;
} {
  pruneHistory();
  const out = {} as Record<League, PipelineEntry & { successRate24h: number }>;
  for (const k of Object.keys(STATUS) as League[]) {
    const e = STATUS[k];
    const total = e.recent24h.successes + e.recent24h.failures;
    out[k] = {
      ...e,
      successRate24h: total > 0 ? e.recent24h.successes / total : 1,
    };
  }
  return {
    generated_at: new Date().toISOString(),
    cron_schedule: {
      daily: '04:00 ET (staggered: NFL 0, NBA +5, MLB +10, NHL +15, MLS +20)',
      hourly: '12:00–23:00 ET, in-season only',
      tz: 'America/New_York',
    },
    pipelines: out,
  };
}

/** Test-only — directly trigger a refresh. */
export async function _runRefreshNow(league: League, log?: FastifyBaseLogger): Promise<void> {
  await runRefresh(league, log);
}
