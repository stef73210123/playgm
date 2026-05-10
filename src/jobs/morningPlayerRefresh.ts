/**
 * morningPlayerRefresh.ts — daily morning refresh of player stats and results
 * from TheSportsDB.
 *
 * Schedule: 07:00 ET daily (America/New_York) — runs after the 04:00 ET stats
 * refresh and 05:30 ET highlights cron, so all upstream caches are warm.
 *
 * For every player in the season stat-cache files (across all 5 sports) we:
 *   1. Resolve the SportsDB idPlayer via searchPlayersByName
 *   2. Fetch full player details (lookupPlayer) — team, position, status
 *   3. Fetch the team's most recent completed event (getLastEventsForTeam) and
 *      derive a W/L/D result
 *   4. Diff the new snapshot against the previous one and collect changes
 *   5. Persist the updated snapshot to assets/stat-cache/player_results_{sport}.json
 *   6. Print a human-readable diff report and surface status via getMorningRefreshStatus()
 *
 * Idempotency: the snapshot file is written atomically (tmp → rename) so
 * concurrent reads never see a partial document. If a player has no new event
 * since the last run, no diff entry is emitted.
 *
 * Rate limiting: 200 ms between SportsDB round-trips. Free-tier key handles
 * ~1 req/s; SPORTSDB_V2_KEY lifts that ceiling.
 *
 * Standalone run:
 *   npx tsx --import ./src/env-loader.ts src/jobs/morningPlayerRefresh.ts
 */

import cron from 'node-cron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  searchPlayersByName,
  lookupPlayer,
  getLastEventsForTeam,
  type SportsDbPlayer,
  type SportsDbLiveScore,
} from '../services/sportsdb.js';

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Polite delay between SportsDB HTTP round-trips. */
const SPORTSDB_DELAY_MS = 200;

// ─── Sport config ────────────────────────────────────────────────────────────

const SPORTS = ['nba', 'nfl', 'mlb', 'nhl', 'mls'] as const;
type Sport = (typeof SPORTS)[number];

const STAT_CACHE_FILE: Record<Sport, string> = {
  nba: 'nba_season_2025-26.json',
  nfl: 'nfl_season_2025.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

// TheSportsDB strSport values that map to each of our sports.
const SPORT_TO_SDB_SPORT: Record<Sport, string> = {
  nba: 'basketball',
  nfl: 'american football',
  mlb: 'baseball',
  nhl: 'ice hockey',
  mls: 'soccer',
};

// ─── Path helpers ─────────────────────────────────────────────────────────────

function repoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'assets'))) return cwd;
  return path.resolve(cwd, '..');
}

function statCachePath(sport: Sport): string {
  return path.join(repoRoot(), 'assets', 'stat-cache', STAT_CACHE_FILE[sport]);
}

function snapshotPath(sport: Sport): string {
  return path.join(repoRoot(), 'assets', 'stat-cache', `player_results_${sport}.json`);
}

// ─── Shared types ─────────────────────────────────────────────────────────────

interface StatCachePlayer {
  external_id?: string;
  full_name?: string;
  team?: string;
}

interface StatCacheFile {
  players?: StatCachePlayer[];
}

export interface PlayerSnapshot {
  /** ESPN external_id from the stat-cache. */
  playerId: string;
  name: string;
  sport: Sport;
  /** TheSportsDB idPlayer resolved via name search. */
  sportsdb_id: string | null;
  team: string | null;
  position: string | null;
  last_event_id: string | null;
  last_event_date: string | null;
  last_event_name: string | null;
  last_event_home: string | null;
  last_event_away: string | null;
  last_score_home: string | null;
  last_score_away: string | null;
  /** 'W' | 'L' | 'D' | null */
  last_event_result: string | null;
  refreshed_at: string;
}

interface SnapshotFile {
  sport: Sport;
  generated_at: string;
  players: PlayerSnapshot[];
}

export interface PlayerDiff {
  playerId: string;
  name: string;
  sport: Sport;
  changes: Array<{ field: string; from: string | null; to: string | null }>;
}

// ─── Status surface ──────────────────────────────────────────────────────────

interface RefreshStatus {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  processedCount: number;
  updatedCount: number;
  errorCount: number;
  diffCount: number;
  perSport: Partial<Record<Sport, { processed: number; updated: number; diffs: number }>>;
}

const STATUS: RefreshStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  processedCount: 0,
  updatedCount: 0,
  errorCount: 0,
  diffCount: 0,
  perSport: {},
};

export function getMorningRefreshStatus(): Readonly<RefreshStatus> {
  return { ...STATUS };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function reportError(scope: string, err: unknown, log?: FastifyBaseLogger): void {
  const msg = (err as Error)?.message ?? String(err);
  if (log) log.warn(`[morning-refresh] ${scope}: ${msg}`);
  else console.warn(`[morning-refresh] ${scope}:`, msg);
}

// ─── Stat-cache IO ────────────────────────────────────────────────────────────

async function readStatCache(sport: Sport): Promise<StatCachePlayer[]> {
  try {
    const raw = await readFile(statCachePath(sport), 'utf8');
    const parsed = JSON.parse(raw) as StatCacheFile;
    return Array.isArray(parsed.players) ? parsed.players : [];
  } catch {
    return [];
  }
}

async function readSnapshot(sport: Sport): Promise<Map<string, PlayerSnapshot>> {
  const byId = new Map<string, PlayerSnapshot>();
  try {
    const raw = await readFile(snapshotPath(sport), 'utf8');
    const parsed = JSON.parse(raw) as SnapshotFile;
    if (Array.isArray(parsed.players)) {
      for (const p of parsed.players) byId.set(p.playerId, p);
    }
  } catch {
    // missing / malformed → fresh map
  }
  return byId;
}

async function writeSnapshot(sport: Sport, file: SnapshotFile): Promise<void> {
  const dest = snapshotPath(sport);
  const tmp = `${dest}.tmp`;
  await mkdir(path.dirname(dest), { recursive: true });
  file.generated_at = new Date().toISOString();
  file.players.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
  await rename(tmp, dest);
}

// ─── SportsDB resolution ──────────────────────────────────────────────────────

async function resolveSportsDbPlayer(
  fullName: string,
  sport: Sport,
): Promise<SportsDbPlayer | null> {
  try {
    const matches = await searchPlayersByName(fullName);
    const wantSport = SPORT_TO_SDB_SPORT[sport].toLowerCase();
    const filtered = matches.filter((m) => (m.strSport ?? '').toLowerCase() === wantSport);
    const pick = filtered[0] ?? matches[0] ?? null;
    if (!pick) return null;
    await sleep(SPORTSDB_DELAY_MS);
    return await lookupPlayer(String(pick.idPlayer));
  } catch (err) {
    reportError(`resolveSportsDbPlayer ${fullName}`, err);
    return null;
  }
}

async function fetchLastEvent(idTeam: string): Promise<SportsDbLiveScore | null> {
  try {
    await sleep(SPORTSDB_DELAY_MS);
    const events = await getLastEventsForTeam(idTeam);
    return events.length > 0 ? events[0] : null;
  } catch {
    return null;
  }
}

function deriveResult(teamName: string, event: SportsDbLiveScore): string | null {
  const home = parseInt(event.intHomeScore ?? '', 10);
  const away = parseInt(event.intAwayScore ?? '', 10);
  if (isNaN(home) || isNaN(away)) return null;

  const isHome = event.strHomeTeam === teamName;
  const isAway = event.strAwayTeam === teamName;
  if (!isHome && !isAway) return null;

  const playerScore = isHome ? home : away;
  const oppScore = isHome ? away : home;
  if (playerScore > oppScore) return 'W';
  if (playerScore < oppScore) return 'L';
  return 'D';
}

// ─── Diff logic ──────────────────────────────────────────────────────────────

const DIFF_FIELDS: Array<keyof PlayerSnapshot> = [
  'team',
  'position',
  'last_event_id',
  'last_event_date',
  'last_event_name',
  'last_score_home',
  'last_score_away',
  'last_event_result',
];

function diffSnapshots(prev: PlayerSnapshot | undefined, next: PlayerSnapshot): PlayerDiff['changes'] {
  if (!prev) return [{ field: 'initial_load', from: null, to: 'seeded' }];
  const changes: PlayerDiff['changes'] = [];
  for (const field of DIFF_FIELDS) {
    const from = (prev[field] as string | null) ?? null;
    const to = (next[field] as string | null) ?? null;
    if (String(from) !== String(to)) changes.push({ field, from, to });
  }
  return changes;
}

// ─── Per-player refresh ───────────────────────────────────────────────────────

async function refreshOnePlayer(
  cached: StatCachePlayer,
  sport: Sport,
  prevById: Map<string, PlayerSnapshot>,
  log?: FastifyBaseLogger,
): Promise<{ snapshot: PlayerSnapshot; diff: PlayerDiff['changes'] } | null> {
  const fullName = cached.full_name?.trim();
  if (!fullName) return null;

  const playerId = cached.external_id ?? `${sport}:${fullName}`;

  const sdbPlayer = await resolveSportsDbPlayer(fullName, sport);

  let lastEvent: SportsDbLiveScore | null = null;
  if (sdbPlayer?.idTeam) {
    lastEvent = await fetchLastEvent(String(sdbPlayer.idTeam));
  }

  const teamName = sdbPlayer?.strTeam ?? cached.team ?? null;

  const snapshot: PlayerSnapshot = {
    playerId,
    name: fullName,
    sport,
    sportsdb_id: sdbPlayer ? String(sdbPlayer.idPlayer) : null,
    team: teamName,
    position: sdbPlayer?.strPosition ?? null,
    last_event_id: lastEvent?.idEvent ?? null,
    last_event_date: lastEvent?.dateEvent ?? null,
    last_event_name: lastEvent?.strEvent ?? null,
    last_event_home: lastEvent?.strHomeTeam ?? null,
    last_event_away: lastEvent?.strAwayTeam ?? null,
    last_score_home: lastEvent?.intHomeScore != null ? String(lastEvent.intHomeScore) : null,
    last_score_away: lastEvent?.intAwayScore != null ? String(lastEvent.intAwayScore) : null,
    last_event_result: teamName && lastEvent ? deriveResult(teamName, lastEvent) : null,
    refreshed_at: new Date().toISOString(),
  };

  const diff = diffSnapshots(prevById.get(playerId), snapshot);

  if (log) {
    if (diff.length === 0 || (diff.length === 1 && diff[0].field === 'initial_load')) {
      log.debug?.(`[morning-refresh] ${sport}/${fullName}: no changes`);
    } else {
      log.info(
        `[morning-refresh] ${sport}/${fullName}: ${diff.length} change(s) — ` +
          diff.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join(', '),
      );
    }
  }

  return { snapshot, diff };
}

// ─── Per-sport refresh ────────────────────────────────────────────────────────

async function refreshSport(
  sport: Sport,
  log?: FastifyBaseLogger,
): Promise<{ processed: number; updated: number; errors: number; diffs: PlayerDiff[] }> {
  const players = await readStatCache(sport);
  if (players.length === 0) {
    log?.info(`[morning-refresh] ${sport}: stat-cache empty, skipping`);
    return { processed: 0, updated: 0, errors: 0, diffs: [] };
  }

  const prevById = await readSnapshot(sport);
  const nextById = new Map<string, PlayerSnapshot>(prevById);
  const diffs: PlayerDiff[] = [];
  let updated = 0;
  let errors = 0;

  for (const cached of players) {
    try {
      const result = await refreshOnePlayer(cached, sport, prevById, log);
      if (!result) continue;

      const { snapshot, diff } = result;
      nextById.set(snapshot.playerId, snapshot);
      updated++;

      const meaningfulDiff = diff.filter((c) => c.field !== 'initial_load');
      if (meaningfulDiff.length > 0) {
        diffs.push({ playerId: snapshot.playerId, name: snapshot.name, sport, changes: meaningfulDiff });
      }
    } catch (err) {
      errors++;
      reportError(`player ${cached.full_name ?? '?'} (${sport})`, err, log);
    }

    await sleep(SPORTSDB_DELAY_MS);
  }

  try {
    await writeSnapshot(sport, {
      sport,
      generated_at: new Date().toISOString(),
      players: Array.from(nextById.values()),
    });
  } catch (err) {
    reportError(`writeSnapshot ${sport}`, err, log);
  }

  return { processed: players.length, updated, errors, diffs };
}

// ─── Diff report ──────────────────────────────────────────────────────────────

function printDiffReport(allDiffs: PlayerDiff[], log?: FastifyBaseLogger): void {
  if (allDiffs.length === 0) {
    const line = '[morning-refresh] No stat changes detected.';
    if (log) log.info(line);
    else console.log(line);
    return;
  }

  const lines: string[] = ['', '── Morning Refresh Diff ────────────────────────'];
  for (const { name, sport, changes } of allDiffs) {
    lines.push(`  ${name} (${sport.toUpperCase()})`);
    for (const { field, from, to } of changes) {
      const label = field.replace(/_/g, ' ').padEnd(22);
      lines.push(`    ${label} ${String(from ?? '—').padStart(10)} → ${to ?? '—'}`);
    }
  }
  lines.push('────────────────────────────────────────────────\n');

  const out = lines.join('\n');
  if (log) log.info(out);
  else console.log(out);
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export async function runMorningPlayerRefresh(log?: FastifyBaseLogger): Promise<void> {
  const startedAt = new Date().toISOString();
  STATUS.lastRunAt = startedAt;

  const msg = `[morning-refresh] Starting — ${startedAt}`;
  if (log) log.info(msg);
  else console.log(msg);

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalErrors = 0;
  const allDiffs: PlayerDiff[] = [];

  for (const sport of SPORTS) {
    let result;
    try {
      result = await refreshSport(sport, log);
    } catch (err) {
      reportError(`refreshSport ${sport}`, err, log);
      result = { processed: 0, updated: 0, errors: 1, diffs: [] };
    }

    STATUS.perSport[sport] = {
      processed: result.processed,
      updated: result.updated,
      diffs: result.diffs.length,
    };
    totalProcessed += result.processed;
    totalUpdated += result.updated;
    totalErrors += result.errors;
    allDiffs.push(...result.diffs);
  }

  STATUS.processedCount = totalProcessed;
  STATUS.updatedCount = totalUpdated;
  STATUS.errorCount = totalErrors;
  STATUS.diffCount = allDiffs.length;
  STATUS.lastSuccessAt = new Date().toISOString();
  STATUS.lastError = totalErrors > 0 ? `${totalErrors} player(s) failed` : null;

  const summary =
    `[morning-refresh] Done — ${totalUpdated}/${totalProcessed} refreshed, ` +
    `${allDiffs.length} diff(s), ${totalErrors} error(s)`;
  if (log) log.info(summary);
  else console.log(summary);

  printDiffReport(allDiffs, log);
}

// ─── Cron registration ────────────────────────────────────────────────────────

export interface MorningRefreshHandle {
  stop: () => void;
}

export function startMorningPlayerRefresh(log?: FastifyBaseLogger): MorningRefreshHandle {
  const tz = 'America/New_York';
  const expr = '0 7 * * *';

  const task = cron.schedule(
    expr,
    () => {
      void runMorningPlayerRefresh(log).catch((err) =>
        reportError('cron tick', err, log),
      );
    },
    { timezone: tz },
  );

  log?.info(
    `[morning-refresh] scheduled daily ${expr} (${tz}) — stats + results refresh for all players`,
  );

  return { stop: () => task.stop() };
}

// ─── CLI invocation ───────────────────────────────────────────────────────────

const isMain =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] != null &&
  process.argv[1].endsWith('morningPlayerRefresh.ts') ||
  (typeof process !== 'undefined' &&
    Array.isArray(process.argv) &&
    process.argv[1] != null &&
    process.argv[1].endsWith('morningPlayerRefresh.js'));

if (isMain) {
  runMorningPlayerRefresh()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[morning-refresh] CLI run FAILED:', err);
      process.exit(1);
    });
}
