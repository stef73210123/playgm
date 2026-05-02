/**
 * computeRatings.test.ts — unit tests for the 13-grade rating system.
 *
 * Covers:
 *   - placeBand (band lookup math, 13-grade output)
 *   - lookupStatPriorities (resolution-file lookup)
 *   - computeRating (full pipeline, missing-tier-file path, weighting math)
 *   - scoreToGrade / GRADE_SCORE / compareGrade (numeric mapping helpers)
 *   - MLB hitter/pitcher routing including Ohtani two-way edge case
 *   - Boundary mapping at every percentile cut
 *   - Legacy 5-tier file compatibility (v1 files still load)
 */
import {
  computeRating,
  placeBand,
  lookupStatPriorities,
  scoreToGrade,
  compareGrade,
  GRADE_SCORE,
  GRADE_ORDER,
  gradeToTier,
  _clearRatingCaches,
  type Grade,
} from '../computeRatings.js';

// ─── 13-grade test fixtures ─────────────────────────────────────────────────

const QB_BLOCK = {
  display_name: 'Pass Yds',
  unit: 'passing yards',
  kid_friendly_name: 'passing',
  retrospective_prefix: 'Last season,',
  grades: [
    { grade: 'A+' as const, min: 4500, max: null, variants: [] },
    { grade: 'A'  as const, min: 4200, max: 4499.99, variants: [] },
    { grade: 'A-' as const, min: 3800, max: 4199.99, variants: [] },
    { grade: 'B+' as const, min: 3400, max: 3799.99, variants: [] },
    { grade: 'B'  as const, min: 2900, max: 3399.99, variants: [] },
    { grade: 'B-' as const, min: 2300, max: 2899.99, variants: [] },
    { grade: 'C+' as const, min: 1700, max: 2299.99, variants: [] },
    { grade: 'C'  as const, min: 1400, max: 1699.99, variants: [] },
    { grade: 'C-' as const, min: 1100, max: 1399.99, variants: [] },
    { grade: 'D+' as const, min: 800,  max: 1099.99, variants: [] },
    { grade: 'D'  as const, min: 500,  max: 799.99,  variants: [] },
    { grade: 'D-' as const, min: 200,  max: 499.99,  variants: [] },
    { grade: 'F'  as const, min: 0,    max: 199.99,  variants: [] },
  ],
};

const ERA_BLOCK = {
  display_name: 'ERA',
  unit: 'earned run average',
  kid_friendly_name: 'run prevention',
  retrospective_prefix: 'Last season,',
  lower_is_better: true,
  grades: [
    { grade: 'A+' as const, min: 0,    max: 2.50, variants: [] },
    { grade: 'A'  as const, min: 2.51, max: 2.80, variants: [] },
    { grade: 'A-' as const, min: 2.81, max: 3.20, variants: [] },
    { grade: 'B+' as const, min: 3.21, max: 3.60, variants: [] },
    { grade: 'B'  as const, min: 3.61, max: 4.00, variants: [] },
    { grade: 'B-' as const, min: 4.01, max: 4.40, variants: [] },
    { grade: 'C+' as const, min: 4.41, max: 4.80, variants: [] },
    { grade: 'C'  as const, min: 4.81, max: 5.00, variants: [] },
    { grade: 'C-' as const, min: 5.01, max: 5.30, variants: [] },
    { grade: 'D+' as const, min: 5.31, max: 5.60, variants: [] },
    { grade: 'D'  as const, min: 5.61, max: 6.00, variants: [] },
    { grade: 'D-' as const, min: 6.01, max: 6.50, variants: [] },
    { grade: 'F'  as const, min: 6.51, max: null, variants: [] },
  ],
};

const LEGACY_QB_TIERS = {
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

beforeEach(() => {
  _clearRatingCaches();
});

// ─── numeric helpers ────────────────────────────────────────────────────────

describe('GRADE_ORDER + GRADE_SCORE', () => {
  test('exposes 13 grades in best-to-worst order', () => {
    expect(GRADE_ORDER).toEqual([
      'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F',
    ]);
  });
  test('A+ scores 13, F scores 1', () => {
    expect(GRADE_SCORE['A+']).toBe(13);
    expect(GRADE_SCORE['F']).toBe(1);
  });
  test('every grade has a unique score in [1,13]', () => {
    const seen = new Set<number>();
    for (const g of GRADE_ORDER) {
      const s = GRADE_SCORE[g];
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(13);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
    expect(seen.size).toBe(13);
  });
  test('compareGrade orders A+ above F', () => {
    expect(compareGrade('A+', 'F')).toBeGreaterThan(0);
    expect(compareGrade('B', 'B')).toBe(0);
    expect(compareGrade('C-', 'B-')).toBeLessThan(0);
  });
});

describe('scoreToGrade boundary mapping', () => {
  test('integer scores map back to the right grade', () => {
    for (const g of GRADE_ORDER) {
      expect(scoreToGrade(GRADE_SCORE[g])).toBe(g);
    }
  });
  test('clamps below F → F', () => {
    expect(scoreToGrade(0)).toBe('F');
    expect(scoreToGrade(-5)).toBe('F');
  });
  test('clamps above A+ → A+', () => {
    expect(scoreToGrade(20)).toBe('A+');
    expect(scoreToGrade(13.7)).toBe('A+');
  });
  test('rounds to nearest grade slot', () => {
    expect(scoreToGrade(12.6)).toBe('A+');
    expect(scoreToGrade(12.4)).toBe('A');
    expect(scoreToGrade(7.4)).toBe('C+');
  });
  test('handles non-finite gracefully', () => {
    expect(scoreToGrade(NaN)).toBe('F');
    expect(scoreToGrade(Infinity)).toBe('A+');
  });
});

describe('gradeToTier (legacy bucket)', () => {
  test('A grades → elite', () => {
    expect(gradeToTier('A+')).toBe('elite');
    expect(gradeToTier('A')).toBe('elite');
    expect(gradeToTier('A-')).toBe('elite');
  });
  test('B grades → strong', () => {
    expect(gradeToTier('B+')).toBe('strong');
    expect(gradeToTier('B')).toBe('strong');
    expect(gradeToTier('B-')).toBe('strong');
  });
  test('C grades → solid', () => {
    for (const g of ['C+', 'C', 'C-'] as Grade[]) {
      expect(gradeToTier(g)).toBe('solid');
    }
  });
  test('D grades → role', () => {
    for (const g of ['D+', 'D', 'D-'] as Grade[]) {
      expect(gradeToTier(g)).toBe('role');
    }
  });
  test('F → deep_bench', () => {
    expect(gradeToTier('F')).toBe('deep_bench');
  });
});

// ─── placeBand ──────────────────────────────────────────────────────────────

describe('placeBand', () => {
  test('top of band → A+', () => {
    expect(placeBand(5500, QB_BLOCK)).toBe('A+');
  });
  test('exactly at A+ minimum lands in A+', () => {
    expect(placeBand(4500, QB_BLOCK)).toBe('A+');
  });
  test('one yard below A+ minimum → A', () => {
    expect(placeBand(4499, QB_BLOCK)).toBe('A');
  });
  test('mid-tier value → B', () => {
    expect(placeBand(3000, QB_BLOCK)).toBe('B');
  });
  test('lower edge of D- → D-', () => {
    expect(placeBand(200, QB_BLOCK)).toBe('D-');
  });
  test('value below F upper → F', () => {
    expect(placeBand(50, QB_BLOCK)).toBe('F');
  });
  test('lower_is_better: ERA 2.50 → A+', () => {
    expect(placeBand(2.5, ERA_BLOCK)).toBe('A+');
  });
  test('lower_is_better: ERA 6.00 → D', () => {
    expect(placeBand(6, ERA_BLOCK)).toBe('D');
  });
  test('lower_is_better: ERA 4.00 → B', () => {
    expect(placeBand(4, ERA_BLOCK)).toBe('B');
  });
  test('lower_is_better: ERA 7.20 → F (above all bands)', () => {
    expect(placeBand(7.2, ERA_BLOCK)).toBe('F');
  });
  test('legacy v1 5-tier file: elite still resolves to A', () => {
    expect(placeBand(4000, LEGACY_QB_TIERS)).toBe('A');
  });
  test('legacy v1: deep_bench resolves to F', () => {
    expect(placeBand(50, LEGACY_QB_TIERS)).toBe('F');
  });
  test('legacy v1: solid resolves to C', () => {
    expect(placeBand(2000, LEGACY_QB_TIERS)).toBe('C');
  });
});

// ─── lookupStatPriorities ───────────────────────────────────────────────────

describe('lookupStatPriorities', () => {
  test('NBA PG → assists primary', () => {
    const p = lookupStatPriorities('nba', 'PG');
    expect(p?.primary).toBe('assists');
  });
  test('NFL QB → passing_yds primary', () => {
    const p = lookupStatPriorities('nfl', 'qb');
    expect(p?.primary).toBe('passing_yds');
  });
  test('MLB hitter falls back to OF entry', () => {
    const p = lookupStatPriorities('mlb', 'hitter');
    expect(p?.primary).toBe('hits');
  });
  test('MLB pitcher falls back to SP entry', () => {
    const p = lookupStatPriorities('mlb', 'pitcher');
    expect(p).not.toBeNull();
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

// ─── computeRating end-to-end ───────────────────────────────────────────────

describe('computeRating', () => {
  test('returns null when tier file is missing', () => {
    const r = computeRating({
      playerId: 'fake:1',
      sport: 'nfl',
      position: 'unknown_position_group',
      stats: { games_played: 16, passing_yards: 4000 },
    });
    expect(r).toBeNull();
  });

  test('NFL QB with elite passing → A or B grade', () => {
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
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
    expect(r!.score).toBeGreaterThanOrEqual(8);
  });

  test('NFL QB with deep-bench numbers → D or F grade', () => {
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
    expect(['D+', 'D', 'D-', 'F']).toContain(r!.overall_grade);
  });

  test('NBA SG with elite stats → A or B grade', () => {
    const r = computeRating({
      playerId: 'fake:sg',
      sport: 'nba',
      position: 'SG',
      stats: {
        games_played: 70,
        points: 28, rebounds: 6, assists: 9, steals: 1.6, three_pm: 4.0, fg_pct: 50,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
  });

  test('breakdowns include each measurable stat with a grade', () => {
    const r = computeRating({
      playerId: 'fake:sg',
      sport: 'nba',
      position: 'SG',
      stats: { points: 14, rebounds: 4, assists: 5 },
    });
    expect(r).not.toBeNull();
    expect(r!.stat_breakdowns.length).toBeGreaterThan(0);
    for (const b of r!.stat_breakdowns) {
      expect(GRADE_ORDER).toContain(b.grade);
    }
  });

  test('player with zero stats lands at F', () => {
    const r = computeRating({
      playerId: 'fake:rookie',
      sport: 'nba',
      position: 'SG',
      stats: { games_played: 0 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade).toBe('F');
  });

  test('source is tier-files-v2', () => {
    const r = computeRating({
      playerId: 'fake:src',
      sport: 'nba',
      position: 'SG',
      stats: { points: 20 },
    });
    expect(r?.source).toBe('tier-files-v2');
  });

  test('confidence is in [0,1]', () => {
    const r = computeRating({
      playerId: 'fake:conf',
      sport: 'nba',
      position: 'SG',
      stats: { games_played: 41, points: 18, assists: 5, rebounds: 4, steals: 1, three_pm: 2 },
    });
    expect(r).not.toBeNull();
    expect(r!.confidence).toBeGreaterThanOrEqual(0);
    expect(r!.confidence).toBeLessThanOrEqual(1);
  });
});

// ─── MLB routing + two-way ──────────────────────────────────────────────────

describe('MLB hitter/pitcher routing', () => {
  test('hitter-only stats → routes to mlb-hitter', () => {
    const r = computeRating({
      playerId: 'fake:hitter',
      sport: 'mlb',
      position: 'OF',
      stats: { games_played: 150, avg: 0.290, hits: 170, hr: 30, rbi: 100, runs: 100, sb: 10 },
    });
    expect(r).not.toBeNull();
    expect(r!.position).toBe('hitter');
    expect(r!.secondary_grade).toBeUndefined();
  });

  test('pitcher-only stats → routes to mlb-pitcher', () => {
    const r = computeRating({
      playerId: 'fake:pitcher',
      sport: 'mlb',
      position: 'SP',
      stats: { games_played: 32, k_pitcher: 220, innings_pitched: 200, wins: 15, era: 2.95, whip: 1.05, saves: 0 },
    });
    expect(r).not.toBeNull();
    expect(r!.position).toBe('pitcher');
    expect(r!.secondary_grade).toBeUndefined();
  });

  test('two-way (hitter + pitcher stats) → both rated, secondary_grade set', () => {
    const r = computeRating({
      playerId: 'fake:ohtani',
      sport: 'mlb',
      position: 'DH',
      stats: {
        games_played: 135,
        avg: 0.304, hits: 151, hr: 44, rbi: 95, runs: 102, sb: 20,
        innings_pitched: 132, k_pitcher: 167, wins: 10, era: 3.14, whip: 1.06, saves: 0,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.secondary_grade).toBeDefined();
    expect(['hitter', 'pitcher']).toContain(r!.position);
    expect(['hitter', 'pitcher']).toContain(r!.secondary_grade!.position);
    expect(r!.position).not.toBe(r!.secondary_grade!.position);
  });

  test('two-way: higher grade wins overall', () => {
    const r = computeRating({
      playerId: 'fake:ohtani-bat-better',
      sport: 'mlb',
      position: 'DH',
      stats: {
        games_played: 150, avg: 0.330, hits: 200, hr: 50, rbi: 130, runs: 130, sb: 25,
        innings_pitched: 30, k_pitcher: 25, wins: 1, era: 5.5, whip: 1.6, saves: 0,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.position).toBe('hitter');
    expect(r!.secondary_grade!.position).toBe('pitcher');
    expect(GRADE_SCORE[r!.overall_grade]).toBeGreaterThanOrEqual(GRADE_SCORE[r!.secondary_grade!.overall_grade]);
  });

  test('staff-pitcher position with batting stats: still rates pitcher only when no hitter shape', () => {
    const r = computeRating({
      playerId: 'fake:reliever',
      sport: 'mlb',
      position: 'RP',
      stats: { games_played: 65, k_pitcher: 80, innings_pitched: 65, wins: 4, era: 2.85, whip: 1.10, saves: 35 },
    });
    expect(r).not.toBeNull();
    expect(r!.position).toBe('pitcher');
  });
});

// ─── known-player smoke tests ───────────────────────────────────────────────

describe('known players — smoke test', () => {
  test('Mahomes (NFL QB) — elite passing → A or B grade', () => {
    const r = computeRating({
      playerId: 'espn:3139477',
      sport: 'nfl',
      position: 'qb',
      stats: {
        games_played: 17,
        passing_yards: 4183, passing_touchdowns: 26, completion_percentage: 67.2,
        interceptions: 11, passer_rating: 92.6, rushing_yards: 389, rushing_touchdowns: 4,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
  });

  test('weak QB → C, D, or F', () => {
    const r = computeRating({
      playerId: 'fake:weak-qb',
      sport: 'nfl',
      position: 'qb',
      stats: {
        games_played: 8,
        passing_yards: 600, passing_touchdowns: 2, completion_percentage: 55,
        interceptions: 9, passer_rating: 65,
      },
    });
    expect(r).not.toBeNull();
    expect(['C+','C','C-','D+','D','D-','F']).toContain(r!.overall_grade);
  });

  test('NBA SG elite → A or B', () => {
    const r = computeRating({
      playerId: 'fake:elite-sg',
      sport: 'nba',
      position: 'SG',
      stats: { games_played: 74, points: 26.4, rebounds: 4.5, assists: 5.1, steals: 0.7, three_pm: 4.8, fg_pct: 45 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
  });

  test('NBA C elite → A or B', () => {
    const r = computeRating({
      playerId: 'fake:elite-c',
      sport: 'nba',
      position: 'C',
      stats: { games_played: 70, points: 25, rebounds: 12, blocks: 1.5, assists: 5, fg_pct: 60, ft_pct: 80 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
  });

  test('Mookie Betts (MLB hitter) — elite → A or B with confidence > 0', () => {
    const r = computeRating({
      playerId: 'espn:33039',
      sport: 'mlb',
      position: 'OF',
      stats: { games_played: 152, avg: 0.307, hits: 175, hr: 26, rbi: 75, runs: 126, sb: 16 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
    expect(r!.confidence).toBeGreaterThan(0);
  });

  test('Aaron Judge — elite hitter → A grade', () => {
    const r = computeRating({
      playerId: 'espn:33192',
      sport: 'mlb',
      position: 'OF',
      stats: { games_played: 158, avg: 0.322, hits: 180, hr: 62, rbi: 131, runs: 133, sb: 16 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.startsWith('A')).toBe(true);
  });

  test('Ohtani two-way — A or B with secondary_grade', () => {
    const r = computeRating({
      playerId: 'espn:39832',
      sport: 'mlb',
      position: 'DH',
      stats: {
        games_played: 135,
        avg: 0.304, hits: 151, hr: 44, rbi: 95, runs: 102, sb: 20,
        innings_pitched: 132, k_pitcher: 167, wins: 10, era: 3.14, whip: 1.06, saves: 0,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
    expect(r!.secondary_grade).toBeDefined();
  });

  test('Cole (MLB pitcher) — elite ERA + Ks → A or B', () => {
    const r = computeRating({
      playerId: 'espn:32162',
      sport: 'mlb',
      position: 'SP',
      stats: { games_played: 32, innings_pitched: 200, k_pitcher: 230, wins: 15, era: 2.50, whip: 0.95, saves: 0 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
    expect(r!.position).toBe('pitcher');
  });

  test('McDavid (NHL skater) — elite goals + assists → A or B', () => {
    const r = computeRating({
      playerId: 'espn:4233563',
      sport: 'nhl',
      position: 'skater',
      stats: { games_played: 76, goals: 32, assists: 100, sog: 314, plus_minus: 22, blocks: 25 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
  });

  test('Hellebuyck (NHL goalie, fallback bands) → A or B', () => {
    const r = computeRating({
      playerId: 'espn:goalie',
      sport: 'nhl',
      position: 'goalie',
      stats: { games_played: 60, saves: 1700, save_pct: 0.928, gaa: 2.39, wins: 37, shutouts: 5 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
  });

  test('Messi (MLS FW, fallback bands) → A or B', () => {
    const r = computeRating({
      playerId: 'espn:45843',
      sport: 'mls',
      position: 'fw',
      stats: { games_played: 19, goals: 20, shots: 60, assists: 8 },
    });
    expect(r).not.toBeNull();
    expect(r!.overall_grade.charAt(0)).toMatch(/[AB]/);
  });
});

// ─── boundary mapping at every percentile cut ───────────────────────────────

describe('boundary mapping (all 13 grades reachable on QB_BLOCK)', () => {
  for (const band of QB_BLOCK.grades) {
    test(`value at ${band.grade} min → ${band.grade}`, () => {
      expect(placeBand(band.min, QB_BLOCK)).toBe(band.grade);
    });
    if (band.max !== null) {
      test(`value at ${band.grade} max → ${band.grade}`, () => {
        expect(placeBand(band.max!, QB_BLOCK)).toBe(band.grade);
      });
    }
  }
});

describe('boundary mapping (lower_is_better — ERA_BLOCK)', () => {
  for (const band of ERA_BLOCK.grades) {
    test(`ERA at ${band.grade} min → ${band.grade}`, () => {
      expect(placeBand(band.min, ERA_BLOCK)).toBe(band.grade);
    });
    if (band.max !== null) {
      test(`ERA at ${band.grade} max → ${band.grade}`, () => {
        expect(placeBand(band.max!, ERA_BLOCK)).toBe(band.grade);
      });
    }
  }
});
