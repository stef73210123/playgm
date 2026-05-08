/**
 * adminDataProviders.ts — JSON API for the per-sport data provider toggle.
 *
 * Routes:
 *   GET    /admin/data-providers
 *     → returns the current data_provider_config.json plus the resolved
 *       provider per league (factoring env override + fallbacks).
 *
 *   PATCH  /admin/data-providers
 *     body: { league: 'nfl'|'nba'|'mlb'|'nhl'|'mls', provider: 'espn'|'thesportsdb'|'apisports' }
 *     → writes the new value to disk atomically and busts the in-memory cache
 *       so the next stats refresh picks it up immediately.
 *
 * Auth: same posture as the rest of /admin/* — no auth at the framework
 * level, expected to live behind the trycloudflare tunnel that already
 * gates the rest of the admin surface.
 */
import type { FastifyInstance } from 'fastify';
import {
  loadDataProviderConfig,
  setProviderForLeague,
  getProviderForLeague,
  type ProviderId,
  type SportId,
} from '../services/dataProviderConfig.js';
import { resetStatsAdapter } from '../services/stats/index.js';

const VALID_LEAGUES: SportId[] = ['nfl', 'nba', 'mlb', 'nhl', 'mls'];
const VALID_PROVIDERS: ProviderId[] = ['espn', 'thesportsdb', 'apisports'];

function isLeague(v: unknown): v is SportId {
  return typeof v === 'string' && (VALID_LEAGUES as string[]).includes(v);
}
function isProvider(v: unknown): v is ProviderId {
  return typeof v === 'string' && (VALID_PROVIDERS as string[]).includes(v);
}

export async function adminDataProviderRoutes(server: FastifyInstance): Promise<void> {
  server.get('/admin/data-providers', async () => {
    const cfg = loadDataProviderConfig();
    const resolved: Record<SportId, ProviderId> = {
      nfl: getProviderForLeague('nfl'),
      nba: getProviderForLeague('nba'),
      mlb: getProviderForLeague('mlb'),
      nhl: getProviderForLeague('nhl'),
      mls: getProviderForLeague('mls'),
    };
    return {
      config: cfg,
      resolved,
      env_override: process.env.STATS_PROVIDER ?? null,
      valid_providers: VALID_PROVIDERS,
      valid_leagues: VALID_LEAGUES,
    };
  });

  server.patch('/admin/data-providers', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { league, provider } = body;
    if (!isLeague(league)) {
      reply.code(400);
      return { error: `invalid league: ${String(league)}`, valid: VALID_LEAGUES };
    }
    if (!isProvider(provider)) {
      reply.code(400);
      return { error: `invalid provider: ${String(provider)}`, valid: VALID_PROVIDERS };
    }
    const updated = setProviderForLeague(league, provider);
    // The stats factory caches the global default adapter; bust it so a
    // legacy caller that doesn't pass a league still picks up changes.
    resetStatsAdapter();
    return {
      ok: true,
      updated_league: league,
      provider,
      config: updated,
    };
  });
}
