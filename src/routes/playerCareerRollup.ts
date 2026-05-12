/**
 * routes/playerCareerRollup.ts — career-averages + teams-played-for rollup.
 *
 * Companion to the per-season /api/stats/player/by-id/:externalId/career
 * endpoint, which returns the 5-row season-by-season table the modal
 * has rendered up to now. This route returns a single rolled-up view:
 *
 *   GET /api/players/:playerId/career-rollup
 *     → {
 *         playerId, sport, fullName, seasonsPlayed, isActive,
 *         careerStats: { ppg, rpg, apg, ... } | {},
 *         teamsPlayedFor: [{ team, teamAbbr, yearStart, yearEnd, isCurrent }],
 *         fetchedAt: ISO
 *       }
 *
 * Reads from Supabase `player_career` (migration 012). Returns null fields
 * when the row hasn't been backfilled yet so the client can degrade to
 * the narrative bio it already shows. Specifically:
 *   - Active player, backfill not yet run → 404 player_not_found (client
 *     falls through to the per-season endpoint).
 *   - All-time-great (retired) → row exists with careerStats:{} and the
 *     client renders narrative only.
 *
 * Writers: scripts/backfill-player-career.ts (one-time), then a weekly
 * cron tick the daily refresh job will own.
 */
import type { FastifyInstance } from 'fastify';
import { supabase } from '../db/client.js';
import { isSportEnabled } from '../services/sportsConfig.js';
import type { SportId } from '../services/sportsConfig.js';

interface PlayerCareerRow {
  player_id: string;
  sport: string;
  full_name: string;
  seasons_played: number | null;
  career_stats_json: Record<string, number>;
  teams_played_for: Array<{
    team: string;
    team_abbr: string;
    year_start: number | null;
    year_end: number | null;
    is_current: boolean;
  }>;
  is_active: boolean | null;
  fetched_at: string | null;
}

interface CareerRollupResponse {
  playerId: string;
  sport: string;
  fullName: string;
  seasonsPlayed: number | null;
  isActive: boolean;
  careerStats: Record<string, number>;
  teamsPlayedFor: Array<{
    team: string;
    teamAbbr: string;
    yearStart: number | null;
    yearEnd: number | null;
    isCurrent: boolean;
  }>;
  fetchedAt: string | null;
}

function projectRow(row: PlayerCareerRow): CareerRollupResponse {
  return {
    playerId: row.player_id,
    sport: row.sport,
    fullName: row.full_name,
    seasonsPlayed: row.seasons_played,
    isActive: row.is_active ?? true,
    careerStats: row.career_stats_json ?? {},
    teamsPlayedFor: (row.teams_played_for ?? []).map((t) => ({
      team: t.team,
      teamAbbr: t.team_abbr,
      yearStart: t.year_start,
      yearEnd: t.year_end,
      isCurrent: t.is_current,
    })),
    fetchedAt: row.fetched_at,
  };
}

export async function playerCareerRollupRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { playerId: string } }>(
    '/api/players/:playerId/career-rollup',
    async (req, reply) => {
      const playerId = decodeURIComponent(req.params.playerId);

      const { data, error } = await supabase
        .from('player_career')
        .select('*')
        .eq('player_id', playerId)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        // Surface table-missing as 503 so the client can fall through cleanly.
        if (error.code === 'PGRST205' || /schema cache/i.test(error.message)) {
          return reply.code(503).send({ error: 'player_career_table_missing', detail: error.message });
        }
        return reply.code(500).send({ error: error.message });
      }

      if (!data) {
        // No row yet — backfill hasn't covered this player.
        return reply.code(404).send({ error: 'player_career_not_found', player_id: playerId });
      }

      const row = data as PlayerCareerRow;
      if (!isSportEnabled(row.sport as SportId)) {
        return reply.code(404).send({ error: 'sport_disabled', sport: row.sport });
      }

      return { career: projectRow(row) };
    },
  );
}
