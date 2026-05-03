/**
 * adminScoringTrend.ts — admin route for the scoring trend dashboard.
 *
 * Two endpoints, same threat model as the rest of /admin/* (tunnel-only):
 *
 *   GET /admin/api/scoring-trend?weeks=8
 *     → JSON: { weeks, days[], enabled_sports, source }
 *       Per-day stacked sport contribution + roster_avg over the window.
 *
 *   GET /admin/edit/scoring-trend
 *     → HTML: Chart.js stacked bar (sport contribution) + line overlay
 *       (roster_avg). Date range picker (1/4/8/12 weeks), legend toggles,
 *       hover tooltip, mobile-responsive.
 *
 * Stefan uses this to verify the daily-parity rebalance is working: if it
 * is, every active game day's sport contributions should be ~equal.
 */
import type { FastifyInstance } from 'fastify';
import { SHARED_STYLE, SHARED_CRUMBS } from './adminEdit.js';
import {
  buildScoringTrend,
  type Granularity,
} from '../services/simulation/scoringTrend.js';

export async function adminScoringTrendRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── JSON endpoint ─────────────────────────────────────────────────────
  fastify.get<{ Querystring: { weeks?: string; granularity?: string } }>(
    '/admin/api/scoring-trend',
    async (req, reply) => {
      const weeksRaw = req.query?.weeks;
      const weeks = weeksRaw ? Number(weeksRaw) : 8;
      const granRaw = (req.query?.granularity ?? 'daily').toLowerCase();
      const granularity: Granularity = granRaw === 'weekly' ? 'weekly' : 'daily';
      try {
        return await buildScoringTrend(weeks, granularity);
      } catch (err) {
        reply.code(500).send({
          ok: false,
          error: err instanceof Error ? err.message : 'unknown error',
        });
        return reply;
      }
    },
  );

  // ─── HTML chart page ───────────────────────────────────────────────────
  fastify.get('/admin/edit/scoring-trend', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return CHART_PAGE_HTML;
  });
}

// ─── Inline chart page ───────────────────────────────────────────────────
// Self-contained: SHARED_STYLE + Chart.js from CDN. Polls
// /admin/api/scoring-trend, re-renders on date-range button clicks.

const CHART_PAGE_HTML = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PlayGM Editor · Scoring Trend</title>
<style>${SHARED_STYLE}
  .range-picker { display: flex; gap: 6px; flex-wrap: wrap; }
  .range-btn {
    background: var(--card-2); color: var(--muted); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; font-family: inherit;
  }
  .range-btn.active { background: rgba(108,212,255,0.15); border-color: var(--accent); color: var(--accent); }
  .chart-wrap { position: relative; min-height: 380px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .chart-inner { min-width: 720px; height: 380px; }
  .legend-line { font-size: 12px; color: var(--muted); margin-top: 8px; }
  .meta-line { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
  .meta-line code { color: var(--accent); }
  @media (max-width: 720px) {
    .chart-inner { height: 320px; }
  }
</style>
</head><body>
<div class="wrap">
  <header>
    <h1>Scoring Trend</h1>
    ${SHARED_CRUMBS}
  </header>

  <div class="muted" style="margin-bottom:10px;">
    Per-day stacked sport contribution to roster PP, with overall roster_avg overlaid.
    Verifies the
    <a href="/admin/edit/scoring" style="color:var(--accent);">daily-parity rebalance</a>:
    every active game day for an enabled sport should contribute roughly the same.
  </div>

  <div class="card-block">
    <div class="toolbar">
      <span style="color:var(--muted);font-size:12px;">Granularity:</span>
      <div class="range-picker" id="granPicker">
        <button class="range-btn active" data-gran="daily">Daily</button>
        <button class="range-btn" data-gran="weekly">Weekly</button>
      </div>
      <span style="color:var(--muted);font-size:12px;margin-left:8px;">Window:</span>
      <div class="range-picker" id="rangePicker">
        <button class="range-btn" data-weeks="1">1 week</button>
        <button class="range-btn" data-weeks="4">4 weeks</button>
        <button class="range-btn active" data-weeks="8">8 weeks</button>
        <button class="range-btn" data-weeks="12">12 weeks</button>
      </div>
      <span class="hint" id="status" style="margin-left:auto;"></span>
    </div>
    <div class="meta-line" id="metaLine">—</div>
    <div class="chart-wrap">
      <div class="chart-inner"><canvas id="trendChart"></canvas></div>
    </div>
    <div class="legend-line">
      Click a series in the legend to hide it. Hover a bar for exact per-sport values.
      <span id="granHint">Daily mode: each bar is one calendar day; sports only stack on their game days.</span>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<script>
(() => {
  const SPORT_COLORS = {
    nfl: '#f87171', // red
    nba: '#fb923c', // orange
    mlb: '#4ade80', // green
    nhl: '#6cd4ff', // accent blue
    mls: '#a78bfa', // purple (hidden by sports config but rendered if returned)
  };
  const SPORT_LABELS = { nfl: 'NFL', nba: 'NBA', mlb: 'MLB', nhl: 'NHL', mls: 'MLS' };
  const ALL_SPORTS = ['nfl', 'nba', 'mlb', 'nhl', 'mls'];

  let chart = null;
  let currentWeeks = 8;
  let currentGran = 'daily';

  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function labelFor(iso, granularity) {
    if (granularity === 'weekly') return 'wk of ' + fmtDate(iso);
    return fmtDate(iso);
  }

  function buildDatasets(points, enabledSports) {
    // Stacked per-sport bars on left axis.
    const datasets = [];
    for (const sport of ALL_SPORTS) {
      // Hide sports not in the response's enabled_sports list to start —
      // user can still toggle them on if data is present.
      const hidden = !enabledSports.includes(sport);
      const data = points.map(p => p.by_sport[sport] ?? 0);
      // Skip the dataset entirely if every value is 0 (sport has no data at all).
      if (data.every(v => !v)) continue;
      datasets.push({
        type: 'bar',
        label: SPORT_LABELS[sport],
        data,
        backgroundColor: SPORT_COLORS[sport],
        borderColor: SPORT_COLORS[sport],
        borderWidth: 0,
        stack: 'sports',
        yAxisID: 'y',
        hidden,
      });
    }
    // Roster avg line on right axis.
    datasets.push({
      type: 'line',
      label: 'Roster avg',
      data: points.map(p => p.roster_avg),
      borderColor: '#facc15',
      backgroundColor: 'rgba(250,204,21,0.2)',
      borderWidth: 2,
      pointRadius: 2,
      tension: 0.25,
      yAxisID: 'y1',
      stack: undefined,
    });
    return datasets;
  }

  function render(payload) {
    const points = (payload.days || []).map(d => ({ ...d, label: labelFor(d.date, payload.granularity) }));
    const labels = points.map(p => p.label);
    const datasets = buildDatasets(points, payload.enabled_sports);
    const isWeekly = payload.granularity === 'weekly';
    const yTitle = isWeekly ? 'Weekly sport contribution (PP)' : 'Daily sport contribution (PP)';
    const y1Title = isWeekly ? 'Roster avg, weekly total (PP)' : 'Roster avg, daily (PP)';

    if (chart) chart.destroy();
    const ctx = document.getElementById('trendChart').getContext('2d');
    chart = new Chart(ctx, {
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#e6edf3', boxWidth: 14, padding: 12 },
          },
          tooltip: {
            backgroundColor: '#0b0f17',
            borderColor: '#1f2a3b',
            borderWidth: 1,
            titleColor: '#e6edf3',
            bodyColor: '#e6edf3',
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                if (typeof v !== 'number') return ctx.dataset.label + ': —';
                return ctx.dataset.label + ': ' + v.toFixed(1) + ' PP';
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: '#8aa0b8', maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
            grid: { color: '#1f2a3b', drawOnChartArea: false },
          },
          y: {
            stacked: true,
            position: 'left',
            beginAtZero: true,
            title: { display: true, text: yTitle, color: '#8aa0b8' },
            ticks: { color: '#8aa0b8' },
            grid: { color: '#1f2a3b' },
          },
          y1: {
            position: 'right',
            beginAtZero: true,
            title: { display: true, text: y1Title, color: '#facc15' },
            ticks: { color: '#facc15' },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });

    const meta = document.getElementById('metaLine');
    const unit = isWeekly ? 'weeks' : 'days';
    let s = 'Source: <code>' + payload.source + '</code>';
    s += ' · granularity: <code>' + payload.granularity + '</code>';
    if (payload.source_run_id) {
      s += ' · run <code>' + payload.source_run_id.slice(0, 8) + '</code>';
    }
    if (payload.source_run_completed_at) {
      s += ' · ' + new Date(payload.source_run_completed_at).toLocaleString();
    }
    s += ' · ' + (payload.days || []).length + ' ' + unit + ' · enabled: ' + (payload.enabled_sports || []).join(', ');
    meta.innerHTML = s;

    const hint = document.getElementById('granHint');
    if (hint) {
      hint.textContent = isWeekly
        ? 'Weekly mode: each bar sums all 7 days into one bucket; bar height is the week\\'s total per-sport contribution.'
        : 'Daily mode: each bar is one calendar day; sports only stack on their game days.';
    }
  }

  async function load(weeks, gran) {
    const status = document.getElementById('status');
    status.textContent = 'loading…';
    try {
      const res = await fetch('/admin/api/scoring-trend?weeks=' + weeks + '&granularity=' + gran);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
      render(payload);
      status.textContent = '';
    } catch (err) {
      status.innerHTML = '<span class="err">' + (err.message || 'load failed') + '</span>';
    }
  }

  function setupRangePicker() {
    const picker = document.getElementById('rangePicker');
    picker.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      const w = Number(btn.dataset.weeks);
      if (!w || w === currentWeeks) return;
      currentWeeks = w;
      [...picker.querySelectorAll('.range-btn')].forEach(b => b.classList.toggle('active', b === btn));
      load(currentWeeks, currentGran);
    });
  }

  function setupGranPicker() {
    const picker = document.getElementById('granPicker');
    picker.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      const g = btn.dataset.gran;
      if (!g || g === currentGran) return;
      currentGran = g;
      [...picker.querySelectorAll('.range-btn')].forEach(b => b.classList.toggle('active', b === btn));
      load(currentWeeks, currentGran);
    });
  }

  setupRangePicker();
  setupGranPicker();
  load(currentWeeks, currentGran);
})();
</script>
</body></html>`;
