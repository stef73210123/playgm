/**
 * runtimeConfig.ts — public read-only aggregator at GET /api/config/v1.
 *
 * Bundles the 10 spec files the client needs at boot into one JSON envelope
 * so the app can refresh content without an over-the-air JS update. Cached
 * in-memory for 60 seconds; admin PATCH handlers can call invalidateConfigCache().
 *
 * Shape:
 *   { version, generated_at, cache_ttl_seconds, specs: { … } }
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './adminEdit.js';

const CACHE_TTL_SECONDS = 600;
const CACHE_TTL_MS = 60 * 1000; // server-side internal cache window
const CONFIG_VERSION = '1.0.0';

interface ConfigPayload {
  version: string;
  generated_at: string;
  cache_ttl_seconds: number;
  specs: {
    progression: unknown;
    pp_earn_rates: unknown;
    subscriptions: unknown;
    streak_rewards: unknown;
    packs: unknown;
    pity_timers: unknown;
    triggers: unknown;
    stat_resolution: unknown;
    card_templates: unknown;
    safety_matrix: unknown;
    trade_rules: unknown;
    sfx_manifest: unknown;
    sports_config: unknown;
  };
}

interface CacheEntry {
  payload: ConfigPayload;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

const SPEC_FILES = {
  progression: ['data', 'economy', 'pgm_progression.json'],
  pp_earn_rates: ['data', 'economy', 'pgm_pp_earn_rates.json'],
  subscriptions: ['data', 'economy', 'pgm_subscriptions.json'],
  streak_rewards: ['data', 'economy', 'pgm_streak_rewards.json'],
  packs: ['data', 'cards', 'pgm_packs.json'],
  pity_timers: ['data', 'cards', 'pgm_pity_timers.json'],
  triggers: ['data', 'cards', 'pgm_triggers.json'],
  stat_resolution: ['data', 'cards', 'pgm_stat_resolution.json'],
  card_templates: ['data', 'cards', 'pgm_card_templates.json'],
  safety_matrix: ['data', 'safety', 'age_feature_matrix.json'],
  trade_rules: ['data', 'economy', 'pgm_trade_rules.json'],
  sfx_manifest: ['data', 'audio', 'pgm_sfx_manifest.json'],
  sports_config: ['data', 'system', 'sports_config.json'],
} as const;

async function buildPayload(): Promise<ConfigPayload> {
  const entries = await Promise.all(
    (Object.entries(SPEC_FILES) as Array<[keyof typeof SPEC_FILES, readonly string[]]>).map(
      async ([key, parts]) => {
        const abs = path.join(PROJECT_ROOT, ...parts);
        const raw = await fs.readFile(abs, 'utf8');
        return [key, JSON.parse(raw) as unknown] as const;
      },
    ),
  );
  const specs = Object.fromEntries(entries) as ConfigPayload['specs'];
  return {
    version: CONFIG_VERSION,
    generated_at: new Date().toISOString(),
    cache_ttl_seconds: CACHE_TTL_SECONDS,
    specs,
  };
}

/** Drop the cached payload so the next request rebuilds from disk. */
export function invalidateConfigCache(): void {
  cache = null;
}

export async function runtimeConfigRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/config/v1', async (_req, reply) => {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return cache.payload;
    }
    try {
      const payload = await buildPayload();
      cache = { payload, expiresAt: now + CACHE_TTL_MS };
      return payload;
    } catch (err) {
      reply.code(500).send({
        ok: false,
        error: err instanceof Error ? err.message : 'failed to build runtime config',
      });
      return reply;
    }
  });
}
