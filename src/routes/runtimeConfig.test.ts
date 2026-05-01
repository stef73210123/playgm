/**
 * runtimeConfig.test.ts — smoke tests for /api/config/v1.
 *
 * Mocks node:fs/promises to serve canned spec files; verifies envelope shape,
 * cache_ttl_seconds, all 10 spec keys, and that the in-memory cache returns
 * the same generated_at on the second call.
 */
import Fastify from 'fastify';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';

jest.mock('@supabase/supabase-js', () => ({
  __esModule: true,
  createClient: () => ({ from: () => ({}), auth: { persistSession: false } }),
}));

const stubDoc = { version: '1.0.0', stub: true };

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  default: {
    readFile: async (p: string): Promise<string> => {
      if (p.endsWith('pgm_card_templates.json')) {
        return JSON.stringify({ version: '3.0.0', card_templates: [] });
      }
      if (p.endsWith('age_feature_matrix.json')) {
        return JSON.stringify({ version: '1.0.0', features: [] });
      }
      return JSON.stringify(stubDoc);
    },
    writeFile: async (): Promise<void> => undefined,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runtimeConfigRoutes, invalidateConfigCache } =
  require('./runtimeConfig.js') as typeof import('./runtimeConfig.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(runtimeConfigRoutes, { prefix: '/' });
  return app;
}

describe('runtimeConfig route', () => {
  beforeEach(() => {
    invalidateConfigCache();
  });

  it('GET /api/config/v1 returns envelope with all 10 spec keys', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/config/v1' });
      expect(res.statusCode).toBe(200);
      const j = res.json() as {
        version: string;
        generated_at: string;
        cache_ttl_seconds: number;
        specs: Record<string, unknown>;
      };
      expect(j.version).toBe('1.0.0');
      expect(j.cache_ttl_seconds).toBe(600);
      expect(typeof j.generated_at).toBe('string');
      const expectedKeys = [
        'progression',
        'pp_earn_rates',
        'subscriptions',
        'streak_rewards',
        'packs',
        'pity_timers',
        'triggers',
        'stat_resolution',
        'card_templates',
        'safety_matrix',
      ];
      for (const k of expectedKeys) {
        expect(j.specs[k]).toBeDefined();
      }
    } finally {
      await app.close();
    }
  });

  it('returns cached payload on second call within TTL', async () => {
    const app = await buildApp();
    try {
      const a = await app.inject({ method: 'GET', url: '/api/config/v1' });
      const b = await app.inject({ method: 'GET', url: '/api/config/v1' });
      const ja = a.json() as { generated_at: string };
      const jb = b.json() as { generated_at: string };
      expect(ja.generated_at).toBe(jb.generated_at);
    } finally {
      await app.close();
    }
  });

  it('invalidateConfigCache forces a fresh build', async () => {
    const app = await buildApp();
    try {
      const a = await app.inject({ method: 'GET', url: '/api/config/v1' });
      const ja = a.json() as { generated_at: string };
      // bump time so the new ISO timestamp differs
      await new Promise((r) => setTimeout(r, 10));
      invalidateConfigCache();
      const b = await app.inject({ method: 'GET', url: '/api/config/v1' });
      const jb = b.json() as { generated_at: string };
      expect(ja.generated_at).not.toBe(jb.generated_at);
    } finally {
      await app.close();
    }
  });

  it('cache_ttl_seconds equals 600', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/config/v1' });
      const j = res.json() as { cache_ttl_seconds: number };
      expect(j.cache_ttl_seconds).toBe(600);
    } finally {
      await app.close();
    }
  });
});
