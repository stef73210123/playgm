/**
 * coppa.test.ts — endpoint tests for the COPPA parental-consent stub.
 *
 * Mocks the supabase client with an in-memory store that supports the
 * narrow operations the auth route uses: upsert with onConflict on
 * `user_id`, plus eq()→maybeSingle() reads + select().single() chains.
 * The route depends on neither RLS nor postgres, so an in-memory store is
 * a faithful enough stand-in to pin the contract.
 */
import Fastify from 'fastify';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';

type Row = Record<string, unknown>;
const pcrStore: Row[] = [];

jest.mock('@supabase/supabase-js', () => {
  function makeQuery(table: string) {
    let rows: Row[] = table === 'parental_consent_requests' ? pcrStore.slice() : [];
    let mode: 'select' | 'upsert' = 'select';
    let upsertPayload: Row | null = null;
    let upsertConflict: string | undefined;
    let selectColumns: string | undefined;
    const eqs: Array<[string, unknown]> = [];

    const query: Record<string, unknown> = {};
    query.select = (cols?: string) => {
      selectColumns = cols;
      return query;
    };
    query.upsert = (payload: Row, opts?: { onConflict?: string }) => {
      mode = 'upsert';
      upsertPayload = payload;
      upsertConflict = opts?.onConflict;
      return query;
    };
    query.eq = (col: string, val: unknown) => {
      eqs.push([col, val]);
      rows = rows.filter((r) => r[col] === val);
      return query;
    };
    query.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    query.single = () => {
      if (mode === 'upsert' && upsertPayload && table === 'parental_consent_requests') {
        const keyCols = (upsertConflict ?? 'id').split(',').map((s) => s.trim());
        const idx = pcrStore.findIndex((r) =>
          keyCols.every((k) => r[k] === (upsertPayload as Row)[k]),
        );
        // Synthesize a stable id on insert (or keep existing id on update).
        const id =
          idx >= 0
            ? (pcrStore[idx]!['id'] as string)
            : `pcr_${Math.random().toString(36).slice(2, 10)}`;
        const merged = { ...(pcrStore[idx] ?? {}), ...upsertPayload, id };
        if (idx >= 0) pcrStore[idx] = merged;
        else pcrStore.push(merged);
        // Project only the requested columns so the route's destructure
        // sees the exact shape Supabase would return.
        const cols = (selectColumns ?? 'id, consent_token')
          .split(',')
          .map((s) => s.trim());
        const projection: Row = {};
        for (const c of cols) projection[c] = (merged as Row)[c];
        return Promise.resolve({ data: projection, error: null });
      }
      return Promise.resolve({ data: rows[0] ?? null, error: null });
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
const { authRoutes } = require('./auth.js') as typeof import('./auth.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/' });
  return app;
}

const VALID_USER = '11111111-1111-1111-1111-111111111111';
const VALID_USER_2 = '22222222-2222-2222-2222-222222222222';

describe('POST /auth/parental-consent-request', () => {
  beforeEach(() => {
    pcrStore.length = 0;
  });

  it('inserts a new consent request and returns id + consent_token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: VALID_USER,
          parent_email: 'parent@example.com',
          child_age: 8,
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; consent_token: string };
      expect(body.id).toBeTruthy();
      expect(body.consent_token).toMatch(/^[0-9a-f]{48}$/);
      expect(pcrStore).toHaveLength(1);
      expect(pcrStore[0]!['parent_email']).toBe('parent@example.com');
      expect(pcrStore[0]!['child_age']).toBe(8);
    } finally {
      await app.close();
    }
  });

  it('rejects body missing user_id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          parent_email: 'p@example.com',
          child_age: 9,
        }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed parent_email', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: VALID_USER,
          parent_email: 'not-an-email',
          child_age: 9,
        }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects child_age out of range', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: VALID_USER,
          parent_email: 'p@example.com',
          child_age: 25,
        }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects non-uuid user_id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: 'not-a-uuid',
          parent_email: 'p@example.com',
          child_age: 8,
        }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('upserts (idempotent) on (user_id) — re-request keeps a single row', async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: VALID_USER,
          parent_email: 'parent@example.com',
          child_age: 9,
        }),
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as { consent_token: string };

      const second = await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: VALID_USER,
          parent_email: 'parent2@example.com',
          child_age: 10,
        }),
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as { consent_token: string };

      // Token MUST rotate so any prior mailto link is invalidated.
      expect(secondBody.consent_token).not.toBe(firstBody.consent_token);
      // Single row preserved.
      expect(pcrStore).toHaveLength(1);
      expect(pcrStore[0]!['parent_email']).toBe('parent2@example.com');
    } finally {
      await app.close();
    }
  });

  it('separate user_ids produce separate rows', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: VALID_USER,
          parent_email: 'a@example.com',
          child_age: 8,
        }),
      });
      await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: VALID_USER_2,
          parent_email: 'b@example.com',
          child_age: 9,
        }),
      });
      expect(pcrStore).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

describe('GET /auth/parental-consent-request/:user_id', () => {
  beforeEach(() => {
    pcrStore.length = 0;
  });

  it('returns 400 for non-uuid user_id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ url: '/auth/parental-consent-request/not-a-uuid' });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when no consent request exists for the user', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ url: `/auth/parental-consent-request/${VALID_USER}` });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns the existing consent row after a POST', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: VALID_USER,
          parent_email: 'parent@example.com',
          child_age: 7,
        }),
      });
      const res = await app.inject({ url: `/auth/parental-consent-request/${VALID_USER}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { parent_email: string; child_age: number };
      expect(body.parent_email).toBe('parent@example.com');
      expect(body.child_age).toBe(7);
    } finally {
      await app.close();
    }
  });
});
