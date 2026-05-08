/**
 * scoutLLM.ts — Scout LLM provider dispatcher.
 *
 * 2026-05-08 — migrated default backend from Anthropic Haiku 4.5 to Gemini
 * Flash (see docs/ask-scout-gemini-migration.md).
 *
 * Selection precedence (first match wins):
 *   1. process.env.SCOUT_LLM_PROVIDER — `gemini` | `anthropic`
 *   2. data/system/data_provider_config.json#scout_llm_provider
 *   3. Default: `gemini`
 *
 * Both backends export the same surface:
 *   - askScoutLLM(question, context?, ageBand?)
 *   - getScoutTake(entityName, factualContext)
 *   - getScoutLLMStats()
 *   - cleanScoutTake(raw)
 *   - SCOUT_SYSTEM_PROMPT
 *
 * Switch providers at runtime by changing the env var and restarting the
 * server — no code change. The non-default backend stays compiled in so a
 * revert is one variable away.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as gemini from './scoutLLMGemini.js';
import * as anthropic from './scoutLLMAnthropic.js';

type ProviderId = 'gemini' | 'anthropic';

function resolveProvider(): ProviderId {
  const envChoice = (process.env['SCOUT_LLM_PROVIDER'] ?? '').toLowerCase();
  if (envChoice === 'gemini' || envChoice === 'anthropic') return envChoice;

  // Optional config file — same lookup pattern as the Anthropic backend's
  // REPO_ROOT walker so it works whether the server is run from
  // server/ or repo root.
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    const fp = path.join(cur, 'data', 'system', 'data_provider_config.json');
    if (existsSync(fp)) {
      try {
        const cfg = JSON.parse(readFileSync(fp, 'utf-8')) as { scout_llm_provider?: string };
        const c = (cfg.scout_llm_provider ?? '').toLowerCase();
        if (c === 'gemini' || c === 'anthropic') return c;
      } catch {
        // Ignore malformed config — fall through to default.
      }
      break;
    }
    cur = path.resolve(cur, '..');
  }

  return 'gemini';
}

const PROVIDER: ProviderId = resolveProvider();
const impl = PROVIDER === 'anthropic' ? anthropic : gemini;

// Re-export the SCOUT_SYSTEM_PROMPT constant of the active backend so
// downstream consumers (tests, debug panels) keep working.
export const SCOUT_SYSTEM_PROMPT = impl.SCOUT_SYSTEM_PROMPT;

/**
 * Ask Scout — kid Q&A. Wired to POST /scout/ask.
 *
 * The Anthropic backend ignores the optional `ageBand` argument; Gemini
 * uses it to harden the prompt for 5-7 year olds. Existing call sites
 * that pass two arguments (question, context) keep working unchanged.
 */
export async function askScoutLLM(
  question: string,
  context?: string,
  ageBand?: gemini.AgeBand,
): Promise<string> {
  if (PROVIDER === 'anthropic') {
    return anthropic.askScoutLLM(question, context);
  }
  return gemini.askScoutLLM(question, context, ageBand);
}

/** Generate a Scout's Take — short narrative blurb for the Scouting Report. */
export async function getScoutTake(entityName: string, factualContext: string): Promise<string> {
  return impl.getScoutTake(entityName, factualContext);
}

/** Strip the prefixes/markdown the model occasionally adds despite the
 *  system prompt forbidding them. Idempotent. */
export function cleanScoutTake(raw: string): string {
  return impl.cleanScoutTake(raw);
}

export function getScoutLLMStats() {
  return impl.getScoutLLMStats();
}

/** Read-only — exposed for `/admin/diagnostics` style probes. */
export function getActiveScoutProvider(): ProviderId {
  return PROVIDER;
}
