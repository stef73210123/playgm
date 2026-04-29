import type { FastifyInstance } from 'fastify';
import { supabase } from '../db/client.js';
import { brandingFilter } from '../services/branding.js';
import { requireAuth } from '../middleware/auth.js';

export async function scoutingReportRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /scouting-report/:entityId
  fastify.get<{ Params: { entityId: string } }>(
    '/scouting-report/:entityId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { entityId } = req.params;

      const { data, error } = await supabase
        .from('scouting_reports')
        .select('*')
        .eq('external_id', entityId)
        .maybeSingle();

      if (error) return reply.code(500).send({ error: error.message });
      if (!data) return reply.code(404).send({ error: 'Entity not found' });

      return reply.send(brandingFilter(data));
    }
  );
}
