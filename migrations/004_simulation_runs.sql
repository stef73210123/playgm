-- ============================================================
-- 004_simulation_runs.sql — Fairness simulator run history
-- ============================================================
-- Backs the /admin/simulate run history + /admin/dashboard trend
-- line. Each row captures one simulation run: the formula snapshot
-- it was scored against, the leagues it spanned, the resulting
-- fairness metrics, and the full results payload (histogram bins,
-- per-season breakdown, sample top rosters).
--
-- This file is **idempotent**: safe to re-run against any DB.
--
-- Persistence is best-effort from the simulator service — the run
-- still completes (and is visible in-process via /admin/api/simulate/:id)
-- even if Supabase isn't configured. Production sets SUPABASE_URL +
-- SUPABASE_SERVICE_KEY so every run lands here for trend analysis.
--
-- RLS: locked down. Reads + writes go through the service role.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS simulation_runs (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_version       TEXT,
  formula_snapshot      JSONB,
  seasons_simulated     TEXT[],
  synthetic_user_count  INT,
  started_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  status                TEXT         CHECK (status IN ('running', 'completed', 'failed')),
  results_json          JSONB,
  fairness_score        NUMERIC
);

CREATE INDEX IF NOT EXISTS ix_simulation_runs_started_at
  ON simulation_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS ix_simulation_runs_status
  ON simulation_runs (status);
CREATE INDEX IF NOT EXISTS ix_simulation_runs_completed_at
  ON simulation_runs (completed_at DESC);

ALTER TABLE simulation_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  -- No SELECT/INSERT policy for end users — service-role only.
  CREATE POLICY simulation_runs_service_only ON simulation_runs
    FOR ALL USING (false) WITH CHECK (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE simulation_runs IS
  'Fairness simulator run history. Driven by server/src/services/simulation/simulationStore.ts. The /admin/simulate page polls in-memory progress; this table stores completed/failed runs for the /admin/dashboard trend line.';

COMMIT;
