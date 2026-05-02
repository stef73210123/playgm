/**
 * tradeFairness.ts — fairness calculator for the PlayGM trade engine.
 *
 * Sums each side of a proposal into a numeric "value score" using the
 * grade ladder defined in `data/economy/pgm_trade_rules.json` (which
 * mirrors `server/src/services/ratings/computeRatings.ts → GRADE_SCORE`),
 * adds a bounded PP-equivalent contribution from any sweetener, then
 * compares the two sides with a percentage-imbalance threshold.
 *
 * Returns a structured verdict so the UI can render a chip (Fair / Slightly
 * off / Lopsided) without a second round-trip — and the server route can
 * reject lopsided proposals before any DB write.
 */

import { loadTradeRulesSpec } from '../../economy/loader.js';
import type { Grade } from '../ratings/computeRatings.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TradeRulesSpec {
  version: string;
  fairness: {
    max_imbalance_pct: number;
    grade_score: Record<Grade, number>;
    pp_per_grade_point: number;
    max_pp_per_side: number;
    min_players_per_side: number;
    max_players_per_side: number;
  };
  execution: { lock_duration_hours: number };
  caps: {
    by_tier: Record<string, { trades_per_season: number }>;
  };
  age_safety: { under_13_friend_list_only: boolean };
  expiry: { proposal_ttl_hours: number };
  /**
   * Cooldown (hours) before two users may exchange another trade
   * proposal after a prior proposal between them. Optional — when
   * absent or 0, cooldowns are disabled.
   */
  cooldown_hours_between_trade_proposals_with_same_user?: number;
}

export interface TradeSidePlayer {
  player_id: string;
  /** Player's PlayGM overall_grade (A+, A, …, F). */
  grade: Grade;
}

export interface TradeSide {
  user_id: string;
  players: TradeSidePlayer[];
  /** Optional PlayPoint sweetener thrown into this side. */
  pp_sweetener?: number;
}

export type FairnessVerdict = 'fair' | 'slightly_off' | 'lopsided';

export interface FairnessResult {
  verdict: FairnessVerdict;
  side_a_score: number;
  side_b_score: number;
  /** |a-b| / max(a,b) — 0 = identical, 1 = total mismatch. */
  imbalance_pct: number;
  threshold_pct: number;
  /** Player count + sweetener cap violations. */
  errors: string[];
}

// ─── Spec loader ──────────────────────────────────────────────────────────────

let _rules: TradeRulesSpec | null = null;
function rules(): TradeRulesSpec {
  if (_rules) return _rules;
  _rules = loadTradeRulesSpec() as TradeRulesSpec;
  return _rules;
}

/** Test seam — reset the cached spec. */
export function _resetTradeRulesForTests(): void {
  _rules = null;
}

/**
 * Drop the in-memory trade-rules cache so the next call re-reads
 * `data/economy/pgm_trade_rules.json` from disk. Called by the admin
 * editor's PUT handler so a save flows through to the live engine
 * without a server restart.
 */
export function invalidateTradeRulesCache(): void {
  _rules = null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Score one side: sum of grade values + bounded PP-equivalent contribution. */
export function scoreSide(side: TradeSide): number {
  const r = rules().fairness;
  const gradeTotal = side.players.reduce((acc, p) => acc + (r.grade_score[p.grade] ?? 0), 0);
  const sweetener = Math.min(Math.max(side.pp_sweetener ?? 0, 0), r.max_pp_per_side);
  const ppContribution = sweetener / r.pp_per_grade_point;
  return gradeTotal + ppContribution;
}

/**
 * Evaluate fairness of a proposal. Computes each side's score and the
 * percentage imbalance, classifies into fair / slightly_off / lopsided,
 * and surfaces structured `errors` for any cap/count violations.
 *
 *   verdict === 'fair'         → imbalance_pct ≤ 0.5 × threshold
 *   verdict === 'slightly_off' → imbalance_pct ≤ threshold
 *   verdict === 'lopsided'     → imbalance_pct >  threshold (rejected)
 */
export function evaluateFairness(sideA: TradeSide, sideB: TradeSide): FairnessResult {
  const r = rules().fairness;
  const errors: string[] = [];

  const checkSide = (label: 'A' | 'B', side: TradeSide): void => {
    if (side.players.length < r.min_players_per_side) {
      errors.push(`Side ${label} must include at least ${r.min_players_per_side} player`);
    }
    if (side.players.length > r.max_players_per_side) {
      errors.push(`Side ${label} can include at most ${r.max_players_per_side} players`);
    }
    if ((side.pp_sweetener ?? 0) > r.max_pp_per_side) {
      errors.push(`Side ${label} PP sweetener exceeds ${r.max_pp_per_side}`);
    }
    if ((side.pp_sweetener ?? 0) < 0) {
      errors.push(`Side ${label} PP sweetener cannot be negative`);
    }
  };
  checkSide('A', sideA);
  checkSide('B', sideB);

  if (sideA.user_id === sideB.user_id) {
    errors.push('Trade sides must belong to different users');
  }

  const aScore = scoreSide(sideA);
  const bScore = scoreSide(sideB);
  const denom = Math.max(aScore, bScore);
  const imbalance = denom > 0 ? Math.abs(aScore - bScore) / denom : 0;
  const threshold = r.max_imbalance_pct / 100;

  let verdict: FairnessVerdict;
  if (errors.length > 0) {
    verdict = 'lopsided';
  } else if (imbalance <= threshold * 0.5) {
    verdict = 'fair';
  } else if (imbalance <= threshold) {
    verdict = 'slightly_off';
  } else {
    verdict = 'lopsided';
  }

  return {
    verdict,
    side_a_score: aScore,
    side_b_score: bScore,
    imbalance_pct: imbalance,
    threshold_pct: threshold,
    errors,
  };
}

/** Convenience: is a proposal *executable* by fairness alone? */
export function isExecutable(result: FairnessResult): boolean {
  return result.verdict !== 'lopsided' && result.errors.length === 0;
}

/** Loaded rules — exposed for routes that need cap / TTL constants. */
export function getTradeRules(): TradeRulesSpec {
  return rules();
}
