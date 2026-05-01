/**
 * safetyMatrix.test.ts — unit tests for the per-age feature resolver.
 *
 * Reads the real on-disk JSON at data/safety/age_feature_matrix.json so the
 * test suite catches schema drift between this file and the runtime resolver.
 */
import {
  loadSafetyMatrix,
  resolveFeaturesForAge,
  getSafetyMatrixSummary,
  validateFeature,
  findFeature,
  _resetSafetyMatrixCacheForTests,
  type SafetyFeature,
} from './safetyMatrix.js';

describe('safetyMatrix', () => {
  beforeEach(() => {
    _resetSafetyMatrixCacheForTests();
  });

  it('loads the on-disk matrix file', () => {
    const file = loadSafetyMatrix();
    expect(file.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(file.age_range).toEqual({ min: 5, max: 14 });
    expect(file.features.length).toBeGreaterThan(0);
    expect(file.policy_principles.length).toBeGreaterThanOrEqual(4);
    expect(file.frameworks).toMatchObject({
      coppa: expect.any(String),
      apple_kids: expect.any(String),
      gdpr_k: expect.any(String),
    });
  });

  it('every feature has the required fields and validates', () => {
    const file = loadSafetyMatrix();
    for (const f of file.features) {
      const err = validateFeature(f);
      if (err) {
        throw new Error(`feature ${f.feature_id} failed validation: ${err}`);
      }
    }
  });

  it('resolveFeaturesForAge(7) blocks under-13 ad personalization, blocks open Scout LLM', () => {
    const decisions = resolveFeaturesForAge(7);
    const adPersonalization = decisions.find((d) => d.feature_id === 'ad_personalization');
    // Statutory floor: ages_blocked covers 5..12 → blocked at age 7.
    // parent_override_allowed=true governs only what happens at 13+.
    expect(adPersonalization?.decision).toBe('blocked');

    const askScoutOpen = decisions.find((d) => d.feature_id === 'ask_scout_llm_open');
    expect(askScoutOpen?.decision).toBe('blocked');

    // Easy trivia is the default-on for age 7
    const easy = decisions.find((d) => d.feature_id === 'trivia_difficulty_easy');
    expect(easy?.decision).toBe('allow');

    // Alliance chat is blocked + no override
    const chat = decisions.find((d) => d.feature_id === 'alliance_text_chat');
    expect(chat?.decision).toBe('blocked');
    expect(chat?.parent_override_allowed).toBe(false);
  });

  it('resolveFeaturesForAge(13) flips COPPA-bound features off and unlocks 13+ surfaces', () => {
    const decisions = resolveFeaturesForAge(13);
    // Ad personalization graduates to "off" with parent override at 13:
    // ages_blocked covers 5..12, default-on window is 0/0, parent_override_allowed
    // is true → at 13 the decision falls through to "off".
    const adPersonalization = decisions.find((d) => d.feature_id === 'ad_personalization');
    expect(adPersonalization?.decision).toBe('off');
    expect(adPersonalization?.parent_override_allowed).toBe(true);

    // Same model for third-party analytics
    const tpa = decisions.find((d) => d.feature_id === 'third_party_analytics');
    expect(tpa?.decision).toBe('off');

    // Alliance chat unlocks (moderated) at 13
    const chat = decisions.find((d) => d.feature_id === 'alliance_text_chat');
    expect(['moderated', 'allow']).toContain(chat?.decision);

    // Championship contest unlocks at 13
    const champ = decisions.find((d) => d.feature_id === 'championship_contest');
    expect(champ?.decision).toBe('allow');

    // requires_parent_consent flips to false for COPPA-graduated user
    const askScoutOpen = decisions.find((d) => d.feature_id === 'ask_scout_llm_open');
    expect(askScoutOpen?.decision).toBe('allow');
    expect(askScoutOpen?.requires_parent_consent).toBe(false);
  });

  it('resolveFeaturesForAge(11) keeps under-13 floors blocked even with parent override', () => {
    const decisions = resolveFeaturesForAge(11);
    // Ad personalization has parent_override_allowed=true but ages_blocked includes 11,
    // so it stays "blocked" (statutory floor wins over override).
    const adPersonalization = decisions.find((d) => d.feature_id === 'ad_personalization');
    expect(adPersonalization?.decision).toBe('blocked');
  });

  it('resolveFeaturesForAge(9) maps to moderated Scout LLM', () => {
    const decisions = resolveFeaturesForAge(9);
    const moderated = decisions.find((d) => d.feature_id === 'ask_scout_llm_moderated');
    expect(moderated?.decision).toBe('allow');
    const open = decisions.find((d) => d.feature_id === 'ask_scout_llm_open');
    expect(open?.decision).toBe('moderated');
  });

  it('out-of-range age (4 or 15) returns blocked for everything', () => {
    const tooYoung = resolveFeaturesForAge(4);
    expect(tooYoung.every((d) => d.decision === 'blocked')).toBe(true);
    const tooOld = resolveFeaturesForAge(15);
    expect(tooOld.every((d) => d.decision === 'blocked')).toBe(true);
  });

  it('feature subset filter only returns requested features', () => {
    const subset = resolveFeaturesForAge(11, ['ad_personalization', 'alliance_text_chat']);
    expect(subset.length).toBe(2);
    expect(subset.map((d) => d.feature_id).sort()).toEqual(
      ['ad_personalization', 'alliance_text_chat'].sort(),
    );
  });

  it('subscription_purchase is kid-blocked at every age (0/0 sentinel + no override)', () => {
    const file = loadSafetyMatrix();
    const sub = file.features.find((f) => f.feature_id === 'subscription_purchase');
    expect(sub).toBeDefined();
    expect(sub!.min_age_default_on).toBe(0);
    expect(sub!.max_age_default_on).toBe(0);
    // 0/0 + parent_override_allowed=false means the kid never gets this surface
    // — the parent buys via the parent dashboard, not via a kid override path.
    for (let age = 5; age <= 14; age += 1) {
      const decisions = resolveFeaturesForAge(age, ['subscription_purchase']);
      expect(decisions[0]!.decision).toBe('blocked');
    }
  });

  it('summary has plausible counts and ages_covered = 10', () => {
    const sum = getSafetyMatrixSummary();
    expect(sum.feature_count).toBeGreaterThanOrEqual(20);
    expect(sum.ages_covered).toBe(10);
    expect(sum.coppa_gated_features).toBeGreaterThan(0);
    expect(sum.apple_kids_blocked_features).toBeGreaterThan(0);
    expect(sum.last_updated_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('findFeature returns the matching feature or null', () => {
    expect(findFeature('ad_personalization')).not.toBeNull();
    expect(findFeature('does_not_exist_xyz')).toBeNull();
  });

  // ─── validateFeature ────────────────────────────────────────────────────
  describe('validateFeature', () => {
    function base(): SafetyFeature {
      return {
        feature_id: 'x',
        label: 'X',
        category: 'auth_identity',
        min_age_default_on: 5,
        max_age_default_on: 14,
        ages_with_moderation: [],
        ages_blocked: [],
        parent_override_allowed: false,
        requires_parent_consent_under: 0,
        rationale: 'because',
        source: 'product judgment',
      };
    }
    it('accepts a clean feature', () => {
      expect(validateFeature(base())).toBeNull();
    });
    it('rejects min > max', () => {
      const f = { ...base(), min_age_default_on: 14, max_age_default_on: 10 };
      expect(validateFeature(f)).toMatch(/min.*≤.*max/i);
    });
    it('accepts the 0/0 sentinel for parent-only features', () => {
      const f = { ...base(), min_age_default_on: 0, max_age_default_on: 0 };
      expect(validateFeature(f)).toBeNull();
    });
    it('rejects out-of-range ages', () => {
      const f = { ...base(), min_age_default_on: 4, max_age_default_on: 14 };
      expect(validateFeature(f)).toMatch(/min_age_default_on/);
    });
    it('rejects empty rationale', () => {
      const f = { ...base(), rationale: '   ' };
      expect(validateFeature(f)).toMatch(/rationale/);
    });
    it('rejects bad category', () => {
      const f = { ...base(), category: 'nonsense' as unknown as SafetyFeature['category'] };
      expect(validateFeature(f)).toMatch(/category/);
    });
    it('rejects requires_parent_consent_under out of [0, 18]', () => {
      const f = { ...base(), requires_parent_consent_under: 25 };
      expect(validateFeature(f)).toMatch(/requires_parent_consent_under/);
    });
  });
});
