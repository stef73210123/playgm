/**
 * me.test.ts — endpoint tests for /me/* persistence layer.
 *
 * Mocks supabase with an in-memory store covering the operations the /me
 * routes touch: `from('table').select().eq().maybeSingle()`,
 * `from(...).insert(...)`, `from(...).upsert(..., { onConflict })`,
 * `from(...).update(...).eq(...)`, plus `auth.getUser(token)` for bearer
 * resolution.
 *
 * Two synthetic users:
 *   - VALID_BEARER → maps to USER_ID; isGuest=false
 *   - X-Guest-Device-Id header path resolves to a synthetic guest user
 */
import Fastify from 'fastify';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';

type Row = Record<string, unknown>;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const VALID_BEARER = 'test-bearer-token';

const stores: Record<string, Row[]> = {
  profiles: [],
  pp_wallet: [],
  pp_events: [],
  streak_state: [],
  trivia_attempts: [],
  card_inventory: [],
  sessions: [],
};

jest.mock('@supabase/supabase-js', () => {
  function makeQuery(table: string) {
    let rows: Row[] = (stores[table] ?? []).slice();
    let mode: 'select' | 'insert' | 'upsert' | 'update' = 'select';
    let payload: Row | null = null;
    let upsertConflict: string | undefined;
    const eqs: Array<[string, unknown]> = [];
    const gtes: Array<[string, unknown]> = [];

    const query: Record<string, unknown> = {};
    query.select = () => {
      mode = mode === 'select' ? 'select' : mode;
      return query;
    };
    query.insert = (p: Row) => {
      mode = 'insert';
      payload = p;
      return query;
    };
    query.upsert = (p: Row, opts?: { onConflict?: string }) => {
      mode = 'upsert';
      payload = p;
      upsertConflict = opts?.onConflict;
      return query;
    };
    query.update = (p: Row) => {
      mode = 'update';
      payload = p;
      return query;
    };
    query.eq = (col: string, val: unknown) => {
      eqs.push([col, val]);
      rows = rows.filter((r) => r[col] === val);
      return query;
    };
    query.gte = (col: string, val: unknown) => {
      gtes.push([col, val]);
      rows = rows.filter(
        (r) => r[col] != null && (r[col] as string | number) >= (val as string | number),
      );
      return query;
    };
    query.maybeSingle = () => {
      if (mode === 'select') return Promise.resolve({ data: rows[0] ?? null, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    query.single = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    query.then = (resolve: (v: unknown) => unknown) => {
      const dest = stores[table] ?? (stores[table] = []);
      if (mode === 'insert' && payload) {
        dest.push({ ...payload, id: payload['id'] ?? `${table}_${dest.length + 1}` });
        return Promise.resolve(resolve({ data: [payload], error: null }));
      }
      if (mode === 'upsert' && payload) {
        const keyCols = (upsertConflict ?? 'user_id').split(',').map((s) => s.trim());
        const idx = dest.findIndex((r) =>
          keyCols.every((k) => r[k] === (payload as Row)[k]),
        );
        if (idx >= 0) dest[idx] = { ...dest[idx], ...payload };
        else dest.push({ ...payload, id: `${table}_${dest.length + 1}` });
        return Promise.resolve(resolve({ data: [payload], error: null }));
      }
      if (mode === 'update' && payload) {
        for (let i = 0; i < dest.length; i += 1) {
          if (eqs.every(([k, v]) => dest[i]![k] === v)) {
            dest[i] = { ...dest[i], ...payload };
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
const { meRoutes } = require('./me.js') as typeof import('./me.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(meRoutes, { prefix: '/' });
  return app;
}

function authedHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${VALID_BEARER}`,
  };
}

function guestHeaders(deviceId = 'device-abc'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-guest-device-id': deviceId,
  };
}

function resetStores() {
  for (const k of Object.keys(stores)) stores[k] = [];
}

describe('GET /me/state', () => {
  beforeEach(resetStores);

  it('rejects missing auth with 401', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ url: '/me/state' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns guest defaults when called with X-Guest-Device-Id only', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ url: '/me/state', headers: guestHeaders() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { handle: string; points: number };
      expect(body.handle).toBe('guest');
      expect(body.points).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns zeroed defaults when authed user has no profile yet', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ url: '/me/state', headers: authedHeaders() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { points: number; lifetimePP: number; streak: number };
      expect(body.points).toBe(0);
      expect(body.lifetimePP).toBe(0);
      expect(body.streak).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('hydrates from existing profile + wallet + streak rows', async () => {
    stores['profiles']!.push({
      id: USER_ID,
      handle: 'kid_one',
      display_name: 'Kid One',
      age: 11,
      favorite_team_ids: ['nba_bos', 'mlb_nyy'],
    });
    stores['pp_wallet']!.push({
      user_id: USER_ID,
      current_balance: 250,
      lifetime_earned: 800,
    });
    stores['streak_state']!.push({ user_id: USER_ID, current_streak_days: 5 });

    const app = await buildApp();
    try {
      const res = await app.inject({ url: '/me/state', headers: authedHeaders() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        handle: string;
        displayName: string;
        age: number;
        points: number;
        lifetimePP: number;
        streak: number;
        favoriteTeamIds: string[];
      };
      expect(body.handle).toBe('kid_one');
      expect(body.displayName).toBe('Kid One');
      expect(body.age).toBe(11);
      expect(body.points).toBe(250);
      expect(body.lifetimePP).toBe(800);
      expect(body.streak).toBe(5);
      expect(body.favoriteTeamIds).toEqual(['nba_bos', 'mlb_nyy']);
    } finally {
      await app.close();
    }
  });
});

describe('POST /me/pp/credit', () => {
  beforeEach(resetStores);

  it('rejects missing auth with 401', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/pp/credit',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ amount: 10, source: 'test' }),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects guests with 403', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/pp/credit',
        headers: guestHeaders(),
        payload: JSON.stringify({ amount: 10, source: 'test' }),
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed body (missing amount)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/pp/credit',
        headers: authedHeaders(),
        payload: JSON.stringify({ source: 'test' }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('credits a fresh wallet and returns new balance', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/pp/credit',
        headers: authedHeaders(),
        payload: JSON.stringify({ amount: 50, source: 'daily_login_bonus' }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { balance: number };
      expect(body.balance).toBe(50);
      expect(stores['pp_events']).toHaveLength(1);
      expect(stores['pp_events']![0]!['source']).toBe('daily_login_bonus');
      expect(stores['pp_wallet']![0]!['current_balance']).toBe(50);
    } finally {
      await app.close();
    }
  });

  it('accumulates across consecutive credits', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/me/pp/credit',
        headers: authedHeaders(),
        payload: JSON.stringify({ amount: 30, source: 'a' }),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/me/pp/credit',
        headers: authedHeaders(),
        payload: JSON.stringify({ amount: 70, source: 'b' }),
      });
      const body = res.json() as { balance: number };
      expect(body.balance).toBe(100);
      expect(stores['pp_wallet']![0]!['lifetime_earned']).toBe(100);
      expect(stores['pp_events']).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

describe('POST /me/sessions/heartbeat', () => {
  beforeEach(resetStores);

  it('inserts a sessions row on first heartbeat', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/sessions/heartbeat',
        headers: authedHeaders(),
        payload: '{}',
      });
      expect(res.statusCode).toBe(200);
      expect(stores['sessions']).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('returns ok for guest mode without inserting a sessions row', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/sessions/heartbeat',
        headers: guestHeaders(),
        payload: '{}',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; guest: boolean };
      expect(body.ok).toBe(true);
      expect(body.guest).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('POST /me/trivia', () => {
  beforeEach(resetStores);

  it('records attempt and credits PP for a correct answer', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/trivia',
        headers: authedHeaders(),
        payload: JSON.stringify({
          question_id: 'q_001',
          sport: 'NBA',
          difficulty: 'medium',
          is_correct: true,
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { pp_awarded: number; balance: number };
      expect(body.pp_awarded).toBe(10);
      expect(body.balance).toBe(10);
      expect(stores['trivia_attempts']).toHaveLength(1);
      expect(stores['trivia_attempts']![0]!['is_correct']).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('does NOT credit PP for a wrong answer but still records attempt', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/trivia',
        headers: authedHeaders(),
        payload: JSON.stringify({
          question_id: 'q_002',
          sport: 'NFL',
          difficulty: 'hard',
          is_correct: false,
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { pp_awarded: number; balance: number };
      expect(body.pp_awarded).toBe(0);
      expect(stores['trivia_attempts']).toHaveLength(1);
      // No pp_events row for wrong answers.
      expect(stores['pp_events']).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('rejects guests', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/trivia',
        headers: guestHeaders(),
        payload: JSON.stringify({
          question_id: 'q_003',
          sport: 'NBA',
          difficulty: 'easy',
          is_correct: true,
        }),
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('credits the correct band per difficulty', async () => {
    const app = await buildApp();
    try {
      const easy = await app.inject({
        method: 'POST',
        url: '/me/trivia',
        headers: authedHeaders(),
        payload: JSON.stringify({
          question_id: 'q_easy',
          sport: 'NBA',
          difficulty: 'easy',
          is_correct: true,
        }),
      });
      expect((easy.json() as { pp_awarded: number }).pp_awarded).toBe(5);

      const hard = await app.inject({
        method: 'POST',
        url: '/me/trivia',
        headers: authedHeaders(),
        payload: JSON.stringify({
          question_id: 'q_hard',
          sport: 'NBA',
          difficulty: 'hard',
          is_correct: true,
        }),
      });
      expect((hard.json() as { pp_awarded: number }).pp_awarded).toBe(20);
    } finally {
      await app.close();
    }
  });
});

describe('POST /me/cards/apply', () => {
  beforeEach(resetStores);

  it('upserts a card_inventory row', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/cards/apply',
        headers: authedHeaders(),
        payload: JSON.stringify({
          card_id: 'boost_23',
          template_id: 'boost_23',
          player_id: 'nba_lebron',
        }),
      });
      expect(res.statusCode).toBe(200);
      expect(stores['card_inventory']).toHaveLength(1);
      expect(stores['card_inventory']![0]!['user_id']).toBe(USER_ID);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed body', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/cards/apply',
        headers: authedHeaders(),
        payload: JSON.stringify({ card_id: 'x' }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects guests', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/cards/apply',
        headers: guestHeaders(),
        payload: JSON.stringify({
          card_id: 'boost_23',
          template_id: 'boost_23',
          player_id: 'nba_lebron',
        }),
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
