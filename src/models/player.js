const { getDb } = require('../db');

// ── Player CRUD ──────────────────────────────────────────────────────────────

function getAllPlayers() {
  return getDb().prepare('SELECT * FROM players ORDER BY name').all();
}

function getPlayerById(id) {
  return getDb().prepare('SELECT * FROM players WHERE id = ?').get(id);
}

function upsertPlayer({ sportsdb_id, name, team, sport, nationality, position }) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM players WHERE sportsdb_id = ?').get(sportsdb_id);
  if (existing) {
    db.prepare(`
      UPDATE players SET name=?, team=?, sport=?, nationality=?, position=?
      WHERE sportsdb_id=?
    `).run(name, team, sport, nationality, position, sportsdb_id);
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO players (sportsdb_id, name, team, sport, nationality, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sportsdb_id, name, team, sport, nationality, position);
  return info.lastInsertRowid;
}

// ── Stats snapshots ──────────────────────────────────────────────────────────

function getLatestSnapshot(playerId) {
  return getDb().prepare(`
    SELECT * FROM player_stats
    WHERE player_id = ?
    ORDER BY snapshot_at DESC
    LIMIT 1
  `).get(playerId);
}

function insertSnapshot(playerId, snap) {
  getDb().prepare(`
    INSERT INTO player_stats
      (player_id, team, position,
       last_event_id, last_event_date, last_event_name,
       last_event_home, last_event_away, last_score_home, last_score_away,
       last_event_result, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    playerId,
    snap.team,
    snap.position,
    snap.last_event_id,
    snap.last_event_date,
    snap.last_event_name,
    snap.last_event_home,
    snap.last_event_away,
    snap.last_score_home,
    snap.last_score_away,
    snap.last_event_result,
    snap.raw ? JSON.stringify(snap.raw) : null
  );
}

// ── Diff ─────────────────────────────────────────────────────────────────────

const DIFF_FIELDS = [
  'team', 'position',
  'last_event_id', 'last_event_date', 'last_event_name',
  'last_event_home', 'last_event_away',
  'last_score_home', 'last_score_away', 'last_event_result',
];

// Returns an array of { field, from, to } objects, or [] when nothing changed.
function diffSnapshots(prev, next) {
  if (!prev) return [{ field: 'initial_load', from: null, to: 'seeded' }];
  return DIFF_FIELDS.reduce((acc, field) => {
    const from = prev[field] ?? null;
    const to   = next[field] ?? null;
    if (String(from) !== String(to)) acc.push({ field, from, to });
    return acc;
  }, []);
}

// ── Refresh log ──────────────────────────────────────────────────────────────

function startRefreshLog() {
  const info = getDb().prepare(`
    INSERT INTO refresh_log (started_at) VALUES (datetime('now'))
  `).run();
  return info.lastInsertRowid;
}

function finishRefreshLog(logId, { total, updated, failed, diffSummary }) {
  getDb().prepare(`
    UPDATE refresh_log
    SET finished_at=datetime('now'), players_total=?, players_updated=?, players_failed=?, diff_summary=?
    WHERE id=?
  `).run(total, updated, failed, JSON.stringify(diffSummary), logId);
}

module.exports = {
  getAllPlayers, getPlayerById, upsertPlayer,
  getLatestSnapshot, insertSnapshot, diffSnapshots,
  startRefreshLog, finishRefreshLog,
};
