/**
 * dataSync.ts
 * Cron-driven data sync jobs:
 *  - Every 24 hr (3am UTC): full stats refresh → upsert sports_master_data
 *  - On startup in dev: runs once immediately
 *
 * NOTE: Live score polling (previously 2-min cron) is now handled exclusively
 * by liveScoreSync.ts — do not re-add it here.
 */

import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../db/client.js';
import { lookupAllTeams, searchPlayers } from './sportsdb.js';

const LEAGUE_IDS: Record<string, string> = {
  NBA: '4387',
  NFL: '4391',
  MLB: '4424',
  NHL: '4380',
  MLS: '4346',
};

const SPORT_MAP: Record<string, string> = {
  '4387': 'basketball',
  '4391': 'football',
  '4424': 'baseball',
  '4380': 'hockey',
  '4346': 'soccer',
};

// ─── Full stats refresh ───────────────────────────────────────────────────────

async function fullStatsRefresh(log: FastifyBaseLogger): Promise<void> {
  try {
    let upserted = 0;

    for (const [acronym, leagueId] of Object.entries(LEAGUE_IDS)) {
      const sportCategory = SPORT_MAP[leagueId] ?? 'basketball';
      const teams = await lookupAllTeams(leagueId);

      for (const team of teams) {
        await supabase.from('sports_master_data').upsert(
          {
            external_id: team.idTeam,
            name: team.strTeam,
            category: sportCategory,
            entity_type: 'team',
            stats_json: {},
            meta_json: {
              badge: team.strBadge,
              logo: team.strLogo,
              color1: team.strColour1,
              color2: team.strColour2,
              abbr: team.strTeamShort,
              league: acronym,
            },
            last_synced: new Date().toISOString(),
          },
          { onConflict: 'external_id,entity_type' }
        );
        upserted++;

        // Fetch players for this team
        const players = await searchPlayers(team.strTeam);
        for (const player of players) {
          await supabase.from('sports_master_data').upsert(
            {
              external_id: player.idPlayer,
              name: player.strPlayer,
              category: sportCategory,
              entity_type: 'player',
              team_id: team.idTeam,
              stats_json: {},
              meta_json: {
                position: player.strPosition,
                jersey: player.strNumber,
                thumb: player.strThumb,
                cutout: player.strCutout,
              },
              last_synced: new Date().toISOString(),
            },
            { onConflict: 'external_id,entity_type' }
          );
          upserted++;
        }
      }
    }

    // Refresh the materialized view (best-effort)
    try {
      await supabase.rpc('refresh_scouting_reports');
    } catch {
      // view refresh is optional — ignore failure
    }

    log.info({ upserted }, 'full stats refresh complete');
  } catch (err) {
    log.error(err, 'fullStatsRefresh failed');
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function startDataSync(log: FastifyBaseLogger): void {
  // Daily at 3am UTC: full stats refresh (teams + players → sports_master_data)
  cron.schedule('0 3 * * *', () => {
    void fullStatsRefresh(log);
  });

  log.info('Data sync cron registered (3am UTC daily stats refresh)');

  // In dev: run once immediately on startup
  if (process.env['NODE_ENV'] !== 'production') {
    log.info('Dev mode: running initial stats refresh now');
    void fullStatsRefresh(log);
  }
}
