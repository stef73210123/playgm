/**
 * probe-canonical.ts — minimal probe: report which canonical tables exist
 * in the live Supabase project (and how many rows). Tables list comes from
 * the dispatch spec for the stats-pipeline migration.
 *
 * Run:
 *   cd server && npx tsx --import ./src/env-loader.ts src/scripts/probe-canonical.ts
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env['SUPABASE_URL'];
const key = process.env['SUPABASE_SERVICE_KEY'];
if (!url || !key) {
  // eslint-disable-next-line no-console
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const TABLES = [
  'pp_events',
  'pp_wallet',
  'card_inventory',
  'card_shards',
  'pity_state',
  'streak_state',
  'play_picks',
  'card_scans',
  'sessions',
  'subscription_events',
  'trivia_attempts',
  'ask_scout_usage',
  'card_scan_usage',
  'player_stats',
  'player_ratings',
];

function isMissing(msg: string | undefined): boolean {
  if (!msg) return false;
  return /does not exist|not found|schema cache|PGRST205|PGRST20[0-9]/i.test(msg);
}

interface Row {
  table: string;
  present: boolean;
  rows: number | null;
  note?: string;
}

(async () => {
  const out: Row[] = [];
  for (const t of TABLES) {
    try {
      const { count, error, status } = await sb
        .from(t)
        .select('*', { count: 'exact', head: true });
      if (error) {
        out.push({
          table: t,
          present: !isMissing(error.message),
          rows: null,
          note: error.message.slice(0, 100),
        });
      } else if (status === 204) {
        out.push({ table: t, present: false, rows: null, note: 'http 204' });
      } else {
        out.push({ table: t, present: true, rows: count ?? 0 });
      }
    } catch (e) {
      out.push({
        table: t,
        present: false,
        rows: null,
        note: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const present = out.filter((r) => r.present);
  const missing = out.filter((r) => !r.present);
  // eslint-disable-next-line no-console
  console.log(`\n=== Canonical table probe (${out.length}) ===`);
  for (const r of out) {
    const status = r.present ? `present rows=${r.rows ?? '?'}` : `MISSING ${r.note ?? ''}`;
    // eslint-disable-next-line no-console
    console.log(`  ${r.table.padEnd(22)} ${status}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nsummary: present=${present.length} missing=${missing.length}`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out));
})();
