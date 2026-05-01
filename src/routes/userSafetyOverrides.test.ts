/**
 * userSafetyOverrides.test.ts — endpoint tests for the Per-User Overrides
 * editor surface in /admin/edit/safety.
 *
 * Mocks supabase with an in-memory store that supports upsert / delete /
 * select with eq() — enough for the four override endpoints. The
 * synchronous safety matrix loader (`safetyMatrix.ts`) deliberately
 * isn't mocked, so feature_id validation runs against the real on-disk
 * matrix file.
 */
import Fastify from 'fastify';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';
process.env['ADMIN_EDIT_AUTOCOMMIT'] = '0';

type Row = Record<string, unknown>;
const overridesStore: Row[] = [];
const profilesStore: Row[] = [
  { id: '11111111-1111-1111-1111-111111111111', handle: 'kid_seven', birth_year: 2019 },
  { id: '22222222-2222-2222-2222-222222222222', handle: 'teen_thirteen', birth_year: 2013 },
];

jest.mock('@supabase/supabase-js', () => {
  function makeQuery(table: string) {
    let rows: Row[] =
      table === 'user_safety_overrides'
        ? overridesStore.slice()
        : table === 'profiles'
          ? profilesStore.slice()
          : [];
    let mode: 'select' | 'upsert' | 'delete' = 'select';
    let upsertPayload: Row | null = null;
    let upsertConflict: string | undefined;
    const eqs: Array<[string, unknown]> = [];

    const query: Record<string, unknown> = {};
    query.select = () => {
      mode = 'select';
      return query;
    };
    query.upsert = (payload: Row, opts?: { onConflict?: string }) => {
      mode = 'upsert';
      upsertPayload = payload;
      upsertConflict = opts?.onConflict;
      return query;
    };
    query.delete = () => {
      mode = 'delete';
      return query;
    };
    query.eq = (col: string, val: unknown) => {
      eqs.push([col, val]);
      rows = rows.filter((r) => r[col] === val);
      return query;
    };
    query.or = (_: string) => query;
    query.limit = () => query;
    query.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    query.then = (resolve: (v: unknown) => unknown) => {
      if (mode === 'upsert' && upsertPayload && table === 'user_safety_overrides') {
        const keyCols = (upsertConflict ?? 'id').split(',').map((s) => s.trim());
        const idx = overridesStore.findIndex((r) =>
          keyCols.every((k) => r[k] === (upsertPayload as Row)[k]),
        );
        if (idx >= 0) overridesStore[idx] = { ...overridesStore[idx], ...upsertPayload };
        else overridesStore.push({ ...upsertPayload });
        return Promise.resolve(resolve({ data: [upsertPayload], error: null }));
      }
      if (mode === 'delete' && table === 'user_safety_overrides') {
        for (let i = overridesStore.length - 1; i >= 0; i -= 1) {
          if (eqs.every(([k, v]) => overridesStore[i]![k] === v)) {
            overridesStore.splice(i, 1);
          }
        }
        return Promise.resolve(resolve({ data: null, error: null }));
      }
      return Promise.resolve(resolve({ data: rows, error: null }));
    };
    return query;
  }
  return {
    __esModule: true,
    createClient: () => ({
      from: (t: string) => makeQuery(t),
      auth: { persistSession: false },
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { adminEditRoutes } = require('./adminEdit.js') as typeof import('./adminEdit.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(adminEditRoutes, { prefix: '/' });
  return app;
}

describe('per-user safety overrides endpoints', () => {
  beforeEach(() => {
    overridesStore.length = 0;
  });

  it('GET /admin/api/user-safety-overrides/summary on empty store returns zeroes', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ url: '/admin/api/user-safety-overrides/summary' });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.ok).toBe(true);
      expect(json.total_overrides).toBe(0);
      expect(json.distinct_users).toBe(0);
      expect(json.distinct_features).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('PATCH upserts a row, summary then reflects it', async () => {
    const app = await buildApp();
    try {
      // First: pick a real feature_id from the on-disk matrix so the
      // validator accepts it. The smoke matrix shipped in
      // data/safety/age_feature_matrix.json includes ask_scout_llm_open.
      const userId = '11111111-1111-1111-1111-111111111111';
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/admin/api/user-safety-overrides/${userId}/ask_scout_llm_open`,
        headers: { 'content-type': 'application/json', 'x-admin-id': 'tests@playgm' },
        payload: JSON.stringify({ enabled: true, reason: 'manually approved' }),
      });
      expect(patchRes.statusCode).toBe(200);
      const patchJson = JSON.parse(patchRes.body);
      expect(patchJson.ok).toBe(true);

      const sumRes = await app.inject({ url: '/admin/api/user-safety-overrides/summary' });
      const sum = JSON.parse(sumRes.body);
      expect(sum.total_overrides).toBe(1);
      expect(sum.distinct_users).toBe(1);
      expect(sum.distinct_features).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('PATCH rejects empty reason (audit trail required)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/user-safety-overrides/uuid-x/ask_scout_llm_open',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ enabled: true, reason: '   ' }),
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.errors.some((e: { field: string }) => e.field === 'reason')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('PATCH rejects unknown feature_id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/user-safety-overrides/uuid-x/feature_that_does_not_exist',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ enabled: false, reason: 'r' }),
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.errors.some((e: { field: string }) => e.field === 'feature_id')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('DELETE removes the override and summary returns to zero', async () => {
    const app = await buildApp();
    try {
      const userId = '11111111-1111-1111-1111-111111111111';
      // seed
      await app.inject({
        method: 'PATCH',
        url: `/admin/api/user-safety-overrides/${userId}/ask_scout_llm_open`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ enabled: true, reason: 'r' }),
      });
      // delete
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/admin/api/user-safety-overrides/${userId}/ask_scout_llm_open`,
      });
      expect(delRes.statusCode).toBe(200);
      const sum = JSON.parse(
        (await app.inject({ url: '/admin/api/user-safety-overrides/summary' })).body,
      );
      expect(sum.total_overrides).toBe(0);
    } finally {
      await app.close();
    }
  });
});
