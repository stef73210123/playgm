import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

function generateInviteCode(): string {
  const words = ['FOX', 'WIN', 'ACE', 'TOP', 'PRO', 'MVP', 'ALL', 'BIG', 'GLD', 'CHM'];
  const a = words[Math.floor(Math.random() * words.length)]!;
  const num = Math.floor(Math.random() * 900 + 100); // 100–999
  const b = words[Math.floor(Math.random() * words.length)]!;
  return `${a}-${num}-${b}`;
}

export async function alliancesRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /alliances
  const createSchema = z.object({ name: z.string().min(1).max(40) });

  fastify.post('/alliances', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const inviteCode = generateInviteCode();

    const { data: alliance, error: allianceErr } = await supabase
      .from('alliances')
      .insert({ name: parsed.data.name, invite_code: inviteCode })
      .select()
      .single();

    if (allianceErr) return reply.code(500).send({ error: allianceErr.message });

    // Set creator's alliance_id
    await supabase
      .from('profiles')
      .update({ alliance_id: (alliance as Record<string, unknown>)['id'] })
      .eq('id', profileId);

    return reply.code(201).send(brandingFilter(alliance));
  });

  // POST /alliances/join
  const joinSchema = z.object({ inviteCode: z.string().min(1) });

  fastify.post('/alliances/join', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { data: alliance, error: allianceErr } = await supabase
      .from('alliances')
      .select('id, max_members')
      .eq('invite_code', parsed.data.inviteCode)
      .maybeSingle();

    if (allianceErr) return reply.code(500).send({ error: allianceErr.message });
    if (!alliance) return reply.code(404).send({ error: 'Invalid invite code' });

    const allianceData = alliance as Record<string, unknown>;

    // Count current members
    const { count } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('alliance_id', allianceData['id']);

    if ((count ?? 0) >= (allianceData['max_members'] as number)) {
      return reply.code(409).send({ error: 'Alliance is full (max 10 members)' });
    }

    await supabase
      .from('profiles')
      .update({ alliance_id: allianceData['id'] })
      .eq('id', profileId);

    return reply.send(brandingFilter({ joined: true, allianceId: allianceData['id'] }));
  });

  // GET /alliances/current
  fastify.get('/alliances/current', { preHandler: requireAuth }, async (req, reply) => {
    const { profileId } = req as AuthenticatedRequest;

    const { data: profile } = await supabase
      .from('profiles')
      .select('alliance_id')
      .eq('id', profileId)
      .single();

    const profileData = profile as Record<string, unknown> | null;
    if (!profileData?.['alliance_id']) {
      return reply.code(404).send({ error: 'Not in an alliance' });
    }

    const { data: alliance, error } = await supabase
      .from('alliances')
      .select('*')
      .eq('id', profileData['alliance_id'])
      .single();

    if (error) return reply.code(500).send({ error: error.message });

    const { data: members } = await supabase
      .from('profiles')
      .select('id, handle, level, gm_grade, play_points')
      .eq('alliance_id', profileData['alliance_id']);

    return reply.send(brandingFilter({ alliance, members: members ?? [] }));
  });
}
