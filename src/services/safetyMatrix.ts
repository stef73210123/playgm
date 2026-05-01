/**
 * safetyMatrix.ts — runtime resolver for the per-age feature matrix.
 *
 * Reads `data/safety/age_feature_matrix.json` and exposes:
 *
 *   - loadSafetyMatrix(): full file (cached 60s)
 *   - resolveFeaturesForAge(age, features?): per-feature decision for one age
 *   - getSafetyMatrixSummary(): counts for the /admin/status surface
 *   - invalidateSafetyMatrixCache(): test hook — also bumps after PATCH writes
 *
 * The runtime decision per feature is one of:
 *   - "allow"     — feature is ON by default at this age
 *   - "moderated" — feature is available in a constrained form
 *   - "blocked"   — feature is unavailable at this age
 *   - "off"       — feature is OFF by default but parent override is allowed
 *
 * "off" vs "blocked" is the parent_override_allowed switch: a "blocked" feature
 * cannot be enabled by a parent (it's a statutory floor or hard product line).
 *
 * Pairs with `docs/gdd/age-recommendations.md` (rationale source-of-truth).
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 60_000;
const AGE_RANGE_MIN = 5;
const AGE_RANGE_MAX = 14;

function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, '..'),
    path.resolve(cwd, '..', '..'),
    path.resolve(cwd, '..', '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'safety', 'age_feature_matrix.json'))) return c;
  }
  return cwd;
}

const PROJECT_ROOT = findProjectRoot();
const MATRIX_PATH = path.join(PROJECT_ROOT, 'data', 'safety', 'age_feature_matrix.json');

// ─── Types ───────────────────────────────────────────────────────────────

export type FeatureCategory =
  | 'auth_identity'
  | 'ai_audio'
  | 'trivia_content'
  | 'social'
  | 'commerce'
  | 'contests'
  | 'privacy_data'
  | 'accessibility';

export interface SafetyFeature {
  feature_id: string;
  label: string;
  category: FeatureCategory;
  /** Default-ON window. 0/0 means "never default-on for any age in 5–14". */
  min_age_default_on: number;
  max_age_default_on: number;
  /** Ages where the feature is available in a moderated/constrained form. */
  ages_with_moderation: number[];
  /** Ages where the feature is unavailable, no parent override below COPPA floor. */
  ages_blocked: number[];
  /** Whether a parent can override outside the default-on window. */
  parent_override_allowed: boolean;
  /**
   * Age below which we require explicit parent consent. 0 = not COPPA-relevant,
   * 13 = standard COPPA, 16 = GDPR-K-conservative, 18 = parent-only at all ages.
   */
  requires_parent_consent_under: number;
  rationale: string;
  source: string;
}

export interface SafetyMatrixFile {
  version: string;
  last_updated_iso: string;
  age_range: { min: number; max: number };
  policy_principles: string[];
  frameworks: Record<string, string>;
  features: SafetyFeature[];
}

export type FeatureDecision = 'allow' | 'moderated' | 'blocked' | 'off';

export interface ResolvedFeature {
  feature_id: string;
  decision: FeatureDecision;
  parent_override_allowed: boolean;
  requires_parent_consent: boolean;
}

export interface SafetyMatrixSummary {
  feature_count: number;
  ages_covered: number;
  coppa_gated_features: number;
  apple_kids_blocked_features: number;
  last_updated_iso: string;
  version: string;
}

// ─── Validation helpers ──────────────────────────────────────────────────

const VALID_CATEGORIES: ReadonlySet<FeatureCategory> = new Set<FeatureCategory>([
  'auth_identity',
  'ai_audio',
  'trivia_content',
  'social',
  'commerce',
  'contests',
  'privacy_data',
  'accessibility',
]);

function isFeatureCategory(v: unknown): v is FeatureCategory {
  return typeof v === 'string' && VALID_CATEGORIES.has(v as FeatureCategory);
}

function isAgeArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => Number.isInteger(n));
}

/** Validate a single feature entry. Returns null on success, error string on failure. */
export function validateFeature(f: unknown): string | null {
  if (f == null || typeof f !== 'object') return 'feature must be an object';
  const o = f as Record<string, unknown>;
  if (typeof o['feature_id'] !== 'string' || o['feature_id'].length === 0) {
    return 'feature_id required';
  }
  if (typeof o['label'] !== 'string' || o['label'].length === 0) {
    return 'label required';
  }
  if (!isFeatureCategory(o['category'])) return 'category invalid';
  if (
    !Number.isInteger(o['min_age_default_on']) ||
    !Number.isInteger(o['max_age_default_on'])
  ) {
    return 'min_age_default_on/max_age_default_on must be integers';
  }
  const minA = o['min_age_default_on'] as number;
  const maxA = o['max_age_default_on'] as number;
  // 0/0 is a sentinel meaning "never default-on" (e.g. subscription_purchase).
  // Otherwise both must lie in [AGE_RANGE_MIN, AGE_RANGE_MAX] and min ≤ max.
  if (!(minA === 0 && maxA === 0)) {
    if (minA < AGE_RANGE_MIN || minA > AGE_RANGE_MAX) {
      return `min_age_default_on must be in [${AGE_RANGE_MIN}, ${AGE_RANGE_MAX}] or 0`;
    }
    if (maxA < AGE_RANGE_MIN || maxA > AGE_RANGE_MAX) {
      return `max_age_default_on must be in [${AGE_RANGE_MIN}, ${AGE_RANGE_MAX}] or 0`;
    }
    if (minA > maxA) return 'min_age_default_on must be ≤ max_age_default_on';
  }
  if (!isAgeArray(o['ages_with_moderation'])) return 'ages_with_moderation must be int[]';
  if (!isAgeArray(o['ages_blocked'])) return 'ages_blocked must be int[]';
  if (typeof o['parent_override_allowed'] !== 'boolean') {
    return 'parent_override_allowed must be boolean';
  }
  if (
    !Number.isInteger(o['requires_parent_consent_under']) ||
    (o['requires_parent_consent_under'] as number) < 0 ||
    (o['requires_parent_consent_under'] as number) > 18
  ) {
    return 'requires_parent_consent_under must be integer in [0, 18]';
  }
  if (typeof o['rationale'] !== 'string' || o['rationale'].trim().length === 0) {
    return 'rationale required (non-empty)';
  }
  if (typeof o['source'] !== 'string' || o['source'].length === 0) {
    return 'source required';
  }
  return null;
}

// ─── Loader (60s cache) ──────────────────────────────────────────────────

interface Cache {
  ts: number;
  mtimeMs: number;
  file: SafetyMatrixFile;
}

let cache: Cache | null = null;

export function loadSafetyMatrix(): SafetyMatrixFile {
  const now = Date.now();
  // Honor the file mtime so /admin/edit/safety PATCH writes invalidate
  // the cache without an explicit call.
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(MATRIX_PATH).mtimeMs;
  } catch {
    /* swallow — first read will throw below */
  }
  if (cache && now - cache.ts < CACHE_TTL_MS && cache.mtimeMs === mtimeMs) {
    return cache.file;
  }
  const raw = readFileSync(MATRIX_PATH, 'utf8');
  const file = JSON.parse(raw) as SafetyMatrixFile;
  cache = { ts: now, mtimeMs, file };
  return file;
}

export function invalidateSafetyMatrixCache(): void {
  cache = null;
}

/** Test hook — same as invalidateSafetyMatrixCache(); aliased for consistency. */
export function _resetSafetyMatrixCacheForTests(): void {
  cache = null;
}

// ─── Resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve the per-age decision for one feature.
 *
 * Decision precedence (highest first):
 *   1. age in ages_blocked → "blocked"
 *   2. age in ages_with_moderation → "moderated"
 *   3. min_age_default_on ≤ age ≤ max_age_default_on AND non-zero window → "allow"
 *   4. default-on window is 0/0 (never default-on) → "blocked" or "off" by override flag
 *   5. age outside default-on window → "off" if parent override allowed, else "blocked"
 *
 * Note: ages_blocked takes priority over ages_with_moderation. If a feature
 * lists the same age in both arrays (data error), block wins.
 */
function decideForAge(feature: SafetyFeature, age: number): FeatureDecision {
  if (feature.ages_blocked.includes(age)) return 'blocked';
  if (feature.ages_with_moderation.includes(age)) return 'moderated';
  const neverDefault =
    feature.min_age_default_on === 0 && feature.max_age_default_on === 0;
  if (
    !neverDefault &&
    age >= feature.min_age_default_on &&
    age <= feature.max_age_default_on
  ) {
    return 'allow';
  }
  return feature.parent_override_allowed ? 'off' : 'blocked';
}

/**
 * Resolve effective feature decisions for a given age.
 *
 * @param age age in 5..14. If outside the supported range, every feature is "blocked".
 * @param features optional subset of feature_ids to resolve. If omitted, all features.
 */
export function resolveFeaturesForAge(
  age: number,
  features?: string[],
): ResolvedFeature[] {
  const file = loadSafetyMatrix();
  if (!Number.isInteger(age) || age < AGE_RANGE_MIN || age > AGE_RANGE_MAX) {
    return file.features
      .filter((f) => !features || features.includes(f.feature_id))
      .map((f) => ({
        feature_id: f.feature_id,
        decision: 'blocked' as const,
        parent_override_allowed: f.parent_override_allowed,
        requires_parent_consent: f.requires_parent_consent_under > 0,
      }));
  }
  const filter = features ? new Set(features) : null;
  return file.features
    .filter((f) => filter === null || filter.has(f.feature_id))
    .map((f) => ({
      feature_id: f.feature_id,
      decision: decideForAge(f, age),
      parent_override_allowed: f.parent_override_allowed,
      requires_parent_consent: age < f.requires_parent_consent_under,
    }));
}

/**
 * Summary counts for the /admin/status `safety_matrix` key.
 *
 * - feature_count        — total number of features
 * - ages_covered         — number of distinct ages in [5..14] that the matrix
 *                          touches at all (allow/moderate/block/off). For a
 *                          well-formed v1 matrix this should always be 10.
 * - coppa_gated_features — features where requires_parent_consent_under ≥ 13
 *                          (i.e. parent consent required for under-13 user).
 * - apple_kids_blocked_features — features that resolve to "blocked" for any
 *                          age in 5..12. Proxy for "the feature is unavailable
 *                          to under-13s in our Apple Kids posture".
 */
export function getSafetyMatrixSummary(): SafetyMatrixSummary {
  const file = loadSafetyMatrix();
  const features = file.features;
  const agesTouched = new Set<number>();
  let coppaGated = 0;
  let appleKidsBlocked = 0;
  for (const f of features) {
    if (f.requires_parent_consent_under >= 13) coppaGated += 1;
    let blockedUnder13 = false;
    for (let age = AGE_RANGE_MIN; age <= AGE_RANGE_MAX; age += 1) {
      const d = decideForAge(f, age);
      if (d === 'allow' || d === 'moderated' || d === 'off' || d === 'blocked') {
        agesTouched.add(age);
      }
      if (age <= 12 && d === 'blocked') blockedUnder13 = true;
    }
    if (blockedUnder13) appleKidsBlocked += 1;
  }
  return {
    feature_count: features.length,
    ages_covered: agesTouched.size,
    coppa_gated_features: coppaGated,
    apple_kids_blocked_features: appleKidsBlocked,
    last_updated_iso: file.last_updated_iso,
    version: file.version,
  };
}

/** Find a feature by id. Returns null if not present. */
export function findFeature(featureId: string): SafetyFeature | null {
  const file = loadSafetyMatrix();
  return file.features.find((f) => f.feature_id === featureId) ?? null;
}

export const SAFETY_MATRIX_PATH_REL = 'data/safety/age_feature_matrix.json';
export const SAFETY_MATRIX_AGE_RANGE = { min: AGE_RANGE_MIN, max: AGE_RANGE_MAX };
