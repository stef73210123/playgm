/**
 * espnAdapter.test.ts — pure-logic tests (no network).
 */
import { classifyPositionGroup, EspnAdapter } from '../espnAdapter.js';
import { getStatsAdapter, resetStatsAdapter } from '../index.js';

describe('classifyPositionGroup', () => {
  test('NFL QB → qb', () => expect(classifyPositionGroup('nfl', 'QB')).toBe('qb'));
  test('NFL RB → rb', () => expect(classifyPositionGroup('nfl', 'RB')).toBe('rb'));
  test('NFL WR / TE → wr-te', () => {
    expect(classifyPositionGroup('nfl', 'WR')).toBe('wr-te');
    expect(classifyPositionGroup('nfl', 'TE')).toBe('wr-te');
  });
  test('NFL DE / LB / CB → defense', () => {
    expect(classifyPositionGroup('nfl', 'DE')).toBe('defense');
    expect(classifyPositionGroup('nfl', 'LB')).toBe('defense');
    expect(classifyPositionGroup('nfl', 'CB')).toBe('defense');
  });
  test('NFL K / P → special', () => {
    expect(classifyPositionGroup('nfl', 'K')).toBe('special');
    expect(classifyPositionGroup('nfl', 'P')).toBe('special');
  });
  test('NFL OL / G / T → other', () => {
    expect(classifyPositionGroup('nfl', 'G')).toBe('other');
    expect(classifyPositionGroup('nfl', 'T')).toBe('other');
  });

  test('NBA PG/SG/SF/PF/C pass through', () => {
    for (const p of ['PG', 'SG', 'SF', 'PF', 'C']) {
      expect(classifyPositionGroup('nba', p)).toBe(p);
    }
  });
  test('NBA G → SG (fallback)', () => expect(classifyPositionGroup('nba', 'G')).toBe('SG'));

  test('MLB SP/RP → pitcher; otherwise hitter', () => {
    expect(classifyPositionGroup('mlb', 'SP')).toBe('pitcher');
    expect(classifyPositionGroup('mlb', 'RP')).toBe('pitcher');
    expect(classifyPositionGroup('mlb', '1B')).toBe('hitter');
    expect(classifyPositionGroup('mlb', 'OF')).toBe('hitter');
  });

  test('NHL G → goalie; otherwise skater', () => {
    expect(classifyPositionGroup('nhl', 'G')).toBe('goalie');
    expect(classifyPositionGroup('nhl', 'C')).toBe('skater');
    expect(classifyPositionGroup('nhl', 'LW')).toBe('skater');
  });

  test('MLS positions classify to fw/mf/df/gk', () => {
    expect(classifyPositionGroup('mls', 'F')).toBe('fw');
    expect(classifyPositionGroup('mls', 'M')).toBe('mf');
    expect(classifyPositionGroup('mls', 'D')).toBe('df');
    expect(classifyPositionGroup('mls', 'GK')).toBe('gk');
  });
});

describe('getStatsAdapter', () => {
  beforeEach(() => resetStatsAdapter());
  afterAll(() => resetStatsAdapter());

  test('default → ESPN adapter', () => {
    delete process.env.STATS_PROVIDER;
    const a = getStatsAdapter();
    expect(a.sourceName).toBe('espn');
    expect(a.isLicensedForCommercial).toBe(false);
  });

  test('STATS_PROVIDER=thesportsdb → thesportsdb adapter', () => {
    process.env.STATS_PROVIDER = 'thesportsdb';
    const a = getStatsAdapter();
    expect(a.sourceName).toBe('thesportsdb');
    expect(a.isLicensedForCommercial).toBe(true);
    delete process.env.STATS_PROVIDER;
  });

  test('STATS_PROVIDER=apisports → apisports adapter', () => {
    process.env.STATS_PROVIDER = 'apisports';
    const a = getStatsAdapter();
    expect(a.sourceName).toBe('apisports');
    expect(a.isLicensedForCommercial).toBe(true);
    delete process.env.STATS_PROVIDER;
  });

  test('thesportsdb stub throws on every method', () => {
    process.env.STATS_PROVIDER = 'thesportsdb';
    const a = getStatsAdapter();
    // Methods are declared async via Promise return type but the stubs throw
    // synchronously (no `async` keyword), so `expect(...).toThrow` works.
    expect(() => a.fetchLeagueRoster('nba')).toThrow(/TODO/);
    expect(() => a.fetchPlayerSeasonStats('nba', '1')).toThrow(/TODO/);
    expect(() => a.fetchTeamSchedule('nba', '1')).toThrow(/TODO/);
    expect(() => a.fetchGameBoxScore('nba', '1')).toThrow(/TODO/);
    delete process.env.STATS_PROVIDER;
  });

  test('EspnAdapter constructs without warning when NODE_ENV != production', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const a = new EspnAdapter();
    expect(a.sourceName).toBe('espn');
    process.env.NODE_ENV = orig;
  });
});
