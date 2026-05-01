/**
 * refreshStats.ts — scheduled stats refresh for all 5 leagues.
 *
 * Schedule (America/New_York):
 *   - 04:00 ET — full refresh, staggered 5 min apart per league:
 *       NFL 04:00, NBA 04:05, MLB 04:10, NHL 04:15, MLS 04:20.
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
import type { FastifyBaseLogger } from 'fastify';
import { pullLeague, cachePath } from '../scripts/pull-stats-shared.js';
import { clearCacheLookups } from '../services/ratings/cacheLookup.js';
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

  log?.info(
    `[refreshStats] cron scheduled — daily 04:00 ET (staggered 5 min) + hourly 12:00–23:00 ET (in-season only). tz=${tz}`,
  );

  return {
    stop: () => {
      for (const t of tasks) t.stop();
    },
  };
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
