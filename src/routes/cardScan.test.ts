/**
 * cardScan.test.ts — smoke test for POST /cards/scan.
 *
 * Loads the real data/cards/pgm_card_templates.json (via the route's path
 * resolver) and mocks the Anthropic SDK so no network calls happen. Verifies
 * the route returns the matched template envelope when the model emits a
 * known template_id_guess.
 */

import path from 'node:path';
import Fastify from 'fastify';

// ─── Mock the Anthropic SDK before importing anything that uses it ──────────

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
  };
});

// Force the cardScanLLM client to instantiate.
process.env['ANTHROPIC_API_KEY'] = 'test-key';

// Pin the templates path to the canonical file so the test passes regardless
// of where Jest is launched from (root vs. server/).
process.env['PGM_CARD_TEMPLATES_PATH'] = path.resolve(
  __dirname, '..', '..', '..', 'data', 'cards', 'pgm_card_templates.json',
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cardScanRoutes, _resetTemplatesCacheForTests } =
  require('./cardScan.js') as typeof import('./cardScan.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockVisionExtraction(payload: Record<string, unknown>): void {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cardScanRoutes, { prefix: '/' });
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /cards/scan', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    _resetTemplatesCacheForTests();
  });

  it('returns the matched template when Anthropic guesses a known template_id', async () => {
    mockVisionExtraction({
      player_name: null,
      team: null,
      sport: null,
      rarity: 'common',
      card_type: 'stat_boost',
      template_id_guess: 'sb_common_p5',
      confidence: 0.92,
      raw_text_extracted: 'STEADY HAND\nCommon · +5% primary stat',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/cards/scan',
      headers: { 'content-type': 'application/json' },
      payload: {
        // tiny non-zero base64 payload — under the 5MB cap, over the 32-char min
        image_base64: 'AAAA'.repeat(16),
        media_type: 'image/jpeg',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      match_status: string;
      extraction: { template_id_guess: string | null; confidence: number };
      template: { template_id: string; name: string } | null;
    };
    expect(body.match_status).toBe('matched');
    expect(body.template).not.toBeNull();
    expect(body.template?.template_id).toBe('sb_common_p5');
    expect(body.template?.name).toBe('Steady Hand');
    expect(body.extraction.template_id_guess).toBe('sb_common_p5');
    expect(body.extraction.confidence).toBeCloseTo(0.92, 5);

    await app.close();
  });

  it('returns match_status=unrecognized when template_id_guess is null', async () => {
    mockVisionExtraction({
      player_name: 'Stephen Curry',
      team: 'Golden State Warriors',
      sport: 'basketball',
      rarity: 'legendary',
      card_type: null,
      template_id_guess: null,
      confidence: 0.4,
      raw_text_extracted: 'STEPHEN CURRY\nGolden State Warriors',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/cards/scan',
      headers: { 'content-type': 'application/json' },
      payload: {
        image_base64: 'AAAA'.repeat(16),
        media_type: 'image/jpeg',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { match_status: string; template: unknown };
    expect(body.match_status).toBe('unrecognized');
    expect(body.template).toBeNull();
    await app.close();
  });
});
