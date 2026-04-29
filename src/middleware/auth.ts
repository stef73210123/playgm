/**
 * auth.ts
 * Simple bearer-token auth: the token IS the user's handle.
 * Full Supabase auth comes in a later sprint; this keeps routing unblocked.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { supabase } from '../db/client.js';

export interface AuthenticatedRequest extends FastifyRequest {
  profileId: string;
  handle: string;
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const auth = request.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    await reply.code(401).send({ error: 'Missing Authorization header' });
    return;
  }

  const handle = auth.slice(7).trim();
  if (!handle) {
    await reply.code(401).send({ error: 'Empty bearer token' });
    return;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('handle', handle)
    .maybeSingle();

  if (!profile) {
    await reply.code(401).send({ error: 'Unknown handle — call POST /profile/bootstrap first' });
    return;
  }

  (request as AuthenticatedRequest).profileId = profile.id as string;
  (request as AuthenticatedRequest).handle = handle;
}
