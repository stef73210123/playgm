/**
 * Morning refresh job
 *
 * For every player in the DB:
 *   1. Fetch latest player details from thesportsdb
 *   2. Fetch their most recent team event/result (cached per team)
 *   3. Compare against the last stored snapshot (diff)
 *   4. Write a new snapshot only when something changed
 *   5. Write daily diff files to DIFF_DIR
 *
 * Runs standalone (`node src/jobs/morningRefresh.js`) or
 * is called by the cron scheduler in src/index.js.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { lookupPlayer, lastTeamEvents } = require('../api/sportsdb');
const {
  getAllPlayers, upsertPlayer,
  getLatestSnapshot, insertSnapshot,
  diffSnapshots,
  startRefreshLog, finishRefreshLog,
} = require('../models/player');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_DELAY_MS = 1100;
const DIFF_DIR = process.env.DIFF_DIR || './diffs';

// Per-run cache: one API call per team instead of one per player
let teamEventsCache = new Map();

function buildSnapshot(apiPlayer, lastEvent) {
  return {
    team:     apiPlayer.strTeam     || null,
    position: apiPlayer.strPosition || null,
    status:   apiPlayer.strStatus   || null,

    last_event_id:     lastEvent?.idEvent     || null,
    last_event_date:   lastEvent?.dateEvent   || null,
    last_event_name:   lastEvent?.strEvent    || null,
    last_event_home:   lastEvent?.strHomeTeam || null,
    last_event_away:   lastEvent?.strAwayTeam || null,
    last_score_home:   lastEvent?.intHomeScore ?? null,
    last_score_away:   lastEvent?.intAwayScore ?? null,
    last_event_result: deriveResult(apiPlayer, lastEvent),

    raw: {
      player: {
        strNationality:   apiPlayer.strNationality,
        strSport:         apiPlayer.strSport,
        strStatus:        apiPlayer.strStatus,
        dateBorn:         apiPlayer.dateBorn,
        strDescriptionEN: apiPlayer.strDescriptionEN,
      },
      event: lastEvent || null,
    },
  };
}

function deriveResult(player, event) {
  if (!event) return null;
  const home = parseInt(event.intHomeScore, 10);
  const away = parseInt(event.intAwayScore, 10);
  if (isNaN(home) || isNaN(away)) return null;

  const team   = player.strTeam || '';
  const isHome = event.strHomeTeam === team;
  const isAway = event.strAwayTeam === team;
  if (!isHome && !isAway) return null;

  const playerScore = isHome ? home : away;
  const oppScore    = isHome ? away : home;
  if (playerScore > oppScore) return 'W';
  if (playerScore < oppScore) return 'L';
  return 'D';
}

async function fetchLatestEvent(apiPlayer) {
  if (!apiPlayer.idTeam) return null;

  if (!teamEventsCache.has(apiPlayer.idTeam)) {
    await sleep(RATE_DELAY_MS);
    const events = await lastTeamEvents(apiPlayer.idTeam);
    // Sort descending so events[0] is always the most recent regardless of API order
    events.sort((a, b) => (b.dateEvent || '').localeCompare(a.dateEvent || ''));
    teamEventsCache.set(apiPlayer.idTeam, events);
  }

  const events = teamEventsCache.get(apiPlayer.idTeam);
  return events.length > 0 ? events[0] : null;
}

async function refreshPlayer(player) {
  await sleep(RATE_DELAY_MS);
  const apiPlayer = await lookupPlayer(player.sportsdb_id);
  if (!apiPlayer) {
    console.warn(`  [skip] ${player.name} — not found on sportsdb (id ${player.sportsdb_id})`);
    return { status: 'not_found', diff: [] };
  }

  upsertPlayer({
    sportsdb_id:  apiPlayer.idPlayer,
    name:         apiPlayer.strPlayer,
    team:         apiPlayer.strTeam,
    sport:        apiPlayer.strSport,
    nationality:  apiPlayer.strNationality,
    position:     apiPlayer.strPosition,
  });

  const lastEvent = await fetchLatestEvent(apiPlayer);
  const snapshot  = buildSnapshot(apiPlayer, lastEvent);
  const prev      = getLatestSnapshot(player.id);
  const diff      = diffSnapshots(prev, snapshot);

  // Only persist a new row when something actually changed — avoids daily duplicates
  if (diff.length > 0) {
    insertSnapshot(player.id, snapshot);
  }

  return { status: 'ok', diff };
}

function writeDiffFiles(dateStr, diffSummary) {
  fs.mkdirSync(DIFF_DIR, { recursive: true });

  const changed = diffSummary.filter((e) => e.diff && e.diff.length > 0);

  // JSON — machine-readable for downstream consumers
  const json = {
    date:         dateStr,
    generated_at: new Date().toISOString(),
    changes:      changed,
  };
  fs.writeFileSync(
    path.join(DIFF_DIR, `${dateStr}.json`),
    JSON.stringify(json, null, 2)
  );

  // TXT — human-readable aligned report
  const lines = [`Morning Refresh — ${dateStr}`, ''];
  if (changed.length === 0) {
    lines.push('No stat changes detected today.');
  } else {
    lines.push('── Diff Report ─────────────────────────────');
    changed.forEach(({ player, diff }) => {
      lines.push('');
      lines.push(`  ${player}`);
      diff.forEach(({ field, from, to }) => {
        const label = field.replace(/_/g, ' ');
        lines.push(`    ${label.padEnd(22)} ${String(from ?? '—').padStart(10)} → ${to ?? '—'}`);
      });
    });
    lines.push('');
    lines.push('────────────────────────────────────────────');
  }
  fs.writeFileSync(
    path.join(DIFF_DIR, `${dateStr}.txt`),
    lines.join('\n') + '\n'
  );
}

async function run() {
  const players = getAllPlayers();
  if (players.length === 0) {
    console.log('No players in DB — add players with `node src/seed.js "Player Name"` first.');
    return;
  }

  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  console.log(`\n=== Morning Refresh — ${now.toISOString()} ===`);
  console.log(`Refreshing ${players.length} player(s)…\n`);

  // Reset team cache so stale data never leaks across cron firings
  teamEventsCache = new Map();

  const logId       = startRefreshLog();
  const diffSummary = [];
  let updated = 0;
  let failed  = 0;

  for (const player of players) {
    try {
      console.log(`  → ${player.name} (sportsdb:${player.sportsdb_id})`);
      const { status, diff } = await refreshPlayer(player);

      if (status === 'not_found') {
        failed++;
        continue;
      }

      updated++;

      if (diff.length === 0) {
        console.log(`     no changes`);
      } else {
        console.log(`     diff (${diff.length} field${diff.length > 1 ? 's' : ''}):`);
        diff.forEach(({ field, from, to }) => {
          console.log(`       ${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
        });
        diffSummary.push({ player: player.name, sportsdb_id: player.sportsdb_id, diff });
      }
    } catch (err) {
      failed++;
      console.error(`  [error] ${player.name}: ${err.message}`);
      diffSummary.push({ player: player.name, sportsdb_id: player.sportsdb_id, error: err.message });
    }
  }

  finishRefreshLog(logId, {
    total:   players.length,
    updated,
    failed,
    diffSummary,
  });

  console.log(`\n=== Done — ${updated} updated, ${failed} failed ===\n`);
  printDiffReport(diffSummary);
  writeDiffFiles(dateStr, diffSummary);
  console.log(`Diff files written → ${DIFF_DIR}/${dateStr}.{txt,json}\n`);
}

function printDiffReport(diffSummary) {
  const changed = diffSummary.filter((e) => e.diff && e.diff.length > 0);
  if (changed.length === 0) {
    console.log('No stat changes detected today.');
    return;
  }
  console.log(`── Diff Report ─────────────────────────────`);
  changed.forEach(({ player, diff }) => {
    console.log(`\n  ${player}`);
    diff.forEach(({ field, from, to }) => {
      const label = field.replace(/_/g, ' ');
      console.log(`    ${label.padEnd(22)} ${String(from ?? '—').padStart(10)} → ${to ?? '—'}`);
    });
  });
  console.log('\n────────────────────────────────────────────\n');
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Refresh failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
