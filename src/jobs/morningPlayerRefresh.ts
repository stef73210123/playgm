/**
 * morningPlayerRefresh.ts — daily 07:00 ET TheSportsDB player refresh.
 *
 * For every player in the `players` table that has a non-null `external_id`
 * (= TheSportsDB idPlayer):
 *   1. Fetch current player details from TheSportsDB v2 /lookup/player/{id}
 *   2. Fetch the team's most recent event via /schedule/previous/team/{teamId}
 *   3. Diff the result against the previous snapshot stored in
 *      meta_json.sportsdb_morning_snapshot
 *   4. Persist the new snapshot + any detected changes to meta_json
 *   5. Log a formatted diff report
 *
 * Rate limiting: 1 100 ms between API calls to respect the free tier (~1 req/s).
 * The job runs at 07:00 ET, after the 04:00 ESPN stats pull (refreshStats.ts)
 * and the 05:00 highlights backfill (highlightsCron.ts).
 */
import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../db/client.js';
import { lookupPlayer, getLastEventsForTeam } from '../services/sportsdb.js';
import type { SportsDbPlayer, SportsDbLiveScore } from '../services/sportsdb.js';

const RATE_DELAY_MS = 1_100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Snapshot shape ──────────────────────────────────────────────────────────

export interface SportsDbSnapshot {
  refreshed_at: string;
  team: string | null;
  team_id: string | null;
  position: string | null;
  status: string | null;
  last_event_id: string | null;
  last_event_date: string | null;
  last_event_name: string | null;
  last_event_home: string | null;
  last_event_away: string | null;
  last_score_home: string | null;
  last_score_away: string | null;
  last_event_result: 'W' | 'L' | 'D' | null;
}

export interface DiffEntry {
  field: string;
  from: unknown;
  to: unknown;
}

const DIFF_FIELDS: Array<keyof Omit<SportsDbSnapshot, 'refreshed_at'>> = [
  'team', 'position', 'status',
  'last_event_id', 'last_event_date', 'last_event_name',
  'last_score_home', 'last_score_away', 'last_event_result',
];

function diffSnapshots(prev: SportsDbSnapshot | null, next: SportsDbSnapshot): DiffEntry[] {
  if (!prev) return [{ field: 'initial_snapshot', from: null, to: 'seeded' }];
  return DIFF_FIELDS.reduce<DiffEntry[]>((acc, field) => {
    const from = prev[field] ?? null;
    const to = next[field] ?? null;
    if (String(from) !== String(to)) acc.push({ field, from, to });
    return acc;
  }, []);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveResult(
  playerTeam: string | null | undefined,
  event: SportsDbLiveScore,
): 'W' | 'L' | 'D' | null {
  if (!playerTeam) return null;
  const home = parseInt(String(event.intHomeScore ?? ''), 10);
  const away = parseInt(String(event.intAwayScore ?? ''), 10);
  if (isNaN(home) || isNaN(away)) return null;
  const isHome = event.strHomeTeam === playerTeam;
  const isAway = event.strAwayTeam === playerTeam;
  if (!isHome && !isAway) return null;
  const ps = isHome ? home : away;
  const os = isHome ? away : home;
  if (ps > os) return 'W';
  if (ps < os) return 'L';
  return 'D';
}

function buildSnapshot(
  apiPlayer: SportsDbPlayer,
  lastEvent: SportsDbLiveScore | null,
): SportsDbSnapshot {
  return {
    refreshed_at: new Date().toISOString(),
    team: apiPlayer.strTeam ?? null,
    team_id: apiPlayer.idTeam ?? null,
    position: apiPlayer.strPosition ?? null,
    status: apiPlayer.strStatus ?? null,
    last_event_id: lastEvent ? String(lastEvent.idEvent) : null,
    last_event_date: lastEvent?.dateEvent ?? null,
    last_event_name: lastEvent?.strEvent ?? null,
    last_event_home: lastEvent?.strHomeTeam ?? null,
    last_event_away: lastEvent?.strAwayTeam ?? null,
    last_score_home: lastEvent?.intHomeScore != null ? String(lastEvent.intHomeScore) : null,
    last_score_away: lastEvent?.intAwayScore != null ? String(lastEvent.intAwayScore) : null,
    last_event_result: lastEvent ? deriveResult(apiPlayer.strTeam, lastEvent) : null,
  };
}

// ─── Core refresh loop ───────────────────────────────────────────────────────

interface PlayerRow {
  id: string;
  external_id: string;
  full_name: string | null;
  meta_json: Record<string, unknown> | null;
}

export interface RefreshSummary {
  total: number;
  updated: number;
  unchanged: number;
  failed: number;
  diffs: Array<{ name: string; external_id: string; diff: DiffEntry[] }>;
}

async function refreshAllPlayers(log?: FastifyBaseLogger): Promise<RefreshSummary> {
  const { data, error } = await supabase
    .from('players')
    .select('id, external_id, full_name, meta_json')
    .not('external_id', 'is', null)
    .returns<PlayerRow[]>();

  if (error) {
    log?.error({ err: error }, '[morningPlayerRefresh] failed to load players');
    throw new Error(error.message);
  }

  const players = data ?? [];
  log?.info(`[morningPlayerRefresh] ${players.length} player(s) with sportsdb IDs`);

  const summary: RefreshSummary = {
    total: players.length,
    updated: 0,
    unchanged: 0,
    failed: 0,
    diffs: [],
  };

  for (const player of players) {
    try {
      await sleep(RATE_DELAY_MS);
      const apiPlayer = await lookupPlayer(player.external_id);
      if (!apiPlayer) {
        log?.warn(`[morningPlayerRefresh] ${player.full_name} (${player.external_id}): not found`);
        summary.failed++;
        continue;
      }

      let lastEvent: SportsDbLiveScore | null = null;
      if (apiPlayer.idTeam) {
        await sleep(RATE_DELAY_MS);
        const events = await getLastEventsForTeam(apiPlayer.idTeam);
        lastEvent = events[0] ?? null;
      }

      const snapshot = buildSnapshot(apiPlayer, lastEvent);
      const prev = (player.meta_json?.sportsdb_morning_snapshot as SportsDbSnapshot | null) ?? null;
      const diff = diffSnapshots(prev, snapshot);

      const newMeta: Record<string, unknown> = {
        ...(player.meta_json ?? {}),
        sportsdb_morning_snapshot: snapshot,
      };
      if (diff.length > 0 && prev !== null) {
        newMeta.sportsdb_last_diff = { detected_at: snapshot.refreshed_at, changes: diff };
      }

      const { error: updateErr } = await supabase
        .from('players')
        .update({ meta_json: newMeta })
        .eq('id', player.id);

      if (updateErr) {
        log?.warn({ err: updateErr }, `[morningPlayerRefresh] update failed: ${player.full_name}`);
        summary.failed++;
        continue;
      }

      const isFirstRun = prev === null;
      const hasRealChanges = !isFirstRun && diff.length > 0;

      if (hasRealChanges) {
        summary.updated++;
        summary.diffs.push({ name: player.full_name ?? player.external_id, external_id: player.external_id, diff });
      } else {
        summary.unchanged++;
        if (hasRealChanges) {
          summary.diffs.push({ name: player.full_name ?? player.external_id, external_id: player.external_id, diff });
        }
      }

      log?.debug(
        `[morningPlayerRefresh]   ${player.full_name} → ` +
        (isFirstRun ? 'seeded' : diff.length === 0 ? 'no changes' : `${diff.length} change(s)`),
      );
    } catch (err) {
      summary.failed++;
      log?.error({ err }, `[morningPlayerRefresh] error on ${player.full_name}`);
    }
  }

  return summary;
}

function logDiffReport(summary: RefreshSummary, log?: FastifyBaseLogger): void {
  const info = (msg: string): void => {
    if (log) log.info(msg);
    else console.log(msg);
  };

  info(
    `[morningPlayerRefresh] DONE — ${summary.total} total, ` +
    `${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.failed} failed`,
  );

  const changed = summary.diffs.filter((e) => e.diff.length > 0 && e.diff[0].field !== 'initial_snapshot');
  if (changed.length === 0) {
    info('[morningPlayerRefresh] No stat changes detected today.');
    return;
  }

  info(`[morningPlayerRefresh] ── Diff Report (${changed.length} player(s) changed) ──────────────`);
  for (const { name, diff } of changed) {
    info(`  ${name}`);
    for (const { field, from, to } of diff) {
      info(`    ${field.padEnd(26)} ${String(from ?? '—').padStart(14)} → ${to ?? '—'}`);
    }
  }
  info('[morningPlayerRefresh] ────────────────────────────────────────────────────────────────');
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export interface MorningPlayerRefreshHandle {
  stop: () => void;
}

/**
 * Wire up the 07:00 ET daily cron. Returns a handle to stop the task.
 * Called from src/index.ts after the server starts.
 */
export function startMorningPlayerRefresh(log?: FastifyBaseLogger): MorningPlayerRefreshHandle {
  const tz = 'America/New_York';
  const task = cron.schedule(
    '0 7 * * *',
    () => {
      log?.info('[morningPlayerRefresh] cron triggered');
      void refreshAllPlayers(log).then((summary) => logDiffReport(summary, log));
    },
    { timezone: tz },
  );
  log?.info('[morningPlayerRefresh] cron scheduled — 07:00 ET daily (after ESPN + highlights refresh)');
  return { stop: () => task.stop() };
}

/** Manually trigger a one-shot refresh outside the cron. */
export async function _runMorningPlayerRefreshNow(log?: FastifyBaseLogger): Promise<RefreshSummary> {
  const summary = await refreshAllPlayers(log);
  logDiffReport(summary, log);
  return summary;
}
