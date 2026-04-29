/**
 * scoutLLM.ts — single LLM dispatcher for both Scout's Takes (player narrative
 * blurbs in scouting reports) and Ask Scout (kid Q&A in the Trivia screen).
 *
 * Model policy (per user directive 2026-04-27):
 *   - Anthropic only — no OpenAI fallback.
 *   - Cheapest Anthropic tier — Claude Haiku 4.5 (`claude-haiku-4-5`).
 *
 * Cost-efficiency notes:
 *   - Prompt caching is NOT applied. Haiku 4.5's minimum cacheable prefix is
 *     4096 tokens; SCOUT_SYSTEM_PROMPT is ~250 tokens, so cache_control would
 *     silently no-op. Don't add it back without first growing the cached prefix
 *     past 4096 tokens (verify with `usage.cache_creation_input_tokens`).
 *   - Per-call output is capped at 220 tokens (Ask Scout) / 90 tokens (Takes).
 *   - Aggregate per-handle usage caps live in routes/scoutAsk.ts.
 *
 * COPPA notes:
 *   - Only the question/entity context is sent to Anthropic. No user ID, age,
 *     handle, or PII. No question history is persisted.
 *   - Only aggregate call counts are logged, never content.
 */

import Anthropic from '@anthropic-ai/sdk';

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
- Never make up stats or records — stick to what's in the provided context or general well-known facts.`;

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

export function getScoutLLMStats() {
  return { askCallCount, takeCallCount, noKeyFallbackCount, model: SCOUT_MODEL };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Ask Scout — kid Q&A. Wired to POST /scout/ask.
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
  const response = await client.messages.create({
    model: SCOUT_MODEL,
    max_tokens: 220,
    system: SCOUT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const block = response.content.find((b) => b.type === 'text');
  return block?.type === 'text'
    ? block.text
    : "I couldn't think of a good answer — try rephrasing!";
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
