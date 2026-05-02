/**
 * supabaseAuth.ts — JWT bearer auth for /me/* endpoints.
 *
 * Validates the Authorization header against Supabase's auth.users via
 * `supabase.auth.getUser(token)`. On success, stamps `request.userId`
 * for downstream handlers; on failure, replies 401.
 *
 * Distinct from middleware/auth.ts (handle-as-bearer) — that one is
 * kept for legacy /profile/* routes during the transition. New routes
 * should use this one.
 *
 * Falls back to anon "guest" mode when an `X-Guest-Device-Id` header
 * is present and no Authorization is provided. Guest requests get a
 * synthetic user_id derived from the device id (`guest:<deviceId>`)
 * which is NOT a real auth.users id — guest-allowlisted endpoints
 * must check `request.isGuest` and route writes to a guest-namespaced
 * row.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { supabase } from '../db/client.js';

export interface SupabaseAuthedRequest extends FastifyRequest {
  userId: string;
  isGuest: boolean;
}

export async function requireSupabaseAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (!token) {
      await reply.code(401).send({ error: 'empty_bearer' });
      return;
    }
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      await reply.code(401).send({ error: 'invalid_token' });
      return;
    }
    (request as SupabaseAuthedRequest).userId = data.user.id;
    (request as SupabaseAuthedRequest).isGuest = false;
    return;
  }

  // Guest fallback.
  const guestHeader = request.headers['x-guest-device-id'];
  if (typeof guestHeader === 'string' && guestHeader.length > 0) {
    (request as SupabaseAuthedRequest).userId = `guest:${guestHeader}`;
    (request as SupabaseAuthedRequest).isGuest = true;
    return;
  }

  await reply.code(401).send({ error: 'missing_auth' });
}
