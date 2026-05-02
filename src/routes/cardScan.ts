/**
 * cardScan.ts
 * POST /cards/scan      — Claude Haiku 4.5 vision OCR for trading cards.
 * GET  /cards/scan/quota — current per-(user, UTC day) quota WITHOUT
 *                          consuming a credit. Mirrors /scout/quota.
 *
 * Accepts a base64-encoded image plus media_type, runs Anthropic vision,
 * and (if the model returned a recognizable PlayGM template_id_guess) matches
 * the result against data/cards/pgm_card_templates.json.
 *
 * Per-(user, UTC day) cap: enforced by `services/cardScanLimiter.ts` and
 * persisted in the `card_scan_usage` table. Caps come from
 * `data/economy/pgm_subscriptions.json#card_scan_daily_cap` (2/5/10/20).
 * The cap is checked BEFORE the Anthropic vision call so over-cap callers
 * never burn LLM spend. Over-cap requests get a 429 with the structured
 * `CARD_SCAN_DAILY_CAP` envelope and `X-CardScan-*` advisory headers.
 *
 * TODO(auth): the per-day limiter currently uses a stub user_id derived
 * from the bearer-token handle (same shim as scoutAsk). Real auth has
 * shipped — once the auth task wires `request.user.{id,subscription_tier}`
 * into the request, swap `resolveUserContext` to read from `request.user`.
 * Until then, the handle stub keeps the cap functional in dev and on
 * tunneled previews.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  extractCardFromImage,
  CardScanLLMError,
  type CardScanExtraction,
  type Rarity as CardScanRarity,
} from '../services/cardScanLLM.js';
import {
  checkAndIncrement,
  getQuota,
  type LimiterDecision,
} from '../services/cardScanLimiter.js';
import { matchPlayer, type MatchResult, type IndexedPlayer } from '../services/cardScan/playerMatcher.js';
import { grantScoutCard, type GrantOutcome } from '../services/cardScan/scoutCardGrant.js';
import { supabase } from '../db/client.js';
import type { Grade } from '../services/ratings/computeRatings.js';
import type { SubscriptionTierId } from '../economy/types.js';

// ─── Card template library (loaded once at startup) ─────────────────────────

interface CardTemplate {
  template_id: string;
  name: string;
  card_type: 'stat_boost' | 'ability' | 'hybrid';
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  energy_cost: number;
  sport: string;
  effect: Record<string, unknown>;
  display: {
    description_short: string;
    description_long: string;
    scout_callout?: string;
  };
}

interface TemplatesFile {
  version: string;
  card_templates: CardTemplate[];
}

/** Resolve the pgm_card_templates.json path. Honors a PGM_CARD_TEMPLATES_PATH
 *  override (used by tests), then probes a few cwd-relative candidates so the
 *  same code works whether the server is launched from `server/` or repo root.
 *  Avoids `import.meta.url` so the module also loads cleanly under Jest's CJS
 *  transformation pipeline. */
function resolveTemplatesPath(): string {
  const override = process.env['PGM_CARD_TEMPLATES_PATH'];
  if (override) return override;
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'data/cards/pgm_card_templates.json'),
    path.join(cwd, '../data/cards/pgm_card_templates.json'),
    path.join(cwd, '../../data/cards/pgm_card_templates.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `cardScan: could not locate pgm_card_templates.json (cwd=${cwd}). ` +
    'Set PGM_CARD_TEMPLATES_PATH to override.',
  );
}

let _templates: CardTemplate[] | null = null;
function loadTemplates(): CardTemplate[] {
  if (_templates) return _templates;
  const raw = readFileSync(resolveTemplatesPath(), 'utf8');
  const data = JSON.parse(raw) as TemplatesFile;
  _templates = data.card_templates;
  return _templates;
}

/** Reset cached templates — exposed for tests to swap fixture data. */
export function _resetTemplatesCacheForTests(): void {
  _templates = null;
}

/** Lookup helper exported for tests. */
export function findTemplateById(id: string): CardTemplate | null {
  const all = loadTemplates();
  return all.find((t) => t.template_id === id) ?? null;
}

// ─── Request / response shapes ──────────────────────────────────────────────

interface ScanBody {
  image_base64: string;
  media_type?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

type MatchStatus = 'matched' | 'unrecognized' | 'scout_unlocked' | 'multiple_players' | 'already_owned';

/** When a third-party card maps to one of OUR roster players, the route
 *  grants a PlayGM scout card. The unlocked card metadata rides on the
 *  response so the client can render the unlock animation without a
 *  follow-up request. See docs/card-scan-ip-policy.md "Unlock flow". */
export interface UnlockedScoutCard {
  template_id: string;
  player_id: string;
  player_name: string;
  team: string | null;
  position: string | null;
  league: string;
  rarity: CardScanRarity;
  grade: Grade;
  needs_more_games: boolean;
}

export interface ScanResponse {
  match_status: MatchStatus;
  extraction: CardScanExtraction;
  template: CardTemplate | null;
  /** Present when match_status === 'scout_unlocked'. */
  unlocked?: UnlockedScoutCard;
  /** Present when match_status === 'multiple_players'. */
  candidates?: Array<Pick<IndexedPlayer, 'external_id' | 'full_name' | 'team' | 'league'>>;
  /** Present when match_status === 'already_owned'. */
  already_owned?: { player_id: string; player_name: string; pp_refresh: number };
}

interface QuotaResponse {
  cap: number | 'unlimited';
  count: number;
  remaining: number | 'unlimited';
  resets_at_iso: string;
  tier: SubscriptionTierId;
}

interface DailyCapErrorEnvelope {
  ok: false;
  error: {
    code: 'CARD_SCAN_DAILY_CAP';
    message: string;
    cap: number;
    remaining: 0;
    resets_at_iso: string;
  };
}

// 15 MB raw — base64 expands ~33% so ~20 MB encoded. The client now resizes
// to ≤1600px / JPEG q0.7 so typical uploads land at 0.4-1 MB, but we keep
// headroom here for older iPhone HEIC→JPEG conversions, RAW captures, and
// any caller that skips the manipulator pipeline. Pairs with the 25 MB
// Fastify bodyLimit in server/src/index.ts.
const MAX_BASE64_BYTES = Math.ceil((15 * 1024 * 1024) * 4 / 3);

const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

/** Look up the player's PlayGM overall_grade from the player_ratings table.
 *  Falls back to 'C' when the player has no rating yet — that's a deliberately
 *  middling default so a brand-new rookie still grants a Common card rather
 *  than blocking the unlock entirely. */
async function fetchPlayerGrade(external_id: string): Promise<Grade> {
  try {
    const { data } = await supabase
      .from('player_ratings')
      .select('overall_grade, overall_tier')
      .eq('external_id', external_id)
      .maybeSingle();
    if (!data) return 'C';
    return ((data as { overall_grade?: Grade; overall_tier?: Grade }).overall_grade
      ?? (data as { overall_tier?: Grade }).overall_tier
      ?? 'C') as Grade;
  } catch {
    return 'C';
  }
}

// ─── Auth shim ────────────────────────────────────────────────────────────────
// TODO(auth): replace with `request.user.{id, subscription_tier}` once the
// auth task fully binds. See file header.

interface UserContext {
  user_id: string;
  tier: SubscriptionTierId;
}

function resolveUserContext(request: FastifyRequest): UserContext {
  const authHeader = request.headers['authorization'] ?? '';
  const handle = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : 'anonymous';
  // The handle is *not* a UUID, so we can't write it directly to a
  // UUID-typed column in production. The route still exercises the limiter
  // path end-to-end in tests via this stub; the auth task will replace
  // `user_id` with `request.user.id`.
  return {
    user_id: handle,
    tier: ((request.headers['x-subscription-tier'] as SubscriptionTierId | undefined) ??
      'free'),
  };
}

function envelopeForCap(d: LimiterDecision): DailyCapErrorEnvelope {
  return {
    ok: false,
    error: {
      code: 'CARD_SCAN_DAILY_CAP',
      message: `Daily card-scan cap (${d.cap}) reached for your tier — upgrade for more, or come back after the reset.`,
      cap: d.cap === Number.POSITIVE_INFINITY ? -1 : d.cap,
      remaining: 0,
      resets_at_iso: d.resets_at_iso,
    },
  };
}

function quotaResponseFor(d: LimiterDecision, tier: SubscriptionTierId): QuotaResponse {
  return {
    cap: d.cap === Number.POSITIVE_INFINITY ? 'unlimited' : d.cap,
    count: d.count,
    remaining: d.remaining === Infinity ? 'unlimited' : d.remaining,
    resets_at_iso: d.resets_at_iso,
    tier,
  };
}

function applyAdvisoryHeaders(reply: FastifyReply, d: LimiterDecision): void {
  reply.header('X-CardScan-Cap', String(d.cap === Number.POSITIVE_INFINITY ? -1 : d.cap));
  reply.header(
    'X-CardScan-Remaining',
    d.remaining === Infinity ? 'unlimited' : String(d.remaining),
  );
  reply.header('X-CardScan-ResetsAt', d.resets_at_iso);
}

// ─── Route ──────────────────────────────────────────────────────────────────

export async function cardScanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ScanBody; Reply: ScanResponse | DailyCapErrorEnvelope | { error: string; detail?: string } }>(
    '/cards/scan',
    {
      schema: {
        body: {
          type: 'object',
          required: ['image_base64'],
          properties: {
            image_base64: { type: 'string', minLength: 32 },
            media_type: {
              type: 'string',
              enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { image_base64, media_type } = request.body;
      const mediaType = media_type ?? 'image/jpeg';

      if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
        return reply.code(400).send({ error: `Unsupported media_type: ${mediaType}` });
      }

      if (image_base64.length > MAX_BASE64_BYTES) {
        return reply.code(413).send({
          error: 'Image too large — must be under 5MB after decode',
        });
      }

      const { user_id, tier } = resolveUserContext(request);

      // Per-(user, day) cap (subscription tier, persisted in Postgres).
      // Run BEFORE invoking Anthropic so over-cap callers never burn LLM spend.
      const decision = await checkAndIncrement(user_id, tier);
      if (!decision.allowed) {
        applyAdvisoryHeaders(reply, decision);
        return reply.code(429).send(envelopeForCap(decision));
      }

      // Strip data-URL prefix if the client sent one.
      const cleanedBase64 = image_base64.replace(/^data:[^;]+;base64,/, '');

      let extraction: CardScanExtraction;
      try {
        extraction = await extractCardFromImage({
          imageBase64: cleanedBase64,
          mediaType,
        });
      } catch (err) {
        const message = err instanceof CardScanLLMError ? err.message : 'Unknown vision error';
        fastify.log.error({ msg: 'Card scan vision error', err: String(err) });
        applyAdvisoryHeaders(reply, decision);
        return reply.code(502).send({ error: 'Vision service failed', detail: message });
      }

      const guess = extraction.template_id_guess;
      const template = guess ? findTemplateById(guess) : null;

      // IP scope: when the scanned card is NOT a recognized PlayGM template
      // (template === null), strip manufacturer-design-derived fields from
      // the response. We only surface factual data about the depicted
      // athlete: player_name, team, year, sport. See docs/card-scan-ip-policy.md.
      const sanitizedExtraction: CardScanExtraction = template
        ? extraction
        : {
            ...extraction,
            rarity: null,
            card_type: null,
            template_id_guess: null,
          };

      // PlayGM template hit — return the existing matched envelope unchanged.
      if (template) {
        const response: ScanResponse = {
          match_status: 'matched',
          extraction: sanitizedExtraction,
          template,
        };
        applyAdvisoryHeaders(reply, decision);
        return reply.send(response);
      }

      // ─── Third-party card → player lookup + scout-card grant ───────────────
      // Per docs/card-scan-ip-policy.md, we never reproduce the manufacturer's
      // design. Instead we look the depicted athlete up in our own roster and
      // grant a PlayGM-designed scout card sized by the player's overall_grade.
      const playerName = sanitizedExtraction.player_name;
      if (!playerName) {
        applyAdvisoryHeaders(reply, decision);
        return reply.send({
          match_status: 'unrecognized',
          extraction: sanitizedExtraction,
          template: null,
        } satisfies ScanResponse);
      }

      const matchResult: MatchResult = matchPlayer({
        player_name: playerName,
        sport: sanitizedExtraction.sport,
        team: sanitizedExtraction.team,
      });

      if (matchResult.kind === 'none') {
        applyAdvisoryHeaders(reply, decision);
        return reply.send({
          match_status: 'unrecognized',
          extraction: sanitizedExtraction,
          template: null,
        } satisfies ScanResponse);
      }

      if (matchResult.kind === 'multiple') {
        applyAdvisoryHeaders(reply, decision);
        return reply.send({
          match_status: 'multiple_players',
          extraction: sanitizedExtraction,
          template: null,
          candidates: matchResult.players.slice(0, 6).map((p) => ({
            external_id: p.external_id,
            full_name: p.full_name,
            team: p.team,
            league: p.league,
          })),
        } satisfies ScanResponse);
      }

      // Single match → look up the player's PlayGM grade then grant.
      const player = matchResult.player;
      const grade = await fetchPlayerGrade(player.external_id);

      try {
        const outcome: GrantOutcome = await grantScoutCard({
          user_id,
          player,
          grade,
        });

        if (outcome.kind === 'already_owned') {
          applyAdvisoryHeaders(reply, decision);
          return reply.send({
            match_status: 'already_owned',
            extraction: sanitizedExtraction,
            template: null,
            already_owned: {
              player_id: outcome.player_id,
              player_name: player.full_name,
              pp_refresh: outcome.pp_refresh,
            },
          } satisfies ScanResponse);
        }

        applyAdvisoryHeaders(reply, decision);
        return reply.send({
          match_status: 'scout_unlocked',
          extraction: sanitizedExtraction,
          template: null,
          unlocked: {
            template_id: outcome.template_id,
            player_id: outcome.player_id,
            player_name: player.full_name,
            team: player.team,
            position: player.position,
            league: player.league,
            rarity: outcome.rarity,
            grade: outcome.grade,
            needs_more_games: outcome.needs_more_games,
          },
        } satisfies ScanResponse);
      } catch (err) {
        fastify.log.error({ msg: 'scout card grant failed', err: String(err) });
        applyAdvisoryHeaders(reply, decision);
        return reply.code(502).send({ error: 'Grant failed', detail: String(err) });
      }
    },
  );

  // GET /cards/scan/quota — read-only quota probe for the client UI.
  fastify.get<{ Reply: QuotaResponse }>('/cards/scan/quota', async (request) => {
    const { user_id, tier } = resolveUserContext(request);
    const decision = await getQuota(user_id, tier);
    return quotaResponseFor(decision, tier);
  });
}
