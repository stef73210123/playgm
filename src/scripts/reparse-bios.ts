/**
 * reparse-bios.ts — re-runs parseHeightToCm / parseWeightToKg on every player
 * using meta_json.raw_height / raw_weight that the populator already cached.
 * No SportsDB calls. Idempotent. Designed to recover coverage after a parser
 * bug fix.
 *
 * Run: npm run reparse-bios
 */

import 'dotenv/config';
import { supabase } from '../db/client.js';
import { parseHeightToCm, parseWeightToKg } from '../services/populate.js';

interface PlayerMeta {
  raw_height?: string | null;
  raw_weight?: string | null;
  [k: string]: unknown;
}

interface PlayerRow {
  id: string;
  external_id: string;
  height_cm: number | null;
  weight_kg: number | null;
  meta_json: PlayerMeta;
}

async function main() {
  console.log('[reparse] loading players…');
  // Page through 5K+ rows; supabase default limit is 1K.
  const PAGE_SIZE = 1000;
  let offset = 0;
  let totalSeen = 0;
  let totalUpdated = 0;
  let heightFilled = 0;
  let weightFilled = 0;
  let heightUnchanged = 0;
  let weightUnchanged = 0;

  while (true) {
    const { data, error } = await supabase
      .from('players')
      .select('id, external_id, height_cm, weight_kg, meta_json')
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;

    const updates: Array<{ id: string; height_cm: number | null; weight_kg: number | null }> = [];
    for (const row of data as PlayerRow[]) {
      totalSeen++;
      const newH = parseHeightToCm(row.meta_json?.raw_height);
      const newW = parseWeightToKg(row.meta_json?.raw_weight);

      const changed =
        (newH != null && newH !== row.height_cm) ||
        (newW != null && newW !== row.weight_kg);

      if (newH != null && row.height_cm == null) heightFilled++;
      if (newW != null && row.weight_kg == null) weightFilled++;
      if (newH == null && row.meta_json?.raw_height) heightUnchanged++;
      if (newW == null && row.meta_json?.raw_weight) weightUnchanged++;

      if (changed) {
        updates.push({
          id: row.id,
          height_cm: newH ?? row.height_cm,
          weight_kg: newW ?? row.weight_kg,
        });
      }
    }

    // UPDATE per row (.update().eq()) — Supabase has no batch update by id list.
    // 2.5K rows × ~40ms each ≈ 100s. Acceptable for a one-shot backfill.
    for (const u of updates) {
      const { error: upErr } = await supabase
        .from('players')
        .update({ height_cm: u.height_cm, weight_kg: u.weight_kg })
        .eq('id', u.id);
      if (upErr) {
        console.error(`[reparse] update ${u.id} failed:`, upErr.message);
      } else {
        totalUpdated++;
      }
    }

    process.stdout.write(`[reparse] seen ${totalSeen} updated ${totalUpdated}\r`);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`\n[reparse] done.`);
  console.log(`  total players scanned:    ${totalSeen}`);
  console.log(`  rows updated:             ${totalUpdated}`);
  console.log(`  newly-filled height_cm:   ${heightFilled}`);
  console.log(`  newly-filled weight_kg:   ${weightFilled}`);
  console.log(`  unparseable raw_height:   ${heightUnchanged}`);
  console.log(`  unparseable raw_weight:   ${weightUnchanged}`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e); process.exit(1); });
