/**
 * CLI entrypoint for the SportsDB → Postgres populator.
 *
 * Usage:
 *   npm run populate                      # full run (~20-25 min, includes box scores + bio enrichment)
 *   npm run populate -- --fast            # skip enrichment + game stats (~3 min)
 *   npm run populate -- --skip-players    # teams + games + standings only
 *   npm run populate -- --skip-game-stats # everything except box scores
 *   npm run populate -- --recent-games=50 # 50 final games per league for stats (default 30)
 *
 * Idempotent: re-runs upsert on (external_id) for every reference table.
 * Reads server/.env for SUPABASE_* and SPORTSDB_V2_KEY.
 */

import 'dotenv/config';
import { populate, type PopulateOptions } from '../services/populate.js';

function parseArgs(argv: string[]): PopulateOptions {
  const opts: PopulateOptions = {};
  for (const arg of argv) {
    if (arg === '--skip-players') opts.skipPlayers = true;
    else if (arg === '--skip-games') opts.skipGames = true;
    else if (arg === '--skip-standings') opts.skipStandings = true;
    else if (arg === '--skip-game-stats') opts.skipGameStats = true;
    else if (arg === '--skip-enrichment') opts.skipPlayerEnrichment = true;
    else if (arg === '--fast') {
      // "Fast" mode: skip the slow per-player /lookup/player enrichment + box scores.
      // Still does teams + bare players + games + standings.
      opts.skipPlayerEnrichment = true;
      opts.skipGameStats = true;
    } else if (arg.startsWith('--recent-games=')) {
      opts.recentGamesPerLeague = Number(arg.split('=')[1]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run populate [-- flags]

Flags:
  --fast               Skip per-player enrichment + box scores (~3 min total).
  --skip-players       Skip Stage 3 (per-team player walk).
  --skip-enrichment    Skip the per-player /lookup/player bio enrichment pass.
  --skip-games         Skip Stage 4 (schedule + scores).
  --skip-standings     Skip Stage 5 (standings).
  --skip-game-stats    Skip Stage 6 (box-score / player_game_stats).
  --recent-games=N     Final games per league for box-score pull (default 30).
  -h, --help           Show this help.

Stage 1 (leagues) and Stage 2 (teams) always run; the rest depend on them.`);
      process.exit(0);
    } else if (arg.startsWith('--')) {
      console.warn(`[populate-cli] unknown flag ignored: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log('[populate-cli] options:', JSON.stringify(opts));
  try {
    await populate(opts);
    process.exit(0);
  } catch (err) {
    console.error('[populate-cli] FATAL:', err);
    process.exit(1);
  }
}

void main();
