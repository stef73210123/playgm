/**
 * adminSimulation.ts — admin routes for the scoring formula editor
 * (mirrors /admin/edit/packs pattern). The fairness-simulator routes
 * live in this file too once the next commit lands; for now this is
 * just the editor surface so admins can tune scoring before invoking
 * the simulator.
 *
 * Surfaces:
 *   GET   /admin/edit/scoring          — HTML editor
 *   GET   /admin/api/scoring           — return current formula JSON
 *   PATCH /admin/api/scoring           — validate + write +
 *                                        chore(content): update scoring formula
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  SHARED_STYLE,
  SHARED_CRUMBS,
  autoCommit,
  badRequest,
  type ValidationError,
} from './adminEdit.js';
import {
  type ScoringFormulaFile,
  type Sport,
  FORMULA_PATH,
} from '../services/simulation/scoringFormula.js';

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
<script>${scriptJs}</script>
</body></html>`;
}

// ─── Route registration ──────────────────────────────────────────────────
export async function adminSimulationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/edit/scoring', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Scoring',
      'Fantasy Scoring Formula',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/economy/pgm_scoring_formula.json</code> · auto-commits on save.
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
}

// ─── Inline editor JS ────────────────────────────────────────────────────
const COMMON_JS = /* javascript */ `
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showStatus(el, ok, txt) {
  el.innerHTML = '<span class="' + (ok?'ok':'err') + '">' + esc(txt) + '</span>';
  if (ok) setTimeout(() => el.textContent='', 2500);
}
async function fetchJson(url, opts) { const res = await fetch(url, opts || {}); return { ok: res.ok, json: await res.json() }; }
async function patchJson(url, body) {
  const res = await fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
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
  async function load() {
    const r = await fetchJson('/admin/api/scoring');
    if (!r.ok) return;
    doc = r.json.doc;
    render();
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
