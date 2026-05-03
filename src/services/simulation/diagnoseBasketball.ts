/**
 * diagnoseBasketball.ts — per-sport projection percentile diagnostic.
 *
 * Mirrors the projection model used by buildDraftPool() (per-game stats ×
 * games_per_week × per_sport_multiplier) and emits per-sport percentiles
 * (P50, P75, P90, P95, P99). Also reports per-game-day projections so the
 * cross-sport game-day-parity check can be re-run.
 *
 * Use this when Stefan flags that a sport feels "high" — the simulator's
 * `sport_contributions` only emits mean + top1pct on the top-50, which
 * obscures where the upper-tier amplification really sits.
 *
 *   npx tsx server/src/services/simulation/diagnoseBasketball.ts
 *
 * Optional env: TOP_FRAC=0.30 (draftable cut), OUT_FILE=/path/to/json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  FORMULA_PATH,
  type ScoringFormulaFile,
  scorePlayerWeek,
  gamesPerWeek,
  type Sport,
} from './scoringFormula.js';
import {
  loadStatCacheForLeagues,
  type League,
  type CachePlayer,
  type LoadedLeague,
} from './seasonSimulator.js';

function pct(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx]!;
}
const round = (n: number, d = 2): number => {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

function projectPerGameDay(
  player: CachePlayer,
  sport: Sport,
  formula: ScoringFormulaFile,
  weeksInSeason: number,
): number {
  // Per-game-day = per-game (no × games_per_week multiplier). This is the
  // metric Stefan tunes against — a single game-day's pay for the player
  // filling a roster slot.
  const games = player.stats['games_played'] ?? weeksInSeason;
  if (!games || games <= 0) {
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
    perGameBag[k] = v / games;
  }
  return scorePlayerWeek(perGameBag, sport, formula, {
    positionGroup: player.position_group,
  });
}

function projectWeekly(
  player: CachePlayer,
  sport: Sport,
  formula: ScoringFormulaFile,
  weeksInSeason: number,
): number {
  const perGame = projectPerGameDay(player, sport, formula, weeksInSeason);
  return perGame * gamesPerWeek(sport, formula);
}

function loadFormulaCli(): ScoringFormulaFile {
  return JSON.parse(readFileSync(FORMULA_PATH, 'utf8')) as ScoringFormulaFile;
}

const leagues: League[] = ['nfl', 'nba', 'mlb', 'nhl'];
const formula = loadFormulaCli();
const TOP_FRAC = Number(process.env.TOP_FRAC ?? 0.30);

const bundles: LoadedLeague[] = loadStatCacheForLeagues(leagues);

const perSport: Array<{
  league: League;
  sport: Sport;
  n_total: number;
  n_draftable: number;
  per_game_day: { P50: number; P75: number; P90: number; P95: number; P99: number; max: number };
  per_week: { P50: number; P75: number; P90: number; P95: number; P99: number; max: number };
  per_week_top50_mean: number;
  per_week_top50_top1pct: number;
}> = [];

for (const b of bundles) {
  if (!b.hasData) continue;
  const allPerGame = b.players.map((p) => projectPerGameDay(p, b.sport, formula, b.weeks));
  const allPerWeek = b.players.map((p) => projectWeekly(p, b.sport, formula, b.weeks));
  // "Draftable" = top TOP_FRAC of the pool by per-week projection.
  const draftableCount = Math.max(1, Math.floor(allPerWeek.length * TOP_FRAC));
  const sortedIdx = allPerWeek
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .slice(0, draftableCount)
    .map((x) => x.i);
  const draftablePerGame = sortedIdx.map((i) => allPerGame[i]!);
  const draftablePerWeek = sortedIdx.map((i) => allPerWeek[i]!);
  const top50 = [...allPerWeek].sort((a, b) => b - a).slice(0, Math.min(50, allPerWeek.length));
  perSport.push({
    league: b.league,
    sport: b.sport,
    n_total: b.players.length,
    n_draftable: draftableCount,
    per_game_day: {
      P50: round(pct(draftablePerGame, 0.5)),
      P75: round(pct(draftablePerGame, 0.75)),
      P90: round(pct(draftablePerGame, 0.9)),
      P95: round(pct(draftablePerGame, 0.95)),
      P99: round(pct(draftablePerGame, 0.99)),
      max: round(Math.max(...draftablePerGame)),
    },
    per_week: {
      P50: round(pct(draftablePerWeek, 0.5)),
      P75: round(pct(draftablePerWeek, 0.75)),
      P90: round(pct(draftablePerWeek, 0.9)),
      P95: round(pct(draftablePerWeek, 0.95)),
      P99: round(pct(draftablePerWeek, 0.99)),
      max: round(Math.max(...draftablePerWeek)),
    },
    per_week_top50_mean:
      top50.length > 0 ? round(top50.reduce((a, b) => a + b, 0) / top50.length) : 0,
    per_week_top50_top1pct: round(pct(top50, 0.99)),
  });
}

// Per-sport weekly slot exposure: how often each sport shows up on a daily
// roster slot over a week. Approximation: gamesPerWeek (NBA 3.5, MLB 6,
// NHL 3.5, NFL 1.0) — the kid's slot is "exposed" to a sport's events in
// proportion to gpw, weighted by how many sport-eligible players the
// kid drafted (approximated here as 1 — i.e. one slot of each sport).
const weekly_slot_exposure: Record<string, number> = {
  basketball: gamesPerWeek('basketball', formula),
  football: gamesPerWeek('football', formula),
  baseball: gamesPerWeek('baseball', formula),
  hockey: gamesPerWeek('hockey', formula),
  soccer: gamesPerWeek('soccer', formula),
};

// Total PP per week per single roster slot, by sport — multiplies the
// median per-game-day pay by gamesPerWeek so we see what a slot
// contributes over a typical kid's week.
const weekly_total_per_slot_at_P50 = perSport.map((s) => ({
  league: s.league,
  sport: s.sport,
  P50_per_game_day: s.per_game_day.P50,
  games_per_week: weekly_slot_exposure[s.sport]!,
  weekly_total_at_P50: round(s.per_game_day.P50 * weekly_slot_exposure[s.sport]!),
  weekly_total_at_P95: round(s.per_game_day.P95 * weekly_slot_exposure[s.sport]!),
  weekly_total_at_P99: round(s.per_game_day.P99 * weekly_slot_exposure[s.sport]!),
}));

const summary = {
  formula_version: formula.version,
  multipliers: {
    basketball: formula.by_sport.basketball.per_sport_multiplier ?? 1,
    football: formula.by_sport.football.per_sport_multiplier ?? 1,
    baseball: formula.by_sport.baseball.per_sport_multiplier ?? 1,
    hockey: formula.by_sport.hockey.per_sport_multiplier ?? 1,
    soccer: formula.by_sport.soccer.per_sport_multiplier ?? 1,
  },
  per_sport: perSport,
  weekly_slot_exposure,
  weekly_total_per_slot_at_P50,
};

const out = JSON.stringify(summary, null, 2);
console.log(out);
if (process.env.OUT_FILE) writeFileSync(process.env.OUT_FILE, out);
