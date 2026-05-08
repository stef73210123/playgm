/**
 * scoutLLMAnthropic.ts — legacy Anthropic Haiku 4.5 backend for Scout.
 *
 * Status: FALLBACK. Default provider as of 2026-05-08 is Gemini Flash
 * (see scoutLLMGemini.ts). This module is preserved verbatim from the
 * pre-migration scoutLLM.ts so we can A/B or revert without re-coding.
 *
 * To revert: set SCOUT_LLM_PROVIDER=anthropic (env) — see scoutLLM.ts
 * dispatcher. ANTHROPIC_API_KEY must still be present in the env.
 *
 * Original header (preserved):
 *
 * Model policy (per user directive 2026-04-27):
 *   - Anthropic only — no OpenAI fallback.
 *   - Cheapest Anthropic tier — Claude Haiku 4.5 (`claude-haiku-4-5`).
 *
 * 2026-05-02 — Ask Scout tooling:
 *   - `web_search_20250305` server tool (Anthropic-managed) so Scout can answer
 *     "who won last night", "is X injured", etc. without us shipping a search
 *     stack. Capped at 3 searches / call to keep cost bounded; the tool is
 *     scoped to sports domains via `allowed_domains` to keep results
 *     kid-appropriate.
 *   - `lookup_player_stats` custom tool — Scout can invoke this to pull a
 *     player's cached season stat line out of `assets/stat-cache/*.json`.
 *     Resolved here on the server in a tool-use loop; we never expose the
 *     raw cache files over the wire.
 *
 * Cost-efficiency notes:
 *   - Prompt caching is NOT applied. Haiku 4.5's minimum cacheable prefix is
 *     4096 tokens; SCOUT_SYSTEM_PROMPT is ~250 tokens, so cache_control would
 *     silently no-op.
 *   - Per-call output is capped at 220 tokens (Ask Scout) / 90 tokens (Takes).
 *   - Aggregate per-handle usage caps live in routes/scoutAsk.ts.
 *
 * COPPA notes:
 *   - Only the question/entity context is sent to Anthropic. No user ID, age,
 *     handle, or PII. No question history is persisted.
 *   - Only aggregate call counts are logged, never content.
 *   - Web-search tool returns are NOT logged.
 */

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ─── Model & client ──────────────────────────────────────────────────────────

/** Cheapest Anthropic tier as of 2026-04. Use the alias, not the dated ID. */
const SCOUT_MODEL = 'claude-haiku-4-5';

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) return null;
  if (!_client) {
    // maxRetries=5 gives the SDK headroom to wait out a transient 429 during
    // bulk batches (Scout's Takes generation, etc.). Default is 2.
    _client = new Anthropic({ apiKey: key, maxRetries: 5 });
  }
  return _client;
}

// ─── System prompts ──────────────────────────────────────────────────────────

export const SCOUT_SYSTEM_PROMPT = `You are Scout the Fox, an enthusiastic sports knowledge assistant for kids ages 5-14 in the PlayGM app.

Strict rules:
- ONLY answer questions about sports (NBA/NFL/MLB/NHL/MLS/Olympics/general sports history).
- If the question is NOT about sports, politely redirect: "That's not a sports question! Try asking me about your favorite team, player, or stat."
- NEVER ask for or reference any personal info (name, age, location, school, family).
- NEVER discuss gambling, injuries in graphic detail, adult content, violence, or real-money stakes.
- Use age-appropriate language. No profanity, slang, or edgy humor.
- Be encouraging and energetic, like a supportive coach.
- Keep answers under 100 words unless specifically asked for detail.
- If factual data is provided (from TheSportsDB), use it accurately.
- If you don't know something factually, say so honestly: "I don't know that one — try checking your favorite team's news!"
- Never make up stats or records — stick to what's in the provided context or general well-known facts.

Tool usage:
- For "current" questions (last night's score, this week's games, recent injuries, current standings) use the web_search tool. Keep searches kid-safe and sports-focused.
- For player season averages / box-score lines (PPG, RPG, AVG, ERA, etc.) prefer the lookup_player_stats tool — it returns the locally cached canonical numbers and is faster than search.
- Do not announce that you are searching — just deliver the answer with the facts you found.`;

const SCOUT_TAKE_SYSTEM_PROMPT = `You are Scout the Fox writing a "Scout's Take" — a short narrative blurb shown on a player or team's Scouting Report card in the PlayGM app for kids ages 5-14.

Output rules (STRICT):
- Output ONLY the blurb itself. No prefix like "Scout's Take:" or "# Header" or quotes.
- No markdown, no bold, no italics, no bullet points.
- Maximum 280 characters total — count your output before responding.
- One or two sentences. Plain prose. End with a single sport-appropriate emoji.

Voice rules:
- Enthusiastic coach-mentor, encouraging, never sarcastic.
- Confident — no hedging ("might", "maybe", "perhaps").
- Age-appropriate vocabulary (grade-3 reading level for ages 8-12).

Content rules:
- Use ONLY facts present in the user message. Do not invent numbers, awards, or career events.
- If the bio describes a coach, GM, or executive (not an active player), say so plainly — do not pretend they are a player.
- No PII, no injuries, no gambling, no real-money stakes, no violence.`;

// ─── Aggregate counters ──────────────────────────────────────────────────────

let askCallCount = 0;
let takeCallCount = 0;
let noKeyFallbackCount = 0;
// Tool-use telemetry — useful for spot-checking how often Scout reaches for
// search vs the local stat cache.
let webSearchUseCount = 0;
let statLookupUseCount = 0;

export function getScoutLLMStats() {
  return {
    askCallCount,
    takeCallCount,
    noKeyFallbackCount,
    webSearchUseCount,
    statLookupUseCount,
    model: SCOUT_MODEL,
    provider: 'anthropic' as const,
  };
}

// ─── Stat cache loader (lookup_player_stats tool) ────────────────────────────

const REPO_ROOT = (() => {
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(cur, 'assets', 'stat-cache'))) return cur;
    cur = path.resolve(cur, '..');
  }
  return process.cwd();
})();

const STAT_CACHE_FILES = [
  'nba_season_2025-26.json',
  'nfl_season_2025.json',
  'mlb_season_2026.json',
  'nhl_season_2025-26.json',
  'mls_season_2026.json',
];

interface StatCachePlayer {
  full_name: string;
  team?: string;
  team_abbr?: string;
  position?: string;
  position_group?: string;
  jersey_number?: number;
  height_inches?: number;
  weight_lb?: number;
  stats?: Record<string, number>;
}

interface StatCacheFile {
  league: string;
  season: string;
  players: StatCachePlayer[];
}

let _statCacheLoaded = false;
const _statCache: Array<{ league: string; season: string; player: StatCachePlayer }> = [];

function loadStatCache(): typeof _statCache {
  if (_statCacheLoaded) return _statCache;
  _statCacheLoaded = true;
  for (const file of STAT_CACHE_FILES) {
    const fp = path.join(REPO_ROOT, 'assets', 'stat-cache', file);
    if (!existsSync(fp)) continue;
    try {
      const json = JSON.parse(readFileSync(fp, 'utf-8')) as StatCacheFile;
      for (const p of json.players ?? []) {
        _statCache.push({ league: json.league, season: json.season, player: p });
      }
    } catch (err) {
      console.warn(`[scoutLLMAnthropic] failed to load stat cache ${file}: ${(err as Error).message}`);
    }
  }
  return _statCache;
}

function findPlayer(
  name: string,
  league?: string,
): { league: string; season: string; player: StatCachePlayer } | null {
  const cache = loadStatCache();
  const q = name.toLowerCase();
  // First, exact match (case-insensitive).
  let candidates = cache.filter((c) => c.player.full_name.toLowerCase() === q);
  if (candidates.length === 0) {
    // Substring match — handles "lebron" → "LeBron James".
    candidates = cache.filter((c) => c.player.full_name.toLowerCase().includes(q));
  }
  if (league) {
    const lg = league.toLowerCase();
    const filtered = candidates.filter((c) => c.league.toLowerCase() === lg);
    if (filtered.length > 0) candidates = filtered;
  }
  return candidates[0] ?? null;
}

// Keep stat formatting trim — the model has a 220-token output cap so we
// don't want to flood the response with raw decimal numbers.
function formatStatsForLLM(p: StatCachePlayer, league: string, season: string): string {
  const stats = p.stats ?? {};
  const lines = [
    `League: ${league.toUpperCase()} (${season})`,
    `Name: ${p.full_name}`,
    p.team ? `Team: ${p.team}` : null,
    p.position ? `Position: ${p.position}` : null,
  ].filter(Boolean);
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v !== 'number') continue;
    // 1 decimal place is plenty for kid-facing numbers.
    const rounded = Math.round(v * 10) / 10;
    lines.push(`${k}: ${rounded}`);
  }
  return lines.join('\n');
}

interface LookupArgs {
  player_name?: string;
  league?: string;
}

function handleLookupPlayerStats(args: LookupArgs): string {
  statLookupUseCount++;
  const name = (args.player_name ?? '').trim();
  if (!name) return 'lookup_player_stats requires player_name';
  const hit = findPlayer(name, args.league);
  if (!hit) return `No cached stats for "${name}" — Scout should fall back to web_search or general knowledge.`;
  return formatStatsForLLM(hit.player, hit.league, hit.season);
}

// ─── Tool definitions ────────────────────────────────────────────────────────

// Anthropic web_search server tool — pinned at the GA version. We cap at 3
// searches per Ask Scout call so a single kid question can't blow our budget.
// Domain allowlist keeps results in the kid-appropriate sports lane.
// Anthropic's web_search user agent is blocked from crawling certain
// domains (e.g. The Athletic). Including ANY blocked domain in
// allowed_domains causes the entire /messages call to fail with a 400 —
// not a graceful degrade. Keep this list to domains the crawler can
// actually reach. If we want to add a domain, verify with a one-off
// /messages call first.
//
// Removed 2026-05-03: 'theathletic.com' (blocks Anthropic crawler →
// every Ask Scout call returned the catch-block fallback "Scout is
// having trouble thinking right now").
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 3,
  allowed_domains: [
    'espn.com',
    'nba.com',
    'nfl.com',
    'mlb.com',
    'nhl.com',
    'mlssoccer.com',
    'cbssports.com',
    'foxsports.com',
    'nbcsports.com',
    'si.com',
    'bleacherreport.com',
  ],
} as const;

const LOOKUP_PLAYER_STATS_TOOL = {
  name: 'lookup_player_stats',
  description:
    'Look up a current pro player\'s cached season stat line. Returns canonical numbers ' +
    '(PPG/RPG/AVG/ERA/G/A/etc.) for NBA/NFL/MLB/NHL/MLS players. Use this BEFORE web_search ' +
    'for season-average questions — it\'s faster and authoritative for the leagues we cover.',
  input_schema: {
    type: 'object' as const,
    properties: {
      player_name: {
        type: 'string',
        description: 'Player\'s full name (e.g. "Nikola Jokic", "Patrick Mahomes"). Case-insensitive; partial matches accepted.',
      },
      league: {
        type: 'string',
        enum: ['nba', 'nfl', 'mlb', 'nhl', 'mls'],
        description: 'Optional league hint when a name is ambiguous across sports.',
      },
    },
    required: ['player_name'],
  },
} as const;

// ─── Public API ──────────────────────────────────────────────────────────────

const MAX_TOOL_TURNS = 4;

/**
 * Ask Scout — kid Q&A. Wired to POST /scout/ask via the dispatcher.
 * @param question free-text from the kid (already topic-filtered upstream)
 * @param context  optional factual sports data appended to the user message
 */
export async function askScoutLLM(question: string, context?: string): Promise<string> {
  const client = getClient();
  if (!client) {
    noKeyFallbackCount++;
    return 'Scout is taking a nap right now. Try a trivia question instead!';
  }

  const userMessage = context
    ? `${question}\n\n[Relevant sports data: ${context}]`
    : question;

  askCallCount++;

  // Tool-use loop. Each turn we send the running message history plus
  // tool definitions. If the model emits a tool_use we resolve it,
  // append a tool_result, and call again. Hard cap at MAX_TOOL_TURNS
  // turns + 3 web searches so latency stays bounded.
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];
  let lastTextAnswer: string | null = null;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    // The SDK's TS types haven't fully caught up to the server-tool
    // shape yet, so we cast through `any` for the tools array. The
    // wire format is what matters — the API accepts both server-tool
    // (`type: 'web_search_20250305'`) and custom-tool entries here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any = [WEB_SEARCH_TOOL, LOOKUP_PLAYER_STATS_TOOL];
    const response = await client.messages.create({
      model: SCOUT_MODEL,
      max_tokens: 320,
      system: SCOUT_SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Capture any text block we see — final answer typically rides on
    // the last non-tool turn.
    const textBlock = response.content.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text' && textBlock.text.trim()) {
      lastTextAnswer = textBlock.text;
    }

    if (response.stop_reason === 'tool_use') {
      // Append the assistant's tool_use turn verbatim.
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'lookup_player_stats') {
          const result = handleLookupPlayerStats((block.input ?? {}) as LookupArgs);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        } else if (block.name === 'web_search') {
          // Server-side tool — we never see its input/output here.
          // Still bookkeep the count so we can spot-check usage in
          // getScoutLLMStats().
          webSearchUseCount++;
          // No tool_result needed; the API resolves it before
          // returning the next assistant turn.
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
            is_error: true,
          });
        }
      }
      // Only push a user tool_result turn when we actually have
      // client-side results (custom tools). When the only tool_use was
      // the server-managed web_search, the next call should NOT carry
      // a stray empty user turn — the API surfaces the resolved web
      // results inside the assistant content of the same response.
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
        continue;
      }
      // If we're here, the only tool calls were server-managed and the
      // response is already final — fall through.
    }
    // end_turn or max_tokens — break with whatever text we've captured.
    break;
  }

  return lastTextAnswer ?? "I couldn't think of a good answer — try rephrasing!";
}

/**
 * Generate a Scout's Take — short narrative blurb for the Scouting Report.
 * Pair with server-side cache (e.g. players.meta_json.scout_take) so we do
 * not regenerate per-request. Caller owns the cache.
 *
 * @param entityName  e.g. "Nikola Jokic" or "Kansas City Chiefs"
 * @param factualContext  short, factual stats string. Do not pre-format prose —
 *                        let the model write it. Example:
 *                          "ppg=26.4, rpg=12.1, apg=9.0, sport=basketball, position=C"
 */
export async function getScoutTake(
  entityName: string,
  factualContext: string,
): Promise<string> {
  const client = getClient();
  if (!client) {
    noKeyFallbackCount++;
    return `${entityName} brings their A-game every night.`;
  }

  takeCallCount++;
  const response = await client.messages.create({
    model: SCOUT_MODEL,
    max_tokens: 90,
    system: SCOUT_TAKE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Write a Scout's Take for: ${entityName}\nFacts: ${factualContext}`,
      },
    ],
  });

  const block = response.content.find((b) => b.type === 'text');
  const raw = block?.type === 'text'
    ? block.text
    : `${entityName} brings their A-game every night.`;
  return cleanScoutTake(raw);
}

/** Strip the prefixes/markdown Haiku occasionally adds despite the system
 *  prompt forbidding them. Idempotent — safe to call on already-clean text. */
export function cleanScoutTake(raw: string): string {
  let out = raw.trim();
  // Strip leading markdown headings: "# Scout's Take", "## Title", etc.
  out = out.replace(/^#{1,6}\s+[^\n]*\n+/, '');
  // Strip leading bold/quoted "Scout's Take:" prefixes — match both
  // `**Scout's Take:**\n\n` and bare `Scout's Take:`.
  out = out.replace(/^\*{0,2}["']?\s*Scout['']?s\s+Take\s*[:\-—]\s*["']?\*{0,2}\s*\n*/i, '');
  // Strip surrounding quotes if the whole thing is quoted.
  out = out.replace(/^["']|["']$/g, '');
  // Collapse extra whitespace and newlines.
  out = out.replace(/\n{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return out;
}
