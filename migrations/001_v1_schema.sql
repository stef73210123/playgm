-- ============================================================
-- 001_v1_schema.sql — PlayGM v1 schema migration
-- ============================================================
-- Applies the canonical v1 economy / v3 card runtime tables
-- documented in DATA_ARCHITECTURE.md ("Canonical schema for v1
-- economy / v3 card runtime — NOT YET APPLIED" section), plus
-- the dashboard / moderation / retention tables flagged
-- "unmeasured" by /admin/status.
--
-- This file is **idempotent**: re-running it is a no-op against
-- a DB that's already at this version.
--
-- Targets the canonical column names verbatim. Where the v1
-- runtime code (server/src/economy/*) and the admin dashboard
-- (server/src/services/economicMetrics.ts) disagreed on column
-- naming, both names are present so neither breaks:
--   pp_events.bonus_amount  — canonical (v1 runtime writes here)
--   pp_events.amount        — generated alias (admin reads here)
--
-- RLS model: every user-owned table enables RLS with an
-- own-row SELECT policy. INSERT/UPDATE happens through the
-- service role (which bypasses RLS), so writes from the
-- gameplay routes succeed without per-table write policies.
-- ============================================================

BEGIN;

-- ─── Helpers ────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Reused trigger function. schema.sql also defines this; CREATE OR REPLACE
-- makes it safe to run either order.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

-- ============================================================================
-- SECTION 1: PP / progression
-- ============================================================================

-- pp_events — append-only PP ledger.
-- Columns mirror DATA_ARCHITECTURE.md verbatim. `amount` is added as a
-- generated stored column so legacy admin code that reads pp_events.amount
-- continues to work without a code change.
CREATE TABLE IF NOT EXISTS pp_events (
  id            BIGSERIAL    PRIMARY KEY,
  user_id       UUID         NOT NULL,
  activity_key  TEXT,                              -- e.g. 'trivia_easy_correct'
  base_amount   INT          NOT NULL DEFAULT 0,   -- pre-multiplier
  multipliers   JSONB        NOT NULL DEFAULT '{}',-- { "subscription_daily_boost": 75 }
  bonus_amount  INT          NOT NULL DEFAULT 0,   -- signed PP delta to wallet
  source_ref    TEXT,                              -- e.g. 'trivia:q_123'
  -- Legacy: schema.sql had `source pp_source NOT NULL` + `amount INT NOT NULL`.
  -- Keep loose-typed `source` for compat with any pre-existing writers; the
  -- canonical writer populates activity_key/source_ref instead.
  source        TEXT,
  ref_id        UUID,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Generated alias for the legacy `amount` column. Done after table creation
-- so it's safe to add idempotently.
ALTER TABLE pp_events
  ADD COLUMN IF NOT EXISTS amount INT GENERATED ALWAYS AS (bonus_amount) STORED;

CREATE INDEX IF NOT EXISTS pp_events_user_idx
  ON pp_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pp_events_created_brin
  ON pp_events USING BRIN (created_at);

-- pp_wallet — denormalized per-user balance cache.
CREATE TABLE IF NOT EXISTS pp_wallet (
  user_id          UUID         PRIMARY KEY,
  current_balance  INT          NOT NULL DEFAULT 0,
  lifetime_earned  INT          NOT NULL DEFAULT 0,
  last_recalc_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  CREATE TRIGGER pp_wallet_updated_at BEFORE UPDATE ON pp_wallet
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- user_pp_totals — read-only aggregate. Spec says "view"; we use a
-- regular VIEW (not materialized) for freshness. Uses bonus_amount,
-- the canonical signed-delta column.
CREATE OR REPLACE VIEW user_pp_totals AS
  SELECT
    user_id,
    COALESCE(SUM(bonus_amount), 0) AS total_pp,
    MAX(created_at)                AS last_pp_at
  FROM pp_events
  GROUP BY user_id;

-- ============================================================================
-- SECTION 2: Cards / inventory / shards / pity
-- ============================================================================

-- card_inventory — per-user owned cards (template × player).
-- Distinct from the legacy owned_scout_cards table; this one carries the
-- player binding required by the v1 card runtime in src/economy/.
CREATE TABLE IF NOT EXISTS card_inventory (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      UUID         NOT NULL,
  template_id  TEXT         NOT NULL,                 -- → pgm_card_templates.json
  player_id    TEXT         NOT NULL,                 -- spec §6 player binding (TEXT to match runtime)
  art_variant  TEXT         NOT NULL DEFAULT 'default',
  owned_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, template_id, player_id, art_variant)
);
CREATE INDEX IF NOT EXISTS card_inventory_user_idx
  ON card_inventory (user_id);
CREATE INDEX IF NOT EXISTS card_inventory_template_idx
  ON card_inventory (template_id);
DO $$ BEGIN
  CREATE TRIGGER card_inventory_updated_at BEFORE UPDATE ON card_inventory
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- card_shards — per-user shard counts by rarity (5-rarity GDD spec).
-- Composite PK (user_id, rarity) per the canonical schema.
CREATE TABLE IF NOT EXISTS card_shards (
  user_id     UUID         NOT NULL,
  rarity      TEXT         NOT NULL CHECK (rarity IN ('common','uncommon','rare','epic','legendary')),
  count       INT          NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, rarity)
);
CREATE INDEX IF NOT EXISTS card_shards_user_idx
  ON card_shards (user_id);
DO $$ BEGIN
  CREATE TRIGGER card_shards_updated_at BEFORE UPDATE ON card_shards
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- pity_state — per-user pack-roll pity counters.
CREATE TABLE IF NOT EXISTS pity_state (
  user_id                  UUID         PRIMARY KEY,
  packs_since_rare_plus    INT          NOT NULL DEFAULT 0 CHECK (packs_since_rare_plus >= 0),
  cards_since_legendary    INT          NOT NULL DEFAULT 0 CHECK (cards_since_legendary >= 0),
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  CREATE TRIGGER pity_state_updated_at BEFORE UPDATE ON pity_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- SECTION 3: Streaks
-- ============================================================================

-- streak_state — per-user daily-login streak.
-- last_login_at is DATE per the canonical schema (UTC date used to detect
-- a break in the streak); the existing daily_streaks table tracks the
-- per-day ledger separately.
CREATE TABLE IF NOT EXISTS streak_state (
  user_id                       UUID         PRIMARY KEY,
  current_streak_days           INT          NOT NULL DEFAULT 0 CHECK (current_streak_days >= 0),
  longest_streak                INT          NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
  last_login_at                 DATE,
  streak_save_used_this_month   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  CREATE TRIGGER streak_state_updated_at BEFORE UPDATE ON streak_state
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- SECTION 4: card_applications additions for v1 validation cache
-- ============================================================================
-- DATA_ARCHITECTURE.md calls out two extra columns on the existing
-- card_applications (the "roster_card_assignments successor"):
--   energy_cost_total — sum of card_templates.energy_cost for this lock
--   legendary_used_this_week — true if this lock contributes the user's
--                              weekly Legendary
-- Both come from validateRoster(...).totals in server/src/economy/validation.ts.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'card_applications') THEN
    -- Best-effort idempotent add. ALTER … ADD COLUMN IF NOT EXISTS is
    -- supported on Postgres 9.6+ which is well within Supabase's range.
    ALTER TABLE card_applications
      ADD COLUMN IF NOT EXISTS energy_cost_total INT NOT NULL DEFAULT 0;
    ALTER TABLE card_applications
      ADD COLUMN IF NOT EXISTS legendary_used_this_week BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- ============================================================================
-- SECTION 5: Dashboard-flagged "unmeasured" tables
-- ============================================================================

-- play_picks — per-user "pick the player" gameplay (admin counts
-- play_picks_made and play_picks_correct_pct).
CREATE TABLE IF NOT EXISTS play_picks (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL,
  game_id      UUID,                              -- optional FK forward
  player_id    UUID,                              -- the player picked
  is_correct   BOOLEAN      NOT NULL DEFAULT FALSE,
  pp_awarded   INT          NOT NULL DEFAULT 0,
  picked_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS play_picks_user_idx
  ON play_picks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS play_picks_created_brin
  ON play_picks USING BRIN (created_at);

-- card_scans — image-recognition card scans (admin counts attempted vs matched).
CREATE TABLE IF NOT EXISTS card_scans (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID         NOT NULL,
  matched_template_id  TEXT,                       -- nullable: null = no match
  confidence           NUMERIC(5,2),               -- 0–100
  source               TEXT,                       -- 'camera','upload','test'
  raw_response         JSONB        NOT NULL DEFAULT '{}',
  scanned_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS card_scans_user_idx
  ON card_scans (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS card_scans_template_idx
  ON card_scans (matched_template_id) WHERE matched_template_id IS NOT NULL;

-- trivia_attempts — per-user per-question correct/incorrect ledger for
-- the moderation pass on trivia content. The runtime currently writes
-- trivia_results (with the question UUID FK); trivia_attempts uses the
-- question's source TEXT id (the JSON file id) so the moderation tooling
-- can roll up performance per source-file question even before that
-- question is synced into the trivia_questions table.
CREATE TABLE IF NOT EXISTS trivia_attempts (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL,
  question_id   TEXT         NOT NULL,            -- references trivia JSON file id
  sport         TEXT         NOT NULL,
  difficulty    TEXT         NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  is_correct    BOOLEAN      NOT NULL,
  pp_awarded    INT          NOT NULL DEFAULT 0,
  answered_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS trivia_attempts_user_idx
  ON trivia_attempts (user_id);
CREATE INDEX IF NOT EXISTS trivia_attempts_question_idx
  ON trivia_attempts (question_id);
CREATE INDEX IF NOT EXISTS trivia_attempts_answered_idx
  ON trivia_attempts (answered_at DESC);

-- sessions — active sessions table. Drives users_and_sessions.active_sessions_24h
-- on the dashboard.
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  client_platform TEXT,                            -- 'ios','android','web'
  client_version  TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx
  ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_last_seen_idx
  ON sessions (last_seen_at DESC);

-- subscription_events — upgrade/downgrade audit log for the tier-conversion
-- counters (subscriptions.starter_to_playmaker_upgrade_30d etc.).
CREATE TABLE IF NOT EXISTS subscription_events (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL,
  from_tier    TEXT,
  to_tier      TEXT,
  event_type   TEXT         NOT NULL CHECK (event_type IN ('upgrade','downgrade','cancel','reactivate')),
  source       TEXT,                                -- 'iap','manual_admin','churn'
  occurred_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  meta_json    JSONB        NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS subscription_events_user_idx
  ON subscription_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS subscription_events_type_idx
  ON subscription_events (event_type, occurred_at DESC);

-- signup_cohorts — view, not table. Reads from auth.users so retention math
-- matches the actual cohort populations (NOT public.profiles, which can lag).
CREATE OR REPLACE VIEW signup_cohorts AS
  SELECT DATE_TRUNC('day', created_at) AS cohort_day, COUNT(*) AS signups
  FROM auth.users
  GROUP BY cohort_day;

-- ============================================================================
-- SECTION 6: RLS — own-row SELECT, writes via service role
-- ============================================================================

ALTER TABLE pp_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pp_wallet            ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_inventory       ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_shards          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pity_state           ENABLE ROW LEVEL SECURITY;
ALTER TABLE streak_state         ENABLE ROW LEVEL SECURITY;
ALTER TABLE play_picks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_scans           ENABLE ROW LEVEL SECURITY;
ALTER TABLE trivia_attempts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY pp_events_own_select       ON pp_events
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY pp_wallet_own_select       ON pp_wallet
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY card_inventory_own_select  ON card_inventory
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY card_shards_own_select     ON card_shards
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY pity_state_own_select      ON pity_state
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY streak_state_own_select    ON streak_state
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY play_picks_own_select      ON play_picks
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY card_scans_own_select      ON card_scans
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY trivia_attempts_own_select ON trivia_attempts
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY sessions_own_select        ON sessions
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY subscription_events_own_select ON subscription_events
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- COMMENTS — for the moderation work + future maintainers
-- ============================================================================

-- Trivia source-of-truth currently lives in JSON files in /data/trivia.
-- When the moderation pass migrates that into the DB, add:
--   ALTER TABLE trivia_questions ADD COLUMN flagged_for_review BOOLEAN
--     NOT NULL DEFAULT FALSE;
-- and let the moderation tool flip the flag. trivia_attempts already
-- carries enough per-question data to drive a "review the worst-performing
-- 5%" UX without further schema changes.

COMMENT ON TABLE pp_events           IS 'v1 PP ledger. bonus_amount is canonical; amount is a generated alias for legacy admin reads.';
COMMENT ON TABLE pp_wallet           IS 'Denormalized PP balance cache. Source of truth: pp_events. Recompute via nightly job.';
COMMENT ON TABLE card_inventory      IS 'Per-user owned cards (template × player × art_variant). Distinct from owned_scout_cards.';
COMMENT ON TABLE card_shards         IS '5-rarity shard counts. Conversion costs in server/src/economy/shards.ts: 5/5/4/3/3.';
COMMENT ON TABLE pity_state          IS 'Pack-roll pity counters. Read by rollPack() in server/src/economy/packRoller.ts.';
COMMENT ON TABLE streak_state        IS 'Daily-login streak. streak_save_used_this_month is one-shot per calendar month.';
COMMENT ON TABLE play_picks          IS 'Pick-the-player gameplay attempts. Powers play_picks_made / play_picks_correct_pct dashboard tiles.';
COMMENT ON TABLE card_scans          IS 'Card-scanner attempts (matched_template_id null = no match). Powers card_scans_attempted / matched dashboard tiles.';
COMMENT ON TABLE trivia_attempts     IS 'Per-user per-source-question trivia ledger. question_id is the JSON-file id, NOT a FK to trivia_questions.';
COMMENT ON TABLE sessions            IS 'Active session ledger. Drives users_and_sessions.active_sessions_24h dashboard tile.';
COMMENT ON TABLE subscription_events IS 'Tier upgrade/downgrade audit. Drives subscriptions.starter_to_playmaker_upgrade_30d etc.';
COMMENT ON VIEW  user_pp_totals      IS 'Per-user PP rollup. Sums bonus_amount (the canonical signed delta).';
COMMENT ON VIEW  signup_cohorts      IS 'Daily signup cohort counts from auth.users. Drives d1/d7/d30 retention math.';

-- ============================================================================
-- SECTION 7: Live data ingestion + ratings (NOT YET APPLIED)
-- ============================================================================
-- These tables back the 5-league stats pipeline + per-player tier rating.
-- The runtime currently reads from the JSON caches in assets/stat-cache and
-- the JSON tier files in assets/stat-tiers — no DB roundtrip on the hot path.
-- After apply, the refresh job dual-writes JSON + DB. See DATA_ARCHITECTURE.md
-- "Live ingestion + ratings" section.

CREATE TABLE IF NOT EXISTS player_stats (
  player_id   TEXT          NOT NULL,           -- 'espn:12345' style external_id
  sport       TEXT          NOT NULL,           -- nfl/nba/mlb/nhl/mls
  season      TEXT          NOT NULL,           -- '2025', '2025-26', '2026'
  stats_json  JSONB         NOT NULL,
  fetched_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, sport, season)
);

CREATE INDEX IF NOT EXISTS idx_player_stats_sport_season
  ON player_stats (sport, season);

CREATE TABLE IF NOT EXISTS player_ratings (
  player_id        TEXT          NOT NULL,
  sport            TEXT          NOT NULL,
  season           TEXT          NOT NULL,
  overall_tier     TEXT          NOT NULL CHECK (overall_tier IN ('elite','strong','solid','role','deep_bench')),
  breakdowns_json  JSONB         NOT NULL,
  computed_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, sport, season)
);

CREATE INDEX IF NOT EXISTS idx_player_ratings_sport_tier
  ON player_ratings (sport, overall_tier);

COMMENT ON TABLE player_stats     IS 'Per-player season stats keyed by (player_id, sport, season). Source: jobs/refreshStats.ts.';
COMMENT ON TABLE player_ratings   IS 'Per-player tier rating (elite/strong/solid/role/deep_bench) computed from player_stats.';

-- ============================================================================
-- SECTION: Ask Scout per-day usage (LLM cap enforcement)
-- ============================================================================
-- One row per (user_id, UTC ymd). The /scout/ask route increments via UPSERT
-- before invoking Anthropic; rejections beyond the per-tier cap (see
-- data/economy/pgm_subscriptions.json#ask_scout_daily_cap) never consume a
-- credit. Rows persist past the day for /admin/status analytics.

CREATE TABLE IF NOT EXISTS ask_scout_usage (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ymd             DATE         NOT NULL,                          -- yyyy-mm-dd in UTC
  count           INTEGER      NOT NULL DEFAULT 0,
  last_request_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ask_scout_usage_user_day UNIQUE (user_id, ymd)
);

CREATE INDEX IF NOT EXISTS ix_ask_scout_usage_user
  ON ask_scout_usage (user_id);
-- BRIN on ymd for cheap "last 24h" / "last 30d" admin scans.
CREATE INDEX IF NOT EXISTS ix_ask_scout_usage_ymd_brin
  ON ask_scout_usage USING BRIN (ymd);

ALTER TABLE ask_scout_usage ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY ask_scout_usage_select_own ON ask_scout_usage
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Writes go through the service role (bypasses RLS), same pattern as
-- pp_events / card_inventory.

COMMENT ON TABLE ask_scout_usage IS 'Per-(user, UTC day) Ask Scout LLM call counts. Authoritative source for the daily cap enforced in server/src/services/askScoutLimiter.ts.';

-- ============================================================================
-- SECTION: Card Scan per-day usage (LLM cap enforcement)
-- ============================================================================
-- Mirror of ask_scout_usage. The /cards/scan route calls
-- cardScanLimiter.checkAndIncrement() before invoking Anthropic vision;
-- rejections beyond the per-tier cap (see
-- data/economy/pgm_subscriptions.json#card_scan_daily_cap) never burn LLM
-- spend. Rows persist past the day for /admin/status analytics.

CREATE TABLE IF NOT EXISTS card_scan_usage (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ymd             DATE         NOT NULL,                          -- yyyy-mm-dd in UTC
  count           INTEGER      NOT NULL DEFAULT 0,
  last_request_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_card_scan_usage_user_day UNIQUE (user_id, ymd)
);

CREATE INDEX IF NOT EXISTS ix_card_scan_usage_user
  ON card_scan_usage (user_id);
-- BRIN on ymd for cheap "last 24h" / "last 30d" admin scans.
CREATE INDEX IF NOT EXISTS ix_card_scan_usage_ymd_brin
  ON card_scan_usage USING BRIN (ymd);

ALTER TABLE card_scan_usage ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY card_scan_usage_select_own ON card_scan_usage
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Writes go through the service role (bypasses RLS), same pattern as
-- pp_events / card_inventory / ask_scout_usage.

COMMENT ON TABLE card_scan_usage IS 'Per-(user, UTC day) Card Scan vision call counts. Authoritative source for the daily cap enforced in server/src/services/cardScanLimiter.ts.';

-- ============================================================================
-- SECTION: Per-user safety matrix overrides
-- ============================================================================
-- Per-user feature overrides applied on top of the age-based safety matrix
-- (data/safety/age_feature_matrix.json). The matrix gives every age a
-- baseline allow / moderated / blocked / off decision per feature; this
-- table lets an admin push a specific user off that baseline for a single
-- feature with an audit trail (`reason`, `set_by_admin`).
--
-- Resolver layering (server/src/services/safetyResolver.ts):
--   1. Look up user.age (computed from profiles.birth_year)
--   2. Call resolveFeaturesForAge(age) → matrix-derived baseline
--   3. For every (user_id, feature_id) row here, override the baseline
--      with `enabled` (true → "allow", false → "blocked")
--   4. Cache the resulting effective set per-user for 5 min
--
-- NULL = inherit from the matrix (we never store NULLs — absence of a row
-- means inherit). An explicit boolean = override.
--
-- Writes go through the admin dashboard via the service role; RLS only
-- exposes a user's own rows for read so the client can show "you have
-- N overrides applied" if we ever want to surface that.

CREATE TABLE IF NOT EXISTS user_safety_overrides (
  id           UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature_id   TEXT         NOT NULL,
  enabled      BOOLEAN      NOT NULL,
  reason       TEXT,                                        -- audit: why was this overridden
  set_by_admin TEXT,                                        -- email or admin user id of the dashboard editor
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_safety_overrides_user_feature UNIQUE (user_id, feature_id)
);

CREATE INDEX IF NOT EXISTS ix_uso_user
  ON user_safety_overrides (user_id);

ALTER TABLE user_safety_overrides ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY uso_select_own ON user_safety_overrides
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Writes go through the service role (bypasses RLS), same pattern as
-- pp_events / card_inventory / ask_scout_usage.

COMMENT ON TABLE user_safety_overrides IS 'Per-user overrides on top of the age-based safety matrix. Resolver: server/src/services/safetyResolver.ts. Editor: GET /admin/edit/safety (Per-User tab).';

-- ============================================================================
-- SECTION: COPPA email-plus parental consent (2026-05-01)
-- ============================================================================
-- One row per consent request. Created when a user under 13 signs up via
-- the kid-safe SignUpScreen. The row sits with consent_received_at NULL
-- until the parent clicks the confirmation token in the email-plus mailer
-- (mailer integration is stubbed for v1 — see server/src/routes/auth.ts
-- TODO). consent_token is generated server-side and embedded in the
-- mailto link; parent_ip is captured on the consent landing page so we
-- can satisfy COPPA's "verifiable parental consent" record-keeping.

CREATE TABLE IF NOT EXISTS parental_consent_requests (
  id                   UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id              UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_email         TEXT         NOT NULL,
  child_age            INT          NOT NULL,
  requested_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  consent_received_at  TIMESTAMPTZ,
  consent_token        TEXT         UNIQUE,
  parent_ip            TEXT
);
CREATE INDEX IF NOT EXISTS ix_pcr_user
  ON parental_consent_requests(user_id);
ALTER TABLE parental_consent_requests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY pcr_select_own ON parental_consent_requests
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE parental_consent_requests IS 'COPPA email-plus consent requests. One row per minor signup. Mailer integration: server/src/routes/auth.ts (stubbed for v1).';

COMMIT;
