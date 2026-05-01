import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cron from 'node-cron';
import { startDataSync } from './services/dataSync.js';
import { startMorningReveal } from './services/morningReveal.js';
import { startLiveScoreSync } from './services/liveScoreSync.js';
import { profileRoutes } from './routes/profile.js';
import { cardsRoutes } from './routes/cards.js';
import { cardScanRoutes } from './routes/cardScan.js';
import { draftRoutes } from './routes/draft.js';
import { scoutingReportRoutes } from './routes/scoutingReport.js';
import { triviaRoutes } from './routes/trivia.js';
import { alliancesRoutes } from './routes/alliances.js';
import { packsRoutes } from './routes/packs.js';
import { scoutAskRoutes } from './routes/scoutAsk.js';
import { gamesRoutes } from './routes/games.js';
import { highlightsRoutes, warmHighlightCache } from './routes/highlights.js';
// ─── Multi-Roster / Contests / Subscriptions (2026-04-19 stubs) ──────────────
import { rostersRoutes } from './routes/rosters.js';
import { contestsRoutes } from './routes/contests.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { practiceDraftRoutes } from './routes/practiceDrafts.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { scoutVoiceRoutes } from './routes/scoutVoice.js';
import { adminRoutes, installRouteTracker } from './routes/admin.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = '0.0.0.0';

const server = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

// ─── CORS ────────────────────────────────────────────────────────────────────

await server.register(cors, {
  origin: true,           // reflect request origin — fine for local dev
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
});

// ─── Raw multipart parser ───────────────────────────────────────────────────
// The /voice/stt route proxies the client's multipart/form-data body straight
// to ElevenLabs. We don't want Fastify to parse/rewrite it, so register a
// raw parser that just buffers the body as-is.
server.addContentTypeParser(/^multipart\/.*/, { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 },
  (_req, body, done) => done(null, body));

// ─── Route tracker ───────────────────────────────────────────────────────────
// Must be installed BEFORE any route registration so /admin/status can list
// every endpoint the server exposes.
installRouteTracker(server);

// ─── Health ──────────────────────────────────────────────────────────────────

server.get('/health', async () => {
  return { ok: true, version: '2026.1' };
});

// ─── Routes ──────────────────────────────────────────────────────────────────

await server.register(profileRoutes, { prefix: '/' });
await server.register(cardsRoutes, { prefix: '/' });
await server.register(cardScanRoutes, { prefix: '/' });
await server.register(draftRoutes, { prefix: '/' });
await server.register(scoutingReportRoutes, { prefix: '/' });
await server.register(triviaRoutes, { prefix: '/' });
await server.register(alliancesRoutes, { prefix: '/' });
await server.register(packsRoutes, { prefix: '/' });
await server.register(scoutAskRoutes, { prefix: '/' });
await server.register(gamesRoutes, { prefix: '/' });
await server.register(highlightsRoutes, { prefix: '/' });
await server.register(rostersRoutes, { prefix: '/' });
await server.register(contestsRoutes, { prefix: '/' });
await server.register(subscriptionRoutes, { prefix: '/' });
await server.register(practiceDraftRoutes, { prefix: '/' });
await server.register(leaderboardRoutes, { prefix: '/' });
await server.register(scoutVoiceRoutes, { prefix: '/' });
await server.register(adminRoutes, { prefix: '/' });

// ─── Start ───────────────────────────────────────────────────────────────────

try {
  await server.listen({ port: PORT, host: HOST });
  server.log.info(`PlayGM backend listening on ${HOST}:${PORT}`);

  // ─── LLM key presence check (masked) ────────────────────────────────────
  // Anthropic only (cheapest tier — Haiku 4.5). No OpenAI fallback.
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    const masked = `${anthropicKey.slice(0, 10)}***${anthropicKey.slice(-12)}`;
    server.log.info(`Scout LLM: Anthropic key detected — ${masked} (model: claude-haiku-4-5)`);
  } else {
    server.log.warn('Scout LLM: ANTHROPIC_API_KEY not set — /scout/ask will return fallback response');
  }

  startDataSync(server.log);      // 24-hr stats refresh
  startMorningReveal(server.log); // 6am UTC victory reveal
  startLiveScoreSync();           // 120-s live score poll (War Room)

  // Daily 5am ET highlight cache refresh (America/New_York handles DST automatically)
  cron.schedule('0 5 * * *', () => warmHighlightCache(server.log), {
    timezone: 'America/New_York',
  });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
