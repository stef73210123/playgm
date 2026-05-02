/**
 * cardScanLLM.ts — Anthropic Haiku 4.5 vision OCR for trading cards.
 *
 * Wired to POST /cards/scan. Given a base64-encoded card image, returns a
 * STRICT-JSON extraction of the visible attributes. The route is responsible
 * for matching `template_id_guess` against pgm_card_templates.json.
 *
 * Cost notes:
 *   - Haiku 4.5 is the cheapest vision-capable Anthropic tier.
 *   - max_tokens=400 is enough for the JSON envelope plus the raw_text field.
 *   - The system prompt is kept short on purpose — caching is no-op below the
 *     4096-token cacheable-prefix floor on Haiku.
 */

import Anthropic from '@anthropic-ai/sdk';

const SCAN_MODEL = 'claude-haiku-4-5';

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key, maxRetries: 3 });
  return _client;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

export type Sport =
  | 'basketball'
  | 'baseball'
  | 'football'
  | 'hockey'
  | 'soccer';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export type CardType = 'stat_boost' | 'ability' | 'hybrid';

/**
 * IP-aware card-scan extraction shape.
 *
 * For NON-PlayGM cards (Topps, Panini, Upper Deck, Bowman, etc.) we extract
 * ONLY factual data — player name, team, year, sport. These are facts about
 * the depicted athlete, not copyrightable elements of the card design. We
 * deliberately DO NOT extract or echo manufacturer rarity tiers, set names,
 * card numbers, holographic foils, autographs, or any other branded design
 * element from third-party trading cards. See docs/card-scan-ip-policy.md.
 *
 * For PlayGM template cards (which we authored) `rarity`, `card_type`, and
 * `template_id_guess` remain valid because we own that design.
 *
 * The route handler enforces: when `template_id_guess` is null (i.e. the
 * card is NOT a recognized PlayGM template), `rarity` and `card_type` are
 * stripped from the response before it reaches the client.
 */
export interface CardScanExtraction {
  player_name: string | null;
  team: string | null;
  /** 4-digit season/year if visible on the card (e.g. "2024"). Factual data. */
  year: string | null;
  sport: Sport | null;
  rarity: Rarity | null;
  card_type: CardType | null;
  template_id_guess: string | null;
  confidence: number;
  raw_text_extracted: string;
}

// ─── System prompt ───────────────────────────────────────────────────────────

// IP-aware system prompt. Two card classes are handled distinctly:
//
//   1. PlayGM template cards (cards we authored). Identify the template_id
//      from the visible design and fill rarity / card_type per the design.
//
//   2. Third-party / real trading cards (Topps, Panini, Upper Deck, Bowman,
//      manufacturers we do not own). Extract ONLY factual data about the
//      depicted athlete: player name, team, season/year, sport. Do NOT
//      attempt to read manufacturer rarity tiers, set names, parallel
//      identifiers, autographs, or any other branded design element. Set
//      rarity, card_type, and template_id_guess to null. We use the player
//      name to look the athlete up in our own roster and grant a PlayGM-
//      designed scout card; we never reproduce the scanned card.
//
// See docs/card-scan-ip-policy.md for the full policy.
const SCAN_SYSTEM_PROMPT = `You are a vision OCR system for the PlayGM trading card app. You receive a single image of a trading card and must return STRICT JSON describing what you see.

Output rules:
- Return JSON ONLY. No prose, no markdown fences, no commentary.
- The JSON must match this exact shape:
  {
    "player_name": string | null,
    "team": string | null,
    "year": string | null,
    "sport": "basketball" | "baseball" | "football" | "hockey" | "soccer" | null,
    "rarity": "common" | "uncommon" | "rare" | "epic" | "legendary" | null,
    "card_type": "stat_boost" | "ability" | "hybrid" | null,
    "template_id_guess": string | null,
    "confidence": number,
    "raw_text_extracted": string
  }
- Use null when a field is not visible or you are unsure.
- "confidence" is a single number between 0 and 1 representing your overall confidence in the extraction.
- "year" is the 4-digit season/year visible on the card (e.g. "2024", "1989") if present, otherwise null.
- "template_id_guess" is your best guess at the PlayGM template_id ONLY if the card is clearly a PlayGM-authored design (e.g. "sb_common_p5", "ab_uncommon_win"). Set to null for any third-party manufacturer card (Topps, Panini, Upper Deck, Bowman, etc.).
- For third-party manufacturer cards: extract ONLY player_name, team, year, sport. Set rarity, card_type, and template_id_guess to null. Do NOT report the manufacturer's rarity tier, set name, parallel, autograph, or other branded design elements. We are interested only in the depicted athlete.
- For PlayGM template cards: rarity and card_type may be filled per the visible design.
- "raw_text_extracted" should be a SHORT plain-text echo of just the player name and team you identified (max ~60 characters). Do NOT transcribe the full back-of-card content, copyright notices, manufacturer set names, or other text.
- Do NOT invent values. If the card is unreadable, set confidence near 0 and most fields to null but still return the JSON envelope.`;

// ─── Public API ──────────────────────────────────────────────────────────────

export interface CardScanInput {
  imageBase64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export class CardScanLLMError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'CardScanLLMError';
  }
}

/** Run Claude vision over a card image and parse the strict-JSON response. */
export async function extractCardFromImage(
  input: CardScanInput,
): Promise<CardScanExtraction> {
  const client = getClient();
  if (!client) {
    throw new CardScanLLMError('ANTHROPIC_API_KEY not configured');
  }

  let response;
  try {
    response = await client.messages.create({
      model: SCAN_MODEL,
      max_tokens: 400,
      system: SCAN_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: input.mediaType,
                data: input.imageBase64,
              },
            },
            {
              type: 'text',
              text: 'Extract the card attributes per the system instructions and return JSON only.',
            },
          ],
        },
      ],
    });
  } catch (err) {
    throw new CardScanLLMError('Anthropic vision request failed', err);
  }

  const block = response.content.find((b) => b.type === 'text');
  const raw = block?.type === 'text' ? block.text : '';
  return parseExtraction(raw);
}

/** Parse the model output into a CardScanExtraction, tolerating fence wrapping. */
export function parseExtraction(raw: string): CardScanExtraction {
  const trimmed = raw.trim();
  // Strip markdown fences if Haiku wrapped the JSON despite instructions.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new CardScanLLMError(`Vision response was not valid JSON: ${stripped.slice(0, 200)}`, err);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new CardScanLLMError('Vision response was not a JSON object');
  }

  const o = parsed as Record<string, unknown>;
  return {
    player_name: nullableString(o['player_name']),
    team: nullableString(o['team']),
    year: nullableYear(o['year']),
    sport: nullableEnum<Sport>(o['sport'], [
      'basketball', 'baseball', 'football', 'hockey', 'soccer',
    ]),
    rarity: nullableEnum<Rarity>(o['rarity'], [
      'common', 'uncommon', 'rare', 'epic', 'legendary',
    ]),
    card_type: nullableEnum<CardType>(o['card_type'], [
      'stat_boost', 'ability', 'hybrid',
    ]),
    template_id_guess: nullableString(o['template_id_guess']),
    confidence: clamp(typeof o['confidence'] === 'number' ? o['confidence'] : 0, 0, 1),
    raw_text_extracted: typeof o['raw_text_extracted'] === 'string' ? o['raw_text_extracted'].slice(0, 120) : '',
  };
}

/** 4-digit year guard. Anything outside 1900-2100 returns null. */
function nullableYear(v: unknown): string | null {
  const s = nullableString(v);
  if (!s) return null;
  const m = s.match(/(19|20|21)\d{2}/);
  return m ? m[0] : null;
}

function nullableString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 || t.toLowerCase() === 'null' ? null : t;
}

function nullableEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (typeof v !== 'string') return null;
  return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
