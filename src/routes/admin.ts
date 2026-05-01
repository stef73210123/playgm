/**
 * admin.ts — developer-facing dashboard for PlayGM.
 *
 * Two routes:
 *   GET /admin/status     → JSON aggregator (probes + counts).
 *   GET /admin/dashboard  → self-contained HTML page that polls /admin/status.
 *
 * Auth: none. The endpoints are intended to live behind the trycloudflare
 * tunnel and are surfaced only to Stefan.
 *
 * Resilience: every probe + count tolerates failure individually. A single
 * dead service or missing table does NOT cause /admin/status to return 500 —
 * each section degrades to { status: 'down' | 'unknown' } or unmeasured.
 */
import type { FastifyInstance } from 'fastify';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  probeAnthropic,
  probeElevenLabs,
  probeSupabase,
  probeSportsDb,
  probeWikimedia,
} from '../services/healthChecks.js';
import { getDataCorpus, getLastUpdated } from '../services/dataCorpus.js';
import {
  getUsersAndSessions,
  getGameplayCounters,
  getScoutVoiceStats,
} from '../services/supabaseAdmin.js';

function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, path.resolve(cwd, '..'), path.resolve(cwd, '..', '..')];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'cards', 'pgm_card_templates.json'))) return c;
  }
  return cwd;
}
const PROJECT_ROOT = findProjectRoot();

const SERVER_STARTED_AT = Date.now();

interface RouteListing {
  method: string;
  path: string;
  purpose: string;
  registered: boolean;
}

/**
 * Module-level registry populated by `installRouteTracker` (called from
 * index.ts before any route registration). Fastify's only public API for
 * walking routes at runtime is `printRoutes()` which returns a formatted
 * tree string — `onRoute` is the cleaner way to capture method/path pairs
 * structurally as routes register.
 */
const routeRegistry: { method: string; path: string }[] = [];
export function installRouteTracker(server: FastifyInstance): void {
  server.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      routeRegistry.push({ method: String(m).toUpperCase(), path: route.url });
    }
  });
}

const ROUTE_PURPOSES: Record<string, string> = {
  'GET /health': 'Liveness check',
  'POST /scout/ask': 'Scout LLM Q&A (Haiku 4.5)',
  'POST /voice/tts': 'Scout voice synthesis (ElevenLabs)',
  'POST /voice/stt': 'Scout voice transcription (ElevenLabs)',
  'POST /cards/scan': 'Card scanner via Claude vision',
  'POST /rosters/lock': 'Roster validation + lock',
  'GET /games/today': "Today's games board",
  'GET /games/yesterday': 'Yesterday recap board',
  'GET /trivia/today': 'Daily trivia question',
  'POST /trivia/answer': 'Submit trivia answer',
  'GET /scouting-report/:teamId': 'Team scouting report',
  'GET /highlights/:eventId': 'YouTube highlight reel for an event',
  'POST /draft/start': 'Start weekly draft event',
  'GET /alliances': 'Alliance listing',
  'GET /packs': 'Available packs',
  'POST /packs/open': 'Open a pack',
  'GET /leaderboard': 'Global leaderboard',
  'GET /contests': 'Contest listing',
  'POST /contests/enter': 'Enter contest',
  'GET /subscriptions/me': 'Subscription status',
  'GET /practice-drafts': 'Practice draft list',
  'GET /admin/status': 'Status aggregator (this dashboard)',
  'GET /admin/dashboard': 'Status dashboard HTML',
};

function pickPurpose(method: string, urlPath: string): string {
  const exact = ROUTE_PURPOSES[`${method} ${urlPath}`];
  if (exact) return exact;
  // Light heuristic — first path segment.
  const first = urlPath.split('/')[1] ?? '';
  const map: Record<string, string> = {
    profile: 'User profile',
    cards: 'Scout cards',
    draft: 'Draft flow',
    trivia: 'Trivia minigame',
    alliances: 'Alliances',
    packs: 'Pack economy',
    games: 'Games board',
    highlights: 'Highlight reels',
    rosters: 'Multi-roster',
    contests: 'Contests',
    subscriptions: 'Subscriptions',
    'practice-drafts': 'Practice drafts',
    leaderboard: 'Leaderboard',
    voice: 'Scout voice',
    scout: 'Scout LLM',
    'scouting-report': 'Scouting reports',
    admin: 'Admin endpoints',
  };
  return map[first] ?? 'Internal route';
}

function readGitHead(): { sha: string; subject: string; committed_at: string } | null {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT }).toString().trim();
    const subject = execSync('git log -1 --pretty=%s', { cwd: PROJECT_ROOT }).toString().trim();
    const committed_at = execSync('git log -1 --pretty=%cI', { cwd: PROJECT_ROOT }).toString().trim();
    return { sha, subject, committed_at };
  } catch {
    return null;
  }
}

function envPresence(name: string): 'present' | 'missing' {
  return process.env[name] ? 'present' : 'missing';
}

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/status', async () => {
    const [
      anthropic,
      elevenlabs,
      supabaseProbe,
      sportsdb,
      wikimedia,
      users,
      gameplay,
      scoutVoice,
    ] = await Promise.all([
      probeAnthropic(),
      probeElevenLabs(),
      probeSupabase(),
      probeSportsDb(),
      probeWikimedia(),
      getUsersAndSessions(),
      getGameplayCounters(),
      getScoutVoiceStats(),
    ]);

    const corpus = await getDataCorpus({ scoutVoiceLinesCount: scoutVoice.count });
    const lastUpdated = await getLastUpdated({ scoutVoiceDbLatest: scoutVoice.latest });

    // Walk the registered Fastify route table — populated by the onRoute
    // hook installed via installRouteTracker() at boot.
    const seen = new Set<string>();
    const internal_routes: RouteListing[] = [];
    for (const r of routeRegistry) {
      if (r.method === 'HEAD' || r.method === 'OPTIONS') continue;
      const k = `${r.method} ${r.path}`;
      if (seen.has(k)) continue;
      seen.add(k);
      internal_routes.push({
        method: r.method,
        path: r.path,
        purpose: pickPurpose(r.method, r.path),
        registered: true,
      });
    }
    internal_routes.sort((a, b) =>
      a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
    );

    return {
      generated_at: new Date().toISOString(),
      server: {
        uptime_seconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
        env: {
          NODE_ENV: process.env['NODE_ENV'] ?? 'development',
          ANTHROPIC_API_KEY: envPresence('ANTHROPIC_API_KEY'),
          ELEVENLABS_API_KEY: envPresence('ELEVENLABS_API_KEY'),
          ELEVENLABS_VOICE_ID: envPresence('ELEVENLABS_VOICE_ID'),
          SUPABASE_URL: envPresence('SUPABASE_URL'),
          SUPABASE_SERVICE_KEY: envPresence('SUPABASE_SERVICE_KEY'),
          SUPABASE_ANON_KEY: envPresence('SUPABASE_ANON_KEY'),
          SPORTSDB_V2_KEY: envPresence('SPORTSDB_V2_KEY'),
        },
      },
      external_services: {
        anthropic: {
          ...anthropic,
          purpose: "Scout's Takes (Haiku 4.5 LLM) + Card Scanner vision OCR",
          model: 'claude-haiku-4-5',
        },
        elevenlabs: {
          ...elevenlabs,
          purpose: "Scout's voice (TTS)",
          voice_id_configured: !!process.env['ELEVENLABS_VOICE_ID'],
        },
        supabase: {
          ...supabaseProbe,
          purpose: 'Primary DB + auth + storage',
          project_ref: extractSupabaseProjectRef(process.env['SUPABASE_URL']),
        },
        sportsdb_v2: {
          ...sportsdb,
          purpose: 'Live scores, schedules, team rosters',
        },
        wikimedia: {
          ...wikimedia,
          purpose: 'City scene images for player/team headers',
        },
      },
      internal_routes,
      users_and_sessions: users,
      gameplay_counters: gameplay,
      data_corpus: corpus,
      last_updated: {
        ...lastUpdated,
        git_head: readGitHead(),
      },
    };
  });

  fastify.get('/admin/dashboard', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return DASHBOARD_HTML;
  });
}

function extractSupabaseProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1]! : null;
}

// ─── HTML ─────────────────────────────────────────────────────────────────
// Self-contained: inline CSS + vanilla JS. Polls /admin/status every 30s.
const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PlayGM Status</title>
<style>
  :root {
    --bg: #0b0f17;
    --card: #131a26;
    --card-2: #1a2333;
    --text: #e6edf3;
    --muted: #8aa0b8;
    --accent: #6cd4ff;
    --green: #4ade80;
    --yellow: #facc15;
    --red: #f87171;
    --gray: #6b7280;
    --border: #1f2a3b;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.45;
    padding: 24px;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: 0.3px; }
  .meta { color: var(--muted); font-size: 13px; }
  .meta code { color: var(--accent); }
  .pills { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .pill {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; display: flex; align-items: center; gap: 10px;
  }
  .pill .dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; background: var(--gray); }
  .pill.up    .dot { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .pill.down  .dot { background: var(--red);   box-shadow: 0 0 8px var(--red); }
  .pill.unknown .dot { background: var(--yellow); box-shadow: 0 0 8px var(--yellow); }
  .pill .name { font-weight: 600; }
  .pill .latency { color: var(--muted); font-size: 12px; margin-left: auto; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px 18px; margin-bottom: 16px;
  }
  .card h2 { margin: 0 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--accent); }
  .kv { display: grid; grid-template-columns: minmax(160px, max-content) 1fr; gap: 4px 14px; font-size: 14px; }
  .kv .k { color: var(--muted); }
  .tile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
  .tile { background: var(--card-2); border-radius: 8px; padding: 10px 12px; }
  .tile .label { color: var(--muted); font-size: 12px; }
  .tile .value { font-size: 22px; font-weight: 600; }
  .tile .sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
  .tag.up { background: rgba(74,222,128,.15); color: var(--green); }
  .tag.down { background: rgba(248,113,113,.15); color: var(--red); }
  .tag.unknown { background: rgba(250,204,21,.15); color: var(--yellow); }
  .tag.present { background: rgba(74,222,128,.15); color: var(--green); }
  .tag.missing { background: rgba(248,113,113,.15); color: var(--red); }
  .tag.unmeasured { background: rgba(107,114,128,.2); color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  details { margin-top: 4px; }
  summary { cursor: pointer; color: var(--accent); font-size: 13px; padding: 4px 0; }
  pre { font-size: 12px; color: var(--muted); margin: 0; white-space: pre-wrap; word-break: break-word; }
  .err-banner { background: rgba(248,113,113,.1); border: 1px solid var(--red); color: var(--red); padding: 10px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
  @media (max-width: 720px) {
    body { padding: 14px; }
    .pills { grid-template-columns: 1fr 1fr; }
    .grid { grid-template-columns: 1fr; }
    .kv { grid-template-columns: 1fr; }
    .kv .k { margin-top: 4px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>PlayGM Status</h1>
    <div class="meta">
      auto-refresh in <code id="countdown">30</code>s ·
      last update <code id="last-update">—</code>
    </div>
  </header>

  <div id="error"></div>

  <section class="pills" id="pills"></section>

  <div class="grid">
    <div class="card" id="server-card">
      <h2>Server</h2>
      <div id="server-body">Loading…</div>
    </div>
    <div class="card" id="external-card">
      <h2>External Services</h2>
      <div id="external-body">Loading…</div>
    </div>
    <div class="card" id="users-card">
      <h2>Users &amp; Sessions</h2>
      <div id="users-body">Loading…</div>
    </div>
    <div class="card" id="gameplay-card">
      <h2>Gameplay</h2>
      <div id="gameplay-body">Loading…</div>
    </div>
    <div class="card" id="corpus-card">
      <h2>Data Corpus</h2>
      <div id="corpus-body">Loading…</div>
    </div>
    <div class="card" id="last-updated-card">
      <h2>Last Updated</h2>
      <div id="last-updated-body">Loading…</div>
    </div>
  </div>

  <div class="card" id="routes-card">
    <h2>Internal Routes</h2>
    <details>
      <summary>Show <span id="route-count">…</span> registered routes</summary>
      <div id="routes-body" style="margin-top:8px;">Loading…</div>
    </details>
  </div>
</div>

<script>
(() => {
  const POLL_MS = 30_000;
  let timer = null;
  let countdown = 30;

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmt(n) { return n == null ? '—' : Number.isInteger(n) ? n.toLocaleString() : n; }
  function relTime(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    const d = Date.now() - t;
    const s = Math.round(d / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function pillHtml(name, probe) {
    const status = probe?.status || 'unknown';
    const lat = probe?.latency_ms != null ? probe.latency_ms + 'ms' : '—';
    return \`<div class="pill \${status}">
      <span class="dot"></span>
      <span class="name">\${esc(name)}</span>
      <span class="latency">\${esc(lat)}</span>
    </div>\`;
  }

  function tagFor(value) {
    if (value === 'present' || value === 'missing') return \`<span class="tag \${value}">\${value}</span>\`;
    if (value === 'up' || value === 'down' || value === 'unknown') return \`<span class="tag \${value}">\${value}</span>\`;
    return esc(value);
  }

  function renderProbeKv(name, p) {
    const tag = \`<span class="tag \${p.status}">\${p.status}</span>\`;
    const extras = [];
    if (p.purpose) extras.push(\`<div class="kv"><span class="k">purpose</span><span>\${esc(p.purpose)}</span></div>\`);
    if (p.model)   extras.push(\`<div class="kv"><span class="k">model</span><span>\${esc(p.model)}</span></div>\`);
    if (p.project_ref) extras.push(\`<div class="kv"><span class="k">project</span><span><code>\${esc(p.project_ref)}</code></span></div>\`);
    if (p.voice_id_configured != null) extras.push(\`<div class="kv"><span class="k">voice id</span><span>\${p.voice_id_configured ? 'configured' : 'default'}</span></div>\`);
    if (p.error) extras.push(\`<div class="kv"><span class="k">error</span><span><code>\${esc(p.error)}</code></span></div>\`);
    return \`
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <strong>\${esc(name)}</strong>\${tag}
        <span style="color:var(--muted);font-size:12px;">\${p.latency_ms ?? '—'}ms · \${relTime(p.last_checked_at)}</span>
      </div>
      \${extras.join('')}
    \`;
  }

  function tileHtml(label, c, sub) {
    if (c && typeof c === 'object' && 'value' in c) {
      const v = c.value;
      const unmeasured = c.unmeasured;
      return \`<div class="tile">
        <div class="label">\${esc(label)}</div>
        <div class="value">\${unmeasured ? '—' : fmt(v)}</div>
        <div class="sub">\${esc(unmeasured ? 'unmeasured' : (sub || ''))}</div>
      </div>\`;
    }
    return \`<div class="tile">
      <div class="label">\${esc(label)}</div>
      <div class="value">\${fmt(c)}</div>
      <div class="sub">\${esc(sub || '')}</div>
    </div>\`;
  }

  function render(s) {
    el('last-update').textContent = new Date(s.generated_at).toLocaleTimeString();

    // Top pills
    el('pills').innerHTML = [
      pillHtml('Anthropic',  s.external_services.anthropic),
      pillHtml('ElevenLabs', s.external_services.elevenlabs),
      pillHtml('Supabase',   s.external_services.supabase),
      pillHtml('SportsDB',   s.external_services.sportsdb_v2),
    ].join('');

    // Server card
    const env = s.server.env;
    const envRows = Object.keys(env).filter(k => k !== 'NODE_ENV').map(k =>
      \`<div class="kv"><span class="k">\${esc(k)}</span><span>\${tagFor(env[k])}</span></div>\`
    ).join('');
    const git = s.last_updated.git_head;
    el('server-body').innerHTML = \`
      <div class="kv"><span class="k">NODE_ENV</span><span><code>\${esc(env.NODE_ENV)}</code></span></div>
      <div class="kv"><span class="k">uptime</span><span>\${esc(formatUptime(s.server.uptime_seconds))}</span></div>
      \${git ? \`
        <div class="kv"><span class="k">git head</span><span><code>\${esc(git.sha.slice(0,12))}</code> · <span style="color:var(--muted)">\${esc(git.subject)}</span></span></div>
        <div class="kv"><span class="k">committed</span><span>\${esc(relTime(git.committed_at))}</span></div>
      \` : ''}
      <div style="margin:10px 0 4px;color:var(--muted);font-size:12px;">env presence</div>
      \${envRows}
    \`;

    // External services
    const ex = s.external_services;
    el('external-body').innerHTML = [
      ['Anthropic',   ex.anthropic],
      ['ElevenLabs',  ex.elevenlabs],
      ['Supabase',    ex.supabase],
      ['SportsDB v2', ex.sportsdb_v2],
      ['Wikimedia',   ex.wikimedia],
    ].map(([n, p]) => \`<div style="margin-bottom:10px;">\${renderProbeKv(n, p)}</div>\`).join('');

    // Users & sessions
    const u = s.users_and_sessions;
    const subs = u.subscriptions_by_tier || {};
    el('users-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('users (total)',     u.user_count)}
        \${tileHtml('signed up today',   u.users_signed_up_today)}
        \${tileHtml('signed up 7d',      u.users_signed_up_7d)}
        \${tileHtml('signed up 30d',     u.users_signed_up_30d)}
        \${tileHtml('active sessions 24h', u.active_sessions_24h)}
      </div>
      <div style="margin-top:10px;color:var(--muted);font-size:12px;">subscriptions by tier</div>
      <div class="tile-grid">
        \${u.subscriptions_by_tier
          ? ['free','starter','playmaker','champion'].map(t => tileHtml(t, subs[t] ?? 0)).join('')
          : '<div class="tile"><div class="value">—</div><div class="sub">unmeasured</div></div>'
        }
      </div>
    \`;

    // Gameplay
    const g = s.gameplay_counters;
    el('gameplay-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('rosters created', g.rosters_created)}
        \${tileHtml('cards owned', g.cards_owned)}
        \${tileHtml('packs opened', g.packs_opened)}
        \${tileHtml('trivia answered', g.trivia_questions_answered)}
        \${tileHtml('trivia correct %', g.trivia_correct_pct, '%')}
        \${tileHtml('play picks', g.play_picks_made)}
        \${tileHtml('play picks correct %', g.play_picks_correct_pct, '%')}
        \${tileHtml('card scans', g.card_scans_attempted)}
        \${tileHtml('scans matched', g.card_scans_matched)}
      </div>
    \`;

    // Data corpus
    const c = s.data_corpus;
    const trivBy = Object.entries(c.trivia_by_sport || {}).map(([k,v]) => \`\${k}: \${v}\`).join(' · ');
    el('corpus-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('trivia questions', c.trivia_questions_total, trivBy)}
        \${tileHtml('card templates', c.card_templates)}
        \${tileHtml('pack defs', c.card_pack_definitions)}
        \${tileHtml('triggers', c.trigger_definitions)}
        \${tileHtml('stat-resolution sports', c.stat_resolution_sports)}
        \${tileHtml('city scenes', c.city_scenes)}
        \${tileHtml('teams', c.team_count)}
        \${tileHtml('NFL stat-cache players', c.nfl_players_in_stat_cache)}
        \${tileHtml('stat-tier files', c.stat_tier_files)}
        \${tileHtml('tier rows', c.tier_levels)}
        \${tileHtml('scout voice lines', c.scout_voice_lines_seeded)}
      </div>
      \${c.notes && c.notes.length ? \`<div style="margin-top:8px;color:var(--yellow);font-size:12px;">⚠ \${c.notes.map(esc).join(' · ')}</div>\` : ''}
    \`;

    // Last updated
    const lu = s.last_updated;
    const rows = [
      ['scenes.json',        lu.scenes_json],
      ['trivia (basketball)', lu.trivia_questions],
      ['card templates',     lu.card_templates],
      ['NFL stat-cache',     lu.stat_cache_nfl],
      ['scout_voice (db)',   lu.scout_voice_db_latest],
    ];
    el('last-updated-body').innerHTML = rows.map(([k, v]) =>
      \`<div class="kv"><span class="k">\${esc(k)}</span><span>\${v ? \`<code>\${esc(new Date(v).toLocaleString())}</code> · <span style="color:var(--muted)">\${esc(relTime(v))}</span>\` : '<span class="tag unmeasured">unmeasured</span>'}</span></div>\`
    ).join('');

    // Routes
    const routes = s.internal_routes || [];
    el('route-count').textContent = routes.length;
    el('routes-body').innerHTML = \`<table>
      <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
      <tbody>
        \${routes.map(r => \`<tr>
          <td><code>\${esc(r.method)}</code></td>
          <td><code>\${esc(r.path)}</code></td>
          <td style="color:var(--muted)">\${esc(r.purpose)}</td>
        </tr>\`).join('')}
      </tbody>
    </table>\`;
  }

  function formatUptime(s) {
    if (s == null) return '—';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return \`\${d}d \${h}h \${m}m\`;
    if (h) return \`\${h}h \${m}m\`;
    return \`\${m}m \${s % 60}s\`;
  }

  async function load() {
    try {
      const res = await fetch('/admin/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      el('error').innerHTML = '';
      render(json);
    } catch (err) {
      el('error').innerHTML = \`<div class="err-banner">Failed to load /admin/status: \${esc(err.message)}</div>\`;
    }
    countdown = 30;
  }

  function tick() {
    countdown -= 1;
    if (countdown < 0) countdown = 0;
    el('countdown').textContent = countdown;
  }

  load();
  setInterval(load, POLL_MS);
  setInterval(tick, 1000);
})();
</script>
</body>
</html>
`;
