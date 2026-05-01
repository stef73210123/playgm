/**
 * admin.test.ts — smoke tests for /admin/status and /admin/dashboard.
 *
 * The external probes are mocked at the healthChecks-service level so this
 * suite never hits the network. Supabase is mocked at the @supabase/supabase-js
 * level: every `from(table).select(..., {count, head})` call resolves to
 * { count: 0, error: null } — exercises the success path of countRows()
 * without reaching out to a real DB.
 */
import path from 'node:path';
import Fastify from 'fastify';

// Make sure dataCorpus resolves files relative to the real project root.
process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';
process.env['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'] ?? 'stub';
process.env['ELEVENLABS_API_KEY'] = process.env['ELEVENLABS_API_KEY'] ?? 'stub';
process.env['ELEVENLABS_VOICE_ID'] = process.env['ELEVENLABS_VOICE_ID'] ?? 'stub-voice';
process.env['SPORTSDB_V2_KEY'] = process.env['SPORTSDB_V2_KEY'] ?? 'stub';

// Anchor data-file resolution to the canonical project root so tests pass
// regardless of where Jest is launched from (root vs. server/).
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
// dataCorpus.ts uses import.meta.url and computes ../../../../ from itself,
// which gives the right path. No env override needed.

// ─── Mock @supabase/supabase-js so db/client.ts doesn't reach the network ─
// Jest hoists jest.mock() above all imports, so the factory can't reference
// out-of-scope variables. Inline the chain inside the factory.
jest.mock('@supabase/supabase-js', () => {
  function makeChain() {
    const result = { count: 0, data: [], error: null as null | { message: string } };
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.gte = () => chain;
    chain.not = () => chain;
    chain.limit = () => chain;
    chain.order = () => chain;
    chain.then = (resolve: (v: typeof result) => unknown) => Promise.resolve(resolve(result));
    return chain;
  }
  return {
    __esModule: true,
    createClient: () => ({
      from: () => makeChain(),
      auth: { persistSession: false },
    }),
  };
});

// ─── Mock the external probes — no network. ─────────────────────────────
jest.mock('../services/healthChecks.js', () => {
  const make = (status: 'up' | 'down' | 'unknown') => async () => ({
    status,
    latency_ms: 12,
    last_checked_at: new Date().toISOString(),
  });
  return {
    __esModule: true,
    probeAnthropic:  make('up'),
    probeElevenLabs: make('up'),
    probeSupabase:   make('up'),
    probeSportsDb:   make('up'),
    probeWikimedia:  make('up'),
    _resetHealthCheckCacheForTests: () => {},
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { adminRoutes, installRouteTracker } =
  require('./admin.js') as typeof import('./admin.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { _resetDataCorpusCacheForTests } =
  require('../services/dataCorpus.js') as typeof import('../services/dataCorpus.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { _resetSupabaseAdminCacheForTests } =
  require('../services/supabaseAdmin.js') as typeof import('../services/supabaseAdmin.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  installRouteTracker(app);
  app.get('/health', async () => ({ ok: true }));
  await app.register(adminRoutes, { prefix: '/' });
  return app;
}

describe('admin routes', () => {
  beforeEach(() => {
    _resetDataCorpusCacheForTests();
    _resetSupabaseAdminCacheForTests();
  });

  it('GET /admin/status returns the full aggregator shape', async () => {
    void PROJECT_ROOT; // referenced to keep tsc happy if unused
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body['generated_at']).toEqual(expect.any(String));
      expect(body['server']).toMatchObject({
        uptime_seconds: expect.any(Number),
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: 'present',
          SUPABASE_URL: 'present',
        }),
      });
      const ext = body['external_services'] as Record<string, { status: string; purpose: string }>;
      expect(ext.anthropic.status).toBe('up');
      expect(ext.elevenlabs.purpose).toMatch(/voice/i);
      expect(ext.sportsdb_v2.status).toBe('up');
      const corpus = body['data_corpus'] as Record<string, unknown>;
      // The repo ships 5 trivia files at ~650 each — total > 3000.
      expect(typeof corpus['trivia_questions_total']).toBe('number');
      expect(corpus['card_templates']).toBeGreaterThan(0);
      expect(corpus['stat_tier_files']).toBe(5);
      const routes = body['internal_routes'] as Array<{ path: string }>;
      expect(routes.some((r) => r.path === '/health')).toBe(true);
      expect(routes.some((r) => r.path === '/admin/status')).toBe(true);
      // New keys from the Economic Metrics extension.
      expect(body['economic_metrics']).toEqual(
        expect.objectContaining({
          pp: expect.any(Object),
          packs: expect.any(Object),
          cards: expect.any(Object),
          subscriptions: expect.any(Object),
          rosters: expect.any(Object),
          trivia_picks: expect.any(Object),
          retention: expect.any(Object),
        }),
      );
      expect(body['economic_targets']).toEqual(
        expect.objectContaining({
          pp: expect.any(Object),
          cards: expect.any(Object),
          business: expect.any(Object),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('GET /admin/dashboard returns self-contained HTML', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/dashboard' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      const html = res.body;
      expect(html).toContain('<title>PlayGM Status</title>');
      // No external script/style tags — must be self-contained.
      expect(html).not.toMatch(/<script[^>]+src=/i);
      expect(html).not.toMatch(/<link[^>]+stylesheet/i);
      expect(html).toContain('/admin/status');
    } finally {
      await app.close();
    }
  });
});
