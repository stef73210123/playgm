-- ============================================================
-- 007_trades.sql — Trade engine schema
-- ============================================================
-- Tables for the user-to-user trade engine wired up by:
--   server/src/services/trade/tradeFairness.ts
--   server/src/services/trade/tradeService.ts
--   server/src/routes/trade.ts
--
-- Two tables:
--   trades              — proposal lifecycle (pending/accepted/rejected/...)
--   trade_roster_locks  — denormalized 24h roster locks for fast lookup at
--                         propose time (avoids a self-join on the trades
--                         table for every proposal).
--
-- Idempotent — safe to re-run.
-- RLS: own-row SELECT for both tables (proposer OR responder); writes go
-- through the service role, which bypasses RLS.
-- ============================================================

BEGIN;

-- ─── trades ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trades (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id                TEXT,                                              -- nullable: open trades may not be league-scoped
  sport                    TEXT         NOT NULL,                             -- 'nba' | 'nfl' | ...
  proposer_id              UUID         NOT NULL,
  responder_id             UUID         NOT NULL,
  side_a                   JSONB        NOT NULL,                             -- { user_id, players[], pp_sweetener? }
  side_b                   JSONB        NOT NULL,
  fairness                 JSONB        NOT NULL,                             -- evaluateFairness() result
  status                   TEXT         NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
  season_key               TEXT         NOT NULL,                             -- e.g. '2025-26-NBA' — used for per-season caps
  proposer_locked_until    TIMESTAMPTZ,
  responder_locked_until   TIMESTAMPTZ,
  responded_at             TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ  NOT NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT trades_distinct_parties CHECK (proposer_id <> responder_id)
);

CREATE INDEX IF NOT EXISTS ix_trades_proposer
  ON trades (proposer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_trades_responder
  ON trades (responder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_trades_status
  ON trades (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_trades_season
  ON trades (season_key, status);
CREATE INDEX IF NOT EXISTS ix_trades_created_brin
  ON trades USING BRIN (created_at);

DROP TRIGGER IF EXISTS trg_trades_updated_at ON trades;
CREATE TRIGGER trg_trades_updated_at
  BEFORE UPDATE ON trades
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY trades_select_own ON trades
    FOR SELECT USING (auth.uid() = proposer_id OR auth.uid() = responder_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE trades IS
  'Trade proposals between two PlayGM users. Authoritative source for the trade engine state machine. Caps/fairness/locks enforced server-side at propose time.';

-- ─── trade_roster_locks ─────────────────────────────────────────────────────
-- Denormalized 24h roster locks. One row per user per executed trade —
-- the propose route looks up the latest row per (user_id, sport) and
-- blocks new outbound proposals while locked_until > NOW().

CREATE TABLE IF NOT EXISTS trade_roster_locks (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      UUID         NOT NULL,
  sport        TEXT         NOT NULL,
  locked_until TIMESTAMPTZ  NOT NULL,
  trade_id     UUID         NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_trl_user_sport
  ON trade_roster_locks (user_id, sport, locked_until DESC);
CREATE INDEX IF NOT EXISTS ix_trl_trade
  ON trade_roster_locks (trade_id);

ALTER TABLE trade_roster_locks ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY trade_roster_locks_select_own ON trade_roster_locks
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE trade_roster_locks IS
  'Per-user roster locks written when a trade is accepted. Lookup hot path for the propose route.';

COMMIT;
