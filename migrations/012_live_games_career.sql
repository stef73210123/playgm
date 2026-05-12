-- 012_live_games_career.sql
--
-- Adds the four tables that retire the remaining client-side mocks:
--   games          — per-game record (scheduled + in-progress + final)
--   game_stats     — per-player per-game box-score line
--   player_career  — per-player career rollup (averages + teams_played_for)
--   team_records   — per-team current-season W-L (replaces mockTeams.ts hardcodes)
--
-- Keying conventions
-- ──────────────────
-- games.id              `${source}:${sport}:${api_game_id}`  e.g. 'apisports:nba:13571'
-- game_stats.player_id  matches player_stats.player_id        e.g. 'espn:1966'
--                        (apisports box-scores resolve api ids → espn ids at ingest;
--                         unresolved rows still write through with their api-sports id
--                         so we don't lose data, and the resolver retries on cron tick)
-- player_career.player_id  same — `espn:NNNNN` is the canonical player id everywhere
-- team_records.team_id  normalized mockTeams id e.g. 'lakers', 'chiefs', 'rangers-nhl'
--                        (collision-safe via the same {sport}-suffix convention
--                         the existing client mocks use)
--
-- Read paths
-- ──────────
-- All four tables are read by Fastify routes under server/src/routes/games.ts,
-- routes/playerCareer.ts (new rollup endpoint), and routes/teamRecords.ts.
-- The daily cron (server/src/jobs/refreshGames.ts) is the only writer for
-- games + game_stats + team_records; backfill-player-career.ts is the
-- one-time writer for player_career, after which it's refreshed weekly.

-- ─── games ───────────────────────────────────────────────────────────────────
create table if not exists games (
  id              text primary key,
  source          text not null,                  -- 'apisports' | 'espn'
  sport           text not null,                  -- 'nba' | 'nfl' | 'mlb' | 'nhl'
  season          text not null,                  -- '2025-26' | '2025' | '2026'
  game_date       date not null,
  status          text not null,                  -- 'scheduled' | 'inprogress' | 'final' | 'postponed' | 'canceled'
  home_team       text not null,
  home_team_abbr  text not null,
  home_score      integer,
  away_team       text not null,
  away_team_abbr  text not null,
  away_score      integer,
  source_game_id  text not null,                  -- raw api id used to refetch boxscore
  fetched_at      timestamptz not null default now()
);
create index if not exists games_sport_date_idx on games (sport, game_date desc);
create index if not exists games_status_idx     on games (status);
create index if not exists games_source_game_idx on games (source, source_game_id);

-- ─── game_stats ──────────────────────────────────────────────────────────────
-- One row per (game, player). stats_json shape mirrors player_stats.stats_json
-- so the same projector in routes/statLines.ts can render either surface.
create table if not exists game_stats (
  game_id     text not null references games(id) on delete cascade,
  player_id   text not null,
  player_name text,
  team        text not null,
  stats_json  jsonb not null default '{}'::jsonb,
  primary key (game_id, player_id)
);
create index if not exists game_stats_player_idx on game_stats (player_id);

-- ─── player_career ───────────────────────────────────────────────────────────
-- career_stats_json keys mirror the per-sport projector keys in routes/statLines.ts
--   NBA  → { ppg, rpg, apg, spg, bpg, threePM, fgPct, ftPct, gamesPlayed }
--   NFL  → { passYards, passTDs, rushYards, rushTDs, receptions, recYards, recTDs, interceptions, gamesPlayed }
--   MLB  → { avg, homeRuns, rbi, hits, strikeouts, era, wins, gamesPlayed }
--   NHL  → { goals, assists, plusMinus, savePct, gaa, wins, gamesPlayed }
-- teams_played_for is an ordered array of timeline entries, most-recent first:
--   [{ team: 'Los Angeles Lakers', team_abbr: 'LAL', year_start: 2018, year_end: null, is_current: true },
--    { team: 'Cleveland Cavaliers', team_abbr: 'CLE', year_start: 2014, year_end: 2018, is_current: false },
--    ...]
-- year_end null when is_current=true.
create table if not exists player_career (
  player_id          text primary key,
  sport              text not null,
  full_name          text not null,
  seasons_played     integer,
  career_stats_json  jsonb not null default '{}'::jsonb,
  teams_played_for   jsonb not null default '[]'::jsonb,
  is_active          boolean default true,
  fetched_at         timestamptz not null default now()
);
create index if not exists player_career_sport_idx on player_career (sport);

-- ─── team_records ────────────────────────────────────────────────────────────
-- One row per (team_id) — we only store the current season since the client
-- never shows historical W-L. team_id matches the canonical id in
-- src/data/mockTeams.ts so the client can key in directly via useTeamRecord.
create table if not exists team_records (
  team_id      text primary key,
  sport        text not null,
  season       text not null,
  wins         integer default 0,
  losses       integer default 0,
  ties         integer default 0,
  ot_losses    integer default 0,                 -- NHL only; 0 elsewhere
  win_pct      numeric,
  computed_at  timestamptz not null default now()
);
create index if not exists team_records_sport_idx on team_records (sport);
