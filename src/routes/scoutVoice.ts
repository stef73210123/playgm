/**
 * Scout voice routes — ElevenLabs proxy.
 *
 * Why a proxy: the ElevenLabs API key grants paid access. Routing through
 * the backend keeps it server-side so it can't leak into the bundled
 * client JS (where anyone with DevTools can grab it).
 *
 * Routes:
 *   POST /voice/tts   { text, voiceId? } → audio/mpeg stream
 *   POST /voice/stt   multipart/form-data (field: audio) → { transcript }
 *
 * Both endpoints degrade gracefully when ELEVENLABS_API_KEY is unset:
 *   - /voice/tts returns 503 so the client falls back to silent display.
 *   - /voice/stt returns 503 so the client keeps the text-input path.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';

// Voice defaults — the canonical "Scout" voice the user picked
// (WSZtzTHUs2DHqN3Itpi1, 2026-04-28) reads as the Scout the Fox
// character across Scout's Takes (scouting modal TTS) and Ask Scout
// (Trivia screen). The hardcoded fallback exists only so dev builds
// still emit something when ELEVENLABS_VOICE_ID isn't set.
const DEFAULT_VOICE_ID = process.env['ELEVENLABS_VOICE_ID'] ?? 'WSZtzTHUs2DHqN3Itpi1';
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5'; // fastest + cheapest English-only tier

export async function scoutVoiceRoutes(fastify: FastifyInstance): Promise<void> {
  const apiKey = process.env['ELEVENLABS_API_KEY'];
  if (!apiKey) {
    fastify.log.warn('Scout voice: ELEVENLABS_API_KEY not set — /voice/* will return 503');
  }

  // ─── TTS: text → audio/mpeg ────────────────────────────────────────────
  const ttsSchema = z.object({
    text: z.string().min(1).max(1000),
    voiceId: z.string().optional(),
  });

  fastify.post('/voice/tts', async (req, reply) => {
    if (!apiKey) return reply.code(503).send({ error: 'Voice service not configured' });
    const parsed = ttsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const voiceId = parsed.data.voiceId ?? DEFAULT_VOICE_ID;

    try {
      const upstream = await fetch(`${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: parsed.data.text,
          model_id: DEFAULT_MODEL_ID,
          voice_settings: {
            // Slightly higher stability than default for a consistent,
            // calm delivery; similarity_boost at 0.75 keeps the voice
            // recognizable as "Scout" across generations.
            stability: 0.6,
            similarity_boost: 0.75,
            style: 0.25,
            use_speaker_boost: true,
          },
        }),
      });

      if (!upstream.ok) {
        const body = await upstream.text().catch(() => '');
        fastify.log.warn({ status: upstream.status, body: body.slice(0, 200) }, 'Scout TTS upstream error');
        return reply.code(502).send({ error: 'TTS upstream failed' });
      }

      const audioBuf = Buffer.from(await upstream.arrayBuffer());
      reply
        .header('Content-Type', 'audio/mpeg')
        .header('Content-Length', String(audioBuf.length))
        // Cache identical requests for 10 min. ElevenLabs call is ~$0.003
        // per request so even a little cache saves real money during dev.
        .header('Cache-Control', 'private, max-age=600');
      return reply.send(audioBuf);
    } catch (e) {
      fastify.log.error(e, 'Scout TTS fetch failed');
      return reply.code(500).send({ error: 'TTS failed' });
    }
  });

  // ─── STT: audio → transcript ───────────────────────────────────────────
  // ElevenLabs exposes /v1/speech-to-text (multipart/form-data) that takes
  // an audio file and returns JSON with a `text` field. We proxy multipart
  // straight through; Fastify doesn't parse it here so the client's raw
  // form body is forwarded as-is.
  fastify.post('/voice/stt', {
    // Let the raw multipart body flow through without Fastify's JSON parser.
    bodyLimit: 25 * 1024 * 1024, // 25 MB ceiling — typical voice clips are <200 KB
  }, async (req, reply) => {
    if (!apiKey) return reply.code(503).send({ error: 'Voice service not configured' });

    // We proxy the multipart body directly. Consumer-Type is copied from
    // the inbound request so the ElevenLabs parser sees the right boundary.
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.startsWith('multipart/')) {
      return reply.code(400).send({ error: 'Expected multipart/form-data' });
    }

    // Read the raw body. Fastify gives us a Buffer when no parser matches
    // the Content-Type. We registered a raw parser for 'multipart/*' in
    // index.ts so this works — see the registration there.
    const rawBody = req.body as Buffer | undefined;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: 'Missing audio body' });
    }

    try {
      // Undici's fetch typings don't list Buffer/Uint8Array in BodyInit even
      // though the runtime accepts both. Cast through `unknown` to BodyInit
      // so we pass the bytes through without copying into a Blob first.
      const upstream = await fetch(`${ELEVENLABS_BASE}/v1/speech-to-text`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': contentType,
        },
        body: rawBody as unknown as BodyInit,
      });

      if (!upstream.ok) {
        const body = await upstream.text().catch(() => '');
        fastify.log.warn({ status: upstream.status, body: body.slice(0, 200) }, 'Scout STT upstream error');
        return reply.code(502).send({ error: 'STT upstream failed' });
      }

      const data = await upstream.json() as { text?: string; language_code?: string };
      return reply.send({
        transcript: (data.text ?? '').trim(),
        language: data.language_code ?? null,
      });
    } catch (e) {
      fastify.log.error(e, 'Scout STT fetch failed');
      return reply.code(500).send({ error: 'STT failed' });
    }
  });
}
