/**
 * seasonSimulator.ts — full-season fairness simulator.
 *
 * Replays N seasons of stat data through:
 *
 *   1. **Weekly redraft** — every week each synthetic user redrafts from
 *      scratch (snake order rotates so user 1 doesn't always pick first).
 *      Per the GDD, rosters lock at week start; mid-week swaps happen via
 *      free-agent pickups only.
 *   2. **Daily free agents** — on the days the active sport is playing,
 *      each user rolls a Bernoulli(p_engage_by_tier). When it fires they
 *      swap their lowest-projected starter for the highest-projected FA
 *      from a 20-deep FA pool. Displaced player goes to bench (max 3).
 *   3. **Cards** — each week the user receives a card hand based on their
 *      sub tier's monthly_pack_allocation pro-rated to weekly + streak
 *      rewards. The 8-Energy budget is spent greedily on highest-expected
 *      uplift, subject to ≤3 Rare per roster, ≤1 Epic per roster, ≤1
 *      Legendary per user per week. Triggers fire with their advertised
 *      `approximate_trigger_rate` (deterministic per [card, player, week]).
 *   4. **Games-per-week scaling** — projected scores multiply the player's
 *      per-game stat bag by the sport's games_per_week. NFL (1/wk) is
 *      naturally lower-volume than MLB (6/wk); the simulator surfaces this
 *      as a per-sport contribution metric so admins can see whether sport
 *      mix is biasing rosters.
 *   5. **Fairness metrics** — stddev across rosters, Spearman rank
 *      stability, top-1% to median ratio, "competitive %" (top-half users
 *      within 25% of leader), card uplift distribution (mean / p50 / p90),
 *      Energy utilization, FA engagement-rate fairness signal.
 *
 * Determinism: a single seed feeds every random choice. Two runs with the
 * same seed + formula + cache produce byte-identical output.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type ScoringFormulaFile,
  type Sport,
  scorePlayerWeek,
  gamesPerWeek,
} from './scoringFormula.js';
import {
  type CardEconomyBundle,
  type SubTier,
  dealWeeklyHand,
  loadCardEconomy,
  planCardPlacements,
} from './cardEngine.js';

// ─── League / sport vocabulary ───────────────────────────────────────────
export type League = 'nba' | 'nfl' | 'mlb' | 'nhl' | 'mls';

export const LEAGUE_TO_SPORT: Record<League, Sport> = {
  nba: 'basketball',
  nfl: 'football',
  mlb: 'baseball',
  nhl: 'hockey',
  mls: 'soccer',
};

const WEEKS_IN_SEASON: Record<League, number> = {
  nfl: 18,
  nba: 26,
  mlb: 26,
  nhl: 26,
  mls: 34,
};

const STAT_CACHE_FILES: Record<League, string> = {
  nfl: 'nfl_season_2025.json',
  nba: 'nba_season_2025-26.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

/** Day-of-week indices (0=Sun..6=Sat) when each sport typically plays. */
const SPORT_GAME_DAYS: Record<Sport, number[]> = {
  basketball: [0, 2, 3, 5, 6], // Sun/Tue/Wed/Fri/Sat
  football: [0, 1, 4], // Sun/Mon/Thu
  baseball: [0, 2, 3, 4, 5, 6], // most days, no Mon
  hockey: [0, 2, 4, 6], // Sun/Tue/Thu/Sat
  soccer: [0, 3, 6], // Sun/Wed/Sat
};

// ─── Project root ────────────────────────────────────────────────────────
function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, '..'),
    path.resolve(cwd, '..', '..'),
    path.resolve(cwd, '..', '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'cards', 'pgm_card_templates.json'))) return c;
  }
  return cwd;
}
const PROJECT_ROOT = findProjectRoot();

// ─── Player / cache types ────────────────────────────────────────────────
export interface CachePlayer {
  external_id: string;
  full_name: string;
  team: string;
  team_abbr: string;
  position: string;
  position_group: string;
  stats: Record<string, number>;
}

interface StatCacheFile {
  league: League;
  season: number | string;
  players: CachePlayer[];
}

export interface LoadedLeague {
  league: League;
  sport: Sport;
  weeks: number;
  players: CachePlayer[];
  hasData: boolean;
  notes: string[];
}

/** Read every requested league's cache from disk. Missing/empty caches are
 * tolerated and surfaced as `hasData: false` + a note. */
export function loadStatCacheForLeagues(leagues: League[]): LoadedLeague[] {
  const out: LoadedLeague[] = [];
  for (const league of leagues) {
    const file = path.join(PROJECT_ROOT, 'assets', 'stat-cache', STAT_CACHE_FILES[league]);
    const sport = LEAGUE_TO_SPORT[league];
    const weeks = WEEKS_IN_SEASON[league];
    if (!existsSync(file)) {
      out.push({
        league,
        sport,
        weeks,
        players: [],
        hasData: false,
        notes: [`cache missing: ${STAT_CACHE_FILES[league]}`],
      });
      continue;
    }
    let parsed: StatCacheFile;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as StatCacheFile;
    } catch (err) {
      out.push({
        league,
        sport,
        weeks,
        players: [],
        hasData: false,
        notes: [`parse error: ${err instanceof Error ? err.message : String(err)}`],
      });
      continue;
    }
    const players = (parsed.players ?? []).filter(
      (p) => p && p.stats && Object.keys(p.stats).length > 0,
    );
    out.push({
      league,
      sport,
      weeks,
      players,
      hasData: players.length > 0,
      notes: players.length === 0 ? ['cache present but 0 players with stats'] : [],
    });
  }
  return out;
}

// ─── Deterministic RNG (mulberry32) ──────────────────────────────────────
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Draft pool ──────────────────────────────────────────────────────────
export interface DraftablePlayer {
  id: string;
  name: string;
  league: League;
  sport: Sport;
  position_group: string;
  /** Projected per-week fantasy score under the formula
   *  (= season_total / weeks_in_season × games_per_week). */
  projectedWeekly: number;
  /** Reference to the player's cache row for weekly scoring. */
  raw: CachePlayer;
}

function projectWeeklyScore(
  player: CachePlayer,
  sport: Sport,
  formula: ScoringFormulaFile,
  weeksInSeason: number,
): number {
  // Per-game stat bag = season totals / games_played, then × games_per_week
  // gives an apples-to-apples weekly projection.
  const games = player.stats['games_played'] ?? weeksInSeason;
  const gpw = gamesPerWeek(sport, formula);
  if (!games || games <= 0) {
    // Fallback: treat season as the per-week projection / weeks
    return (
      scorePlayerWeek(player.stats, sport, formula, {
        positionGroup: player.position_group,
      }) /
      Math.max(1, weeksInSeason)
    );
  }
  const perGameBag: Record<string, number> = {};
  for (const [k, v] of Object.entries(player.stats)) {
    if (k === 'games_played') continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    perGameBag[k] = (v / games) * gpw;
  }
  return scorePlayerWeek(perGameBag, sport, formula, {
    positionGroup: player.position_group,
  });
}

export function buildDraftPool(
  bundles: LoadedLeague[],
  formula: ScoringFormulaFile,
): DraftablePlayer[] {
  const pool: DraftablePlayer[] = [];
  for (const b of bundles) {
    if (!b.hasData) continue;
    for (const p of b.players) {
      pool.push({
        id: `${b.league}:${p.external_id}`,
        name: p.full_name,
        league: b.league,
        sport: b.sport,
        position_group: p.position_group,
        projectedWeekly: projectWeeklyScore(p, b.sport, formula, b.weeks),
        raw: p,
      });
    }
  }
  pool.sort((a, b) => b.projectedWeekly - a.projectedWeekly || a.id.localeCompare(b.id));
  return pool;
}

// ─── Snake draft ─────────────────────────────────────────────────────────
export interface SyntheticRoster {
  userIdx: number;
  picks: DraftablePlayer[];
  bench: DraftablePlayer[];
  picksBySport: Record<Sport, number>;
}

interface DraftConfig {
  rosterSize: number;
  minPicksPerSport: Record<Sport, number>;
  syntheticUserCount: number;
  pickNoiseTopK: number;
}

/** Run a single snake draft round-trip. Pool is consumed in place. */
function snakeDraft(
  pool: DraftablePlayer[],
  cfg: DraftConfig,
  startOffset: number,
  rng: () => number,
): SyntheticRoster[] {
  const { rosterSize, minPicksPerSport, syntheticUserCount, pickNoiseTopK } = cfg;
  const remaining = [...pool];
  const rosters: SyntheticRoster[] = Array.from({ length: syntheticUserCount }, (_, i) => ({
    userIdx: i,
    picks: [],
    bench: [],
    picksBySport: { basketball: 0, football: 0, baseball: 0, hockey: 0, soccer: 0 },
  }));

  for (let pickIdx = 0; pickIdx < rosterSize; pickIdx++) {
    const baseOrder = Array.from({ length: syntheticUserCount }, (_, i) => i);
    const rotated = baseOrder.map((u) => (u + startOffset) % syntheticUserCount);
    const order =
      pickIdx % 2 === 0
        ? rotated
        : rotated.slice().reverse();

    for (const userIdx of order) {
      const roster = rosters[userIdx]!;
      const slotsLeft = rosterSize - roster.picks.length;
      const stillNeeded: Sport[] = [];
      let totalNeeded = 0;
      for (const sport of [
        'basketball',
        'football',
        'baseball',
        'hockey',
        'soccer',
      ] as const) {
        const need = Math.max(0, (minPicksPerSport[sport] ?? 0) - roster.picksBySport[sport]);
        if (need > 0) stillNeeded.push(sport);
        totalNeeded += need;
      }
      const restrictToNeeded = totalNeeded >= slotsLeft && stillNeeded.length > 0;

      const candidates: { idx: number; player: DraftablePlayer }[] = [];
      for (let i = 0; i < remaining.length && candidates.length < pickNoiseTopK; i++) {
        const p = remaining[i];
        if (!p) continue;
        if (restrictToNeeded && !stillNeeded.includes(p.sport)) continue;
        candidates.push({ idx: i, player: p });
      }
      if (candidates.length === 0) {
        for (let i = 0; i < remaining.length && candidates.length < pickNoiseTopK; i++) {
          candidates.push({ idx: i, player: remaining[i]! });
        }
      }
      if (candidates.length === 0) continue;
      const choice = candidates[Math.floor(rng() * candidates.length)]!;
      remaining.splice(choice.idx, 1);
      roster.picks.push(choice.player);
      roster.picksBySport[choice.player.sport]++;
    }
  }

  return rosters;
}

// ─── Weekly stat bag (deterministic jitter) ─────────────────────────────
function weeklyStatBag(
  player: DraftablePlayer,
  weekIdx: number,
  weeksInSeason: number,
  seed: number,
  formula: ScoringFormulaFile,
): Record<string, number> {
  const gpw = gamesPerWeek(player.sport, formula);
  const games = player.raw.stats['games_played'] ?? weeksInSeason;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(player.raw.stats)) {
    if (k === 'games_played') continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const jitter =
      0.5 + makeRng(hashStr(`${player.id}|${k}|w${weekIdx}|${seed}`))();
    const perGame = games > 0 ? v / games : v / weeksInSeason;
    out[k] = perGame * gpw * jitter;
  }
  return out;
}

// ─── Per-user state during the season ───────────────────────────────────
interface UserState {
  userIdx: number;
  tier: SubTier;
  faPickups: number;
  faImproved: boolean;
  totalEnergyAvailable: number;
  totalEnergySpent: number;
  cardUplift: number; // total fantasy points added by cards (cumulative)
}

function pickTierFromMix(
  mix: Record<string, number>,
  rng: () => number,
): SubTier {
  const order: SubTier[] = ['free', 'starter', 'playmaker', 'champion'];
  let acc = 0;
  const cum: number[] = [];
  for (const t of order) {
    acc += mix[t] ?? 0;
    cum.push(acc);
  }
  if (acc <= 0) return 'free';
  const r = rng() * acc;
  for (let i = 0; i < cum.length; i++) {
    if (r < cum[i]!) return order[i]!;
  }
  return order[order.length - 1]!;
}

// ─── Top-level orchestrator ──────────────────────────────────────────────
export interface SimulationConfig {
  leagues: League[];
  seasons: number;
  formula: ScoringFormulaFile;
  seed: number;
  syntheticUserCountOverride?: number;
  /** Disable card application — useful for tests + isolated fairness checks. */
  disableCards?: boolean;
  /** Disable daily FA pickups — useful for tests + isolated fairness checks. */
  disableFA?: boolean;
  onProgress?: (frac: number, note?: string) => void;
}

export interface SportContribution {
  sport: Sport;
  meanPerRoster: number;
  top1pct: number;
}

export interface FairnessReport {
  user_count: number;
  weeks_simulated: number;
  weekly_stddev_mean: number;
  total_stddev: number;
  total_mean: number;
  total_median: number;
  total_top1pct: number;
  top1_to_median_ratio: number;
  rank_stability: number;
  competitive_pct: number;
  fairness_score: number;
  sport_contributions: SportContribution[];
  /** Histogram bin counts (16 equal-width bins). */
  histogram: { min: number; max: number; bins: number[] };
  /** Card uplift across rosters (additional fantasy points from cards). */
  card_uplift_distribution: { mean: number; p50: number; p90: number; bins: number[]; min: number; max: number };
  /** Energy utilization (spent / available) per roster. */
  energy_utilization: { mean: number; p50: number; p90: number };
  /** % of users who made at least one FA pickup that improved their score. */
  fa_engagement_pct: number;
  suggested_adjustments: string[];
}

export interface SimulationResult {
  cfg_summary: {
    leagues: League[];
    seasons: number;
    seed: number;
    user_count: number;
    roster_size: number;
    min_picks_per_sport: Record<Sport, number>;
    formula_version: string;
    cards_enabled: boolean;
    fa_enabled: boolean;
  };
  fairness: FairnessReport;
  per_season_fairness: FairnessReport[];
  notes: string[];
  sample_top_rosters: { user_idx: number; tier: SubTier; total: number; sports: Record<Sport, number> }[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
function stddev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx]!;
}
function histogramBins(xs: number[], bins: number): { min: number; max: number; bins: number[] } {
  const min = xs.length > 0 ? Math.min(...xs) : 0;
  const max = xs.length > 0 ? Math.max(...xs) : 0;
  const out = new Array<number>(bins).fill(0);
  if (max > min) {
    for (const x of xs) {
      const i = Math.min(bins - 1, Math.floor(((x - min) / (max - min)) * bins));
      out[i]!++;
    }
  } else {
    out[0] = xs.length;
  }
  return { min, max, bins: out };
}
export function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return 0;
  const rank = (xs: number[]): number[] => {
    const idx = xs.map((v, i) => ({ v, i }));
    idx.sort((x, y) => x.v - y.v);
    const out = new Array<number>(xs.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j < idx.length - 1 && idx[j + 1]!.v === idx[i]!.v) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k]!.i] = avg;
      i = j + 1;
    }
    return out;
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    const xa = ra[i]! - ma;
    const xb = rb[i]! - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

function suggestedAdjustments(
  contribs: SportContribution[],
  formula: ScoringFormulaFile,
  metrics: { top1_to_median_ratio: number; rank_stability: number; competitive_pct: number },
): string[] {
  const out: string[] = [];
  if (metrics.top1_to_median_ratio >= 10) {
    out.push(
      `Top-1% to median ratio is ${metrics.top1_to_median_ratio.toFixed(1)}× (target ~5×). The system rewards a tiny set of users far more than the rest — consider trimming dominant stat weights by 30–40%.`,
    );
  }
  if (metrics.rank_stability < 0.3) {
    out.push(
      `Week-to-week rank stability is ${metrics.rank_stability.toFixed(2)} (target >0.5). Scoring is chaotic — increase the weight of consistent-performer stats relative to volatile ones.`,
    );
  }
  if (metrics.competitive_pct < 30) {
    out.push(
      `Only ${metrics.competitive_pct.toFixed(0)}% of users stay within 25% of the leader. Either compress top-end weights or raise min_picks_per_sport so rosters can't concentrate.`,
    );
  }
  const flagDominant = (
    sport: Sport,
    weights: Record<string, number>,
    topPct: number,
  ): void => {
    if (topPct === 0) return;
    const sorted = Object.entries(weights).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (sorted.length < 2) return;
    const top = sorted[0]!;
    const next = sorted[1]!;
    if (Math.abs(top[1]) >= 2.5 * Math.abs(next[1]) && Math.abs(top[1]) > 1.5) {
      out.push(
        `${sport[0]!.toUpperCase()}${sport.slice(1)}'s "${top[0]}" weight (${top[1]}) is ${(Math.abs(top[1]) / Math.abs(next[1])).toFixed(1)}× the next stat — consider lowering to ~${(Math.abs(next[1]) * 1.6).toFixed(2)}.`,
      );
    }
  };
  flagDominant('basketball', formula.by_sport.basketball.weights, contribs.find((c) => c.sport === 'basketball')?.top1pct ?? 0);
  flagDominant('football', formula.by_sport.football.weights, contribs.find((c) => c.sport === 'football')?.top1pct ?? 0);
  flagDominant('baseball', formula.by_sport.baseball.hitter_weights, contribs.find((c) => c.sport === 'baseball')?.top1pct ?? 0);
  flagDominant('hockey', formula.by_sport.hockey.skater_weights, contribs.find((c) => c.sport === 'hockey')?.top1pct ?? 0);
  flagDominant('soccer', formula.by_sport.soccer.weights, contribs.find((c) => c.sport === 'soccer')?.top1pct ?? 0);
  if (out.length === 0) {
    out.push('All metrics within target bands — no adjustment necessary.');
  }
  return out;
}

// ─── Main: runSimulation ─────────────────────────────────────────────────
export function runSimulation(cfg: SimulationConfig): SimulationResult {
  const notes: string[] = [];
  const userCount =
    cfg.syntheticUserCountOverride ?? cfg.formula.global.synthetic_user_count;
  const rosterSize = cfg.formula.global.roster_size;
  const minPicks = { ...cfg.formula.global.min_picks_per_sport };
  const energyBudget = cfg.formula.global.weekly_energy_budget ?? 8;
  const rarityCaps = {
    rarePerRoster: cfg.formula.global.rarity_caps?.rare_per_roster ?? 3,
    epicPerRoster: cfg.formula.global.rarity_caps?.epic_per_roster ?? 1,
    legendaryPerWeek: cfg.formula.global.rarity_caps?.legendary_per_user_per_week ?? 1,
  };
  const tierMix = cfg.formula.global.subscription_tier_mix ?? {
    free: 0.7,
    starter: 0.15,
    playmaker: 0.1,
    champion: 0.05,
  };
  const faEngageByTier = cfg.formula.global.fa_engagement_by_tier ?? {
    free: 0.3,
    starter: 0.5,
    playmaker: 0.7,
    champion: 0.85,
  };
  const faPoolSize = cfg.formula.global.fa_pool_size ?? 20;
  const maxBench = cfg.formula.global.max_bench_size ?? 3;

  cfg.onProgress?.(0.05, 'loading caches');
  const bundles = loadStatCacheForLeagues(cfg.leagues);
  for (const b of bundles) {
    if (!b.hasData) notes.push(`league ${b.league}: no usable data — ${b.notes.join(', ')}`);
  }
  const usable = bundles.filter((b) => b.hasData);
  if (usable.length === 0) throw new Error('no leagues with usable stat data');

  for (const b of bundles) {
    if (!b.hasData && (minPicks[b.sport] ?? 0) > 0) {
      notes.push(
        `${b.sport} has no data — relaxing min_picks_per_sport.${b.sport} from ${minPicks[b.sport]} to 0`,
      );
      minPicks[b.sport] = 0;
    }
  }

  cfg.onProgress?.(0.1, 'building draft pool');
  const fullPool = buildDraftPool(usable, cfg.formula);

  cfg.onProgress?.(0.15, 'loading card economy');
  const cardEconomy: CardEconomyBundle | null = cfg.disableCards ? null : loadCardEconomy();

  // Pre-roll user tiers (one-time) so the same user keeps the same tier across weeks.
  const tierRng = makeRng(cfg.seed ^ 0xa5a5a5a5);
  const userTiers: SubTier[] = Array.from({ length: userCount }, () =>
    pickTierFromMix(tierMix, tierRng),
  );

  // The simulated season uses the max weeks across leagues.
  let maxWeeks = 0;
  for (const b of usable) maxWeeks = Math.max(maxWeeks, b.weeks);
  if (maxWeeks === 0) maxWeeks = 18;

  // Per-season aggregation
  const perSeason: { weekly: number[][]; cumulative: number[][]; totals: number[]; userStates: UserState[] }[] = [];

  for (let s = 0; s < cfg.seasons; s++) {
    cfg.onProgress?.(0.2 + (s / cfg.seasons) * 0.7, `season ${s + 1}/${cfg.seasons}`);
    const seasonSeed = cfg.seed ^ (s * 0x9e3779b1);

    const userStates: UserState[] = userTiers.map((tier, i) => ({
      userIdx: i,
      tier,
      faPickups: 0,
      faImproved: false,
      totalEnergyAvailable: 0,
      totalEnergySpent: 0,
      cardUplift: 0,
    }));

    const weekly: number[][] = Array.from({ length: userCount }, () =>
      new Array<number>(maxWeeks).fill(0),
    );

    for (let w = 0; w < maxWeeks; w++) {
      // ── Weekly redraft (snake order rotates by week) ──────────────────
      const draftRng = makeRng(seasonSeed ^ (w * 0x12345 + 1));
      const rosters = snakeDraft(
        fullPool,
        {
          rosterSize,
          minPicksPerSport: minPicks,
          syntheticUserCount: userCount,
          pickNoiseTopK: 3,
        },
        w % userCount,
        draftRng,
      );

      // ── Daily FA pickups ──────────────────────────────────────────────
      // Track which players are on every roster so the FA pool excludes
      // them. Set keyed on player.id.
      if (!cfg.disableFA) {
        const onRoster = new Set<string>();
        for (const r of rosters) {
          for (const p of r.picks) onRoster.add(p.id);
          for (const p of r.bench) onRoster.add(p.id);
        }
        // Game days the active sport(s) play. Use union across leagues.
        const activeDays = new Set<number>();
        for (const b of usable)
          for (const d of SPORT_GAME_DAYS[b.sport]) activeDays.add(d);

        for (const day of activeDays) {
          const faRng = makeRng(seasonSeed ^ (w * 0x7ab + day * 0x13));
          for (let u = 0; u < userCount; u++) {
            const state = userStates[u]!;
            const p_engage = faEngageByTier[state.tier] ?? 0.3;
            if (faRng() >= p_engage) continue;
            const roster = rosters[u]!;
            // Pick the lowest-projected starter to drop:
            roster.picks.sort((a, b) => a.projectedWeekly - b.projectedWeekly);
            const drop = roster.picks[0];
            if (!drop) continue;
            // FA pool: top-N of fullPool not on any roster, sport-restricted to drop's sport.
            const pool: DraftablePlayer[] = [];
            for (const p of fullPool) {
              if (pool.length >= faPoolSize) break;
              if (onRoster.has(p.id)) continue;
              if (p.sport !== drop.sport) continue;
              pool.push(p);
            }
            if (pool.length === 0) continue;
            const candidate = pool[0]!;
            if (candidate.projectedWeekly <= drop.projectedWeekly) continue; // never strictly worse
            // Swap
            roster.picks.shift(); // remove drop (it's at index 0 after sort asc)
            roster.picks.push(candidate);
            onRoster.add(candidate.id);
            onRoster.delete(drop.id);
            if (roster.bench.length < maxBench) roster.bench.push(drop);
            state.faPickups++;
            state.faImproved = true;
          }
        }
      }

      // ── Weekly card hand + placements ────────────────────────────────
      const placementsByUser: ReturnType<typeof planCardPlacements>[] = [];
      if (!cfg.disableCards && cardEconomy) {
        for (let u = 0; u < userCount; u++) {
          const state = userStates[u]!;
          const handRng = makeRng(seasonSeed ^ (w * 0xdead + u * 0xbeef));
          const hand = dealWeeklyHand(cardEconomy, state.tier, cfg.formula, handRng);
          const slotScores = rosters[u]!.picks.map((p) => p.projectedWeekly);
          const placements = planCardPlacements(
            hand,
            slotScores,
            cardEconomy.triggerRateById,
            { energyBudget, rarityCaps },
          );
          placementsByUser.push(placements);
          state.totalEnergyAvailable += energyBudget;
          for (const pl of placements) state.totalEnergySpent += pl.card.template.energy_cost;
        }
      }

      // ── Score the week ───────────────────────────────────────────────
      for (let u = 0; u < userCount; u++) {
        const roster = rosters[u]!;
        const placements = placementsByUser[u] ?? [];
        let weekScore = 0;
        for (let slot = 0; slot < roster.picks.length; slot++) {
          const player = roster.picks[slot]!;
          const bundle = usable.find((b) => b.league === player.league)!;
          const localWeek = w % bundle.weeks;
          const bag = weeklyStatBag(player, localWeek, bundle.weeks, seasonSeed, cfg.formula);
          const baseScore = scorePlayerWeek(bag, player.sport, cfg.formula, {
            positionGroup: player.position_group,
          });
          // Apply cards
          let multiplier = 1;
          for (const pl of placements) {
            if (pl.rosterSlot !== slot) continue;
            // Trigger fires deterministically per (card, player, week)
            const fireRng = makeRng(
              hashStr(`${pl.card.template.template_id}|${player.id}|w${w}|s${seasonSeed}`),
            );
            if (fireRng() < pl.triggerRate) {
              multiplier += pl.card.uplift;
              const state = userStates[u]!;
              state.cardUplift += baseScore * pl.card.uplift;
            }
          }
          weekScore += baseScore * multiplier;
        }
        weekly[u]![w] = weekScore;
      }
    }

    const cumulative: number[][] = weekly.map((wk) => {
      let acc = 0;
      return wk.map((v) => (acc += v));
    });
    const totals = cumulative.map((c) => c[c.length - 1] ?? 0);
    perSeason.push({ weekly, cumulative, totals, userStates });
  }

  // Aggregate across seasons
  const aggWeekly: number[][] = Array.from({ length: userCount }, () =>
    new Array<number>(maxWeeks).fill(0),
  );
  for (const s of perSeason) {
    for (let u = 0; u < userCount; u++) {
      for (let w = 0; w < maxWeeks; w++) {
        aggWeekly[u]![w]! += s.weekly[u]?.[w] ?? 0;
      }
    }
  }
  const aggCumulative: number[][] = aggWeekly.map((wk) => {
    let acc = 0;
    return wk.map((v) => (acc += v));
  });
  const aggTotals = aggCumulative.map((c) => c[c.length - 1] ?? 0);

  cfg.onProgress?.(0.95, 'computing fairness');
  const fairness = computeFairness(
    aggWeekly,
    aggCumulative,
    aggTotals,
    perSeason.flatMap((s) => s.userStates),
    perSeason.length,
    cfg.formula,
    fullPool,
  );
  const perSeasonFairness = perSeason.map((s) =>
    computeFairness(s.weekly, s.cumulative, s.totals, s.userStates, 1, cfg.formula, fullPool),
  );

  // Sample top rosters
  const indexed = aggTotals.map((t, i) => ({ i, t }));
  indexed.sort((a, b) => b.t - a.t);
  const sample_top_rosters = indexed.slice(0, 10).map(({ i, t }) => {
    const bag: Record<Sport, number> = {
      basketball: 0,
      football: 0,
      baseball: 0,
      hockey: 0,
      soccer: 0,
    };
    // Approximate per-sport contribution to total via a representative
    // re-draft (cheap re-run with same seed produces stable results).
    const r = snakeDraft(
      fullPool,
      {
        rosterSize,
        minPicksPerSport: minPicks,
        syntheticUserCount: userCount,
        pickNoiseTopK: 3,
      },
      0,
      makeRng(cfg.seed),
    )[i];
    if (r) for (const p of r.picks) bag[p.sport] += p.projectedWeekly;
    return { user_idx: i, tier: userTiers[i] ?? 'free', total: t, sports: bag };
  });

  cfg.onProgress?.(1, 'done');

  return {
    cfg_summary: {
      leagues: cfg.leagues,
      seasons: cfg.seasons,
      seed: cfg.seed,
      user_count: userCount,
      roster_size: rosterSize,
      min_picks_per_sport: minPicks,
      formula_version: cfg.formula.version,
      cards_enabled: !cfg.disableCards,
      fa_enabled: !cfg.disableFA,
    },
    fairness,
    per_season_fairness: perSeasonFairness,
    notes,
    sample_top_rosters,
  };
}

// ─── Fairness aggregation (extracted) ───────────────────────────────────
function computeFairness(
  weekly: number[][],
  cumulative: number[][],
  totals: number[],
  userStates: UserState[],
  seasons: number,
  formula: ScoringFormulaFile,
  fullPool: DraftablePlayer[],
): FairnessReport {
  const userCount = totals.length;
  const weeks = weekly[0]?.length ?? 0;

  const weeklyStddevs: number[] = [];
  for (let w = 0; w < weeks; w++) {
    const col = weekly.map((row) => row[w] ?? 0);
    weeklyStddevs.push(stddev(col));
  }
  const weekly_stddev_mean = mean(weeklyStddevs);

  const total_stddev = stddev(totals);
  const total_mean = mean(totals);
  const total_median = percentile(totals, 0.5);
  const total_top1pct = percentile(totals, 0.99);
  const top1_to_median_ratio = total_median > 0 ? total_top1pct / total_median : 0;

  const rankCorrs: number[] = [];
  for (let w = 1; w < weeks; w++) {
    const a = cumulative.map((row) => row[w - 1] ?? 0);
    const b = cumulative.map((row) => row[w] ?? 0);
    rankCorrs.push(spearman(a, b));
  }
  const rank_stability = mean(rankCorrs);

  const sortedTotals = [...totals].sort((a, b) => b - a);
  const leader = sortedTotals[0] ?? 0;
  const median = total_median;
  const threshold = leader * 0.75;
  const topHalfCount = Math.max(1, Math.floor(userCount / 2));
  const inTopHalfAndCompetitive = totals.filter((t) => t >= median && t >= threshold).length;
  const competitive_pct = userCount > 0 ? (inTopHalfAndCompetitive / topHalfCount) * 100 : 0;

  const histogram = histogramBins(totals, 16);

  // Card uplift distribution (per roster, summed across seasons)
  const upliftPerUser: number[] = new Array<number>(userCount).fill(0);
  // userStates concat per-user across seasons; sum into userIdx slot
  for (const u of userStates) upliftPerUser[u.userIdx]! += u.cardUplift;
  const upliftHist = histogramBins(upliftPerUser, 16);
  const card_uplift_distribution = {
    mean: mean(upliftPerUser),
    p50: percentile(upliftPerUser, 0.5),
    p90: percentile(upliftPerUser, 0.9),
    bins: upliftHist.bins,
    min: upliftHist.min,
    max: upliftHist.max,
  };

  // Energy utilization: spent / available, summed across seasons per user.
  const utilPerUser: number[] = new Array<number>(userCount).fill(0);
  const availPerUser: number[] = new Array<number>(userCount).fill(0);
  for (const u of userStates) {
    utilPerUser[u.userIdx]! += u.totalEnergySpent;
    availPerUser[u.userIdx]! += u.totalEnergyAvailable;
  }
  const utilFraction = utilPerUser.map((v, i) =>
    availPerUser[i]! > 0 ? v / availPerUser[i]! : 0,
  );
  const energy_utilization = {
    mean: mean(utilFraction),
    p50: percentile(utilFraction, 0.5),
    p90: percentile(utilFraction, 0.9),
  };

  // FA engagement %: users with ≥1 successful pickup, in any season
  const improvedPerUser: boolean[] = new Array<boolean>(userCount).fill(false);
  for (const u of userStates) if (u.faImproved) improvedPerUser[u.userIdx] = true;
  const fa_engagement_pct =
    userCount > 0 ? (improvedPerUser.filter(Boolean).length / userCount) * 100 : 0;

  // Per-sport contributions (approx via fullPool projections of a representative draft)
  const sport_contributions: SportContribution[] = (
    ['basketball', 'football', 'baseball', 'hockey', 'soccer'] as const
  ).map((sport) => {
    const inPool = fullPool.filter((p) => p.sport === sport);
    const top = inPool.slice(0, Math.min(50, inPool.length)).map((p) => p.projectedWeekly);
    return { sport, meanPerRoster: mean(top), top1pct: percentile(top, 0.99) };
  });

  void seasons;

  // Composite fairness
  const ratioScore = Math.max(0, 100 - Math.max(0, top1_to_median_ratio - 5) * 10);
  const stabScore = Math.max(0, Math.min(1, rank_stability)) * 100;
  const compScore = Math.min(100, Math.max(0, competitive_pct));
  const fairness_score = 0.4 * ratioScore + 0.3 * stabScore + 0.3 * compScore;

  const suggested = suggestedAdjustments(sport_contributions, formula, {
    top1_to_median_ratio,
    rank_stability,
    competitive_pct,
  });

  return {
    user_count: userCount,
    weeks_simulated: weeks,
    weekly_stddev_mean,
    total_stddev,
    total_mean,
    total_median,
    total_top1pct,
    top1_to_median_ratio,
    rank_stability,
    competitive_pct,
    fairness_score,
    sport_contributions,
    histogram,
    card_uplift_distribution,
    energy_utilization,
    fa_engagement_pct,
    suggested_adjustments: suggested,
  };
}
