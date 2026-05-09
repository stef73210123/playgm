-- 011_previous_teams.sql
--
-- Adds the metadata columns the team-stats route needs to query player_stats
-- directly out of Supabase, plus the previous_teams[] array that captures
-- mid-season trade history.
--
-- Why these columns: dualWritePlayerStats currently only persists
-- (player_id, sport, season, stats_json, fetched_at). The team-route in
-- routes/statLines.ts builds its response off PlayerCacheEntry fields like
-- full_name, team_abbr, position, position_group — none of which exist as
-- queryable columns. We lift them out of the cache JSON into top-level
-- columns so:
--   1. WHERE team ILIKE '%lakers%' is indexed and fast.
--   2. The Supabase-backed branch of cacheLookup can reconstruct a full
--      PlayerCacheEntry without having to JSON-decode stats_json on every read.
--   3. previous_teams[] supports the "search by old team" use case (a kid
--      typing "Warriors" still finds Klay Thompson) via GIN on the array.
--
-- Backfill: stats_json today does NOT contain a 'team' key (the dualWrite
-- function only persists the stats Record). The backfill statements below
-- are no-ops on existing rows but kept defensively in case future writers
-- mirror the metadata into stats_json. Existing rows just get NULLed-out
-- top-level columns; the next NBA / MLB pull repopulates them.

alter table player_stats add column if not exists team             text;
alter table player_stats add column if not exists team_abbr        text;
alter table player_stats add column if not exists previous_teams   text[] default '{}'::text[] not null;
alter table player_stats add column if not exists full_name        text;
alter table player_stats add column if not exists position         text;
alter table player_stats add column if not exists position_group   text;
alter table player_stats add column if not exists jersey_number    int;
alter table player_stats add column if not exists bio_json         jsonb  default '{}'::jsonb not null;

-- Lower-case functional index so ILIKE '%foo%' on team is fast for short
-- nicknames ("Lakers") as well as full names ("Los Angeles Lakers").
create index if not exists player_stats_team_lower_idx
  on player_stats (lower(team));
create index if not exists player_stats_team_abbr_lower_idx
  on player_stats (lower(team_abbr));
-- GIN over previous_teams supports `'X' = ANY(previous_teams)` and the @>
-- contains operator. Substring search across array elements still requires
-- an unnest scan, but on ~600 NBA + ~750 MLB rows that's instant.
create index if not exists player_stats_previous_teams_gin_idx
  on player_stats using gin (previous_teams);

-- Defensive backfill: pull team out of stats_json IF a future writer ever
-- mirrors it there. Today this matches zero rows, which is fine — the
-- post-migration NBA / MLB re-pull populates all the new columns properly.
update player_stats
set    team           = coalesce(team,           stats_json->>'team'),
       team_abbr      = coalesce(team_abbr,      stats_json->>'team_abbr'),
       full_name      = coalesce(full_name,      stats_json->>'full_name'),
       position       = coalesce(position,       stats_json->>'position'),
       position_group = coalesce(position_group, stats_json->>'position_group')
where  team is null
   and stats_json ? 'team';
