-- ============================================================
-- 003_card_scan_usage.sql — Card Scan per-day usage table
-- ============================================================
-- Companion to 001_v1_schema.sql for projects that have already
-- applied 001 and therefore won't see the appended `card_scan_usage`
-- block. This file is **idempotent**: safe to re-run against any DB.
--
-- Mirrors `ask_scout_usage` exactly — both tables back the same
-- per-(user, UTC day) cap pattern. The /cards/scan route calls
-- `cardScanLimiter.checkAndIncrement(user_id, tier)` BEFORE invoking
-- Anthropic Haiku 4.5 vision; rejections beyond the per-tier cap (see
-- `data/economy/pgm_subscriptions.json#card_scan_daily_cap`, 2/5/10/20)
-- never burn LLM spend. Rows persist past the day for `/admin/status`
-- analytics (`card_scan.free_users_capped_today`, by-tier cap-hit rate,
-- estimated Anthropic spend).
--
-- RLS: own-row SELECT; writes go through the service role.
-- ============================================================

BEGIN;

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
CREATE INDEX IF NOT EXISTS ix_card_scan_usage_ymd_brin
  ON card_scan_usage USING BRIN (ymd);

ALTER TABLE card_scan_usage ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY card_scan_usage_select_own ON card_scan_usage
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE card_scan_usage IS 'Per-(user, UTC day) Card Scan vision call counts. Authoritative source for the daily cap enforced in server/src/services/cardScanLimiter.ts.';

COMMIT;
