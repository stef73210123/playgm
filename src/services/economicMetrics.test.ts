/**
 * economicMetrics.test.ts — shape + pure-helper tests for the live economic
 * metrics aggregator and the static targets module.
 *
 * Supabase is mocked at the @supabase/supabase-js level so no network is
 * touched. The mock chain resolves every query to `{ count: 0, data: [] }`,
 * which exercises the success path of every helper without a real DB.
 */
import path from 'node:path';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';

// Anchor file resolution to the canonical project root so the JSON specs
// (data/economy/, data/cards/) load regardless of where Jest is launched.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

jest.mock('@supabase/supabase-js', () => {
  function makeChain() {
    const result = { count: 0, data: [] as unknown[], error: null as null | { message: string } };
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.gte = () => chain;
    chain.not = () => chain;
    chain.limit = () => chain;
    chain.order = () => chain;
    chain.then = (resolve: (v: typeof result) => unknown) =>
      Promise.resolve(resolve(result));
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  getEconomicMetrics,
  _resetEconomicMetricsCacheForTests,
  _internalsForTests,
} = require('./economicMetrics.js') as typeof import('./economicMetrics.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  getEconomicTargets,
  _resetEconomicTargetsCacheForTests,
} = require('./economicTargets.js') as typeof import('./economicTargets.js');

describe('economicMetrics', () => {
  beforeEach(() => {
    _resetEconomicMetricsCacheForTests();
    _resetEconomicTargetsCacheForTests();
  });

  it('returns the full economic_metrics shape with all sections', async () => {
    void PROJECT_ROOT;
    const m = await getEconomicMetrics();
    expect(m).toEqual(
      expect.objectContaining({
        pp: expect.any(Object),
        packs: expect.any(Object),
        cards: expect.any(Object),
        subscriptions: expect.any(Object),
        rosters: expect.any(Object),
        trivia_picks: expect.any(Object),
        retention: expect.any(Object),
        ask_scout: expect.any(Object),
      }),
    );
    // Ask Scout block — calls_24h_by_tier should always carry the 4-tier shape
    expect(m.ask_scout).toEqual(
      expect.objectContaining({
        calls_24h: expect.any(Object),
        calls_24h_by_tier: expect.any(Object),
        cap_hit_rate_24h_by_tier: expect.any(Object),
        free_users_capped_today: expect.any(Object),
        estimated_anthropic_spend_24h_usd: expect.any(Object),
        cost_per_paid_seat_24h_usd: expect.any(Object),
      }),
    );
    // PP section keys
    expect(m.pp).toEqual(
      expect.objectContaining({
        total_earned_lifetime: expect.any(Object),
        total_earned_24h: expect.any(Object),
        total_earned_7d: expect.any(Object),
        median_pp_per_user: expect.any(Object),
        p90_pp_per_user: expect.any(Object),
        avg_daily_earn_per_active_user: expect.any(Object),
        distribution_by_tier: expect.any(Object),
      }),
    );
    // Packs — new pack tier names should surface as unmeasured because the
    // schema's pack_type enum doesn't have rookie/pro/all_star/mvp/goat yet.
    expect(m.packs.rookie_pack_opens_30d.unmeasured).toBe(true);
    expect(m.packs.goat_pack_opens_30d.unmeasured).toBe(true);
    // Subscription mix should reflect the 4 tiers in pgm_subscriptions.json.
    expect(m.subscriptions.by_tier.value).toEqual(
      expect.objectContaining({ free: 0, starter: 0, playmaker: 0, champion: 0 }),
    );
    // Retention: pity-related cohorts unmeasured (no signup-cohort table).
    expect(m.retention.d30_retention.unmeasured).toBe(true);
  });

  it('PP tier distribution covers all 13 levels', async () => {
    const m = await getEconomicMetrics();
    const dist = m.pp.distribution_by_tier.value;
    expect(dist).not.toBeNull();
    expect(Object.keys(dist!)).toEqual([
      'Peewee', 'Travel', 'JV', 'Varsity', 'Semi-Pro', 'Pro', 'Starter',
      'All-Star', 'MVP', 'Champion', 'Hall of Famer', 'Legend', 'GOAT',
    ]);
  });

  it('cards_by_rarity contains all 5 GDD rarities (uncommon/epic remain 0 until schema migration)', async () => {
    const m = await getEconomicMetrics();
    const dist = m.cards.cards_by_rarity.value;
    expect(dist).not.toBeNull();
    expect(Object.keys(dist!).sort()).toEqual(
      ['common', 'epic', 'legendary', 'rare', 'uncommon'],
    );
  });

  it('caches results for 60s — second call returns same object reference', async () => {
    const a = await getEconomicMetrics();
    const b = await getEconomicMetrics();
    expect(a).toBe(b);
  });

  it('pure helpers: quantile + pct + isMissingTableError', () => {
    const { quantile, pct, isMissingTableError } = _internalsForTests;
    // quantile
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([10], 0.5)).toBe(10);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6, 5);
    // pct: denominator unmeasured propagates unmeasured
    expect(pct({ value: 5 }, { value: null, unmeasured: true })).toEqual(
      expect.objectContaining({ unmeasured: true }),
    );
    expect(pct({ value: 5 }, { value: 0 })).toEqual({ value: 0 });
    expect(pct({ value: 1 }, { value: 4 })).toEqual({ value: 25 });
    // isMissingTableError
    expect(isMissingTableError('relation does not exist')).toBe(true);
    expect(isMissingTableError('PGRST205 schema cache')).toBe(true);
    expect(isMissingTableError('connection refused')).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
  });
});

describe('economicTargets', () => {
  beforeEach(() => {
    _resetEconomicTargetsCacheForTests();
  });

  it('returns the full targets shape sourced from GDD + JSON specs', () => {
    const t = getEconomicTargets();
    expect(t.pp.pro_pack_cost.current).toBe(1000);
    expect(t.pp.pro_pack_cost.target_min).toBe(750);
    expect(t.pp.pro_pack_cost.target_max).toBe(1250);
    expect(t.progression.all_star_to_mvp_gap.current).toBe(9000);
    expect(t.progression.h2h_loss_pp.current).toBe(50);
    // Legendary drop rates from pgm_packs.json (GDD §12 confirms 0/2/8/15%).
    expect(t.cards.legendary_drop_rates.pro_pack.current).toBe(0);
    expect(t.cards.legendary_drop_rates.all_star_pack.current).toBeCloseTo(0.02, 5);
    expect(t.cards.legendary_drop_rates.mvp_pack.current).toBeCloseTo(0.08, 5);
    expect(t.cards.legendary_drop_rates.goat_pack.current).toBeCloseTo(0.15, 5);
    // Per-player limit is the open question (2 vs. 3).
    expect(t.cards.per_player_limit).toEqual(
      expect.objectContaining({ current: 2, alt: 3 }),
    );
    // Business targets carry the "extrapolated"/"industry-standard" flag.
    expect(t.business.target_arpu_usd_monthly.flag).toBe('extrapolated');
    expect(t.business.target_paid_conversion_pct.flag).toBe('industry-standard');
    expect(t.business.target_d30_retention_pct.flag).toBe('industry-standard');
  });
});
