/**
 * tradeService.ts — propose / accept / reject / cancel.
 *
 * The trade engine is intentionally a small state machine on top of the
 * `trades` table (see migrations/007_trades.sql). All persistence runs
 * through the service-role Supabase client (bypasses RLS); the route
 * layer is responsible for verifying the caller is one of the trade
 * participants before delegating in.
 *
 * State transitions:
 *   pending      → accepted   (counterparty accepts, executes)
 *   pending      → rejected   (counterparty rejects)
 *   pending      → cancelled  (proposer withdraws)
 *   pending      → expired    (TTL elapsed — surfaced lazily; no cron)
 *
 * Fairness is enforced at propose time: lopsided proposals never make it
 * into the table. Caps (per-season, per-roster) are also enforced at
 * propose time using the `trades` table itself as the source of truth
 * (executed-trade count for the (user_id, season_key) tuple).
 *
 * "Executing" a trade currently writes the trade rows + lock rows. The
 * actual roster swap is a separate hand-off that runs against the
 * `roster_cards` table — that hand-off is wired by the caller for now
 * (the rosters table is a stub) so this service stays narrowly scoped to
 * trade lifecycle. When the real roster table lands, drop the swap into
 * `executeTrade()` between the status update and lock writes.
 */

import { supabase } from '../../db/client.js';
import {
  evaluateFairness,
  getTradeRules,
  isExecutable,
  type TradeSide,
  type FairnessResult,
} from './tradeFairness.js';

export type TradeStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface TradeRow {
  id: string;
  league_id: string | null;
  sport: string;
  proposer_id: string;
  responder_id: string;
  side_a: TradeSide;
  side_b: TradeSide;
  fairness: FairnessResult;
  status: TradeStatus;
  proposer_locked_until: string | null;
  responder_locked_until: string | null;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
  expires_at: string;
}

export interface ProposeInput {
  proposer_id: string;
  responder_id: string;
  sport: string;
  league_id?: string | null;
  side_a: TradeSide;
  side_b: TradeSide;
  /** Subscription tier of the proposer — used to evaluate the per-season trade cap. */
  proposer_tier: string;
  /** ISO date string identifying the season (e.g. '2025-26-NBA'). */
  season_key: string;
  /** Whether the proposer is under 13 — gates COPPA-aware friend-list check. */
  proposer_under_13?: boolean;
  /** Pre-resolved friend ids for the proposer. Required if proposer_under_13. */
  proposer_friend_ids?: string[];
}

export interface ProposeResult {
  ok: boolean;
  trade?: TradeRow;
  fairness?: FairnessResult;
  error?: { code: string; message: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function plusHoursIso(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString();
}

/** Count trades the proposer has had `accepted` (executed) this season. */
async function executedTradeCountForSeason(
  user_id: string,
  season_key: string,
): Promise<number> {
  // The trades table stores season_key on every row so per-season counting
  // is just an indexed scan.
  const { count, error } = await supabase
    .from('trades')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'accepted')
    .eq('season_key', season_key)
    .or(`proposer_id.eq.${user_id},responder_id.eq.${user_id}`);

  if (error) throw new Error(`trades count query failed: ${error.message}`);
  return count ?? 0;
}

function tierCap(tier: string): number {
  const rules = getTradeRules();
  const cap = rules.caps.by_tier[tier];
  if (!cap) return rules.caps.by_tier['free']?.trades_per_season ?? 2;
  return cap.trades_per_season;
}

/** True if the existing roster lock blocks an outbound trade right now. */
function lockBlocks(lockUntilIso: string | null): boolean {
  if (!lockUntilIso) return false;
  return new Date(lockUntilIso).getTime() > Date.now();
}

// ─── Propose ──────────────────────────────────────────────────────────────────

export async function proposeTrade(input: ProposeInput): Promise<ProposeResult> {
  const fairness = evaluateFairness(input.side_a, input.side_b);

  if (!isExecutable(fairness)) {
    const friendly =
      fairness.errors.length > 0
        ? fairness.errors.join('; ')
        : "This trade looks too lopsided — try adjusting";
    return {
      ok: false,
      fairness,
      error: { code: 'TRADE_LOPSIDED', message: friendly },
    };
  }

  // COPPA: under-13 must trade only with someone on their friend list.
  if (
    input.proposer_under_13 &&
    !(input.proposer_friend_ids ?? []).includes(input.responder_id)
  ) {
    return {
      ok: false,
      fairness,
      error: {
        code: 'TRADE_FRIEND_ONLY',
        message: 'Under-13 accounts can only trade with kids on their friend list.',
      },
    };
  }

  // Cap check (per-season, per-roster).
  const cap = tierCap(input.proposer_tier);
  if (cap !== -1) {
    const used = await executedTradeCountForSeason(input.proposer_id, input.season_key);
    if (used >= cap) {
      return {
        ok: false,
        fairness,
        error: {
          code: 'TRADE_CAP_REACHED',
          message: `You've used your ${cap} season trades — upgrade for unlimited trades.`,
        },
      };
    }
  }

  // Lock check — if the proposer's roster is still locked from a recent
  // executed trade, block the new outbound proposal.
  const { data: existingLock } = await supabase
    .from('trade_roster_locks')
    .select('locked_until')
    .eq('user_id', input.proposer_id)
    .eq('sport', input.sport)
    .order('locked_until', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lockBlocks(existingLock?.locked_until ?? null)) {
    return {
      ok: false,
      fairness,
      error: {
        code: 'TRADE_ROSTER_LOCKED',
        message: `Your roster is locked from a recent trade — try again after ${existingLock?.locked_until}.`,
      },
    };
  }

  const ttlHours = getTradeRules().expiry.proposal_ttl_hours;
  const insert = {
    league_id: input.league_id ?? null,
    sport: input.sport,
    proposer_id: input.proposer_id,
    responder_id: input.responder_id,
    side_a: input.side_a as unknown as Record<string, unknown>,
    side_b: input.side_b as unknown as Record<string, unknown>,
    fairness: fairness as unknown as Record<string, unknown>,
    status: 'pending' as const,
    season_key: input.season_key,
    expires_at: plusHoursIso(ttlHours),
  };

  const { data, error } = await supabase
    .from('trades')
    .insert(insert)
    .select('*')
    .single();

  if (error) {
    return { ok: false, fairness, error: { code: 'TRADE_DB_INSERT', message: error.message } };
  }
  return { ok: true, fairness, trade: data as unknown as TradeRow };
}

// ─── Accept / Reject / Cancel ────────────────────────────────────────────────

export async function acceptTrade(tradeId: string, actorUserId: string): Promise<ProposeResult> {
  const { data: trade, error } = await supabase
    .from('trades')
    .select('*')
    .eq('id', tradeId)
    .maybeSingle();
  if (error || !trade) {
    return { ok: false, error: { code: 'TRADE_NOT_FOUND', message: error?.message ?? 'Trade not found' } };
  }
  const t = trade as unknown as TradeRow;

  if (t.responder_id !== actorUserId) {
    return { ok: false, error: { code: 'TRADE_NOT_RESPONDER', message: 'Only the responder can accept.' } };
  }
  if (t.status !== 'pending') {
    return { ok: false, error: { code: 'TRADE_NOT_PENDING', message: `Trade is ${t.status}` } };
  }
  if (new Date(t.expires_at).getTime() < Date.now()) {
    await supabase.from('trades').update({ status: 'expired', updated_at: nowIso() }).eq('id', tradeId);
    return { ok: false, error: { code: 'TRADE_EXPIRED', message: 'This proposal has expired.' } };
  }

  const lockUntil = plusHoursIso(getTradeRules().execution.lock_duration_hours);

  const { error: updErr } = await supabase
    .from('trades')
    .update({
      status: 'accepted',
      responded_at: nowIso(),
      updated_at: nowIso(),
      proposer_locked_until: lockUntil,
      responder_locked_until: lockUntil,
    })
    .eq('id', tradeId);
  if (updErr) {
    return { ok: false, error: { code: 'TRADE_DB_UPDATE', message: updErr.message } };
  }

  // Write per-user roster locks (denormalized for fast lookup at propose time).
  const lockRows = [
    { user_id: t.proposer_id, sport: t.sport, locked_until: lockUntil, trade_id: t.id },
    { user_id: t.responder_id, sport: t.sport, locked_until: lockUntil, trade_id: t.id },
  ];
  await supabase.from('trade_roster_locks').insert(lockRows);

  const { data: updated } = await supabase.from('trades').select('*').eq('id', tradeId).single();
  return { ok: true, trade: updated as unknown as TradeRow };
}

export async function rejectTrade(tradeId: string, actorUserId: string): Promise<ProposeResult> {
  return finalizeNonExecuting(tradeId, actorUserId, 'rejected', 'TRADE_NOT_RESPONDER');
}

export async function cancelTrade(tradeId: string, actorUserId: string): Promise<ProposeResult> {
  return finalizeNonExecuting(tradeId, actorUserId, 'cancelled', 'TRADE_NOT_PROPOSER');
}

async function finalizeNonExecuting(
  tradeId: string,
  actorUserId: string,
  newStatus: 'rejected' | 'cancelled',
  notAuthorizedCode: string,
): Promise<ProposeResult> {
  const { data: trade, error } = await supabase
    .from('trades')
    .select('*')
    .eq('id', tradeId)
    .maybeSingle();
  if (error || !trade) {
    return { ok: false, error: { code: 'TRADE_NOT_FOUND', message: error?.message ?? 'Trade not found' } };
  }
  const t = trade as unknown as TradeRow;

  // Only the responder may reject; only the proposer may cancel.
  const expectedActor = newStatus === 'rejected' ? t.responder_id : t.proposer_id;
  if (expectedActor !== actorUserId) {
    return { ok: false, error: { code: notAuthorizedCode, message: 'Not authorized for this transition.' } };
  }
  if (t.status !== 'pending') {
    return { ok: false, error: { code: 'TRADE_NOT_PENDING', message: `Trade is ${t.status}` } };
  }

  const { error: updErr } = await supabase
    .from('trades')
    .update({ status: newStatus, responded_at: nowIso(), updated_at: nowIso() })
    .eq('id', tradeId);
  if (updErr) {
    return { ok: false, error: { code: 'TRADE_DB_UPDATE', message: updErr.message } };
  }
  const { data: updated } = await supabase.from('trades').select('*').eq('id', tradeId).single();
  return { ok: true, trade: updated as unknown as TradeRow };
}

// ─── Listing ──────────────────────────────────────────────────────────────────

export async function listTradesForUser(userId: string): Promise<TradeRow[]> {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .or(`proposer_id.eq.${userId},responder_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`trades list failed: ${error.message}`);
  return (data as unknown as TradeRow[]) ?? [];
}
