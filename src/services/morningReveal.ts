/**
 * morningReveal.ts
 * Cron at 6am UTC daily:
 *  - Walk active_drafts with status LIVE from yesterday
 *  - Compute play_points based on score
 *  - Update profile.play_points
 *  - Mark draft COMPLETED
 *  - Insert a victory_reveal row
 */

import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../db/client.js';

const POINTS_PER_SCORE_UNIT = 10; // 1 score point → 10 play_points

async function runMorningReveal(log: FastifyBaseLogger): Promise<number> {
  // Yesterday's window
  const now = new Date();
  const yesterdayStart = new Date(now);
  yesterdayStart.setUTCDate(now.getUTCDate() - 1);
  yesterdayStart.setUTCHours(0, 0, 0, 0);
  const yesterdayEnd = new Date(yesterdayStart);
  yesterdayEnd.setUTCHours(23, 59, 59, 999);

  const { data: drafts, error } = await supabase
    .from('active_drafts')
    .select('id, user_id, score')
    .eq('status', 'LIVE')
    .gte('created_at', yesterdayStart.toISOString())
    .lte('created_at', yesterdayEnd.toISOString());

  if (error) {
    log.error(error, 'morningReveal: failed to fetch drafts');
    return 0;
  }
  if (!drafts || drafts.length === 0) {
    log.info('morningReveal: no LIVE drafts from yesterday');
    return 0;
  }

  let processed = 0;
  for (const draft of drafts) {
    const pointsWon = Math.round((draft.score as number) * POINTS_PER_SCORE_UNIT);

    // Award points to profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('play_points')
      .eq('id', draft.user_id)
      .single();

    if (profile) {
      await supabase
        .from('profiles')
        .update({ play_points: (profile.play_points as number) + pointsWon })
        .eq('id', draft.user_id);
    }

    // Mark draft completed
    await supabase
      .from('active_drafts')
      .update({
        status: 'COMPLETED',
        play_points_won: pointsWon,
        updated_at: new Date().toISOString(),
      })
      .eq('id', draft.id);

    // Insert victory_reveal
    await supabase.from('victory_reveals').insert({
      user_id: draft.user_id,
      draft_id: draft.id,
      points_won: pointsWon,
      seen: false,
    });

    processed++;
  }

  log.info({ processed }, 'morningReveal complete');
  return processed;
}

export function startMorningReveal(log: FastifyBaseLogger): void {
  cron.schedule('0 6 * * *', () => {
    void runMorningReveal(log);
  });
  log.info('Morning Reveal cron registered (6am UTC daily)');
}

export { runMorningReveal };
