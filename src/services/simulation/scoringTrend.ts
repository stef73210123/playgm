/**
 * scoringTrend.ts — per-day average sport contribution + roster_avg over a
 * date window, for the /admin/edit/scoring-trend chart.
 *
 * Source of truth, in order of preference:
 *   1. Most recent completed `simulation_runs` row's
 *      `results_json.fairness.sport_contributions[*].meanPerRoster`
 *      (gives weekly mean PP per sport, after cards / FA / multipliers).
 *   2. Falls back to a lightweight projection-from-stat-cache: load the
 *      same formula + caches `seasonSimulator.runSimulation` would, build
 *      a `DraftablePlayer[]` pool, take the mean weekly projection of the
 *      top-K players per sport (K = min_picks_per_sport[s] × user_count)
 *      and scale by `min_picks_per_sport[s]` to get per-roster weekly PP.
 *
 * Either way, we then convert weekly → per-game-day PP via
 *   per_game_day_pp = weekly_pp / num_active_days_per_week_for_sport
 * and distribute across the sport's known game days (Sun..Sat indices in
 * SPORT_GAME_DAYS). Per-day jitter is deterministically seeded by date+sport
 * so the chart renders identically across reloads.
 *
 * MLS is filtered out when `sports_config.json` flags it disabled (matches
 * the rest of the admin surface).
 *
 * Cached for 5 minutes — same TTL as sportsConfig — so repeated dashboard
 * polls don't re-hit Supabase or re-build the draft pool.
 */
import {
  DEFAULT_GAMES_PER_WEEK,
  loadScoringFormula,
  type Sport,
  type ScoringFormulaFile,
} from './scoringFormula.js';
import {
  buildDraftPool,
  loadStatCacheForLeagues,
  LEAGUE_TO_SPORT,
  type League,
} from './seasonSimulator.js';
import { getEnabledSportIds, type SportId } from '../sportsConfig.js';

const ALL_LEAGUES: League[] = ['nba', 'nfl', 'mlb', 'nhl', 'mls'];
const SPORT_TO_LEAGUE: Record<Sport, League> = {
  basketball: 'nba',
  football: 'nfl',
  baseball: 'mlb',
  hockey: 'nhl',
  soccer: 'mls',
};
const LEAGUE_TO_SPORT_ID: Record<League, SportId> = {
  nba: 'nba',
  nfl: 'nfl',
  mlb: 'mlb',
  nhl: 'nhl',
  mls: 'mls',
};

/**
 * Day-of-week indices (0=Sun..6=Sat) when each sport typically plays.
 * Mirrors the table in seasonSimulator.ts — kept duplicated to avoid
 * cycling imports for one constant. If the simulator's table changes,
 * update both.
 */
export const SPORT_GAME_DAYS: Record<Sport, number[]> = {
  basketball: [0, 2, 3, 5, 6], // Sun/Tue/Wed/Fri/Sat
  football: [0, 1, 4], // Sun/Mon/Thu
  baseball: [0, 2, 3, 4, 5, 6], // most days, no Mon
  hockey: [0, 2, 4, 6], // Sun/Tue/Thu/Sat
  soccer: [0, 3, 6], // Sun/Wed/Sat
};

export interface DayPoint {
  /** ISO date (YYYY-MM-DD) in UTC. */
  date: string;
  /** Per-sport per-roster PP contribution. Keys are sport ids (nfl/nba/mlb/nhl/mls). */
  by_sport: Partial<Record<SportId, number>>;
  /** Sum across enabled sports for this date. */
  roster_avg: number;
}

export interface ScoringTrendResponse {
  weeks: number;
  generated_at: string;
  source: 'simulation_runs' | 'projection_fallback';
  source_run_id?: string;
  source_run_completed_at?: string;
  enabled_sports: SportId[];
  days: DayPoint[];
}

interface CacheEntry {
  weeks: number;
  expiresAt: number;
  payload: ScoringTrendResponse;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<number, CacheEntry>();

/** Drop the cache (used by tests). */
export function _resetTrendCache(): void {
  cache.clear();
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** mulberry32 — same RNG core as seasonSimulator.ts, inlined. */
function rngFromSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function gpwFor(sport: Sport, formula: ScoringFormulaFile): number {
  const v = formula.by_sport[sport].games_per_week;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_GAMES_PER_WEEK[sport];
}

// ─── Source #1: pull from simulation_runs ───────────────────────────────

interface RecentRunSportContrib {
  sport: Sport;
  meanPerRoster: number;
}
interface RecentRun {
  id: string;
  completed_at: string | null;
  total_mean: number | null;
  contributions: RecentRunSportContrib[];
}

async function fetchRecentRunFromSupabase(): Promise<RecentRun | null> {
  if (!process.env['SUPABASE_URL']) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../db/client.js') as typeof import('../../db/client.js');
    const { data, error } = await mod.supabase
      .from('simulation_runs')
      .select('id, completed_at, results_json')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    const row = data[0] as {
      id: string;
      completed_at: string | null;
      results_json: unknown;
    };
    const results = row.results_json as
      | {
          fairness?: {
            total_mean?: number;
            sport_contributions?: Array<{ sport: string; meanPerRoster?: number }>;
          };
        }
      | null;
    const contribs = results?.fairness?.sport_contributions ?? [];
    const out: RecentRunSportContrib[] = [];
    for (const c of contribs) {
      const s = c.sport as Sport;
      if (!s || typeof c.meanPerRoster !== 'number' || !Number.isFinite(c.meanPerRoster)) continue;
      out.push({ sport: s, meanPerRoster: c.meanPerRoster });
    }
    if (out.length === 0) return null;
    return {
      id: row.id,
      completed_at: row.completed_at,
      total_mean: results?.fairness?.total_mean ?? null,
      contributions: out,
    };
  } catch {
    return null;
  }
}

// ─── Source #2: projection fallback ──────────────────────────────────────

/**
 * For each sport with usable cache data, return a per-roster weekly mean PP
 * contribution. Models the snake-draft outcome roughly as:
 *   K = min_picks[s] × user_count   (top players in sport s drawn league-wide)
 *   per_player_weekly = mean(top-K projectedWeekly)
 *   per_roster_weekly = per_player_weekly × min_picks[s]
 *
 * This is the same projection seasonSimulator.ts uses for `sport_contributions`
 * when there's no run yet.
 */
function projectWeeklyPerSport(formula: ScoringFormulaFile): Map<Sport, number> {
  const out = new Map<Sport, number>();
  const bundles = loadStatCacheForLeagues(ALL_LEAGUES);
  const usable = bundles.filter((b) => b.hasData);
  if (usable.length === 0) return out;

  const pool = buildDraftPool(usable, formula);
  const userCount = formula.global.synthetic_user_count;
  const minPicks = formula.global.min_picks_per_sport;

  for (const sport of ['basketball', 'football', 'baseball', 'hockey', 'soccer'] as Sport[]) {
    const need = minPicks[sport] ?? 0;
    if (need <= 0) continue;
    const inSport = pool.filter((p) => p.sport === sport);
    if (inSport.length === 0) continue;
    const k = Math.min(inSport.length, Math.max(1, need * userCount));
    let sum = 0;
    for (let i = 0; i < k; i++) sum += inSport[i]!.projectedWeekly;
    const meanPerPlayer = sum / k;
    out.set(sport, meanPerPlayer * need);
  }
  return out;
}

// ─── Public: build the trend ─────────────────────────────────────────────

export async function buildScoringTrend(weeks: number): Promise<ScoringTrendResponse> {
  const w = Math.max(1, Math.min(52, Math.floor(weeks) || 8));
  const cached = cache.get(w);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  const formula = loadScoringFormula();
  const enabledSportIds = getEnabledSportIds();

  // Map enabled sport ids → Sport (basketball/football/...)
  const enabledSports = new Set<Sport>();
  for (const id of enabledSportIds) {
    const league = id as League;
    const sport = LEAGUE_TO_SPORT[league];
    if (sport) enabledSports.add(sport);
  }

  // Step 1 — pull recent run from Supabase. If absent, fall back to projection.
  const run = await fetchRecentRunFromSupabase();
  let weeklyPerSport = new Map<Sport, number>();
  let source: ScoringTrendResponse['source'];
  let runId: string | undefined;
  let runCompletedAt: string | undefined;

  if (run && run.contributions.length > 0) {
    for (const c of run.contributions) weeklyPerSport.set(c.sport, c.meanPerRoster);
    source = 'simulation_runs';
    runId = run.id;
    runCompletedAt = run.completed_at ?? undefined;
  } else {
    weeklyPerSport = projectWeeklyPerSport(formula);
    source = 'projection_fallback';
  }

  // Compute per-active-game-day PP per sport. Days when the sport doesn't
  // play contribute 0 — chart shows them as gaps in the stack.
  const perGameDay = new Map<Sport, number>();
  for (const [sport, weekly] of weeklyPerSport) {
    if (!enabledSports.has(sport)) continue;
    const days = SPORT_GAME_DAYS[sport].length;
    if (days === 0) continue;
    perGameDay.set(sport, weekly / days);
  }

  // Step 2 — walk every date in the window. Use UTC midnight so day-of-week
  // is stable across timezones. Window ends today (inclusive).
  const days: DayPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const totalDays = w * 7;
  for (let offset = totalDays - 1; offset >= 0; offset--) {
    const d = new Date(today.getTime() - offset * 86400_000);
    const dow = d.getUTCDay();
    const date = isoDateUTC(d);
    const by_sport: Partial<Record<SportId, number>> = {};
    let roster_avg = 0;
    for (const [sport, perDayPP] of perGameDay) {
      if (!SPORT_GAME_DAYS[sport].includes(dow)) continue;
      // ±15% deterministic jitter — keyed on date+sport so same date always
      // returns same value. Centers around perDayPP.
      const jitter = 0.85 + rngFromSeed(hashStr(`${date}|${sport}`))() * 0.3;
      const contribution = perDayPP * jitter;
      const league = SPORT_TO_LEAGUE[sport];
      const sportId = LEAGUE_TO_SPORT_ID[league];
      by_sport[sportId] = Math.round(contribution * 100) / 100;
      roster_avg += contribution;
    }
    days.push({
      date,
      by_sport,
      roster_avg: Math.round(roster_avg * 100) / 100,
    });
  }

  const payload: ScoringTrendResponse = {
    weeks: w,
    generated_at: new Date().toISOString(),
    source,
    ...(runId ? { source_run_id: runId } : {}),
    ...(runCompletedAt ? { source_run_completed_at: runCompletedAt } : {}),
    enabled_sports: enabledSportIds,
    days,
  };

  cache.set(w, { weeks: w, expiresAt: Date.now() + CACHE_TTL_MS, payload });
  return payload;
}
