/**
 * scoutAsk.ts
 * POST /scout/ask — COPPA-safe sports Q&A powered by Scout the Fox.
 *
 * COPPA notes:
 * - Only question text is sent to LLM. No user ID, age, handle, or PII.
 * - No question history is persisted anywhere.
 * - Rate-limited to 5 req/min per handle (in-memory, resets on server restart).
 * - Only aggregate call counts are logged, never question content.
 */

import type { FastifyInstance } from 'fastify';
import { askScoutLLM } from '../services/scoutLLM.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AskBody {
  question: string;
}

interface AskResponse {
  answer: string;
  references?: Array<{ label: string; url: string }>;
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

// ─── In-memory rate limiters ──────────────────────────────────────────────────
// Two layers, both per-handle, both reset on server restart:
//   - Per-minute: blunts mash-the-button abuse (5 calls / 60s).
//   - Per-day:    caps worst-case spend (50 calls / 24h). At Haiku 4.5 pricing
//                 (~$0.001 / call) this bounds a single kid to ~$0.05/day.

interface RateBucket {
  count: number;
  resetAt: number;
}

const PER_MIN_LIMIT = 5;
const PER_MIN_WINDOW_MS = 60_000;
const PER_DAY_LIMIT = 50;
const PER_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const minuteBuckets = new Map<string, RateBucket>();
const dayBuckets = new Map<string, RateBucket>();

function checkBucket(
  map: Map<string, RateBucket>,
  handle: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const bucket = map.get(handle);
  if (!bucket || now >= bucket.resetAt) {
    map.set(handle, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

type RateCheck = 'ok' | 'minute' | 'day';

function checkRateLimit(handle: string): RateCheck {
  // Day cap is checked first (and only consumed if the minute cap also passes)
  // so that a 429 on the minute cap doesn't consume daily budget.
  const now = Date.now();
  const dayBucket = dayBuckets.get(handle);
  if (dayBucket && now < dayBucket.resetAt && dayBucket.count >= PER_DAY_LIMIT) {
    return 'day';
  }
  if (!checkBucket(minuteBuckets, handle, PER_MIN_LIMIT, PER_MIN_WINDOW_MS)) {
    return 'minute';
  }
  // Minute cap consumed a slot; consume a day slot too.
  checkBucket(dayBuckets, handle, PER_DAY_LIMIT, PER_DAY_WINDOW_MS);
  return 'ok';
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function scoutAskRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: AskBody; Reply: AskResponse }>(
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

      // Extract handle from auth header (used only for rate limiting, never sent to LLM)
      const authHeader = request.headers['authorization'] ?? '';
      const handle = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : 'anonymous';

      // Rate limit (two layers — see definitions above)
      const rate = checkRateLimit(handle);
      if (rate === 'minute') {
        return reply.code(429).send({
          answer: "Whoa, slow down! Scout needs a breather. Try again in a minute! 🦊",
        } as AskResponse);
      }
      if (rate === 'day') {
        return reply.code(429).send({
          answer: "Scout has answered a TON of your questions today — give the fox a rest until tomorrow! 🦊💤",
        } as AskResponse);
      }

      // Pre-filter obvious non-sports topics
      if (isNonSportsTopic(question)) {
        return reply.send({
          answer: "That's not a sports question! Try asking me about your favorite team, player, or stat. 🦊",
        });
      }

      try {
        const answer = await askScoutLLM(question);
        return reply.send({ answer });
      } catch (err) {
        fastify.log.error({ msg: 'Scout LLM error', err: String(err) });
        return reply.send({
          answer: "Scout is having trouble thinking right now. Try asking another question! 🦊",
        });
      }
    },
  );
}
