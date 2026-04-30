/**
 * cardScan.ts
 * POST /cards/scan — Claude Haiku 4.5 vision OCR for trading cards.
 *
 * Accepts a base64-encoded image plus media_type, runs Anthropic vision,
 * and (if the model returned a recognizable PlayGM template_id_guess) matches
 * the result against data/cards/pgm_card_templates.json.
 *
 * Open route (no auth) — mirrors /scout/ask. Auth can be added later when the
 * full scan-once / claim-once flow lands.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import {
  extractCardFromImage,
  CardScanLLMError,
  type CardScanExtraction,
} from '../services/cardScanLLM.js';

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

type MatchStatus = 'matched' | 'unrecognized';

export interface ScanResponse {
  match_status: MatchStatus;
  extraction: CardScanExtraction;
  template: CardTemplate | null;
}

// 5MB raw — base64 expands ~33% so ~6.7MB encoded.
const MAX_BASE64_BYTES = Math.ceil((5 * 1024 * 1024) * 4 / 3);

const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

// ─── Route ──────────────────────────────────────────────────────────────────

export async function cardScanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ScanBody }>(
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
        return reply.code(502).send({ error: 'Vision service failed', detail: message });
      }

      const guess = extraction.template_id_guess;
      const template = guess ? findTemplateById(guess) : null;

      const response: ScanResponse = {
        match_status: template ? 'matched' : 'unrecognized',
        extraction,
        template,
      };
      return reply.send(response);
    },
  );
}
