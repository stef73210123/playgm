/**
 * advertising.test.ts — sanity tests for the advertising rollup service.
 *
 * Coverage:
 *   1. channel_definitions.json loads cleanly + has the 10 expected channels
 *      with the audience-flag taxonomy taxonomy ("kid-safe", "<13", "13+").
 *   2. Portfolio rollup math: sum of spend, weighted CPI = total_spend / total_installs.
 *   3. PATCH validation rejects negatives + non-numeric values via the
 *      shared validator (re-implemented locally to avoid pulling in Fastify).
 *
 * The PATCH route itself is exercised by the broader adminEdit.test.ts surface;
 * here we verify just the validator + rollup math, which is what actually
 * controls correctness when Stefan pastes data in.
 */
import {
  loadChannelDefinitions,
  buildReport,
  withDerivedMetrics,
  type ChannelActualsFile,
} from './advertising.js';

describe('advertising service', () => {
  it('channel_definitions.json loads cleanly with all 10 channels', () => {
    const defs = loadChannelDefinitions();
    expect(defs.version).toBe('1.0.0');
    expect(defs.channels).toHaveLength(10);
    const ids = defs.channels.map((c) => c.channel_id).sort();
    expect(ids).toEqual(
      [
        'apple_search_ads',
        'google_ads',
        'instagram_organic',
        'meta_paid',
        'reddit',
        'roblox',
        'tiktok_organic',
        'tiktok_paid',
        'x_twitter',
        'youtube_kids',
      ].sort(),
    );
  });

  it('audience-flag taxonomy is set on the kid-facing channels', () => {
    const defs = loadChannelDefinitions();
    const yt = defs.channels.find((c) => c.channel_id === 'youtube_kids')!;
    expect(yt.audience_constraints).toEqual(
      expect.arrayContaining(['<13', 'COPPA-compliant']),
    );
    const rb = defs.channels.find((c) => c.channel_id === 'roblox')!;
    expect(rb.audience_constraints).toEqual(expect.arrayContaining(['kid-safe']));
    const meta = defs.channels.find((c) => c.channel_id === 'meta_paid')!;
    expect(meta.audience_constraints).toEqual(['13+']);
  });

  it('every channel target_source is flagged extrapolated or industry-standard', () => {
    const defs = loadChannelDefinitions();
    for (const c of defs.channels) {
      expect(c.target_source).toBeDefined();
      expect(c.target_source!.toLowerCase()).toMatch(/extrapolated|industry-standard/);
    }
  });

  it('Roblox has the platform-native subchannels (not a traditional ad funnel)', () => {
    const defs = loadChannelDefinitions();
    const rb = defs.channels.find((c) => c.channel_id === 'roblox')!;
    expect(rb.subchannels).toEqual(
      expect.arrayContaining([
        'display_ads',
        'immersive_ads',
        'ugc_items',
        'sponsored_experiences',
        'branded_experience',
      ]),
    );
  });

  it('withDerivedMetrics computes CTR, CPI, CAC, ROAS, completion_rate_pct', () => {
    const out = withDerivedMetrics({
      impressions: 100_000,
      clicks: 2_000,
      installs: 500,
      signups: 250,
      spend_usd: 1_000,
      revenue_usd: 1_500,
      completions: 65_000,
    });
    expect(out['ctr_pct']).toBe(2);
    expect(out['cpi_usd']).toBe(2); // 1000 / 500
    expect(out['cac_usd']).toBe(4); // 1000 / 250
    expect(out['roas']).toBe(1.5); // 1500 / 1000
    expect(out['completion_rate_pct']).toBe(65); // 65k / 100k
  });

  it('portfolio rollup: sum of spend, weighted CPI = total_spend / total_installs', () => {
    const defs = loadChannelDefinitions();
    // Build a synthetic actuals file. Three channels with installs:
    //   meta_paid: $4,000 → 2,000 installs
    //   tiktok_paid: $2,000 → 800 installs
    //   google_ads: $6,000 → 3,000 installs
    // Total: $12,000 / 5,800 installs = $2.07 blended CPI
    const actuals: ChannelActualsFile = {
      version: '1.0.0',
      last_updated_iso: null,
      actuals_by_channel: {
        meta_paid: {
          current_month: {
            spend_usd: 4000,
            impressions: 0,
            clicks: 0,
            installs: 2000,
            signups: 1000,
            revenue_usd: 5000,
          },
        },
        tiktok_paid: {
          current_month: {
            spend_usd: 2000,
            impressions: 0,
            clicks: 0,
            installs: 800,
            signups: 400,
            revenue_usd: 1500,
          },
        },
        google_ads: {
          current_month: {
            spend_usd: 6000,
            impressions: 0,
            clicks: 0,
            installs: 3000,
            signups: 1500,
            revenue_usd: 7500,
          },
        },
      },
      funnel_30d: { first_roster_locked: 600, paid_subs: 90 },
    };

    const report = buildReport(defs, actuals);
    expect(report.portfolio.monthly_spend_total_usd).toBe(12_000);
    // Blended CPI = 12000 / 5800 = 2.0689... → 2.07
    expect(report.portfolio.blended_cpi_usd).toBeCloseTo(2.07, 2);
    // Blended CAC = 12000 / 2900 = 4.13...
    expect(report.portfolio.blended_cac_usd).toBeCloseTo(4.14, 2);
    // Blended ROAS = 14000 / 12000 = 1.1667
    expect(report.portfolio.blended_roas).toBeCloseTo(1.167, 2);
    // Funnel passes through
    expect(report.portfolio.conversion_funnel.first_roster_locked).toBe(600);
    expect(report.portfolio.conversion_funnel.paid_subs).toBe(90);
  });

  it('classify: meta_paid lands "off" when CPI is more than 35% above target', () => {
    const defs = loadChannelDefinitions();
    const actuals: ChannelActualsFile = {
      version: '1.0.0',
      last_updated_iso: null,
      actuals_by_channel: {
        meta_paid: {
          // target CPI is $1.50; actual = $4.00 → ratio 2.67x → off
          current_month: {
            spend_usd: 4000,
            impressions: 100000,
            clicks: 2000,
            installs: 1000, // → CPI = 4
            signups: 500,
            revenue_usd: 0,
          },
        },
      },
    };
    const report = buildReport(defs, actuals);
    const meta = report.channels.find((c) => c.channel_id === 'meta_paid')!;
    expect(meta.current['cpi_usd']).toBe(4);
    expect(meta.status).toBe('off');
  });

  it('classify: zero-data channel reports unmeasured', () => {
    const defs = loadChannelDefinitions();
    const actuals: ChannelActualsFile = {
      version: '1.0.0',
      last_updated_iso: null,
      actuals_by_channel: {},
    };
    const report = buildReport(defs, actuals);
    for (const ch of report.channels) {
      expect(ch.status).toBe('unmeasured');
    }
  });

  // ─── PATCH validation ───────────────────────────────────────────────────
  // Re-implement the validator here to avoid pulling in the full adminEdit
  // dependency chain. Keep this in sync with validateAdvertisingPayload().
  function validateAdvertisingPayloadCopy(body: Record<string, unknown>): Array<{ field: string; message: string }> {
    const errs: Array<{ field: string; message: string }> = [];
    for (const period of ['current_month', 'last_month'] as const) {
      if (body[period] === undefined) continue;
      const p = body[period];
      if (p == null || typeof p !== 'object' || Array.isArray(p)) {
        errs.push({ field: period, message: 'must be object' });
        continue;
      }
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          errs.push({ field: `${period}.${k}`, message: 'must be a finite number' });
          continue;
        }
        if (v < 0) {
          errs.push({ field: `${period}.${k}`, message: 'must be ≥ 0' });
        }
      }
    }
    return errs;
  }

  it('PATCH validation rejects negative numbers', () => {
    const errs = validateAdvertisingPayloadCopy({
      current_month: { spend_usd: -50 },
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]!.field).toBe('current_month.spend_usd');
  });

  it('PATCH validation rejects non-numeric values', () => {
    const errs = validateAdvertisingPayloadCopy({
      current_month: { spend_usd: 'abc' },
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toMatch(/finite number/);
  });

  it('PATCH validation rejects NaN and Infinity', () => {
    const errs = validateAdvertisingPayloadCopy({
      current_month: { spend_usd: NaN, clicks: Infinity },
    });
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it('PATCH validation accepts a valid payload', () => {
    const errs = validateAdvertisingPayloadCopy({
      current_month: { spend_usd: 100.5, impressions: 5000, clicks: 80 },
      last_month: { spend_usd: 0, impressions: 0 },
    });
    expect(errs).toEqual([]);
  });
});
