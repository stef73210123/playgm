/**
 * healthChecks.ts — lightweight liveness probes for external services.
 *
 * Each probe returns a uniform shape so the /admin/status aggregator can
 * render them without per-service branching:
 *
 *   { status: 'up' | 'down' | 'unknown', latency_ms, last_checked_at, error? }
 *
 * Constraints:
 *   - 5s hard timeout per probe (AbortController)
 *   - Failures degrade to { status: 'down', error } — never throw
 *   - Probes that need an env var that's missing return 'unknown' (not 'down')
 *   - Results are cached for 25s so dashboard polling at 30s doesn't hammer
 *     external APIs.
 */
import { supabase } from '../db/client.js';

const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 25_000;

export interface ProbeResult {
  status: 'up' | 'down' | 'unknown';
  latency_ms: number;
  last_checked_at: string;
  error?: string;
}

interface CacheEntry<T> {
  value: T;
  expires_at: number;
}

const probeCache = new Map<string, CacheEntry<ProbeResult>>();

async function withTimeout(
  fn: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Wraps a probe with cache + timing + error coercion. */
async function runProbe(
  cacheKey: string,
  probe: () => Promise<{ ok: boolean; error?: string; unknown?: boolean }>,
): Promise<ProbeResult> {
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) {
    return cached.value;
  }

  const start = Date.now();
  let result: ProbeResult;
  try {
    const out = await probe();
    const latency_ms = Date.now() - start;
    if (out.unknown) {
      result = {
        status: 'unknown',
        latency_ms,
        last_checked_at: new Date().toISOString(),
        error: out.error,
      };
    } else if (out.ok) {
      result = {
        status: 'up',
        latency_ms,
        last_checked_at: new Date().toISOString(),
      };
    } else {
      result = {
        status: 'down',
        latency_ms,
        last_checked_at: new Date().toISOString(),
        error: out.error ?? 'unknown error',
      };
    }
  } catch (err) {
    result = {
      status: 'down',
      latency_ms: Date.now() - start,
      last_checked_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  probeCache.set(cacheKey, { value: result, expires_at: Date.now() + CACHE_TTL_MS });
  return result;
}

// ─── Anthropic ──────────────────────────────────────────────────────────────
// GET /v1/models — cheapest authenticated probe; verifies the API key works.
export async function probeAnthropic(): Promise<ProbeResult> {
  return runProbe('anthropic', async () => {
    const key = process.env['ANTHROPIC_API_KEY'];
    if (!key) return { ok: false, unknown: true, error: 'ANTHROPIC_API_KEY not set' };
    const res = await withTimeout((signal) =>
      fetch('https://api.anthropic.com/v1/models?limit=1', {
        method: 'GET',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        signal,
      }),
    );
    return res.ok
      ? { ok: true }
      : { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
  });
}

// ─── ElevenLabs ─────────────────────────────────────────────────────────────
// GET /v1/voices — short voices listing. Auth via xi-api-key header.
export async function probeElevenLabs(): Promise<ProbeResult> {
  return runProbe('elevenlabs', async () => {
    const key = process.env['ELEVENLABS_API_KEY'];
    if (!key) return { ok: false, unknown: true, error: 'ELEVENLABS_API_KEY not set' };
    const res = await withTimeout((signal) =>
      fetch('https://api.elevenlabs.io/v1/voices', {
        method: 'GET',
        headers: { 'xi-api-key': key },
        signal,
      }),
    );
    return res.ok
      ? { ok: true }
      : { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
  });
}

// ─── Supabase ───────────────────────────────────────────────────────────────
// `select count(*) from profiles limit 1` via the JS client.
export async function probeSupabase(): Promise<ProbeResult> {
  return runProbe('supabase', async () => {
    const url = process.env['SUPABASE_URL'];
    const key = process.env['SUPABASE_SERVICE_KEY'] ?? process.env['SUPABASE_ANON_KEY'];
    if (!url || !key) {
      return { ok: false, unknown: true, error: 'SUPABASE_URL or key not set' };
    }
    // head:true makes this an existence/authz probe — no row payload.
    const { error } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
}

// ─── TheSportsDB v2 ─────────────────────────────────────────────────────────
// Lookup a known event (NBA event id 401705006 — a 2024 Nuggets game).
// Falls back to a livescore probe if the event lookup ever drifts.
export async function probeSportsDb(): Promise<ProbeResult> {
  return runProbe('sportsdb', async () => {
    const key = process.env['SPORTSDB_V2_KEY'] ?? '238797'; // dev fallback (matches sportsdb.ts)
    const res = await withTimeout((signal) =>
      fetch('https://www.thesportsdb.com/api/v2/json/livescore/basketball', {
        method: 'GET',
        headers: { 'X-API-KEY': key },
        signal,
      }),
    );
    return res.ok
      ? { ok: true }
      : { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
  });
}

// ─── Wikimedia ──────────────────────────────────────────────────────────────
// HEAD on a stable Commons file URL.
export async function probeWikimedia(): Promise<ProbeResult> {
  return runProbe('wikimedia', async () => {
    const res = await withTimeout((signal) =>
      fetch('https://commons.wikimedia.org/wiki/File:Wikimedia-logo.svg', {
        method: 'HEAD',
        signal,
      }),
    );
    return res.ok
      ? { ok: true }
      : { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
  });
}

/** Test hook — clears the probe cache so unit tests start clean. */
export function _resetHealthCheckCacheForTests(): void {
  probeCache.clear();
}
