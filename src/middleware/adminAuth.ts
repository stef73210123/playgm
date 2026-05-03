/**
 * adminAuth.ts — HTTP Basic Auth gate for /admin/* routes.
 *
 * Until 2026-05, the dashboard lived behind a rotating trycloudflare URL and
 * was effectively security-by-obscurity. With a stable production URL
 * (admin.playgm.app), we need real auth or anyone who guesses the host can
 * edit subscriptions, trade rules, SFX, and trigger simulations.
 *
 * Implementation: a Fastify onRequest hook that fires before any /admin route
 * resolves. It reads ADMIN_USER and ADMIN_PASSWORD from env. If either is
 * missing, behavior depends on NODE_ENV:
 *   - production → server refuses to register the gate and the registration
 *     call throws, blocking startup. We never want to ship an unprotected
 *     admin dashboard.
 *   - non-production → we log a loud warning and skip the gate entirely.
 *     This keeps `npm run dev` ergonomic without forcing developers to set
 *     credentials locally.
 *
 * The gate uses constant-time comparison to avoid timing-attack leaks on the
 * username, even though username enumeration isn't very valuable here.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

const REALM = 'PlayGM Admin';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still do a comparison to keep timing roughly constant.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
    .type('text/plain')
    .send('Authentication required');
}

export function installAdminAuth(server: FastifyInstance): void {
  const user = process.env['ADMIN_USER'];
  const pass = process.env['ADMIN_PASSWORD'];

  if (!user || !pass) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'ADMIN_USER and ADMIN_PASSWORD must be set in production. ' +
        'Refusing to start with an unprotected /admin dashboard.',
      );
    }
    server.log.warn(
      '[adminAuth] ADMIN_USER/ADMIN_PASSWORD not set — /admin/* is UNGATED in this dev session',
    );
    return;
  }

  server.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Only gate /admin/*. Everything else (mobile API, /health) passes through.
    if (!req.url.startsWith('/admin')) return;

    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('basic ')) {
      return unauthorized(reply);
    }

    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    } catch {
      return unauthorized(reply);
    }

    const sep = decoded.indexOf(':');
    if (sep < 0) return unauthorized(reply);

    const givenUser = decoded.slice(0, sep);
    const givenPass = decoded.slice(sep + 1);

    if (!safeEqual(givenUser, user) || !safeEqual(givenPass, pass)) {
      return unauthorized(reply);
    }

    // Authenticated — let the route handler run.
  });

  server.log.info('[adminAuth] /admin/* gated by HTTP Basic Auth');
}
