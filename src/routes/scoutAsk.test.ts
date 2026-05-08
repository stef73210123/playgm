/**
 * scoutAsk.test.ts — integration coverage for POST /scout/ask + GET /scout/quota.
 *
 * Verifies:
 *   - 429 envelope shape when the per-day cap is hit.
 *   - X-AskScout-* headers on cap-hit responses.
 *   - Anthropic LLM is NOT invoked when over the cap.
 *   - /scout/quota returns the current state without consuming a credit.
 *
 * Mocks @supabase/supabase-js with the same in-memory store pattern as
 * askScoutLimiter.test.ts. Anthropic SDK is mocked so no network calls happen.
 */

import Fastify from 'fastify';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';
process.env['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'] ?? 'test-key';
// Pin the dispatcher to the Anthropic backend for this test — these
// suites mock `@anthropic-ai/sdk` and assert on its mock counter. The
// production default flipped to Gemini in 2026-05; pinning here keeps
// the limiter assertions independent of the active backend.
process.env['SCOUT_LLM_PROVIDER'] = 'anthropic';

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
      if (table !== 'ask_scout_usage') return Promise.resolve({ data: null, error: null });
      if (!filterUid || !filterYmd) return Promise.resolve({ data: null, error: null });
      const row = mockUsageStore.get(mockKey(filterUid, filterYmd));
      return Promise.resolve({ data: row ? { count: row.count } : null, error: null });
    };
    chain.single = () => {
      if (table !== 'ask_scout_usage' || mode !== 'upsert' || !upsertPayload)
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

// Mock the Anthropic SDK so we can ASSERT it was/wasn't called.
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scoutAskRoutes } = require('./scoutAsk.js') as typeof import('./scoutAsk.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(scoutAskRoutes, { prefix: '/' });
  return app;
}

beforeEach(() => {
  mockUsageStore.clear();
  mockAnthropicCreate.mockReset();
  mockAnthropicCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'The Lakers play in Los Angeles.' }],
  });
});

describe('POST /scout/ask — daily cap envelope', () => {
  it('returns 429 with ASK_SCOUT_DAILY_CAP envelope when over cap (free tier = 2)', async () => {
    const app = await buildApp();
    // Burn the 2-call free cap.
    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: 'POST',
        url: '/scout/ask',
        headers: { Authorization: 'Bearer u1' },
        payload: { question: 'Who won the NBA finals?' },
      });
      expect(ok.statusCode).toBe(200);
    }
    // 3rd call must be denied with the structured envelope + advisory headers.
    const blocked = await app.inject({
      method: 'POST',
      url: '/scout/ask',
      headers: { Authorization: 'Bearer u1' },
      payload: { question: 'And the Super Bowl?' },
    });
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json() as {
      ok: boolean;
      error: { code: string; cap: number; remaining: number; resets_at_iso: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('ASK_SCOUT_DAILY_CAP');
    expect(body.error.cap).toBe(2);
    expect(body.error.remaining).toBe(0);
    expect(typeof body.error.resets_at_iso).toBe('string');
    expect(blocked.headers['x-askscout-cap']).toBe('2');
    expect(blocked.headers['x-askscout-remaining']).toBe('0');
    expect(typeof blocked.headers['x-askscout-resetsat']).toBe('string');
  });

  it('does NOT call Anthropic when the request is over cap', async () => {
    const app = await buildApp();
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST',
        url: '/scout/ask',
        headers: { Authorization: 'Bearer u2' },
        payload: { question: 'Tell me about the Yankees.' },
      });
    }
    const callsBeforeOverCap = mockAnthropicCreate.mock.calls.length;
    expect(callsBeforeOverCap).toBe(2);
    const blocked = await app.inject({
      method: 'POST',
      url: '/scout/ask',
      headers: { Authorization: 'Bearer u2' },
      payload: { question: 'one more please' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(mockAnthropicCreate.mock.calls.length).toBe(callsBeforeOverCap); // unchanged
  });

  it('respects higher tiers — champion (cap=20) and playmaker (cap=10) keep allowing calls past the free cap', async () => {
    const app = await buildApp();
    // Stay under the in-memory minute rate-limit (5/min/handle) by alternating
    // handles. The DB-side per-day cap is what we're verifying; the minute
    // limit is a separate sidecar guard.
    const champ1 = await app.inject({
      method: 'POST',
      url: '/scout/ask',
      headers: { Authorization: 'Bearer uChampA', 'x-subscription-tier': 'champion' },
      payload: { question: 'who is mvp?' },
    });
    expect(champ1.statusCode).toBe(200);
    const playmaker1 = await app.inject({
      method: 'POST',
      url: '/scout/ask',
      headers: { Authorization: 'Bearer uPlayA', 'x-subscription-tier': 'playmaker' },
      payload: { question: 'who is mvp?' },
    });
    expect(playmaker1.statusCode).toBe(200);
    // Quota responses should reflect the right caps.
    const cQuota = await app.inject({
      method: 'GET',
      url: '/scout/quota',
      headers: { Authorization: 'Bearer uChampA', 'x-subscription-tier': 'champion' },
    });
    expect(cQuota.json()).toEqual(
      expect.objectContaining({ cap: 20, count: 1, remaining: 19, tier: 'champion' }),
    );
    const pQuota = await app.inject({
      method: 'GET',
      url: '/scout/quota',
      headers: { Authorization: 'Bearer uPlayA', 'x-subscription-tier': 'playmaker' },
    });
    expect(pQuota.json()).toEqual(
      expect.objectContaining({ cap: 10, count: 1, remaining: 9, tier: 'playmaker' }),
    );
  });
});

describe('GET /scout/quota', () => {
  it('returns current quota without incrementing', async () => {
    const app = await buildApp();
    // Make one call, then check quota.
    await app.inject({
      method: 'POST',
      url: '/scout/ask',
      headers: { Authorization: 'Bearer qu1' },
      payload: { question: 'first one' },
    });
    const r1 = await app.inject({
      method: 'GET',
      url: '/scout/quota',
      headers: { Authorization: 'Bearer qu1' },
    });
    expect(r1.statusCode).toBe(200);
    const q1 = r1.json() as { cap: number; count: number; remaining: number; tier: string };
    expect(q1.cap).toBe(2);
    expect(q1.count).toBe(1);
    expect(q1.remaining).toBe(1);
    expect(q1.tier).toBe('free');
    // Calling /scout/quota again should NOT increment.
    const r2 = await app.inject({
      method: 'GET',
      url: '/scout/quota',
      headers: { Authorization: 'Bearer qu1' },
    });
    const q2 = r2.json() as { count: number };
    expect(q2.count).toBe(1);
  });

  it('reports tier-aware caps when x-subscription-tier is provided', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'GET',
      url: '/scout/quota',
      headers: {
        Authorization: 'Bearer qu2',
        'x-subscription-tier': 'playmaker',
      },
    });
    const q = r.json() as { cap: number; count: number; remaining: number; tier: string };
    expect(q.cap).toBe(10);
    expect(q.count).toBe(0);
    expect(q.remaining).toBe(10);
    expect(q.tier).toBe('playmaker');
  });
});
