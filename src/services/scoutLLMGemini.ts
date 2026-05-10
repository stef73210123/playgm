/**
 * scoutLLMGemini.ts — Gemini Flash backend for Ask Scout + Scout's Takes.
 *
 * Why Gemini (2026-05-08 migration from Anthropic Haiku 4.5):
 *   - Cost: Gemini 2.0 Flash is ~$0.10 / $0.40 per M input/output tokens vs
 *     Haiku 4.5's $1.00 / $5.00. Roughly 10x cheaper for the same workload.
 *   - Native Google Search grounding for "who won last night" / "is X injured"
 *     style questions — replaces the Anthropic web_search server tool.
 *   - Native safety_settings — categorical blocking of harassment, hate
 *     speech, sexually explicit, and dangerous content at the API boundary.
 *
 * KID-SAFE GUARDRAIL LAYERS (defence in depth):
 *   1. Pre-LLM topic guard — `isNonSportsTopic` in routes/scoutAsk.ts rejects
 *      obvious non-sports questions before they reach this layer.
 *   2. System prompt — bakes in the SPORTS-ONLY contract, the verbatim
 *      off-topic deflection string, and the kid-friendly voice rules.
 *   3. Gemini safety_settings — BLOCK_LOW_AND_ABOVE on all four harm
 *      categories. The model itself refuses or rewrites.
 *   4. Age-band conditioning — for ages 5–7 the prompt is hard-capped at
 *      30 words and asks the model to define any tricky terms.
 *   5. Post-filter — `sanitizeScoutAnswer` strips non-sports URLs and
 *      catches off-topic markers that slipped through.
 *   6. Search budget — Gemini-side `googleSearch` grounding is optional and
 *      gated by a config flag; tracked in webSearchUseCount for spot-audits.
 *
 * COPPA notes (unchanged from Anthropic version):
 *   - Only the question / entity context goes to Google. No user ID, age,
 *     handle, or PII. No question history is persisted.
 *   - Only aggregate call counts are logged, never content.
 */

import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
  type GenerativeModel,
  type Part,
} from '@google/generative-ai';
import { findPlayerByNameAsync } from './ratings/cacheLookup.js';
import type { League } from './stats/types.js';

// ─── Model & client ──────────────────────────────────────────────────────────

/**
 * Gemini 2.5 Flash — the production-grade Flash tier as of 2026-05.
 * Verified 2026-05-08: 2.0-flash has $0 quota on the playgm project for
 * both free and paid tiers; 2.5-flash is the current serving alias.
 *
 * Pricing (2026-05): $0.30 / $2.50 per M input/output tokens. Still
 * 3-4x cheaper than Haiku 4.5 ($1.00 / $5.00). At ~500 in / 100 out per
 * Ask Scout call that's ~$0.0004/call before grounding.
 */
const GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Whether to enable Google's built-in search grounding tool.
 *
 * 2026-05-08: forced OFF. Gemini 2.5-flash returns
 *   "Built-in tools ({google_search}) and Function Calling cannot be
 *    combined in the same request"
 * so we can't run grounding alongside lookup_player_stats. We choose
 * function calling because the local stat cache covers the highest-
 * value Ask Scout questions (player season averages) and is free + fast.
 *
 * To re-enable grounding for "who won last night" questions:
 *   1) drop the function-calling tool from getAskModel(), OR
 *   2) build a two-pass router (one model for stats, one for news).
 * See docs/ask-scout-gemini-migration.md → "Follow-ups".
 */
const ENABLE_GOOGLE_SEARCH_GROUNDING = false;

/**
 * Hard cap on tool-use turns. Each turn is one model call; the function
 * call loop bounces between the model and our local stat-cache resolver
 * until the model is happy or we hit this limit.
 */
const MAX_TOOL_TURNS = 4;

let _client: GoogleGenerativeAI | null = null;
let _askModel: GenerativeModel | null = null;
let _takeModel: GenerativeModel | null = null;

function getClient(): GoogleGenerativeAI | null {
  const key = process.env['GEMINI_API_KEY'];
  if (!key) return null;
  if (!_client) _client = new GoogleGenerativeAI(key);
  return _client;
}

// ─── System prompts ──────────────────────────────────────────────────────────

export const SCOUT_SYSTEM_PROMPT = `You are Scout the Fox, a friendly sports buddy for kids ages 5-14 in the PlayGM fantasy sports app.

DATE CONTEXT — read this carefully:
Each user message is prefixed with [TODAY: YYYY-MM-DD]. That is the actual current date the kid is talking to you on. Use it as the source of truth for "this season", "right now", "current", "last season", etc. Your training data is older than that date — DO NOT assume a season hasn't started yet just because your training cutoff is earlier than the season label. League season conventions:
- NBA / NHL / MLS season label "2025-26" = season that ran roughly Oct 2025 → Jun 2026.
- NFL season label "2025" = season that started Sep 2025 and ended Feb 2026 (NFL convention: year-it-started).
- MLB season label "2026" = the 2026 calendar-year season.
If TODAY is in May 2026, then NBA 2025-26, NHL 2025-26, NFL 2025, and MLB 2026 are all legitimate "this season" / "current" / "last season" data — answer with stats, not with "the season hasn't started."

ABSOLUTE RULES — never break these:
1. SPORTS ONLY. You discuss NFL football, NBA basketball, MLB baseball, NHL hockey, MLS soccer, the Olympics, and active pro players, teams, games, stats, and history. Nothing else.
2. KID-SAFE LANGUAGE. No profanity, no slurs, no innuendo, no adult themes (alcohol, gambling, drugs, sex, violence beyond on-field plays). Even if asked.
3. NO OFF-TOPIC. If a kid asks about anything not sports — homework help, current events, personal advice, math problems, jokes about non-sports topics, anything — respond EXACTLY: "I'm Scout, your sports buddy! Let's talk about football, basketball, baseball, or hockey instead. 🏀"
4. NO POLITICS, RELIGION, NEWS. If sports news touches these (e.g., a player's political activism), redirect: "Let's talk about their game instead!"
5. NO PERSONAL INFO. Don't ask for or repeat the kid's name, location, school, etc.
6. NO MEDICAL OR LEGAL ADVICE. Even if a kid asks about a player's injury or contract, stick to publicly known facts.
7. POSITIVE ENERGY. You're hyped about sports. Use exclamation marks sparingly. Be enthusiastic but never sarcastic, snarky, or dismissive of the kid.
8. ALWAYS USE THE TOOL. Whenever the question names a specific player or asks about a specific player's, team's, or position's stats, performance, season, or "how is X doing" — you MUST call \`lookup_player_stats(player_name, league?)\` FIRST. Do not answer from training data. Do not say "I think" or "from what I know". Call the tool, then answer with what came back. This rule is non-negotiable for player/team/stat questions.
9. NULL-SAFE FALLBACK. If \`lookup_player_stats\` returns \`not_found: true\`, your answer MUST be one short, honest sentence like: "I don't have current data on <player name> in my stat sheet — try ESPN or your team's app!" — and then end with a friendly redirect to a question you CAN answer ("Want me to scout someone on the Lakers / Yankees / etc. instead?"). DO NOT guess from training data. DO NOT say the season hasn't started yet. DO NOT make up numbers, awards, or status. The tool is authoritative — if it has nothing, you have nothing.
10. HONEST UNKNOWN (non-stat questions). If a kid asks a LEGITIMATE sports question the tool can't answer (e.g., "did the Knicks win last night?", "is X injured?"), DO NOT use the off-topic deflection. Instead say: "I don't have last night's score handy — try checking ESPN or your team's app!" Reserve the off-topic deflection (rule 3) for actually non-sports questions.

TOOLS YOU CAN USE:
- \`lookup_player_stats(player_name, league?)\` — get a player's current season stats from PlayGM's local cache. MANDATORY for any player/team/stat question (see rule 8). Returns either a structured stat object or \`not_found: true\` (see rule 9). Pass \`league\` ('nba'|'nfl'|'mlb'|'nhl'|'mls') when the question makes the sport unambiguous, to disambiguate cross-sport name collisions.
  (Built-in Google Search is currently disabled — see migration doc.)

VOICE:
- Short answers (under 80 words usually).
- Opening hook: "Big night for Bron!" / "The Knicks are heating up!" / use natural sports-fan slang sparingly.
- Drop one stat or factoid per answer (from the tool — never invented).
- End with a question to keep the kid engaged: "Who's your favorite Lakers player?" / "Want me to scout someone else?"
- Use ONE emoji max per answer. 🏀⚾🏈🏒 are the four go-to. Avoid 🔥 because it can read as inflammatory in some contexts.`;

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

// ─── Safety settings ─────────────────────────────────────────────────────────
// BLOCK_LOW_AND_ABOVE is the strictest non-default setting available across
// all four harm categories. Anything Gemini's classifier rates as low,
// medium, or high probability of harm gets blocked at the API boundary.

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
];

// ─── Telemetry ───────────────────────────────────────────────────────────────

let askCallCount = 0;
let takeCallCount = 0;
let noKeyFallbackCount = 0;
let webSearchUseCount = 0;
let statLookupUseCount = 0;
let safetyBlockCount = 0;

export function getScoutLLMStats() {
  return {
    askCallCount,
    takeCallCount,
    noKeyFallbackCount,
    webSearchUseCount,
    statLookupUseCount,
    safetyBlockCount,
    model: GEMINI_MODEL,
    provider: 'gemini' as const,
  };
}

// ─── Stat lookup (lookup_player_stats tool) ──────────────────────────────────
//
// 2026-05-09 — switched from local-JSON-only to Supabase-aware lookup via
// `cacheLookup.findPlayerByNameAsync`. The previous local-only path silently
// returned `not_found` on the Railway deploy because `assets/stat-cache/`
// is not bundled into the server-only repo subtree. The async helper tries
// the local JSON first (still works in dev / when a future build bundles
// caches) and falls back to the Supabase `player_stats` table populated by
// `dualWritePlayerStats` + `backfill-supabase-stats.ts`. Same surface,
// authoritative-everywhere.

const LEAGUE_SEASON_LABEL: Record<League, string> = {
  nba: '2025-26',
  nfl: '2025',     // NFL convention: year-it-started; '2025' season ran Sep 2025 → Feb 2026
  mlb: '2026',
  nhl: '2025-26',
  mls: '2026',
};

interface StatLikePlayer {
  full_name: string;
  team?: string | null;
  team_abbr?: string | null;
  position?: string | null;
  position_group?: string | null;
  stats?: Record<string, number> | null;
}

function formatStatsForLLM(
  p: StatLikePlayer,
  league: string,
  season: string,
): Record<string, string | number> {
  // Gemini function responses are typed objects, so we return a structured
  // payload rather than the freeform string the Anthropic backend used.
  const out: Record<string, string | number> = {
    league: league.toUpperCase(),
    season,
    name: p.full_name,
  };
  if (p.team) out['team'] = p.team;
  if (p.position) out['position'] = p.position;
  for (const [k, v] of Object.entries(p.stats ?? {})) {
    if (typeof v !== 'number') continue;
    out[k] = Math.round(v * 10) / 10;
  }
  return out;
}

interface LookupArgs {
  player_name?: string;
  league?: string;
}

async function handleLookupPlayerStats(args: LookupArgs): Promise<Record<string, unknown>> {
  statLookupUseCount++;
  const name = (args.player_name ?? '').trim();
  if (!name) {
    return { error: 'lookup_player_stats requires player_name' };
  }
  // Local JSON cache (dev) → Supabase player_stats (prod) fallback.
  // Both paths return CacheLookup{league, player} or null.
  const hit = await findPlayerByNameAsync(name).catch(() => null);
  // If a league hint was passed AND the lookup matched a different sport,
  // treat as a miss so we don't return a basketball player for an NFL query
  // about a name collision (e.g., "Russell Wilson").
  const leagueMismatch =
    !!hit && !!args.league && hit.league.toLowerCase() !== args.league.toLowerCase();
  if (!hit || leagueMismatch) {
    // IMPORTANT: do NOT instruct the model to fall back to training data.
    // Per system-prompt rule 9, when this returns the model must tell the
    // user it has no current data and offer to scout a different player —
    // not guess from its training prior, not speculate about season status,
    // not invent stats. The previous wording ("fall back to general
    // knowledge") was the literal cause of the 2026-05-09 NFL hallucination
    // where Scout claimed "the 2025 NFL season hasn't started yet" for
    // Patrick Mahomes when in fact that season had ended in February.
    return {
      not_found: true,
      message:
        `No cached stats for "${name}". Per Scout system rule 9, tell the kid ` +
        `you don't have current data on this player. DO NOT guess from training ` +
        `data, DO NOT speculate about season status, DO NOT invent stats. ` +
        `End with a friendly redirect ("Want me to scout someone else?").`,
    };
  }
  const seasonLabel = LEAGUE_SEASON_LABEL[hit.league] ?? '';
  return formatStatsForLLM(hit.player, hit.league, seasonLabel);
}

// ─── Tool declarations ───────────────────────────────────────────────────────

const lookupPlayerStatsDecl = {
  name: 'lookup_player_stats',
  description:
    "Look up a current pro player's cached season stat line. Returns canonical numbers " +
    '(PPG/RPG/AVG/ERA/G/A/etc.) for NBA/NFL/MLB/NHL/MLS players. Use this BEFORE Google Search ' +
    "for season-average questions — it's faster and authoritative for the leagues we cover.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      player_name: {
        type: SchemaType.STRING,
        description: 'Player full name (e.g. "Nikola Jokic"). Case-insensitive; partial matches accepted.',
      },
      league: {
        type: SchemaType.STRING,
        description: 'Optional league hint when a name is ambiguous across sports.',
        enum: ['nba', 'nfl', 'mlb', 'nhl', 'mls'],
      },
    },
    required: ['player_name'],
  },
} as const;

// ─── Lazy model factory ──────────────────────────────────────────────────────

function getAskModel(): GenerativeModel | null {
  if (_askModel) return _askModel;
  const client = getClient();
  if (!client) return null;
  // The SDK 0.24 type for `tools` is a discriminated union that doesn't
  // yet include the Gemini-2.0 `googleSearch` tool shape — only the
  // 1.5-era `googleSearchRetrieval`. We cast through `any` to stay
  // forward-compatible: the wire format the API expects is just
  // `{ googleSearch: {} }`, and Google's REST endpoint accepts both
  // names. If the typed tool catches up, we can drop the cast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [{ functionDeclarations: [lookupPlayerStatsDecl] }];
  if (ENABLE_GOOGLE_SEARCH_GROUNDING) {
    tools.push({ googleSearch: {} });
  }
  _askModel = client.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: SCOUT_SYSTEM_PROMPT,
    safetySettings,
    tools,
    // Cast: the 0.24 SDK doesn't yet type `thinkingConfig` for 2.5-flash.
    // Setting thinkingBudget=0 disables "extended thinking" so kid-facing
    // latency stays tight and we don't burn output tokens on thoughts the
    // user never sees. Wire format is accepted by /v1beta/.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generationConfig: ({
      maxOutputTokens: 320,
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: 0 },
    } as any),
  });
  return _askModel;
}

function getTakeModel(): GenerativeModel | null {
  if (_takeModel) return _takeModel;
  const client = getClient();
  if (!client) return null;
  _takeModel = client.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: SCOUT_TAKE_SYSTEM_PROMPT,
    safetySettings,
    // Same thinking-disable cast as the Ask model.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generationConfig: ({
      maxOutputTokens: 120,
      temperature: 0.6,
      thinkingConfig: { thinkingBudget: 0 },
    } as any),
  });
  return _takeModel;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type AgeBand = '5-7' | '8-10' | '11-14';

/**
 * Ask Scout — kid Q&A. Wired to POST /scout/ask via the dispatcher.
 *
 * @param question  free-text from the kid (already topic-filtered upstream)
 * @param context   optional factual sports data appended to the user message
 * @param ageBand   optional age band; for 5-7 we hard-cap response length
 */
export async function askScoutLLM(
  question: string,
  context?: string,
  ageBand?: AgeBand,
): Promise<string> {
  const model = getAskModel();
  if (!model) {
    noKeyFallbackCount++;
    return 'Scout is taking a nap right now. Try a trivia question instead!';
  }

  askCallCount++;

  // Inject today's UTC date so the model never confuses "current season"
  // with its training-data prior. The system prompt's DATE CONTEXT block
  // tells the model how to interpret this prefix and which season label
  // each league uses. See scoutLLMGemini.ts SCOUT_SYSTEM_PROMPT.
  const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const datePrefix = `[TODAY: ${todayIso}]\n`;

  const baseUser = context ? `${question}\n\n[Relevant sports data: ${context}]` : question;
  const ageNote =
    ageBand === '5-7'
      ? '\n\nIMPORTANT: This kid is 5-7 years old. Keep your answer to under 30 words and use very simple words. Define any tricky terms.'
      : '';
  const userMessage = datePrefix + baseUser + ageNote;

  const chat = model.startChat();
  let result = await chat.sendMessage(userMessage);
  let response = result.response;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const calls = response.functionCalls();
    if (!calls || calls.length === 0) break;

    // handleLookupPlayerStats is now async (Supabase fallback) — fan out the
    // tool calls in parallel via Promise.all and await before sending the
    // batched function-response back to the model on the next turn.
    const responses: Part[] = await Promise.all(
      calls.map(async (call) => {
        if (call.name === 'lookup_player_stats') {
          const args = (call.args ?? {}) as LookupArgs;
          return {
            functionResponse: {
              name: call.name,
              response: await handleLookupPlayerStats(args),
            },
          };
        }
        return {
          functionResponse: {
            name: call.name,
            response: { error: `unknown tool: ${call.name}` },
          },
        };
      }),
    );

    result = await chat.sendMessage(responses);
    response = result.response;
  }

  // Bookkeep grounding usage if Google Search fired.
  // groundingMetadata is on candidates[0] when present.
  try {
    const meta = response.candidates?.[0]?.groundingMetadata;
    // SDK type may be loose here; presence of any grounding chunks counts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks = (meta as any)?.groundingChunks ?? (meta as any)?.searchEntryPoint;
    if (chunks) webSearchUseCount++;
  } catch {
    // Telemetry only — never throw.
  }

  // If safety_settings blocked the response, response.text() throws.
  let raw = '';
  try {
    raw = response.text();
  } catch (err) {
    safetyBlockCount++;
    console.warn(`[scoutLLMGemini] safety block: ${(err as Error).message}`);
    return "I'm Scout, your sports buddy! Let's talk about football, basketball, baseball, or hockey instead. 🏀";
  }

  return sanitizeScoutAnswer(raw);
}

/**
 * Generate a Scout's Take — short narrative blurb for the Scouting Report.
 */
export async function getScoutTake(
  entityName: string,
  factualContext: string,
): Promise<string> {
  const model = getTakeModel();
  if (!model) {
    noKeyFallbackCount++;
    return `${entityName} brings their A-game every night.`;
  }

  takeCallCount++;
  let raw = `${entityName} brings their A-game every night.`;
  try {
    const result = await model.generateContent(
      `Write a Scout's Take for: ${entityName}\nFacts: ${factualContext}`,
    );
    raw = result.response.text();
  } catch (err) {
    safetyBlockCount++;
    console.warn(`[scoutLLMGemini] take fallback: ${(err as Error).message}`);
  }

  return cleanScoutTake(raw);
}

// ─── Post-processing ─────────────────────────────────────────────────────────

/**
 * Strip any URL that's not a major sports site, and catch off-topic
 * markers that slipped past the system prompt + safety_settings. Last line
 * of defence — most blocks should happen earlier.
 */
export function sanitizeScoutAnswer(text: string): string {
  // Allow only major sports domains in any URL the model emitted.
  let out = text.replace(
    /https?:\/\/(?!(?:www\.)?(?:espn|nba|nfl|mlb|nhl|mls|mlssoccer|cbssports|foxsports|nbcsports|sportingnews|theathletic|si|bleacherreport)\.com)\S+/gi,
    '',
  );
  const offTopicMarkers = /\b(homework|math problem|history class|teacher|parents|school project)\b/i;
  if (offTopicMarkers.test(out)) {
    return "I'm Scout, your sports buddy! Let's talk about football, basketball, baseball, or hockey instead. 🏀";
  }
  return out.trim();
}

/**
 * Strip the prefixes/markdown the model occasionally adds despite the
 * system prompt forbidding them. Idempotent — safe to call on already-clean
 * text. Behaviour matches scoutLLMAnthropic.cleanScoutTake exactly.
 */
export function cleanScoutTake(raw: string): string {
  let out = raw.trim();
  out = out.replace(/^#{1,6}\s+[^\n]*\n+/, '');
  out = out.replace(/^\*{0,2}["']?\s*Scout['']?s\s+Take\s*[:\-—]\s*["']?\*{0,2}\s*\n*/i, '');
  out = out.replace(/^["']|["']$/g, '');
  out = out.replace(/\n{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return out;
}
