/**
 * adminSimulation.ts — admin routes for the fairness simulator + scoring editor.
 *
 * Two surfaces, both unauthenticated (same threat model as /admin/dashboard):
 *
 * Scoring editor (mirrors /admin/edit/packs pattern):
 *   GET   /admin/edit/scoring          — HTML editor
 *   GET   /admin/api/scoring           — return current formula JSON
 *   PATCH /admin/api/scoring           — validate + write +
 *                                        chore(content): update scoring formula
 *
 * Simulator:
 *   GET   /admin/simulate              — HTML form + run + results page
 *   POST  /admin/api/simulate          — kick off a run, returns run_id
 *   GET   /admin/api/simulate/:id      — poll status / progress / results
 *   GET   /admin/api/simulate          — list recent runs (for dashboard card)
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  SHARED_STYLE,
  SHARED_CRUMBS,
  SHARED_SORTABLE_JS,
  autoCommit,
  badRequest,
  type ValidationError,
} from './adminEdit.js';
import {
  type ScoringFormulaFile,
  type Sport,
  FORMULA_PATH,
} from '../services/simulation/scoringFormula.js';
import {
  type League,
  runSimulation,
} from '../services/simulation/seasonSimulator.js';
import {
  completeRun,
  createRun,
  failRun,
  fetchRecentRunsFromSupabase,
  getRun,
  listRecentRuns,
  updateProgress,
} from '../services/simulation/simulationStore.js';

// ─── File helpers (same conventions as adminEditConfig.ts) ───────────────
async function readFormula(): Promise<ScoringFormulaFile> {
  const raw = await fs.readFile(FORMULA_PATH, 'utf8');
  return JSON.parse(raw) as ScoringFormulaFile;
}
async function writeFormula(data: ScoringFormulaFile): Promise<void> {
  const out = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(FORMULA_PATH, out, 'utf8');
}
function relFromRoot(absPath: string): string {
  return path.relative(PROJECT_ROOT, absPath);
}

// ─── Validation ──────────────────────────────────────────────────────────
const SPORTS: Sport[] = ['basketball', 'football', 'baseball', 'hockey', 'soccer'];
const LEAGUES: League[] = ['nba', 'nfl', 'mlb', 'nhl', 'mls'];

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateWeightsBag(obj: unknown, prefix: string): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errs.push({ field: prefix, message: 'must be object' });
    return errs;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (!isFiniteNum(v)) errs.push({ field: `${prefix}.${k}`, message: 'must be finite number' });
  }
  return errs;
}

function validateFormulaPatch(body: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  const bs = body['by_sport'] as Record<string, unknown> | undefined;
  if (bs !== undefined) {
    if (!bs || typeof bs !== 'object' || Array.isArray(bs)) {
      errs.push({ field: 'by_sport', message: 'must be object' });
    } else {
      for (const sport of SPORTS) {
        const block = bs[sport] as Record<string, unknown> | undefined;
        if (!block) continue;
        if (sport === 'baseball') {
          if (block['hitter_weights'] !== undefined)
            errs.push(...validateWeightsBag(block['hitter_weights'], `by_sport.baseball.hitter_weights`));
          if (block['pitcher_weights'] !== undefined)
            errs.push(...validateWeightsBag(block['pitcher_weights'], `by_sport.baseball.pitcher_weights`));
        } else if (sport === 'hockey') {
          if (block['skater_weights'] !== undefined)
            errs.push(...validateWeightsBag(block['skater_weights'], `by_sport.hockey.skater_weights`));
          if (block['goalie_weights'] !== undefined)
            errs.push(...validateWeightsBag(block['goalie_weights'], `by_sport.hockey.goalie_weights`));
        } else {
          if (block['weights'] !== undefined)
            errs.push(...validateWeightsBag(block['weights'], `by_sport.${sport}.weights`));
        }
        if (block['games_per_week'] !== undefined) {
          const v = block['games_per_week'];
          if (!isFiniteNum(v) || (v as number) <= 0) {
            errs.push({ field: `by_sport.${sport}.games_per_week`, message: 'must be positive number' });
          }
        }
        if (block['per_sport_multiplier'] !== undefined) {
          const v = block['per_sport_multiplier'];
          if (!isFiniteNum(v) || (v as number) <= 0) {
            errs.push({
              field: `by_sport.${sport}.per_sport_multiplier`,
              message: 'must be positive number',
            });
          }
        }
      }
    }
  }
  const g = body['global'] as Record<string, unknown> | undefined;
  if (g !== undefined) {
    if (g['roster_size'] !== undefined) {
      const v = g['roster_size'];
      if (!isFiniteNum(v) || !Number.isInteger(v) || (v as number) < 1 || (v as number) > 12) {
        errs.push({ field: 'global.roster_size', message: 'must be integer 1..12' });
      }
    }
    if (g['synthetic_user_count'] !== undefined) {
      const v = g['synthetic_user_count'];
      if (!isFiniteNum(v) || !Number.isInteger(v) || (v as number) < 10 || (v as number) > 10000) {
        errs.push({ field: 'global.synthetic_user_count', message: 'must be integer 10..10000' });
      }
    }
    if (g['min_picks_per_sport'] !== undefined) {
      const m = g['min_picks_per_sport'];
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        errs.push({ field: 'global.min_picks_per_sport', message: 'must be object' });
      } else {
        for (const sport of SPORTS) {
          const v = (m as Record<string, unknown>)[sport];
          if (v === undefined) continue;
          if (!isFiniteNum(v) || !Number.isInteger(v) || (v as number) < 0 || (v as number) > 5) {
            errs.push({
              field: `global.min_picks_per_sport.${sport}`,
              message: 'must be integer 0..5',
            });
          }
        }
      }
    }
  }
  return errs;
}

function mergeFormula(base: ScoringFormulaFile, patch: Record<string, unknown>): ScoringFormulaFile {
  const out: ScoringFormulaFile = JSON.parse(JSON.stringify(base)) as ScoringFormulaFile;
  const bs = patch['by_sport'] as Record<string, unknown> | undefined;
  if (bs && typeof bs === 'object') {
    for (const sport of SPORTS) {
      const block = bs[sport] as Record<string, unknown> | undefined;
      if (!block) continue;
      const target = (out.by_sport as Record<string, Record<string, unknown>>)[sport]!;
      for (const [k, v] of Object.entries(block)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          target[k] = { ...(target[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
        } else {
          target[k] = v;
        }
      }
    }
  }
  const g = patch['global'] as Record<string, unknown> | undefined;
  if (g && typeof g === 'object') {
    for (const [k, v] of Object.entries(g)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        (out.global as unknown as Record<string, unknown>)[k] = {
          ...((out.global as unknown as Record<string, unknown>)[k] as Record<string, unknown>),
          ...(v as Record<string, unknown>),
        };
      } else {
        (out.global as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  if (typeof patch['version'] === 'string') out.version = patch['version'];
  return out;
}

function pageHtml(title: string, h1: string, bodyInner: string, scriptJs: string): string {
  return /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PlayGM Editor · ${title}</title>
<style>${SHARED_STYLE}</style>
</head><body>
<div class="wrap">
  <header>
    <h1>${h1}</h1>
    ${SHARED_CRUMBS}
  </header>
  ${bodyInner}
</div>
<script>${SHARED_SORTABLE_JS}</script>
<script>${scriptJs}</script>
</body></html>`;
}

// suppress unused-import warning under strict tsc
void ({} as FastifyReply);

// ─── Route registration ──────────────────────────────────────────────────
export async function adminSimulationRoutes(fastify: FastifyInstance): Promise<void> {
  // ═══ SCORING EDITOR ═════════════════════════════════════════════════════
  fastify.get('/admin/edit/scoring', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Scoring',
      'Fantasy Scoring Formula',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/economy/pgm_scoring_formula.json</code> · auto-commits on save.
        After editing, run a fresh <a href="/admin/simulate" style="color:var(--accent);">simulation</a> to see distribution shifts before the live config is touched.
      </div>
      <div id="root">Loading…</div>
      <div class="card-block">
        <button class="btn primary" id="saveAll">Save all</button>
        <button class="btn" id="reload" style="margin-left:8px;">Reload</button>
        <span class="hint" id="status" style="margin-left:8px;"></span>
      </div>`,
      SCORING_JS,
    );
  });

  fastify.get('/admin/api/scoring', async (_req, reply) => {
    try {
      const f = await readFormula();
      return { ok: true, doc: f };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/scoring', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateFormulaPatch(body);
    if (errs.length) return badRequest(reply, errs);
    const base = await readFormula();
    const merged = mergeFormula(base, body);
    await writeFormula(merged);
    const commit = autoCommit(relFromRoot(FORMULA_PATH), 'chore(content): update scoring formula');
    return { ok: true, doc: merged, commit };
  });

  // ═══ SIMULATOR ══════════════════════════════════════════════════════════
  fastify.get('/admin/simulate', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Simulate',
      'Fairness Simulator',
      `<div class="muted" style="margin-bottom:10px;">
        Replays N seasons of cached <code>player_stats</code> through the current
        <a href="/admin/edit/scoring" style="color:var(--accent);">scoring formula</a>
        with synthetic users, weekly redrafts, daily FA pickups, and card application.
        Surfaces fairness metrics + suggested adjustments before you touch the live config.
      </div>
      <div class="card-block" id="form">
        <div style="display:grid;grid-template-columns:repeat(2, 1fr);gap:14px;">
          <label>Leagues
            <div id="leagues" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;"></div>
          </label>
          <label>Seasons
            <select id="seasons" style="margin-top:4px;">
              <option value="1" selected>1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </label>
          <label>Synthetic users
            <select id="users" style="margin-top:4px;">
              <option value="100" selected>100 (smoke test)</option>
              <option value="500">500</option>
              <option value="1000">1,000 (full)</option>
            </select>
          </label>
          <label>Cards / FA
            <div style="margin-top:4px;display:flex;gap:14px;font-size:13px;">
              <label><input type="checkbox" id="cards" checked /> Cards</label>
              <label><input type="checkbox" id="fa" checked /> Free agents</label>
            </div>
          </label>
        </div>
        <div style="margin-top:14px;">
          <button class="btn primary" id="run">Run Simulation</button>
          <span class="hint" id="status" style="margin-left:10px;"></span>
        </div>
      </div>
      <div class="card-block" id="progress" style="display:none;">
        <h3 style="margin:0 0 8px;">Run progress</h3>
        <div id="progressBar" style="background:var(--card-2);border-radius:8px;height:14px;overflow:hidden;">
          <div id="progressFill" style="background:var(--accent);height:100%;width:0%;transition:width .3s;"></div>
        </div>
        <div class="muted" id="progressNote" style="margin-top:6px;font-size:12px;">…</div>
      </div>
      <div id="results"></div>`,
      SIMULATE_JS,
    );
  });

  fastify.post('/admin/api/simulate', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const leagues = Array.isArray(body['leagues']) ? (body['leagues'] as string[]) : ['nfl'];
    const seasons = Math.min(3, Math.max(1, Number(body['seasons'] ?? 1)));
    const userCount = Math.min(2000, Math.max(10, Number(body['user_count'] ?? 100)));
    const disableCards = body['disable_cards'] === true;
    const disableFA = body['disable_fa'] === true;
    const seed = Number(body['seed'] ?? 42);

    const valid = leagues.filter((l): l is League => LEAGUES.includes(l as League));
    if (valid.length === 0) {
      return badRequest(reply, [{ field: 'leagues', message: 'pick at least one league' }]);
    }

    let formula: ScoringFormulaFile;
    try {
      formula = await readFormula();
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load formula failed' });
      return reply;
    }

    const rec = createRun({ formula, leagues: valid, syntheticUserCount: userCount });

    setImmediate(() => {
      try {
        const result = runSimulation({
          leagues: valid,
          seasons,
          formula,
          seed,
          syntheticUserCountOverride: userCount,
          disableCards,
          disableFA,
          onProgress: (frac, note) => updateProgress(rec.id, frac, note),
        });
        completeRun(rec.id, result);
      } catch (err) {
        failRun(rec.id, err);
      }
    });

    return { ok: true, run_id: rec.id };
  });

  fastify.get('/admin/api/simulate/:id', async (req) => {
    const { id } = req.params as { id: string };
    const r = getRun(id);
    if (!r) return { ok: false, error: 'not found' };
    return {
      ok: true,
      id: r.id,
      status: r.status,
      progress: r.progress,
      progress_note: r.progress_note,
      formula_version: r.formula_version,
      seasons_simulated: r.seasons_simulated,
      synthetic_user_count: r.synthetic_user_count,
      started_at: r.started_at,
      completed_at: r.completed_at,
      fairness_score: r.fairness_score,
      results: r.results,
      error: r.error,
    };
  });

  fastify.get('/admin/api/simulate', async () => {
    const local = listRecentRuns(20).map((r) => ({
      id: r.id,
      status: r.status,
      started_at: r.started_at,
      completed_at: r.completed_at,
      fairness_score: r.fairness_score,
    }));
    const supa = await fetchRecentRunsFromSupabase(20);
    return { ok: true, runs: local, trend: supa };
  });
}

// ─── Inline editor JS modules ────────────────────────────────────────────
const COMMON_JS = /* javascript */ `
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showStatus(el, ok, txt) {
  el.innerHTML = '<span class="' + (ok?'ok':'err') + '">' + esc(txt) + '</span>';
  if (ok) setTimeout(() => el.textContent='', 2500);
}
async function fetchJson(url, opts) {
  const res = await fetch(url, opts || {});
  return { ok: res.ok, json: await res.json() };
}
async function patchJson(url, body) {
  const res = await fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const j = await res.json();
  return { ok: res.ok && j.ok, json: j };
}
async function postJson(url, body) {
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const j = await res.json();
  return { ok: res.ok && j.ok, json: j };
}
`;

const SCORING_JS = /* javascript */ `
(() => {
  ${COMMON_JS}
  const SPORTS = ['basketball','football','baseball','hockey','soccer'];
  let doc = null;
  function weightTable(prefix, weightsObj) {
    const rows = Object.entries(weightsObj).map(([k,v]) =>
      '<tr><td><code>' + esc(k) + '</code></td>' +
      '<td><input type="number" step="0.01" data-path="' + prefix + '.' + esc(k) + '" value="' + v + '" /></td></tr>'
    ).join('');
    return '<table>' + rows + '</table>';
  }
  function render() {
    const root = document.getElementById('root');
    root.classList.remove('muted');
    let html = '';
    for (const sport of SPORTS) {
      const block = doc.by_sport[sport];
      html += '<div class="card-block"><h3 style="margin:0 0 6px;">' + esc(sport) + '</h3>';
      if (sport === 'baseball') {
        html += '<h4 style="margin:6px 0;color:var(--muted);">hitter weights</h4>' + weightTable('by_sport.' + sport + '.hitter_weights', block.hitter_weights);
        html += '<h4 style="margin:6px 0;color:var(--muted);">pitcher weights</h4>' + weightTable('by_sport.' + sport + '.pitcher_weights', block.pitcher_weights);
      } else if (sport === 'hockey') {
        html += '<h4 style="margin:6px 0;color:var(--muted);">skater weights</h4>' + weightTable('by_sport.' + sport + '.skater_weights', block.skater_weights);
        html += '<h4 style="margin:6px 0;color:var(--muted);">goalie weights</h4>' + weightTable('by_sport.' + sport + '.goalie_weights', block.goalie_weights);
      } else {
        html += weightTable('by_sport.' + sport + '.weights', block.weights);
      }
      html += '<div style="margin-top:8px;font-size:13px;">games per week: <input type="number" step="0.1" min="0" data-path="by_sport.' + sport + '.games_per_week" value="' + (block.games_per_week ?? '') + '" style="width:80px;" /></div>';
      html += '<div style="margin-top:6px;font-size:13px;" title="Inverse-scale factor that converges per-game-day median PP across sports — see docs/scoring-balance-2026-05-02.md">per-sport multiplier: <input type="number" step="0.001" min="0" data-path="by_sport.' + sport + '.per_sport_multiplier" value="' + (block.per_sport_multiplier ?? 1) + '" style="width:100px;" /></div>';
      html += '</div>';
    }
    const g = doc.global;
    html += '<div class="card-block"><h3 style="margin:0 0 6px;">global</h3>' +
      '<table>' +
      '<tr><td>roster_size</td><td><input type="number" min="1" max="12" data-path="global.roster_size" value="' + g.roster_size + '" /></td></tr>' +
      '<tr><td>synthetic_user_count</td><td><input type="number" min="10" max="10000" data-path="global.synthetic_user_count" value="' + g.synthetic_user_count + '" /></td></tr>' +
      '<tr><td>weekly_energy_budget</td><td><input type="number" min="0" max="64" data-path="global.weekly_energy_budget" value="' + (g.weekly_energy_budget ?? 8) + '" /></td></tr>' +
      '</table>' +
      '<h4 style="margin:10px 0 6px;color:var(--muted);">min_picks_per_sport</h4>' +
      '<table>' + SPORTS.map(s =>
        '<tr><td><code>' + esc(s) + '</code></td>' +
        '<td><input type="number" min="0" max="5" data-path="global.min_picks_per_sport.' + s + '" value="' + (g.min_picks_per_sport[s] ?? 0) + '" style="width:80px;" /></td></tr>'
      ).join('') + '</table>' +
      '</div>';
    root.innerHTML = html;
  }
  function applyPrefilledChanges(changes) {
    for (const [path, value] of Object.entries(changes)) {
      const el = document.querySelector('[data-path="' + path + '"]');
      if (el) { el.value = value; el.style.background = 'rgba(108,212,255,0.18)'; }
    }
  }
  async function load() {
    const r = await fetchJson('/admin/api/scoring');
    if (!r.ok) return;
    doc = r.json.doc;
    render();
    const params = new URLSearchParams(location.search);
    const prefill = params.get('prefill');
    if (prefill) { try { applyPrefilledChanges(JSON.parse(prefill)); } catch {} }
  }
  function collectPatch() {
    const patch = { by_sport: {}, global: {} };
    document.querySelectorAll('[data-path]').forEach(el => {
      const segs = el.dataset.path.split('.');
      let cursor = patch;
      for (let i = 0; i < segs.length - 1; i++) {
        cursor[segs[i]] = cursor[segs[i]] ?? {};
        cursor = cursor[segs[i]];
      }
      const v = el.value === '' ? null : Number(el.value);
      if (v !== null && Number.isFinite(v)) cursor[segs[segs.length-1]] = v;
    });
    return patch;
  }
  document.getElementById('saveAll').addEventListener('click', async () => {
    const status = document.getElementById('status');
    const patch = collectPatch();
    const r = await patchJson('/admin/api/scoring', patch);
    if (r.ok) { doc = r.json.doc; render(); showStatus(status, true, 'saved'); }
    else { const errs = (r.json.errors || []).map(e => e.field + ': ' + e.message).join(', '); showStatus(status, false, errs || 'error'); }
  });
  document.getElementById('reload').addEventListener('click', load);
  load();
})();
`;

const SIMULATE_JS = /* javascript */ `
(() => {
  ${COMMON_JS}
  const LEAGUE_LABELS = { nba: 'NBA', nfl: 'NFL', mlb: 'MLB', nhl: 'NHL', mls: 'MLS' };
  function renderLeaguePicker() {
    const root = document.getElementById('leagues');
    root.innerHTML = Object.keys(LEAGUE_LABELS).map(l =>
      '<label style="font-size:13px;"><input type="checkbox" name="lg" value="' + l + '"' + (l==='nfl'?' checked':'') + ' /> ' + LEAGUE_LABELS[l] + '</label>'
    ).join('');
  }
  function selectedLeagues() {
    return Array.from(document.querySelectorAll('input[name="lg"]:checked')).map(el => el.value);
  }
  function fmt(n) { return n == null ? '—' : Number.isFinite(n) ? Math.round(n*100)/100 : '—'; }
  function pct(n) { return n == null ? '—' : (Math.round(n*10)/10) + '%'; }
  function bar(bins, color) {
    if (!bins || bins.length === 0) return '';
    const max = Math.max(...bins);
    return '<svg viewBox="0 0 ' + bins.length + ' 40" preserveAspectRatio="none" style="width:100%;height:80px;background:var(--card-2);border-radius:6px;">' +
      bins.map((v, i) => {
        const h = max > 0 ? (v/max)*38 : 0;
        return '<rect x="' + i + '" y="' + (40-h) + '" width="0.85" height="' + h + '" fill="' + (color||'#6cd4ff') + '" />';
      }).join('') + '</svg>';
  }
  function renderResults(data) {
    const root = document.getElementById('results');
    if (!data || !data.results) {
      root.innerHTML = '<div class="card-block err">No results.</div>';
      return;
    }
    const r = data.results;
    const f = r.fairness;
    const ratioColor = f.top1_to_median_ratio >= 10 ? '#f87171' : f.top1_to_median_ratio >= 7 ? '#facc15' : '#4ade80';
    const stabColor = f.rank_stability >= 0.5 ? '#4ade80' : f.rank_stability >= 0.3 ? '#facc15' : '#f87171';
    const compColor = f.competitive_pct >= 50 ? '#4ade80' : f.competitive_pct >= 30 ? '#facc15' : '#f87171';
    const sportRows = f.sport_contributions.map(s =>
      '<tr><td>' + esc(s.sport) + '</td><td>' + fmt(s.meanPerRoster) + '</td><td>' + fmt(s.top1pct) + '</td></tr>'
    ).join('');
    const adj = (f.suggested_adjustments || []).map(a => '<li>' + esc(a) + '</li>').join('');
    const cu = f.card_uplift_distribution || { mean:0, p50:0, p90:0, bins:[] };
    const eu = f.energy_utilization || { mean:0, p50:0, p90:0 };
    const sportBars = f.sport_contributions.map(s => {
      const max = Math.max(...f.sport_contributions.map(x => x.meanPerRoster));
      const w = max > 0 ? (s.meanPerRoster/max)*100 : 0;
      return '<div class="mini-bar-row"><span class="label">' + esc(s.sport) + '</span><span class="bar"><span class="bar-fill" style="width:' + w + '%;"></span></span><span class="val">' + fmt(s.meanPerRoster) + '</span></div>';
    }).join('');
    const notes = (r.notes || []).map(n => '<li>' + esc(n) + '</li>').join('');
    root.innerHTML = '' +
      '<div class="card-block"><h3 style="margin:0 0 8px;">Headline metrics — fairness score: <span style="color:var(--accent);">' + fmt(f.fairness_score) + '</span></h3>' +
      '<div class="tile-grid">' +
        '<div class="tile"><div class="label">user count</div><div class="value">' + f.user_count.toLocaleString() + '</div><div class="sub">' + f.weeks_simulated + ' weeks</div></div>' +
        '<div class="tile"><div class="label">top-1% / median</div><div class="value" style="color:' + ratioColor + ';">' + fmt(f.top1_to_median_ratio) + '×</div><div class="sub">target ~5×; ≥10× unfair</div></div>' +
        '<div class="tile"><div class="label">rank stability</div><div class="value" style="color:' + stabColor + ';">' + fmt(f.rank_stability) + '</div><div class="sub">target &gt; 0.5</div></div>' +
        '<div class="tile"><div class="label">competitive %</div><div class="value" style="color:' + compColor + ';">' + pct(f.competitive_pct) + '</div><div class="sub">top-half within 25% of #1</div></div>' +
        '<div class="tile"><div class="label">total stddev</div><div class="value">' + fmt(f.total_stddev) + '</div><div class="sub">across rosters</div></div>' +
        '<div class="tile"><div class="label">FA engagement</div><div class="value">' + pct(f.fa_engagement_pct) + '</div><div class="sub">≥30% target</div></div>' +
      '</div></div>' +
      '<div class="card-block"><h3 style="margin:0 0 6px;">Distribution of total roster scores</h3>' + bar(f.histogram.bins) +
      '<div class="muted" style="font-size:11px;margin-top:4px;">range: ' + fmt(f.histogram.min) + ' – ' + fmt(f.histogram.max) + ' · 16 bins</div></div>' +
      '<div class="card-block"><h3 style="margin:0 0 6px;">Card uplift per roster — mean ' + fmt(cu.mean) + ' · p50 ' + fmt(cu.p50) + ' · p90 ' + fmt(cu.p90) + '</h3>' + bar(cu.bins, '#a78bfa') +
      '<div class="muted" style="font-size:11px;margin-top:4px;">range: ' + fmt(cu.min) + ' – ' + fmt(cu.max) + '</div></div>' +
      '<div class="card-block"><h3 style="margin:0 0 6px;">Energy utilization (spent / available)</h3>' +
        '<div class="kv"><span class="k">mean</span><span>' + pct((eu.mean||0)*100) + '</span></div>' +
        '<div class="kv"><span class="k">p50</span><span>' + pct((eu.p50||0)*100) + '</span></div>' +
        '<div class="kv"><span class="k">p90</span><span>' + pct((eu.p90||0)*100) + '</span></div>' +
      '</div>' +
      '<div class="card-block"><h3 style="margin:0 0 6px;">Per-sport contribution to roster scores</h3>' + sportBars +
        '<table style="margin-top:8px;"><thead><tr><th>sport</th><th>mean per roster</th><th>top-1%</th></tr></thead><tbody>' + sportRows + '</tbody></table>' +
      '</div>' +
      '<div class="card-block"><h3 style="margin:0 0 6px;">Suggested adjustments</h3><ul style="margin:0;padding-left:18px;">' + adj + '</ul>' +
        '<div style="margin-top:10px;"><a class="btn primary" href="/admin/edit/scoring">Open scoring editor</a></div>' +
      '</div>' +
      (notes ? '<div class="card-block"><h3 style="margin:0 0 6px;">Notes</h3><ul style="margin:0;padding-left:18px;color:var(--muted);">' + notes + '</ul></div>' : '');
  }

  let pollTimer = null;
  async function poll(runId) {
    const r = await fetchJson('/admin/api/simulate/' + encodeURIComponent(runId));
    if (!r.ok) return;
    const j = r.json;
    const fill = document.getElementById('progressFill');
    const note = document.getElementById('progressNote');
    if (fill) fill.style.width = Math.round((j.progress||0)*100) + '%';
    if (note) note.textContent = (j.progress_note || '') + ' (' + Math.round((j.progress||0)*100) + '%)';
    if (j.status === 'completed') {
      clearInterval(pollTimer); pollTimer = null;
      document.getElementById('progress').style.display = 'none';
      renderResults(j);
    } else if (j.status === 'failed') {
      clearInterval(pollTimer); pollTimer = null;
      document.getElementById('progress').style.display = 'none';
      document.getElementById('results').innerHTML = '<div class="card-block err">Run failed: ' + esc(j.error || 'unknown') + '</div>';
    }
  }

  document.getElementById('run').addEventListener('click', async () => {
    const status = document.getElementById('status');
    const leagues = selectedLeagues();
    if (leagues.length === 0) return showStatus(status, false, 'pick at least one league');
    const seasons = Number(document.getElementById('seasons').value);
    const userCount = Number(document.getElementById('users').value);
    const cards = document.getElementById('cards').checked;
    const fa = document.getElementById('fa').checked;
    const r = await postJson('/admin/api/simulate', {
      leagues, seasons, user_count: userCount,
      disable_cards: !cards, disable_fa: !fa
    });
    if (!r.ok) return showStatus(status, false, r.json.error || 'failed to start');
    showStatus(status, true, 'run ' + r.json.run_id.slice(0,8) + ' started');
    document.getElementById('progress').style.display = '';
    document.getElementById('results').innerHTML = '';
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => poll(r.json.run_id), 3000);
    poll(r.json.run_id);
  });

  renderLeaguePicker();
})();
`;
