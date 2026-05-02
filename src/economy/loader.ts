/**
 * Server-side JSON loader for economy / card data files.
 *
 * Reads the canonical JSON specs at module-load time via `fs.readFileSync`.
 * The spec files live at `<repo-root>/data/...`, which is outside the
 * server's TypeScript rootDir, so we go through `fs` rather than a static
 * import to keep the build configuration boring.
 *
 * Each export is a function that returns the parsed `unknown` JSON. The
 * mirror modules (`progression.ts`, `earnRates.ts`, …) cast/validate the
 * result in their own `buildXxx(spec)` helpers — same pattern as the
 * client. Tests should call those builders with hand-rolled fixtures
 * directly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve `here` in a way that works under both ESM (production) and CJS
// (jest with babel-jest, where `import.meta` is unavailable). We walk up
// from `process.cwd()` as a fallback since the production process is
// always launched from the repo root or `server/`.
function resolveHere(): string {
  // ESM path — import.meta.url present.
  try {
    // Dynamic Function() avoids the parser tripping on import.meta in CJS.
    const u = (Function('return import.meta.url')() as string | undefined) ?? null;
    if (u) return dirname(fileURLToPath(u));
  } catch {
    /* fallthrough */
  }
  // CJS / babel test path — __dirname is provided by Node's module wrapper.
  if (typeof __dirname === 'string') return __dirname;
  return process.cwd();
}

// Sources: <root>/server/src/economy/loader.ts → 3 ups for <root>.
// Compiled: <root>/server/dist/src/economy/loader.js → 4 ups for <root>.
// The dev path is tsx (no compile) so we resolve dynamically: walk up
// until we land on a directory that contains `data/economy`.
function findDataRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(resolve(cur, 'data', 'economy', 'pgm_progression.json'), 'utf8');
      return resolve(cur, 'data');
    } catch {
      cur = resolve(cur, '..');
    }
  }
  throw new Error(`server/economy/loader: could not locate <root>/data starting from ${start}`);
}
const DATA_ROOT = findDataRoot(resolveHere());

function read(rel: string): unknown {
  const buf = readFileSync(resolve(DATA_ROOT, rel), 'utf8');
  return JSON.parse(buf);
}

export const loadProgressionSpec = (): unknown => read('economy/pgm_progression.json');
export const loadEarnRatesSpec = (): unknown => read('economy/pgm_pp_earn_rates.json');
export const loadSubscriptionsSpec = (): unknown => read('economy/pgm_subscriptions.json');
export const loadStreakRewardsSpec = (): unknown => read('economy/pgm_streak_rewards.json');
export const loadCardTemplatesSpec = (): unknown => read('cards/pgm_card_templates.json');
export const loadTriggersSpec = (): unknown => read('cards/pgm_triggers.json');
export const loadStatResolutionSpec = (): unknown => read('cards/pgm_stat_resolution.json');
export const loadPacksSpec = (): unknown => read('cards/pgm_packs.json');
export const loadPityTimersSpec = (): unknown => read('cards/pgm_pity_timers.json');
export const loadTradeRulesSpec = (): unknown => read('economy/pgm_trade_rules.json');
export const loadScanGradeRaritySpec = (): unknown => read('cards/scan_grade_to_rarity.json');
