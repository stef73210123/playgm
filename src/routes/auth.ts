/**
 * auth.ts — auth-related server endpoints.
 *
 * For v1 the only endpoint here is the COPPA parental-consent stub. The
 * Supabase auth.users row is created by the client via supabase-js
 * directly (no server hop required), so the server's only job is to
 * record the consent request and (in a follow-up dispatch) trigger the
 * email-plus mailer.
 *
 * Mailer integration: NOT YET WIRED.
 *   When ready, plug Postmark or SendGrid here. The minimum payload is:
 *     - to: parent_email
 *     - subject: "Permission needed for your child's PlayGM account"
 *     - body: deeplink with `?token=<consent_token>` to the
 *       /coppa/confirm route (also TBD — lives in a static-page repo).
 *   The consent_token is the row's UUID; storing it server-side means
 *   we don't have to trust signed JWTs from a third-party mailer.
 *
 * Open route (no auth) — the user_id is supplied by the client right
 * after sign-up (the Supabase client knows their own auth.users.id), so
 * we don't need a bearer to authenticate the caller. The supabase
 * service-role write enforces user_id is a valid auth.users.id (FK).
 */

import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { supabase } from '../db/client.js';

const ParentalConsentRequestSchema = z.object({
  user_id: z.string().uuid(),
  parent_email: z.string().email(),
  child_age: z.number().int().min(0).max(17),
});

export async function authRoutes(server: FastifyInstance): Promise<void> {
  /**
   * POST /auth/parental-consent-request
   *
   * Body: { user_id, parent_email, child_age }
   * Response: { id, consent_token }
   *
   * Idempotent on (user_id) — re-issuing for an existing row updates
   * requested_at + rotates the consent_token (so old mailto links stop
   * working when the parent re-requests).
   *
   * TODO: enqueue mailer job here. For v1 we only persist the row.
   */
  server.post('/auth/parental-consent-request', async (request, reply) => {
    const parsed = ParentalConsentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
      return;
    }
    const { user_id, parent_email, child_age } = parsed.data;
    const consent_token = crypto.randomBytes(24).toString('hex');

    // Upsert on (user_id) — only one open consent request per minor.
    const { data, error } = await supabase
      .from('parental_consent_requests')
      .upsert(
        {
          user_id,
          parent_email,
          child_age,
          consent_token,
          requested_at: new Date().toISOString(),
          consent_received_at: null,
        },
        { onConflict: 'user_id', ignoreDuplicates: false },
      )
      .select('id, consent_token')
      .single();

    if (error) {
      request.log.error({ err: error }, 'parental-consent-request insert failed');
      await reply.code(500).send({ error: 'persist_failed' });
      return;
    }

    // TODO: queue mailer.
    // await mailer.send({ to: parent_email, template: 'coppa-consent', data: { token: consent_token } });

    return { id: data.id, consent_token: data.consent_token };
  });

  /**
   * GET /auth/parental-consent-request/:user_id
   *
   * Read-only check — returns the latest consent state for a user_id.
   * Used by the client + admin dashboard to decide whether the kid is
   * unblocked for verified-consent gated features.
   */
  server.get<{ Params: { user_id: string } }>(
    '/auth/parental-consent-request/:user_id',
    async (request, reply) => {
      const userId = request.params.user_id;
      if (!/^[0-9a-fA-F-]{36}$/.test(userId)) {
        await reply.code(400).send({ error: 'invalid_user_id' });
        return;
      }
      const { data, error } = await supabase
        .from('parental_consent_requests')
        .select('id, parent_email, child_age, requested_at, consent_received_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) {
        request.log.error({ err: error }, 'parental-consent-request lookup failed');
        await reply.code(500).send({ error: 'lookup_failed' });
        return;
      }
      if (!data) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      return data;
    },
  );
}
