/**
 * scoringFormula.test.ts — edge cases for the scoring engine.
 *
 * These tests construct in-memory ScoringFormulaFile objects (no disk I/O)
 * so they're hermetic and run on every PR.
 */
import {
  type ScoringFormulaFile,
  scorePlayerWeek,
  gamesPerWeek,
  DEFAULT_GAMES_PER_WEEK,
} from './scoringFormula.js';

function baseFormula(): ScoringFormulaFile {
  return {
    version: 'test',
    by_sport: {
      basketball: {
        weights: { points: 1, rebounds: 1.2, assists: 1.5, turnovers: -1 },
        negative_caps: { turnovers: -10 },
        games_per_week: 3.5,
      },
      football: {
        weights: { passing_yds: 0.04, passing_tds: 4, ints: -2, rushing_yds: 0.1 },
        games_per_week: 1,
      },
      baseball: {
        hitter_weights: { hits: 1, hr: 4 },
        pitcher_weights: { wins: 4, k_pitcher: 1 },
        games_per_week: 6,
      },
      hockey: {
        skater_weights: { goals: 3, assists: 2 },
        goalie_weights: { saves: 0.4, wins: 4 },
        games_per_week: 3.5,
      },
      soccer: {
        weights: { goals: 6, assists: 3 },
        games_per_week: 1.5,
      },
    },
    global: {
      roster_size: 5,
      min_picks_per_sport: { basketball: 0, football: 0, baseball: 0, hockey: 0, soccer: 0 },
      synthetic_user_count: 100,
      draft_position_strategy: 'snake',
    },
  };
}

describe('scorePlayerWeek', () => {
  it('returns 0 for empty stats bag', () => {
    const f = baseFormula();
    expect(scorePlayerWeek({}, 'basketball', f)).toBe(0);
  });

  it('returns 0 for stats not in the formula', () => {
    const f = baseFormula();
    expect(scorePlayerWeek({ random_stat: 999 }, 'basketball', f)).toBe(0);
  });

  it('computes basketball: 30 pts + 10 reb + 5 ast = 30 + 12 + 7.5 = 49.5', () => {
    const f = baseFormula();
    expect(scorePlayerWeek({ points: 30, rebounds: 10, assists: 5 }, 'basketball', f)).toBeCloseTo(49.5, 5);
  });

  it('clamps negative caps: 12 turnovers ⇒ -10 (not -12)', () => {
    const f = baseFormula();
    const score = scorePlayerWeek({ points: 0, turnovers: 12 }, 'basketball', f);
    expect(score).toBe(-10);
  });

  it('aliases football: passing_yds matches cache key passing_yards', () => {
    const f = baseFormula();
    // Cache uses canonical "passing_yards"; formula has weight under "passing_yds".
    const cacheBag = { passing_yards: 300, passing_touchdowns: 2 };
    expect(scorePlayerWeek(cacheBag, 'football', f)).toBeCloseTo(300 * 0.04 + 2 * 4, 5);
  });

  it('routes baseball pitchers to pitcher_weights', () => {
    const f = baseFormula();
    expect(
      scorePlayerWeek({ wins: 2, k_pitcher: 8 }, 'baseball', f, { positionGroup: 'pitcher' }),
    ).toBeCloseTo(8 + 8, 5);
  });

  it('routes baseball hitters to hitter_weights', () => {
    const f = baseFormula();
    expect(
      scorePlayerWeek({ hits: 3, hr: 1 }, 'baseball', f, { positionGroup: 'hitter' }),
    ).toBeCloseTo(7, 5);
  });

  it('routes hockey goalies to goalie_weights', () => {
    const f = baseFormula();
    expect(
      scorePlayerWeek({ saves: 30, wins: 1 }, 'hockey', f, { positionGroup: 'goalie' }),
    ).toBeCloseTo(30 * 0.4 + 4, 5);
  });

  it('handles all-zero stats', () => {
    const f = baseFormula();
    expect(scorePlayerWeek({ points: 0, rebounds: 0, assists: 0 }, 'basketball', f)).toBe(0);
  });

  it('handles non-finite gracefully (NaN/Infinity ignored)', () => {
    const f = baseFormula();
    // NaN is excluded by the alias resolver, so it should not contribute.
    expect(scorePlayerWeek({ points: NaN, rebounds: 5 }, 'basketball', f)).toBeCloseTo(6, 5);
  });
});

describe('gamesPerWeek', () => {
  it('returns the configured value when present', () => {
    const f = baseFormula();
    expect(gamesPerWeek('football', f)).toBe(1);
    expect(gamesPerWeek('baseball', f)).toBe(6);
  });

  it('falls back to defaults when omitted', () => {
    const f = baseFormula();
    delete f.by_sport.basketball.games_per_week;
    expect(gamesPerWeek('basketball', f)).toBe(DEFAULT_GAMES_PER_WEEK.basketball);
  });
});
