/**
 * dailyCapLimiter.test.ts — generic per-(user, UTC day) cap enforcement.
 *
 * Drives the `createDailyCapLimiter(...)` factory directly under both
 * feature configurations (Ask Scout = ask_scout_usage, Card Scan =
 * card_scan_usage) to verify the abstraction is genuinely reusable and
 * neither feature contaminates the other's counter.
 *
 * Mocks the Supabase client at the @supabase/supabase-js level with an
 * in-memory store keyed on (table_name, user_id, ymd). The fake store
 * supports the upsert() / select().eq().eq().maybeSingle() shapes the
 * limiter uses, exactly like askScoutLimiter.test.ts but parameterized.
 */

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';

interface UsageRow { user_id: string; ymd: string; count: number; last_request_at: string }
const mockUsageStore = new Map<string, UsageRow>();
function mockKey(table: string, uid: string, ymd: string) { return table + '::' + uid + '::' + ymd; }

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
      if (!filterUid || !filterYmd) return Promise.resolve({ data: null, error: null });
      const row = mockUsageStore.get(mockKey(table, filterUid, filterYmd));
      return Promise.resolve({ data: row ? { count: row.count } : null, error: null });
    };
    chain.single = () => {
      if (mode !== 'upsert' || !upsertPayload) return Promise.resolve({ data: null, error: null });
      const k = mockKey(table, upsertPayload.user_id, upsertPayload.ymd);
      const existing = mockUsageStore.get(k);
      if (existing) {
        const next = Math.max(existing.count + 1, upsertPayload.count);
        mockUsageStore.set(k, { ...upsertPayload, count: next });
        return Promise.resolve({ data: { count: next }, error: null });
      }
      mockUsageStore.set(k, upsertPayload);
      return Promise.resolve({ data: { count: upsertPayload.count }, error: null });
    };
    chain.then = undefined;
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dcl = require('./dailyCapLimiter.js') as typeof import('./dailyCapLimiter.js');

const TODAY = dcl._internalsForTests.utcYmd();

// Two flavours, used to assert table isolation.
const askLimiter = dcl.createDailyCapLimiter({
  featureId: 'ask_scout',
  tableName: 'ask_scout_usage',
  resolveCap: (tier) => ({ free: 2, starter: 5, playmaker: 10, champion: 20 })[tier],
  errorCode: 'ASK_SCOUT_DAILY_CAP',
});
const scanLimiter = dcl.createDailyCapLimiter({
  featureId: 'card_scan',
  tableName: 'card_scan_usage',
  resolveCap: (tier) => ({ free: 2, starter: 5, playmaker: 10, champion: 20 })[tier],
  errorCode: 'CARD_SCAN_DAILY_CAP',
});

describe('createDailyCapLimiter — Card Scan config', () => {
  beforeEach(() => mockUsageStore.clear());

  it('allows free-tier first call, increments count, reports remaining=1', async () => {
    const d = await scanLimiter.checkAndIncrement('uA', 'free');
    expect(d.allowed).toBe(true);
    expect(d.count).toBe(1);
    expect(d.cap).toBe(2);
    expect(d.remaining).toBe(1);
  });

  it('exhausts free tier at cap=2 and denies further calls without consuming a credit', async () => {
    const a = await scanLimiter.checkAndIncrement('uB', 'free');
    expect(a.allowed).toBe(true);
    const b = await scanLimiter.checkAndIncrement('uB', 'free');
    expect(b.allowed).toBe(true);
    expect(b.remaining).toBe(0);
    const c = await scanLimiter.checkAndIncrement('uB', 'free');
    expect(c.allowed).toBe(false);
    expect(c.count).toBe(2);          // unchanged
    expect(c.remaining).toBe(0);
  });

  it('honors per-tier caps for card scans (starter=5, playmaker=10, champion=20)', async () => {
    const cases: Array<['starter' | 'playmaker' | 'champion', number]> = [
      ['starter', 5],
      ['playmaker', 10],
      ['champion', 20],
    ];
    for (const [tier, cap] of cases) {
      const uid = 'scan_' + tier;
      let last;
      for (let i = 0; i < cap; i++) {
        last = await scanLimiter.checkAndIncrement(uid, tier);
        expect(last.allowed).toBe(true);
      }
      expect(last!.count).toBe(cap);
      expect(last!.remaining).toBe(0);
      const overflow = await scanLimiter.checkAndIncrement(uid, tier);
      expect(overflow.allowed).toBe(false);
      expect(overflow.cap).toBe(cap);
    }
  });

  it('getQuota does not increment the counter', async () => {
    await scanLimiter.checkAndIncrement('uQuota', 'free');
    const q1 = await scanLimiter.getQuota('uQuota', 'free');
    expect(q1.count).toBe(1);
    const q2 = await scanLimiter.getQuota('uQuota', 'free');
    expect(q2.count).toBe(1);
    expect(q2.remaining).toBe(1);
  });
});

describe('createDailyCapLimiter — feature isolation', () => {
  beforeEach(() => mockUsageStore.clear());

  it('Ask Scout and Card Scan counters do NOT share state for the same user/day', async () => {
    // Same user, same UTC day, free tier (cap=2 for both).
    // Burn the Ask Scout cap to 2…
    await askLimiter.checkAndIncrement('uShared', 'free');
    await askLimiter.checkAndIncrement('uShared', 'free');
    const askBlocked = await askLimiter.checkAndIncrement('uShared', 'free');
    expect(askBlocked.allowed).toBe(false);

    // …but Card Scan must still allow 2 fresh calls.
    const scan1 = await scanLimiter.checkAndIncrement('uShared', 'free');
    const scan2 = await scanLimiter.checkAndIncrement('uShared', 'free');
    expect(scan1.allowed).toBe(true);
    expect(scan2.allowed).toBe(true);
    expect(scan2.count).toBe(2);

    // Each table holds its own row.
    const askRow = mockUsageStore.get(mockKey('ask_scout_usage', 'uShared', TODAY));
    const scanRow = mockUsageStore.get(mockKey('card_scan_usage', 'uShared', TODAY));
    expect(askRow?.count).toBe(2);
    expect(scanRow?.count).toBe(2);
  });

  it('writes to the configured tableName', async () => {
    await scanLimiter.checkAndIncrement('writeUser', 'starter');
    expect(mockUsageStore.has(mockKey('card_scan_usage', 'writeUser', TODAY))).toBe(true);
    expect(mockUsageStore.has(mockKey('ask_scout_usage', 'writeUser', TODAY))).toBe(false);
  });
});
