const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './playgm.db';

let db;

function getDb() {
  if (!db) {
    db = new Database(path.resolve(DB_PATH));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sportsdb_id TEXT    UNIQUE NOT NULL,
      name        TEXT    NOT NULL,
      team        TEXT,
      sport       TEXT,
      nationality TEXT,
      position    TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS player_stats (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      snapshot_at TEXT    NOT NULL DEFAULT (datetime('now')),
      -- core identity fields snapshotted for diffing
      team        TEXT,
      position    TEXT,
      -- player status (Active, Retired, On Loan, etc.)
      status      TEXT,
      -- last event result
      last_event_id     TEXT,
      last_event_date   TEXT,
      last_event_name   TEXT,
      last_event_home   TEXT,
      last_event_away   TEXT,
      last_score_home   TEXT,
      last_score_away   TEXT,
      last_event_result TEXT,
      -- raw json blob for any extra fields
      raw         TEXT
    );

    CREATE TABLE IF NOT EXISTS refresh_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      players_total   INTEGER DEFAULT 0,
      players_updated INTEGER DEFAULT 0,
      players_failed  INTEGER DEFAULT 0,
      diff_summary TEXT
    );
  `);

  // Additive column migrations for existing databases
  const cols = db.prepare('PRAGMA table_info(player_stats)').all().map((c) => c.name);
  if (!cols.includes('status')) {
    db.exec('ALTER TABLE player_stats ADD COLUMN status TEXT');
  }
}

module.exports = { getDb };
