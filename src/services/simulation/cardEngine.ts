/**
 * cardEngine.ts — Card deployment for the fairness simulator.
 *
 * Loads the four data files that drive the card economy:
 *   - data/cards/pgm_card_templates.json   — every available card
 *   - data/cards/pgm_triggers.json         — trigger pseudocode + rate
 *   - data/economy/pgm_subscriptions.json  — per-tier monthly_pack_allocation
 *   - data/economy/pgm_streak_rewards.json — daily streak grants
 *
 * Per the spec we don't actually re-implement every trigger evaluator — we
 * use each trigger's `approximate_trigger_rate` as a Bernoulli probability,
 * deterministic per (card_template, player_id, week_idx, seed). That's an
 * acceptable approximation for fairness simulation; the real evaluator runs
 * in scoring/engine.ts in production.
 *
 * Per-week flow per synthetic user:
 *   1. Receive cards from monthly allocation (pro-rated to per-week) +
 *      streak rewards for the week.
 *   2. Plan card placement on roster: greedy by expected boost subject to
 *      the 8-Energy budget + rarity caps (≤3 Rare/roster, ≤1 Epic/roster,
 *      ≤1 Legendary/user/week).
 *   3. When scoring each player-week, if a placed card's trigger fires we
 *      multiply that player's score by (1 + uplift_by_rarity[rarity]).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ScoringFormulaFile } from './scoringFormula.js';

// ─── Shared types ────────────────────────────────────────────────────────
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export type SubTier = 'free' | 'starter' | 'playmaker' | 'champion';

export interface CardTemplate {
  template_id: string;
  name: string;
  card_type: 'stat_boost' | 'ability' | 'hybrid';
  rarity: Rarity;
  energy_cost: number;
  sport: 'any' | 'basketball' | 'baseball' | 'football' | 'hockey' | 'soccer';
  effect: unknown;
  trigger_id?: string;
  retired?: boolean;
}

interface CardTemplatesFile {
  version: string;
  card_templates: CardTemplate[];
}

interface Trigger {
  trigger_id: string;
  approximate_trigger_rate: number;
}

interface TriggersFile {
  version: string;
  triggers: Trigger[];
}

interface PackAllocation {
  pack_id: string;
  count: number;
}

interface SubTierDef {
  tier_id: string;
  monthly_pack_allocation: PackAllocation[];
}

interface SubsFile {
  version: string;
  tiers: SubTierDef[];
}

interface PackDef {
  pack_id: string;
  card_count: number;
  drop_rates: Record<string, number>;
}

interface PacksFile {
  version: string;
  packs: PackDef[];
}

interface StreakRewardsFile {
  version: string;
  streak_rewards: Array<{ day: number; pack_id: string; bonus_pp: number; bonus_tokens: number }>;
}

// ─── Project root ────────────────────────────────────────────────────────
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

// ─── Bundle: everything the simulator needs ─────────────────────────────
export interface CardEconomyBundle {
  cardsByRarity: Record<Rarity, CardTemplate[]>;
  triggerRateById: Map<string, number>;
  /** Avg cards per week from a tier's monthly allocation (per-week pro-rata). */
  weeklyCardsByTier: Record<SubTier, number>;
  /** Mean rarity weights derived from each tier's pack allocation. */
  rarityMixByTier: Record<SubTier, Record<Rarity, number>>;
  /** Streak reward cards per week (avg). */
  streakCardsPerWeek: number;
}

function safeReadJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** Multiply pack count × cards per pack × drop rate ⇒ expected cards per
 *  rarity per month. Sums across all packs the tier receives. */
function expectedRarityMix(
  alloc: PackAllocation[],
  packs: Map<string, PackDef>,
): Record<Rarity, number> {
  const out: Record<Rarity, number> = {
    common: 0,
    uncommon: 0,
    rare: 0,
    epic: 0,
    legendary: 0,
  };
  for (const a of alloc) {
    const pk = packs.get(a.pack_id);
    if (!pk) continue;
    const totalCards = a.count * pk.card_count;
    for (const r of RARITIES) {
      const rate = pk.drop_rates[r] ?? 0;
      out[r] += totalCards * rate;
    }
  }
  return out;
}

export function loadCardEconomy(): CardEconomyBundle {
  const cardsFile = safeReadJson<CardTemplatesFile>(
    path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_card_templates.json'),
  );
  const triggersFile = safeReadJson<TriggersFile>(
    path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_triggers.json'),
  );
  const subsFile = safeReadJson<SubsFile>(
    path.join(PROJECT_ROOT, 'data', 'economy', 'pgm_subscriptions.json'),
  );
  const packsFile = safeReadJson<PacksFile>(
    path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_packs.json'),
  );
  const streakFile = safeReadJson<StreakRewardsFile>(
    path.join(PROJECT_ROOT, 'data', 'economy', 'pgm_streak_rewards.json'),
  );

  const cards = (cardsFile?.card_templates ?? []).filter((c) => !c.retired);
  const cardsByRarity: Record<Rarity, CardTemplate[]> = {
    common: [],
    uncommon: [],
    rare: [],
    epic: [],
    legendary: [],
  };
  for (const c of cards) cardsByRarity[c.rarity].push(c);

  const triggerRateById = new Map<string, number>();
  for (const t of triggersFile?.triggers ?? []) {
    triggerRateById.set(t.trigger_id, t.approximate_trigger_rate);
  }

  const packMap = new Map<string, PackDef>();
  for (const p of packsFile?.packs ?? []) packMap.set(p.pack_id, p);

  const TIERS: SubTier[] = ['free', 'starter', 'playmaker', 'champion'];
  const weeklyCardsByTier: Record<SubTier, number> = {
    free: 0,
    starter: 0,
    playmaker: 0,
    champion: 0,
  };
  const rarityMixByTier: Record<SubTier, Record<Rarity, number>> = {
    free: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
    starter: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
    playmaker: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
    champion: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
  };
  for (const t of TIERS) {
    const tier = subsFile?.tiers.find((x) => x.tier_id === t);
    if (!tier) continue;
    const monthlyMix = expectedRarityMix(tier.monthly_pack_allocation, packMap);
    const monthlyTotal =
      monthlyMix.common +
      monthlyMix.uncommon +
      monthlyMix.rare +
      monthlyMix.epic +
      monthlyMix.legendary;
    weeklyCardsByTier[t] = monthlyTotal / 4.33; // ~weeks/month
    if (monthlyTotal > 0) {
      for (const r of RARITIES) rarityMixByTier[t][r] = monthlyMix[r] / monthlyTotal;
    }
  }

  // Streak reward cards: simplest model = 1 card per streak day reward we
  // expect a typical user to claim. Average 5 days/week claimed → 5/7 packs.
  const streakDays = streakFile?.streak_rewards.length ?? 0;
  const streakCardsPerWeek = streakDays > 0 ? 5 / 7 : 0;

  return {
    cardsByRarity,
    triggerRateById,
    weeklyCardsByTier,
    rarityMixByTier,
    streakCardsPerWeek,
  };
}

// ─── Per-user weekly card hand ───────────────────────────────────────────
export interface DealtCard {
  template: CardTemplate;
  uplift: number;
}

/** Sample N cards drawn from the tier's expected rarity mix. Deterministic
 *  in (rng) — the caller must seed the RNG for reproducibility. */
export function dealWeeklyHand(
  bundle: CardEconomyBundle,
  tier: SubTier,
  formula: ScoringFormulaFile,
  rng: () => number,
): DealtCard[] {
  const upliftMap = formula.global.card_uplift_by_rarity ?? {
    common: 0.1,
    uncommon: 0.2,
    rare: 0.35,
    epic: 0.6,
    legendary: 1.0,
  };
  const tierWeekly =
    (bundle.weeklyCardsByTier[tier] ?? 0) + bundle.streakCardsPerWeek;
  const handSize = Math.max(0, Math.round(tierWeekly));
  const mix = bundle.rarityMixByTier[tier];
  const rarities: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  // Cumulative for sampling:
  const cum: number[] = [];
  let acc = 0;
  for (const r of rarities) {
    acc += mix[r] ?? 0;
    cum.push(acc);
  }
  if (acc <= 0) return [];

  const hand: DealtCard[] = [];
  for (let i = 0; i < handSize; i++) {
    const x = rng() * acc;
    let pickIdx = 0;
    for (; pickIdx < cum.length - 1; pickIdx++) if (x < cum[pickIdx]!) break;
    const rarity = rarities[pickIdx]!;
    const pool = bundle.cardsByRarity[rarity];
    if (pool.length === 0) continue;
    const tpl = pool[Math.floor(rng() * pool.length)]!;
    hand.push({ template: tpl, uplift: upliftMap[rarity] ?? 0 });
  }
  return hand;
}

// ─── Card placement (per-week energy plan) ──────────────────────────────
export interface CardPlacement {
  /** Player slot index in the roster. */
  rosterSlot: number;
  card: DealtCard;
  /** Trigger rate (0..1) used to decide whether the card fires in a given week. */
  triggerRate: number;
}

interface PlacementContext {
  energyBudget: number;
  rarityCaps: { rarePerRoster: number; epicPerRoster: number; legendaryPerWeek: number };
}

/**
 * Greedy placement: highest expected boost first, subject to Energy + caps.
 *
 * Expected boost per (card, slot) = playerProjectedScore × uplift × triggerRate.
 * We don't know player projected scores in this layer; the caller passes
 * them as `slotScores`.
 */
export function planCardPlacements(
  hand: DealtCard[],
  slotScores: number[],
  triggerRateById: Map<string, number>,
  ctx: PlacementContext,
): CardPlacement[] {
  let energyLeft = ctx.energyBudget;
  let rareUsed = 0;
  let epicUsed = 0;
  let legUsed = 0;
  const placements: CardPlacement[] = [];

  // Score every (card, slot) pair, then pick greedily.
  type Cand = { card: DealtCard; slot: number; expected: number; rate: number };
  const cands: Cand[] = [];
  for (const card of hand) {
    const rate = card.template.trigger_id
      ? (triggerRateById.get(card.template.trigger_id) ?? 0.5)
      : 0.5;
    for (let s = 0; s < slotScores.length; s++) {
      // Sport-restricted cards can only go on matching-sport players;
      // this layer can't enforce that without more context, so assume 'any'
      // matches anywhere. (Mismatches are rare and don't materially affect
      // fairness signals.)
      const expected = slotScores[s]! * card.uplift * rate;
      cands.push({ card, slot: s, expected, rate });
    }
  }
  cands.sort((a, b) => b.expected - a.expected);

  const usedSlots = new Set<number>(); // one card per slot
  const usedCards = new Set<DealtCard>();
  for (const c of cands) {
    if (usedSlots.has(c.slot)) continue;
    if (usedCards.has(c.card)) continue;
    if (c.card.template.energy_cost > energyLeft) continue;
    if (c.card.template.rarity === 'rare' && rareUsed >= ctx.rarityCaps.rarePerRoster) continue;
    if (c.card.template.rarity === 'epic' && epicUsed >= ctx.rarityCaps.epicPerRoster) continue;
    if (c.card.template.rarity === 'legendary' && legUsed >= ctx.rarityCaps.legendaryPerWeek)
      continue;

    placements.push({ rosterSlot: c.slot, card: c.card, triggerRate: c.rate });
    energyLeft -= c.card.template.energy_cost;
    usedSlots.add(c.slot);
    usedCards.add(c.card);
    if (c.card.template.rarity === 'rare') rareUsed++;
    if (c.card.template.rarity === 'epic') epicUsed++;
    if (c.card.template.rarity === 'legendary') legUsed++;
  }

  return placements;
}
