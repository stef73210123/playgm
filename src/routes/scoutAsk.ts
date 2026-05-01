/**
 * scoutAsk.ts
 * POST /scout/ask  — sports Q&A powered by Scout the Fox (Claude Haiku 4.5).
 * GET  /scout/quota — returns the current per-(user, UTC day) quota WITHOUT
 *                     consuming a credit. Used by the client to render the
 *                     "X/Y questions today" badge + the cap-hit empty state.
 *
 * COPPA notes:
 * - Only question text is sent to LLM. No user ID, age, handle, or PII.
 * - No question history is persisted anywhere.
 * - Per-handle in-memory rate limit (5 req/min) blunts mash-the-button abuse.
 * - Per-(user, UTC day) limit comes from the subscription spec — enforced by
 *   `services/askScoutLimiter.ts` and persisted in the `ask_scout_usage`
 *   table. See `data/economy/pgm_subscriptions.json#ask_scout_daily_cap`.
 *
 * TODO(auth): the per-day limiter currently uses a stub user_id derived from
 * the bearer-token handle. When real auth ships and a Supabase user
 * (`req.user.id` + `req.user.subscription_tier`) is bound, swap the
 * `resolveUserContext` helper below to read from `request.user`. Until then,
 * the handle stub keeps the cap functional in dev and on tunneled previews
 * without blocking on the auth task.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { askScoutLLM } from '../services/scoutLLM.js';
import {
  checkAndIncrement,
  getQuota,
  type LimiterDecision,
} from '../services/askScoutLimiter.js';
import type { SubscriptionTierId } from '../economy/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AskBody {
  question: string;
}

interface AskResponse {
  answer: string;
  references?: Array<{ label: string; url: string }>;
}

interface QuotaResponse {
  cap: number | 'unlimited';
  count: number;
  remaining: number | 'unlimited';
  resets_at_iso: string;
  tier: SubscriptionTierId;
}

interface DailyCapErrorEnvelope {
  ok: false;
  error: {
    code: 'ASK_SCOUT_DAILY_CAP';
    message: string;
    cap: number;
    remaining: 0;
    resets_at_iso: string;
  };
}

// ─── Topic guard — pre-LLM rejection for obvious non-sports content ───────────

const NON_SPORTS_PATTERNS: RegExp[] = [
  /\b(bitcoin|crypto|ethereum|nft|blockchain|defi|stocks?|invest|portfolio)\b/i,
  /\b(president|election|politic|democrat|republican|senator|vote|congress)\b/i,
  /\b(diagnos|symptom|medicine|drug|medication|disease|covid|cancer|therapy)\b/i,
  /\b(my name|my age|where do i live|my address|my phone|my email|my password)\b/i,
  /\b(kill|murder|bomb|terrorist|weapon|shoot someone)\b/i,
  /\b(sex|porn|nude|naked|dating|hookup)\b/i,
  /\b(homework|math|science class|history class|school assignment)\b/i,
];

function isNonSportsTopic(q: string): boolean {
  return NON_SPORTS_PATTERNS.some((re) => re.test(q));
}

// ─── In-memory per-minute rate limiter ────────────────────────────────────────
// Distinct from the per-day limiter: this guards against mash-the-button
// abuse and resets on server restart. The per-day cap (subscription tier)
// is authoritative and lives in Postgres.

interface RateBucket {
  count: number;
  resetAt: number;
}

const PER_MIN_LIMIT = 5;
const PER_MIN_WINDOW_MS = 60_000;

const minuteBuckets = new Map<string, RateBucket>();

function checkMinuteLimit(handle: string): boolean {
  const now = Date.now();
  const bucket = minuteBuckets.get(handle);
  if (!bucket || now >= bucket.resetAt) {
    minuteBuckets.set(handle, { count: 1, resetAt: now + PER_MIN_WINDOW_MS });
    return true;
  }
  if (bucket.count >= PER_MIN_LIMIT) return false;
  bucket.count++;
  return true;
}

// ─── Auth shim ────────────────────────────────────────────────────────────────
// TODO(auth): replace with `request.user.{id, subscription_tier}` once the
// auth task ships. See file header.

interface UserContext {
  user_id: string;
  tier: SubscriptionTierId;
}

function resolveUserContext(request: FastifyRequest): UserContext {
  const authHeader = request.headers['authorization'] ?? '';
  const handle = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : 'anonymous';
  // The handle is *not* a UUID, so we can't write it directly to a
  // UUID-typed column in production. The route still exercises the limiter
  // path end-to-end in tests via this stub; the auth task will replace
  // `user_id` with `request.user.id`.
  return {
    user_id: handle,
    tier: ((request.headers['x-subscription-tier'] as SubscriptionTierId | undefined) ??
      'free'),
  };
}

function envelopeForCap(d: LimiterDecision): DailyCapErrorEnvelope {
  return {
    ok: false,
    error: {
      code: 'ASK_SCOUT_DAILY_CAP',
      message: `Scout's daily question cap (${d.cap}) reached for your tier — upgrade for more, or come back after the reset.`,
      cap: d.cap === Number.POSITIVE_INFINITY ? -1 : d.cap,
      remaining: 0,
      resets_at_iso: d.resets_at_iso,
    },
  };
}

function quotaResponseFor(d: LimiterDecision, tier: SubscriptionTierId): QuotaResponse {
  return {
    cap: d.cap === Number.POSITIVE_INFINITY ? 'unlimited' : d.cap,
    count: d.count,
    remaining: d.remaining === Infinity ? 'unlimited' : d.remaining,
    resets_at_iso: d.resets_at_iso,
    tier,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function scoutAskRoutes(fastify: FastifyInstance) {
  // POST /scout/ask
  fastify.post<{ Body: AskBody; Reply: AskResponse | DailyCapErrorEnvelope }>(
    '/scout/ask',
    {
      schema: {
        body: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { question } = request.body;
      const { user_id, tier } = resolveUserContext(request);

      // Per-minute rate limit (mash-the-button guard, in-memory).
      if (!checkMinuteLimit(user_id)) {
        return reply.code(429).send({
          answer: "Whoa, slow down! Scout needs a breather. Try again in a minute! 🦊",
        } as AskResponse);
      }

      // Per-(user, day) cap (subscription tier, persisted in Postgres).
      // Run BEFORE invoking Anthropic so over-cap callers never burn LLM spend.
      const decision = await checkAndIncrement(user_id, tier);
      if (!decision.allowed) {
        // Surface the structured envelope + advisory headers so the client
        // can render a precise empty state without guessing.
        reply.header('X-AskScout-Cap', String(decision.cap));
        reply.header('X-AskScout-Remaining', '0');
        reply.header('X-AskScout-ResetsAt', decision.resets_at_iso);
        return reply.code(429).send(envelopeForCap(decision));
      }

      // Pre-filter obvious non-sports topics. These DO consume a credit
      // (the increment happened above) — the alternative is letting kids
      // probe the topic guard for free, which would defeat the cap.
      if (isNonSportsTopic(question)) {
        reply.header('X-AskScout-Cap', String(decision.cap));
        reply.header(
          'X-AskScout-Remaining',
          decision.remaining === Infinity ? 'unlimited' : String(decision.remaining),
        );
        return reply.send({
          answer:
            "That's not a sports question! Try asking me about your favorite team, player, or stat. 🦊",
        });
      }

      try {
        const answer = await askScoutLLM(question);
        reply.header('X-AskScout-Cap', String(decision.cap));
        reply.header(
          'X-AskScout-Remaining',
          decision.remaining === Infinity ? 'unlimited' : String(decision.remaining),
        );
        return reply.send({ answer });
      } catch (err) {
        fastify.log.error({ msg: 'Scout LLM error', err: String(err) });
        return reply.send({
          answer: "Scout is having trouble thinking right now. Try asking another question! 🦊",
        });
      }
    },
  );

  // GET /scout/quota — read-only quota probe for the client UI.
  fastify.get<{ Reply: QuotaResponse }>('/scout/quota', async (request) => {
    const { user_id, tier } = resolveUserContext(request);
    const decision = await getQuota(user_id, tier);
    return quotaResponseFor(decision, tier);
  });
}
