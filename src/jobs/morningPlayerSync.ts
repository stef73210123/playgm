/**
 * morningPlayerSync.ts — daily TheSportsDB player stats & results refresh.
 *
 * Schedule: 07:00 ET every day (after the 03:30–06 stats/games/highlights jobs).
 *
 * For every player in the Supabase `players` table that has an `external_id`
 * (TheSportsDB idPlayer):
 *   1. Fetch the latest player record from TheSportsDB (/lookup/player/{id})
 *   2. Fetch the team's last events for the most recent result
 *   3. Diff the fetched values against the previous sync stored in
 *      `players.meta_json.sportsdb_sync`
 *   4. Write the new snapshot back to meta_json and emit a diff report
 *
 * Running standalone:
 *   npx tsx --import ./src/env-loader.ts src/jobs/morningPlayerSync.ts
 */

import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../db/client.js';
import {
  lookupPlayer,
  getLastEventsForTeam,
  type SportsDbPlayer,
  type SportsDbLiveScore,
} from '../services/sportsdb.js';

// 200 ms between calls — v2 is more generous than the free v1 rate limit
const RATE_DELAY_MS = 200;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Snapshot stored in players.meta_json.sportsdb_sync ─────────────────────

interface SyncSnapshot {
  synced_at: string;
  team: string | null;
  position: string | null;
  status: string | null;
  jersey_number: string | null;
  last_event_id: string | null;
  last_event_date: string | null;
  last_event_name: string | null;
  last_score_home: string | null;
  last_score_away: string | null;
  last_event_result: 'W' | 'L' | 'D' | null;
}

type DiffableField = keyof Omit<SyncSnapshot, 'synced_at'>;

const DIFF_FIELDS: DiffableField[] = [
  'team', 'position', 'status', 'jersey_number',
  'last_event_id', 'last_event_date', 'last_event_name',
  'last_score_home', 'last_score_away', 'last_event_result',
];

interface DiffEntry {
  field: string;
  from: string | null;
  to: string | null;
}

function diffSnapshots(prev: SyncSnapshot | null, next: SyncSnapshot): DiffEntry[] {
  if (!prev) return [{ field: 'initial_sync', from: null, to: 'seeded' }];
  return DIFF_FIELDS.reduce<DiffEntry[]>((acc, f) => {
    const from = prev[f] ?? null;
    const to   = next[f] ?? null;
    if (String(from) !== String(to)) acc.push({ field: f, from, to });
    return acc;
  }, []);
}

// ─── Snapshot helpers ────────────────────────────────────────────────────────

function deriveResult(
  playerTeam: string | undefined,
  event: SportsDbLiveScore,
): 'W' | 'L' | 'D' | null {
  if (!playerTeam) return null;
  const home = parseInt(event.intHomeScore ?? '', 10);
  const away = parseInt(event.intAwayScore ?? '', 10);
  if (isNaN(home) || isNaN(away)) return null;

  const isHome = event.strHomeTeam === playerTeam;
  const isAway = event.strAwayTeam === playerTeam;
  if (!isHome && !isAway) return null;

  const playerScore = isHome ? home : away;
  const oppScore    = isHome ? away : home;
  if (playerScore > oppScore) return 'W';
  if (playerScore < oppScore) return 'L';
  return 'D';
}

function buildSnapshot(
  apiPlayer: SportsDbPlayer,
  lastEvent: SportsDbLiveScore | null,
): SyncSnapshot {
  return {
    synced_at:         new Date().toISOString(),
    team:              apiPlayer.strTeam       ?? null,
    position:          apiPlayer.strPosition   ?? null,
    status:            apiPlayer.strStatus     ?? null,
    jersey_number:     apiPlayer.strNumber     ?? null,
    last_event_id:     lastEvent?.idEvent      ?? null,
    last_event_date:   lastEvent?.dateEvent    ?? null,
    last_event_name:   lastEvent?.strEvent     ?? null,
    last_score_home:   lastEvent?.intHomeScore ?? null,
    last_score_away:   lastEvent?.intAwayScore ?? null,
    last_event_result: lastEvent
      ? deriveResult(apiPlayer.strTeam, lastEvent)
      : null,
  };
}

// ─── Per-player sync ─────────────────────────────────────────────────────────

interface PlayerRow {
  id: string;
  full_name: string;
  external_id: string;
  meta_json: Record<string, unknown>;
}

async function syncPlayer(
  player: PlayerRow,
): Promise<{ status: 'ok' | 'not_found'; diff: DiffEntry[] }> {
  await sleep(RATE_DELAY_MS);
  const apiPlayer = await lookupPlayer(player.external_id);
  if (!apiPlayer) {
    return { status: 'not_found', diff: [] };
  }

  let lastEvent: SportsDbLiveScore | null = null;
  if (apiPlayer.idTeam) {
    await sleep(RATE_DELAY_MS);
    const events = await getLastEventsForTeam(apiPlayer.idTeam);
    lastEvent = events[0] ?? null;
  }

  const snapshot = buildSnapshot(apiPlayer, lastEvent);
  const prev     = (player.meta_json?.['sportsdb_sync'] as SyncSnapshot | undefined) ?? null;
  const diff     = diffSnapshots(prev, snapshot);

  const { error } = await supabase
    .from('players')
    .update({ meta_json: { ...(player.meta_json ?? {}), sportsdb_sync: snapshot } })
    .eq('id', player.id);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  return { status: 'ok', diff };
}

// ─── Diff report ─────────────────────────────────────────────────────────────

function printDiffReport(
  summary: Array<{ player: string; diff: DiffEntry[] }>,
  log: (msg: string) => void,
): void {
  const changed = summary.filter((e) => e.diff.some((d) => d.field !== 'initial_sync'));
  if (changed.length === 0) {
    log('[morningPlayerSync] No stat changes detected today.');
    return;
  }
  log('── Diff Report ──────────────────────────────────────────────────');
  for (const { player, diff } of changed) {
    log(`\n  ${player}`);
    for (const { field, from, to } of diff) {
      const label = field.replace(/_/g, ' ');
      log(`    ${label.padEnd(24)} ${String(from ?? '—').padStart(12)} → ${to ?? '—'}`);
    }
  }
  log('\n─────────────────────────────────────────────────────────────────\n');
}

// ─── Main run ─────────────────────────────────────────────────────────────────

export async function runMorningPlayerSync(log?: FastifyBaseLogger): Promise<void> {
  const info  = (msg: string) => log ? log.info(msg)  : console.log(msg);
  const warn  = (msg: string) => log ? log.warn(msg)  : console.warn(msg);
  const error = (msg: string) => log ? log.error(msg) : console.error(msg);

  const { data: players, error: fetchErr } = await supabase
    .from('players')
    .select('id, full_name, external_id, meta_json')
    .not('external_id', 'is', null);

  if (fetchErr) throw new Error(`Failed to fetch players: ${fetchErr.message}`);
  if (!players || players.length === 0) {
    info('[morningPlayerSync] no players in DB — skipping');
    return;
  }

  info(`\n=== Morning Player Sync — ${new Date().toISOString()} ===`);
  info(`Syncing ${players.length} player(s) from TheSportsDB…\n`);

  let updated  = 0;
  let notFound = 0;
  let failed   = 0;
  const diffSummary: Array<{ player: string; diff: DiffEntry[] }> = [];

  for (const player of players as PlayerRow[]) {
    try {
      info(`  → ${player.full_name} (sportsdb:${player.external_id})`);
      const { status, diff } = await syncPlayer(player);

      if (status === 'not_found') {
        warn(`     not found on TheSportsDB`);
        notFound++;
        continue;
      }

      updated++;
      if (diff.length === 0) {
        info(`     no changes`);
      } else {
        info(`     diff (${diff.length} field${diff.length > 1 ? 's' : ''}):`);
        for (const { field, from, to } of diff) {
          info(`       ${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
        }
        diffSummary.push({ player: player.full_name, diff });
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      error(`  [error] ${player.full_name}: ${msg}`);
    }
  }

  info(`\n=== Done — ${updated} updated, ${notFound} not found on SportsDB, ${failed} errored ===\n`);
  printDiffReport(diffSummary, info);
}

// ─── Cron registration ────────────────────────────────────────────────────────

export function startMorningPlayerSync(log?: FastifyBaseLogger): void {
  // 07:00 ET daily — after the 03:30–06:00 stats / games / highlights jobs
  cron.schedule(
    '0 7 * * *',
    () => {
      (log ? (m: string) => log.info(m) : console.log)(
        `[cron] morningPlayerSync triggered at ${new Date().toISOString()}`,
      );
      runMorningPlayerSync(log).catch((err) => {
        (log ? (m: unknown) => log.error(m) : console.error)(
          `[cron] morningPlayerSync failed: ${err}`,
        );
      });
    },
    { timezone: 'America/New_York' },
  );
  (log ? (m: string) => log.info(m) : console.log)(
    '[morningPlayerSync] registered — schedule: daily 07:00 ET',
  );
}

// Allow direct one-shot execution:
//   npx tsx --import ./src/env-loader.ts src/jobs/morningPlayerSync.ts
const isMain =
  process.argv[1]?.endsWith('morningPlayerSync.ts') ||
  process.argv[1]?.endsWith('morningPlayerSync.js');

if (isMain) {
  runMorningPlayerSync().catch((err) => {
    console.error('Sync failed:', err);
    process.exit(1);
  });
}
