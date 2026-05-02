-- 002_grade_rename.sql
-- ----------------------------------------------------------------------------
-- Rename `player_ratings.overall_tier` (5-tier name) → `overall_grade` (13-grade letter).
-- Idempotent: safe to re-run after the column has already been renamed.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  has_old BOOLEAN;
  has_new BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'player_ratings' AND column_name = 'overall_tier'
  ) INTO has_old;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'player_ratings' AND column_name = 'overall_grade'
  ) INTO has_new;

  -- Drop the v1 CHECK constraint before renaming so the new letter values
  -- don't trip it. The constraint name from 001_v1_schema.sql is the
  -- auto-generated `player_ratings_overall_tier_check`.
  IF has_old THEN
    BEGIN
      EXECUTE 'ALTER TABLE player_ratings DROP CONSTRAINT IF EXISTS player_ratings_overall_tier_check';
    EXCEPTION WHEN OTHERS THEN
      -- Some DBs may name it differently; the constraint will be replaced below regardless.
      NULL;
    END;
  END IF;

  IF has_old AND NOT has_new THEN
    EXECUTE 'ALTER TABLE player_ratings RENAME COLUMN overall_tier TO overall_grade';
  END IF;
END $$;

-- Drop the old index (keyed on overall_tier) and recreate on overall_grade.
DROP INDEX IF EXISTS idx_player_ratings_sport_tier;
CREATE INDEX IF NOT EXISTS idx_player_ratings_sport_grade
  ON player_ratings (sport, overall_grade);

-- Add a CHECK constraint for the 13-grade ladder. We keep the v1 names in the
-- accepted set for two cycles so existing rows aren't invalidated before the
-- recompute job rewrites them.
DO $$
BEGIN
  -- Drop a previous version of the new constraint if it exists.
  EXECUTE 'ALTER TABLE player_ratings DROP CONSTRAINT IF EXISTS player_ratings_overall_grade_check';
  EXECUTE $C$
    ALTER TABLE player_ratings
      ADD CONSTRAINT player_ratings_overall_grade_check
      CHECK (overall_grade IN (
        'A+','A','A-',
        'B+','B','B-',
        'C+','C','C-',
        'D+','D','D-',
        'F',
        -- legacy v1 names — accepted during the transition window.
        'elite','strong','solid','role','deep_bench'
      ))
  $C$;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

COMMENT ON TABLE  player_ratings IS 'Per-player rating on the 13-grade A+ → F ladder, computed from player_stats.';
COMMENT ON COLUMN player_ratings.overall_grade IS '13-grade letter: A+ (top 5%) … F (bottom 2%).';
