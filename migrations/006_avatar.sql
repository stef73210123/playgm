-- Migration 006 — add avatar_id column to profiles.
--
-- Context: Bug #4 — kids can pick a preset avatar from a grid both on
-- the post-signup pre-Home flow and from ProfileScreen's tap-to-edit
-- affordance. The preset id (e.g. 'fox', 'lion', 'rocket') is the
-- canonical reference; the matching emoji is derived client-side from
-- AVATAR_PRESETS so we can swap glyphs/styled assets later without
-- a data migration.
--
-- Idempotent — safe to re-run.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS avatar_id TEXT;

-- No uniqueness constraint — many kids share the same preset id by
-- design (it's a coloring-book set, not a unique handle).

-- Backfill — leave NULL for existing rows. The client falls back to
-- avatarEmoji (legacy field) for any user without an avatar_id, so
-- the data is forward-compatible without a one-time backfill.
