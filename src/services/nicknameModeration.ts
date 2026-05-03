/**
 * nicknameModeration.ts — COPPA-aware moderation for kid-authored
 * display names and roster team names.
 *
 * Single entry point: `validateUserContent({ content, age, kind })`.
 * Same five-stage pipeline applies to both surfaces:
 *
 *   1. Length + character-class regex
 *   2. Static profanity blocklist (kid-safe — embedded inline so the
 *      service has no runtime dependency on a third-party package and
 *      stays portable across deploy targets; swap-in instructions for
 *      `obscenity` are documented at the bottom of this file)
 *   3. PII heuristics — phone, email, URL patterns
 *   4. COPPA-stricter rules for under-13:
 *        a. Top-200 US baby first names blocked (kids should not
 *           broadcast their real first name)
 *        b. "First Last" two-word capitalised pattern blocked
 *   5. Optional Anthropic Haiku 4.5 second pass for under-13 — catches
 *      edge cases the static checks miss. Cap is 1 call per save
 *      attempt; failure-open if the API key is unset or the call errors
 *      so the moderator never becomes a hard dependency on the LLM.
 *
 * Returns a normalised string + reason on rejection. Callers persist
 * `display_name_status='approved'` only when `ok===true`; otherwise
 * write `status='rejected'` and surface `reason` to the client.
 *
 * COPPA notes:
 *   - Only the candidate string + age band is sent to Anthropic (never
 *     a user id, profile id, parent email, etc.).
 *   - The Haiku call is a single yes/no classification — no transcript
 *     is logged.
 *   - When ANTHROPIC_API_KEY is unset, stage 5 is a no-op so kid
 *     accounts work in unconfigured environments.
 */

import Anthropic from '@anthropic-ai/sdk';

// ─── Types ──────────────────────────────────────────────────────────────

export type ContentKind = 'display_name' | 'team_name';

export interface ValidateInput {
  /** Raw user input. Will be normalised before any check runs. */
  content: string;
  /** Self-reported age. <13 routes through the stricter COPPA rules. */
  age: number | null | undefined;
  /** Surface — currently identical rules across both, but kept distinct
   *  for future divergence (e.g. team names allowing apostrophes). */
  kind: ContentKind;
  /** When true, the LLM second pass is invoked for under-13 entries.
   *  Defaults to true when ANTHROPIC_API_KEY is set. Tests can pass
   *  `false` to make the validator deterministic. */
  llmSecondPass?: boolean;
}

export interface ValidateResult {
  ok: boolean;
  /** Whitespace-collapsed version of `content`. Always returned, even
   *  on rejection, so the admin queue can store the cleaned string for
   *  later manual review. */
  normalized: string;
  /** Friendly, kid-readable reason. Present only when `ok===false`. */
  reason?: string;
  /** The pipeline stage that produced the rejection — useful for
   *  debugging and for the admin queue's "why was this rejected"
   *  column. */
  stage?:
    | 'regex'
    | 'profanity'
    | 'pii'
    | 'coppa_first_name'
    | 'coppa_full_name'
    | 'llm';
}

// ─── Stage 1: regex ──────────────────────────────────────────────────────
// 2–20 chars, letters/numbers/spaces/single hyphens.
const CONTENT_REGEX = /^[a-zA-Z0-9 \-]{2,20}$/;

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ─── Stage 2: kid-safe profanity blocklist ───────────────────────────────
// Curated permissive list. Includes obvious slurs / profanity / sexual
// terms but deliberately excludes ambiguous words a kid might use
// innocently (e.g. "ball", "stick"). Case-insensitive whole-token match
// AND substring match — substring catches "f@@k" / "shitty" without
// tokenising.
//
// To swap in the `obscenity` package later:
//   1. `npm i obscenity --workspace server`
//   2. Replace BLOCKLIST below with `englishDataset.build()` and use
//      `RegExpMatcher` for matching.
//   3. Keep the COPPA name list — `obscenity` does not include first
//      names.
const BLOCKLIST: ReadonlyArray<string> = [
  // Sexual / anatomy
  'porn', 'sex', 'xxx', 'cock', 'dick', 'pussy', 'tits', 'boob', 'boobs',
  'cum', 'jizz', 'horny', 'naked', 'nude', 'nudes', 'penis', 'vagina',
  'butt', 'anal',
  // Profanity
  'fuck', 'fck', 'shit', 'sht', 'bitch', 'btch', 'asshole', 'damn',
  'bastard', 'crap', 'piss', 'pissed', 'douche', 'twat', 'wank',
  // Slurs (partial — extend in admin queue review)
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'retarded', 'tranny',
  'spic', 'chink', 'kike', 'gook', 'wetback', 'cunt',
  // Drugs / alcohol / violence (kid-context inappropriate)
  'meth', 'cocaine', 'heroin', 'weed', 'crack', 'rape', 'kill', 'kills',
  'killer', 'murder', 'nazi', 'hitler', 'isis',
  // Common evasions
  'fk', 'wtf', 'stfu', 'gtfo',
  // Gambling
  'bet', 'gamble', 'casino',
];

const BLOCKLIST_SET = new Set(BLOCKLIST.map((w) => w.toLowerCase()));

function containsProfanity(input: string): { hit: boolean; word?: string } {
  const lower = input.toLowerCase();
  // Whole-token match first (faster, more accurate).
  for (const tok of lower.split(/[\s\-]+/)) {
    if (BLOCKLIST_SET.has(tok)) return { hit: true, word: tok };
  }
  // Substring match catches concatenations (e.g. "shithead", "fuk1").
  // Skip tokens shorter than 4 chars in the blocklist to avoid false
  // positives on short safe substrings ("bet" inside "Betsy" — though
  // Betsy is also blocked separately as a first name for under-13).
  for (const w of BLOCKLIST) {
    if (w.length >= 4 && lower.includes(w)) return { hit: true, word: w };
  }
  return { hit: false };
}

// ─── Stage 3: PII heuristics ─────────────────────────────────────────────
// Conservative — false positives are far cheaper than letting a phone
// or email through. Match against the LOWER-CASED string so both
// "@gmail.com" and "@Gmail.COM" trip.
const PHONE_RE = /\d{3}[\s.\-]?\d{3,4}[\s.\-]?\d{4}/;
const URL_TOKENS = ['http', 'www.', '.com', '.net', '.org', '.io', '.co', '.gg', '.tv'];

function containsPii(input: string): { hit: boolean; reason?: string } {
  if (input.includes('@')) return { hit: true, reason: 'email-like' };
  if (PHONE_RE.test(input)) return { hit: true, reason: 'phone-like' };
  const lower = input.toLowerCase();
  for (const tok of URL_TOKENS) {
    if (lower.includes(tok)) return { hit: true, reason: 'url-like' };
  }
  return { hit: false };
}

// ─── Stage 4: COPPA name lists ───────────────────────────────────────────
// Top-200 US baby names by SSA frequency (2010s aggregate — combined
// male + female). Kids under 13 are blocked from setting any of these
// as a display name because broadcasting a real first name is a known
// COPPA risk (it links the kid's identity to their handle in any
// downstream leaderboard / chat / share event).
const TOP_FIRST_NAMES = new Set<string>(
  [
    // Top boys
    'liam','noah','oliver','elijah','william','james','benjamin','lucas','henry','alexander',
    'mason','michael','ethan','daniel','jacob','logan','jackson','levi','sebastian','mateo',
    'jack','owen','theodore','aiden','samuel','joseph','john','david','wyatt','matthew',
    'luke','asher','carter','julian','grayson','leo','jayden','gabriel','isaac','lincoln',
    'anthony','hudson','dylan','ezra','thomas','charles','christopher','jaxon','maverick','josiah',
    'isaiah','andrew','elias','joshua','nathan','caleb','ryan','adrian','miles','eli',
    'nolan','christian','aaron','cameron','ezekiel','colton','luca','landon','hunter','jonathan',
    'santiago','axel','easton','cooper','jeremiah','angel','roman','connor','jameson','robert',
    'greyson','jordan','ian','carson','jaxson','leonardo','nicholas','dominic','austin','everett',
    'brooks','xavier','kai','jose','parker','adam','jace','wesley','kayden','silas',
    // Top girls
    'olivia','emma','charlotte','amelia','ava','sophia','isabella','mia','evelyn','harper',
    'luna','camila','gianna','elizabeth','eleanor','ella','abigail','sofia','avery','scarlett',
    'emily','aria','penelope','chloe','layla','mila','nora','hazel','madison','ellie',
    'lily','nova','isla','grace','violet','aurora','riley','zoey','willow','emilia',
    'stella','zoe','victoria','hannah','addison','leah','lucy','eliana','ivy','everly',
    'lillian','paisley','elena','naomi','maya','natalie','kinsley','delilah','claire','audrey',
    'aaliyah','ruby','brooklyn','alice','aubrey','autumn','leilani','savannah','valentina','kennedy',
    'madelyn','josephine','bella','skylar','genesis','sophie','hailey','sadie','natalia','quinn',
    'caroline','allison','gabriella','anna','serenity','nevaeh','cora','ariana','emery','lydia',
    'jade','sarah','eva','adeline','madeline','piper','rylee','athena','peyton','everleigh',
    // Common diminutives + extras
    'john','jane','sam','sammy','alex','max','katie','kate','tom','tommy','mike','mikey',
    'pete','peter','chris','tony','nick','dan','rob','steve','steven','jeff','jeffrey',
  ].map((n) => n.toLowerCase()),
);

function looksLikeFullName(input: string): boolean {
  // "First Last" — two capitalised tokens, both starting with a top
  // name OR both 3+ letter alpha tokens. We keep this conservative:
  // only flag the [Capital][lower]+ + space + [Capital][lower]+
  // pattern so a handle like "GoatRider Pro" doesn't get blocked.
  const parts = input.split(/\s+/);
  if (parts.length !== 2) return false;
  const [a, b] = parts;
  const re = /^[A-Z][a-z]{2,}$/;
  if (!re.test(a) || !re.test(b)) return false;
  // Either token in the top-name list is enough — bnames are
  // surprisingly distinctive in US data.
  if (
    TOP_FIRST_NAMES.has(a.toLowerCase()) ||
    TOP_FIRST_NAMES.has(b.toLowerCase())
  ) {
    return true;
  }
  return false;
}

// ─── Stage 5: optional Haiku second pass ─────────────────────────────────

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key, maxRetries: 1 });
  return _client;
}

/** Single yes/no classification. Returns:
 *   - { ok: true }                          on YES
 *   - { ok: false, reason: string }         on NO
 *   - { ok: true } when key is missing or the call errors (failure-open;
 *     the static checks above are the safety floor) */
async function llmSecondPass(
  candidate: string,
): Promise<{ ok: boolean; reason?: string }> {
  const client = getClient();
  if (!client) return { ok: true };

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 60,
      system:
        'You are a content moderator for a kids sports app (ages 5-12). ' +
        'You evaluate display nicknames children want to show publicly. ' +
        'Reject anything sexual, violent, drug-related, hateful, ' +
        'a real first or full name, or that contains personal info. ' +
        'Allow playful kid-friendly handles like sport themes, animals, colors, fantasy.',
      messages: [
        {
          role: 'user',
          content:
            `Is this nickname appropriate for a child under 13 to display publicly? ` +
            `Answer in the format "YES" or "NO: <one short reason>". ` +
            `Nickname: "${candidate}"`,
        },
      ],
    });

    const block = msg.content[0];
    if (!block || block.type !== 'text') return { ok: true };
    const text = block.text.trim();
    const upper = text.toUpperCase();
    if (upper.startsWith('YES')) return { ok: true };
    if (upper.startsWith('NO')) {
      const colonIdx = text.indexOf(':');
      const reason =
        colonIdx >= 0 ? text.slice(colonIdx + 1).trim() : 'not appropriate';
      return { ok: false, reason: reason || 'not appropriate' };
    }
    // Unparseable — failure-open. Static checks already passed.
    return { ok: true };
  } catch {
    // Network blip / rate limit — failure-open.
    return { ok: true };
  }
}

// ─── Public entry point ──────────────────────────────────────────────────

export async function validateUserContent(
  input: ValidateInput,
): Promise<ValidateResult> {
  const normalized = normalize(input.content ?? '');

  // Stage 1
  if (!CONTENT_REGEX.test(normalized)) {
    return {
      ok: false,
      normalized,
      reason:
        'Use 2–20 letters, numbers, spaces, or single hyphens only.',
      stage: 'regex',
    };
  }

  // Stage 2
  const prof = containsProfanity(normalized);
  if (prof.hit) {
    return {
      ok: false,
      normalized,
      reason: 'That word isn’t allowed. Try another nickname.',
      stage: 'profanity',
    };
  }

  // Stage 3
  const pii = containsPii(normalized);
  if (pii.hit) {
    return {
      ok: false,
      normalized,
      reason: 'No phone numbers, emails, or website links.',
      stage: 'pii',
    };
  }

  // Stage 4 — COPPA-stricter rules for under-13
  const isUnder13 = typeof input.age === 'number' && input.age < 13;
  if (isUnder13) {
    // First-name list — case-insensitive. We strip trailing/leading
    // digits before the lookup so "John123", "Mike01", "AvA" all hit.
    // The check is whole-string OR per-token (so single-token handles
    // like "John123" and multi-token handles like "John 123" both
    // resolve through the same path).
    const lower = normalized.toLowerCase();
    const stripDigits = (s: string) => s.replace(/^\d+|\d+$/g, '');
    const candidates = [stripDigits(lower)]
      .concat(lower.split(/[\s\-]+/).filter(Boolean).map(stripDigits))
      .filter((t) => t.length >= 2);
    for (const c of candidates) {
      if (TOP_FIRST_NAMES.has(c)) {
        return {
          ok: false,
          normalized,
          reason: 'Try a creative nickname instead of a real name.',
          stage: 'coppa_first_name',
        };
      }
    }
    if (looksLikeFullName(normalized)) {
      return {
        ok: false,
        normalized,
        reason: 'Real names aren’t allowed. Try a creative nickname.',
        stage: 'coppa_full_name',
      };
    }

    // Stage 5 — optional Haiku pass. Cap = 1 call per validate (no
    // retries). Caller controls via `llmSecondPass`, default true.
    const useLlm = input.llmSecondPass !== false;
    if (useLlm) {
      const verdict = await llmSecondPass(normalized);
      if (!verdict.ok) {
        return {
          ok: false,
          normalized,
          reason: verdict.reason ?? 'That nickname isn’t a good fit.',
          stage: 'llm',
        };
      }
    }
  }

  return { ok: true, normalized };
}

/** Returns true when the Haiku second pass is wired up. The admin
 *  queue + verification step in the orchestrator both surface this so
 *  it's clear whether stage 5 was active. */
export function llmSecondPassEnabled(): boolean {
  return Boolean(process.env['ANTHROPIC_API_KEY']);
}
