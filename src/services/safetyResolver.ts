/**
 * safetyResolver.ts — per-user feature resolver layered on top of the
 * age-based safety matrix.
 *
 * Resolution order (highest priority last — overrides win):
 *
 *   1. Look up the user's age (`profiles.birth_year` → year-of-now − birth_year).
 *      If birth_year is missing we fall back to "every feature blocked"
 *      so we never accidentally allow a feature for a user we can't age.
 *   2. Call `resolveFeaturesForAge(age)` to get the matrix-derived baseline.
 *   3. Pull every row in `user_safety_overrides` for this user.
 *      For each, rewrite the baseline:
 *         enabled = true  → "allow"
 *         enabled = false → "blocked"
 *      (`reason` is preserved on the EffectiveFeature so the API can
 *       surface why a feature is non-default — useful for the dashboard.)
 *   4. Cache the resulting array per-user-id for 5 minutes. Override
 *      writes invalidate the cache for that user.
 *
 * Pairs with:
 *   - server/migrations/001_v1_schema.sql        — `user_safety_overrides`
 *   - server/src/services/safetyMatrix.ts        — baseline age matrix
 *   - server/src/routes/adminEdit.ts             — Per-User Overrides editor
 *   - server/src/routes/profile.ts (route reg)   — GET /me/features
 */
import { supabase } from '../db/client.js';
import {
  resolveFeaturesForAge,
  type FeatureDecision,
  type ResolvedFeature,
} from './safetyMatrix.js';

// ─── Types ────────────────────────────────────────────────────────────────

/** Resolution source — tells the dashboard whether the decision came from
 *  the matrix or an override. */
export type ResolutionSource = 'matrix' | 'override';

export interface EffectiveFeature {
  feature_id: string;
  decision: FeatureDecision;
  source: ResolutionSource;
  /** Present iff source === 'override'. */
  reason?: string;
  parent_override_allowed: boolean;
  requires_parent_consent: boolean;
}

export interface EffectiveFeatureSet {
  user_id: string;
  age: number | null;
  features: EffectiveFeature[];
  resolved_at_iso: string;
}

interface UserOverrideRow {
  feature_id: string;
  enabled: boolean;
  reason: string | null;
}

// ─── Cache ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes per the spec
interface CacheEntry {
  set: EffectiveFeatureSet;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/** Test + admin hook — call after a per-user override write. */
export function invalidateUserFeaturesCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Look up a user's age from the `profiles` table. Returns null if the
 * birth_year is missing or the row doesn't exist — callers downgrade to
 * "everything blocked" in that case so we never default an unknown user
 * into adult-grade access.
 *
 * Pulled out of the resolver so we can stub it cheaply in tests
 * without spinning up Supabase.
 */
export async function fetchUserAge(userId: string, today: Date = new Date()): Promise<number | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('birth_year')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const birthYear = (data as { birth_year: number | null }).birth_year;
  if (birthYear == null) return null;
  return today.getFullYear() - birthYear;
}

/** Pull every (feature_id, enabled, reason) override row for one user. */
export async function fetchUserOverrides(userId: string): Promise<UserOverrideRow[]> {
  const { data, error } = await supabase
    .from('user_safety_overrides')
    .select('feature_id, enabled, reason')
    .eq('user_id', userId);
  if (error || !data) return [];
  return data as UserOverrideRow[];
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Pure layering function — exposed for unit tests so we can drive it
 *  with synthetic baselines + overrides without touching Supabase. */
export function layerOverrides(
  baseline: ResolvedFeature[],
  overrides: UserOverrideRow[],
): EffectiveFeature[] {
  const overrideMap = new Map<string, UserOverrideRow>();
  for (const o of overrides) overrideMap.set(o.feature_id, o);

  return baseline.map((b) => {
    const override = overrideMap.get(b.feature_id);
    if (!override) {
      return {
        feature_id: b.feature_id,
        decision: b.decision,
        source: 'matrix' as const,
        parent_override_allowed: b.parent_override_allowed,
        requires_parent_consent: b.requires_parent_consent,
      };
    }
    return {
      feature_id: b.feature_id,
      decision: (override.enabled ? 'allow' : 'blocked') as FeatureDecision,
      source: 'override' as const,
      reason: override.reason ?? undefined,
      parent_override_allowed: b.parent_override_allowed,
      requires_parent_consent: b.requires_parent_consent,
    };
  });
}

/** Build the effective feature set for a user. Cached 5 min per spec. */
export async function resolveFeaturesForUser(userId: string): Promise<EffectiveFeatureSet> {
  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now) return cached.set;

  const age = await fetchUserAge(userId);
  // Age unknown → block everything. resolveFeaturesForAge already does this
  // when given an out-of-range integer; we pass -1 to trigger that path.
  const baseline = resolveFeaturesForAge(age == null ? -1 : age);
  const overrides = await fetchUserOverrides(userId);
  const features = layerOverrides(baseline, overrides);

  const set: EffectiveFeatureSet = {
    user_id: userId,
    age,
    features,
    resolved_at_iso: new Date().toISOString(),
  };
  cache.set(userId, { set, expiresAt: now + CACHE_TTL_MS });
  return set;
}
