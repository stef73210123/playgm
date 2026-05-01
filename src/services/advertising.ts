/**
 * advertising.ts — marketing-channel rollups for the admin dashboard.
 *
 * Reads two JSON files:
 *   - data/marketing/channel_definitions.json (read-only, defines shape + targets)
 *   - data/marketing/channel_actuals.json     (mutable, edited via /admin/edit/advertising)
 *
 * Computes derived metrics where the underlying counters are present:
 *   - CTR  = clicks / impressions × 100
 *   - CPI  = spend / installs (USD)
 *   - CAC  = spend / signups  (USD; falls back to spend / installs when no signup column)
 *   - ROAS = revenue / spend
 *
 * Returns a per-channel report with a "status" pill (on_target | near | off |
 * unmeasured) plus a portfolio-level rollup (total spend, blended CPI / CAC /
 * ROAS, attributed installs 30d, conversion funnel).
 *
 * Cached for 60s (JSON reads are cheap but repeated polls add up).
 *
 * NOTE: every target in channel_definitions.json is flagged 'extrapolated' or
 * 'industry-standard' — none are sourced from the GDD. Stefan can override
 * before any real spend lands.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 60_000;

function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, '..'),
    path.resolve(cwd, '..', '..'),
    path.resolve(cwd, '..', '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'cards', 'pgm_card_templates.json'))) return c;
  }
  return cwd;
}
const PROJECT_ROOT = findProjectRoot();
const DEFINITIONS_PATH = path.join(PROJECT_ROOT, 'data', 'marketing', 'channel_definitions.json');
const ACTUALS_PATH = path.join(PROJECT_ROOT, 'data', 'marketing', 'channel_actuals.json');

// ─── Types ───────────────────────────────────────────────────────────────

export interface ChannelDefinition {
  channel_id: string;
  display_name: string;
  category: string;
  subchannels?: string[];
  metric_keys: string[];
  audience_constraints?: string[];
  kpi_focus: string;
  targets: Record<string, number>;
  target_source?: string;
}

export interface ChannelDefinitionsFile {
  version: string;
  notes?: string[];
  channels: ChannelDefinition[];
}

export type PeriodActuals = Record<string, number>;

export interface ChannelActuals {
  current_month: PeriodActuals;
  last_month?: PeriodActuals;
  last_updated_iso?: string | null;
}

export interface ChannelActualsFile {
  version: string;
  last_updated_iso?: string | null;
  actuals_by_channel: Record<string, ChannelActuals>;
  funnel_30d?: { first_roster_locked?: number; paid_subs?: number };
}

export type ChannelStatus = 'on_target' | 'near' | 'off' | 'unmeasured';

export interface ChannelReport {
  channel_id: string;
  display_name: string;
  category: string;
  subchannels?: string[];
  audience_constraints?: string[];
  kpi_focus: string;
  current: Record<string, number>;
  last_month?: Record<string, number>;
  target: Record<string, number>;
  status: ChannelStatus;
  last_updated_iso: string | null;
  target_source?: string;
}

export interface AdvertisingReport {
  channels: ChannelReport[];
  portfolio: {
    monthly_spend_total_usd: number;
    blended_cpi_usd: number | null;
    blended_cac_usd: number | null;
    blended_roas: number | null;
    attributed_installs_30d_total: number;
    conversion_funnel: {
      impressions: number;
      clicks: number;
      installs: number;
      signups: number;
      first_roster_locked: number;
      paid_subs: number;
    };
  };
  last_updated_iso: string | null;
  notes: string[];
}

// ─── Cache ────────────────────────────────────────────────────────────────

interface Cache {
  ts: number;
  report: AdvertisingReport;
}
let cache: Cache | null = null;

// ─── Loaders ──────────────────────────────────────────────────────────────

export function loadChannelDefinitions(): ChannelDefinitionsFile {
  const raw = readFileSync(DEFINITIONS_PATH, 'utf8');
  return JSON.parse(raw) as ChannelDefinitionsFile;
}

export function loadChannelActuals(): ChannelActualsFile {
  const raw = readFileSync(ACTUALS_PATH, 'utf8');
  return JSON.parse(raw) as ChannelActualsFile;
}

// ─── Derived-metric helpers ───────────────────────────────────────────────

function safeDiv(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return n / d;
}

function round(v: number | null, digits: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

/**
 * Augment a period's actuals with derived ratios where the inputs exist.
 * - ctr_pct, cpi_usd, cac_usd, roas, completion_rate_pct
 *
 * Returns a new object so we don't mutate the source JSON in memory.
 */
export function withDerivedMetrics(p: PeriodActuals): Record<string, number> {
  const out: Record<string, number> = { ...p };

  const impressions = num(p['impressions']);
  const clicks = num(p['clicks']);
  const taps = num(p['taps']);
  const installs = num(p['installs']);
  const signups = num(p['signups']);
  const spend = num(p['spend_usd']);
  const revenue = num(p['revenue_usd']);
  const completions = num(p['completions']);

  if (impressions > 0 && clicks > 0) {
    const ctr = round(safeDiv(clicks * 100, impressions), 2);
    if (ctr != null) out['ctr_pct'] = ctr;
  } else if (impressions > 0 && taps > 0) {
    // Apple Search Ads — taps stand in for clicks.
    const ctr = round(safeDiv(taps * 100, impressions), 2);
    if (ctr != null) out['ctr_pct'] = ctr;
  }
  if (impressions > 0 && taps > 0 && installs > 0) {
    const conv = round(safeDiv(installs * 100, taps), 2);
    if (conv != null) out['conversion_rate_pct'] = conv;
  }
  if (spend > 0 && installs > 0) {
    const cpi = round(safeDiv(spend, installs), 2);
    if (cpi != null) out['cpi_usd'] = cpi;
  }
  if (spend > 0 && signups > 0) {
    const cac = round(safeDiv(spend, signups), 2);
    if (cac != null) out['cac_usd'] = cac;
  }
  if (spend > 0 && revenue > 0) {
    const roas = round(safeDiv(revenue, spend), 3);
    if (roas != null) out['roas'] = roas;
  }
  if (impressions > 0 && completions > 0) {
    const cr = round(safeDiv(completions * 100, impressions), 2);
    if (cr != null) out['completion_rate_pct'] = cr;
  }

  return out;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ─── Status classification ────────────────────────────────────────────────
/**
 * Compare a channel's KPI against its target. The KPI focus determines the
 * direction of "good": for CPI / CAC, lower is better; for ROAS, engagement,
 * installs, etc. higher is better.
 *
 *   on_target = within ±15% of target
 *   near      = within ±35% of target
 *   off       = beyond ±35%
 *   unmeasured = no KPI value present (zeroed-out / missing inputs)
 */
function classify(kpi: string, actual: number | null, target: number): ChannelStatus {
  if (actual == null || target <= 0) return 'unmeasured';
  const lowerIsBetter = /cpi|cac|cost/i.test(kpi);
  const ratio = actual / target;
  if (lowerIsBetter) {
    if (ratio <= 1.15) return 'on_target';
    if (ratio <= 1.35) return 'near';
    return 'off';
  }
  if (ratio >= 0.85) return 'on_target';
  if (ratio >= 0.65) return 'near';
  return 'off';
}

function targetForKpiFocus(def: ChannelDefinition): { key: string; value: number } | null {
  // Map kpi_focus → target key naming. We try a few common patterns.
  const focus = def.kpi_focus;
  const candidates = [
    focus,
    'target_' + focus,
    focus.replace(/_pct$/, '_pct'),
    'target_' + focus.replace(/_pct$/, '_pct'),
    focus.replace(/_usd$/, '_usd'),
    'target_' + focus.replace(/_usd$/, '_usd'),
  ];
  for (const key of candidates) {
    const v = def.targets[key];
    if (typeof v === 'number') return { key, value: v };
  }
  // Fallback: any target key that contains the focus root.
  const root = focus.replace(/_(pct|usd)$/, '');
  for (const [key, v] of Object.entries(def.targets)) {
    if (key.includes(root) && typeof v === 'number') return { key, value: v };
  }
  return null;
}

// ─── Build report ─────────────────────────────────────────────────────────

function buildReportInternal(
  defs: ChannelDefinitionsFile,
  actualsFile: ChannelActualsFile,
): AdvertisingReport {
  const reports: ChannelReport[] = [];
  const notes: string[] = [];

  let totalSpend = 0;
  let totalInstalls = 0;
  let totalSignups = 0;
  let totalRevenue = 0;
  let totalImpressions = 0;
  let totalClicks = 0;
  let attributedInstalls30d = 0;

  for (const def of defs.channels) {
    const a = actualsFile.actuals_by_channel[def.channel_id];
    const cur = a?.current_month ?? {};
    const lm = a?.last_month;
    const curWithDerived = withDerivedMetrics(cur);
    const lmWithDerived = lm ? withDerivedMetrics(lm) : undefined;

    const targetEntry = targetForKpiFocus(def);
    const kpiActualRaw = curWithDerived[def.kpi_focus];
    const kpiActual: number | null =
      typeof kpiActualRaw === 'number' && Number.isFinite(kpiActualRaw) && kpiActualRaw > 0
        ? kpiActualRaw
        : null;
    const status: ChannelStatus = targetEntry
      ? classify(def.kpi_focus, kpiActual, targetEntry.value)
      : 'unmeasured';

    reports.push({
      channel_id: def.channel_id,
      display_name: def.display_name,
      category: def.category,
      subchannels: def.subchannels,
      audience_constraints: def.audience_constraints,
      kpi_focus: def.kpi_focus,
      current: curWithDerived,
      last_month: lmWithDerived,
      target: def.targets,
      status,
      last_updated_iso: a?.last_updated_iso ?? null,
      target_source: def.target_source,
    });

    // Portfolio totals — pull from raw counters (not derived) to avoid
    // double-counting.
    totalSpend += num(cur['spend_usd']);
    totalInstalls += num(cur['installs']);
    totalSignups += num(cur['signups']);
    totalRevenue += num(cur['revenue_usd']);
    totalImpressions += num(cur['impressions']);
    totalClicks += num(cur['clicks']) + num(cur['taps']);
    // Roblox uses attributed_app_installs_30d; YT Kids uses attributed_signups_30d;
    // organic channels use attributed_installs_30d. Sum all "attributed" install variants.
    attributedInstalls30d +=
      num(cur['attributed_installs_30d']) + num(cur['attributed_app_installs_30d']);
  }

  const blendedCpi = round(safeDiv(totalSpend, totalInstalls), 2);
  const blendedCac = round(safeDiv(totalSpend, totalSignups), 2);
  const blendedRoas = round(safeDiv(totalRevenue, totalSpend), 3);

  const funnel = actualsFile.funnel_30d ?? {};

  if (totalSpend === 0) {
    notes.push(
      'Portfolio spend is $0 — actuals scaffold present, no real data entered yet. Use /admin/edit/advertising.',
    );
  }
  notes.push(
    'All channel targets are extrapolated / industry-standard — not sourced from any GDD section. Override before scaling spend.',
  );

  return {
    channels: reports,
    portfolio: {
      monthly_spend_total_usd: round(totalSpend, 2) ?? 0,
      blended_cpi_usd: blendedCpi,
      blended_cac_usd: blendedCac,
      blended_roas: blendedRoas,
      attributed_installs_30d_total: attributedInstalls30d + totalInstalls,
      conversion_funnel: {
        impressions: totalImpressions,
        clicks: totalClicks,
        installs: totalInstalls + attributedInstalls30d,
        signups: totalSignups,
        first_roster_locked: num(funnel.first_roster_locked),
        paid_subs: num(funnel.paid_subs),
      },
    },
    last_updated_iso: actualsFile.last_updated_iso ?? null,
    notes,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

export function getAdvertisingReport(): AdvertisingReport {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.report;
  try {
    const defs = loadChannelDefinitions();
    const actuals = loadChannelActuals();
    const report = buildReportInternal(defs, actuals);
    cache = { ts: Date.now(), report };
    return report;
  } catch (err) {
    return {
      channels: [],
      portfolio: {
        monthly_spend_total_usd: 0,
        blended_cpi_usd: null,
        blended_cac_usd: null,
        blended_roas: null,
        attributed_installs_30d_total: 0,
        conversion_funnel: {
          impressions: 0,
          clicks: 0,
          installs: 0,
          signups: 0,
          first_roster_locked: 0,
          paid_subs: 0,
        },
      },
      last_updated_iso: null,
      notes: [
        'advertising service degraded: ' + (err instanceof Error ? err.message : String(err)),
      ],
    };
  }
}

/** Test hook + invalidation after PATCH writes. */
export function _resetAdvertisingCacheForTests(): void {
  cache = null;
}

export function invalidateAdvertisingCache(): void {
  cache = null;
}

/** Exposed for tests + the editor route. */
export function buildReport(
  defs: ChannelDefinitionsFile,
  actuals: ChannelActualsFile,
): AdvertisingReport {
  return buildReportInternal(defs, actuals);
}
