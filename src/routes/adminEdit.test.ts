/**
 * adminEdit.test.ts — smoke tests for the editable inventory pages.
 *
 * Mocks:
 *   - @supabase/supabase-js: every players/teams query resolves to a fixed
 *     in-memory row. PATCH updates round-trip through the in-memory store.
 *   - node:fs/promises: readFile returns canned card-template + trivia JSON;
 *     writeFile is a no-op spy so tests never mutate disk.
 *   - autoCommit (via env flag): ADMIN_EDIT_AUTOCOMMIT=0 disables git calls.
 */
import path from 'node:path';
import Fastify from 'fastify';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';
process.env['ADMIN_EDIT_AUTOCOMMIT'] = '0';

// ─── In-memory Supabase store ───────────────────────────────────────────
type Row = Record<string, unknown>;
const store: Record<string, Row[]> = {
  players: [
    {
      id: 'p1',
      full_name: 'LeBron James',
      position: 'SF',
      jersey_number: 23,
      category: 'basketball',
      team_id: 't1',
      meta_json: {},
    },
    {
      id: 'p2',
      full_name: 'Patrick Mahomes',
      position: 'QB',
      jersey_number: 15,
      category: 'football',
      team_id: 't2',
      meta_json: { video_highlight_url: 'https://example.com/m' },
    },
  ],
  teams: [
    {
      id: 't1',
      full_name: 'Los Angeles Lakers',
      name: 'Lakers',
      city: 'Los Angeles',
      abbreviation: 'LAL',
      category: 'basketball',
      meta_json: {},
    },
  ],
};

jest.mock('@supabase/supabase-js', () => {
  function makeQuery(table: string) {
    let rows: Row[] = (store[table] ?? []).slice();
    let updatePayload: Row | null = null;
    let mode: 'select' | 'update' = 'select';
    let count: 'exact' | undefined;
    const query: Record<string, unknown> = {};
    query.select = (_cols: string, opts?: { count?: 'exact' }) => {
      mode = 'select';
      count = opts?.count;
      return query;
    };
    query.update = (payload: Row) => {
      mode = 'update';
      updatePayload = payload;
      return query;
    };
    query.eq = (col: string, val: unknown) => {
      rows = rows.filter((r) => r[col] === val);
      return query;
    };
    query.ilike = (_col: string, _val: string) => query;
    query.gte = () => query;
    query.not = () => query;
    query.limit = () => query;
    query.range = () => query;
    query.order = () => query;
    query.then = (resolve: (v: unknown) => unknown) => {
      if (mode === 'update' && updatePayload) {
        for (const r of rows) {
          Object.assign(r, updatePayload);
          // mutate the master store too
          const masterRow = (store[table] ?? []).find((m) => m['id'] === r['id']);
          if (masterRow) Object.assign(masterRow, updatePayload);
        }
        return Promise.resolve(resolve({ data: rows, error: null }));
      }
      const result = { data: rows, error: null, count: count ? rows.length : null };
      return Promise.resolve(resolve(result));
    };
    return query;
  }
  return {
    __esModule: true,
    createClient: () => ({
      from: (table: string) => makeQuery(table),
      auth: { persistSession: false },
    }),
  };
});

// ─── Mock fs/promises so disk is never mutated ──────────────────────────
const cardFile = {
  version: '3.0.0',
  card_templates: [
    {
      template_id: 'sb_common_p5',
      name: 'Steady Hand',
      card_type: 'stat_boost',
      rarity: 'common',
      energy_cost: 1,
      sport: 'any',
      effect: { type: 'stat_boost', stat_boosts: [] },
      display: { description_short: '+5% primary stat' },
    },
  ],
};
const triviaFile: Record<string, unknown[]> = {
  basketball: [
    {
      id: 'bball_e_rules_001',
      sport: 'basketball',
      difficulty: 'easy',
      category: 'rules',
      question: 'How many players?',
      answer_correct: '5',
      answer_options: ['4', '5', '6', '7'],
      explanation: 'because',
    },
  ],
  football: [],
  baseball: [],
  hockey: [],
  soccer: [],
};
const writes: Array<{ path: string; data: string }> = [];

jest.mock('node:fs/promises', () => {
  return {
    __esModule: true,
    default: {
      readFile: async (p: string): Promise<string> => {
        if (p.endsWith('pgm_card_templates.json')) return JSON.stringify(cardFile);
        const m = p.match(/trivia_(\w+)\.json$/);
        if (m) {
          const sport = m[1] as keyof typeof triviaFile;
          return JSON.stringify(triviaFile[sport] ?? []);
        }
        throw new Error('unmocked readFile: ' + p);
      },
      writeFile: async (p: string, data: string): Promise<void> => {
        writes.push({ path: p, data });
      },
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { adminEditRoutes } = require('./adminEdit.js') as typeof import('./adminEdit.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(adminEditRoutes, { prefix: '/' });
  return app;
}

describe('admin edit routes', () => {
  beforeEach(() => {
    writes.length = 0;
  });

  // ─── HTML pages render ────────────────────────────────────────────────
  it.each([
    ['/admin/edit/players', 'Player Video Links'],
    ['/admin/edit/teams', 'Team Video Links'],
    ['/admin/edit/cards', 'Card Template Inventory'],
    ['/admin/edit/trivia', 'Trivia Question Inventory'],
  ])('GET %s renders self-contained HTML', async (url, marker) => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain(marker);
      // No external script/style tags — must be self-contained.
      expect(res.body).not.toMatch(/<script[^>]+src=/i);
      expect(res.body).not.toMatch(/<link[^>]+stylesheet/i);
    } finally {
      await app.close();
    }
  });

  // ─── Players ──────────────────────────────────────────────────────────
  it('GET /admin/api/players returns extracted video URLs from meta_json', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/api/players' });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; items: Array<Record<string, unknown>> };
      expect(j.ok).toBe(true);
      expect(j.items.length).toBeGreaterThan(0);
      const lebron = j.items.find((p) => p['id'] === 'p1');
      expect(lebron).toBeDefined();
      expect(lebron!['video_highlight_url']).toBe('');
      const mahomes = j.items.find((p) => p['id'] === 'p2');
      expect(mahomes!['video_highlight_url']).toBe('https://example.com/m');
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/players/:id rejects non-HTTPS URL', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/players/p1',
        payload: { video_highlight_url: 'http://insecure.example' },
      });
      expect(res.statusCode).toBe(400);
      const j = res.json() as { ok: boolean; errors: Array<{ field: string }> };
      expect(j.ok).toBe(false);
      expect(j.errors.some((e) => e.field === 'video_highlight_url')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/players/:id accepts empty string and HTTPS', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/players/p1',
        payload: {
          video_highlight_url: 'https://youtube.com/abc',
          video_about_url: '',
        },
      });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; meta_json: Record<string, string> };
      expect(j.ok).toBe(true);
      expect(j.meta_json['video_highlight_url']).toBe('https://youtube.com/abc');
      expect(j.meta_json['video_about_url']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  // ─── Teams ────────────────────────────────────────────────────────────
  it('GET /admin/api/teams returns 1 team', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/api/teams' });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; items: unknown[] };
      expect(j.items.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/teams/:id updates URL', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/teams/t1',
        payload: { video_about_url: 'https://nba.com/lakers' },
      });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; meta_json: Record<string, string> };
      expect(j.meta_json['video_about_url']).toBe('https://nba.com/lakers');
    } finally {
      await app.close();
    }
  });

  // ─── Cards ────────────────────────────────────────────────────────────
  it('GET /admin/api/cards returns the card templates file', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/api/cards' });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; items: Array<{ template_id: string }> };
      expect(j.ok).toBe(true);
      expect(j.items[0]!.template_id).toBe('sb_common_p5');
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/cards/:id rejects bad rarity', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/cards/sb_common_p5',
        payload: { rarity: 'mythic' },
      });
      expect(res.statusCode).toBe(400);
      const j = res.json() as { ok: boolean; errors: Array<{ field: string }> };
      expect(j.errors.some((e) => e.field === 'rarity')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/cards/:id rejects out-of-range energy_cost', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/cards/sb_common_p5',
        payload: { energy_cost: 99 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/cards/:id accepts a valid update + writes the file', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/cards/sb_common_p5',
        payload: { name: 'Steady Hands v2' },
      });
      expect(res.statusCode).toBe(200);
      expect(writes.length).toBe(1);
      expect(writes[0]!.path).toMatch(/pgm_card_templates\.json$/);
      expect(writes[0]!.data).toContain('Steady Hands v2');
    } finally {
      await app.close();
    }
  });

  it('POST /admin/api/cards rejects duplicate template_id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/api/cards',
        payload: {
          template_id: 'sb_common_p5',
          name: 'dup',
          card_type: 'stat_boost',
          rarity: 'common',
          energy_cost: 1,
          sport: 'any',
        },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('DELETE /admin/api/cards/:id soft-deletes (sets retired:true)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'DELETE', url: '/admin/api/cards/sb_common_p5' });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; item: { retired: boolean } };
      expect(j.item.retired).toBe(true);
    } finally {
      await app.close();
    }
  });

  // ─── Trivia ───────────────────────────────────────────────────────────
  it('GET /admin/api/trivia returns paginated questions', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/api/trivia?per_page=10' });
      expect(res.statusCode).toBe(200);
      const j = res.json() as {
        ok: boolean;
        total: number;
        per_page: number;
        items: Array<{ id: string }>;
      };
      expect(j.ok).toBe(true);
      expect(j.per_page).toBe(10);
      expect(j.items[0]!.id).toBe('bball_e_rules_001');
    } finally {
      await app.close();
    }
  });

  it('GET /admin/api/trivia?sport=basketball filters by sport', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/trivia?sport=basketball',
      });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { items: Array<{ sport: string }> };
      expect(j.items.every((q) => q.sport === 'basketball')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/trivia/:id rejects answer_options of wrong length', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/trivia/bball_e_rules_001',
        payload: { answer_options: ['1', '2', '3'] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/trivia/:id rejects when correct not in options', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/trivia/bball_e_rules_001',
        payload: {
          answer_options: ['a', 'b', 'c', 'd'],
          answer_correct: 'z',
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/trivia/:id accepts a valid update', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/trivia/bball_e_rules_001',
        payload: { explanation: 'updated' },
      });
      expect(res.statusCode).toBe(200);
      expect(writes.length).toBe(1);
      expect(writes[0]!.path).toMatch(/trivia_basketball\.json$/);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/trivia/:id 404s when id not found', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/trivia/no_such_id',
        payload: { explanation: 'x' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // anchor PROJECT_ROOT marker so we don't have an unused import warning
  it('uses real project paths', () => {
    expect(path.basename(__filename)).toBe('adminEdit.test.ts');
  });
});
