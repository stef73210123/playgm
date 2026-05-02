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
import { createReadStream, existsSync, statSync } from 'node:fs';
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
import { getEconomicMetrics } from '../services/economicMetrics.js';
import { getEconomicTargets } from '../services/economicTargets.js';
import { getAdvertisingReport } from '../services/advertising.js';
import { getDataPipelinesStatus } from '../jobs/refreshStats.js';
import { getHighlightsCoverage } from '../services/highlightsCoverage.js';
import {
  getSafetyMatrixSummary,
  loadSafetyMatrix,
} from '../services/safetyMatrix.js';

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
  'GET /admin/api/economic-metrics': 'Live economic metrics (PP, packs, cards, subs, retention)',
  'GET /admin/edit/advertising': 'Advertising actuals editor',
  'GET /admin/api/advertising': 'Advertising report (all channels)',
  'GET /admin/edit/safety': 'Per-age safety/feature matrix editor',
  'GET /admin/api/safety-matrix': 'Per-age safety/feature matrix (full)',
  'GET /admin/docs/:slot': 'Serve admin docs (GDD, business plan, financial model)',
  'GET /admin/api/docs': 'Admin docs presence + slot metadata',
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
      economicMetrics,
    ] = await Promise.all([
      probeAnthropic(),
      probeElevenLabs(),
      probeSupabase(),
      probeSportsDb(),
      probeWikimedia(),
      getUsersAndSessions(),
      getGameplayCounters(),
      getScoutVoiceStats(),
      getEconomicMetrics(),
    ]);
    const economicTargets = getEconomicTargets();
    const advertising = getAdvertisingReport();
    let safetyMatrixSummary: ReturnType<typeof getSafetyMatrixSummary> | null;
    try {
      safetyMatrixSummary = getSafetyMatrixSummary();
    } catch {
      // Tolerate a missing/broken matrix file — same posture as other probes.
      safetyMatrixSummary = null;
    }

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
      economic_metrics: economicMetrics,
      economic_targets: economicTargets,
      advertising,
      safety_matrix: safetyMatrixSummary,
      data_pipelines: getDataPipelinesStatus(),
    };
  });


  fastify.get('/admin/api/advertising', async () => {
    return {
      generated_at: new Date().toISOString(),
      ...getAdvertisingReport(),
    };
  });

  fastify.get('/admin/api/economic-metrics', async () => {
    const [metrics, targets] = await Promise.all([
      getEconomicMetrics(),
      Promise.resolve(getEconomicTargets()),
    ]);
    return {
      generated_at: new Date().toISOString(),
      economic_metrics: metrics,
      economic_targets: targets,
    };
  });

  fastify.get('/admin/api/highlights-coverage', async () => {
    return await getHighlightsCoverage();
  });

  // ─── Admin Documents ─────────────────────────────────────────────────────
  // Serves GDD, business plan, and financial model from docs/admin/.
  // Each slot maps to a base filename; we auto-detect the extension by
  // preference order so Stefan can drop in a .pdf, .xlsx, .docx, or .md
  // without re-wiring the route. If nothing is present we return a friendly
  // 404 with the path to drop a replacement at.
  const DOC_SLOTS: Record<string, { base: string; exts: string[] }> = {
    gdd: { base: 'GDD', exts: ['pdf', 'docx', 'md'] },
    'business-plan': { base: 'business-plan', exts: ['pdf', 'docx', 'md'] },
    'financial-model': { base: 'financial-model', exts: ['xlsx', 'pdf', 'docx', 'md'] },
  };

  const DOC_CONTENT_TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    md: 'text/markdown; charset=utf-8',
  };

  function findDocFile(slot: keyof typeof DOC_SLOTS): { ext: string; abs: string } | null {
    const def = DOC_SLOTS[slot];
    if (!def) return null;
    const dir = path.join(PROJECT_ROOT, 'docs', 'admin');
    for (const ext of def.exts) {
      const abs = path.join(dir, `${def.base}.${ext}`);
      if (existsSync(abs) && statSync(abs).isFile()) {
        return { ext, abs };
      }
    }
    return null;
  }

  fastify.get<{ Params: { slot: string } }>('/admin/docs/:slot', async (req, reply) => {
    const slot = String(req.params.slot ?? '').toLowerCase() as keyof typeof DOC_SLOTS;
    const def = DOC_SLOTS[slot];
    if (!def) {
      reply.code(404).type('text/plain; charset=utf-8');
      return `Unknown document slot: ${slot}\n\nValid slots: ${Object.keys(DOC_SLOTS).join(', ')}`;
    }
    const found = findDocFile(slot);
    if (!found) {
      reply.code(404).type('text/plain; charset=utf-8');
      return (
        `Document not found.\n\n` +
        `Drop the current ${slot} file at one of:\n` +
        def.exts.map((e) => `  docs/admin/${def.base}.${e}`).join('\n') +
        `\n\nThe admin dashboard tile auto-detects the extension.\n`
      );
    }
    const contentType = DOC_CONTENT_TYPES[found.ext] ?? 'application/octet-stream';
    reply.type(contentType);
    return reply.send(createReadStream(found.abs));
  });

  fastify.get('/admin/api/docs', async () => {
    const out: Record<string, { present: boolean; ext: string | null; url: string }> = {};
    for (const slot of Object.keys(DOC_SLOTS) as Array<keyof typeof DOC_SLOTS>) {
      const found = findDocFile(slot);
      out[slot] = {
        present: !!found,
        ext: found?.ext ?? null,
        url: `/admin/docs/${slot}`,
      };
    }
    return { docs: out };
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
  .doc-tile {
    background: var(--card-2); border-radius: 8px; padding: 12px 14px;
    text-decoration: none; color: var(--text); display: block;
    border: 1px solid transparent; transition: border-color 120ms ease, transform 120ms ease;
  }
  .doc-tile:hover { border-color: var(--accent); transform: translateY(-1px); }
  .doc-tile .label { color: var(--muted); font-size: 12px; }
  .doc-tile .value { font-size: 20px; font-weight: 600; color: var(--accent); }
  .doc-tile .sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .doc-tile.missing .value { color: var(--muted); }
  .doc-tile.missing .sub { color: var(--yellow); }
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
  .status-pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .status-pill.ok    { background: rgba(74,222,128,.15);  color: var(--green);  }
  .status-pill.warn  { background: rgba(250,204,21,.15);  color: var(--yellow); }
  .status-pill.fail  { background: rgba(248,113,113,.15); color: var(--red);    }
  .status-pill.unmeas{ background: rgba(107,114,128,.2);  color: var(--muted);  }
  abbr[title] { text-decoration: dotted underline; cursor: help; }
  .mini-bar-row { display: grid; grid-template-columns: 96px 1fr 56px; gap: 8px; align-items: center; font-size: 12px; margin: 2px 0; }
  .mini-bar-row .label { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mini-bar-row .bar { background: var(--card-2); border-radius: 4px; height: 10px; overflow: hidden; position: relative; }
  .mini-bar-row .bar-fill { background: var(--accent); height: 100%; }
  .mini-bar-row .val { color: var(--text); text-align: right; font-variant-numeric: tabular-nums; }
  .pity-warn { color: var(--yellow); font-weight: 600; }
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

  <nav style="margin: 0 0 16px; font-size: 13px; color: var(--muted);">
    Editors:
    <a href="/admin/edit/players" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Players</a>·
    <a href="/admin/edit/teams"   style="color: var(--accent); text-decoration: none; margin: 0 4px;">Teams</a>·
    <a href="/admin/edit/cards"   style="color: var(--accent); text-decoration: none; margin: 0 4px;">Card templates</a>·
    <a href="/admin/edit/trivia"  style="color: var(--accent); text-decoration: none; margin: 0 4px;">Trivia</a>·
    <a href="/admin/edit/advertising" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Advertising</a>·
    <a href="/admin/edit/safety" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Safety matrix</a>·
    <a href="/admin/edit/packs" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Packs</a>·
    <a href="/admin/edit/earn-rates" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Earn rates</a>·
    <a href="/admin/edit/subscriptions" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Subscriptions</a>·
    <a href="/admin/edit/streaks" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Streaks</a>·
    <a href="/admin/edit/triggers" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Triggers</a>·
    <a href="/admin/edit/stat-resolution" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Stat resolution</a>·
    <a href="/admin/edit/pity" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Pity</a>·
    <a href="/admin/edit/progression" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Progression</a>·
    <a href="/admin/edit/scoring" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Scoring</a>·
    <a href="/admin/simulate" style="color: var(--accent); text-decoration: none; margin: 0 4px;">Simulate</a>
  </nav>

  <div id="error"></div>

  <div class="card" id="documents-card">
    <h2>Documents</h2>
    <div class="tile-grid">
      <a class="doc-tile" id="doc-tile-gdd" href="/admin/docs/gdd" target="_blank" rel="noopener">
        <div class="label">Game Design Document</div>
        <div class="value">GDD</div>
        <div class="sub" id="doc-sub-gdd">—</div>
      </a>
      <a class="doc-tile" id="doc-tile-business-plan" href="/admin/docs/business-plan" target="_blank" rel="noopener">
        <div class="label">Business Plan</div>
        <div class="value">Plan</div>
        <div class="sub" id="doc-sub-business-plan">—</div>
      </a>
      <a class="doc-tile" id="doc-tile-financial-model" href="/admin/docs/financial-model" target="_blank" rel="noopener">
        <div class="label">Financial Model</div>
        <div class="value">Model</div>
        <div class="sub" id="doc-sub-financial-model">—</div>
      </a>
    </div>
  </div>

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

  <h2 style="margin: 28px 0 12px; font-size: 16px; letter-spacing: 0.4px; color: var(--accent); text-transform: uppercase;">Economic Metrics</h2>
  <div class="grid">
    <div class="card" id="econ-pp-card">
      <h2>PP Flywheel</h2>
      <div id="econ-pp-body">Loading…</div>
    </div>
    <div class="card" id="econ-packs-card">
      <h2>Packs</h2>
      <div id="econ-packs-body">Loading…</div>
    </div>
    <div class="card" id="econ-cards-card">
      <h2>Card Inventory</h2>
      <div id="econ-cards-body">Loading…</div>
    </div>
    <div class="card" id="econ-subs-card">
      <h2>Subscription Mix</h2>
      <div id="econ-subs-body">Loading…</div>
    </div>
    <div class="card" id="econ-askscout-card">
      <h2>Ask Scout Usage</h2>
      <div id="econ-askscout-body">Loading…</div>
    </div>
    <div class="card" id="econ-cardscan-card">
      <h2>Card Scan Usage</h2>
      <div id="econ-cardscan-body">Loading…</div>
    </div>
    <div class="card" id="econ-rosters-card">
      <h2>Roster Activity</h2>
      <div id="econ-rosters-body">Loading…</div>
    </div>
    <div class="card" id="econ-engage-card">
      <h2>Engagement</h2>
      <div id="econ-engage-body">Loading…</div>
    </div>
  </div>
  <div class="card" id="econ-targets-card">
    <h2>Targets vs Actuals</h2>
    <div id="econ-targets-body">Loading…</div>
  </div>

  <h2 style="margin: 28px 0 12px; font-size: 16px; letter-spacing: 0.4px; color: var(--accent); text-transform: uppercase;">Advertising</h2>
  <div class="card" id="ad-portfolio-card">
    <h2>Portfolio</h2>
    <div id="ad-portfolio-body">Loading…</div>
  </div>
  <div class="card" id="ad-funnel-card">
    <h2>Conversion Funnel (30d)</h2>
    <div id="ad-funnel-body">Loading…</div>
  </div>
  <div class="card" id="ad-channels-card">
    <h2>Channels</h2>
    <div id="ad-channels-body">Loading…</div>
  </div>

  <h2 style="margin: 28px 0 12px; font-size: 16px; letter-spacing: 0.4px; color: var(--accent); text-transform: uppercase;">Safety Matrix</h2>
  <div class="card" id="safety-matrix-card">
    <h2>Per-Age Feature &amp; Settings Matrix</h2>
    <div id="safety-matrix-body">Loading…</div>
  </div>

  <h2 style="margin: 28px 0 12px; font-size: 16px; letter-spacing: 0.4px; color: var(--accent); text-transform: uppercase;">Data Pipelines</h2>
  <div class="card" id="data-pipelines-card">
    <h2>Per-League Refresh Status</h2>
    <div id="data-pipelines-body">Loading…</div>
  </div>
  <div class="card" id="highlights-coverage-card">
    <h2>Highlights (TheSportsDB)</h2>
    <div id="highlights-coverage-body">Loading…</div>
  </div>
  <div class="card" id="ratings-distribution-card">
    <h2>Rating Distribution</h2>
    <div id="ratings-distribution-body">Loading…</div>
  </div>

  <h2 style="margin: 28px 0 12px; font-size: 16px; letter-spacing: 0.4px; color: var(--accent); text-transform: uppercase;">Fairness Simulation</h2>
  <div class="card" id="simulation-card">
    <h2>Last Run + Fairness Trend</h2>
    <div id="simulation-body">Loading…</div>
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

    // ─── Economic Metrics ────────────────────────────────────────────────
    renderEconomic(s.economic_metrics || {}, s.economic_targets || {});

    // ─── Advertising ─────────────────────────────────────────────────────
    renderAdvertising(s.advertising || {});

    // ─── Safety Matrix ───────────────────────────────────────────────────
    renderSafetyMatrix(s.safety_matrix);

    // ─── Data Pipelines (live ingestion) ─────────────────────────────────
    renderDataPipelines(s.data_pipelines || {});

    // ─── Highlights coverage (TheSportsDB premium pull) ──────────────────
    renderHighlightsCoverage();

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

  function metricVal(c) {
    if (c == null) return null;
    if (typeof c === 'object' && 'value' in c) return c.unmeasured ? null : c.value;
    return c;
  }
  function metricCell(c, suffix) {
    if (c == null) return '<span class="tag unmeasured">—</span>';
    if (typeof c === 'object' && 'value' in c) {
      if (c.unmeasured) return '<abbr title="' + esc(c.error || 'unmeasured') + '"><span class="tag unmeasured">unmeasured</span></abbr>';
      return fmt(c.value) + (suffix || '');
    }
    return fmt(c) + (suffix || '');
  }
  function miniBar(label, value, max, valStr) {
    const v = value == null ? 0 : value;
    const pctW = max > 0 ? Math.min(100, Math.round((v / max) * 100)) : 0;
    return \`<div class="mini-bar-row">
      <span class="label">\${esc(label)}</span>
      <span class="bar"><span class="bar-fill" style="width:\${pctW}%"></span></span>
      <span class="val">\${esc(valStr ?? fmt(v))}</span>
    </div>\`;
  }
  function statusPill(actual, low, high) {
    if (actual == null) return '<span class="status-pill unmeas">—</span>';
    if (actual >= low && actual <= high) return '<span class="status-pill ok">✅ in range</span>';
    const margin = (high - low) * 0.15;
    if (actual >= low - margin && actual <= high + margin) return '<span class="status-pill warn">⚠ near edge</span>';
    return '<span class="status-pill fail">❌ out of range</span>';
  }

  function renderEconomic(m, t) {
    // ── PP Flywheel ────────────────────────────────────────────────────
    const pp = m.pp || {};
    const dist = (pp.distribution_by_tier && pp.distribution_by_tier.value) || {};
    const tiers = ['Peewee','Travel','JV','Varsity','Semi-Pro','Pro','Starter','All-Star','MVP','Champion','Hall of Famer','Legend','GOAT'];
    const maxTier = Math.max(1, ...tiers.map(t => dist[t] ?? 0));
    const distHtml = pp.distribution_by_tier && pp.distribution_by_tier.unmeasured
      ? '<abbr title="' + esc(pp.distribution_by_tier.error || '') + '"><span class="tag unmeasured">unmeasured</span></abbr>'
      : tiers.map(t => miniBar(t, dist[t] ?? 0, maxTier)).join('');
    el('econ-pp-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('lifetime PP', pp.total_earned_lifetime)}
        \${tileHtml('PP earned 24h', pp.total_earned_24h)}
        \${tileHtml('PP earned 7d', pp.total_earned_7d)}
        \${tileHtml('median PP/user', pp.median_pp_per_user)}
        \${tileHtml('p90 PP/user', pp.p90_pp_per_user)}
        \${tileHtml('avg daily/active', pp.avg_daily_earn_per_active_user)}
      </div>
      <div style="margin-top:10px;color:var(--muted);font-size:12px;">distribution by tier (\${esc(tiers.length)} levels)</div>
      <div style="margin-top:6px;">\${distHtml}</div>
    \`;

    // ── Packs ──────────────────────────────────────────────────────────
    const packs = m.packs || {};
    const ldro = packs.legendary_drop_rate_observed || {};
    const ldrt = (t.cards && t.cards.legendary_drop_rates) || {};
    function dropRow(tierKey, label) {
      const obs = ldro[tierKey];
      const tgt = ldrt[tierKey];
      const obsVal = (obs && !obs.unmeasured) ? obs.value : null;
      const tgtVal = tgt ? tgt.current : null;
      const obsStr = obs && obs.unmeasured
        ? '<abbr title="' + esc(obs.error || '') + '"><span class="tag unmeasured">unmeasured</span></abbr>'
        : (obsVal != null ? obsVal.toFixed(1) + '%' : '—');
      return \`<div class="kv">
        <span class="k">\${esc(label)}</span>
        <span>obs \${obsStr} · tgt \${tgtVal != null ? (tgtVal*100).toFixed(0) + '%' : '—'} <abbr title="\${esc(tgt && tgt.source || '')}">ⓘ</abbr></span>
      </div>\`;
    }
    el('econ-packs-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('rookie 30d', packs.rookie_pack_opens_30d)}
        \${tileHtml('pro 30d', packs.pro_pack_opens_30d)}
        \${tileHtml('all-star 30d', packs.all_star_pack_opens_30d)}
        \${tileHtml('mvp 30d', packs.mvp_pack_opens_30d)}
        \${tileHtml('goat 30d', packs.goat_pack_opens_30d)}
        \${tileHtml('avg/active 30d', packs.avg_packs_per_active_user_30d)}
      </div>
      <div style="margin-top:10px;color:var(--muted);font-size:12px;">legendary drop rate · observed vs target</div>
      \${dropRow('pro_pack', 'Pro Pack')}
      \${dropRow('all_star_pack', 'All-Star Pack')}
      \${dropRow('mvp_pack', 'MVP Pack')}
      \${dropRow('goat_pack', 'GOAT Pack')}
    \`;

    // ── Cards ──────────────────────────────────────────────────────────
    const cards = m.cards || {};
    const rarityDist = (cards.cards_by_rarity && cards.cards_by_rarity.value) || {};
    const rarities = ['common','uncommon','rare','epic','legendary'];
    const maxRar = Math.max(1, ...rarities.map(r => rarityDist[r] ?? 0));
    const rarityHtml = cards.cards_by_rarity && cards.cards_by_rarity.unmeasured
      ? '<abbr title="' + esc(cards.cards_by_rarity.error || '') + '"><span class="tag unmeasured">unmeasured</span></abbr>'
      : rarities.map(r => miniBar(r, rarityDist[r] ?? 0, maxRar)).join('');
    const pityPctVal = metricVal(cards.legendary_pity_pct);
    const pityPctTarget = (t.cards && t.cards.legendary_pity_user_pct_target && t.cards.legendary_pity_user_pct_target.max) || 0.05;
    const pityWarn = (pityPctVal != null && pityPctVal > pityPctTarget * 100);
    el('econ-cards-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('cards in circ', cards.total_cards_in_circulation)}
        \${tileHtml('avg cards/user', cards.avg_cards_per_user)}
        \${tileHtml('pity users at threshold', cards.pity_users_at_threshold)}
      </div>
      <div style="margin-top:10px;color:var(--muted);font-size:12px;">cards by rarity (5-rarity GDD spec; uncommon+epic schema-pending)</div>
      <div style="margin-top:6px;">\${rarityHtml}</div>
      <div class="kv" style="margin-top:8px;">
        <span class="k">legendary pity %</span>
        <span class="\${pityWarn ? 'pity-warn' : ''}">\${metricCell(cards.legendary_pity_pct, '%')} <abbr title="GDD card-system §12 — should affect <\${(pityPctTarget*100).toFixed(0)}% of users">target ≤\${(pityPctTarget*100).toFixed(0)}%</abbr></span>
      </div>
    \`;

    // ── Subscriptions ──────────────────────────────────────────────────
    const subs = m.subscriptions || {};
    const subDist = (subs.by_tier && subs.by_tier.value) || {};
    const subList = ['free','starter','playmaker','champion'];
    const subTotal = subList.reduce((acc, k) => acc + (subDist[k] ?? 0), 0) || 1;
    const subRows = subs.by_tier && subs.by_tier.unmeasured
      ? '<abbr title="' + esc(subs.by_tier.error || '') + '"><span class="tag unmeasured">unmeasured</span></abbr>'
      : subList.map(k => {
          const v = subDist[k] ?? 0;
          const p = Math.round((v / subTotal) * 100);
          return miniBar(k, v, subTotal, v + ' (' + p + '%)');
        }).join('');
    el('econ-subs-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('paid %', subs.paid_pct, '%')}
        \${tileHtml('MRR estimate', subs.monthly_revenue_estimate_usd, ' USD')}
        \${tileHtml('ARPU', subs.arpu_usd, ' USD')}
        \${tileHtml('ARPPU', subs.arppu_usd, ' USD')}
      </div>
      <div style="margin-top:10px;color:var(--muted);font-size:12px;">tier mix</div>
      <div style="margin-top:6px;">\${subRows}</div>
    \`;

    // ── Ask Scout Usage ────────────────────────────────────────────────
    // The cap-hit rate per tier is the primary upgrade-pressure signal.
    // free_users_capped_today is the conversion-funnel KPI we'll watch
    // as Free→Starter conversions ship.
    const ask = m.ask_scout || {};
    const askByTier = (ask.calls_24h_by_tier && ask.calls_24h_by_tier.value) || {};
    const capHit = (ask.cap_hit_rate_24h_by_tier && ask.cap_hit_rate_24h_by_tier.value) || {};
    const askTiers = ['free','starter','playmaker','champion'];
    const askMax = Math.max(1, ...askTiers.map(t => askByTier[t] ?? 0));
    const askRows = ask.calls_24h_by_tier && ask.calls_24h_by_tier.unmeasured
      ? '<abbr title="' + esc(ask.calls_24h_by_tier.error || '') + '"><span class="tag unmeasured">unmeasured</span></abbr>'
      : askTiers.map(t => {
          const v = askByTier[t] ?? 0;
          const hit = capHit[t];
          const hitStr = (hit != null) ? ' · ' + hit.toFixed(1) + '% cap-hit' : '';
          return miniBar(t, v, askMax, v + hitStr);
        }).join('');
    const freeCapped = metricVal(ask.free_users_capped_today);
    const freeCappedHtml = freeCapped == null
      ? '<abbr title="' + esc(ask.free_users_capped_today && ask.free_users_capped_today.error || '') + '"><span class="tag unmeasured">unmeasured</span></abbr>'
      : (freeCapped > 0
          ? '<span style="color:var(--accent);font-weight:600;">' + freeCapped + ' Free users hit cap today — conversion target 🎯</span>'
          : '<span style="color:var(--muted);">0 Free users at cap today</span>');
    el('econ-askscout-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('calls 24h', ask.calls_24h)}
        \${tileHtml('Anthropic spend 24h', ask.estimated_anthropic_spend_24h_usd, ' USD')}
        \${tileHtml('cost / paid seat 24h', ask.cost_per_paid_seat_24h_usd, ' USD')}
      </div>
      <div style="margin-top:10px;color:var(--muted);font-size:12px;">calls by tier (24h) · cap-hit rate</div>
      <div style="margin-top:6px;">\${askRows}</div>
      <div class="kv" style="margin-top:8px;">
        <span class="k">free users at cap today</span>
        <span>\${freeCappedHtml}</span>
      </div>
    \`;

    // ── Card Scan Usage ────────────────────────────────────────────────
    // Mirrors Ask Scout. Per-scan cost is ~3-5x higher than Ask Scout
    // (Haiku 4.5 vision: tokens + image MP cost), so the cap-hit signal
    // is even more important here for both cost containment and as
    // upgrade pressure on the Free tier.
    const scan = m.card_scan || {};
    const scanByTier = (scan.scans_24h_by_tier && scan.scans_24h_by_tier.value) || {};
    const scanCapHit = (scan.cap_hit_rate_24h_by_tier && scan.cap_hit_rate_24h_by_tier.value) || {};
    const scanTiers = ['free','starter','playmaker','champion'];
    const scanMax = Math.max(1, ...scanTiers.map(t => scanByTier[t] ?? 0));
    const scanRows = scan.scans_24h_by_tier && scan.scans_24h_by_tier.unmeasured
      ? '<abbr title="' + esc(scan.scans_24h_by_tier.error || '') + '"><span class="tag unmeasured">unmeasured</span></abbr>'
      : scanTiers.map(t => {
          const v = scanByTier[t] ?? 0;
          const hit = scanCapHit[t];
          const hitStr = (hit != null) ? ' · ' + hit.toFixed(1) + '% cap-hit' : '';
          return miniBar(t, v, scanMax, v + hitStr);
        }).join('');
    const scanFreeCapped = metricVal(scan.free_users_capped_today);
    const scanFreeCappedHtml = scanFreeCapped == null
      ? '<abbr title="' + esc(scan.free_users_capped_today && scan.free_users_capped_today.error || '') + '"><span class="tag unmeasured">unmeasured</span></abbr>'
      : (scanFreeCapped > 0
          ? '<span style="color:var(--accent);font-weight:600;">' + scanFreeCapped + ' Free users hit scan cap today — conversion target 🎯</span>'
          : '<span style="color:var(--muted);">0 Free users at scan cap today</span>');
    el('econ-cardscan-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('scans 24h', scan.scans_24h)}
        \${tileHtml('Anthropic spend 24h', scan.estimated_anthropic_spend_24h_usd, ' USD')}
        \${tileHtml('cost / paid seat 24h', scan.cost_per_paid_seat_24h_usd, ' USD')}
      </div>
      <div style="margin-top:10px;color:var(--muted);font-size:12px;">scans by tier (24h) · cap-hit rate</div>
      <div style="margin-top:6px;">\${scanRows}</div>
      <div class="kv" style="margin-top:8px;">
        <span class="k">free users at scan cap today</span>
        <span>\${scanFreeCappedHtml}</span>
      </div>
    \`;

    // ── Rosters ─────────────────────────────────────────────────────────
    const r = m.rosters || {};
    el('econ-rosters-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('rosters locked 24h', r.rosters_locked_24h)}
        \${tileHtml('rosters w/ legendary 24h', r.rosters_with_legendary_24h)}
        \${tileHtml('avg energy used', r.avg_energy_used_per_roster)}
        \${tileHtml('h2h matches 24h', r.h2h_matches_24h)}
        \${tileHtml('h2h win PP 24h', r.h2h_win_pp_total_24h)}
        \${tileHtml('h2h loss PP 24h', r.h2h_loss_pp_total_24h)}
      </div>
    \`;

    // ── Engagement (trivia + retention) ─────────────────────────────────
    const tp = m.trivia_picks || {};
    const ret = m.retention || {};
    el('econ-engage-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('DAU', ret.dau)}
        \${tileHtml('WAU', ret.wau)}
        \${tileHtml('MAU', ret.mau)}
        \${tileHtml('DAU/MAU %', ret.dau_mau_pct, '%')}
        \${tileHtml('trivia 24h', tp.trivia_questions_answered_24h)}
        \${tileHtml('trivia correct %', tp.trivia_correct_pct, '%')}
        \${tileHtml('picks 24h', tp.play_picks_made_24h)}
        \${tileHtml('picks correct %', tp.play_picks_correct_pct, '%')}
        \${tileHtml('streak-5 bonuses 24h', tp.streak_5_bonuses_24h)}
      </div>
      <div style="margin-top:10px;color:var(--muted);font-size:12px;">retention (target d30 ≥ \${esc(((t.business && t.business.target_d30_retention_pct && t.business.target_d30_retention_pct.value) || 0.20) * 100)}% — industry standard)</div>
      <div class="tile-grid">
        \${tileHtml('d1 retention', ret.d1_retention_7d, '%')}
        \${tileHtml('d7 retention', ret.d7_retention, '%')}
        \${tileHtml('d30 retention', ret.d30_retention, '%')}
      </div>
    \`;

    // ── Targets vs Actuals table ────────────────────────────────────────
    const rows = [];
    // Pro pack cost
    if (t.pp && t.pp.pro_pack_cost) {
      const tgt = t.pp.pro_pack_cost;
      rows.push({
        metric: 'Pro Pack cost (PP)',
        actual: tgt.current, // current spec value — live spend tracking later
        target: tgt.target_min + '–' + tgt.target_max,
        status: statusPill(tgt.current, tgt.target_min, tgt.target_max),
        source: tgt.source,
      });
    }
    // Legendary drop rates
    if (t.cards && t.cards.legendary_drop_rates) {
      ['pro_pack','all_star_pack','mvp_pack','goat_pack'].forEach(k => {
        const tgt = t.cards.legendary_drop_rates[k];
        const obs = (m.packs && m.packs.legendary_drop_rate_observed && m.packs.legendary_drop_rate_observed[k]);
        const obsVal = (obs && !obs.unmeasured) ? obs.value : null;
        const tgtPct = tgt.current * 100;
        const status = obsVal == null
          ? '<span class="status-pill unmeas">unmeasured</span>'
          : statusPill(obsVal, tgtPct * 0.5, tgtPct * 1.5);
        rows.push({
          metric: 'Legendary drop · ' + k.replace(/_/g, ' '),
          actual: obsVal == null ? '—' : obsVal.toFixed(2) + '%',
          target: tgtPct.toFixed(0) + '%',
          status,
          source: tgt.source,
        });
      });
    }
    // Legendary pity %
    if (t.cards && t.cards.legendary_pity_user_pct_target) {
      const tgt = t.cards.legendary_pity_user_pct_target;
      const obs = m.cards && m.cards.legendary_pity_pct;
      const obsVal = (obs && !obs.unmeasured) ? obs.value : null;
      const tgtPct = tgt.max * 100;
      const status = obsVal == null
        ? '<span class="status-pill unmeas">unmeasured</span>'
        : (obsVal <= tgtPct ? '<span class="status-pill ok">✅ in range</span>'
           : '<span class="status-pill fail">❌ out of range</span>');
      rows.push({
        metric: 'Legendary pity user %',
        actual: obsVal == null ? '—' : obsVal.toFixed(1) + '%',
        target: '≤ ' + tgtPct.toFixed(0) + '%',
        status,
        source: tgt.source,
      });
    }
    // ARPU
    if (t.business && t.business.target_arpu_usd_monthly) {
      const tgt = t.business.target_arpu_usd_monthly;
      const obs = m.subscriptions && m.subscriptions.arpu_usd;
      const obsVal = (obs && !obs.unmeasured) ? obs.value : null;
      const status = obsVal == null
        ? '<span class="status-pill unmeas">unmeasured</span>'
        : (obsVal >= tgt.value ? '<span class="status-pill ok">✅ in range</span>'
           : statusPill(obsVal, tgt.value * 0.85, tgt.value * 100));
      rows.push({
        metric: 'ARPU (monthly USD)',
        actual: obsVal == null ? '—' : '$' + obsVal.toFixed(2),
        target: '≥ $' + tgt.value.toFixed(2) + ' <span class="status-pill warn">extrapolated</span>',
        status,
        source: tgt.source,
      });
    }
    // Paid conversion
    if (t.business && t.business.target_paid_conversion_pct) {
      const tgt = t.business.target_paid_conversion_pct;
      const obs = m.subscriptions && m.subscriptions.paid_pct;
      const obsVal = (obs && !obs.unmeasured) ? obs.value : null;
      const tgtPct = tgt.value * 100;
      const status = obsVal == null
        ? '<span class="status-pill unmeas">unmeasured</span>'
        : (obsVal >= tgtPct ? '<span class="status-pill ok">✅ in range</span>'
           : statusPill(obsVal, tgtPct * 0.5, tgtPct * 100));
      rows.push({
        metric: 'Paid conversion %',
        actual: obsVal == null ? '—' : obsVal.toFixed(1) + '%',
        target: '≥ ' + tgtPct.toFixed(0) + '% <span class="status-pill warn">industry-standard</span>',
        status,
        source: tgt.source,
      });
    }
    // d30 retention
    if (t.business && t.business.target_d30_retention_pct) {
      const tgt = t.business.target_d30_retention_pct;
      const obs = m.retention && m.retention.d30_retention;
      const obsVal = (obs && !obs.unmeasured) ? obs.value : null;
      const tgtPct = tgt.value * 100;
      const status = obsVal == null
        ? '<span class="status-pill unmeas">unmeasured</span>'
        : (obsVal >= tgtPct ? '<span class="status-pill ok">✅ in range</span>'
           : '<span class="status-pill fail">❌ out of range</span>');
      rows.push({
        metric: 'D30 retention %',
        actual: obsVal == null ? '—' : obsVal.toFixed(1) + '%',
        target: '≥ ' + tgtPct.toFixed(0) + '% <span class="status-pill warn">industry-standard</span>',
        status,
        source: tgt.source,
      });
    }
    el('econ-targets-body').innerHTML = \`<table>
      <thead><tr><th>Metric</th><th>Actual</th><th>Target</th><th>Status</th><th>Source</th></tr></thead>
      <tbody>
        \${rows.map(r => \`<tr>
          <td>\${esc(r.metric)}</td>
          <td><code>\${typeof r.actual === 'string' ? r.actual : esc(r.actual)}</code></td>
          <td>\${r.target}</td>
          <td>\${r.status}</td>
          <td><abbr title="\${esc(r.source || '')}" style="color:var(--muted)">\${esc((r.source || '').slice(0,40))}\${(r.source || '').length > 40 ? '…' : ''}</abbr></td>
        </tr>\`).join('')}
      </tbody>
    </table>\`;
  }

  function renderAdvertising(ad) {
    const portfolio = ad.portfolio || {};
    const channels = ad.channels || [];
    const funnel = portfolio.conversion_funnel || {};
    const fmtUsd = v => v == null ? '—' : '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtRoas = v => v == null ? '—' : (Number(v).toFixed(2) + 'x');
    const fmtNum = v => v == null ? '—' : Number(v).toLocaleString();

    el('ad-portfolio-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('monthly spend', fmtUsd(portfolio.monthly_spend_total_usd), 'USD · current month')}
        \${tileHtml('blended CPI', fmtUsd(portfolio.blended_cpi_usd), 'spend ÷ installs')}
        \${tileHtml('blended CAC', fmtUsd(portfolio.blended_cac_usd), 'spend ÷ signups')}
        \${tileHtml('blended ROAS', fmtRoas(portfolio.blended_roas), 'revenue ÷ spend')}
        \${tileHtml('attributed installs 30d', fmtNum(portfolio.attributed_installs_30d_total))}
      </div>
      \${(ad.notes||[]).length ? '<div style="margin-top:8px;color:var(--yellow);font-size:12px;">⚠ ' + ad.notes.map(esc).join(' · ') + '</div>' : ''}
    \`;

    // Funnel
    const stages = [
      ['Impressions', funnel.impressions || 0],
      ['Clicks', funnel.clicks || 0],
      ['Installs', funnel.installs || 0],
      ['Signups', funnel.signups || 0],
      ['Roster locked', funnel.first_roster_locked || 0],
      ['Paid subs', funnel.paid_subs || 0],
    ];
    const maxStage = Math.max(1, ...stages.map(s => s[1]));
    const stageRows = stages.map((s, i) => {
      const prev = i > 0 ? stages[i-1][1] : null;
      const conv = (prev && prev > 0) ? ((s[1] / prev) * 100).toFixed(1) + '%' : '';
      return miniBar(s[0], s[1], maxStage, fmtNum(s[1]) + (conv ? ' (↘ ' + conv + ')' : ''));
    }).join('');
    el('ad-funnel-body').innerHTML = stageRows || '<div class="muted">no funnel data yet</div>';

    // Channel grid
    function audienceBadges(a) {
      if (!a || !a.length) return '';
      return a.map(t => {
        const cls = /COPPA|<13/.test(t) ? 'fail' : (/kid-safe|8\+/.test(t) ? 'warn' : 'ok');
        return '<span class="status-pill ' + cls + '" style="margin-right:4px;">' + esc(t) + '</span>';
      }).join('');
    }
    function statusEmoji(s) {
      if (s === 'on_target') return '<span class="status-pill ok">✅ on target</span>';
      if (s === 'near')      return '<span class="status-pill warn">⚠ near</span>';
      if (s === 'off')       return '<span class="status-pill fail">❌ off</span>';
      return '<span class="status-pill unmeas">unmeasured</span>';
    }
    el('ad-channels-body').innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:10px;">' +
      channels.map(c => {
        const target = c.target || {};
        const cur = c.current || {};
        const kpiV = cur[c.kpi_focus];
        const kpiTargetKey = Object.keys(target).find(k => k === c.kpi_focus || k === 'target_' + c.kpi_focus || k.includes(c.kpi_focus.replace(/_(usd|pct)$/, '')));
        const kpiT = kpiTargetKey ? target[kpiTargetKey] : null;
        const targetSrcAttr = c.target_source ? ' title="' + esc(c.target_source) + '"' : '';
        return \`<div class="card" style="margin:0;">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;">
            <strong>\${esc(c.display_name)}</strong>
            \${statusEmoji(c.status)}
          </div>
          <div class="muted" style="margin-top:2px;">\${esc(c.category)} · KPI: <code>\${esc(c.kpi_focus)}</code></div>
          <div style="margin-top:6px;">\${audienceBadges(c.audience_constraints)}</div>
          <div class="kv" style="margin-top:8px;">
            <span class="k">current</span>
            <span><code>\${kpiV != null ? esc(String(kpiV)) : '—'}</code></span>
          </div>
          <div class="kv">
            <span class="k">target</span>
            <span\${targetSrcAttr}><code>\${kpiT != null ? esc(String(kpiT)) : '—'}</code> <span class="status-pill warn">extrapolated</span></span>
          </div>
          \${c.last_updated_iso ? '<div class="muted" style="margin-top:6px;">last update: ' + esc(relTime(c.last_updated_iso)) + '</div>' : '<div class="muted" style="margin-top:6px;">last update: —</div>'}
        </div>\`;
      }).join('') + '</div>';
  }

  function renderSafetyMatrix(sm) {
    if (!sm) {
      el('safety-matrix-body').innerHTML = '<span class="tag unmeasured">unmeasured · matrix file missing</span>';
      return;
    }
    el('safety-matrix-body').innerHTML = \`
      <div class="tile-grid">
        \${tileHtml('total features', sm.feature_count, 'in matrix')}
        \${tileHtml('ages covered', sm.ages_covered, 'within 5–14')}
        \${tileHtml('COPPA-gated', sm.coppa_gated_features, 'parent-consent <13')}
        \${tileHtml('Apple-Kids-blocked', sm.apple_kids_blocked_features, 'no override <13')}
        <div class="tile" id="uso-tile">
          <div class="tile-label">per-user overrides</div>
          <div class="tile-value" id="uso-tile-value">…</div>
          <div class="tile-sub" id="uso-tile-sub">loading</div>
        </div>
      </div>
      <div class="kv" style="margin-top:10px;">
        <span class="k">version</span><span><code>\${esc(sm.version)}</code></span>
      </div>
      <div class="kv">
        <span class="k">last edited</span><span>\${esc(relTime(sm.last_updated_iso))} · <code>\${esc(new Date(sm.last_updated_iso).toLocaleString())}</code></span>
      </div>
      <div style="margin-top:8px;">
        <a href="/admin/edit/safety" style="color: var(--accent); text-decoration: none;">→ Open editor</a> ·
        <a href="/admin/edit/safety#peruser" style="color: var(--accent); text-decoration: none;" id="uso-tile-link">→ Per-user overrides</a>
      </div>
    \`;
    // Async fetch the override summary — keeps the dashboard /admin/status
    // call cheap (no extra DB query inline) and lets the tile populate
    // independently of matrix-file freshness.
    fetch('/admin/api/user-safety-overrides/summary').then(r => r.json()).then(j => {
      if (!j || !j.ok) return;
      const v = el('uso-tile-value'); if (v) v.textContent = j.distinct_users;
      const s = el('uso-tile-sub');   if (s) s.textContent = j.total_overrides + ' rows · ' + j.distinct_features + ' features';
    }).catch(() => {});
  }

  function renderDataPipelines(p) {
    const pipelines = p.pipelines || {};
    const cron = p.cron_schedule || {};
    const leagues = ['nfl','nba','mlb','nhl','mls'];
    const fmtPct = v => (v == null ? '—' : (v * 100).toFixed(1) + '%');
    const rows = leagues.map(L => {
      const e = pipelines[L] || {};
      const lastRun = e.lastRunAt ? \`<code>\${esc(new Date(e.lastRunAt).toLocaleString())}</code> · <span class="muted">\${esc(relTime(e.lastRunAt))}</span>\` : '<span class="tag unmeasured">never</span>';
      const lastSucc = e.lastSuccessAt ? \`<code>\${esc(new Date(e.lastSuccessAt).toLocaleString())}</code> · <span class="muted">\${esc(relTime(e.lastSuccessAt))}</span>\` : '<span class="tag unmeasured">never</span>';
      const sr = typeof e.successRate24h === 'number' ? fmtPct(e.successRate24h) : '—';
      return \`<tr>
        <td><strong>\${esc(L.toUpperCase())}</strong></td>
        <td>\${lastRun}</td>
        <td>\${lastSucc}</td>
        <td>\${esc(String(e.playerCount ?? 0))}</td>
        <td>\${sr} <span class="muted">(\${(e.recent24h && e.recent24h.successes) || 0}✓ / \${(e.recent24h && e.recent24h.failures) || 0}✗)</span></td>
      </tr>\`;
    }).join('');
    el('data-pipelines-body').innerHTML = \`
      <div class="muted" style="margin-bottom:6px;">cron: <code>\${esc(cron.daily || '—')}</code> · hourly: <code>\${esc(cron.hourly || '—')}</code> · tz: <code>\${esc(cron.tz || '—')}</code></div>
      <table>
        <thead><tr><th>League</th><th>Last Run</th><th>Last Success</th><th>Players</th><th>24h Success Rate</th></tr></thead>
        <tbody>\${rows}</tbody>
      </table>
    \`;

    // Lazy-load /admin/ratings/distribution for the histogram below.
    fetch('/admin/ratings/distribution').then(r => r.json()).then(data => {
      const dist = data.distribution || {};
      // 13-grade ladder. Falls back to v1 5-tier names if the API hasn't
      // been redeployed yet — drawing 5 bars instead of 13 in that window.
      const grades = data.grades || data.tiers || ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'];
      const bg = {
        'A+': '#F97316', 'A':  '#FBBF24', 'A-': '#FCD34D',
        'B+': '#3B82F6', 'B':  '#60A5FA', 'B-': '#93C5FD',
        'C+': '#10B981', 'C':  '#34D399', 'C-': '#6EE7B7',
        'D+': '#FB923C', 'D':  '#F97316', 'D-': '#EA580C',
        'F':  '#DC2626',
        // legacy 5-tier names — kept so the dashboard renders during the migration window.
        elite: '#FBBF24', strong: '#3B82F6', solid: '#10B981', role: '#FB923C', deep_bench: '#DC2626',
      };
      let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:10px;">';
      for (const L of leagues) {
        const d = dist[L] || {};
        const total = grades.reduce((s, g) => s + (d[g] || 0), 0);
        const max = Math.max(1, ...grades.map(g => d[g] || 0));
        const bars = grades.map(g => {
          const v = d[g] || 0;
          const pct = (v / max) * 100;
          return '<div style="margin:1px 0;display:flex;align-items:center;gap:6px;">' +
            '<span style="width:32px;font-size:10px;font-weight:700;color:var(--muted);">' + esc(String(g).replace('_',' ')) + '</span>' +
            '<div style="flex:1;background:var(--bg);height:12px;border-radius:3px;overflow:hidden;">' +
              '<div style="height:100%;background:' + (bg[g] || '#9CA3AF') + ';width:' + pct + '%;"></div>' +
            '</div>' +
            '<span style="width:36px;text-align:right;font-size:11px;">' + v + '</span>' +
          '</div>';
        }).join('');
        html += \`<div class="card" style="margin:0;">
          <strong>\${esc(L.toUpperCase())}</strong> <span class="muted">(\${total} rated)</span>
          <div style="margin-top:6px;">\${bars}</div>
        </div>\`;
      }
      html += '</div>';
      el('ratings-distribution-body').innerHTML = html;
    }).catch(() => {
      el('ratings-distribution-body').innerHTML = '<span class="tag unmeasured">distribution endpoint failed</span>';
    });
  }

  function renderHighlightsCoverage() {
    fetch('/admin/api/highlights-coverage', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        const fmtPct = v => (v == null ? '—' : (v * 100).toFixed(0) + '%');
        const t = d.totals || {};
        const emb = d.embeddability || { enabled: false, hit_rate: null, quota: { units_24h: 0, daily_budget: 10000, utilization: 0, cache_size: 0 } };
        const rows = (d.by_league || []).map(r => {
          const ppct = r.players_total ? (r.players_with / r.players_total) : 0;
          const tpct = r.teams_total ? (r.teams_with / r.teams_total) : 0;
          const last = r.last_pulled_at ? '<code>' + esc(r.last_pulled_at.slice(0,10)) + '</code>' : '<span class="tag unmeasured">never</span>';
          // Avg playlist length per league — show "—" when null so the
          // dashboard reads honestly while the first cron is still running.
          const apP = r.avg_playlist_length_players != null ? r.avg_playlist_length_players.toFixed(2) : '—';
          const apT = r.avg_playlist_length_teams != null ? r.avg_playlist_length_teams.toFixed(2) : '—';
          return '<tr>' +
            '<td><strong>' + esc(r.league) + '</strong></td>' +
            '<td>' + esc(String(r.players_with ?? '?')) + ' / ' + esc(String(r.players_total ?? '?')) + ' <span class="muted">(' + fmtPct(ppct) + ')</span></td>' +
            '<td>' + esc(String(r.teams_with ?? '?')) + ' / ' + esc(String(r.teams_total ?? '?')) + ' <span class="muted">(' + fmtPct(tpct) + ')</span></td>' +
            '<td><span class="muted">P:</span>' + esc(apP) + ' · <span class="muted">T:</span>' + esc(apT) + '</td>' +
            '<td>' + last + '</td>' +
            '<td><a href="/admin/edit/players?missing_highlight=1&sport=' + esc(r.category) + '">missing →</a></td>' +
          '</tr>';
        }).join('');
        const pipe = d.pipeline || {};
        const lastRun = pipe.last_run_at ? '<code>' + esc(new Date(pipe.last_run_at).toLocaleString()) + '</code> · <span class="muted">' + esc(relTime(pipe.last_run_at)) + '</span>' : '<span class="tag unmeasured">never</span>';
        const lastSucc = pipe.last_success_at ? '<code>' + esc(new Date(pipe.last_success_at).toLocaleString()) + '</code>' : '<span class="tag unmeasured">never</span>';
        const apOverall = (typeof t.avg_playlist_length === 'number' ? t.avg_playlist_length.toFixed(2) : '—');
        const hitRate = emb.hit_rate != null ? fmtPct(emb.hit_rate) : '<span class="tag unmeasured">no run yet</span>';
        const embStatus = emb.enabled
          ? '<span class="tag ok">YouTube API key configured</span>'
          : '<span class="tag unmeasured">YOUTUBE_API_KEY missing — filter degraded</span>';
        const quota = emb.quota || { units_24h: 0, daily_budget: 10000, utilization: 0, cache_size: 0 };
        const quotaPct = (quota.utilization * 100).toFixed(1);
        el('highlights-coverage-body').innerHTML =
          '<div class="muted" style="margin-bottom:6px;">cron: <code>0 5 * * *</code> ET · last run: ' + lastRun + ' · last success: ' + lastSucc + '</div>' +
          '<div class="kv"><span class="k">Players covered</span><span><strong>' + esc(String(t.players_with || 0)) + '</strong> / ' + esc(String(t.players_total || 0)) + ' <span class="muted">(' + fmtPct(t.players_pct) + ')</span></span></div>' +
          '<div class="kv"><span class="k">Teams covered</span><span><strong>' + esc(String(t.teams_with || 0)) + '</strong> / ' + esc(String(t.teams_total || 0)) + ' <span class="muted">(' + fmtPct(t.teams_pct) + ')</span></span></div>' +
          '<div class="kv"><span class="k">Avg playlist length</span><span><strong>' + esc(apOverall) + '</strong> <span class="muted">/ 5 max</span></span></div>' +
          '<div class="kv"><span class="k">Embeddability hit rate</span><span><strong>' + hitRate + '</strong></span></div>' +
          '<div class="kv"><span class="k">Embeddability filter</span><span>' + embStatus + '</span></div>' +
          '<div class="kv"><span class="k">YouTube quota (24h)</span><span><strong>' + esc(String(quota.units_24h)) + '</strong> / ' + esc(String(quota.daily_budget)) + ' units <span class="muted">(' + esc(quotaPct) + '% used · ' + esc(String(quota.cache_size)) + ' cached)</span></span></div>' +
          '<table style="margin-top:10px;"><thead><tr><th>League</th><th>Players</th><th>Teams</th><th>Avg Playlist</th><th>Last Pulled</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
      })
      .catch(err => {
        el('highlights-coverage-body').innerHTML = '<div class="err-banner">' + esc(err.message || 'fetch failed') + '</div>';
      });
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

  function loadSimulation() {
    fetch('/admin/api/simulate', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        if (!j || !j.ok) {
          el('simulation-body').innerHTML = '<span class="tag unmeasured">no runs yet</span> · <a href="/admin/simulate" style="color:var(--accent);">Run new simulation</a>';
          return;
        }
        const local = j.runs || [];
        const trend = (j.trend || []).filter(t => t.fairness_score != null).slice(0, 30);
        const last = local.find(r => r.status === 'completed') || trend[0];
        const lastTs = last ? (last.completed_at || last.started_at) : null;
        const lastScore = last ? last.fairness_score : null;
        const scoreColor = lastScore == null ? 'var(--muted)' : lastScore >= 70 ? 'var(--green)' : lastScore >= 50 ? 'var(--yellow)' : 'var(--red)';
        let trendSvg = '';
        if (trend.length >= 2) {
          const w = 280, h = 60;
          const xs = trend.slice().reverse();
          const max = Math.max(...xs.map(t => t.fairness_score || 0), 100);
          const min = Math.min(...xs.map(t => t.fairness_score || 0), 0);
          const span = Math.max(1, max - min);
          const points = xs.map((t, i) => {
            const x = (i / (xs.length - 1)) * w;
            const y = h - ((t.fairness_score - min) / span) * h;
            return x.toFixed(1) + ',' + y.toFixed(1);
          }).join(' ');
          trendSvg = '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="width:100%;height:60px;background:var(--card-2);border-radius:6px;margin-top:8px;">' +
            '<polyline points="' + points + '" fill="none" stroke="var(--accent)" stroke-width="1.5" /></svg>';
        }
        el('simulation-body').innerHTML =
          '<div class="kv"><span class="k">Last run</span><span>' + (lastTs ? '<code>' + esc(new Date(lastTs).toLocaleString()) + '</code> <span class="muted">(' + esc(relTime(lastTs)) + ')</span>' : '<span class="tag unmeasured">never</span>') + '</span></div>' +
          '<div class="kv"><span class="k">Fairness score</span><span style="color:' + scoreColor + ';font-weight:600;">' + (lastScore != null ? Math.round(lastScore * 100) / 100 : '—') + '</span></div>' +
          '<div class="kv"><span class="k">Recent runs</span><span>' + (trend.length || local.length) + '</span></div>' +
          trendSvg +
          '<div style="margin-top:10px;"><a class="status-pill ok" style="text-decoration:none;padding:4px 10px;" href="/admin/simulate">Run new simulation →</a></div>';
      })
      .catch(err => {
        el('simulation-body').innerHTML = '<div class="err-banner">' + esc(err.message || 'fetch failed') + '</div>';
      });
  }

  async function load() {
    try {
      const res = await fetch('/admin/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      el('error').innerHTML = '';
      render(json);
      loadSimulation();
      loadDocs();
    } catch (err) {
      el('error').innerHTML = \`<div class="err-banner">Failed to load /admin/status: \${esc(err.message)}</div>\`;
    }
    countdown = 30;
  }

  async function loadDocs() {
    try {
      const res = await fetch('/admin/api/docs', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      const slots = ['gdd', 'business-plan', 'financial-model'];
      for (const slot of slots) {
        const meta = json.docs && json.docs[slot];
        const tile = document.getElementById('doc-tile-' + slot);
        const sub = document.getElementById('doc-sub-' + slot);
        if (!tile || !sub) continue;
        if (meta && meta.present) {
          tile.classList.remove('missing');
          sub.textContent = '.' + meta.ext + ' · open in new tab';
        } else {
          tile.classList.add('missing');
          sub.textContent = 'missing — drop file at docs/admin/';
        }
      }
    } catch {
      /* tolerated — tile keeps last-known state */
    }
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
