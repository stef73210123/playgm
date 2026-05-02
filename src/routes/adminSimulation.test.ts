/**
 * adminSimulation.test.ts — smoke tests for the scoring editor route.
 *
 * Mocks node:fs/promises so writes are captured without touching disk;
 * ADMIN_EDIT_AUTOCOMMIT=0 disables git side effects. Stubs Supabase env so
 * adminEdit.ts (whose shared exports we re-use) can import its client.
 */
import Fastify from 'fastify';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';
process.env['ADMIN_EDIT_AUTOCOMMIT'] = '0';

jest.mock('@supabase/supabase-js', () => ({
  __esModule: true,
  createClient: () => ({
    from: () => ({
      upsert: () => Promise.resolve({ error: null }),
      select: () => ({
        eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
    }),
    auth: { persistSession: false },
  }),
}));

const mockWrites: Array<{ path: string; data: string }> = [];

const FORMULA_FIXTURE = {
  version: '1.0.0',
  by_sport: {
    basketball: { weights: { points: 1, rebounds: 1.2 }, games_per_week: 3.5 },
    football: { weights: { passing_yds: 0.04, passing_tds: 4 }, games_per_week: 1 },
    baseball: { hitter_weights: { hits: 1 }, pitcher_weights: { wins: 4 }, games_per_week: 6 },
    hockey: { skater_weights: { goals: 3 }, goalie_weights: { saves: 0.4 }, games_per_week: 3.5 },
    soccer: { weights: { goals: 6 }, games_per_week: 1.5 },
  },
  global: {
    roster_size: 5,
    min_picks_per_sport: { basketball: 0, football: 0, baseball: 0, hockey: 0, soccer: 0 },
    synthetic_user_count: 100,
    draft_position_strategy: 'snake',
    weekly_energy_budget: 8,
  },
};

jest.mock('node:fs/promises', () => {
  return {
    __esModule: true,
    default: {
      readFile: async (p: string): Promise<string> => {
        if (p.endsWith('pgm_scoring_formula.json')) return JSON.stringify(FORMULA_FIXTURE);
        throw new Error('unmocked readFile: ' + p);
      },
      writeFile: async (p: string, data: string): Promise<void> => {
        mockWrites.push({ path: p, data });
      },
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { adminSimulationRoutes } =
  require('./adminSimulation.js') as typeof import('./adminSimulation.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(adminSimulationRoutes, { prefix: '/' });
  return app;
}

describe('admin simulation routes', () => {
  beforeEach(() => {
    mockWrites.length = 0;
  });

  it('GET /admin/edit/scoring renders self-contained HTML', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/edit/scoring' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Fantasy Scoring Formula');
      expect(res.body).not.toMatch(/<script[^>]+src=/i);
      expect(res.body).not.toMatch(/<link[^>]+stylesheet/i);
    } finally {
      await app.close();
    }
  });

  it('GET /admin/api/scoring returns the doc', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/api/scoring' });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; doc: { version: string } };
      expect(j.ok).toBe(true);
      expect(j.doc.version).toBe('1.0.0');
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/scoring rejects non-numeric weight', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/scoring',
        payload: { by_sport: { basketball: { weights: { points: 'not-a-number' } } } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/scoring rejects out-of-range roster_size', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/scoring',
        payload: { global: { roster_size: 99 } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/scoring accepts a valid weight update + writes file', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/scoring',
        payload: { by_sport: { basketball: { weights: { points: 1.5 } } } },
      });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; doc: { by_sport: { basketball: { weights: { points: number; rebounds: number } } } } };
      expect(j.ok).toBe(true);
      expect(j.doc.by_sport.basketball.weights.points).toBe(1.5);
      expect(j.doc.by_sport.basketball.weights.rebounds).toBe(1.2);
      expect(mockWrites.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('GET /admin/simulate renders the simulator form', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/simulate' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Fairness Simulator');
    } finally {
      await app.close();
    }
  });

  it('POST /admin/api/simulate rejects empty leagues', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/api/simulate',
        payload: { leagues: [] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('GET /admin/api/simulate returns runs+trend (empty in test)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/api/simulate' });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; runs: unknown[]; trend: unknown[] };
      expect(j.ok).toBe(true);
      expect(Array.isArray(j.runs)).toBe(true);
      expect(Array.isArray(j.trend)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
