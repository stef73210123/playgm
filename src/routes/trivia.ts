import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const CORRECT_POINTS       = 100;
const HINT_PENALTY_FACTOR  = 0.5; // 50% of potential winnings

export async function triviaRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /trivia/next?sport=basketball&difficulty=easy
  fastify.get('/trivia/next', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const query = req.query as { sport?: string; difficulty?: string };

    let qb = supabase
      .from('trivia_questions')
      .select('id, sport, category, question, choices, difficulty, media_url')
      // Exclude already-seen questions for this user
      .not(
        'id',
        'in',
        `(SELECT question_id FROM trivia_seen WHERE user_id = '${profileId}')`
      );

    if (query.sport) qb = qb.eq('sport', query.sport);
    if (query.difficulty) qb = qb.eq('difficulty', query.difficulty);

    const { data: questions, error } = await qb.limit(50);
    if (error) return reply.code(500).send({ error: error.message });

    if (!questions || questions.length === 0) {
      // All seen — reset for this user and retry
      await supabase.from('trivia_seen').delete().eq('user_id', profileId);
      return reply.code(204).send();
    }

    const question = questions[Math.floor(Math.random() * questions.length)]!;
    // Don't send correct_idx to client
    return reply.send(brandingFilter(question));
  });

  // POST /trivia/answer
  const answerSchema = z.object({
    questionId: z.string().uuid(),
    choiceIdx:  z.number().int().min(0).max(3),
    usedHint:   z.boolean().default(false),
  });

  fastify.post('/trivia/answer', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { questionId, choiceIdx, usedHint } = parsed.data;

    // Fetch correct answer
    const { data: question, error } = await supabase
      .from('trivia_questions')
      .select('correct_idx')
      .eq('id', questionId)
      .maybeSingle();

    if (error) return reply.code(500).send({ error: error.message });
    if (!question) return reply.code(404).send({ error: 'Question not found' });

    const isCorrect = (question as Record<string, unknown>)['correct_idx'] === choiceIdx;

    // Mark question as seen regardless of correctness
    await supabase
      .from('trivia_seen')
      .upsert({ user_id: profileId, question_id: questionId }, { onConflict: 'user_id,question_id' });

    let pointsAwarded = 0;
    if (isCorrect) {
      pointsAwarded = usedHint
        ? Math.round(CORRECT_POINTS * HINT_PENALTY_FACTOR)
        : CORRECT_POINTS;

      // Award points — try RPC first, fall back to direct update
      const { error: rpcErr } = await supabase.rpc('increment_play_points', {
        p_user_id: profileId,
        p_amount: pointsAwarded,
      });
      if (rpcErr) {
        // Fallback if RPC not yet created
        const { data: profileRow } = await supabase
          .from('profiles')
          .select('play_points')
          .eq('id', profileId)
          .single();
        if (profileRow) {
          await supabase
            .from('profiles')
            .update({ play_points: (profileRow as Record<string, unknown>)['play_points'] as number + pointsAwarded })
            .eq('id', profileId);
        }
      }
    }

    return reply.send({ isCorrect, pointsAwarded });
  });
}
