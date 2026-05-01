/**
 * Server economy module tests — validation, pack rolling, shards, triggers.
 *
 * Pack roller tests use a seeded RNG so they're fully deterministic. The
 * validation tests cover all four constraints from card-system.md §5.
 */

import { validateRoster } from './validation.js';
import type { RosterCard } from './validation.js';
import { rollPack, makeSeededRng } from './packRoller.js';
import { bindCardToPlayer } from './playerBinding.js';
import { convertDuplicateToShards, SHARD_REDEMPTION_COST } from './shards.js';
import {
  evaluateTrigger,
  evaluateBigGame,
  evaluateStatStuffer,
} from './triggerEvaluator.js';
import type { PityState } from './types.js';

// ─── validation ──────────────────────────────────────────────────────────────

describe('validateRoster', () => {
  test('happy path: 4 commons (energy 4) on 4 different players is valid', () => {
    const cards = [
      { template_id: 'sb_common_p5', player_id: 'p1' },
      { template_id: 'sb_common_p5', player_id: 'p2' },
      { template_id: 'sb_common_p5', player_id: 'p3' },
      { template_id: 'sb_common_p5', player_id: 'p4' },
    ];
    const r = validateRoster(cards);
    expect(r.ok).toBe(true);
    expect(r.totals.energy_cost_total).toBe(4);
  });

  test('energy budget exceeded: 4 epics = 12 energy → fail', () => {
    // sb_epic_p20 has energy_cost=3; 4 of them = 12 > 8 budget.
    // But 4 epics also blows the rare-cap. Use uniqueness across players.
    const cards = [
      { template_id: 'sb_epic_p20', player_id: 'p1' },
      { template_id: 'sb_epic_p20', player_id: 'p2' },
      { template_id: 'sb_epic_p20', player_id: 'p3' },
      { template_id: 'sb_epic_p20', player_id: 'p4' },
    ];
    const r = validateRoster(cards);
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.code === 'ENERGY_BUDGET_EXCEEDED')).toBeDefined();
    expect(r.errors.find((e) => e.code === 'EPIC_CAP_EXCEEDED')).toBeDefined();
  });

  test('per-player cap: 3 cards on a single player → fail', () => {
    const cards = [
      { template_id: 'sb_common_p5', player_id: 'p1' },
      { template_id: 'sb_common_p5', player_id: 'p1' },
      { template_id: 'sb_common_p5', player_id: 'p1' },
    ];
    const r = validateRoster(cards);
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.code === 'PER_PLAYER_CAP_EXCEEDED')).toBeDefined();
  });

  test('legendary cross-roster cap with prior placement', () => {
    const cards = [{ template_id: 'ab_legendary_showtime', player_id: 'p1' }];
    const r = validateRoster(cards, { legendaryAlreadyPlacedThisWeek: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.code === 'WEEKLY_LEGENDARY_CAP_EXCEEDED')).toBeDefined();
  });

  test('unknown template is flagged but counted-towards-nothing', () => {
    const cards = [{ template_id: 'this_doesnt_exist', player_id: 'p1' }];
    const r = validateRoster(cards);
    expect(r.errors.find((e) => e.code === 'UNKNOWN_TEMPLATE')).toBeDefined();
    expect(r.totals.energy_cost_total).toBe(0);
  });
});

// ─── pack roller ─────────────────────────────────────────────────────────────

describe('rollPack', () => {
  const zeroPity: PityState = { packs_since_rare_plus: 0, cards_since_legendary: 0 };

  test('rookie pack rolls 3 cards, deterministic with same seed', () => {
    const r1 = rollPack('rookie_pack', zeroPity, { rng: makeSeededRng(42) });
    const r2 = rollPack('rookie_pack', zeroPity, { rng: makeSeededRng(42) });
    expect(r1.rarities.length).toBe(3);
    expect(r1.rarities).toEqual(r2.rarities);
  });

  test('all_star_pack honors guaranteed slot 5 = rare-or-better', () => {
    const r = rollPack('all_star_pack', zeroPity, { rng: makeSeededRng(7) });
    expect(r.rarities.length).toBe(6);
    const lastRarity = r.rarities[5]!;
    expect(['rare', 'epic', 'legendary']).toContain(lastRarity);
  });

  test('rare_plus pity fires when threshold hit and no rare+ in roll', () => {
    // Force a rookie_pack (low rare rates) at rare_plus_threshold-1 → next pack triggers.
    const onePastThreshold: PityState = { packs_since_rare_plus: 29, cards_since_legendary: 0 };
    const r = rollPack('rookie_pack', onePastThreshold, { rng: makeSeededRng(123) });
    // Either we naturally rolled a rare+, or pity triggered. Either way at least one rare+.
    const hasRarePlus = r.rarities.some((x) =>
      x === 'rare' || x === 'epic' || x === 'legendary',
    );
    expect(hasRarePlus).toBe(true);
    // Pity counter resets after a rare+ pull (whether organic or pity-induced).
    expect(r.next_pity_state.packs_since_rare_plus).toBe(0);
  });

  test('legendary pity fires after 150 cards without one', () => {
    const ledger: PityState = { packs_since_rare_plus: 0, cards_since_legendary: 150 };
    const r = rollPack('mvp_pack', ledger, { rng: makeSeededRng(99) });
    expect(r.rarities.includes('legendary')).toBe(true);
    expect(r.next_pity_state.cards_since_legendary).toBe(0);
  });

  test('next_pity_state increments when no rare+ pulled', () => {
    // Rig drop rates by using rookie_pack with a seed that misses rare+.
    // Use a high rng floor — rookie_pack rare rate is 3%, common is 75%.
    const rng = makeSeededRng(1);
    const r = rollPack('rookie_pack', zeroPity, { rng });
    if (!r.rarities.some((x) => x === 'rare' || x === 'epic' || x === 'legendary')) {
      expect(r.next_pity_state.packs_since_rare_plus).toBe(1);
    } else {
      // The seeded sample happened to hit a rare+. Counter should reset.
      expect(r.next_pity_state.packs_since_rare_plus).toBe(0);
    }
  });
});

// ─── player binding ──────────────────────────────────────────────────────────

describe('bindCardToPlayer', () => {
  test('respects sport-diversity guarantee', () => {
    const players = [
      { player_id: 'a', sport: 'basketball' },
      { player_id: 'b', sport: 'football' },
      { player_id: 'c', sport: 'baseball' },
    ];
    const ids = bindCardToPlayer(players, {
      cardCount: 3,
      sportDiversityMin: 3,
      rng: makeSeededRng(5),
    });
    expect(ids.length).toBe(3);
    const sportsCovered = new Set(
      ids.map((id) => players.find((p) => p.player_id === id)!.sport),
    );
    expect(sportsCovered.size).toBe(3);
  });
});

// ─── shards ──────────────────────────────────────────────────────────────────

describe('shards', () => {
  test('duplicate → 1 shard of matching rarity', () => {
    expect(convertDuplicateToShards({ rarity: 'rare' })).toEqual({
      rarity: 'rare',
      shards_granted: 1,
    });
  });

  test('redemption costs match spec (rare=4, epic=3)', () => {
    expect(SHARD_REDEMPTION_COST.rare).toBe(4);
    expect(SHARD_REDEMPTION_COST.epic).toBe(3);
    expect(SHARD_REDEMPTION_COST.legendary).toBe(3);
  });
});

// ─── triggers ────────────────────────────────────────────────────────────────

describe('triggerEvaluator', () => {
  test('big_game: this_game[primary] > season_avg[primary]', () => {
    expect(
      evaluateBigGame(
        { primary_stat: 'points' },
        { this_game_stats: { points: 30 }, season_avg: { points: 22 } },
      ),
    ).toBe(true);
  });

  test('stat_stuffer counts non-zero categories ≥ min', () => {
    const ok = evaluateStatStuffer(
      { categories: ['pts', 'reb', 'ast', 'stl', 'blk'], min_categories: 4 },
      { this_game_stats: { pts: 10, reb: 8, ast: 5, stl: 1, blk: 0 } },
    );
    expect(ok).toBe(true);

    const not = evaluateStatStuffer(
      { categories: ['pts', 'reb', 'ast', 'stl'], min_categories: 4 },
      { this_game_stats: { pts: 10, reb: 0, ast: 0, stl: 0 } },
    );
    expect(not).toBe(false);
  });

  test('dispatcher returns false for unknown trigger id', () => {
    expect(evaluateTrigger('nonexistent', {}, {})).toBe(false);
  });

  test('rivalry calls opponent_meta.is_rival(scope)', () => {
    const calls: string[] = [];
    const ok = evaluateTrigger(
      'rivalry',
      { scope: 'division' },
      { opponent_meta: { is_rival: (s) => { calls.push(s); return true; } } },
    );
    expect(ok).toBe(true);
    expect(calls).toEqual(['division']);
  });
});
