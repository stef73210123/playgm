/**
 * runFairnessCheck.ts — CLI driver to run the season simulator end-to-end
 * with the current scoring formula and emit a JSON snapshot of fairness +
 * per-sport contribution metrics.
 *
 * Invoked from the command line (no server required) for pre/post checks
 * of the scoring rebalance:
 *   npx tsx server/src/services/simulation/runFairnessCheck.ts
 *
 * Output: stdout JSON, plus a copy written to the path in OUT_FILE env var
 * if set.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { FORMULA_PATH, type ScoringFormulaFile } from './scoringFormula.js';
import { runSimulation, type League } from './seasonSimulator.js';

/** Load formula directly (bypasses scoringFormula.loadScoringFormula which
 *  uses CJS require() — incompatible with our ESM CLI runner). */
function loadFormulaCli(): ScoringFormulaFile {
  return JSON.parse(readFileSync(FORMULA_PATH, 'utf8')) as ScoringFormulaFile;
}

const leagues: League[] = ['nfl', 'nba', 'mlb', 'nhl'];
const seed = Number(process.env.SEED ?? 42);
const userCount = Number(process.env.USERS ?? 200);
const seasons = Number(process.env.SEASONS ?? 1);
const disableCards = process.env.NO_CARDS === '1';
const disableFA = process.env.NO_FA === '1';

const formula = loadFormulaCli();
if (process.env.NO_MULT === '1') {
  // Strip per_sport_multiplier so we can reproduce the pre-rebalance behavior
  // without reverting the JSON file. Used for before/after comparison.
  for (const s of ['basketball', 'football', 'baseball', 'hockey', 'soccer'] as const) {
    delete (formula.by_sport[s] as { per_sport_multiplier?: number }).per_sport_multiplier;
  }
}
const result = runSimulation({
  leagues,
  seasons,
  formula,
  seed,
  syntheticUserCountOverride: userCount,
  disableCards,
  disableFA,
});

const summary = {
  formula_version: formula.version,
  per_sport_multipliers: {
    basketball: formula.by_sport.basketball.per_sport_multiplier ?? 1,
    football: formula.by_sport.football.per_sport_multiplier ?? 1,
    baseball: formula.by_sport.baseball.per_sport_multiplier ?? 1,
    hockey: formula.by_sport.hockey.per_sport_multiplier ?? 1,
    soccer: formula.by_sport.soccer.per_sport_multiplier ?? 1,
  },
  cfg: result.cfg_summary,
  fairness: {
    user_count: result.fairness.user_count,
    weeks_simulated: result.fairness.weeks_simulated,
    total_mean: round(result.fairness.total_mean),
    total_median: round(result.fairness.total_median),
    total_stddev: round(result.fairness.total_stddev),
    total_top1pct: round(result.fairness.total_top1pct),
    top1_to_median_ratio: round(result.fairness.top1_to_median_ratio),
    rank_stability: round(result.fairness.rank_stability),
    competitive_pct: round(result.fairness.competitive_pct),
    fairness_score: round(result.fairness.fairness_score),
    fa_engagement_pct: round(result.fairness.fa_engagement_pct),
    card_uplift: {
      mean: round(result.fairness.card_uplift_distribution.mean),
      p50: round(result.fairness.card_uplift_distribution.p50),
      p90: round(result.fairness.card_uplift_distribution.p90),
    },
    sport_contributions: result.fairness.sport_contributions.map((s) => ({
      sport: s.sport,
      meanPerRoster: round(s.meanPerRoster),
      top1pct: round(s.top1pct),
    })),
  },
  notes: result.notes,
};

function round(n: number, d = 2): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

const out = JSON.stringify(summary, null, 2);
console.log(out);
if (process.env.OUT_FILE) writeFileSync(process.env.OUT_FILE, out);
