-- ============================================================
-- 008_display_name_and_roster_names.sql
-- ============================================================
-- COPPA-safe display nicknames + per-roster team names.
--
-- Two surfaces:
--   1. profiles.display_name           — kid-overridable nickname shown
--                                         instead of the auto Rookie-XXXX
--                                         username. Username (handle) stays
--                                         the immutable internal handle.
--   2. rosters.team_name                — per-roster label distinct from
--                                         the system-default `name`
--                                         ("Roster 1", "Roster 2", …).
--
-- Both fields pass through the `validateUserContent()` pipeline in
-- server/src/services/nicknameModeration.ts before they're persisted.
-- The `*_status` column is the moderation state machine:
--
--     pending  — default; not yet evaluated (or admin re-queued)
--     approved — passed every check (regex, profanity, PII, COPPA);
--                this is the value the client renders
--     rejected — failed at least one check; client falls back to the
--                immutable internal label and the kid sees a
--                "rejected" pill so they can retry
--
-- Idempotent — every column is ADD IF NOT EXISTS; CHECK constraints
-- are only added when missing. RLS: profiles already has own-row
-- SELECT, and rosters already has rosters_own — so display_name
-- and team_name are covered by existing policies. No new policies
-- required.
-- ============================================================

BEGIN;

-- ─── profiles.display_name ────────────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS display_name        TEXT,
  ADD COLUMN IF NOT EXISTS display_name_status TEXT NOT NULL DEFAULT 'pending';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_display_name_status_chk'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_display_name_status_chk
      CHECK (display_name_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

-- 20-char ceiling matches the client regex; guards against a buggy or
-- bypassed client that would persist a longer string.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_display_name_len_chk'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_display_name_len_chk
      CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 2 AND 20);
  END IF;
END $$;

-- Admin moderation queue reads `WHERE display_name_status IN ('pending','rejected')`
-- to surface every entry that needs review. Partial index keeps the
-- approved-row count out of the index.
CREATE INDEX IF NOT EXISTS profiles_display_name_status_idx
  ON profiles (display_name_status, updated_at DESC)
  WHERE display_name_status IN ('pending', 'rejected');

-- ─── rosters.team_name ────────────────────────────────────────────────────
-- The existing `rosters.name` column carries the system-default label
-- ("Roster 1", "Roster 2", "Roster 3" — set at creation time and used
-- internally for the snake-position rotation key). team_name is the
-- KID-AUTHORED override that gets rendered everywhere a roster is
-- shown — Trade screen, Draft screen, Scouting, Roster switcher.
-- Kept as a separate column so the system-default name is always
-- queryable for analytics / debugging without the moderation
-- pending/rejected branch.
ALTER TABLE rosters
  ADD COLUMN IF NOT EXISTS team_name        TEXT,
  ADD COLUMN IF NOT EXISTS team_name_status TEXT NOT NULL DEFAULT 'pending';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rosters_team_name_status_chk'
  ) THEN
    ALTER TABLE rosters
      ADD CONSTRAINT rosters_team_name_status_chk
      CHECK (team_name_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rosters_team_name_len_chk'
  ) THEN
    ALTER TABLE rosters
      ADD CONSTRAINT rosters_team_name_len_chk
      CHECK (team_name IS NULL OR char_length(team_name) BETWEEN 2 AND 20);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS rosters_team_name_status_idx
  ON rosters (team_name_status, updated_at DESC)
  WHERE team_name_status IN ('pending', 'rejected');

COMMIT;

-- ─── End of migration 008 ────────────────────────────────────────────────
