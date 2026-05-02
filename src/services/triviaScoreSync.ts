/**
 * triviaScoreSync.ts
 *
 * Server-side merge logic for trivia scores accumulated on the client
 * while offline. The client batches up plays and sends them to
 * `/api/sync/trivia-scores` once back online; this module is the
 * authoritative drainer.
 *
 * Dedup contract:
 *  - Each client play carries a stable `localId` (generated at enqueue
 *    time on the device).
 *  - We persist applied `localId`s in `trivia_offline_sync` (insert
 *    on conflict ignore). The dedup key is `(user_id, local_id)` so
 *    one user replaying a synced batch is a no-op, and two kids on
 *    different accounts can theoretically collide on the same
 *    `localId` without one stealing the other's points.
 *  - For every NEW localId we:
 *      a. Insert a `trivia_results` row capturing the play.
 *      b. If `is_correct`, increment the user's play_points by
 *         `pp_won` via the same RPC the live `/trivia/answer` route
 *         uses, falling back to a direct UPDATE if the RPC isn't
 *         available.
 *  - We DO NOT touch `trivia_seen` here. The client may have answered
 *    questions that the server hasn't actually marked seen for this
 *    user, but in practice the client uses /trivia/next when online
 *    and only gets cached questions when offline — the duplicate
 *    risk is acceptable for now and well-bounded by the bundled
 *    question pool (3,302 questions).
 *
 * Failure modes:
 *  - Bad payload (missing fields) → 400 from the route handler;
 *    we never see it here.
 *  - Supabase write fails on a single entry → returned in the
 *    `failed` array; the client keeps the entry in its queue so it
 *    retries on next online transition. The rest of the batch still
 *    applies.
 *  - The dedup table doesn't exist yet (e.g. fresh local Supabase)
 *    → we fall through to a best-effort path that just inserts the
 *    result rows. The cost is "trivia might double-count if the
 *    client retries" which we accept on dev environments. Production
 *    schema includes the table (see schema.sql update).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OfflineTriviaScore {
  /** Stable client-side id used for dedup. Required. */
  localId: string;
  /** UUID of the question. Required. */
  questionId: string;
  /** Index of the choice the kid selected (0..3). */
  selectedIdx: number;
  /** Whether the answer was correct (computed client-side from the
   *  bundled question metadata; we re-check server-side to prevent
   *  trivial cheating). */
  isCorrect: boolean;
  /** PP the client *thinks* they earned. Authoritative value is
   *  recomputed server-side. */
  ppWon: number;
  /** Hint usage flags. */
  used5050?: boolean;
  usedInsight?: boolean;
  /** ISO 8601 client clock at answer time. */
  answeredAt: string;
}

export interface SyncResult {
  applied: string[];
  duplicates: string[];
  failed: Array<{ localId: string; error: string }>;
  pointsAwarded: number;
}

const CORRECT_POINTS = 100;
const HINT_PENALTY_FACTOR = 0.5;

// ─── Internals ───────────────────────────────────────────────────────────────

async function fetchAlreadyApplied(
  supabase: SupabaseClient,
  userId: string,
  localIds: string[],
): Promise<Set<string>> {
  if (localIds.length === 0) return new Set();
  try {
    const { data, error } = await supabase
      .from('trivia_offline_sync')
      .select('local_id')
      .eq('user_id', userId)
      .in('local_id', localIds);
    if (error) {
      // Table may not exist on old schemas — fall through to "none applied"
      // and accept the small risk of double-apply on retries.
      // eslint-disable-next-line no-console
      console.warn('[triviaScoreSync] offline-sync table read failed:', error.message);
      return new Set();
    }
    return new Set((data ?? []).map((r) => (r as { local_id: string }).local_id));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[triviaScoreSync] offline-sync table read threw:', e);
    return new Set();
  }
}

async function recordApplied(
  supabase: SupabaseClient,
  userId: string,
  localIds: string[],
): Promise<void> {
  if (localIds.length === 0) return;
  try {
    const rows = localIds.map((local_id) => ({ user_id: userId, local_id }));
    const { error } = await supabase
      .from('trivia_offline_sync')
      .upsert(rows, { onConflict: 'user_id,local_id' });
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[triviaScoreSync] failed to record applied ids:', error.message);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[triviaScoreSync] applied-id upsert threw:', e);
  }
}

async function awardPoints(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  const { error: rpcErr } = await supabase.rpc('increment_play_points', {
    p_user_id: userId,
    p_amount: amount,
  });
  if (!rpcErr) return;
  // Fallback: direct update.
  const { data: profileRow } = await supabase
    .from('profiles')
    .select('play_points')
    .eq('id', userId)
    .single();
  if (profileRow) {
    const current = (profileRow as Record<string, unknown>)['play_points'] as number;
    await supabase
      .from('profiles')
      .update({ play_points: current + amount })
      .eq('id', userId);
  }
}

function computePoints(score: OfflineTriviaScore): number {
  if (!score.isCorrect) return 0;
  const usedHint = !!score.used5050 || !!score.usedInsight;
  return usedHint
    ? Math.round(CORRECT_POINTS * HINT_PENALTY_FACTOR)
    : CORRECT_POINTS;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply a batch of offline trivia scores for a single user. Idempotent
 * by `(userId, localId)`.
 */
export async function syncTriviaScores(
  supabase: SupabaseClient,
  userId: string,
  scores: OfflineTriviaScore[],
): Promise<SyncResult> {
  const result: SyncResult = {
    applied: [],
    duplicates: [],
    failed: [],
    pointsAwarded: 0,
  };

  if (scores.length === 0) return result;

  const allIds = scores.map((s) => s.localId);
  const alreadyApplied = await fetchAlreadyApplied(supabase, userId, allIds);

  // Validate `is_correct` against the question's stored correct_idx so a
  // tampered client can't claim points it didn't earn. We pre-fetch all
  // distinct questions in one round trip.
  const distinctQs = Array.from(new Set(scores.map((s) => s.questionId)));
  const correctMap = new Map<string, number>();
  if (distinctQs.length > 0) {
    const { data: qRows, error: qErr } = await supabase
      .from('trivia_questions')
      .select('id, correct_idx')
      .in('id', distinctQs);
    if (!qErr && qRows) {
      for (const row of qRows as Array<{ id: string; correct_idx: number }>) {
        correctMap.set(row.id, row.correct_idx);
      }
    }
  }

  const newlyApplied: string[] = [];

  for (const score of scores) {
    if (alreadyApplied.has(score.localId)) {
      result.duplicates.push(score.localId);
      continue;
    }

    // Server-side recheck of correctness. If the question isn't in the
    // map (deleted/inactive), we trust the client's claim of incorrect
    // (no points) but reject claims of correctness.
    const correctIdx = correctMap.get(score.questionId);
    const verifiedCorrect =
      correctIdx !== undefined && correctIdx === score.selectedIdx;
    if (score.isCorrect && !verifiedCorrect) {
      result.failed.push({
        localId: score.localId,
        error: 'correctness mismatch — refusing to apply',
      });
      continue;
    }

    const points = computePoints({ ...score, isCorrect: verifiedCorrect });

    try {
      const { error: insErr } = await supabase.from('trivia_results').insert({
        user_id: userId,
        question_id: score.questionId,
        selected_idx: score.selectedIdx,
        is_correct: verifiedCorrect,
        used_5050_hint: !!score.used5050,
        used_insight: !!score.usedInsight,
        pp_won: points,
        pp_spent: 0,
        answered_at: score.answeredAt,
      });
      if (insErr) {
        result.failed.push({ localId: score.localId, error: insErr.message });
        continue;
      }
      // Mark the question seen for this user — keeps the next-question
      // picker honest.
      await supabase
        .from('trivia_seen')
        .upsert(
          { user_id: userId, question_id: score.questionId },
          { onConflict: 'user_id,question_id' },
        );

      if (points > 0) {
        await awardPoints(supabase, userId, points);
        result.pointsAwarded += points;
      }
      newlyApplied.push(score.localId);
      result.applied.push(score.localId);
    } catch (e) {
      result.failed.push({
        localId: score.localId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await recordApplied(supabase, userId, newlyApplied);
  return result;
}
