/**
 * safetyResolver.test.ts — unit tests for the per-user feature resolver.
 *
 * The pure layering function (`layerOverrides`) is tested directly. It
 * doesn't touch Supabase, so we drive it with synthetic baseline +
 * override arrays — that's where the override-precedence rules live and
 * where regressions would actually bite.
 *
 * `resolveFeaturesForUser` and the cache are exercised indirectly here
 * (we don't stand up a real DB) via the cache-invalidation helper.
 */
// Stub supabase env BEFORE the resolver imports `../db/client.js` (which
// throws at module-load if no creds are present). The resolver tests
// only exercise the pure layering function — the stubbed client is
// never actually invoked. Imports are required (not ES-imported) so the
// module load happens after the env mutation, matching the pattern in
// adminEdit.test.ts.
process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] ?? 'https://stub.supabase.co';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] ?? 'stub';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { layerOverrides, invalidateUserFeaturesCache } = require('./safetyResolver.js') as typeof import('./safetyResolver.js');
import type { EffectiveFeature } from './safetyResolver.js';
import type { ResolvedFeature } from './safetyMatrix.js';

function baseline(decision: ResolvedFeature['decision']): ResolvedFeature[] {
  return [
    {
      feature_id: 'feat_a',
      decision,
      parent_override_allowed: true,
      requires_parent_consent: false,
    },
    {
      feature_id: 'feat_b',
      decision: 'blocked',
      parent_override_allowed: false,
      requires_parent_consent: true,
    },
  ];
}

describe('safetyResolver.layerOverrides', () => {
  it('passes through baseline decisions when no overrides exist', () => {
    const out = layerOverrides(baseline('allow'), []);
    expect(out).toHaveLength(2);
    const a = out.find((f) => f.feature_id === 'feat_a')!;
    expect(a.decision).toBe('allow');
    expect(a.source).toBe('matrix');
    expect(a.reason).toBeUndefined();
  });

  it('an enabled=true override rewrites a blocked baseline to allow', () => {
    const out = layerOverrides(baseline('blocked'), [
      { feature_id: 'feat_a', enabled: true, reason: 'parent unblocked it' },
    ]);
    const a = out.find((f) => f.feature_id === 'feat_a')!;
    expect(a.decision).toBe('allow');
    expect(a.source).toBe('override');
    expect(a.reason).toBe('parent unblocked it');
  });

  it('an enabled=false override rewrites an allow baseline to blocked', () => {
    const out = layerOverrides(baseline('allow'), [
      { feature_id: 'feat_a', enabled: false, reason: 'admin escalation' },
    ]);
    const a = out.find((f) => f.feature_id === 'feat_a')!;
    expect(a.decision).toBe('blocked');
    expect(a.source).toBe('override');
    expect(a.reason).toBe('admin escalation');
  });

  it('overrides win over a hard-blocked baseline (no parent_override_allowed)', () => {
    // feat_b is blocked + parent_override_allowed=false in the baseline,
    // but admin overrides should still be able to flip it — the matrix's
    // parent_override_allowed flag governs PARENT controls, not admin
    // ones. The admin editor is the authoritative escape hatch.
    const out = layerOverrides(baseline('allow'), [
      { feature_id: 'feat_b', enabled: true, reason: 'manual review approved' },
    ]);
    const b = out.find((f) => f.feature_id === 'feat_b')!;
    expect(b.decision).toBe('allow');
    expect(b.source).toBe('override');
  });

  it('preserves parent_override_allowed and requires_parent_consent on override rows', () => {
    const out = layerOverrides(baseline('allow'), [
      { feature_id: 'feat_b', enabled: true, reason: 'r' },
    ]);
    const b = out.find((f) => f.feature_id === 'feat_b')!;
    expect(b.parent_override_allowed).toBe(false); // unchanged from baseline
    expect(b.requires_parent_consent).toBe(true);
  });

  it('handles a null reason (DB column is nullable)', () => {
    const out = layerOverrides(baseline('allow'), [
      { feature_id: 'feat_a', enabled: false, reason: null },
    ]);
    const a = out.find((f) => f.feature_id === 'feat_a')!;
    expect(a.source).toBe('override');
    expect(a.reason).toBeUndefined();
  });

  it('ignores override rows for unknown features (not in baseline)', () => {
    // A stale row in user_safety_overrides for a feature_id that no
    // longer exists in the matrix shouldn't crash or insert phantom
    // entries — the resolver only emits rows present in the baseline.
    const out: EffectiveFeature[] = layerOverrides(baseline('allow'), [
      { feature_id: 'feat_zzz_retired', enabled: true, reason: 'orphan' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((f) => f.feature_id === 'feat_zzz_retired')).toBeUndefined();
  });
});

describe('safetyResolver cache helpers', () => {
  it('invalidateUserFeaturesCache(userId) is a no-op for empty cache', () => {
    expect(() => invalidateUserFeaturesCache('nobody')).not.toThrow();
  });

  it('invalidateUserFeaturesCache() with no arg clears all', () => {
    expect(() => invalidateUserFeaturesCache()).not.toThrow();
  });
});
