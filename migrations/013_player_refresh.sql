-- 013_player_refresh.sql
--
-- Daily TheSportsDB player refresh snapshot tables.
--
-- Each morning job pass writes one row per player into
-- player_refresh_snapshots; the diff between successive rows drives the
-- diff report printed to the server log.  player_refresh_log records one
-- row per job run with summary counts and the full diff payload.
--
-- Intentionally separate from the sports_master_data table so that the
-- refresh cadence (daily, via TheSportsDB) stays decoupled from the
-- broader stats pipeline (ESPN / API-Sports).

-- ─── player_refresh_snapshots ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS player_refresh_snapshots (
  id                BIGSERIAL    PRIMARY KEY,
  sportsdb_id       TEXT         NOT NULL,
  snapshot_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  team              TEXT,
  team_id           TEXT,
  position          TEXT,
  last_event_id     TEXT,
  last_event_date   TEXT,
  last_event_name   TEXT,
  last_event_home   TEXT,
  last_event_away   TEXT,
  last_score_home   TEXT,
  last_score_away   TEXT,
  last_event_result TEXT,             -- 'W' | 'L' | 'D' | NULL
  raw_json          JSONB
);

CREATE INDEX IF NOT EXISTS player_refresh_snapshots_player_time_idx
  ON player_refresh_snapshots (sportsdb_id, snapshot_at DESC);

-- ─── player_refresh_log ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS player_refresh_log (
  id               BIGSERIAL    PRIMARY KEY,
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ,
  players_total    INTEGER      NOT NULL DEFAULT 0,
  players_updated  INTEGER      NOT NULL DEFAULT 0,
  players_failed   INTEGER      NOT NULL DEFAULT 0,
  diff_summary     JSONB
);
