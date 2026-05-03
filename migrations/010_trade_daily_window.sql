-- ============================================================
-- 010_trade_daily_window.sql — Per-day trade cap lookup support
-- ============================================================
-- v1.1.0 of the trade engine pivots caps from per-season to per-day
-- (UTC-resetting). The `tradeService.executedTradeCountForUtcDay()`
-- helper queries:
--
--   SELECT count(id)
--   FROM trades
--   WHERE status = 'accepted'
--     AND created_at >= <utc_midnight>
--     AND created_at <  <utc_midnight + 24h>
--     AND (proposer_id = $1 OR responder_id = $1)
--
-- The existing ix_trades_proposer / ix_trades_responder indexes already
-- give per-user btree access by created_at DESC, but the predicate is
-- always `status = 'accepted'`. A small partial index lets the planner
-- skip the table scan on the status filter for the hot path.
--
-- Idempotent — safe to re-run.
-- ============================================================

BEGIN;

-- Partial index: only rows the daily-cap check ever touches.
-- created_at DESC matches the access pattern of the count query (range
-- scan over the most-recent day) and keeps the index slim — pending /
-- expired / cancelled rows are excluded entirely.
CREATE INDEX IF NOT EXISTS ix_trades_accepted_proposer_created
  ON trades (proposer_id, created_at DESC)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS ix_trades_accepted_responder_created
  ON trades (responder_id, created_at DESC)
  WHERE status = 'accepted';

COMMENT ON INDEX ix_trades_accepted_proposer_created IS
  'Partial index supporting per-day cap lookup in tradeService.executedTradeCountForUtcDay() (proposer side).';
COMMENT ON INDEX ix_trades_accepted_responder_created IS
  'Partial index supporting per-day cap lookup in tradeService.executedTradeCountForUtcDay() (responder side).';

COMMIT;
