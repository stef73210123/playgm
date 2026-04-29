/**
 * One-shot diagnostic for SportsDB v2 endpoint coverage under our current key.
 * Probes:
 *   1. /lookup/eventstats/{id}  — does the box-score endpoint return data?
 *   2. /list/table/{league}/{season} — what season label format does standings want?
 *   3. /lookup/player/{id} — full bio for a known NBA player; which fields come back?
 *
 * Run: npm run probe-sportsdb
 */

import 'dotenv/config';
import { supabase } from '../db/client.js';

const API_KEY = process.env['SPORTSDB_V2_KEY'] ?? '238797';
const BASE = 'https://www.thesportsdb.com/api/v2/json';

async function fetchRaw(path: string): Promise<{ status: number; body: unknown; bodyKeys: string[] }> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-API-KEY': API_KEY } });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  const bodyKeys =
    body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body as Record<string, unknown>)
      : [];
  return { status: res.status, body, bodyKeys };
}

function preview(o: unknown, max = 2): unknown {
  if (Array.isArray(o)) return o.slice(0, max);
  return o;
}

async function main() {
  console.log(`[probe] using key: ${API_KEY === '238797' ? 'DEV-FALLBACK (public)' : API_KEY.slice(0, 6) + '***'}`);
  console.log(`[probe] base: ${BASE}\n`);

  // ── 1. eventstats ─────────────────────────────────────────────────────────
  // Pull one recent NBA + one recent NFL game from the DB to test.
  const { data: games } = await supabase
    .from('games')
    .select('external_id, category, date_event')
    .in('category', ['basketball', 'football'])
    .order('date_event', { ascending: false })
    .limit(4);

  console.log('=== 1. /lookup/eventstats/{idEvent} ===');
  for (const g of games ?? []) {
    const r = await fetchRaw(`/lookup/eventstats/${g.external_id}`);
    console.log(`\n[${g.category}] event ${g.external_id} (${g.date_event}):`);
    console.log('  status:', r.status, 'top-level keys:', r.bodyKeys);
    console.log('  body preview:', JSON.stringify(preview(r.body, 1)).slice(0, 350));
  }

  // ── 2. standings / leaguetable ────────────────────────────────────────────
  // Try each format the v2 docs reference. NBA = 4387.
  console.log('\n\n=== 2. /list/table/4387 (NBA) — season format probe ===');
  const seasonFormats = ['2025-2026', '2024-2025', '2025', '2024'];
  for (const s of seasonFormats) {
    const r = await fetchRaw(`/list/table/4387/${encodeURIComponent(s)}`);
    const bodyArr = (r.body as { table?: unknown[] })?.table;
    const len = Array.isArray(bodyArr) ? bodyArr.length : 0;
    console.log(`  season "${s}": status ${r.status}, top keys ${JSON.stringify(r.bodyKeys)}, table[] length ${len}`);
  }

  // ── 3. lookup player — known NBA star ────────────────────────────────────
  // LeBron James idPlayer = 34145987 in SportsDB
  console.log('\n\n=== 3. /lookup/player/34145987 (LeBron James) ===');
  const r3 = await fetchRaw('/lookup/player/34145987');
  console.log('  status:', r3.status, 'top-level keys:', r3.bodyKeys);
  if (r3.body && typeof r3.body === 'object') {
    const lookup = (r3.body as { lookup?: unknown[] }).lookup;
    if (Array.isArray(lookup) && lookup.length > 0) {
      const p = lookup[0] as Record<string, unknown>;
      console.log('  fields with values:');
      for (const [k, v] of Object.entries(p)) {
        if (v != null && v !== '' && !k.startsWith('str') === false) {
          const preview = String(v).slice(0, 80);
          console.log(`    ${k}: ${preview}`);
        } else if (v != null && v !== '') {
          console.log(`    ${k}: ${String(v).slice(0, 80)}`);
        }
      }
    } else {
      console.log('  lookup empty');
    }
  }

  // ── 4. alternative v2 stats endpoints ──────────────────────────────────────
  console.log('\n\n=== 4. probe alternative v2 stats endpoints ===');
  const altPaths = [
    '/list/playerseasons/34145987',
    '/list/playerstats/34145987',
    '/list/playerstats/34145987/2024-2025',
    '/lookup/playerseasonstats/34145987',
    '/list/honours/34145987',
    '/list/contracts/34145987',
    '/list/results/34145987',
  ];
  for (const p of altPaths) {
    const r = await fetchRaw(p);
    console.log(`  ${p.padEnd(50)} status ${r.status}, keys ${JSON.stringify(r.bodyKeys).slice(0, 80)}`);
  }

  // ── 5. v1 API probe — auth via key in path, not header ────────────────────
  // V1 has historically had broader coverage than v2 for box scores + standings.
  // The screenshot shows the user's Premium key 238797 works on v1 paths like
  //   www.thesportsdb.com/api/v1/json/238797/searchteams.php?t=Arsenal
  console.log('\n\n=== 5. v1 API probe (key in path: ' + API_KEY + ') ===');
  const v1Base = `https://www.thesportsdb.com/api/v1/json/${API_KEY}`;
  // Use the same recent NBA game and leagues we tested above.
  const v1Paths = [
    `/eventstats.php?id=${games?.[0]?.external_id ?? '2468597'}`, // box score
    `/lookuptable.php?l=4387&s=2024-2025`,                         // NBA standings 24-25
    `/lookuptable.php?l=4387&s=2025-2026`,                         // NBA standings 25-26
    `/lookuptable.php?l=4391&s=2024-2025`,                         // NFL standings
    `/eventslast.php?id=4387`,                                     // last events for NBA
    `/eventsnext.php?id=4387`,                                     // next events for NBA
    `/lookuphonours.php?id=34145987`,                              // honours
    // Per-team last 5 events — has player game logs
    `/eventslast.php?id=133604`,                                   // Lakers last 5
  ];
  for (const p of v1Paths) {
    const res = await fetch(`${v1Base}${p}`);
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : {}; } catch { body = text.slice(0, 100); }
    const keys = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body as Record<string, unknown>)
      : [];
    // For each key, count items if it's an array.
    const counts = keys.map(k => {
      const v = (body as Record<string, unknown>)[k];
      return Array.isArray(v) ? `${k}[${v.length}]` : k;
    });
    console.log(`  ${p.padEnd(60)} ${res.status}, ${counts.join(', ')}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e); process.exit(1); });
