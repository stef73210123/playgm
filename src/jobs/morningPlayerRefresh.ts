/**
 * morningPlayerRefresh.ts — daily 07:00 ET player stats + results refresh.
 *
 * For every player row in sports_master_data:
 *   1. Fetch the team's most recent event from TheSportsDB v2.
 *      (Calls are batched per unique team so N_teams API calls, not N_players.)
 *   2. Build a snapshot (team, position, last event, score, W/L/D result).
 *   3. Diff against the last stored snapshot from player_refresh_snapshots.
 *   4. Write the new snapshot; log the diff.
 *
 * Runs at 07:00 ET — after the 04:00 ET stats refresh and 05:00 ET highlights.
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

// ─── Rate limiting ────────────────────────────────────────────────────────────
// TheSportsDB free tier: ≈1 req/s.  V2 Patreon tiers are faster but we stay
// conservative — the morning job is not time-sensitive.
const RATE_DELAY_MS = 1100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Diff ─────────────────────────────────────────────────────────────────────

const DIFF_FIELDS = [
  'team',
  'position',
  'last_event_id',
  'last_event_date',
  'last_event_name',
  'last_score_home',
  'last_score_away',
  'last_event_result',
] as const;

type SnapField = (typeof DIFF_FIELDS)[number];

interface Snapshot {
  team: string | null;
  team_id: string | null;
  position: string | null;
  last_event_id: string | null;
  last_event_date: string | null;
  last_event_name: string | null;
  last_event_home: string | null;
  last_event_away: string | null;
  last_score_home: string | null;
  last_score_away: string | null;
  last_event_result: string | null;
  raw_json: object;
}

interface DiffEntry {
  field: SnapField | 'initial_load';
  from: string | null;
  to: string | null;
}

function deriveResult(teamName: string | null | undefined, event: SportsDbLiveScore): string | null {
  const home = parseInt(event.intHomeScore ?? '', 10);
  const away = parseInt(event.intAwayScore ?? '', 10);
  if (isNaN(home) || isNaN(away)) return null;

  const team = teamName ?? '';
  const isHome = event.strHomeTeam === team;
  const isAway = event.strAwayTeam === team;
  if (!isHome && !isAway) return null;

  const us = isHome ? home : away;
  const them = isHome ? away : home;
  return us > them ? 'W' : us < them ? 'L' : 'D';
}

function buildSnapshot(
  apiPlayer: SportsDbPlayer,
  lastEvent: SportsDbLiveScore | null,
): Snapshot {
  return {
    team: apiPlayer.strTeam ?? null,
    team_id: apiPlayer.idTeam ?? null,
    position: apiPlayer.strPosition ?? null,
    last_event_id: lastEvent?.idEvent ?? null,
    last_event_date: lastEvent?.dateEvent ?? null,
    last_event_name: lastEvent?.strEvent ?? null,
    last_event_home: lastEvent?.strHomeTeam ?? null,
    last_event_away: lastEvent?.strAwayTeam ?? null,
    last_score_home: lastEvent?.intHomeScore ?? null,
    last_score_away: lastEvent?.intAwayScore ?? null,
    last_event_result: lastEvent ? deriveResult(apiPlayer.strTeam, lastEvent) : null,
    raw_json: {
      player: {
        strNationality: apiPlayer.strNationality,
        strSport: apiPlayer.strSport,
        strStatus: apiPlayer.strStatus,
        dateBorn: apiPlayer.dateBorn,
      },
      event: lastEvent ?? null,
    },
  };
}

function diffSnapshots(
  prev: Record<string, unknown> | null,
  next: Snapshot,
): DiffEntry[] {
  if (!prev) return [{ field: 'initial_load', from: null, to: 'seeded' }];
  const nextRec = next as unknown as Record<string, string | null>;
  return DIFF_FIELDS.reduce<DiffEntry[]>((acc, field) => {
    const from = (prev[field] as string | null) ?? null;
    const to = nextRec[field] ?? null;
    if (String(from) !== String(to)) acc.push({ field, from, to });
    return acc;
  }, []);
}

// ─── Reporting ────────────────────────────────────────────────────────────────

interface DiffRecord {
  name: string;
  sportsdb_id: string;
  diff?: DiffEntry[];
  error?: string;
}

function printDiffReport(summary: DiffRecord[], log?: FastifyBaseLogger): void {
  const changed = summary.filter((e) => e.diff && e.diff.length > 0);
  const out = (s: string) => (log ? log.info(s) : console.log(s));

  if (changed.length === 0) {
    out('[morningRefresh] No stat changes detected today.');
    return;
  }

  out('── Diff Report ─────────────────────────────');
  for (const { name, diff } of changed) {
    out(`  ${name}`);
    for (const { field, from, to } of diff ?? []) {
      const label = field.replace(/_/g, ' ').padEnd(22);
      out(`    ${label} ${String(from ?? '—').padStart(10)} → ${to ?? '—'}`);
    }
  }
  out('────────────────────────────────────────────');
}

// ─── Core run ────────────────────────────────────────────────────────────────

export async function runMorningPlayerRefresh(log?: FastifyBaseLogger): Promise<void> {
  const info = (s: string) => (log ? log.info(s) : console.log(s));
  const warn = (s: string) => (log ? log.warn(s) : console.warn(s));
  const err  = (s: string) => (log ? log.error(s) : console.error(s));

  info(`\n=== Morning Player Refresh — ${new Date().toISOString()} ===`);

  // 1. Fetch all player rows from sports_master_data
  const { data: rows, error: fetchErr } = await supabase
    .from('sports_master_data')
    .select('external_id, name, team_id, meta_json')
    .eq('entity_type', 'player');

  if (fetchErr) {
    err(`[morningRefresh] Failed to fetch players: ${fetchErr.message}`);
    return;
  }

  interface PlayerRow { external_id: string; name: string; team_id: string | null; meta_json: unknown }
  const players = (rows ?? []) as PlayerRow[];
  if (players.length === 0) {
    info('[morningRefresh] No players in sports_master_data — skipping.');
    return;
  }

  info(`Refreshing ${players.length} player(s) across ${new Set(players.map((p) => p.team_id)).size} team(s)…`);

  // 2. Open a refresh log row
  const { data: logRow } = await supabase
    .from('player_refresh_log')
    .insert({ started_at: new Date().toISOString() })
    .select('id')
    .single();
  const logId = logRow?.id as number | undefined;

  // 3. Fetch last event per unique team (one API call per team, not per player)
  const teamIds = [...new Set(players.map((p) => p.team_id).filter((id): id is string => !!id))];
  const teamEventCache = new Map<string, SportsDbLiveScore | null>();

  info(`Fetching last events for ${teamIds.length} team(s)…`);
  for (const teamId of teamIds) {
    await sleep(RATE_DELAY_MS);
    try {
      const events = await getLastEventsForTeam(teamId);
      teamEventCache.set(teamId, events[0] ?? null);
    } catch (e) {
      warn(`[morningRefresh] team ${teamId} event fetch failed: ${(e as Error).message}`);
      teamEventCache.set(teamId, null);
    }
  }

  // 4. Fetch previous snapshots for all players in one query
  const sportsdbIds = players.map((p) => p.external_id);
  const { data: prevSnapRows } = await supabase
    .from('player_refresh_snapshots')
    .select('*')
    .in('sportsdb_id', sportsdbIds)
    .order('snapshot_at', { ascending: false });

  // Keep only the latest snapshot per player
  const prevSnapByPlayer = new Map<string, Record<string, unknown>>();
  for (const snap of prevSnapRows ?? []) {
    const id = snap.sportsdb_id as string;
    if (!prevSnapByPlayer.has(id)) prevSnapByPlayer.set(id, snap as Record<string, unknown>);
  }

  // 5. Per-player: lookup, snapshot, diff, insert
  const diffSummary: DiffRecord[] = [];
  let updated = 0;
  let failed  = 0;
  const newSnapshots: object[] = [];

  for (const row of players) {
    const sportsdbId = row.external_id;
    const playerName = row.name;
    const teamId     = row.team_id;

    try {
      await sleep(RATE_DELAY_MS);
      const apiPlayer = await lookupPlayer(sportsdbId);

      if (!apiPlayer) {
        warn(`  [skip] ${playerName} (${sportsdbId}) — not found on TheSportsDB`);
        failed++;
        continue;
      }

      const lastEvent = teamId ? (teamEventCache.get(apiPlayer.idTeam ?? teamId) ?? null) : null;
      const snapshot  = buildSnapshot(apiPlayer, lastEvent);
      const prev      = prevSnapByPlayer.get(sportsdbId) ?? null;
      const diff      = diffSnapshots(prev, snapshot);

      newSnapshots.push({ sportsdb_id: sportsdbId, ...snapshot });
      updated++;

      if (diff.length === 0 || (diff.length === 1 && diff[0].field === 'initial_load')) {
        info(`  ${playerName}: ${diff.length === 0 ? 'no changes' : 'initial load'}`);
      } else {
        info(`  ${playerName}: ${diff.length} change(s)`);
        for (const { field, from, to } of diff) {
          info(`    ${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
        }
        diffSummary.push({ name: playerName, sportsdb_id: sportsdbId, diff });
      }
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      err(`  [error] ${playerName}: ${msg}`);
      diffSummary.push({ name: playerName, sportsdb_id: sportsdbId, error: msg });
    }
  }

  // 6. Bulk-insert all new snapshots
  if (newSnapshots.length > 0) {
    const { error: insertErr } = await supabase
      .from('player_refresh_snapshots')
      .insert(newSnapshots);
    if (insertErr) err(`[morningRefresh] snapshot insert failed: ${insertErr.message}`);
  }

  // 7. Close the refresh log row
  if (logId !== undefined) {
    await supabase
      .from('player_refresh_log')
      .update({
        finished_at: new Date().toISOString(),
        players_total: players.length,
        players_updated: updated,
        players_failed: failed,
        diff_summary: diffSummary,
      })
      .eq('id', logId);
  }

  info(`\n=== Done — ${updated} updated, ${failed} failed ===`);
  printDiffReport(diffSummary, log);
}

// ─── Cron registration ────────────────────────────────────────────────────────

export function startMorningPlayerRefreshJob(log?: FastifyBaseLogger): void {
  cron.schedule(
    '0 7 * * *',
    () => { void runMorningPlayerRefresh(log); },
    { timezone: 'America/New_York' },
  );
  log?.info('[morningRefresh] cron registered — 07:00 ET daily');
}
