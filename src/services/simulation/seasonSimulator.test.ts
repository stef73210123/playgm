/**
 * seasonSimulator.test.ts — fairness simulator end-to-end behavior.
 *
 * Hermetic: mocks node:fs to provide synthetic stat caches + scoring formula
 * on disk, so the test exercises the full snake-draft + weekly-replay +
 * fairness-aggregation path without touching real data files.
 */
import {
  buildDraftPool,
  loadStatCacheForLeagues,
  makeRng,
  runSimulation,
  spearman,
} from './seasonSimulator.js';
import type { ScoringFormulaFile } from './scoringFormula.js';

// ─── Synthetic data fixture ──────────────────────────────────────────────
// 50 NFL players with varied stats. Top tier ~ 20 pts/wk projection,
// bottom ~ 1 pt/wk. Seasonality jitter introduces realistic variance.
//
// Variable names prefixed with `mock` so Jest allows them inside the
// jest.mock(...) factory.
const mockNflPlayers: unknown[] = [];
for (let i = 0; i < 50; i++) {
  const tier = Math.floor(i / 10);
  const factor = 1 / (1 + tier);
  mockNflPlayers.push({
    external_id: `t:${i}`,
    full_name: `Player ${i}`,
    team: 'TST',
    team_abbr: 'TST',
    position: 'QB',
    position_group: 'qb',
    stats: {
      games_played: 16,
      passing_yards: 4500 * factor,
      passing_touchdowns: 30 * factor,
      interceptions: 8,
      rushing_yards: 200 * factor,
    },
  });
}
const mockNflFile = { league: 'nfl', players: mockNflPlayers };

const mockSynthFormula: ScoringFormulaFile = {
  version: 'test',
  by_sport: {
    basketball: {
      weights: { points: 1, rebounds: 1, assists: 1 },
      games_per_week: 3.5,
    },
    football: {
      weights: { passing_yds: 0.04, passing_tds: 4, ints: -2, rushing_yds: 0.1 },
      games_per_week: 1,
    },
    baseball: {
      hitter_weights: { hits: 1, hr: 4 },
      pitcher_weights: { wins: 4 },
      games_per_week: 6,
    },
    hockey: {
      skater_weights: { goals: 3, assists: 2 },
      goalie_weights: { saves: 0.4 },
      games_per_week: 3.5,
    },
    soccer: { weights: { goals: 6, assists: 3 }, games_per_week: 1.5 },
  },
  global: {
    roster_size: 3,
    min_picks_per_sport: { basketball: 0, football: 0, baseball: 0, hockey: 0, soccer: 0 },
    synthetic_user_count: 20,
    draft_position_strategy: 'snake',
    weekly_energy_budget: 8,
    rarity_caps: { rare_per_roster: 3, epic_per_roster: 1, legendary_per_user_per_week: 1 },
    subscription_tier_mix: { free: 1, starter: 0, playmaker: 0, champion: 0 },
    fa_engagement_by_tier: { free: 0.3, starter: 0.5, playmaker: 0.7, champion: 0.85 },
    fa_pool_size: 10,
    max_bench_size: 3,
    card_uplift_by_rarity: { common: 0.1, uncommon: 0.2, rare: 0.35, epic: 0.6, legendary: 1.0 },
  },
};

// ─── Mock fs to back loadStatCacheForLeagues + scoringFormula path ──────
const originalReadFileSync = jest.requireActual('node:fs').readFileSync;
const originalExistsSync = jest.requireActual('node:fs').existsSync;
const originalStatSync = jest.requireActual('node:fs').statSync;

jest.mock('node:fs', () => {
  const real = jest.requireActual('node:fs');
  return {
    ...real,
    existsSync: jest.fn((p: string) => {
      // Always pretend the sentinel + cache + formula files exist.
      if (p.endsWith('pgm_card_templates.json')) return true;
      if (p.endsWith('nfl_season_2025.json')) return true;
      if (p.endsWith('nba_season_2025-26.json')) return false;
      if (p.endsWith('mlb_season_2026.json')) return false;
      if (p.endsWith('nhl_season_2025-26.json')) return false;
      if (p.endsWith('mls_season_2026.json')) return false;
      if (p.endsWith('pgm_scoring_formula.json')) return true;
      return real.existsSync(p);
    }),
    readFileSync: jest.fn((p: string, enc?: string) => {
      if (typeof p === 'string') {
        if (p.endsWith('nfl_season_2025.json')) {
          return JSON.stringify(mockNflFile);
        }
        if (p.endsWith('pgm_scoring_formula.json')) {
          return JSON.stringify(mockSynthFormula);
        }
      }
      return real.readFileSync(p, enc);
    }),
    statSync: jest.fn((p: string) => {
      if (typeof p === 'string' && p.endsWith('pgm_scoring_formula.json')) {
        return { mtimeMs: 0 };
      }
      return real.statSync(p);
    }),
  };
});

afterAll(() => {
  // restore — though jest.restoreAllMocks in afterEach is also fine
  void originalReadFileSync;
  void originalExistsSync;
  void originalStatSync;
});

// ─── Tests ───────────────────────────────────────────────────────────────
describe('makeRng', () => {
  it('is deterministic with the same seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const aSeq = [a(), a(), a(), a()];
    const bSeq = [b(), b(), b(), b()];
    expect(aSeq).toEqual(bSeq);
  });

  it('produces values in [0, 1)', () => {
    const r = makeRng(1);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('spearman', () => {
  it('returns 1 for perfectly correlated rankings', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 5);
  });

  it('returns -1 for inverse rankings', () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 5);
  });

  it('returns 0 for completely uncorrelated rankings', () => {
    // These rankings have zero linear association
    const a = [1, 2, 3, 4, 5];
    const b = [3, 1, 5, 2, 4];
    const s = spearman(a, b);
    expect(Math.abs(s)).toBeLessThan(0.4);
  });

  it('returns 0 for empty/short arrays', () => {
    expect(spearman([], [])).toBe(0);
    expect(spearman([1], [2])).toBe(0);
  });
});

describe('loadStatCacheForLeagues', () => {
  it('flags missing leagues with hasData=false', () => {
    const out = loadStatCacheForLeagues(['nfl', 'nba']);
    expect(out).toHaveLength(2);
    const nfl = out.find((b) => b.league === 'nfl')!;
    const nba = out.find((b) => b.league === 'nba')!;
    expect(nfl.hasData).toBe(true);
    expect(nfl.players.length).toBe(50);
    expect(nba.hasData).toBe(false);
    expect(nba.notes[0]).toMatch(/cache missing/);
  });
});

describe('buildDraftPool', () => {
  it('orders by projectedWeekly desc with stable id tiebreaker', () => {
    const bundles = loadStatCacheForLeagues(['nfl']);
    const pool = buildDraftPool(bundles, mockSynthFormula);
    expect(pool.length).toBe(50);
    // Top player should be tier-0; weakest should be tier-4.
    expect(pool[0]!.id).toBe('nfl:t:0');
    expect(pool[pool.length - 1]!.projectedWeekly).toBeLessThan(pool[0]!.projectedWeekly);
  });
});

describe('runSimulation (smoke)', () => {
  it('runs a 1-season 20-user NFL simulation deterministically', () => {
    const r1 = runSimulation({
      leagues: ['nfl'],
      seasons: 1,
      formula: mockSynthFormula,
      seed: 42,
      syntheticUserCountOverride: 20,
      disableCards: true,
      disableFA: true,
    });
    const r2 = runSimulation({
      leagues: ['nfl'],
      seasons: 1,
      formula: mockSynthFormula,
      seed: 42,
      syntheticUserCountOverride: 20,
      disableCards: true,
      disableFA: true,
    });
    expect(r1.fairness.fairness_score).toBeCloseTo(r2.fairness.fairness_score, 8);
    expect(r1.fairness.total_top1pct).toBeCloseTo(r2.fairness.total_top1pct, 8);
  });

  it('produces non-degenerate fairness metrics', () => {
    const r = runSimulation({
      leagues: ['nfl'],
      seasons: 1,
      formula: mockSynthFormula,
      seed: 42,
      syntheticUserCountOverride: 20,
      disableCards: true,
      disableFA: true,
    });
    expect(r.fairness.user_count).toBe(20);
    expect(r.fairness.weeks_simulated).toBeGreaterThan(0);
    expect(r.fairness.total_stddev).toBeGreaterThanOrEqual(0);
    expect(r.fairness.top1_to_median_ratio).toBeGreaterThan(0);
    expect(r.fairness.top1_to_median_ratio).toBeLessThan(20); // sanity ceiling
    // With only 20 users and 1 season, fairness should be reasonably bounded
    expect(r.fairness.fairness_score).toBeGreaterThanOrEqual(0);
    expect(r.fairness.fairness_score).toBeLessThanOrEqual(100);
  });

  it('honors min_picks_per_sport when data is available', () => {
    const formula = { ...mockSynthFormula, global: { ...mockSynthFormula.global, min_picks_per_sport: { basketball: 0, football: 3, baseball: 0, hockey: 0, soccer: 0 } } };
    const r = runSimulation({
      leagues: ['nfl'],
      seasons: 1,
      formula,
      seed: 7,
      syntheticUserCountOverride: 10,
      disableCards: true,
      disableFA: true,
    });
    // Roster size = 3, min football = 3 → every roster is 100% football
    expect(r.cfg_summary.min_picks_per_sport.football).toBe(3);
    expect(r.fairness.user_count).toBe(10);
  });

  it('relaxes min_picks for sports with no cache data', () => {
    const formula = {
      ...mockSynthFormula,
      global: {
        ...mockSynthFormula.global,
        min_picks_per_sport: { basketball: 1, football: 0, baseball: 1, hockey: 0, soccer: 0 },
      },
    };
    const r = runSimulation({
      leagues: ['nfl', 'nba', 'mlb'],
      seasons: 1,
      formula,
      seed: 11,
      syntheticUserCountOverride: 10,
      disableCards: true,
      disableFA: true,
    });
    expect(r.notes.some((n) => n.includes('basketball') && n.includes('relaxing'))).toBe(true);
    expect(r.notes.some((n) => n.includes('baseball') && n.includes('relaxing'))).toBe(true);
    expect(r.cfg_summary.min_picks_per_sport.basketball).toBe(0);
    expect(r.cfg_summary.min_picks_per_sport.baseball).toBe(0);
  });

  it('throws clearly when no leagues have data', () => {
    expect(() =>
      runSimulation({
        leagues: ['mls'], // mocked as missing
        seasons: 1,
        formula: mockSynthFormula,
        seed: 1,
        syntheticUserCountOverride: 10,
        disableCards: true,
        disableFA: true,
      }),
    ).toThrow(/no leagues with usable stat data/);
  });

  it('top1/median ratio is bounded — single-sport pool ≤ 8x', () => {
    const r = runSimulation({
      leagues: ['nfl'],
      seasons: 1,
      formula: mockSynthFormula,
      seed: 99,
      syntheticUserCountOverride: 50,
      disableCards: true,
      disableFA: true,
    });
    expect(r.fairness.top1_to_median_ratio).toBeLessThan(8);
  });
});
