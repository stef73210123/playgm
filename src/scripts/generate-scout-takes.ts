/**
 * generate-scout-takes.ts — bio-driven Scout's Takes for the Scouting Report.
 *
 * For every player with a substantial bio that doesn't yet have a cached
 * scout_take, calls Anthropic Haiku 4.5 (the cheapest tier) via getScoutTake()
 * to produce a 280-char Scout's-voice narrative, then writes it to
 * meta_json.scout_take.
 *
 * Run:
 *   npm run generate-scout-takes                 # full batch (~$4, ~15 min)
 *   npm run generate-scout-takes -- --limit=50   # smoke test
 *   npm run generate-scout-takes -- --sport=basketball
 *   npm run generate-scout-takes -- --redo       # regenerate even if already cached
 *
 * Idempotent — skips players that already have meta_json.scout_take.
 */

import 'dotenv/config';
import { supabase } from '../db/client.js';
import { getScoutTake, getScoutLLMStats } from '../services/scoutLLM.js';

interface Args {
  limit?: number;
  sport?: string;
  redo?: boolean;
  concurrency?: number;
}

interface ArgsExt extends Args {
  rpm?: number;
}

function parseArgs(argv: string[]): ArgsExt {
  // Default concurrency 1 + RPM 40 keeps us well under Anthropic's 50 RPM
  // org limit even with retry overhead. Override only if you've requested
  // a higher org RPM cap from Anthropic.
  const a: ArgsExt = { concurrency: 1, rpm: 40 };
  for (const arg of argv) {
    if (arg.startsWith('--limit=')) a.limit = Number(arg.split('=')[1]);
    else if (arg.startsWith('--sport=')) a.sport = arg.split('=')[1];
    else if (arg === '--redo') a.redo = true;
    else if (arg.startsWith('--concurrency=')) a.concurrency = Number(arg.split('=')[1]);
    else if (arg.startsWith('--rpm=')) a.rpm = Number(arg.split('=')[1]);
    else if (arg.startsWith('--')) console.warn('[generate-takes] unknown flag:', arg);
  }
  return a;
}

interface PlayerRow {
  id: string;
  category: string;
  full_name: string;
  position: string | null;
  jersey_number: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  date_of_birth: string | null;
  nationality: string | null;
  meta_json: {
    description?: string | null;
    college?: string | null;
    birth_location?: string | null;
    scout_take?: string | null;
    [k: string]: unknown;
  };
  team_id: string | null;
}

/** Build a factual context string for the LLM. Trims description so we stay
 *  cheap on input tokens. */
function buildFactualContext(p: PlayerRow, teamName: string | null): string {
  const age = p.date_of_birth
    ? new Date().getFullYear() - new Date(p.date_of_birth).getFullYear()
    : null;
  const lines: string[] = [];
  lines.push(`sport: ${p.category}`);
  if (teamName) lines.push(`team: ${teamName}`);
  if (p.position) lines.push(`position: ${p.position}`);
  if (p.jersey_number != null) lines.push(`jersey: #${p.jersey_number}`);
  if (age != null) lines.push(`age: ${age}`);
  if (p.height_cm) lines.push(`height: ${p.height_cm}cm`);
  if (p.weight_kg) lines.push(`weight: ${p.weight_kg}kg`);
  if (p.nationality) lines.push(`from: ${p.nationality}`);
  if (p.meta_json.college) lines.push(`college: ${p.meta_json.college}`);
  if (p.meta_json.description) {
    // Trim to 600 chars — enough for Haiku to extract relevant facts without
    // burning input tokens.
    const desc = p.meta_json.description.slice(0, 600);
    lines.push(`bio: ${desc}`);
  }
  return lines.join('\n');
}

/** Update meta_json.scout_take for a single player. */
async function persistScoutTake(playerId: string, take: string, existingMeta: object): Promise<void> {
  const newMeta = { ...existingMeta, scout_take: take };
  const { error } = await supabase
    .from('players')
    .update({ meta_json: newMeta })
    .eq('id', playerId);
  if (error) throw new Error(`update ${playerId}: ${error.message}`);
}

/** Process one player. */
async function processPlayer(p: PlayerRow, teamLookup: Map<string, string>): Promise<'ok' | 'skip' | 'err'> {
  const teamName = p.team_id ? teamLookup.get(p.team_id) ?? null : null;
  const ctx = buildFactualContext(p, teamName);
  try {
    const take = await getScoutTake(p.full_name, ctx);
    await persistScoutTake(p.id, take, p.meta_json);
    return 'ok';
  } catch (err) {
    console.error(`[generate-takes] ${p.full_name} failed:`, err);
    return 'err';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('[generate-takes] options:', JSON.stringify(args));

  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('[generate-takes] ANTHROPIC_API_KEY missing — set it in server/.env');
    process.exit(1);
  }

  // Build team-id → team-name lookup so we can include it in the LLM context.
  const { data: teams } = await supabase.from('teams').select('id, full_name');
  const teamLookup = new Map<string, string>();
  for (const t of teams ?? []) teamLookup.set(t.id as string, t.full_name as string);

  // Fetch candidates. PostgREST caps select() at 1,000 rows by default — page
  // through to pick up the full ~5K player corpus.
  const PAGE_SIZE = 1000;
  let pageOffset = 0;
  const allRows: PlayerRow[] = [];
  while (true) {
    let q = supabase
      .from('players')
      .select('id, category, full_name, position, jersey_number, height_cm, weight_kg, date_of_birth, nationality, meta_json, team_id')
      .not('meta_json->>description', 'is', null)
      .range(pageOffset, pageOffset + PAGE_SIZE - 1);
    if (args.sport) q = q.eq('category', args.sport);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    allRows.push(...(data as PlayerRow[]));
    if (data.length < PAGE_SIZE) break;
    pageOffset += PAGE_SIZE;
    if (args.limit && allRows.length >= args.limit) break;
  }

  // Client-side filters that are awkward to express in PostgREST.
  let candidates = allRows.filter(p => {
    const desc = p.meta_json.description ?? '';
    if (desc.length < 80) return false;
    if (/^Basketball former|^Retired|former [A-Za-z]+ Player/.test(desc)) return false;
    if (!args.redo && p.meta_json.scout_take) return false;
    return true;
  });
  if (args.limit) candidates = candidates.slice(0, args.limit);

  console.log(`[generate-takes] ${candidates.length} candidates (after substantial-bio + cache filter)`);
  if (candidates.length === 0) { console.log('[generate-takes] nothing to do'); return; }

  // Run with bounded concurrency + RPM throttle. Anthropic's free-tier org
  // RPM is 50; we default to 40 RPM to leave headroom for SDK retries.
  const concurrency = args.concurrency ?? 1;
  const rpm = args.rpm ?? 40;
  const minGapMs = Math.ceil(60_000 / rpm);
  let ok = 0, skip = 0, err = 0;
  const t0 = Date.now();
  console.log(`[generate-takes] throttle: concurrency=${concurrency}, ${rpm} RPM (~${minGapMs}ms between starts), est. ${(candidates.length / (rpm / 60)).toFixed(0)}s`);

  // Single shared "next call slot" timestamp — the throttle gate.
  let nextSlot = Date.now();
  async function gate() {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minGapMs;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const idx = cursor++;
      const p = candidates[idx];
      await gate();
      const result = await processPlayer(p, teamLookup);
      if (result === 'ok') ok++;
      else if (result === 'skip') skip++;
      else err++;
      if ((ok + err) % 20 === 0) {
        const rate = (ok + err) / ((Date.now() - t0) / 1000);
        process.stdout.write(`[generate-takes] ${ok + err}/${candidates.length} (${rate.toFixed(2)}/s, ok=${ok} err=${err})\r`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const stats = getScoutLLMStats();
  console.log(`\n[generate-takes] done in ${elapsed}s — ok=${ok} err=${err} skip=${skip}`);
  console.log(`[generate-takes] LLM stats: ${JSON.stringify(stats)}`);
  console.log(`[generate-takes] est. cost: ~$${(stats.takeCallCount * 0.001).toFixed(2)} (Haiku 4.5 @ ~$0.001/call)`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e); process.exit(1); });
