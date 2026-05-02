/**
 * sync.ts
 *
 * Endpoints supporting the client's offline mode:
 *
 *   GET  /api/sync/manifest             → version strings for stat-cache,
 *                                          schedule, and runtime config so
 *                                          the client knows what to refresh.
 *   GET  /api/sync/stat-cache/:league   → freshest stat-cache JSON for a
 *                                          league. Served from disk; the
 *                                          file is rewritten by the
 *                                          existing data-sync jobs.
 *   POST /api/sync/queue                → generic sink for client-side
 *                                          enqueued events (settings
 *                                          updates, lineup tweaks). Each
 *                                          envelope carries its own type
 *                                          and is dispatched to the
 *                                          matching handler.
 *   POST /api/trivia/scores/sync        → batch upload of offline trivia
 *                                          scores. Dedup-by-localId via
 *                                          `services/triviaScoreSync.ts`.
 *
 * Versioning: we hash the contents of each stat-cache file to derive
 * `version`. This way, the client can short-circuit a refresh whenever
 * the file hasn't actually changed, even if `updated_at` is newer.
 */

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { PROJECT_ROOT } from './adminEdit.js';
import { supabase } from '../db/client.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  syncTriviaScores,
  type OfflineTriviaScore,
} from '../services/triviaScoreSync.js';

// ─── Stat-cache discovery ────────────────────────────────────────────────────

const STAT_CACHE_DIR = path.join(PROJECT_ROOT, 'assets', 'stat-cache');

// Map league key → on-disk filename. Mirrors the client's LEAGUE_BUNDLES.
const LEAGUE_FILES: Record<string, string> = {
  nba: 'nba_season_2025-26.json',
  nfl: 'nfl_season_2025.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

interface ManifestEntry {
  version: string;
  updated_at: string;
}

interface ManifestCacheEntry {
  manifest: {
    statCacheVersion: Record<string, ManifestEntry>;
    generated_at: string;
  };
  expiresAt: number;
}

let manifestCache: ManifestCacheEntry | null = null;
const MANIFEST_TTL_MS = 60_000; // 1 minute — admin edits to caches show up fast.

async function buildManifest(): Promise<ManifestCacheEntry['manifest']> {
  const entries = await Promise.all(
    Object.entries(LEAGUE_FILES).map(async ([league, filename]) => {
      const abs = path.join(STAT_CACHE_DIR, filename);
      try {
        const buf = await fs.readFile(abs);
        const stat = await fs.stat(abs);
        const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
        const entry: ManifestEntry = {
          version: hash,
          updated_at: stat.mtime.toISOString(),
        };
        return [league, entry] as const;
      } catch {
        // Missing file → omit from manifest. The client still has the
        // bundled require to fall back to.
        return null;
      }
    }),
  );
  const map = Object.fromEntries(
    entries.filter((e): e is readonly [string, ManifestEntry] => e !== null),
  );
  return {
    statCacheVersion: map,
    generated_at: new Date().toISOString(),
  };
}

/** Drop the cached manifest so the next request rebuilds. Hooked into
 *  the data-sync job so admin-driven cache refreshes propagate. */
export function invalidateSyncManifest(): void {
  manifestCache = null;
}

// ─── Request schemas ─────────────────────────────────────────────────────────

const triviaScoreSchema = z.object({
  localId: z.string().min(1).max(64),
  questionId: z.string().uuid(),
  selectedIdx: z.number().int().min(0).max(3),
  isCorrect: z.boolean(),
  ppWon: z.number().int().min(0).max(1000),
  used5050: z.boolean().optional(),
  usedInsight: z.boolean().optional(),
  answeredAt: z.string().datetime(),
});

const triviaScoresSchema = z.object({
  scores: z.array(triviaScoreSchema).min(1).max(200),
});

const queueEnvelopeSchema = z.object({
  localId: z.string().min(1).max(64),
  type: z.enum(['settings_update', 'lineup_update', 'profile_update']),
  payload: z.record(z.unknown()),
  timestamp: z.string().datetime(),
});

const queueBatchSchema = z.object({
  envelopes: z.array(queueEnvelopeSchema).min(1).max(100),
});

// ─── Handlers for the generic queue ──────────────────────────────────────────
//
// We keep these inline (rather than in their own services dir) because
// they're each ~5 lines of supabase upsert. If they grow, each can move
// to `services/` like triviaScoreSync.ts.

async function applySettingsUpdate(
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Whitelist the fields a kid can write from the client. Anything not
  // in this list is silently dropped — protects against a tampered
  // client trying to bump play_points or change subscription_tier.
  const allowed = ['timezone', 'initials', 'favorite_team_ids'];
  const safe: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in payload) safe[k] = payload[k];
  }
  if (Object.keys(safe).length === 0) return;
  const { error } = await supabase.from('profiles').update(safe).eq('id', userId);
  if (error) throw new Error(`settings_update: ${error.message}`);
}

async function applyLineupUpdate(
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Stored as a single JSONB blob on the user's active roster. Schema
  // for `rosters` has a `lineup_json` column we treat as authoritative.
  const lineup = payload['lineup'];
  if (!lineup) return;
  const { error } = await supabase
    .from('rosters')
    .update({ lineup_json: lineup })
    .eq('user_id', userId)
    .eq('is_active', true);
  if (error) throw new Error(`lineup_update: ${error.message}`);
}

async function applyProfileUpdate(
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Identical whitelist semantics to settings_update — separate route
  // type so the client can opt to retry-individually.
  return applySettingsUpdate(userId, payload);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function syncRoutes(fastify: FastifyInstance): Promise<void> {
  // Public manifest — no auth required. Reading versions is harmless
  // and the kid may be in a state where the cached handle is stale.
  fastify.get('/api/sync/manifest', async () => {
    const now = Date.now();
    if (manifestCache && manifestCache.expiresAt > now) {
      return manifestCache.manifest;
    }
    const manifest = await buildManifest();
    manifestCache = { manifest, expiresAt: now + MANIFEST_TTL_MS };
    return manifest;
  });

  // Per-league fetch — also public read. Mirrors what the client
  // bundles, but freshest.
  fastify.get<{ Params: { league: string } }>(
    '/api/sync/stat-cache/:league',
    async (req, reply) => {
      const league = req.params.league.toLowerCase();
      const filename = LEAGUE_FILES[league];
      if (!filename) {
        reply.code(404).send({ error: `Unknown league "${league}"` });
        return reply;
      }
      const abs = path.join(STAT_CACHE_DIR, filename);
      try {
        const buf = await fs.readFile(abs, 'utf8');
        // Set a short cache header so retries within the same minute
        // don't keep hammering the disk on a flaky network.
        reply.header('Cache-Control', 'public, max-age=60');
        reply.header('Content-Type', 'application/json');
        return buf;
      } catch (e) {
        reply.code(500).send({
          error: e instanceof Error ? e.message : 'failed to read stat-cache',
        });
        return reply;
      }
    },
  );

  // Generic offline-queue drain. Authenticated — every envelope is
  // applied to the caller's user record, never someone else's.
  fastify.post('/api/sync/queue', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = queueBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const applied: string[] = [];
    const failed: Array<{ localId: string; error: string }> = [];
    for (const env of parsed.data.envelopes) {
      try {
        switch (env.type) {
          case 'settings_update':
            await applySettingsUpdate(profileId, env.payload);
            break;
          case 'lineup_update':
            await applyLineupUpdate(profileId, env.payload);
            break;
          case 'profile_update':
            await applyProfileUpdate(profileId, env.payload);
            break;
        }
        applied.push(env.localId);
      } catch (e) {
        failed.push({
          localId: env.localId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return reply.send({ applied, failed });
  });

  // Trivia score batch sync — uses the dedicated dedup service.
  fastify.post(
    '/api/trivia/scores/sync',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { profileId } = req as AuthenticatedRequest;
      const parsed = triviaScoresSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const result = await syncTriviaScores(
        supabase,
        profileId,
        parsed.data.scores as OfflineTriviaScore[],
      );
      return reply.send(result);
    },
  );
}
