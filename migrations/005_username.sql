-- Migration 005 — add username column to profiles.
--
-- Context: Bug #3 — new sign-ups can leave the display-name field blank
-- and the client auto-generates a `Rookie-XXXX` handle. We persist that
-- value into a dedicated `username` column on profiles so it can be
-- queried by leaderboards / friend search without conflating with the
-- existing `handle` field (which is reserved for user-chosen handles
-- and may be reused by handle-changing flows in the future).
--
-- Idempotent — safe to re-run. The column is nullable for backfill of
-- pre-existing rows; new sign-ups always populate it from the client
-- upsert in SignUpScreen.tsx.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS username TEXT;

-- Unique index — partial on non-deleted rows so deleted handles can
-- be reclaimed. Mirrors the existing profiles_handle_uidx pattern.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_uidx
  ON profiles (username)
  WHERE NOT is_deleted AND username IS NOT NULL;

-- Backfill — any existing rows without a username inherit their handle
-- so legacy users still resolve when the client switches to reading
-- profiles.username. No-op for rows that already have one.
UPDATE profiles
SET username = handle
WHERE username IS NULL AND handle IS NOT NULL;
