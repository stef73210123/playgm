/**
 * probe-schema.ts — fast probe to detect which canonical tables exist in
 * the live Supabase project. Reads server/.env. Writes a single line per
 * table: `present` or `missing(<reason>)`.
 *
 * Run: npx tsx --import ./src/env-loader.ts src/scripts/probe-schema.ts
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env['SUPABASE_URL'];
const key = process.env['SUPABASE_SERVICE_KEY'];
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const TABLES = [
  // Already-applied (from schema.sql)
  'profiles', 'pp_events', 'play_packs', 'owned_scout_cards', 'card_applications',
  'rosters', 'roster_players', 'h2h_matches', 'trivia_results',
  'subscriptions', 'scout_card_definitions',
  // Canonical-but-not-applied
  'pp_wallet', 'card_inventory', 'card_shards', 'pity_state', 'streak_state',
  // Dashboard-referenced but missing
  'play_picks', 'card_scans', 'sessions', 'subscription_events', 'trivia_attempts',
  // Views
  'user_pp_totals', 'signup_cohorts',
];

function isMissing(msg: string | undefined): boolean {
  if (!msg) return false;
  return /does not exist|not found|schema cache|PGRST205|PGRST20[0-9]/i.test(msg);
}

(async () => {
  for (const t of TABLES) {
    try {
      const { error, status } = await sb.from(t).select('*', { count: 'exact', head: true });
      if (error) {
        const tag = isMissing(error.message) ? 'MISSING' : 'ERROR';
        console.log(`${t.padEnd(30)} ${tag}  ${error.message.slice(0, 80)}`);
      } else if (status === 204) {
        console.log(`${t.padEnd(30)} MISSING  http 204 / not in schema cache`);
      } else {
        console.log(`${t.padEnd(30)} present`);
      }
    } catch (e) {
      console.log(`${t.padEnd(30)} THREW    ${e instanceof Error ? e.message : String(e)}`);
    }
  }
})();
