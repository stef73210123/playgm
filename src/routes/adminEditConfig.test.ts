/**
 * adminEditConfig.test.ts — smoke tests for the 8 economy/cards spec editors.
 *
 * Mocks node:fs/promises so disk is never mutated; ADMIN_EDIT_AUTOCOMMIT=0
 * disables git calls. Stubs Supabase env so adminEdit.ts (which we import
 * for its shared exports) can construct its client.
 */
import Fastify from 'fastify';

process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';
process.env['ADMIN_EDIT_AUTOCOMMIT'] = '0';

jest.mock('@supabase/supabase-js', () => ({
  __esModule: true,
  createClient: () => ({
    from: () => ({}),
    auth: { persistSession: false },
  }),
}));

const mockWrites: Array<{ path: string; data: string }> = [];

jest.mock('node:fs/promises', () => {
  const mockPacks = {
    version: '3.0.0',
    packs: [
      {
        pack_id: 'rookie_pack',
        name: 'Rookie Pack',
        pp_cost: 400,
        card_count: 3,
        drop_rates: { common: 0.75, uncommon: 0.22, rare: 0.03, epic: 0, legendary: 0 },
        guaranteed_slots: [],
        sport_diversity_min: 1,
        bonus_token_chance: 0,
      },
      {
        pack_id: 'pro_pack',
        name: 'Pro Pack',
        pp_cost: 1000,
        card_count: 5,
        drop_rates: { common: 0.5, uncommon: 0.32, rare: 0.15, epic: 0.03, legendary: 0 },
        guaranteed_slots: [],
        sport_diversity_min: 2,
        bonus_token_chance: 0.05,
      },
    ],
  };
  const mockEarn = {
    version: '1.0.0',
    roster_performance: { roster_scored_base: 75, performance_bonus_stack_rule: 'highest_only_no_stack' },
    daily_engagement: { daily_login: 25 },
    subscription_daily_boost: { free: 0, starter: 25, playmaker: 75, champion: 150 },
  };
  const mockSubs = {
    version: '1.0.0',
    tiers: [
      {
        tier_id: 'free',
        name: 'Free',
        monthly_price_usd: 0,
        rosters_per_week: 2,
        practice_drafts_per_week: 1,
        cap_mode: false,
        monthly_pack_allocation: [],
        card_inventory_cap: 100,
        daily_pp_boost: 0,
        ask_scout_daily_cap: 2,
      },
    ],
  };
  const mockStreak = {
    version: '1.0.0',
    streak_rewards: [
      { day: 1, pack_id: 'rookie_pack', bonus_pp: 0, bonus_tokens: 0 },
      { day: 3, pack_id: 'rookie_pack', bonus_pp: 0, bonus_tokens: 0 },
    ],
    post_30_recurrence: { interval_days: 30, pack_id: 'pro_pack' },
    subscription_streak_boost: {},
    streak_save: { cost_usd: 0.99, cost_gems: 99, monthly_limit: 1 },
  };
  const mockTriggers = {
    version: '3.0.0',
    triggers: [
      {
        trigger_id: 'big_game',
        name: 'Big Game',
        description: 'Player exceeds season average.',
        data_required: ['this_game_stats', 'season_avg'],
        params_schema: {},
        evaluator_pseudocode: 'foo',
        approximate_trigger_rate: 0.5,
      },
    ],
  };
  const mockStatRes = {
    version: '3.0.0',
    stat_resolution: {
      basketball: {
        default_primary: 'points',
        default_secondary: 'rebounds',
        default_tertiary: 'assists',
        default_stats: ['points', 'rebounds'],
        star_threshold: { stat: 'points', value: 25 },
        by_position: { PG: { primary: 'assists', secondary: 'points', tertiary: 'steals' } },
      },
    },
  };
  const mockPity = {
    version: '3.0.0',
    pity_timers: [
      {
        id: 'rare_plus',
        description: 'Guarantees a Rare+',
        trigger_threshold: 30,
        tracking_unit: 'consecutive',
        guarantee: 'next_pack_upgrade',
        reset_on: 'rare_pull',
      },
    ],
  };
  const mockProg = {
    version: '1.0.0',
    tiers: Array.from({ length: 13 }, (_unused: unknown, i: number) => ({
      level: i + 1,
      name: `Tier ${i + 1}`,
      pp_threshold: i * 100,
      color: '#94A3B8',
    })),
    tier_up_bonus_pp: 500,
    contest_gating: {
      alliance: 1,
      regional_alliance: 6,
      regional_external: 8,
      themed_external: 8,
      national: 9,
      championship: 11,
    },
  };
  return {
    __esModule: true,
    default: {
      readFile: async (p: string): Promise<string> => {
        if (p.endsWith('pgm_packs.json')) return JSON.stringify(mockPacks);
        if (p.endsWith('pgm_pp_earn_rates.json')) return JSON.stringify(mockEarn);
        if (p.endsWith('pgm_subscriptions.json')) return JSON.stringify(mockSubs);
        if (p.endsWith('pgm_streak_rewards.json')) return JSON.stringify(mockStreak);
        if (p.endsWith('pgm_triggers.json')) return JSON.stringify(mockTriggers);
        if (p.endsWith('pgm_stat_resolution.json')) return JSON.stringify(mockStatRes);
        if (p.endsWith('pgm_pity_timers.json')) return JSON.stringify(mockPity);
        if (p.endsWith('pgm_progression.json')) return JSON.stringify(mockProg);
        if (p.endsWith('pgm_card_templates.json'))
          return JSON.stringify({ version: '3.0.0', card_templates: [] });
        throw new Error('unmocked readFile: ' + p);
      },
      writeFile: async (p: string, data: string): Promise<void> => {
        mockWrites.push({ path: p, data });
      },
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { adminEditConfigRoutes } =
  require('./adminEditConfig.js') as typeof import('./adminEditConfig.js');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(adminEditConfigRoutes, { prefix: '/' });
  return app;
}

describe('admin edit config routes', () => {
  beforeEach(() => {
    mockWrites.length = 0;
  });

  it.each([
    ['/admin/edit/packs', 'Pack Inventory'],
    ['/admin/edit/earn-rates', 'PP Earn Rates'],
    ['/admin/edit/subscriptions', 'Subscription Tiers'],
    ['/admin/edit/streaks', 'Streak Rewards'],
    ['/admin/edit/triggers', 'Card Triggers'],
    ['/admin/edit/stat-resolution', 'Stat Resolution'],
    ['/admin/edit/pity', 'Pity Timers'],
    ['/admin/edit/progression', 'Progression Tiers'],
  ])('GET %s renders self-contained HTML', async (url, marker) => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain(marker);
      expect(res.body).not.toMatch(/<script[^>]+src=/i);
      expect(res.body).not.toMatch(/<link[^>]+stylesheet/i);
    } finally {
      await app.close();
    }
  });

  it('GET /admin/api/packs returns items', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/api/packs' });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; items: Array<{ pack_id: string }> };
      expect(j.ok).toBe(true);
      expect(j.items.length).toBe(2);
      expect(j.items[0]!.pack_id).toBe('rookie_pack');
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/packs/:id rejects drop rates summing > 1', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/packs/rookie_pack',
        payload: { drop_rates: { common: 0.6, uncommon: 0.5, rare: 0, epic: 0, legendary: 0 } },
      });
      expect(res.statusCode).toBe(400);
      const j = res.json() as { ok: boolean; errors: Array<{ field: string }> };
      expect(j.ok).toBe(false);
      expect(j.errors.some((e) => e.field === 'drop_rates')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/packs/:id accepts valid update and writes file', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/packs/rookie_pack',
        payload: { name: 'Rookie Pack v2' },
      });
      expect(res.statusCode).toBe(200);
      const j = res.json() as { ok: boolean; item: { name: string } };
      expect(j.ok).toBe(true);
      expect(j.item.name).toBe('Rookie Pack v2');
      expect(mockWrites.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/earn-rates rejects negative integers', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/earn-rates',
        payload: { daily_engagement: { daily_login: -5 } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/earn-rates accepts valid update', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/earn-rates',
        payload: { daily_engagement: { daily_login: 50 } },
      });
      expect(res.statusCode).toBe(200);
      expect(mockWrites.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/subscriptions/:id rejects unknown pack_id in allocation', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/subscriptions/free',
        payload: { monthly_pack_allocation: [{ pack_id: 'unknown_pack', count: 1 }] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/streaks rejects non-ascending days', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/streaks',
        payload: {
          streak_rewards: [
            { day: 5, pack_id: 'rookie_pack', bonus_pp: 0, bonus_tokens: 0 },
            { day: 3, pack_id: 'rookie_pack', bonus_pp: 0, bonus_tokens: 0 },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/triggers/:id rejects bad slug', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/triggers/big_game',
        payload: { trigger_id: 'BadSlug!' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/pity/:id rejects threshold below 1', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/pity/rare_plus',
        payload: { trigger_threshold: 0 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/progression rejects non-ascending thresholds', async () => {
    const app = await buildApp();
    try {
      const tiers = Array.from({ length: 13 }, (_, i) => ({
        level: i + 1,
        name: `t${i}`,
        pp_threshold: 100,
        color: '#FF0000',
      }));
      tiers[0]!.pp_threshold = 0;
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/progression',
        payload: { tiers },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('PATCH /admin/api/stat-resolution/:sport accepts valid update', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/api/stat-resolution/basketball',
        payload: { default_primary: 'pts' },
      });
      expect(res.statusCode).toBe(200);
      expect(mockWrites.length).toBe(1);
    } finally {
      await app.close();
    }
  });
});
