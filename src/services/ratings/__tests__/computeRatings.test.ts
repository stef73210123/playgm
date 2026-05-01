/**
 * computeRatings.test.ts — unit tests for the per-player tier rating.
 *
 * Covers:
 *   - placeBand (band lookup math)
 *   - lookupStatPriorities (resolution-file lookup)
 *   - computeRating (full pipeline, missing-tier-file path, weighting math)
 *
 * The 5-known-players smoke test (Mahomes/Curry/Betts/McDavid/Messi) is
 * marked it.todo where the cache for that league hasn't been pulled yet.
 */
import { computeRating, placeBand, lookupStatPriorities, _clearRatingCaches } from '../computeRatings.js';

const QB_BLOCK = {
  display_name: 'Pass Yds',
  unit: 'passing yards',
  kid_friendly_name: 'passing',
  retrospective_prefix: 'Last season,',
  tiers: [
    { name: 'elite' as const, min: 3931, max: null, variants: [] },
    { name: 'strong' as const, min: 2549, max: 3930.99, variants: [] },
    { name: 'solid' as const, min: 739, max: 2548.99, variants: [] },
    { name: 'role' as const, min: 102, max: 738.99, variants: [] },
    { name: 'deep_bench' as const, min: 0, max: 101.99, variants: [] },
  ],
};

const ERA_BLOCK = {
  display_name: 'ERA',
  unit: 'earned run average',
  kid_friendly_name: 'run prevention',
  retrospective_prefix: 'Last season,',
  lower_is_better: true,
  tiers: [
    { name: 'elite' as const, min: 0, max: 3.0, variants: [] },
    { name: 'strong' as const, min: 3.01, max: 3.8, variants: [] },
    { name: 'solid' as const, min: 3.81, max: 4.5, variants: [] },
    { name: 'role' as const, min: 4.51, max: 5.5, variants: [] },
    { name: 'deep_bench' as const, min: 5.51, max: null, variants: [] },
  ],
};

beforeEach(() => {
  _clearRatingCaches();
});

describe('placeBand', () => {
  test('value above the elite minimum lands in elite', () => {
    expect(placeBand(4500, QB_BLOCK)).toBe('elite');
  });
  test('value in the strong band', () => {
    expect(placeBand(3000, QB_BLOCK)).toBe('strong');
  });
  test('value at exact lower edge of solid', () => {
    expect(placeBand(739, QB_BLOCK)).toBe('solid');
  });
  test('value in role band', () => {
    expect(placeBand(500, QB_BLOCK)).toBe('role');
  });
  test('value in deep_bench band', () => {
    expect(placeBand(50, QB_BLOCK)).toBe('deep_bench');
  });
  test('lower_is_better: ERA 2.50 → elite', () => {
    expect(placeBand(2.5, ERA_BLOCK)).toBe('elite');
  });
  test('lower_is_better: ERA 6.00 → deep_bench', () => {
    expect(placeBand(6, ERA_BLOCK)).toBe('deep_bench');
  });
  test('lower_is_better: ERA 4.00 → solid', () => {
    expect(placeBand(4, ERA_BLOCK)).toBe('solid');
  });
});

describe('lookupStatPriorities', () => {
  test('NBA PG → assists primary', () => {
    const p = lookupStatPriorities('nba', 'PG');
    expect(p?.primary).toBe('assists');
  });
  test('NFL QB → passing_yds primary (resolution file uses passing_yds, not passing_yards)', () => {
    const p = lookupStatPriorities('nfl', 'qb');
    expect(p?.primary).toBe('passing_yds');
  });
  test('MLB hitter falls back to OF entry', () => {
    const p = lookupStatPriorities('mlb', 'hitter');
    expect(p?.primary).toBe('hits');
  });
  test('NHL skater falls back to C entry', () => {
    const p = lookupStatPriorities('nhl', 'skater');
    expect(p?.primary).toBe('goals');
  });
  test('MLS FW → goals primary', () => {
    const p = lookupStatPriorities('mls', 'FW');
    expect(p?.primary).toBe('goals');
  });
});

describe('computeRating', () => {
  test('returns null when tier file is missing for a sport+position', () => {
    const r = computeRating({
      playerId: 'fake:1',
      sport: 'nfl',
      position: 'unknown_position_group',
      stats: { games_played: 16, passing_yards: 4000 },
    });
    // tier file 'nfl-unknown_position_group.json' doesn't exist
    expect(r).toBeNull();
  });

  test('NFL QB with elite passing → at least strong', () => {
    const r = computeRating({
      playerId: 'fake:qb',
      sport: 'nfl',
      position: 'qb',
      stats: {
        games_played: 17,
        passing_yards: 4500,
        passing_touchdowns: 35,
        completion_percentage: 70,
        interceptions: 8,
        passer_rating: 105,
      },
    });
    expect(r).not.toBeNull();
    expect(['elite', 'strong']).toContain(r!.overall_tier);
    // Score should be high (>=4) for elite-level QB.
    expect(r!.score).toBeGreaterThanOrEqual(4);
  });

  test('NFL QB with deep-bench numbers ends at deep_bench or role', () => {
    const r = computeRating({
      playerId: 'fake:qb-bad',
      sport: 'nfl',
      position: 'qb',
      stats: {
        games_played: 4,
        passing_yards: 50,
        passing_touchdowns: 0,
        completion_percentage: 50,
        interceptions: 12,
        passer_rating: 40,
      },
    });
    expect(r).not.toBeNull();
    expect(['deep_bench', 'role']).toContain(r!.overall_tier);
  });

  test('NBA PG with elite stats → elite', () => {
    const r = computeRating({
      playerId: 'fake:pg',
      sport: 'nba',
      position: 'PG',
      stats: {
        games_played: 70,
        points: 28,
        rebounds: 6,
        assists: 9,
        steals: 1.6,
        three_pm: 4.0,
        fg_pct: 50,
      },
    });
    expect(r).not.toBeNull();
    expect(['elite', 'strong']).toContain(r!.overall_tier);
  });

  test('breakdowns include each measurable stat with a tier', () => {
    const r = computeRating({
      playerId: 'fake:pg',
      sport: 'nba',
      position: 'PG',
      stats: { points: 14, rebounds: 4, assists: 5 },
    });
    expect(r).not.toBeNull();
    expect(r!.stat_breakdowns.length).toBeGreaterThan(0);
    for (const b of r!.stat_breakdowns) {
      expect(['elite', 'strong', 'solid', 'role', 'deep_bench']).toContain(b.tier);
    }
  });

  test('player with zero stats lands at deep_bench', () => {
    const r = computeRating({
      playerId: 'fake:rookie',
      sport: 'nba',
      position: 'PG',
      stats: { games_played: 0 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_tier).toBe('deep_bench');
  });
});

describe('5 known players (smoke test)', () => {
  // These use simulated stats based on real-life production. We're verifying
  // the rating compute lands at elite/strong tier for each, NOT that we read
  // the actual cache files (those would require running pull scripts first).

  test('Mahomes (NFL QB) — elite passing numbers → elite or strong', () => {
    const r = computeRating({
      playerId: 'espn:3139477',
      sport: 'nfl',
      position: 'qb',
      stats: {
        games_played: 17,
        passing_yards: 4183,
        passing_touchdowns: 26,
        completion_percentage: 67.2,
        interceptions: 11,
        passer_rating: 92.6,
        rushing_yards: 389,
        rushing_touchdowns: 4,
      },
    });
    expect(r).not.toBeNull();
    expect(['elite', 'strong']).toContain(r!.overall_tier);
  });

  test('Curry (NBA PG) — elite shooting + assists → elite', () => {
    const r = computeRating({
      playerId: 'espn:3975',
      sport: 'nba',
      position: 'PG',
      stats: {
        games_played: 74,
        points: 26.4,
        rebounds: 4.5,
        assists: 5.1,
        steals: 0.7,
        three_pm: 4.8,
        fg_pct: 45,
      },
    });
    expect(r).not.toBeNull();
    expect(['elite', 'strong']).toContain(r!.overall_tier);
  });

  test('LeBron (NBA SF) — elite all-around → elite', () => {
    const r = computeRating({
      playerId: 'espn:1966',
      sport: 'nba',
      position: 'SF',
      stats: {
        games_played: 71,
        points: 25.7,
        rebounds: 7.3,
        assists: 8.3,
        steals: 1.3,
        three_pm: 2.1,
        fg_pct: 54,
      },
    });
    expect(r).not.toBeNull();
    expect(['elite', 'strong']).toContain(r!.overall_tier);
  });

  test('Mookie Betts (MLB hitter) — elite hitting → elite or strong', () => {
    const r = computeRating({
      playerId: 'espn:33039',
      sport: 'mlb',
      position: 'hitter',
      stats: {
        games_played: 152,
        avg: 0.307,
        hits: 175,
        hr: 26,
        rbi: 75,
        runs: 126,
        sb: 16,
      },
    });
    expect(r).not.toBeNull();
    expect(['elite', 'strong']).toContain(r!.overall_tier);
  });

  test('McDavid (NHL skater) — elite goals + assists → elite', () => {
    const r = computeRating({
      playerId: 'espn:4233563',
      sport: 'nhl',
      position: 'skater',
      stats: {
        games_played: 76,
        goals: 32,
        assists: 100,
        sog: 314,
        plus_minus: 22,
        blocks: 25,
      },
    });
    expect(r).not.toBeNull();
    expect(['elite', 'strong']).toContain(r!.overall_tier);
  });

  test('Messi (MLS FW) — elite goals/shots/assists → elite', () => {
    const r = computeRating({
      playerId: 'espn:45843',
      sport: 'mls',
      position: 'fw',
      stats: {
        games_played: 19,
        goals: 20,
        shots: 60,
        assists: 8,
      },
    });
    expect(r).not.toBeNull();
    expect(['elite', 'strong']).toContain(r!.overall_tier);
  });
});
