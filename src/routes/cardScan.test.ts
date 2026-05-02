/**
 * cardScan.test.ts — integration coverage for POST /cards/scan +
 * GET /cards/scan/quota.
 *
 * Loads the real data/cards/pgm_card_templates.json (via the route's path
 * resolver) and mocks the Anthropic SDK so no network calls happen. Mocks
 * @supabase/supabase-js with the same in-memory store pattern used by
 * scoutAsk.test.ts so the per-day card scan limiter can be exercised
 * end-to-end. Verifies:
 *
 *   - Matched and unrecognized scan envelopes (existing behaviour).
 *   - 429 envelope shape when the per-day cap is hit.
 *   - X-CardScan-* headers on cap-hit responses.
 *   - Anthropic vision SDK is NOT invoked when over the cap.
 *   - GET /cards/scan/quota returns current state without incrementing.
 */

import path from 'node:path';
import Fastify from 'fastify';

// ─── Supabase env stubs (limiter imports the supabase client at module load) ─

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';
process.env['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'] ?? 'test-key';

// ─── Fake card_scan_usage store, keyed on (user_id, ymd) ─────────────────────

interface UsageRow { user_id: string; ymd: string; count: number; last_request_at: string }
const mockUsageStore = new Map<string, UsageRow>();
function mockKey(uid: string, ymd: string) { return uid + '::' + ymd; }

jest.mock('@supabase/supabase-js', () => {
  function makeChain(table: string) {
    let filterUid: string | null = null;
    let filterYmd: string | null = null;
    let mode: 'select' | 'upsert' = 'select';
    let upsertPayload: UsageRow | null = null;
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (col: string, val: string) => {
      if (col === 'user_id') filterUid = val;
      if (col === 'ymd') filterYmd = val;
      return chain;
    };
    chain.in = () => chain;
    chain.upsert = (payload: UsageRow) => {
      mode = 'upsert';
      upsertPayload = payload;
      return chain;
    };
    chain.maybeSingle = () => {
      if (table !== 'card_scan_usage') return Promise.resolve({ data: null, error: null });
      if (!filterUid || !filterYmd) return Promise.resolve({ data: null, error: null });
      const row = mockUsageStore.get(mockKey(filterUid, filterYmd));
      return Promise.resolve({ data: row ? { count: row.count } : null, error: null });
    };
    chain.single = () => {
      if (table !== 'card_scan_usage' || mode !== 'upsert' || !upsertPayload)
        return Promise.resolve({ data: null, error: null });
      const k = mockKey(upsertPayload.user_id, upsertPayload.ymd);
      const existing = mockUsageStore.get(k);
      if (existing) {
        const next = Math.max(existing.count + 1, upsertPayload.count);
        mockUsageStore.set(k, { ...upsertPayload, count: next });
        return Promise.resolve({ data: { count: next }, error: null });
      }
      mockUsageStore.set(k, upsertPayload);
      return Promise.resolve({ data: { count: upsertPayload.count }, error: null });
    };
    return chain;
  }
  return {
    __esModule: true,
    createClient: () => ({
      from: (table: string) => makeChain(table),
      auth: { persistSession: false },
    }),
  };
});

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

const SCAN_PAYLOAD = {
  image_base64: 'AAAA'.repeat(16),
  media_type: 'image/jpeg' as const,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /cards/scan', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUsageStore.clear();
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
      headers: { 'content-type': 'application/json', authorization: 'Bearer u_match' },
      payload: SCAN_PAYLOAD,
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
    // Allowed scans get advisory headers too.
    expect(res.headers['x-cardscan-cap']).toBe('2');
    expect(res.headers['x-cardscan-remaining']).toBe('1');

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
      headers: { 'content-type': 'application/json', authorization: 'Bearer u_unrec' },
      payload: SCAN_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { match_status: string; template: unknown };
    expect(body.match_status).toBe('unrecognized');
    expect(body.template).toBeNull();
    await app.close();
  });
});

describe('POST /cards/scan — daily cap envelope', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUsageStore.clear();
    _resetTemplatesCacheForTests();
    // Sensible default for the 2 allowed scans before the 3rd is denied.
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({
        player_name: null, team: null, sport: null, rarity: null, card_type: null,
        template_id_guess: null, confidence: 0.1, raw_text_extracted: '',
      }) }],
    });
  });

  it('returns 429 with CARD_SCAN_DAILY_CAP envelope when over cap (free tier = 2)', async () => {
    const app = await buildApp();
    // Burn the 2-call free cap.
    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: 'POST',
        url: '/cards/scan',
        headers: { 'content-type': 'application/json', authorization: 'Bearer cap_user' },
        payload: SCAN_PAYLOAD,
      });
      expect(ok.statusCode).toBe(200);
    }
    // 3rd call must be denied with the structured envelope + advisory headers.
    const blocked = await app.inject({
      method: 'POST',
      url: '/cards/scan',
      headers: { 'content-type': 'application/json', authorization: 'Bearer cap_user' },
      payload: SCAN_PAYLOAD,
    });
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json() as {
      ok: boolean;
      error: { code: string; cap: number; remaining: number; resets_at_iso: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('CARD_SCAN_DAILY_CAP');
    expect(body.error.cap).toBe(2);
    expect(body.error.remaining).toBe(0);
    expect(typeof body.error.resets_at_iso).toBe('string');
    expect(blocked.headers['x-cardscan-cap']).toBe('2');
    expect(blocked.headers['x-cardscan-remaining']).toBe('0');
    expect(typeof blocked.headers['x-cardscan-resetsat']).toBe('string');

    await app.close();
  });

  it('does NOT call Anthropic vision when the request is over cap', async () => {
    const app = await buildApp();
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST',
        url: '/cards/scan',
        headers: { 'content-type': 'application/json', authorization: 'Bearer no_anthropic' },
        payload: SCAN_PAYLOAD,
      });
    }
    const callsBeforeOverCap = mockCreate.mock.calls.length;
    expect(callsBeforeOverCap).toBe(2);
    const blocked = await app.inject({
      method: 'POST',
      url: '/cards/scan',
      headers: { 'content-type': 'application/json', authorization: 'Bearer no_anthropic' },
      payload: SCAN_PAYLOAD,
    });
    expect(blocked.statusCode).toBe(429);
    expect(mockCreate.mock.calls.length).toBe(callsBeforeOverCap); // unchanged

    await app.close();
  });
});

describe('GET /cards/scan/quota', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockUsageStore.clear();
    _resetTemplatesCacheForTests();
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({
        player_name: null, team: null, sport: null, rarity: null, card_type: null,
        template_id_guess: null, confidence: 0.1, raw_text_extracted: '',
      }) }],
    });
  });

  it('returns current quota without consuming a credit', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/cards/scan',
      headers: { 'content-type': 'application/json', authorization: 'Bearer q_user' },
      payload: SCAN_PAYLOAD,
    });

    const r1 = await app.inject({
      method: 'GET',
      url: '/cards/scan/quota',
      headers: { authorization: 'Bearer q_user' },
    });
    expect(r1.statusCode).toBe(200);
    const q1 = r1.json() as { cap: number; count: number; remaining: number; tier: string };
    expect(q1).toEqual(expect.objectContaining({ cap: 2, count: 1, remaining: 1, tier: 'free' }));

    // Re-reading should NOT increment.
    const r2 = await app.inject({
      method: 'GET',
      url: '/cards/scan/quota',
      headers: { authorization: 'Bearer q_user' },
    });
    expect((r2.json() as { count: number }).count).toBe(1);

    await app.close();
  });

  it('reports tier-aware caps when x-subscription-tier is provided', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'GET',
      url: '/cards/scan/quota',
      headers: {
        authorization: 'Bearer q_play',
        'x-subscription-tier': 'playmaker',
      },
    });
    const q = r.json() as { cap: number; count: number; remaining: number; tier: string };
    expect(q.cap).toBe(10);
    expect(q.count).toBe(0);
    expect(q.remaining).toBe(10);
    expect(q.tier).toBe('playmaker');

    await app.close();
  });
});
