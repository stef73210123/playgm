/**
 * simulationStore.ts — persistence + in-memory job tracking for simulator runs.
 *
 * Two layers:
 *   1. Process-local Map<run_id, RunRecord> — drives /admin/simulate progress
 *      polling. Records evict 30 min after completion.
 *   2. Supabase `simulation_runs` table (migration 004) — long-term storage.
 *      Best-effort: if Supabase isn't configured, we log + skip silently so
 *      the simulator still works in dev / tests.
 */
import { randomUUID } from 'node:crypto';
import type { ScoringFormulaFile } from './scoringFormula.js';
import type { League, SimulationResult } from './seasonSimulator.js';

export type RunStatus = 'running' | 'completed' | 'failed';

export interface RunRecord {
  id: string;
  formula_version: string;
  formula_snapshot: ScoringFormulaFile;
  seasons_simulated: League[];
  synthetic_user_count: number;
  started_at: string;
  completed_at: string | null;
  status: RunStatus;
  results: SimulationResult | null;
  fairness_score: number | null;
  /** 0..1 progress (in-memory only). */
  progress: number;
  progress_note: string;
  error: string | null;
}

const RUNS = new Map<string, RunRecord>();
const EVICT_AFTER_MS = 30 * 60_000;

/** Create a run, return its id. The job runs asynchronously after this. */
export function createRun(input: {
  formula: ScoringFormulaFile;
  leagues: League[];
  syntheticUserCount: number;
}): RunRecord {
  const id = randomUUID();
  const rec: RunRecord = {
    id,
    formula_version: input.formula.version,
    formula_snapshot: input.formula,
    seasons_simulated: input.leagues,
    synthetic_user_count: input.syntheticUserCount,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: 'running',
    results: null,
    fairness_score: null,
    progress: 0,
    progress_note: 'queued',
    error: null,
  };
  RUNS.set(id, rec);
  return rec;
}

export function getRun(id: string): RunRecord | undefined {
  evictStale();
  return RUNS.get(id);
}

export function listRecentRuns(limit = 20): RunRecord[] {
  evictStale();
  return Array.from(RUNS.values())
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, limit);
}

export function updateProgress(id: string, frac: number, note?: string): void {
  const r = RUNS.get(id);
  if (!r || r.status !== 'running') return;
  r.progress = frac;
  if (note !== undefined) r.progress_note = note;
}

export function completeRun(id: string, result: SimulationResult): void {
  const r = RUNS.get(id);
  if (!r) return;
  r.status = 'completed';
  r.completed_at = new Date().toISOString();
  r.results = result;
  r.fairness_score = result.fairness.fairness_score;
  r.progress = 1;
  r.progress_note = 'done';
  void persistToSupabase(r);
}

export function failRun(id: string, err: unknown): void {
  const r = RUNS.get(id);
  if (!r) return;
  r.status = 'failed';
  r.completed_at = new Date().toISOString();
  r.error = err instanceof Error ? err.message : String(err);
  r.progress_note = 'failed';
  void persistToSupabase(r);
}

function evictStale(): void {
  const cutoff = Date.now() - EVICT_AFTER_MS;
  for (const [id, r] of RUNS) {
    if (r.status !== 'running' && new Date(r.completed_at ?? r.started_at).getTime() < cutoff) {
      RUNS.delete(id);
    }
  }
}

// ─── Best-effort Supabase persistence ───────────────────────────────────
async function persistToSupabase(r: RunRecord): Promise<void> {
  if (!process.env['SUPABASE_URL']) return; // not configured
  try {
    // Lazy import to avoid forcing the test env to wire Supabase up.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../db/client.js') as typeof import('../../db/client.js');
    const { error } = await mod.supabase.from('simulation_runs').upsert(
      {
        id: r.id,
        formula_version: r.formula_version,
        formula_snapshot: r.formula_snapshot,
        seasons_simulated: r.seasons_simulated,
        synthetic_user_count: r.synthetic_user_count,
        started_at: r.started_at,
        completed_at: r.completed_at,
        status: r.status,
        results_json: r.results,
        fairness_score: r.fairness_score,
      },
      { onConflict: 'id' },
    );
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[simulation_runs] persist failed (table missing?):', error.message);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[simulation_runs] persist threw:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Fetch recent runs from Supabase. Used by the dashboard trend-line. */
export async function fetchRecentRunsFromSupabase(limit = 20): Promise<{
  fairness_score: number | null;
  completed_at: string | null;
}[]> {
  if (!process.env['SUPABASE_URL']) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../db/client.js') as typeof import('../../db/client.js');
    const { data, error } = await mod.supabase
      .from('simulation_runs')
      .select('fairness_score, completed_at')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as { fairness_score: number | null; completed_at: string | null }[];
  } catch {
    return [];
  }
}

/** Reset for tests. */
export function _resetForTests(): void {
  RUNS.clear();
}
