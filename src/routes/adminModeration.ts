/**
 * adminModeration.ts — admin moderation queue for kid-authored content.
 *
 * Two surfaces:
 *   1. Display nicknames (profiles.display_name)
 *   2. Roster team names (rosters.team_name)
 *
 * Both share the same three-state status machine (pending/approved/rejected)
 * persisted on the source row. This module is the operator UI:
 *
 *   - GET   /admin/edit/moderation-queue        → HTML editor
 *   - GET   /admin/api/moderation               → JSON list of pending+rejected
 *   - PATCH /admin/api/moderation/:type/:id     → manual override
 *
 * Auth: relies on the global /admin/* basic-auth gate installed by
 * installAdminAuth() at server boot. No extra checks here.
 *
 * Threat model is identical to /admin/edit/safety — tunnel-only access,
 * Stefan is the only operator. We deliberately don't add CSRF tokens
 * because the surface area is one form, one operator, no third-party
 * referrers.
 */

import type { FastifyInstance } from 'fastify';
import { supabase } from '../db/client.js';
import { SHARED_SORTABLE_JS } from './adminEdit.js';

type ModType = 'display_name' | 'team_name';

const ALLOWED_STATUSES = new Set(['approved', 'rejected', 'pending']);

interface DisplayNameRow {
  id: string;
  display_name: string | null;
  display_name_status: 'pending' | 'approved' | 'rejected';
  age: number | null;
  birth_year: number | null;
  username: string | null;
  updated_at: string;
}

interface TeamNameRow {
  id: string;
  team_name: string | null;
  team_name_status: 'pending' | 'approved' | 'rejected';
  user_id: string;
  name: string; // system default
  updated_at: string;
}

function ageBand(age: number | null): 'under_13' | '13_17' | '18_plus' | 'unknown' {
  if (typeof age !== 'number') return 'unknown';
  if (age < 13) return 'under_13';
  if (age <= 17) return '13_17';
  return '18_plus';
}

export async function adminModerationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // ─── HTML editor page ────────────────────────────────────────────────
  fastify.get('/admin/edit/moderation-queue', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderQueuePage();
  });

  // ─── JSON list — pending + rejected only ─────────────────────────────
  // We deliberately exclude approved entries from the queue: once
  // approved they're live for the kid, so re-surfacing them as
  // "manage approved nicknames" is a separate flow if/when needed.
  fastify.get('/admin/api/moderation', async (_req, reply) => {
    const [{ data: dn, error: dnErr }, { data: tn, error: tnErr }] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, display_name, display_name_status, age, birth_year, username, updated_at')
        .in('display_name_status', ['pending', 'rejected'])
        .not('display_name', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(500),
      supabase
        .from('rosters')
        .select('id, team_name, team_name_status, user_id, name, updated_at')
        .in('team_name_status', ['pending', 'rejected'])
        .not('team_name', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(500),
    ]);

    if (dnErr || tnErr) {
      reply.code(500).send({ ok: false, error: dnErr?.message ?? tnErr?.message });
      return reply;
    }

    const dnRows = (dn ?? []) as DisplayNameRow[];
    const tnRows = (tn ?? []) as TeamNameRow[];

    return {
      ok: true,
      display_names: dnRows.map((r) => {
        const age =
          r.age ??
          (typeof r.birth_year === 'number'
            ? new Date().getFullYear() - r.birth_year
            : null);
        return {
          type: 'display_name' as ModType,
          id: r.id,
          candidate: r.display_name,
          status: r.display_name_status,
          age_band: ageBand(age),
          age,
          username: r.username,
          submitted_at: r.updated_at,
        };
      }),
      team_names: tnRows.map((r) => ({
        type: 'team_name' as ModType,
        id: r.id,
        candidate: r.team_name,
        status: r.team_name_status,
        owner_id: r.user_id,
        default_name: r.name,
        submitted_at: r.updated_at,
      })),
    };
  });

  // ─── PATCH override ──────────────────────────────────────────────────
  fastify.patch<{ Params: { type: string; id: string } }>(
    '/admin/api/moderation/:type/:id',
    async (req, reply) => {
      const { type, id } = req.params;
      const body = (req.body ?? {}) as { status?: string };
      if (!body.status || !ALLOWED_STATUSES.has(body.status)) {
        reply.code(400).send({ ok: false, error: 'status required (pending|approved|rejected)' });
        return reply;
      }
      if (type !== 'display_name' && type !== 'team_name') {
        reply.code(400).send({ ok: false, error: 'type must be display_name or team_name' });
        return reply;
      }

      const status = body.status as 'pending' | 'approved' | 'rejected';
      if (type === 'display_name') {
        const { error } = await supabase
          .from('profiles')
          .update({ display_name_status: status })
          .eq('id', id);
        if (error) {
          reply.code(500).send({ ok: false, error: error.message });
          return reply;
        }
      } else {
        const { error } = await supabase
          .from('rosters')
          .update({ team_name_status: status })
          .eq('id', id);
        if (error) {
          reply.code(500).send({ ok: false, error: error.message });
          return reply;
        }
      }
      return { ok: true, type, id, status };
    },
  );
}

// ─── HTML renderer ─────────────────────────────────────────────────────
// Self-contained HTML (no build step). Mirrors the style of
// /admin/edit/safety so operator memory stays consistent across pages.

function renderQueuePage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>Moderation Queue · PlayGM Admin</title>
<style>
  body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; margin: 24px; color: #1a202c; background: #f7fafc; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { color: #718096; margin: 0 0 24px; }
  section { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #edf2f7; vertical-align: middle; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #4a5568; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: #2b6cb0; }
  th.sortable .sort-ind { display: inline-block; margin-left: 4px; opacity: 0.55; font-size: 10px; }
  th.sortable.sort-asc .sort-ind, th.sortable.sort-desc .sort-ind { opacity: 1; color: #2b6cb0; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
  .pill.pending  { background: #fefcbf; color: #744210; }
  .pill.rejected { background: #fed7d7; color: #742a2a; }
  .pill.approved { background: #c6f6d5; color: #22543d; }
  .pill.under_13 { background: #fed7e2; color: #702459; }
  .pill.\\31 3_17  { background: #bee3f8; color: #2a4365; }
  .pill.\\31 8_plus { background: #e9d8fd; color: #44337a; }
  .pill.unknown { background: #e2e8f0; color: #4a5568; }
  button { font-family: inherit; cursor: pointer; padding: 6px 12px; border-radius: 6px; border: 1px solid #cbd5e0; background: #fff; font-size: 12px; font-weight: 600; }
  button.approve { background: #48bb78; border-color: #2f855a; color: #fff; }
  button.reject  { background: #e53e3e; border-color: #9b2c2c; color: #fff; margin-left: 6px; }
  .empty { color: #a0aec0; font-style: italic; padding: 16px 0; }
  code { font-family: "SF Mono", Menlo, monospace; background: #edf2f7; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head><body>
<h1>Moderation Queue</h1>
<p class="sub">Pending and rejected nicknames + team names. Approve to make live, reject to keep hidden.</p>

<section>
  <h2>Display nicknames</h2>
  <div id="dn-list">Loading…</div>
</section>

<section>
  <h2>Team names</h2>
  <div id="tn-list">Loading…</div>
</section>

<script>
function pill(cls, label) {
  return '<span class="pill ' + cls + '">' + label + '</span>';
}
function row(item, type) {
  const id = item.id;
  const candidateRaw = item.candidate ?? '';
  const candidate = String(candidateRaw).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  const status = item.status;
  const ageBand = item.age_band ?? 'unknown';
  const meta = type === 'display_name'
    ? '<code>' + (item.username ?? '—') + '</code>'
    : 'default: <code>' + (item.default_name ?? '—') + '</code>';
  const candidateSort = String(candidateRaw).toLowerCase();
  const submittedTs = new Date(item.submitted_at).getTime() || 0;
  return '<tr>' +
    '<td data-sort-value="' + candidateSort + '"><strong>' + candidate + '</strong></td>' +
    '<td>' + meta + '</td>' +
    '<td data-sort-value="' + status + '">' + pill(status, status) + '</td>' +
    (type === 'display_name'
      ? '<td data-sort-value="' + ageBand + '">' + pill(ageBand, ageBand.replace('_', '-')) + '</td>'
      : '<td>—</td>') +
    '<td data-sort-value="' + submittedTs + '">' + new Date(item.submitted_at).toLocaleString() + '</td>' +
    '<td>' +
      '<button class="approve" data-id="' + id + '" data-type="' + type + '" data-status="approved">Approve</button>' +
      '<button class="reject"  data-id="' + id + '" data-type="' + type + '" data-status="rejected">Reject</button>' +
    '</td>' +
  '</tr>';
}
function table(items, type, label) {
  if (!items || items.length === 0) {
    return '<div class="empty">Nothing to review.</div>';
  }
  return '<table><thead><tr>' +
    '<th class="sortable">' + label + '</th>' +
    '<th>Context</th>' +
    '<th class="sortable">Status</th>' +
    '<th class="sortable">Age</th>' +
    '<th class="sortable">Submitted</th>' +
    '<th>Action</th>' +
  '</tr></thead><tbody>' + items.map(it => row(it, type)).join('') + '</tbody></table>';
}
async function load() {
  const r = await fetch('/admin/api/moderation');
  const j = await r.json();
  document.getElementById('dn-list').innerHTML = table(j.display_names, 'display_name', 'Nickname');
  document.getElementById('tn-list').innerHTML = table(j.team_names,    'team_name',    'Team name');
  document.querySelectorAll('button[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id, type = btn.dataset.type, status = btn.dataset.status;
      const r2 = await fetch('/admin/api/moderation/' + type + '/' + id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (r2.ok) load(); else alert('Update failed');
    });
  });
}
load();
</script>
<script>${SHARED_SORTABLE_JS}</script>
</body></html>`;
}
