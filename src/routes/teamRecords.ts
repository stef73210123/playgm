/**
 * routes/teamRecords.ts — current-season W-L by team.
 *
 * Background
 * ──────────
 * mockTeams.ts in the client hardcodes `wins: 28, losses: 30` etc. for every
 * NBA/NFL/MLB/NHL team. Those values were last updated by hand months ago and
 * the audit (docs/wiring-audit-2026-05-04.md) flagged them as one of the
 * remaining surfaces showing stale data. This route replaces those hardcodes
 * with whatever the cron has computed into Supabase.team_records.
 *
 * Reads
 * ─────
 *   GET /api/teams/:sport/:teamId/record
 *     → { record: { teamId, sport, season, wins, losses, ties, ot_losses,
 *                   win_pct, computed_at } }
 *     200 always — when the row is missing (team not yet computed for the
 *     current season) we return zeros with `computed_at: null`. The client
 *     renders "—" for unknowns rather than wrong numbers.
 *
 *   GET /api/teams/:sport/records
 *     → { records: TeamRecord[] }  — every team for the sport in one fetch,
 *       useful for the standings view + bulk hydration.
 *
 * Writers: refreshGames.ts cron (Wave 2) — recomputes win_pct + columns from
 * the games table after every daily ingest.
 */
import type { FastifyInstance } from 'fastify';
import { supabase } from '../db/client.js';
import { isSportEnabled } from '../services/sportsConfig.js';
import type { SportId } from '../services/sportsConfig.js';

interface TeamRecordRow {
  team_id: string;
  sport: string;
  season: string;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  ot_losses: number | null;
  win_pct: number | null;
  computed_at: string | null;
}

interface TeamRecordResponse {
  teamId: string;
  sport: string;
  season: string | null;
  wins: number;
  losses: number;
  ties: number;
  otLosses: number;
  winPct: number | null;
  computedAt: string | null;
}

function projectRow(row: TeamRecordRow): TeamRecordResponse {
  return {
    teamId: row.team_id,
    sport: row.sport,
    season: row.season,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    ties: row.ties ?? 0,
    otLosses: row.ot_losses ?? 0,
    winPct: row.win_pct,
    computedAt: row.computed_at,
  };
}

const VALID_SPORTS = new Set<SportId>(['nfl', 'nba', 'mlb', 'nhl', 'mls']);

function emptyRecord(teamId: string, sport: string): TeamRecordResponse {
  return {
    teamId,
    sport,
    season: null,
    wins: 0,
    losses: 0,
    ties: 0,
    otLosses: 0,
    winPct: null,
    computedAt: null,
  };
}

export async function teamRecordsRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── Single team ───────────────────────────────────────────────────────────
  fastify.get<{ Params: { sport: string; teamId: string } }>(
    '/api/teams/:sport/:teamId/record',
    async (req, reply) => {
      const sport = req.params.sport.toLowerCase();
      const teamId = req.params.teamId.toLowerCase();

      if (!VALID_SPORTS.has(sport as SportId)) {
        return reply.code(400).send({ error: 'invalid_sport', sport });
      }
      if (!isSportEnabled(sport as SportId)) {
        return reply.code(404).send({ error: 'sport_disabled', sport });
      }

      const { data, error } = await supabase
        .from('team_records')
        .select('*')
        .eq('team_id', teamId)
        .eq('sport', sport)
        .maybeSingle();

      if (error) {
        // Don't 500 on a missing row — Supabase reports PGRST116 here. Other
        // codes are surfaced because they indicate a config / network problem.
        if (error.code !== 'PGRST116') {
          return reply.code(500).send({ error: error.message });
        }
      }

      const record: TeamRecordResponse = data
        ? projectRow(data as TeamRecordRow)
        : emptyRecord(teamId, sport);

      return { record };
    },
  );

  // ─── All teams for a sport ─────────────────────────────────────────────────
  fastify.get<{ Params: { sport: string } }>(
    '/api/teams/:sport/records',
    async (req, reply) => {
      const sport = req.params.sport.toLowerCase();
      if (!VALID_SPORTS.has(sport as SportId)) {
        return reply.code(400).send({ error: 'invalid_sport', sport });
      }
      if (!isSportEnabled(sport as SportId)) {
        return reply.code(404).send({ error: 'sport_disabled', sport });
      }

      const { data, error } = await supabase
        .from('team_records')
        .select('*')
        .eq('sport', sport)
        .order('win_pct', { ascending: false });

      if (error) {
        return reply.code(500).send({ error: error.message });
      }

      const records = (data ?? []).map((row) => projectRow(row as TeamRecordRow));
      return { sport, count: records.length, records };
    },
  );
}
