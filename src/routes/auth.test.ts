/**
 * auth.test.ts — registration smoke + invalid-token defense for the auth
 * route module.
 *
 * The dispatch's "signup creates auth.users + profiles row + zeroed
 * pp_wallet/streak/pity rows" criterion is enforced server-side by
 * Supabase's `auth.users` -> `profiles` insert trigger; we can't
 * exercise that here without a live Postgres. Instead we pin the parts
 * the server is responsible for: (a) the COPPA endpoint actually mounts
 * under /auth/parental-consent-request, (b) the /me/state path requires
 * auth + accepts a valid bearer.
 */
import Fastify from 'fastify';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';

const VALID_BEARER = 'auth-test-token';
const USER_ID = '11111111-1111-1111-1111-111111111111';

jest.mock('@supabase/supabase-js', () => {
  function makeQuery(_table: string) {
    const query: Record<string, unknown> = {};
    query.select = () => query;
    query.upsert = () => query;
    query.insert = () => query;
    query.update = () => query;
    query.eq = () => query;
    query.gte = () => query;
    query.maybeSingle = () => Promise.resolve({ data: null, error: null });
    query.single = () =>
      Promise.resolve({
        data: { id: 'pcr_id_1', consent_token: 'tok_abc' },
        error: null,
      });
    query.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ data: [], error: null }));
    return query;
  }
  return {
    __esModule: true,
    createClient: () => ({
      from: (t: string) => makeQuery(t),
      auth: {
        persistSession: false,
        getUser: (token: string) => {
          if (token === VALID_BEARER) {
            return Promise.resolve({
              data: { user: { id: USER_ID } },
              error: null,
            });
          }
          return Promise.resolve({
            data: { user: null },
            error: { message: 'invalid_token' },
          });
        },
      },
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authRoutes } = require('./auth.js') as typeof import('./auth.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { meRoutes } = require('./me.js') as typeof import('./me.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/' });
  await app.register(meRoutes, { prefix: '/' });
  return app;
}

describe('auth route registration', () => {
  it('registers POST /auth/parental-consent-request', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/parental-consent-request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          user_id: USER_ID,
          parent_email: 'parent@example.com',
          child_age: 9,
        }),
      });
      // A 404 here would mean the route never registered. 200 confirms the
      // mount + the supabase mock shape.
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('registers GET /auth/parental-consent-request/:user_id', async () => {
    const app = await buildApp();
    try {
      // Bad uuid → 400 (validation runs, route mounted).
      const res = await app.inject({ url: '/auth/parental-consent-request/bad-id' });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('bearer auth defense', () => {
  it('rejects /me/state without an Authorization header', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ url: '/me/state' });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { error: string };
      expect(body.error).toBe('missing_auth');
    } finally {
      await app.close();
    }
  });

  it('rejects /me/state with an empty Bearer token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        url: '/me/state',
        headers: { authorization: 'Bearer ' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects /me/state with an invalid token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        url: '/me/state',
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { error: string };
      expect(body.error).toBe('invalid_token');
    } finally {
      await app.close();
    }
  });

  it('accepts /me/state with a valid bearer', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        url: '/me/state',
        headers: { authorization: `Bearer ${VALID_BEARER}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('falls back to guest mode when X-Guest-Device-Id is supplied', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        url: '/me/state',
        headers: { 'x-guest-device-id': 'dev-xyz' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { handle: string };
      expect(body.handle).toBe('guest');
    } finally {
      await app.close();
    }
  });
});
