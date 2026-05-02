-- ============================================================
-- PlayGM Database Schema (v2 — 2026-04-27)
-- ============================================================
-- Production schema for the full domain model: multi-roster drafts,
-- three-pillar card economy, contests, alliances, COPPA, avatar shop,
-- box-score-grain stats. Pairs with DATA_ARCHITECTURE.md.
--
-- How to run:
--   Supabase: paste into Dashboard → SQL Editor → Run
--   psql:     psql $SUPABASE_DB_URL -f schema.sql
-- ============================================================

-- ─── Extensions ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- ─── Drop legacy v1 objects (idempotent reset) ──────────────────────────────
-- Order matters: views → tables → functions → types
DROP MATERIALIZED VIEW IF EXISTS scouting_reports CASCADE;
DROP MATERIALIZED VIEW IF EXISTS season_player_stats CASCADE;
DROP MATERIALIZED VIEW IF EXISTS user_pp_totals CASCADE;
DROP TABLE IF EXISTS sports_master_data CASCADE;

-- ─── Enums ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE subscription_tier AS ENUM ('free', 'starter', 'playmaker', 'champion');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE level_tier AS ENUM (
    'Peewee','Travel','JV','Varsity','Semi-Pro','Pro','Starter',
    'All-Star','MVP','Champion','Hall of Famer','Legend','GOAT'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE age_tier AS ENUM ('young', 'older');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ai_difficulty AS ENUM ('dummy', 'heuristic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sport_category AS ENUM ('basketball','football','baseball','hockey','soccer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE card_rarity AS ENUM ('common','rare','epic','legendary');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE scout_card_rarity AS ENUM ('common','rare','legendary');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE scout_card_category AS ENUM ('ABILITY','ATTRIBUTE','ROLE','EVENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE draft_mode AS ENUM ('snake','cap');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE draft_event_status AS ENUM ('open','in_progress','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE game_status AS ENUM ('scheduled','live','final','postponed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pack_type AS ENUM ('common','rare','epic','legendary','starter');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pack_source AS ENUM ('purchased','earned','gifted','contest_prize','starter_grant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE consent_method AS ENUM ('email_plus','credit_card','id_selfie','video_call');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE consent_status AS ENUM ('not_started','email_submitted','email_confirmed','verified','revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contest_scope AS ENUM ('alliance','regional','national','premium','invitational');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contest_submission_mode AS ENUM ('better_of','single');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contest_entry_status AS ENUM ('entered','locked','resolved','disqualified');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trade_status AS ENUM ('pending','accepted','rejected','expired','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alliance_role AS ENUM ('founder','member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pp_source AS ENUM (
    'draft_performance','contest_placement','h2h_win','trivia_correct',
    'streak_reward','achievement','practice_draft','daily_login'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_channel AS ENUM ('push','in_app','email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_status AS ENUM ('queued','sent','delivered','failed','suppressed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Shared functions ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

-- AdjectiveAnimalNN handle generator (kept from v1).
CREATE OR REPLACE FUNCTION generate_handle() RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  adjectives TEXT[] := ARRAY['Mighty','Swift','Bold','Brave','Calm','Clever','Cool','Daring',
    'Epic','Fast','Fierce','Grand','Great','Iron','Keen','Lucky','Noble','Quick','Sharp','Wild'];
  animals TEXT[] := ARRAY['Fox','Bear','Wolf','Eagle','Hawk','Lion','Tiger','Shark','Falcon',
    'Cobra','Panda','Moose','Bison','Lynx','Raven','Viper','Drake','Stag','Orca','Otter'];
  num INT;
BEGIN
  num := floor(random() * 90 + 10)::INT;
  RETURN adjectives[floor(random()*array_length(adjectives,1)+1)::INT]
      || animals[floor(random()*array_length(animals,1)+1)::INT]
      || num::TEXT;
END;
$$;

-- ISO-week label e.g. '2026-W17' — used as the partition key for card_applications.
CREATE OR REPLACE FUNCTION iso_week_label(ts TIMESTAMPTZ) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char(ts AT TIME ZONE 'UTC', 'IYYY-"W"IW');
$$;

-- =============================================================================
-- A. REFERENCE DATA — populated from TheSportsDB, public-read
-- =============================================================================

-- ─── leagues ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leagues (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     TEXT            NOT NULL UNIQUE,  -- SportsDB idLeague
  acronym         TEXT            NOT NULL UNIQUE,  -- 'NBA','NFL','MLB','NHL','MLS'
  name            TEXT            NOT NULL,         -- Editorial name
  generic_name    TEXT            NOT NULL,         -- '§2A: Pro Basketball' etc.
  category        sport_category  NOT NULL,
  country         TEXT,
  current_season  TEXT,                              -- e.g. '2025-2026'
  meta_json       JSONB           NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE TRIGGER leagues_updated_at BEFORE UPDATE ON leagues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── seasons ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seasons (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id       UUID            NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season_label    TEXT            NOT NULL,         -- '2025-2026'
  starts_on       DATE,
  ends_on         DATE,
  is_current      BOOLEAN         NOT NULL DEFAULT FALSE,
  meta_json       JSONB           NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (league_id, season_label)
);
CREATE INDEX seasons_current_idx ON seasons (league_id) WHERE is_current;

-- ─── venues ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS venues (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     TEXT            UNIQUE,           -- SportsDB idVenue when present
  name            TEXT            NOT NULL,
  city            TEXT,
  state_or_region TEXT,
  country         TEXT,
  capacity        INT,
  -- §2A IP: arena-exterior images flagged. Use city skyline alternative.
  skyline_url     TEXT,                              -- our owned/CC0 asset
  needs_ip_review BOOLEAN         NOT NULL DEFAULT TRUE,
  meta_json       JSONB           NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE TRIGGER venues_updated_at BEFORE UPDATE ON venues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── teams ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     TEXT            NOT NULL UNIQUE,  -- SportsDB idTeam
  league_id       UUID            NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  category        sport_category  NOT NULL,
  name            TEXT            NOT NULL,         -- 'Lakers'
  city            TEXT,                              -- 'Los Angeles'
  full_name       TEXT            NOT NULL,         -- 'Los Angeles Lakers'
  abbreviation    TEXT,                              -- 'LAL'
  primary_color   TEXT,                              -- '#552583'
  secondary_color TEXT,
  conference      TEXT,
  division        TEXT,
  venue_id        UUID            REFERENCES venues(id) ON DELETE SET NULL,
  -- §2A IP: never use SportsDB strBadge / strLogo. Original abstract mark only.
  brand_pack_url  TEXT,                              -- owned abstract team mark
  needs_ip_review BOOLEAN         NOT NULL DEFAULT FALSE,
  meta_json       JSONB           NOT NULL DEFAULT '{}',
  last_synced     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX teams_league_idx ON teams (league_id);
CREATE INDEX teams_category_idx ON teams (category);
CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── players ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     TEXT            NOT NULL UNIQUE,  -- SportsDB idPlayer
  team_id         UUID            REFERENCES teams(id) ON DELETE SET NULL,
  category        sport_category  NOT NULL,
  full_name       TEXT            NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  position        TEXT,
  jersey_number   INT,
  height_cm       INT,
  weight_kg       INT,
  date_of_birth   DATE,
  nationality     TEXT,
  rating          INT             CHECK (rating IS NULL OR rating BETWEEN 0 AND 100),
  -- §2A IP: photoUrl cutouts from SportsDB are real-player likenesses → forbidden.
  -- Leave NULL on populate; use position_silhouette_url from owned asset pack.
  photo_url       TEXT,
  silhouette_url  TEXT,
  is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
  meta_json       JSONB           NOT NULL DEFAULT '{}',
  last_synced     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX players_team_idx ON players (team_id);
CREATE INDEX players_category_idx ON players (category);
CREATE INDEX players_active_idx ON players (is_active);
CREATE INDEX players_name_search_idx ON players USING gin (to_tsvector('simple', full_name));
CREATE TRIGGER players_updated_at BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── player_team_history (trades, FA, retirements) ──────────────────────────
CREATE TABLE IF NOT EXISTS player_team_history (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id       UUID            NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id         UUID            REFERENCES teams(id) ON DELETE SET NULL,
  starts_on       DATE            NOT NULL,
  ends_on         DATE,
  reason          TEXT,                              -- 'trade','fa','draft','retire','release'
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX pth_player_idx ON player_team_history (player_id, starts_on DESC);

-- ─── games ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     TEXT            NOT NULL UNIQUE,  -- SportsDB idEvent
  league_id       UUID            NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season_id       UUID            REFERENCES seasons(id) ON DELETE SET NULL,
  category        sport_category  NOT NULL,
  date_event      DATE            NOT NULL,
  time_event      TIME,
  starts_at       TIMESTAMPTZ,                       -- materialized timestamp
  status          game_status     NOT NULL DEFAULT 'scheduled',
  home_team_id    UUID            REFERENCES teams(id) ON DELETE SET NULL,
  away_team_id    UUID            REFERENCES teams(id) ON DELETE SET NULL,
  home_score      INT,
  away_score      INT,
  venue_id        UUID            REFERENCES venues(id) ON DELETE SET NULL,
  meta_json       JSONB           NOT NULL DEFAULT '{}',
  last_synced     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX games_date_idx ON games (date_event);
CREATE INDEX games_league_date_idx ON games (league_id, date_event);
CREATE INDEX games_home_team_idx ON games (home_team_id, date_event);
CREATE INDEX games_away_team_idx ON games (away_team_id, date_event);
CREATE INDEX games_status_idx ON games (status) WHERE status IN ('scheduled','live');
CREATE TRIGGER games_updated_at BEFORE UPDATE ON games
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── team_game_stats ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_game_stats (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id         UUID            NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_id         UUID            NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  is_home         BOOLEAN         NOT NULL,
  points_scored   INT,
  stats_json      JSONB           NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, team_id)
);
CREATE INDEX tgs_team_idx ON team_game_stats (team_id);

-- ─── player_game_stats (the high-volume table) ──────────────────────────────
-- ~2M rows/yr. v1 single-table is fine. At 250K users / multi-year history,
-- migrate to declarative partitioning by date_event quarter:
--   CREATE TABLE player_game_stats (...) PARTITION BY RANGE (game_date);
--   CREATE TABLE player_game_stats_2026q1 PARTITION OF player_game_stats
--     FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS player_game_stats (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id         UUID            NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id       UUID            NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id         UUID            REFERENCES teams(id) ON DELETE SET NULL,
  game_date       DATE            NOT NULL,         -- denormalized for BRIN
  minutes_played  NUMERIC(5,2),
  fantasy_points  NUMERIC(8,2)    NOT NULL DEFAULT 0,
  did_play        BOOLEAN         NOT NULL DEFAULT TRUE,
  stats_json      JSONB           NOT NULL DEFAULT '{}', -- ppg/apg/passYards/etc raw
  source          TEXT            NOT NULL DEFAULT 'sportsdb', -- TheSportsDB only (no ESPN)
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, player_id)
);
CREATE INDEX pgs_player_date_idx ON player_game_stats (player_id, game_date DESC);
CREATE INDEX pgs_date_brin ON player_game_stats USING BRIN (game_date);

-- ─── standings ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS standings (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id       UUID            NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season_id       UUID            REFERENCES seasons(id) ON DELETE SET NULL,
  team_id         UUID            NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rank            INT,
  played          INT,
  wins            INT,
  losses          INT,
  draws           INT,
  goals_for       INT,
  goals_against   INT,
  goal_difference INT,
  points          INT,
  form            TEXT,                              -- e.g. 'WWLWD'
  meta_json       JSONB           NOT NULL DEFAULT '{}',
  last_synced     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (season_id, team_id)
);
CREATE INDEX standings_league_idx ON standings (league_id);

-- =============================================================================
-- B. USER IDENTITY & COMPLIANCE
-- =============================================================================

CREATE TABLE IF NOT EXISTS profiles (
  -- PK matches Supabase auth.uid() so RLS can use auth.uid() directly.
  id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  handle              TEXT                NOT NULL,
  initials            CHAR(2),
  birth_year          INT                 CHECK (birth_year IS NULL OR birth_year BETWEEN 2000 AND 2030),
  age_tier            age_tier            NOT NULL DEFAULT 'older',
  timezone            TEXT                NOT NULL DEFAULT 'UTC',
  region_code         TEXT,                            -- bucket only; no raw IP
  expo_push_token     TEXT,                            -- for push notifications
  -- Subscription (canonical 4-value enum — see GDD §8)
  subscription_tier   subscription_tier   NOT NULL DEFAULT 'free',
  -- Experience-level (13-tier ladder — see GDD §7)
  level_tier          level_tier          NOT NULL DEFAULT 'Peewee',
  level_index         INT                 NOT NULL DEFAULT 0 CHECK (level_index BETWEEN 0 AND 12),
  pp                  INT                 NOT NULL DEFAULT 0 CHECK (pp >= 0),
  -- Currencies
  play_points         INT                 NOT NULL DEFAULT 0 CHECK (play_points >= 0),
  -- Gameplay
  streak              INT                 NOT NULL DEFAULT 0,
  gm_grade            TEXT                NOT NULL DEFAULT 'C',
  avatar_emoji        TEXT                NOT NULL DEFAULT '🦊',
  -- Equipped cosmetics (FK → avatar_items by item_id text key)
  equipped_avatar     TEXT,
  equipped_jersey     TEXT,
  equipped_headband   TEXT,
  equipped_frame      TEXT,
  equipped_badges     JSONB               NOT NULL DEFAULT '[]', -- up to 3 ids
  -- Misc
  alliance_id         UUID,
  is_deleted          BOOLEAN             NOT NULL DEFAULT FALSE,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX profiles_handle_uidx ON profiles (handle) WHERE NOT is_deleted;
CREATE INDEX profiles_subscription_idx ON profiles (subscription_tier);
CREATE INDEX profiles_level_idx ON profiles (level_index);
CREATE INDEX profiles_alliance_idx ON profiles (alliance_id);
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── parent_consents ────────────────────────────────────────────────────────
-- Split out of profiles for audit retention after revoke.
CREATE TABLE IF NOT EXISTS parent_consents (
  id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID                NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status              consent_status      NOT NULL DEFAULT 'not_started',
  method              consent_method,
  parent_email_hash   TEXT,                            -- SHA256 — never plaintext
  requested_at        TIMESTAMPTZ,
  email_confirmed_at  TIMESTAMPTZ,
  verified_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  meta_json           JSONB               NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE TRIGGER parent_consents_updated_at BEFORE UPDATE ON parent_consents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── age_settings (parent dashboard toggles) ────────────────────────────────
CREATE TABLE IF NOT EXISTS age_settings (
  user_id                  UUID            PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  cap_mode_allowed         BOOLEAN         NOT NULL DEFAULT TRUE,
  external_contests_allowed BOOLEAN        NOT NULL DEFAULT TRUE,
  purchases_allowed        BOOLEAN         NOT NULL DEFAULT TRUE,
  updated_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE TRIGGER age_settings_updated_at BEFORE UPDATE ON age_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── favorite_teams ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS favorite_teams (
  user_id     UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  team_id     UUID            NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rank        INT             NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX favorite_teams_user_idx ON favorite_teams (user_id);

-- ─── pp_events (audit log; basis for user_pp_totals MV) ─────────────────────
CREATE TABLE IF NOT EXISTS pp_events (
  id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source      pp_source       NOT NULL,
  amount      INT             NOT NULL,
  ref_id      UUID,                                    -- generic ref to the originating row
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX pp_events_user_created_idx ON pp_events (user_id, created_at DESC);
CREATE INDEX pp_events_created_brin ON pp_events USING BRIN (created_at);

-- =============================================================================
-- C. SUBSCRIPTION & MONETIZATION
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID                NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tier                subscription_tier   NOT NULL,
  -- INTEGRATION FLAG: provider receipts (Apple/Google/RevenueCat) populate these.
  provider            TEXT                NOT NULL,    -- 'apple','google','revenuecat','manual'
  provider_subscription_id TEXT,                        -- store transaction id
  starts_at           TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  renews_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  is_active           BOOLEAN             NOT NULL DEFAULT TRUE,
  meta_json           JSONB               NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
CREATE INDEX subscriptions_user_active_idx ON subscriptions (user_id) WHERE is_active;
CREATE INDEX subscriptions_provider_idx ON subscriptions (provider, provider_subscription_id);
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── purchases (transaction log) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID                NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  product_sku         TEXT                NOT NULL,    -- 'pack.epic','token.bonus_roster',...
  amount_cents        INT                 NOT NULL CHECK (amount_cents >= 0),
  currency            TEXT                NOT NULL DEFAULT 'USD',
  provider            TEXT                NOT NULL,
  provider_txn_id     TEXT,
  refunded_at         TIMESTAMPTZ,
  meta_json           JSONB               NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
CREATE INDEX purchases_user_idx ON purchases (user_id, created_at DESC);
CREATE UNIQUE INDEX purchases_provider_txn_uidx ON purchases (provider, provider_txn_id)
  WHERE provider_txn_id IS NOT NULL;

-- ─── play_packs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS play_packs (
  id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  pack_type   pack_type       NOT NULL DEFAULT 'common',
  source      pack_source     NOT NULL DEFAULT 'purchased',
  gifted_by   UUID            REFERENCES profiles(id) ON DELETE SET NULL,
  opened_at   TIMESTAMPTZ,
  contents    JSONB           NOT NULL DEFAULT '[]',  -- card descriptors
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX play_packs_owner_unopened_idx ON play_packs (owner_id) WHERE opened_at IS NULL;

-- ─── bonus_roster_tokens ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bonus_roster_tokens (
  id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  obtained_at TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  week_lock   TEXT,                                    -- ISO-week 'YYYY-Www' or NULL
  redeemed_at TIMESTAMPTZ,
  redeemed_for_event_id UUID REFERENCES profiles(id),  -- weekly_draft_events.id (FK forward)
  meta_json   JSONB           NOT NULL DEFAULT '{}'
);
CREATE INDEX bonus_tokens_user_unredeemed_idx ON bonus_roster_tokens (user_id) WHERE redeemed_at IS NULL;

-- =============================================================================
-- D. CARDS — three-pillar economic engine (GDD §3.F)
-- =============================================================================

-- ─── scout_card_definitions (the 150-card library) ──────────────────────────
CREATE TABLE IF NOT EXISTS scout_card_definitions (
  id              TEXT                PRIMARY KEY,    -- e.g. 'ab_scouts_choice_1'
  name            TEXT                NOT NULL,
  flavor          TEXT                NOT NULL,
  rarity          scout_card_rarity   NOT NULL,
  affinity_tag    TEXT                NOT NULL,
  category        scout_card_category NOT NULL,
  logic           JSONB               NOT NULL DEFAULT '{}',
  set_label       TEXT                NOT NULL DEFAULT 'base-2026',
  is_active       BOOLEAN             NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
CREATE INDEX scd_category_idx ON scout_card_definitions (category);
CREATE INDEX scd_rarity_idx ON scout_card_definitions (rarity);

-- ─── owned_scout_cards ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS owned_scout_cards (
  id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID                NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  definition_id       TEXT                NOT NULL REFERENCES scout_card_definitions(id),
  -- Three-pillar state: see project_card_economics.md
  energy              INT                 NOT NULL DEFAULT 3 CHECK (energy BETWEEN 0 AND 3),
  last_used_at        TIMESTAMPTZ,                     -- 48-hr cooldown anchor
  obtained_at         TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  obtained_via        pack_source         NOT NULL DEFAULT 'purchased',
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
CREATE INDEX osc_owner_idx ON owned_scout_cards (owner_id);
CREATE INDEX osc_owner_last_used_idx ON owned_scout_cards (owner_id, last_used_at);
CREATE INDEX osc_definition_idx ON owned_scout_cards (definition_id);
CREATE TRIGGER owned_scout_cards_updated_at BEFORE UPDATE ON owned_scout_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── card_applications (THE one-card-one-slot ledger) ───────────────────────
-- Pillar #2 of the economy is enforced HERE in the database, not in app code.
-- A specific card instance can only appear in one row for any given week.
CREATE TABLE IF NOT EXISTS card_applications (
  id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id             UUID                NOT NULL REFERENCES owned_scout_cards(id) ON DELETE CASCADE,
  user_id             UUID                NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  roster_id           UUID                NOT NULL,    -- FK to rosters.id (forward)
  roster_player_id    UUID                NOT NULL,    -- FK to roster_players.id (forward)
  week_of             TEXT                NOT NULL,    -- ISO-week 'YYYY-Www'
  applied_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  cooldown_until      TIMESTAMPTZ         NOT NULL,    -- applied_at + 48h
  energy_pip_used     INT                 NOT NULL DEFAULT 1 CHECK (energy_pip_used BETWEEN 1 AND 3),
  removed_at          TIMESTAMPTZ,
  meta_json           JSONB               NOT NULL DEFAULT '{}'
);
-- The economy-defining constraint:
CREATE UNIQUE INDEX card_apps_one_slot_per_week_uidx
  ON card_applications (card_id, week_of)
  WHERE removed_at IS NULL;
CREATE INDEX card_apps_user_week_idx ON card_applications (user_id, week_of);
CREATE INDEX card_apps_roster_idx ON card_applications (roster_id);

-- =============================================================================
-- E. DRAFTING — multi-roster (GDD §3)
-- =============================================================================

CREATE TABLE IF NOT EXISTS weekly_draft_events (
  id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID                NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_of         TEXT                NOT NULL,        -- 'YYYY-Www'
  week_starts_on  DATE                NOT NULL,        -- Monday
  mode            draft_mode          NOT NULL DEFAULT 'snake',
  status          draft_event_status  NOT NULL DEFAULT 'open',
  -- Snake position rotation per roster, keyed by index:
  --   { "1": 7, "2": 22, "3": 14 }
  snake_positions JSONB               NOT NULL DEFAULT '{}',
  rosters_count   INT                 NOT NULL DEFAULT 2 CHECK (rosters_count BETWEEN 2 AND 3),
  uses_bonus_token BOOLEAN            NOT NULL DEFAULT FALSE,
  meta_json       JSONB               NOT NULL DEFAULT '{}',
  opened_at       TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  locked_at       TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, week_of)
);
CREATE INDEX wde_user_idx ON weekly_draft_events (user_id, week_starts_on DESC);
CREATE TRIGGER wde_updated_at BEFORE UPDATE ON weekly_draft_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── rosters ────────────────────────────────────────────────────────────────
-- bench_players + roster_free_agent_seed (added 2026-05-01):
--   * bench_players is a small TEXT[] (capped at 3 in app code) of
--     player_ids that were displaced from the active 5 by a free-agent
--     swap. The roster table stays the canonical record of the active
--     5 (via roster_players); bench is auxiliary state used by the
--     swap UX so the displaced player is not lost. We store as TEXT[]
--     (not a join table) because the cap is small and the read path is
--     single-roster + always-eager.
--   * roster_free_agent_seed is a stable UUID that seeds the
--     deterministic FA pool generator in services/freeAgents/pool.ts.
--     It's set once at roster creation and combined with
--     iso_week_label() so the same 20 FAs surface for the kid all week,
--     but the pool rolls every Monday.
CREATE TABLE IF NOT EXISTS rosters (
  id                       UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                 UUID                NOT NULL REFERENCES weekly_draft_events(id) ON DELETE CASCADE,
  user_id                  UUID                NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  roster_index             INT                 NOT NULL CHECK (roster_index BETWEEN 1 AND 3),
  name                     TEXT                NOT NULL,        -- defaults to 'Roster N'
  draft_mode               draft_mode          NOT NULL DEFAULT 'snake',
  cap_budget               INT,                                  -- only Cap mode
  cap_spent                INT                 NOT NULL DEFAULT 0,
  total_score              NUMERIC(10,2)       NOT NULL DEFAULT 0,
  is_locked                BOOLEAN             NOT NULL DEFAULT FALSE,
  bench_players            TEXT[]              NOT NULL DEFAULT '{}'
                            CHECK (array_length(bench_players, 1) IS NULL OR array_length(bench_players, 1) <= 3),
  roster_free_agent_seed   UUID                NOT NULL DEFAULT gen_random_uuid(),
  meta_json                JSONB               NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, roster_index)
);
CREATE INDEX rosters_user_idx ON rosters (user_id);
CREATE INDEX rosters_event_idx ON rosters (event_id);
CREATE TRIGGER rosters_updated_at BEFORE UPDATE ON rosters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Forward-compat ALTER for existing deployments that ran an earlier schema.
-- Idempotent: safe to re-run after the CREATE TABLE applies cleanly.
ALTER TABLE rosters
  ADD COLUMN IF NOT EXISTS bench_players TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS roster_free_agent_seed UUID NOT NULL DEFAULT gen_random_uuid();
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rosters_bench_players_max3_chk'
  ) THEN
    ALTER TABLE rosters
      ADD CONSTRAINT rosters_bench_players_max3_chk
      CHECK (array_length(bench_players, 1) IS NULL OR array_length(bench_players, 1) <= 3);
  END IF;
END $$;

-- ─── roster_players (the 8-slot roster contents) ────────────────────────────
CREATE TABLE IF NOT EXISTS roster_players (
  id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  roster_id       UUID                NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  user_id         UUID                NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  player_id       UUID                NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id         UUID                REFERENCES teams(id) ON DELETE SET NULL, -- denormalized for max-3-per-team check
  slot            INT                 NOT NULL CHECK (slot BETWEEN 1 AND 8),
  cap_price       INT,                                  -- only Cap mode
  is_benched      BOOLEAN             NOT NULL DEFAULT FALSE,
  weekly_score    NUMERIC(10,2)       NOT NULL DEFAULT 0,
  meta_json       JSONB               NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  UNIQUE (roster_id, slot)
);
CREATE INDEX rp_user_idx ON roster_players (user_id);
CREATE INDEX rp_player_idx ON roster_players (player_id);
CREATE INDEX rp_roster_team_idx ON roster_players (roster_id, team_id);
CREATE TRIGGER rp_updated_at BEFORE UPDATE ON roster_players
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── bench_replacements (nightly Free Agents per GDD §3.E.1) ────────────────
CREATE TABLE IF NOT EXISTS bench_replacements (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  roster_player_id    UUID            NOT NULL REFERENCES roster_players(id) ON DELETE CASCADE,
  replacement_player_id UUID          NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_date           DATE            NOT NULL,
  auto_assigned       BOOLEAN         NOT NULL DEFAULT FALSE,
  scored              NUMERIC(10,2)   NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (roster_player_id, game_date)
);

-- ─── draft_picks (full snake-draft history; audit) ──────────────────────────
CREATE TABLE IF NOT EXISTS draft_picks (
  id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  roster_id       UUID                NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  pick_number     INT                 NOT NULL,        -- 1..240
  round           INT                 NOT NULL,        -- 1..8
  drafter_index   INT                 NOT NULL,        -- 1..30
  is_kid          BOOLEAN             NOT NULL,        -- false = AI
  player_id       UUID                NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  ai_difficulty   ai_difficulty,                        -- only if AI pick
  picked_at       TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  UNIQUE (roster_id, pick_number)
);
CREATE INDEX draft_picks_roster_idx ON draft_picks (roster_id, pick_number);

-- =============================================================================
-- F. COMPETITION — contests, H2H, alliances, trades
-- =============================================================================

CREATE TABLE IF NOT EXISTS contests (
  id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT                NOT NULL,
  scope           contest_scope       NOT NULL,
  submission_mode contest_submission_mode NOT NULL,
  region_code     TEXT,                                  -- regional contests (geo bucket)
  theme           TEXT,                                  -- 'rookies-only', etc.
  min_level_index INT                 NOT NULL DEFAULT 0,
  entry_cost_pp   INT                 NOT NULL DEFAULT 0,
  entry_token_required BOOLEAN        NOT NULL DEFAULT FALSE,
  prize_summary   TEXT,
  opens_at        TIMESTAMPTZ         NOT NULL,
  locks_at        TIMESTAMPTZ         NOT NULL,
  resolves_at     TIMESTAMPTZ,
  alliance_id     UUID,                                  -- only for scope='alliance'
  meta_json       JSONB               NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
CREATE INDEX contests_window_idx ON contests (opens_at, locks_at);
CREATE INDEX contests_scope_level_idx ON contests (scope, min_level_index);

CREATE TABLE IF NOT EXISTS contest_entries (
  id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id              UUID            NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id                 UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  submitted_roster_id     UUID            REFERENCES rosters(id) ON DELETE SET NULL,
  status                  contest_entry_status NOT NULL DEFAULT 'entered',
  score                   NUMERIC(10,2)   NOT NULL DEFAULT 0,
  placement               INT,
  prize_meta              JSONB           NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (contest_id, user_id)
);
CREATE INDEX ce_user_idx ON contest_entries (user_id);
CREATE INDEX ce_contest_score_idx ON contest_entries (contest_id, score DESC);
CREATE TRIGGER ce_updated_at BEFORE UPDATE ON contest_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── h2h_matches (daily pairings) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS h2h_matches (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  game_date       DATE            NOT NULL,
  user_a_id       UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_b_id       UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_a_roster_id UUID           REFERENCES rosters(id) ON DELETE SET NULL,
  user_b_roster_id UUID           REFERENCES rosters(id) ON DELETE SET NULL,
  user_a_score    NUMERIC(10,2)   NOT NULL DEFAULT 0,
  user_b_score    NUMERIC(10,2)   NOT NULL DEFAULT 0,
  winner_id       UUID            REFERENCES profiles(id),
  resolved        BOOLEAN         NOT NULL DEFAULT FALSE,
  pp_payout       INT             NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  UNIQUE (game_date, user_a_id, user_b_id)
);
CREATE INDEX h2h_user_a_idx ON h2h_matches (user_a_id, game_date DESC);
CREATE INDEX h2h_user_b_idx ON h2h_matches (user_b_id, game_date DESC);

-- ─── alliances ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alliances (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT            NOT NULL,
  invite_code         TEXT            NOT NULL UNIQUE,
  created_by          UUID            REFERENCES profiles(id) ON DELETE SET NULL,
  max_members         INT             NOT NULL DEFAULT 10,
  weekly_mean_score   NUMERIC(10,2)   NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE TRIGGER alliances_updated_at BEFORE UPDATE ON alliances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS alliance_members (
  alliance_id UUID            NOT NULL REFERENCES alliances(id) ON DELETE CASCADE,
  user_id     UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        alliance_role   NOT NULL DEFAULT 'member',
  joined_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alliance_id, user_id)
);
CREATE INDEX alliance_members_user_idx ON alliance_members (user_id);

-- Add the FK from profiles → alliances now that alliances exists.
DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_alliance_fkey
    FOREIGN KEY (alliance_id) REFERENCES alliances(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── trade_proposals + trade_items ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_proposals (
  id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  proposer_id             UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  counterparty_id         UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  proposer_roster_id      UUID            NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  counterparty_roster_id  UUID            NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  status                  trade_status    NOT NULL DEFAULT 'pending',
  expires_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  resolved_at             TIMESTAMPTZ
);
CREATE INDEX trades_counterparty_pending_idx ON trade_proposals (counterparty_id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS trade_items (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id     UUID            NOT NULL REFERENCES trade_proposals(id) ON DELETE CASCADE,
  side            TEXT            NOT NULL CHECK (side IN ('proposer','counterparty')),
  player_id       UUID            NOT NULL REFERENCES players(id) ON DELETE CASCADE
);
CREATE INDEX trade_items_proposal_idx ON trade_items (proposal_id);

-- =============================================================================
-- G. ENGAGEMENT — trivia, avatar, streaks, notifications
-- =============================================================================

-- ─── trivia_questions (content authored in Cowork — see DATA_ARCHITECTURE.md) ─
CREATE TABLE IF NOT EXISTS trivia_questions (
  id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  source_question_id  TEXT                UNIQUE,        -- Cowork id for sync
  sport               sport_category      NOT NULL,
  category            TEXT                NOT NULL,
  question            TEXT                NOT NULL,
  choices             JSONB               NOT NULL,
  correct_idx         INT                 NOT NULL CHECK (correct_idx BETWEEN 0 AND 3),
  difficulty          TEXT                NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  media_url           TEXT,
  age_min             INT                 NOT NULL DEFAULT 5,
  age_max             INT                 NOT NULL DEFAULT 14,
  is_active           BOOLEAN             NOT NULL DEFAULT TRUE,
  meta_json           JSONB               NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
CREATE INDEX trivia_sport_difficulty_idx ON trivia_questions (sport, difficulty) WHERE is_active;
CREATE TRIGGER trivia_updated_at BEFORE UPDATE ON trivia_questions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS trivia_seen (
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES trivia_questions(id) ON DELETE CASCADE,
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, question_id)
);

CREATE TABLE IF NOT EXISTS trivia_results (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  question_id     UUID            NOT NULL REFERENCES trivia_questions(id) ON DELETE CASCADE,
  selected_idx    INT             NOT NULL,
  is_correct      BOOLEAN         NOT NULL,
  used_5050_hint  BOOLEAN         NOT NULL DEFAULT FALSE,
  used_insight    BOOLEAN         NOT NULL DEFAULT FALSE,
  pp_won          INT             NOT NULL DEFAULT 0,
  pp_spent        INT             NOT NULL DEFAULT 0,
  answered_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX trivia_results_user_idx ON trivia_results (user_id, answered_at DESC);

-- ─── avatar_items (the catalog from src/data/avatarCatalog.ts) ─────────────
CREATE TABLE IF NOT EXISTS avatar_items (
  id              TEXT                PRIMARY KEY,    -- e.g. 'avatar_scout_default'
  name            TEXT                NOT NULL,
  emoji           TEXT,
  category        TEXT                NOT NULL CHECK (category IN ('alternateAvatar','jersey','headband','frame','badge')),
  price_pp        INT                 NOT NULL DEFAULT 0,
  rarity          scout_card_rarity   NOT NULL DEFAULT 'common',
  description     TEXT,
  earned_by       TEXT,
  is_default      BOOLEAN             NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN             NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS owned_avatar_items (
  user_id     UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id     TEXT            NOT NULL REFERENCES avatar_items(id),
  obtained_at TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  obtained_via pack_source    NOT NULL DEFAULT 'purchased',
  PRIMARY KEY (user_id, item_id)
);

-- ─── daily_streaks ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_streaks (
  user_id         UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  streak_date     DATE            NOT NULL,
  streak_count    INT             NOT NULL,             -- the count AS OF this date
  PRIMARY KEY (user_id, streak_date)
);
CREATE INDEX streaks_user_idx ON daily_streaks (user_id, streak_date DESC);

-- ─── victory_reveals ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS victory_reveals (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID            NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  roster_id       UUID            REFERENCES rosters(id) ON DELETE CASCADE,
  player_id       UUID            REFERENCES players(id),
  game_id         UUID            REFERENCES games(id),
  points_won      INT             NOT NULL DEFAULT 0,
  seen            BOOLEAN         NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX victory_reveals_user_unseen_idx ON victory_reveals (user_id) WHERE NOT seen;

-- ─── notifications (outbound queue) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID                NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  channel         notification_channel NOT NULL,
  status          notification_status NOT NULL DEFAULT 'queued',
  template_key    TEXT                NOT NULL,         -- 'morning_reveal','contest_hype',etc
  payload         JSONB               NOT NULL DEFAULT '{}',
  scheduled_for   TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
CREATE INDEX notifications_due_idx ON notifications (scheduled_for) WHERE status='queued';
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- =============================================================================
-- H. OPERATIONS & TELEMETRY
-- =============================================================================

CREATE TABLE IF NOT EXISTS nightly_scoring_runs (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date        DATE            NOT NULL,
  started_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  rosters_scored  INT             NOT NULL DEFAULT 0,
  errors_count    INT             NOT NULL DEFAULT 0,
  notes           TEXT
);
CREATE INDEX nsr_date_idx ON nightly_scoring_runs (run_date DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL       PRIMARY KEY,
  actor_id        UUID            REFERENCES profiles(id) ON DELETE SET NULL,
  action          TEXT            NOT NULL,             -- 'consent.verify','asset.flag', etc.
  target_type     TEXT,
  target_id       TEXT,
  details         JSONB           NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_actor_idx ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_action_idx ON audit_log (action, created_at DESC);
CREATE INDEX audit_created_brin ON audit_log USING BRIN (created_at);

-- =============================================================================
-- MATERIALIZED VIEWS (refresh via cron)
-- =============================================================================

-- ─── season_player_stats — season totals for the Scouting Report ───────────
CREATE MATERIALIZED VIEW IF NOT EXISTS season_player_stats AS
SELECT
  p.id                                                  AS player_id,
  p.full_name,
  p.category,
  p.team_id,
  s.id                                                  AS season_id,
  s.season_label,
  COUNT(pgs.id)                                         AS games_played,
  COUNT(pgs.id) FILTER (WHERE pgs.did_play)             AS games_active,
  COALESCE(SUM(pgs.fantasy_points), 0)                  AS total_fantasy_points,
  COALESCE(AVG(pgs.fantasy_points) FILTER (WHERE pgs.did_play), 0) AS avg_fantasy_points,
  COALESCE(MAX(pgs.fantasy_points), 0)                  AS career_high_fp,
  -- Rank within sport (lower rank = better)
  RANK() OVER (
    PARTITION BY p.category, s.id
    ORDER BY COALESCE(AVG(pgs.fantasy_points) FILTER (WHERE pgs.did_play), 0) DESC
  )                                                      AS sport_rank
FROM players p
JOIN games g ON g.category = p.category
JOIN seasons s ON s.id = g.season_id
LEFT JOIN player_game_stats pgs ON pgs.game_id = g.id AND pgs.player_id = p.id
GROUP BY p.id, p.full_name, p.category, p.team_id, s.id, s.season_label;

CREATE UNIQUE INDEX season_player_stats_uidx ON season_player_stats (player_id, season_id);
CREATE INDEX season_player_stats_rank_idx ON season_player_stats (category, sport_rank);

-- ─── user_pp_totals — denormalized PP rollup ───────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS user_pp_totals AS
SELECT
  user_id,
  COALESCE(SUM(amount), 0)                              AS total_pp,
  MAX(created_at)                                       AS last_pp_at
FROM pp_events
GROUP BY user_id;

CREATE UNIQUE INDEX user_pp_totals_uidx ON user_pp_totals (user_id);

-- Helper function for cron.
CREATE OR REPLACE FUNCTION refresh_materialized_views() RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY season_player_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY user_pp_totals;
END;
$$;

-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================

-- Reference data: public read, no client write.
ALTER TABLE leagues             ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons             ENABLE ROW LEVEL SECURITY;
ALTER TABLE venues              ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams               ENABLE ROW LEVEL SECURITY;
ALTER TABLE players             ENABLE ROW LEVEL SECURITY;
ALTER TABLE games               ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_game_stats   ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_game_stats     ENABLE ROW LEVEL SECURITY;
ALTER TABLE standings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE scout_card_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE avatar_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trivia_questions    ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY p_read_all ON leagues             FOR SELECT USING (true);
  CREATE POLICY p_read_all ON seasons             FOR SELECT USING (true);
  CREATE POLICY p_read_all ON venues              FOR SELECT USING (true);
  CREATE POLICY p_read_all ON teams               FOR SELECT USING (true);
  CREATE POLICY p_read_all ON players             FOR SELECT USING (true);
  CREATE POLICY p_read_all ON games               FOR SELECT USING (true);
  CREATE POLICY p_read_all ON player_game_stats   FOR SELECT USING (true);
  CREATE POLICY p_read_all ON team_game_stats     FOR SELECT USING (true);
  CREATE POLICY p_read_all ON standings           FOR SELECT USING (true);
  CREATE POLICY p_read_all ON scout_card_definitions FOR SELECT USING (true);
  CREATE POLICY p_read_all ON avatar_items        FOR SELECT USING (true);
  CREATE POLICY p_read_all ON trivia_questions    FOR SELECT USING (is_active);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- User-owned rows: own-row policy.
ALTER TABLE profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_consents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE age_settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorite_teams          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pp_events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases               ENABLE ROW LEVEL SECURITY;
ALTER TABLE play_packs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE bonus_roster_tokens     ENABLE ROW LEVEL SECURITY;
ALTER TABLE owned_scout_cards       ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_applications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_draft_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rosters                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_players          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bench_replacements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_picks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE contest_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE h2h_matches             ENABLE ROW LEVEL SECURITY;
ALTER TABLE alliances               ENABLE ROW LEVEL SECURITY;
ALTER TABLE alliance_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_proposals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_items             ENABLE ROW LEVEL SECURITY;
ALTER TABLE trivia_seen             ENABLE ROW LEVEL SECURITY;
ALTER TABLE trivia_results          ENABLE ROW LEVEL SECURITY;
ALTER TABLE owned_avatar_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_streaks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE victory_reveals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications           ENABLE ROW LEVEL SECURITY;
ALTER TABLE contests                ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY profiles_own              ON profiles               USING (id = auth.uid()) WITH CHECK (id = auth.uid());
  CREATE POLICY parent_consents_own       ON parent_consents        USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY age_settings_own          ON age_settings           USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY favorite_teams_own        ON favorite_teams         USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY pp_events_own             ON pp_events              FOR SELECT USING (user_id = auth.uid());
  CREATE POLICY subscriptions_own         ON subscriptions          USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY purchases_own             ON purchases              FOR SELECT USING (user_id = auth.uid());
  CREATE POLICY play_packs_own            ON play_packs             USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
  CREATE POLICY bonus_tokens_own          ON bonus_roster_tokens    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY owned_scout_cards_own     ON owned_scout_cards      USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
  CREATE POLICY card_applications_own     ON card_applications      USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY wde_own                   ON weekly_draft_events    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY rosters_own               ON rosters                USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY roster_players_own        ON roster_players         USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY bench_replacements_own    ON bench_replacements
    USING (EXISTS (SELECT 1 FROM roster_players rp WHERE rp.id = bench_replacements.roster_player_id AND rp.user_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM roster_players rp WHERE rp.id = bench_replacements.roster_player_id AND rp.user_id = auth.uid()));
  CREATE POLICY draft_picks_own           ON draft_picks
    USING (EXISTS (SELECT 1 FROM rosters r WHERE r.id = draft_picks.roster_id AND r.user_id = auth.uid()));
  CREATE POLICY contest_entries_own       ON contest_entries        USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY h2h_matches_participant   ON h2h_matches            FOR SELECT USING (user_a_id = auth.uid() OR user_b_id = auth.uid());
  CREATE POLICY alliances_member_read     ON alliances              FOR SELECT
    USING (id IN (SELECT alliance_id FROM alliance_members WHERE user_id = auth.uid()));
  CREATE POLICY alliance_members_self     ON alliance_members
    USING (user_id = auth.uid() OR alliance_id IN (SELECT alliance_id FROM alliance_members WHERE user_id = auth.uid()));
  CREATE POLICY trade_proposals_party     ON trade_proposals
    USING (proposer_id = auth.uid() OR counterparty_id = auth.uid())
    WITH CHECK (proposer_id = auth.uid() OR counterparty_id = auth.uid());
  CREATE POLICY trade_items_party         ON trade_items
    USING (EXISTS (SELECT 1 FROM trade_proposals tp WHERE tp.id = trade_items.proposal_id
                   AND (tp.proposer_id = auth.uid() OR tp.counterparty_id = auth.uid())));
  CREATE POLICY trivia_seen_own           ON trivia_seen            USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY trivia_results_own        ON trivia_results         FOR SELECT USING (user_id = auth.uid());
  CREATE POLICY owned_avatar_items_own    ON owned_avatar_items     USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY daily_streaks_own         ON daily_streaks          FOR SELECT USING (user_id = auth.uid());
  CREATE POLICY victory_reveals_own       ON victory_reveals        USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  CREATE POLICY notifications_own         ON notifications          FOR SELECT USING (user_id = auth.uid());
  CREATE POLICY contests_eligibility_read ON contests               FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- COMMENTS — schema notes for future maintainers
-- =============================================================================

COMMENT ON TABLE  card_applications IS 'GDD §3.F: the global one-card-one-slot ledger. The UNIQUE INDEX on (card_id, week_of) WHERE removed_at IS NULL is the database-enforced economic pillar #2. Do not drop it.';
COMMENT ON COLUMN owned_scout_cards.last_used_at IS '48-hr cooldown anchor (GDD §3.F pillar #3). cooldown_until = last_used_at + 48h.';
COMMENT ON COLUMN players.photo_url IS '§2A.B: leave NULL on populate. SportsDB cutout images are real-player likenesses → forbidden.';
COMMENT ON COLUMN teams.brand_pack_url IS '§2A.C: original abstract team mark. Never set from SportsDB strBadge/strLogo.';
COMMENT ON COLUMN venues.skyline_url IS '§1 + §2A.B: city skyline photography (with naming-rights caveat for arena exteriors). Use owned/CC0 assets, not SportsDB venue images.';
COMMENT ON COLUMN trivia_questions.source_question_id IS 'Cowork question id. Authoring lives in Cowork; this table is a synced replica.';
COMMENT ON COLUMN subscriptions.provider IS 'INTEGRATION FLAG: RevenueCat / Apple / Google webhooks populate this. See DATA_ARCHITECTURE.md flag #2.';
