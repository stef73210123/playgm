/**
 * adminEditConfig.ts — editable config pages for the 8 economy/cards spec files.
 *
 * Surfaces (mirrors adminEdit.ts pattern — HTML editor + JSON API per resource):
 *   1. Packs              (data/cards/pgm_packs.json)              — keyed list
 *   2. Earn rates         (data/economy/pgm_pp_earn_rates.json)    — single doc
 *   3. Subscriptions      (data/economy/pgm_subscriptions.json)    — keyed list
 *   4. Streaks            (data/economy/pgm_streak_rewards.json)   — single doc
 *   5. Triggers           (data/cards/pgm_triggers.json)           — keyed list
 *   6. Stat resolution    (data/cards/pgm_stat_resolution.json)    — keyed by sport
 *   7. Pity               (data/cards/pgm_pity_timers.json)        — keyed list
 *   8. Progression        (data/economy/pgm_progression.json)      — single doc
 *
 * Each PATCH writes the file (2-space indent + trailing newline) and calls
 * autoCommit(relPath, subject) — same auto-commit-no-push behavior used by
 * adminEdit.ts. Tests bypass autoCommit by setting ADMIN_EDIT_AUTOCOMMIT=0.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  SHARED_STYLE,
  SHARED_CRUMBS,
  autoCommit,
  badRequest,
  notFound,
  type ValidationError,
} from './adminEdit.js';
import { invalidateTradeRulesCache } from '../services/trade/tradeFairness.js';
import { invalidateSportsConfigCache } from '../services/sportsConfig.js';
import { invalidateConfigCache } from './runtimeConfig.js';

// ─── File paths ──────────────────────────────────────────────────────────
const PACKS_PATH = path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_packs.json');
const EARN_RATES_PATH = path.join(PROJECT_ROOT, 'data', 'economy', 'pgm_pp_earn_rates.json');
const SUBSCRIPTIONS_PATH = path.join(PROJECT_ROOT, 'data', 'economy', 'pgm_subscriptions.json');
const STREAK_REWARDS_PATH = path.join(PROJECT_ROOT, 'data', 'economy', 'pgm_streak_rewards.json');
const TRIGGERS_PATH = path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_triggers.json');
const STAT_RESOLUTION_PATH = path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_stat_resolution.json');
const PITY_PATH = path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_pity_timers.json');
const PROGRESSION_PATH = path.join(PROJECT_ROOT, 'data', 'economy', 'pgm_progression.json');
const TRADE_RULES_PATH = path.join(PROJECT_ROOT, 'data', 'economy', 'pgm_trade_rules.json');
const SPORTS_CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'system', 'sports_config.json');

// ─── Constants ───────────────────────────────────────────────────────────
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
const SUB_TIERS = ['free', 'starter', 'playmaker', 'champion'] as const;
const DRAFT_MODES = ['snake', 'cap'] as const;
const DRAFT_POSITION_CONTROLS = ['none', 'random', 'preferred_slot', 'exact_slot'] as const;
const SPORTS = ['basketball', 'baseball', 'football', 'hockey', 'soccer'] as const;
const STACK_RULES = ['highest_only_no_stack', 'stack'] as const;
const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const DROP_RATE_EPSILON = 0.001;

type Sport = (typeof SPORTS)[number];

// ─── Tiny helpers ────────────────────────────────────────────────────────
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isStr(v: unknown, max = 1000): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

async function readJson<T>(p: string): Promise<T> {
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}
async function writeJson(p: string, data: unknown): Promise<void> {
  const out = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(p, out, 'utf8');
}

function relFromRoot(absPath: string): string {
  return path.relative(PROJECT_ROOT, absPath);
}

// ─── Spec file types ─────────────────────────────────────────────────────
interface PackDef {
  pack_id: string;
  name: string;
  pp_cost: number | null;
  card_count: number;
  drop_rates: Record<string, number>;
  guaranteed_slots: Array<{ slot_index: number; minimum_rarity: string }>;
  sport_diversity_min: number;
  bonus_token_chance: number;
  obtainable_via?: string;
}
interface PacksFile {
  version: string;
  packs: PackDef[];
}
interface EarnRatesFile {
  version: string;
  roster_performance: Record<string, number | string>;
  daily_engagement: Record<string, number>;
  subscription_daily_boost: Record<string, number>;
}
interface SubTier {
  tier_id: string;
  name: string;
  monthly_price_usd: number;
  rosters_per_week: number;
  practice_drafts_per_week: number;
  cap_mode: boolean;
  draft_modes: Array<'snake' | 'cap'>;
  fa_pool_size_per_week: number;
  draft_position_control: 'none' | 'random' | 'preferred_slot' | 'exact_slot';
  family_max_profiles: number;
  monthly_pack_allocation: Array<{ pack_id: string; count: number }>;
  card_inventory_cap: number;
  daily_pp_boost: number;
  ask_scout_daily_cap: number;
  card_scan_daily_cap: number;
  /** Per-season trade cap. -1 == unlimited. */
  trade_cap_per_season?: number;
  /** Free-form admin notes. */
  notes?: string;
}
interface SubscriptionsFile {
  version: string;
  tiers: SubTier[];
}
interface StreakReward {
  day: number;
  pack_id: string;
  bonus_pp: number;
  bonus_tokens: number;
}
interface StreakRewardsFile {
  version: string;
  streak_rewards: StreakReward[];
  post_30_recurrence: { interval_days: number; pack_id: string };
  subscription_streak_boost: Record<string, string>;
  streak_save: { cost_usd: number; cost_gems: number; monthly_limit: number };
}
interface Trigger {
  trigger_id: string;
  name: string;
  description: string;
  data_required: string[];
  params_schema: Record<string, unknown>;
  evaluator_pseudocode: string;
  approximate_trigger_rate: number;
}
interface TriggersFile {
  version: string;
  triggers: Trigger[];
}
interface StatResolutionEntry {
  default_primary: string;
  default_secondary: string;
  default_tertiary: string;
  default_stats: string[];
  star_threshold: { stat: string; value: number };
  by_position: Record<string, { primary: string; secondary: string; tertiary: string }>;
}
interface StatResolutionFile {
  version: string;
  stat_resolution: Record<string, StatResolutionEntry>;
}
interface PityTimer {
  id: string;
  description: string;
  trigger_threshold: number;
  tracking_unit: string;
  guarantee: string;
  reset_on: string;
}
interface PityFile {
  version: string;
  pity_timers: PityTimer[];
}
interface ProgressionTier {
  level: number;
  name: string;
  pp_threshold: number;
  color: string;
}
interface ProgressionFile {
  version: string;
  tiers: ProgressionTier[];
  tier_up_bonus_pp: number;
  contest_gating: Record<string, number>;
}
interface SportsConfigEntry {
  enabled: boolean;
  label: string;
  league: string;
  disabled_reason?: string;
}
interface SportsConfigFile {
  version: string;
  last_updated_iso?: string;
  sports: Record<string, SportsConfigEntry>;
}

interface TradeRulesFile {
  version: string;
  fairness: {
    max_imbalance_pct: number;
    grade_score: Record<string, number>;
    pp_per_grade_point: number;
    max_pp_per_side: number;
    min_players_per_side: number;
    max_players_per_side: number;
  };
  execution: { lock_duration_hours: number };
  caps: {
    by_tier: Record<string, { trades_per_season: number } & Record<string, unknown>>;
  };
  age_safety: { under_13_friend_list_only: boolean };
  expiry: { proposal_ttl_hours: number };
  cooldown_hours_between_trade_proposals_with_same_user?: number;
  // Allow loose `_doc` fields and similar comments to flow through.
  [extra: string]: unknown;
}

// ─── Validators ──────────────────────────────────────────────────────────

function validatePack(body: Record<string, unknown>, validPackIds?: Set<string>): ValidationError[] {
  const errs: ValidationError[] = [];
  void validPackIds;
  if (body['pack_id'] !== undefined) {
    const v = body['pack_id'];
    if (typeof v !== 'string' || !SLUG_RE.test(v) || v.length > 40) {
      errs.push({ field: 'pack_id', message: 'must match ^[a-z][a-z0-9_]*$ and be ≤40 chars' });
    }
  }
  if (body['name'] !== undefined && !isStr(body['name'], 80)) {
    errs.push({ field: 'name', message: 'must be non-empty string ≤80 chars' });
  }
  if (body['pp_cost'] !== undefined) {
    const v = body['pp_cost'];
    if (v !== null && (!isInt(v) || (v as number) < 0)) {
      errs.push({ field: 'pp_cost', message: 'must be integer ≥0 or null' });
    }
  }
  if (body['card_count'] !== undefined) {
    const v = body['card_count'];
    if (!isInt(v) || (v as number) < 1) {
      errs.push({ field: 'card_count', message: 'must be integer ≥1' });
    }
  }
  if (body['sport_diversity_min'] !== undefined) {
    const v = body['sport_diversity_min'];
    if (!isInt(v) || (v as number) < 1 || (v as number) > 5) {
      errs.push({ field: 'sport_diversity_min', message: 'must be integer 1..5' });
    }
  }
  if (body['bonus_token_chance'] !== undefined) {
    const v = body['bonus_token_chance'];
    if (!isNum(v) || (v as number) < 0 || (v as number) > 1) {
      errs.push({ field: 'bonus_token_chance', message: 'must be number 0..1' });
    }
  }
  if (body['drop_rates'] !== undefined) {
    const dr = body['drop_rates'];
    if (!dr || typeof dr !== 'object' || Array.isArray(dr)) {
      errs.push({ field: 'drop_rates', message: 'must be object' });
    } else {
      let sum = 0;
      for (const r of RARITIES) {
        const v = (dr as Record<string, unknown>)[r];
        if (v === undefined) continue;
        if (!isNum(v) || (v as number) < 0 || (v as number) > 1) {
          errs.push({ field: `drop_rates.${r}`, message: 'must be number 0..1' });
        } else {
          sum += v as number;
        }
      }
      if (sum > 1 + DROP_RATE_EPSILON) {
        errs.push({ field: 'drop_rates', message: `sum must be ≤ 1.0 (got ${sum.toFixed(4)})` });
      }
    }
  }
  if (body['guaranteed_slots'] !== undefined) {
    const gs = body['guaranteed_slots'];
    const cardCount = isInt(body['card_count']) ? (body['card_count'] as number) : null;
    if (!Array.isArray(gs)) {
      errs.push({ field: 'guaranteed_slots', message: 'must be array' });
    } else {
      gs.forEach((slot, i) => {
        if (!slot || typeof slot !== 'object') {
          errs.push({ field: `guaranteed_slots[${i}]`, message: 'must be object' });
          return;
        }
        const s = slot as Record<string, unknown>;
        if (!isInt(s['slot_index']) || (s['slot_index'] as number) < 0) {
          errs.push({ field: `guaranteed_slots[${i}].slot_index`, message: 'must be integer ≥0' });
        } else if (cardCount != null && (s['slot_index'] as number) >= cardCount) {
          errs.push({
            field: `guaranteed_slots[${i}].slot_index`,
            message: `must be < card_count (${cardCount})`,
          });
        }
        if (
          typeof s['minimum_rarity'] !== 'string' ||
          !(RARITIES as readonly string[]).includes(s['minimum_rarity'] as string)
        ) {
          errs.push({
            field: `guaranteed_slots[${i}].minimum_rarity`,
            message: `must be one of ${RARITIES.join('|')}`,
          });
        }
      });
    }
  }
  return errs;
}

function validateEarnRates(body: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  function checkNonNegIntMap(obj: unknown, prefix: string): void {
    if (obj === undefined) return;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      errs.push({ field: prefix, message: 'must be object' });
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'performance_bonus_stack_rule') {
        if (!(STACK_RULES as readonly string[]).includes(v as string)) {
          errs.push({
            field: `${prefix}.${k}`,
            message: `must be one of ${STACK_RULES.join('|')}`,
          });
        }
        continue;
      }
      if (!isInt(v) || (v as number) < 0) {
        errs.push({ field: `${prefix}.${k}`, message: 'must be non-negative integer' });
      }
    }
  }
  checkNonNegIntMap(body['roster_performance'], 'roster_performance');
  checkNonNegIntMap(body['daily_engagement'], 'daily_engagement');
  checkNonNegIntMap(body['subscription_daily_boost'], 'subscription_daily_boost');
  return errs;
}

function validateSubscriptionTier(
  body: Record<string, unknown>,
  validPackIds: Set<string>,
): ValidationError[] {
  const errs: ValidationError[] = [];
  if (body['tier_id'] !== undefined) {
    if (!(SUB_TIERS as readonly string[]).includes(body['tier_id'] as string)) {
      errs.push({ field: 'tier_id', message: `must be one of ${SUB_TIERS.join('|')}` });
    }
  }
  if (body['name'] !== undefined && !isStr(body['name'], 80)) {
    errs.push({ field: 'name', message: 'must be non-empty string ≤80 chars' });
  }
  if (body['monthly_price_usd'] !== undefined) {
    const v = body['monthly_price_usd'];
    if (!isNum(v) || (v as number) < 0) {
      errs.push({ field: 'monthly_price_usd', message: 'must be number ≥0' });
    }
  }
  if (body['rosters_per_week'] !== undefined) {
    const v = body['rosters_per_week'];
    if (!isInt(v) || (v as number) < 0) {
      errs.push({ field: 'rosters_per_week', message: 'must be integer ≥0' });
    }
  }
  if (body['practice_drafts_per_week'] !== undefined) {
    const v = body['practice_drafts_per_week'];
    if (!isInt(v) || (v as number) < -1) {
      errs.push({ field: 'practice_drafts_per_week', message: 'must be integer ≥-1' });
    }
  }
  if (body['cap_mode'] !== undefined && typeof body['cap_mode'] !== 'boolean') {
    errs.push({ field: 'cap_mode', message: 'must be boolean' });
  }
  if (body['draft_modes'] !== undefined) {
    const dm = body['draft_modes'];
    if (!Array.isArray(dm) || dm.length === 0) {
      errs.push({ field: 'draft_modes', message: 'must be non-empty array' });
    } else {
      const seen = new Set<string>();
      for (const m of dm) {
        if (typeof m !== 'string' || !(DRAFT_MODES as readonly string[]).includes(m)) {
          errs.push({
            field: 'draft_modes',
            message: `each entry must be one of ${DRAFT_MODES.join('|')}`,
          });
          break;
        }
        if (seen.has(m)) {
          errs.push({ field: 'draft_modes', message: 'entries must be unique' });
          break;
        }
        seen.add(m);
      }
      if (!seen.has('snake')) {
        errs.push({ field: 'draft_modes', message: 'must include "snake"' });
      }
    }
  }
  if (body['fa_pool_size_per_week'] !== undefined) {
    const v = body['fa_pool_size_per_week'];
    if (!isInt(v) || (v as number) < 0) {
      errs.push({ field: 'fa_pool_size_per_week', message: 'must be integer ≥0' });
    }
  }
  if (body['draft_position_control'] !== undefined) {
    if (!(DRAFT_POSITION_CONTROLS as readonly string[]).includes(
      body['draft_position_control'] as string,
    )) {
      errs.push({
        field: 'draft_position_control',
        message: `must be one of ${DRAFT_POSITION_CONTROLS.join('|')}`,
      });
    }
  }
  if (body['family_max_profiles'] !== undefined) {
    const v = body['family_max_profiles'];
    if (!isInt(v) || (v as number) < 1) {
      errs.push({ field: 'family_max_profiles', message: 'must be integer ≥1' });
    }
  }
  if (body['card_scan_daily_cap'] !== undefined) {
    const v = body['card_scan_daily_cap'];
    if (!isInt(v) || (v as number) < -1) {
      errs.push({ field: 'card_scan_daily_cap', message: 'must be integer ≥-1' });
    }
  }
  if (body['card_inventory_cap'] !== undefined) {
    const v = body['card_inventory_cap'];
    if (!isInt(v) || (v as number) < -1) {
      errs.push({ field: 'card_inventory_cap', message: 'must be integer ≥-1' });
    }
  }
  if (body['daily_pp_boost'] !== undefined) {
    const v = body['daily_pp_boost'];
    if (!isNum(v) || (v as number) < 0) {
      errs.push({ field: 'daily_pp_boost', message: 'must be number ≥0' });
    }
  }
  if (body['ask_scout_daily_cap'] !== undefined) {
    const v = body['ask_scout_daily_cap'];
    if (!isInt(v) || (v as number) < -1) {
      errs.push({ field: 'ask_scout_daily_cap', message: 'must be integer ≥-1' });
    }
  }
  if (body['monthly_pack_allocation'] !== undefined) {
    const a = body['monthly_pack_allocation'];
    if (!Array.isArray(a)) {
      errs.push({ field: 'monthly_pack_allocation', message: 'must be array' });
    } else {
      a.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') {
          errs.push({ field: `monthly_pack_allocation[${i}]`, message: 'must be object' });
          return;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e['pack_id'] !== 'string' || !validPackIds.has(e['pack_id'] as string)) {
          errs.push({
            field: `monthly_pack_allocation[${i}].pack_id`,
            message: `must be a known pack_id`,
          });
        }
        if (!isInt(e['count']) || (e['count'] as number) < 1) {
          errs.push({
            field: `monthly_pack_allocation[${i}].count`,
            message: 'must be integer ≥1',
          });
        }
      });
    }
  }
  if (body['trade_cap_per_season'] !== undefined) {
    const v = body['trade_cap_per_season'];
    if (!isInt(v) || (v as number) < -1) {
      errs.push({
        field: 'trade_cap_per_season',
        message: 'must be integer ≥-1 (-1 = unlimited)',
      });
    }
  }
  if (body['notes'] !== undefined) {
    const v = body['notes'];
    if (typeof v !== 'string' || v.length > 4000) {
      errs.push({ field: 'notes', message: 'must be string ≤4000 chars' });
    }
  }
  return errs;
}

function validateStreakArray(arr: unknown, validPackIds: Set<string>): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!Array.isArray(arr)) {
    errs.push({ field: 'streak_rewards', message: 'must be array' });
    return errs;
  }
  let prev = -Infinity;
  arr.forEach((row, i) => {
    if (!row || typeof row !== 'object') {
      errs.push({ field: `streak_rewards[${i}]`, message: 'must be object' });
      return;
    }
    const r = row as Record<string, unknown>;
    if (!isInt(r['day']) || (r['day'] as number) < 1) {
      errs.push({ field: `streak_rewards[${i}].day`, message: 'must be integer ≥1' });
    } else if ((r['day'] as number) <= prev) {
      errs.push({ field: `streak_rewards[${i}].day`, message: 'days must strictly ascend' });
    } else {
      prev = r['day'] as number;
    }
    if (typeof r['pack_id'] !== 'string' || !validPackIds.has(r['pack_id'] as string)) {
      errs.push({ field: `streak_rewards[${i}].pack_id`, message: 'must be a known pack_id' });
    }
    if (!isInt(r['bonus_pp']) || (r['bonus_pp'] as number) < 0) {
      errs.push({
        field: `streak_rewards[${i}].bonus_pp`,
        message: 'must be non-negative integer',
      });
    }
    if (!isInt(r['bonus_tokens']) || (r['bonus_tokens'] as number) < 0) {
      errs.push({
        field: `streak_rewards[${i}].bonus_tokens`,
        message: 'must be non-negative integer',
      });
    }
  });
  return errs;
}

function validateTrigger(body: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  if (body['trigger_id'] !== undefined) {
    const v = body['trigger_id'];
    if (typeof v !== 'string' || !SLUG_RE.test(v) || v.length > 40) {
      errs.push({ field: 'trigger_id', message: 'must match ^[a-z][a-z0-9_]*$ and be ≤40 chars' });
    }
  }
  if (body['name'] !== undefined && !isStr(body['name'], 80)) {
    errs.push({ field: 'name', message: 'must be non-empty string ≤80 chars' });
  }
  if (body['description'] !== undefined && !isStr(body['description'], 600)) {
    errs.push({ field: 'description', message: 'must be non-empty string ≤600 chars' });
  }
  if (body['data_required'] !== undefined) {
    const dr = body['data_required'];
    if (!Array.isArray(dr) || dr.some((x) => typeof x !== 'string')) {
      errs.push({ field: 'data_required', message: 'must be array of strings' });
    }
  }
  if (body['approximate_trigger_rate'] !== undefined) {
    const v = body['approximate_trigger_rate'];
    if (!isNum(v) || (v as number) < 0 || (v as number) > 1) {
      errs.push({ field: 'approximate_trigger_rate', message: 'must be number 0..1' });
    }
  }
  return errs;
}

function validateStatResolutionEntry(body: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  for (const k of ['default_primary', 'default_secondary', 'default_tertiary'] as const) {
    if (body[k] !== undefined && !isStr(body[k], 60)) {
      errs.push({ field: k, message: 'must be non-empty string' });
    }
  }
  if (body['default_stats'] !== undefined) {
    const a = body['default_stats'];
    if (!Array.isArray(a) || a.length === 0 || a.some((x) => typeof x !== 'string')) {
      errs.push({ field: 'default_stats', message: 'must be non-empty array of strings' });
    }
  }
  if (body['star_threshold'] !== undefined) {
    const st = body['star_threshold'] as Record<string, unknown> | null;
    if (!st || typeof st !== 'object') {
      errs.push({ field: 'star_threshold', message: 'must be object' });
    } else {
      if (typeof st['stat'] !== 'string' || st['stat'].length === 0) {
        errs.push({ field: 'star_threshold.stat', message: 'must be non-empty string' });
      }
      if (!isNum(st['value'])) {
        errs.push({ field: 'star_threshold.value', message: 'must be number' });
      }
    }
  }
  if (body['by_position'] !== undefined) {
    const bp = body['by_position'];
    if (!bp || typeof bp !== 'object' || Array.isArray(bp)) {
      errs.push({ field: 'by_position', message: 'must be object' });
    } else {
      for (const [pos, entry] of Object.entries(bp)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errs.push({ field: `by_position.${pos}`, message: 'must be object' });
          continue;
        }
        const e = entry as Record<string, unknown>;
        for (const slot of ['primary', 'secondary', 'tertiary'] as const) {
          if (typeof e[slot] !== 'string' || (e[slot] as string).length === 0) {
            errs.push({
              field: `by_position.${pos}.${slot}`,
              message: 'must be non-empty string',
            });
          }
        }
      }
    }
  }
  return errs;
}

function validatePity(body: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  if (body['trigger_threshold'] !== undefined) {
    const v = body['trigger_threshold'];
    if (!isInt(v) || (v as number) < 1) {
      errs.push({ field: 'trigger_threshold', message: 'must be integer ≥1' });
    }
  }
  for (const k of ['description', 'tracking_unit', 'guarantee', 'reset_on'] as const) {
    if (body[k] !== undefined && !isStr(body[k], 400)) {
      errs.push({ field: k, message: 'must be non-empty string' });
    }
  }
  return errs;
}

function validateProgression(body: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  if (body['tiers'] !== undefined) {
    const t = body['tiers'];
    if (!Array.isArray(t)) {
      errs.push({ field: 'tiers', message: 'must be array' });
    } else if (t.length !== 13) {
      errs.push({ field: 'tiers', message: 'must contain exactly 13 tiers' });
    } else {
      let prevThreshold = -1;
      t.forEach((tier, i) => {
        if (!tier || typeof tier !== 'object') {
          errs.push({ field: `tiers[${i}]`, message: 'must be object' });
          return;
        }
        const r = tier as Record<string, unknown>;
        if (!isInt(r['level']) || (r['level'] as number) !== i + 1) {
          errs.push({ field: `tiers[${i}].level`, message: `must equal ${i + 1}` });
        }
        if (!isStr(r['name'], 40)) {
          errs.push({ field: `tiers[${i}].name`, message: 'must be non-empty string' });
        }
        if (!isInt(r['pp_threshold']) || (r['pp_threshold'] as number) < 0) {
          errs.push({
            field: `tiers[${i}].pp_threshold`,
            message: 'must be non-negative integer',
          });
        } else {
          if (i === 0 && (r['pp_threshold'] as number) !== 0) {
            errs.push({ field: `tiers[0].pp_threshold`, message: 'first tier must be 0' });
          }
          if ((r['pp_threshold'] as number) <= prevThreshold) {
            errs.push({
              field: `tiers[${i}].pp_threshold`,
              message: 'thresholds must strictly ascend',
            });
          }
          prevThreshold = r['pp_threshold'] as number;
        }
        if (typeof r['color'] !== 'string' || !HEX_RE.test(r['color'] as string)) {
          errs.push({ field: `tiers[${i}].color`, message: 'must match #RRGGBB hex' });
        }
      });
    }
  }
  if (body['tier_up_bonus_pp'] !== undefined) {
    const v = body['tier_up_bonus_pp'];
    if (!isInt(v) || (v as number) < 0) {
      errs.push({ field: 'tier_up_bonus_pp', message: 'must be non-negative integer' });
    }
  }
  return errs;
}

function validateTradeRules(body: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];

  // fairness section
  const f = body['fairness'] as Record<string, unknown> | undefined;
  if (f !== undefined) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      errs.push({ field: 'fairness', message: 'must be object' });
    } else {
      if (f['max_imbalance_pct'] !== undefined) {
        const v = f['max_imbalance_pct'];
        if (!isNum(v) || (v as number) < 0 || (v as number) > 100) {
          errs.push({ field: 'fairness.max_imbalance_pct', message: 'must be number 0..100' });
        }
      }
      if (f['pp_per_grade_point'] !== undefined) {
        const v = f['pp_per_grade_point'];
        if (!isNum(v) || (v as number) <= 0) {
          errs.push({ field: 'fairness.pp_per_grade_point', message: 'must be number >0' });
        }
      }
      if (f['max_pp_per_side'] !== undefined) {
        const v = f['max_pp_per_side'];
        if (!isInt(v) || (v as number) < 0) {
          errs.push({ field: 'fairness.max_pp_per_side', message: 'must be integer ≥0' });
        }
      }
      if (f['min_players_per_side'] !== undefined) {
        const v = f['min_players_per_side'];
        if (!isInt(v) || (v as number) < 1) {
          errs.push({ field: 'fairness.min_players_per_side', message: 'must be integer ≥1' });
        }
      }
      if (f['max_players_per_side'] !== undefined) {
        const v = f['max_players_per_side'];
        if (!isInt(v) || (v as number) < 1 || (v as number) > 10) {
          errs.push({ field: 'fairness.max_players_per_side', message: 'must be integer 1..10' });
        }
      }
      // min must not exceed max if both present.
      const mn = isInt(f['min_players_per_side']) ? (f['min_players_per_side'] as number) : null;
      const mx = isInt(f['max_players_per_side']) ? (f['max_players_per_side'] as number) : null;
      if (mn != null && mx != null && mn > mx) {
        errs.push({
          field: 'fairness.max_players_per_side',
          message: 'must be ≥ min_players_per_side',
        });
      }
    }
  }

  // execution
  const e = body['execution'] as Record<string, unknown> | undefined;
  if (e !== undefined) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      errs.push({ field: 'execution', message: 'must be object' });
    } else if (e['lock_duration_hours'] !== undefined) {
      const v = e['lock_duration_hours'];
      if (!isInt(v) || (v as number) < 0) {
        errs.push({ field: 'execution.lock_duration_hours', message: 'must be integer ≥0' });
      }
    }
  }

  // caps.by_tier — accept any tier key, all values must have integer ≥-1.
  const c = body['caps'] as Record<string, unknown> | undefined;
  if (c !== undefined) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errs.push({ field: 'caps', message: 'must be object' });
    } else {
      const bt = c['by_tier'] as Record<string, unknown> | undefined;
      if (bt !== undefined) {
        if (!bt || typeof bt !== 'object' || Array.isArray(bt)) {
          errs.push({ field: 'caps.by_tier', message: 'must be object' });
        } else {
          for (const [tier, entry] of Object.entries(bt)) {
            if (!entry || typeof entry !== 'object') {
              errs.push({ field: `caps.by_tier.${tier}`, message: 'must be object' });
              continue;
            }
            const er = entry as Record<string, unknown>;
            if (er['trades_per_season'] !== undefined) {
              const v = er['trades_per_season'];
              if (!isInt(v) || (v as number) < -1) {
                errs.push({
                  field: `caps.by_tier.${tier}.trades_per_season`,
                  message: 'must be integer ≥-1 (-1 = unlimited)',
                });
              }
            }
          }
        }
      }
    }
  }

  // age_safety
  const a = body['age_safety'] as Record<string, unknown> | undefined;
  if (a !== undefined) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      errs.push({ field: 'age_safety', message: 'must be object' });
    } else if (
      a['under_13_friend_list_only'] !== undefined &&
      typeof a['under_13_friend_list_only'] !== 'boolean'
    ) {
      errs.push({
        field: 'age_safety.under_13_friend_list_only',
        message: 'must be boolean',
      });
    }
  }

  // expiry
  const x = body['expiry'] as Record<string, unknown> | undefined;
  if (x !== undefined) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      errs.push({ field: 'expiry', message: 'must be object' });
    } else if (x['proposal_ttl_hours'] !== undefined) {
      const v = x['proposal_ttl_hours'];
      if (!isInt(v) || (v as number) < 0) {
        errs.push({ field: 'expiry.proposal_ttl_hours', message: 'must be integer ≥0' });
      }
    }
  }

  // cooldown
  if (body['cooldown_hours_between_trade_proposals_with_same_user'] !== undefined) {
    const v = body['cooldown_hours_between_trade_proposals_with_same_user'];
    if (!isInt(v) || (v as number) < 0) {
      errs.push({
        field: 'cooldown_hours_between_trade_proposals_with_same_user',
        message: 'must be integer ≥0',
      });
    }
  }

  return errs;
}

// ─── Page wrapper helper ─────────────────────────────────────────────────
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

// ─── Generic table-editor JS used by keyed-list resources (packs/triggers/pity/subs/sr) ─
const COMMON_JS_PRELUDE = /* javascript */ `
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showStatus(el, ok, txt) {
  el.innerHTML = '<span class="' + (ok?'ok':'err') + '">' + esc(txt) + '</span>';
  if (ok) setTimeout(() => el.textContent='', 2000);
}
async function saveJson(url, body) {
  const res = await fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const j = await res.json();
  return { ok: res.ok && j.ok, json: j };
}
`;

// ─── Route registration ──────────────────────────────────────────────────
export async function adminEditConfigRoutes(fastify: FastifyInstance): Promise<void> {
  // ═══ PACKS ═══════════════════════════════════════════════════════════════
  fastify.get('/admin/edit/packs', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Packs',
      'Pack Inventory',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/cards/pgm_packs.json</code> · auto-commits on save.
      </div>
      <div class="card-block">
        <table id="tbl">
          <thead><tr>
            <th>Pack ID</th><th>Name</th><th>PP Cost</th><th>Cards</th>
            <th>Drop rates (c/u/r/e/l)</th><th>Diversity</th><th>Bonus token</th><th>Actions</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>`,
      PACKS_JS,
    );
  });

  fastify.get('/admin/api/packs', async (_req, reply) => {
    try {
      const file = await readJson<PacksFile>(PACKS_PATH);
      return { ok: true, items: file.packs };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/packs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validatePack(body);
    if (errs.length) return badRequest(reply, errs);
    const file = await readJson<PacksFile>(PACKS_PATH);
    const idx = file.packs.findIndex((p) => p.pack_id === id);
    if (idx === -1) return notFound(reply, `pack ${id}`);
    const merged = { ...file.packs[idx]!, ...body } as PackDef;
    const reErrs = validatePack(merged as unknown as Record<string, unknown>);
    if (reErrs.length) return badRequest(reply, reErrs);
    file.packs[idx] = merged;
    await writeJson(PACKS_PATH, file);
    const commit = autoCommit(relFromRoot(PACKS_PATH), `chore(content): update packs — ${id}`);
    return { ok: true, item: merged, commit };
  });

  // ═══ EARN RATES ══════════════════════════════════════════════════════════
  fastify.get('/admin/edit/earn-rates', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Earn rates',
      'PP Earn Rates',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/economy/pgm_pp_earn_rates.json</code> · auto-commits on save.
      </div>
      <div id="root">Loading…</div>`,
      EARN_RATES_JS,
    );
  });

  fastify.get('/admin/api/earn-rates', async (_req, reply) => {
    try {
      const file = await readJson<EarnRatesFile>(EARN_RATES_PATH);
      return { ok: true, doc: file };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/earn-rates', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateEarnRates(body);
    if (errs.length) return badRequest(reply, errs);
    const file = await readJson<EarnRatesFile>(EARN_RATES_PATH);
    const merged: EarnRatesFile = {
      ...file,
      ...(body['roster_performance']
        ? {
            roster_performance: {
              ...file.roster_performance,
              ...(body['roster_performance'] as Record<string, number | string>),
            },
          }
        : {}),
      ...(body['daily_engagement']
        ? {
            daily_engagement: {
              ...file.daily_engagement,
              ...(body['daily_engagement'] as Record<string, number>),
            },
          }
        : {}),
      ...(body['subscription_daily_boost']
        ? {
            subscription_daily_boost: {
              ...file.subscription_daily_boost,
              ...(body['subscription_daily_boost'] as Record<string, number>),
            },
          }
        : {}),
    };
    await writeJson(EARN_RATES_PATH, merged);
    const commit = autoCommit(relFromRoot(EARN_RATES_PATH), 'chore(content): update earn rates');
    return { ok: true, doc: merged, commit };
  });

  // ═══ SUBSCRIPTIONS ═══════════════════════════════════════════════════════
  fastify.get('/admin/edit/subscriptions', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Subscriptions',
      'Subscription Tiers',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/economy/pgm_subscriptions.json</code> · auto-commits on save.
        v2 fields: draft modes, FA pool, slot picker, family, trade cap, notes.
        Use <code>-1</code> for "unlimited" in any numeric cap.
      </div>

      <h2 style="margin:18px 0 8px;font-size:13px;letter-spacing:.4px;color:var(--accent);text-transform:uppercase;">Comparison preview</h2>
      <div class="card-block" style="overflow-x:auto;">
        <table id="cmp">
          <thead></thead>
          <tbody></tbody>
        </table>
        <div class="hint" id="cmpWarn" style="margin-top:6px;color:var(--yellow);"></div>
      </div>

      <h2 style="margin:18px 0 8px;font-size:13px;letter-spacing:.4px;color:var(--accent);text-transform:uppercase;">Edit tier</h2>
      <div class="card-block" style="overflow-x:auto;">
        <table id="tbl">
          <thead><tr>
            <th>Tier</th><th>Name</th><th>$/mo</th><th>Rosters/wk</th>
            <th>Drafts/wk</th><th>Cap mode</th><th>Draft modes</th>
            <th>FA pool/wk</th><th>Slot picker</th><th>Family max</th>
            <th>Inv cap</th><th>PP daily</th><th>Scout cap</th><th>Card scan cap</th>
            <th>Trade cap/season</th>
            <th>Pack alloc (id:n,…)</th><th>Notes</th><th>Actions</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>`,
      SUBSCRIPTIONS_JS,
    );
  });

  fastify.get('/admin/api/subscriptions', async (_req, reply) => {
    try {
      const file = await readJson<SubscriptionsFile>(SUBSCRIPTIONS_PATH);
      return { ok: true, items: file.tiers };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const packs = await readJson<PacksFile>(PACKS_PATH);
    const validPackIds = new Set(packs.packs.map((p) => p.pack_id));
    const errs = validateSubscriptionTier(body, validPackIds);
    if (errs.length) return badRequest(reply, errs);
    const file = await readJson<SubscriptionsFile>(SUBSCRIPTIONS_PATH);
    const idx = file.tiers.findIndex((t) => t.tier_id === id);
    if (idx === -1) return notFound(reply, `subscription tier ${id}`);
    const merged = { ...file.tiers[idx]!, ...body } as SubTier;
    file.tiers[idx] = merged;
    await writeJson(SUBSCRIPTIONS_PATH, file);
    const commit = autoCommit(
      relFromRoot(SUBSCRIPTIONS_PATH),
      `chore(content): update subscriptions — ${id}`,
    );
    return { ok: true, item: merged, commit };
  });

  // ═══ STREAKS ═════════════════════════════════════════════════════════════
  fastify.get('/admin/edit/streaks', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Streaks',
      'Streak Rewards',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/economy/pgm_streak_rewards.json</code> · auto-commits on save.
      </div>
      <div class="card-block">
        <table id="tbl">
          <thead><tr>
            <th>Day</th><th>Pack</th><th>Bonus PP</th><th>Bonus Tokens</th><th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
          <button class="btn" id="addRow">+ Row</button>
          <button class="btn primary" id="save">Save all</button>
          <span class="hint" id="status"></span>
        </div>
      </div>`,
      STREAKS_JS,
    );
  });

  fastify.get('/admin/api/streaks', async (_req, reply) => {
    try {
      const file = await readJson<StreakRewardsFile>(STREAK_REWARDS_PATH);
      const packs = await readJson<PacksFile>(PACKS_PATH);
      return {
        ok: true,
        doc: file,
        valid_pack_ids: packs.packs.map((p) => p.pack_id),
      };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/streaks', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const packs = await readJson<PacksFile>(PACKS_PATH);
    const validPackIds = new Set(packs.packs.map((p) => p.pack_id));
    if (body['streak_rewards'] === undefined) {
      return badRequest(reply, [{ field: 'streak_rewards', message: 'required' }]);
    }
    const errs = validateStreakArray(body['streak_rewards'], validPackIds);
    if (errs.length) return badRequest(reply, errs);
    const file = await readJson<StreakRewardsFile>(STREAK_REWARDS_PATH);
    const merged: StreakRewardsFile = {
      ...file,
      streak_rewards: body['streak_rewards'] as StreakReward[],
    };
    await writeJson(STREAK_REWARDS_PATH, merged);
    const commit = autoCommit(
      relFromRoot(STREAK_REWARDS_PATH),
      'chore(content): update streak rewards',
    );
    return { ok: true, doc: merged, commit };
  });

  // ═══ TRIGGERS ════════════════════════════════════════════════════════════
  fastify.get('/admin/edit/triggers', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Triggers',
      'Card Triggers',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/cards/pgm_triggers.json</code> · auto-commits on save.
      </div>
      <div class="card-block">
        <table id="tbl">
          <thead><tr>
            <th>ID</th><th>Name</th><th>Description</th>
            <th>Data required (csv)</th><th>Rate</th><th>Actions</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>`,
      TRIGGERS_JS,
    );
  });

  fastify.get('/admin/api/triggers', async (_req, reply) => {
    try {
      const file = await readJson<TriggersFile>(TRIGGERS_PATH);
      return { ok: true, items: file.triggers };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/triggers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateTrigger(body);
    if (errs.length) return badRequest(reply, errs);
    const file = await readJson<TriggersFile>(TRIGGERS_PATH);
    const idx = file.triggers.findIndex((t) => t.trigger_id === id);
    if (idx === -1) return notFound(reply, `trigger ${id}`);
    const merged = { ...file.triggers[idx]!, ...body } as Trigger;
    file.triggers[idx] = merged;
    await writeJson(TRIGGERS_PATH, file);
    const commit = autoCommit(
      relFromRoot(TRIGGERS_PATH),
      `chore(content): update triggers — ${id}`,
    );
    return { ok: true, item: merged, commit };
  });

  // ═══ STAT RESOLUTION ═════════════════════════════════════════════════════
  fastify.get('/admin/edit/stat-resolution', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Stat resolution',
      'Stat Resolution',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/cards/pgm_stat_resolution.json</code> · auto-commits on save. Edit each sport as JSON.
      </div>
      <div id="root">Loading…</div>`,
      STAT_RESOLUTION_JS,
    );
  });

  fastify.get('/admin/api/stat-resolution', async (_req, reply) => {
    try {
      const file = await readJson<StatResolutionFile>(STAT_RESOLUTION_PATH);
      return { ok: true, doc: file };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/stat-resolution/:sport', async (req, reply) => {
    const { sport } = req.params as { sport: string };
    if (!(SPORTS as readonly string[]).includes(sport)) {
      return notFound(reply, `sport ${sport}`);
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateStatResolutionEntry(body);
    if (errs.length) return badRequest(reply, errs);
    const file = await readJson<StatResolutionFile>(STAT_RESOLUTION_PATH);
    const cur = file.stat_resolution[sport as Sport];
    if (!cur) return notFound(reply, `sport ${sport}`);
    const merged = { ...cur, ...body } as StatResolutionEntry;
    // Re-validate merged entry to ensure required keys still exist.
    if (
      !merged.default_primary ||
      !merged.default_secondary ||
      !merged.default_tertiary ||
      !Array.isArray(merged.default_stats) ||
      merged.default_stats.length === 0 ||
      !merged.star_threshold ||
      typeof merged.star_threshold.stat !== 'string' ||
      typeof merged.star_threshold.value !== 'number' ||
      !merged.by_position ||
      typeof merged.by_position !== 'object'
    ) {
      return badRequest(reply, [
        { field: 'merged', message: 'merged stat resolution entry missing required keys' },
      ]);
    }
    file.stat_resolution[sport as Sport] = merged;
    await writeJson(STAT_RESOLUTION_PATH, file);
    const commit = autoCommit(
      relFromRoot(STAT_RESOLUTION_PATH),
      `chore(content): update stat resolution — ${sport}`,
    );
    return { ok: true, sport, item: merged, commit };
  });

  // ═══ PITY ════════════════════════════════════════════════════════════════
  fastify.get('/admin/edit/pity', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Pity',
      'Pity Timers',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/cards/pgm_pity_timers.json</code> · auto-commits on save.
      </div>
      <div class="card-block">
        <table id="tbl">
          <thead><tr>
            <th>ID</th><th>Description</th><th>Threshold</th>
            <th>Tracking unit</th><th>Guarantee</th><th>Reset on</th><th>Actions</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>`,
      PITY_JS,
    );
  });

  fastify.get('/admin/api/pity', async (_req, reply) => {
    try {
      const file = await readJson<PityFile>(PITY_PATH);
      return { ok: true, items: file.pity_timers };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/pity/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validatePity(body);
    if (errs.length) return badRequest(reply, errs);
    const file = await readJson<PityFile>(PITY_PATH);
    const idx = file.pity_timers.findIndex((t) => t.id === id);
    if (idx === -1) return notFound(reply, `pity timer ${id}`);
    const merged = { ...file.pity_timers[idx]!, ...body } as PityTimer;
    file.pity_timers[idx] = merged;
    await writeJson(PITY_PATH, file);
    const commit = autoCommit(relFromRoot(PITY_PATH), `chore(content): update pity — ${id}`);
    return { ok: true, item: merged, commit };
  });

  // ═══ PROGRESSION ═════════════════════════════════════════════════════════
  fastify.get('/admin/edit/progression', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Progression',
      'Progression Tiers',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/economy/pgm_progression.json</code> · auto-commits on save.
      </div>
      <div class="card-block">
        <table id="tbl">
          <thead><tr>
            <th>Level</th><th>Name</th><th>PP threshold</th><th>Color (#hex)</th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
          <label class="muted">Tier-up bonus PP: <input id="bonus" type="number" min="0" step="1" style="width:90px;" /></label>
          <button class="btn primary" id="save">Save all</button>
          <span class="hint" id="status"></span>
        </div>
      </div>`,
      PROGRESSION_JS,
    );
  });

  fastify.get('/admin/api/progression', async (_req, reply) => {
    try {
      const file = await readJson<ProgressionFile>(PROGRESSION_PATH);
      return { ok: true, doc: file };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/progression', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateProgression(body);
    if (errs.length) return badRequest(reply, errs);
    const file = await readJson<ProgressionFile>(PROGRESSION_PATH);
    const merged: ProgressionFile = {
      ...file,
      ...(body['tiers'] ? { tiers: body['tiers'] as ProgressionTier[] } : {}),
      ...(body['tier_up_bonus_pp'] !== undefined
        ? { tier_up_bonus_pp: body['tier_up_bonus_pp'] as number }
        : {}),
      ...(body['contest_gating']
        ? { contest_gating: body['contest_gating'] as Record<string, number> }
        : {}),
    };
    await writeJson(PROGRESSION_PATH, merged);
    const commit = autoCommit(
      relFromRoot(PROGRESSION_PATH),
      'chore(content): update progression',
    );
    return { ok: true, doc: merged, commit };
  });

  // ═══ TRADE RULES ═════════════════════════════════════════════════════════
  fastify.get('/admin/edit/trade-rules', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Trade rules',
      'Trade Rules',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/economy/pgm_trade_rules.json</code> · auto-commits on save.
        Runtime cache + <code>/api/config/v1</code> are invalidated on save so changes
        flow to the live trade engine without a restart.
      </div>

      <h2 style="margin:18px 0 8px;font-size:13px;letter-spacing:.4px;color:var(--accent);text-transform:uppercase;">Test a trade</h2>
      <div class="card-block">
        <div class="muted" style="margin-bottom:8px;font-size:12px;">
          Enter the grade-summed score of each side (use the grade ladder
          A+=13, A=12, A-=11, B+=10, … F=1) plus an optional PP sweetener.
          The verdict and imbalance % are computed against the current
          <code>fairness</code> values below — edit those values and the
          calculator will recompute live.
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;">
          <div>
            <label class="muted">Side A grade total</label><br/>
            <input id="calc_a_grades" type="number" step="0.1" value="12" style="width:90px;" />
            <label class="muted" style="margin-left:10px;">Side A PP sweetener</label>
            <input id="calc_a_pp" type="number" min="0" value="0" style="width:90px;" />
          </div>
          <div>
            <label class="muted">Side B grade total</label><br/>
            <input id="calc_b_grades" type="number" step="0.1" value="11" style="width:90px;" />
            <label class="muted" style="margin-left:10px;">Side B PP sweetener</label>
            <input id="calc_b_pp" type="number" min="0" value="0" style="width:90px;" />
          </div>
        </div>
        <div id="calc_out" style="margin-top:10px;font-size:13px;"></div>
      </div>

      <h2 style="margin:18px 0 8px;font-size:13px;letter-spacing:.4px;color:var(--accent);text-transform:uppercase;">Fairness</h2>
      <div class="card-block">
        <table style="width:auto;">
          <tr><td><label class="muted">Imbalance threshold (%)</label></td>
            <td><input id="f_max_imbalance_pct" type="number" min="0" max="100" step="0.1" style="width:90px;" /></td>
            <td class="muted" style="font-size:11px;">Max <code>(|a-b|/max(a,b))</code> before auto-reject. 15 = ±15%.</td></tr>
          <tr><td><label class="muted">PP per grade point</label></td>
            <td><input id="f_pp_per_grade_point" type="number" min="1" style="width:90px;" /></td>
            <td class="muted" style="font-size:11px;">200 PP = 1.0 grade pts (so 100 PP = 0.5).</td></tr>
          <tr><td><label class="muted">Max PP sweetener / side</label></td>
            <td><input id="f_max_pp_per_side" type="number" min="0" style="width:90px;" /></td>
            <td class="muted" style="font-size:11px;">Hard ceiling. Excess PP is clamped server-side.</td></tr>
          <tr><td><label class="muted">Min players / side</label></td>
            <td><input id="f_min_players" type="number" min="1" style="width:90px;" /></td>
            <td class="muted" style="font-size:11px;">Each side must include at least this many players.</td></tr>
          <tr><td><label class="muted">Max players / side</label></td>
            <td><input id="f_max_players" type="number" min="1" max="10" style="width:90px;" /></td>
            <td class="muted" style="font-size:11px;">Spec default: 3.</td></tr>
        </table>
      </div>

      <h2 style="margin:18px 0 8px;font-size:13px;letter-spacing:.4px;color:var(--accent);text-transform:uppercase;">Execution &amp; expiry</h2>
      <div class="card-block">
        <table style="width:auto;">
          <tr><td><label class="muted">Post-trade lock (hours)</label></td>
            <td><input id="e_lock_hours" type="number" min="0" style="width:90px;" /></td>
            <td class="muted" style="font-size:11px;">Both rosters lock outbound trades for this duration.</td></tr>
          <tr><td><label class="muted">Proposal TTL (hours)</label></td>
            <td><input id="e_ttl_hours" type="number" min="0" style="width:90px;" /></td>
            <td class="muted" style="font-size:11px;">Pending proposals auto-expire after this many hours.</td></tr>
          <tr><td><label class="muted">Same-pair cooldown (hours)</label></td>
            <td><input id="e_cooldown" type="number" min="0" style="width:90px;" /></td>
            <td class="muted" style="font-size:11px;">Wait between proposals to the same user. 0 disables.</td></tr>
        </table>
      </div>

      <h2 style="margin:18px 0 8px;font-size:13px;letter-spacing:.4px;color:var(--accent);text-transform:uppercase;">Per-tier trade caps</h2>
      <div class="card-block">
        <table style="width:auto;">
          <thead><tr><th>Tier</th><th>Trades / season</th><th></th></tr></thead>
          <tbody id="capsBody"></tbody>
        </table>
        <div class="muted" style="font-size:11px;margin-top:6px;">Use <code>-1</code> for "unlimited".</div>
      </div>

      <h2 style="margin:18px 0 8px;font-size:13px;letter-spacing:.4px;color:var(--accent);text-transform:uppercase;">Age safety</h2>
      <div class="card-block">
        <label><input id="a_under13" type="checkbox" />
          Restrict under-13 users to friend-list trades only (COPPA)</label>
      </div>

      <div class="card-block" style="margin-top:14px;display:flex;gap:10px;align-items:center;">
        <button class="btn primary" id="save">Save</button>
        <button class="btn" id="diff">Show diff vs. current</button>
        <span class="hint" id="status"></span>
      </div>
      <pre id="diffOut" class="muted" style="margin-top:8px;font-size:12px;display:none;"></pre>`,
      TRADE_RULES_JS,
    );
  });

  fastify.get('/admin/api/trade-rules', async (_req, reply) => {
    try {
      const file = await readJson<TradeRulesFile>(TRADE_RULES_PATH);
      return { ok: true, doc: file };
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  /**
   * PUT /admin/api/trade-rules
   *
   * Body: a partial trade-rules patch ({ fairness?, execution?, caps?, …}).
   * We merge the patch into the on-disk file (preserving `_doc` comment
   * fields and the grade_score ladder), validate, and write. On success
   * we invalidate both the trade-rules in-memory cache and the runtime
   * config cache so changes flow live without a restart.
   */
  const writeTradeRules = async (
    req: { body?: unknown },
    reply: FastifyReply,
  ): Promise<unknown> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateTradeRules(body);
    if (errs.length) return badRequest(reply, errs);
    const file = await readJson<TradeRulesFile>(TRADE_RULES_PATH);
    const merged: TradeRulesFile = {
      ...file,
      ...(body['fairness']
        ? {
            fairness: {
              ...file.fairness,
              ...(body['fairness'] as Record<string, unknown>),
              // Always preserve the grade_score ladder — never editable here.
              grade_score: file.fairness.grade_score,
            },
          }
        : {}),
      ...(body['execution']
        ? {
            execution: {
              ...file.execution,
              ...(body['execution'] as Record<string, unknown>),
            },
          }
        : {}),
      ...(body['caps']
        ? {
            caps: {
              ...file.caps,
              by_tier: {
                ...file.caps.by_tier,
                ...((body['caps'] as Record<string, unknown>)['by_tier'] as Record<
                  string,
                  { trades_per_season: number }
                >),
              },
            },
          }
        : {}),
      ...(body['age_safety']
        ? {
            age_safety: {
              ...file.age_safety,
              ...(body['age_safety'] as Record<string, unknown>),
            },
          }
        : {}),
      ...(body['expiry']
        ? {
            expiry: {
              ...file.expiry,
              ...(body['expiry'] as Record<string, unknown>),
            },
          }
        : {}),
      ...(body['cooldown_hours_between_trade_proposals_with_same_user'] !== undefined
        ? {
            cooldown_hours_between_trade_proposals_with_same_user: body[
              'cooldown_hours_between_trade_proposals_with_same_user'
            ] as number,
          }
        : {}),
    };
    await writeJson(TRADE_RULES_PATH, merged);
    invalidateTradeRulesCache();
    invalidateConfigCache();
    const commit = autoCommit(
      relFromRoot(TRADE_RULES_PATH),
      'chore(content): update trade rules',
    );
    return { ok: true, doc: merged, commit };
  };
  fastify.put('/admin/api/trade-rules', writeTradeRules);
  // Accept PATCH too — admin writers in this file use PATCH semantics elsewhere.
  fastify.patch('/admin/api/trade-rules', writeTradeRules);

  // ═══ SPORTS CONFIG ═══════════════════════════════════════════════════════
  // Per-sport enabled flag + label/league/disabled_reason. Edits mutate
  // data/system/sports_config.json and invalidate the runtime config cache so
  // /api/config/v1 reflects the change without a server bounce. Schema is
  // tiny — one row per sport id, save per-row.
  fastify.get('/admin/edit/sports-config', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return pageHtml(
      'Sports config',
      'Sports Config',
      `<div class="muted" style="margin-bottom:10px;">
        Source: <code>data/system/sports_config.json</code> · auto-commits on save.
        Runtime cache + <code>/api/config/v1</code> are invalidated on save so the
        client picks up the toggle without a rebuild. Disabled sports are hidden
        across the app (sport selectors, trivia, scouting, highlights, settings)
        and their server endpoints reject with <code>{ reason: 'sport_disabled' }</code>.
      </div>
      <div class="card-block">
        <table id="tbl">
          <thead><tr>
            <th>Sport ID</th><th>Label</th><th>League</th>
            <th>Enabled</th><th>Disabled reason</th><th>Actions</th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <div class="muted" style="font-size:11px;margin-top:6px;">
          Sport IDs are read-only. To add a new sport, edit the JSON file directly
          and ensure the corresponding stat-cache + team data exists.
        </div>
      </div>`,
      SPORTS_CONFIG_JS,
    );
  });

  fastify.get('/admin/api/sports-config', async (_req, reply) => {
    try {
      const file = await readJson<SportsConfigFile>(SPORTS_CONFIG_PATH);
      const items = Object.entries(file.sports).map(([id, entry]) => ({ id, ...entry }));
      return { ok: true, items, version: file.version };
    } catch (err) {
      reply
        .code(500)
        .send({ ok: false, error: err instanceof Error ? err.message : 'load failed' });
      return reply;
    }
  });

  fastify.patch('/admin/api/sports-config/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs: ValidationError[] = [];
    if (body['enabled'] !== undefined && typeof body['enabled'] !== 'boolean') {
      errs.push({ field: 'enabled', message: 'must be boolean' });
    }
    if (body['label'] !== undefined && !isStr(body['label'], 40)) {
      errs.push({ field: 'label', message: 'must be non-empty string ≤40 chars' });
    }
    if (body['league'] !== undefined && !isStr(body['league'], 20)) {
      errs.push({ field: 'league', message: 'must be non-empty string ≤20 chars' });
    }
    if (
      body['disabled_reason'] !== undefined &&
      body['disabled_reason'] !== null &&
      typeof body['disabled_reason'] !== 'string'
    ) {
      errs.push({ field: 'disabled_reason', message: 'must be string or null' });
    }
    if (errs.length) return badRequest(reply, errs);

    const file = await readJson<SportsConfigFile>(SPORTS_CONFIG_PATH);
    if (!file.sports[id]) return notFound(reply, `sport ${id}`);
    const cur = file.sports[id];
    const merged: SportsConfigEntry = {
      enabled: body['enabled'] !== undefined ? (body['enabled'] as boolean) : cur.enabled,
      label: body['label'] !== undefined ? (body['label'] as string) : cur.label,
      league: body['league'] !== undefined ? (body['league'] as string) : cur.league,
      disabled_reason:
        body['disabled_reason'] !== undefined
          ? ((body['disabled_reason'] as string) ?? '')
          : (cur.disabled_reason ?? ''),
    };
    file.sports[id] = merged;
    file.last_updated_iso = new Date().toISOString();
    await writeJson(SPORTS_CONFIG_PATH, file);
    invalidateSportsConfigCache();
    invalidateConfigCache();
    const commit = autoCommit(
      relFromRoot(SPORTS_CONFIG_PATH),
      `chore(content): update sports config — ${id}`,
    );
    return { ok: true, item: { id, ...merged }, commit };
  });
}

// ─── Inline editor JS modules ────────────────────────────────────────────

const PACKS_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}
  const RARS = ['common','uncommon','rare','epic','legendary'];
  async function load() {
    const res = await fetch('/admin/api/packs');
    const j = await res.json();
    if (!j.ok) return;
    const tbody = document.querySelector('#tbl tbody');
    tbody.innerHTML = j.items.map(p => {
      const dr = p.drop_rates || {};
      const drStr = RARS.map(r => (dr[r] ?? 0)).join(',');
      return '<tr data-id="' + esc(p.pack_id) + '">' +
        '<td><code>' + esc(p.pack_id) + '</code></td>' +
        '<td><input class="name" value="' + esc(p.name) + '" /></td>' +
        '<td><input class="ppcost" value="' + (p.pp_cost == null ? '' : p.pp_cost) + '" placeholder="null" /></td>' +
        '<td><input class="cards" type="number" min="1" value="' + p.card_count + '" /></td>' +
        '<td><input class="dr" value="' + drStr + '" placeholder="c,u,r,e,l" /></td>' +
        '<td><input class="div" type="number" min="1" max="5" value="' + p.sport_diversity_min + '" /></td>' +
        '<td><input class="bt" type="number" step="0.01" min="0" max="1" value="' + p.bonus_token_chance + '" /></td>' +
        '<td><button class="btn primary save">Save</button><div class="hint status"></div></td>' +
        '</tr>';
    }).join('');
    tbody.querySelectorAll('.save').forEach(b => b.addEventListener('click', save));
  }
  async function save(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const status = tr.querySelector('.status');
    const ppcostRaw = tr.querySelector('.ppcost').value.trim();
    const drVals = tr.querySelector('.dr').value.split(',').map(s => Number(s.trim()));
    if (drVals.length !== 5 || drVals.some(n => Number.isNaN(n))) {
      return showStatus(status, false, 'drop rates must be 5 comma-separated numbers');
    }
    const dr = {}; RARS.forEach((r, i) => dr[r] = drVals[i]);
    const body = {
      name: tr.querySelector('.name').value.trim(),
      pp_cost: ppcostRaw === '' || ppcostRaw === 'null' ? null : Number(ppcostRaw),
      card_count: Number(tr.querySelector('.cards').value),
      drop_rates: dr,
      sport_diversity_min: Number(tr.querySelector('.div').value),
      bonus_token_chance: Number(tr.querySelector('.bt').value),
    };
    const r = await saveJson('/admin/api/packs/' + encodeURIComponent(id), body);
    showStatus(status, r.ok, r.ok ? 'saved' : ((r.json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || 'error'));
  }
  load();
})();
`;

const EARN_RATES_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}
  async function load() {
    const res = await fetch('/admin/api/earn-rates');
    const j = await res.json();
    if (!j.ok) return;
    const root = document.getElementById('root');
    root.classList.remove('muted');
    const sections = ['roster_performance', 'daily_engagement', 'subscription_daily_boost'];
    root.innerHTML = sections.map(sec => {
      const rows = Object.entries(j.doc[sec] || {}).map(([k,v]) => {
        if (k === 'performance_bonus_stack_rule') {
          return '<tr><td><code>' + esc(k) + '</code></td><td>' +
            '<select data-section="' + sec + '" data-key="' + esc(k) + '">' +
            '<option' + (v==='highest_only_no_stack'?' selected':'') + '>highest_only_no_stack</option>' +
            '<option' + (v==='stack'?' selected':'') + '>stack</option>' +
            '</select></td></tr>';
        }
        return '<tr><td><code>' + esc(k) + '</code></td><td>' +
          '<input type="number" min="0" step="1" data-section="' + sec + '" data-key="' + esc(k) + '" value="' + esc(v) + '" /></td></tr>';
      }).join('');
      return '<div class="card-block"><h3 style="margin:0 0 8px;">' + sec + '</h3>' +
        '<table>' + rows + '</table></div>';
    }).join('') +
    '<div class="card-block"><button class="btn primary" id="saveBtn">Save all</button> <span id="saveStatus" class="hint"></span></div>';
    document.getElementById('saveBtn').addEventListener('click', saveAll);
  }
  async function saveAll() {
    const status = document.getElementById('saveStatus');
    const body = { roster_performance:{}, daily_engagement:{}, subscription_daily_boost:{} };
    document.querySelectorAll('[data-section]').forEach(el => {
      const sec = el.dataset.section, key = el.dataset.key;
      const v = el.value;
      body[sec][key] = el.tagName === 'SELECT' ? v : Number(v);
    });
    const r = await saveJson('/admin/api/earn-rates', body);
    showStatus(status, r.ok, r.ok ? 'saved' : ((r.json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || 'error'));
  }
  load();
})();
`;

const SUBSCRIPTIONS_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}
  const SLOT_OPTS = ['none','random','preferred_slot','exact_slot'];

  /** Snapshot of "spec defaults" (v2.0.0). Used by the Reset button. */
  const DEFAULTS = {
    free: {
      name:'Free', monthly_price_usd:0, rosters_per_week:1, practice_drafts_per_week:1,
      cap_mode:false, draft_modes:['snake'], fa_pool_size_per_week:10,
      draft_position_control:'none', family_max_profiles:1, monthly_pack_allocation:[],
      card_inventory_cap:100, daily_pp_boost:200, ask_scout_daily_cap:2,
      card_scan_daily_cap:2, trade_cap_per_season:2, notes:''
    },
    starter: {
      name:'Starter', monthly_price_usd:4.99, rosters_per_week:3, practice_drafts_per_week:5,
      cap_mode:true, draft_modes:['snake','cap'], fa_pool_size_per_week:20,
      draft_position_control:'random', family_max_profiles:1,
      monthly_pack_allocation:[{pack_id:'pro_pack',count:1}],
      card_inventory_cap:200, daily_pp_boost:500, ask_scout_daily_cap:5,
      card_scan_daily_cap:5, trade_cap_per_season:-1, notes:''
    },
    playmaker: {
      name:'Playmaker', monthly_price_usd:9.99, rosters_per_week:6, practice_drafts_per_week:15,
      cap_mode:true, draft_modes:['snake','cap'], fa_pool_size_per_week:30,
      draft_position_control:'preferred_slot', family_max_profiles:1,
      monthly_pack_allocation:[{pack_id:'pro_pack',count:3}],
      card_inventory_cap:400, daily_pp_boost:1000, ask_scout_daily_cap:10,
      card_scan_daily_cap:10, trade_cap_per_season:-1, notes:''
    },
    champion: {
      name:'Champion', monthly_price_usd:19.99, rosters_per_week:12, practice_drafts_per_week:-1,
      cap_mode:true, draft_modes:['snake','cap'], fa_pool_size_per_week:40,
      draft_position_control:'exact_slot', family_max_profiles:1,
      monthly_pack_allocation:[
        {pack_id:'all_star_pack',count:1},
        {pack_id:'pro_pack',count:2}
      ],
      card_inventory_cap:-1, daily_pp_boost:2000, ask_scout_daily_cap:20,
      card_scan_daily_cap:20, trade_cap_per_season:-1, notes:''
    }
  };

  /** Display "-1" as "unlimited" in the comparison preview. */
  function fmt(v) {
    if (v === -1 || v === '-1') return 'unlimited';
    if (typeof v === 'number') return String(v);
    return v == null ? '—' : String(v);
  }

  /** Order Free → Starter → Playmaker → Champion regardless of file order. */
  const TIER_ORDER = ['free','starter','playmaker','champion'];
  function sortTiers(items) {
    return items.slice().sort((a,b) => TIER_ORDER.indexOf(a.tier_id) - TIER_ORDER.indexOf(b.tier_id));
  }

  /** Read all current values from a row back into a tier object. */
  function rowToBody(tr) {
    const allocStr = tr.querySelector('.alloc').value.trim();
    const allocation = allocStr === '' ? [] : allocStr.split(',').map(s => {
      const [pid, c] = s.split(':');
      return { pack_id: (pid||'').trim(), count: Number((c||'0').trim()) };
    });
    const dmStr = tr.querySelector('.dm').value.trim();
    const draft_modes = dmStr === '' ? ['snake'] : dmStr.split(',').map(s => s.trim()).filter(Boolean);
    return {
      name: tr.querySelector('.name').value.trim(),
      monthly_price_usd: Number(tr.querySelector('.price').value),
      rosters_per_week: Number(tr.querySelector('.rpw').value),
      practice_drafts_per_week: Number(tr.querySelector('.dpw').value),
      cap_mode: tr.querySelector('.cap').checked,
      draft_modes,
      fa_pool_size_per_week: Number(tr.querySelector('.fa').value),
      draft_position_control: tr.querySelector('.slot').value,
      family_max_profiles: Number(tr.querySelector('.fam').value),
      card_inventory_cap: Number(tr.querySelector('.inv').value),
      daily_pp_boost: Number(tr.querySelector('.boost').value),
      ask_scout_daily_cap: Number(tr.querySelector('.scout').value),
      card_scan_daily_cap: Number(tr.querySelector('.scan').value),
      trade_cap_per_season: Number(tr.querySelector('.trade').value),
      monthly_pack_allocation: allocation,
      notes: tr.querySelector('.notes').value,
    };
  }

  /** Render the comparison preview from the live table. */
  function renderPreview() {
    const rows = Array.from(document.querySelectorAll('#tbl tbody tr'));
    const items = rows.map(tr => Object.assign({ tier_id: tr.dataset.id }, rowToBody(tr)));
    const sorted = sortTiers(items);

    const head = '<tr><th style="text-align:left;">Field</th>' +
      sorted.map(t => '<th>'+esc(t.name||t.tier_id)+'</th>').join('') + '</tr>';
    const fields = [
      ['Tier id', t => '<code>'+esc(t.tier_id)+'</code>'],
      ['Price / mo', t => '$' + Number(t.monthly_price_usd).toFixed(2)],
      ['Rosters / week', t => fmt(t.rosters_per_week)],
      ['Practice drafts / week', t => fmt(t.practice_drafts_per_week)],
      ['Cap mode', t => t.cap_mode ? '✓' : '—'],
      ['Draft modes', t => (t.draft_modes||[]).join(', ')],
      ['FA pool / week', t => fmt(t.fa_pool_size_per_week)],
      ['Slot picker', t => esc(t.draft_position_control)],
      ['Family max profiles', t => fmt(t.family_max_profiles)],
      ['Inventory cap', t => fmt(t.card_inventory_cap)],
      ['Daily PP boost', t => fmt(t.daily_pp_boost)],
      ['Ask Scout / day', t => fmt(t.ask_scout_daily_cap)],
      ['Card Scan / day', t => fmt(t.card_scan_daily_cap)],
      ['Trade cap / season', t => fmt(t.trade_cap_per_season ?? -1)],
      ['Monthly pack alloc', t => (t.monthly_pack_allocation||[]).map(p => p.pack_id+':'+p.count).join(', ') || '—'],
    ];
    const body = fields.map(([label, getter]) =>
      '<tr><td style="color:var(--muted);">'+esc(label)+'</td>' +
      sorted.map(t => '<td>'+getter(t)+'</td>').join('') + '</tr>'
    ).join('');
    document.querySelector('#cmp thead').innerHTML = head;
    document.querySelector('#cmp tbody').innerHTML = body;

    // Free-paid feature warning: if Free has a numeric cap higher than any paid tier's,
    // call it out. Same for "unlimited free, capped paid".
    const free = sorted.find(t => t.tier_id === 'free');
    const warns = [];
    if (free) {
      const checkUp = (key, label) => {
        const fv = Number(free[key]);
        for (const t of sorted) {
          if (t.tier_id === 'free') continue;
          const tv = Number(t[key]);
          // Treat -1 as Infinity for comparison.
          const ff = fv === -1 ? Infinity : fv;
          const tt = tv === -1 ? Infinity : tv;
          if (ff > tt) warns.push(label+': Free ('+fmt(fv)+') exceeds '+(t.name||t.tier_id)+' ('+fmt(tv)+').');
        }
      };
      checkUp('rosters_per_week','Rosters/week');
      checkUp('practice_drafts_per_week','Drafts/week');
      checkUp('fa_pool_size_per_week','FA pool');
      checkUp('card_inventory_cap','Inventory cap');
      checkUp('daily_pp_boost','Daily PP');
      checkUp('ask_scout_daily_cap','Ask Scout');
      checkUp('card_scan_daily_cap','Card Scan');
      checkUp('trade_cap_per_season','Trade cap');
    }
    document.getElementById('cmpWarn').textContent =
      warns.length ? '⚠ ' + warns.join(' ') : '';
  }

  function rowHtml(t) {
    const allocStr = (t.monthly_pack_allocation || []).map(a => a.pack_id + ':' + a.count).join(',');
    const dm = t.draft_modes || (t.cap_mode ? ['snake','cap'] : ['snake']);
    const dmStr = dm.join(',');
    const slotOpts = SLOT_OPTS.map(o =>
      '<option' + ((t.draft_position_control||'none')===o?' selected':'') + '>'+o+'</option>'
    ).join('');
    const tradeCap = (t.trade_cap_per_season ?? -1);
    const notes = t.notes ?? '';
    return '<tr data-id="' + esc(t.tier_id) + '">' +
      '<td><code>' + esc(t.tier_id) + '</code></td>' +
      '<td><input class="name" value="' + esc(t.name) + '" /></td>' +
      '<td><input class="price" type="number" min="0" step="0.01" value="' + t.monthly_price_usd + '" style="width:80px;" /></td>' +
      '<td><input class="rpw" type="number" min="0" value="' + t.rosters_per_week + '" style="width:60px;" /></td>' +
      '<td><input class="dpw" type="number" min="-1" value="' + t.practice_drafts_per_week + '" style="width:60px;" title="-1 = unlimited" /></td>' +
      '<td><input class="cap" type="checkbox" ' + (t.cap_mode?'checked':'') + ' /></td>' +
      '<td><input class="dm" value="' + esc(dmStr) + '" placeholder="snake,cap" style="width:100px;" /></td>' +
      '<td><input class="fa" type="number" min="0" value="' + (t.fa_pool_size_per_week ?? 0) + '" style="width:60px;" /></td>' +
      '<td><select class="slot">' + slotOpts + '</select></td>' +
      '<td><input class="fam" type="number" min="1" value="' + (t.family_max_profiles ?? 1) + '" style="width:60px;" /></td>' +
      '<td><input class="inv" type="number" min="-1" value="' + t.card_inventory_cap + '" style="width:70px;" title="-1 = unlimited" /></td>' +
      '<td><input class="boost" type="number" min="0" value="' + t.daily_pp_boost + '" style="width:70px;" /></td>' +
      '<td><input class="scout" type="number" min="-1" value="' + t.ask_scout_daily_cap + '" style="width:60px;" title="-1 = unlimited" /></td>' +
      '<td><input class="scan" type="number" min="-1" value="' + (t.card_scan_daily_cap ?? -1) + '" style="width:60px;" title="-1 = unlimited" /></td>' +
      '<td><input class="trade" type="number" min="-1" value="' + tradeCap + '" style="width:80px;" title="-1 = unlimited" /></td>' +
      '<td><input class="alloc" value="' + esc(allocStr) + '" placeholder="pack_id:n,…" /></td>' +
      '<td><textarea class="notes" rows="2" style="width:200px;font-size:12px;">' + esc(notes) + '</textarea></td>' +
      '<td>' +
        '<button class="btn primary save">Save</button> ' +
        '<button class="btn reset" title="Reset to v2.0.0 default">Reset</button>' +
        '<div class="hint status"></div>' +
      '</td>' +
    '</tr>';
  }

  async function load() {
    const res = await fetch('/admin/api/subscriptions');
    const j = await res.json();
    if (!j.ok) return;
    const tbody = document.querySelector('#tbl tbody');
    tbody.innerHTML = sortTiers(j.items).map(rowHtml).join('');
    wire();
    renderPreview();
  }

  function wire() {
    const tbody = document.querySelector('#tbl tbody');
    tbody.querySelectorAll('.save').forEach(b => b.addEventListener('click', save));
    tbody.querySelectorAll('.reset').forEach(b => b.addEventListener('click', resetRow));
    // Live preview — recompute whenever any input changes.
    tbody.querySelectorAll('input,select,textarea').forEach(el =>
      el.addEventListener('input', renderPreview)
    );
  }

  function resetRow(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const def = DEFAULTS[id];
    if (!def) return;
    if (!confirm('Reset ' + id + ' to v2.0.0 defaults? Save afterwards to persist.')) return;
    tr.outerHTML = rowHtml(Object.assign({ tier_id: id }, def));
    wire();
    renderPreview();
  }

  async function save(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const status = tr.querySelector('.status');
    const body = rowToBody(tr);
    // Pre-flight: numeric fields must not be < -1; -1 is the sentinel for unlimited.
    const numericKeys = ['practice_drafts_per_week','card_inventory_cap','ask_scout_daily_cap','card_scan_daily_cap','trade_cap_per_season'];
    for (const k of numericKeys) {
      if (Number.isNaN(body[k]) || body[k] < -1) {
        showStatus(status, false, k + ' must be ≥ -1 (-1 = unlimited)');
        return;
      }
    }
    const r = await saveJson('/admin/api/subscriptions/' + encodeURIComponent(id), body);
    showStatus(status, r.ok, r.ok ? 'saved' : ((r.json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || 'error'));
    if (r.ok) renderPreview();
  }

  load();
})();
`;

const STREAKS_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}
  let validIds = [];
  function rowHtml(r) {
    const opts = validIds.map(id => '<option' + (id===r.pack_id?' selected':'') + '>' + esc(id) + '</option>').join('');
    return '<tr>' +
      '<td><input class="day" type="number" min="1" value="' + r.day + '" style="width:80px;" /></td>' +
      '<td><select class="pack">' + opts + '</select></td>' +
      '<td><input class="pp" type="number" min="0" value="' + r.bonus_pp + '" style="width:90px;" /></td>' +
      '<td><input class="tok" type="number" min="0" value="' + r.bonus_tokens + '" style="width:90px;" /></td>' +
      '<td><button class="btn danger del">×</button></td>' +
    '</tr>';
  }
  async function load() {
    const res = await fetch('/admin/api/streaks');
    const j = await res.json();
    if (!j.ok) return;
    validIds = j.valid_pack_ids;
    const tbody = document.querySelector('#tbl tbody');
    tbody.innerHTML = j.doc.streak_rewards.map(rowHtml).join('');
    wireDel();
  }
  function wireDel() {
    document.querySelectorAll('.del').forEach(b => {
      b.onclick = () => { b.closest('tr').remove(); };
    });
  }
  document.getElementById('addRow').addEventListener('click', () => {
    const tbody = document.querySelector('#tbl tbody');
    const r = { day: 0, pack_id: validIds[0]||'', bonus_pp: 0, bonus_tokens: 0 };
    tbody.insertAdjacentHTML('beforeend', rowHtml(r));
    wireDel();
  });
  document.getElementById('save').addEventListener('click', async () => {
    const status = document.getElementById('status');
    const rows = Array.from(document.querySelectorAll('#tbl tbody tr')).map(tr => ({
      day: Number(tr.querySelector('.day').value),
      pack_id: tr.querySelector('.pack').value,
      bonus_pp: Number(tr.querySelector('.pp').value),
      bonus_tokens: Number(tr.querySelector('.tok').value),
    }));
    const r = await saveJson('/admin/api/streaks', { streak_rewards: rows });
    showStatus(status, r.ok, r.ok ? 'saved' : ((r.json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || 'error'));
  });
  load();
})();
`;

const TRIGGERS_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}
  async function load() {
    const res = await fetch('/admin/api/triggers');
    const j = await res.json();
    if (!j.ok) return;
    const tbody = document.querySelector('#tbl tbody');
    tbody.innerHTML = j.items.map(t =>
      '<tr data-id="' + esc(t.trigger_id) + '">' +
        '<td><code>' + esc(t.trigger_id) + '</code></td>' +
        '<td><input class="name" value="' + esc(t.name) + '" /></td>' +
        '<td><textarea class="desc">' + esc(t.description) + '</textarea></td>' +
        '<td><input class="dr" value="' + esc((t.data_required||[]).join(',')) + '" /></td>' +
        '<td><input class="rate" type="number" step="0.01" min="0" max="1" value="' + t.approximate_trigger_rate + '" style="width:80px;" /></td>' +
        '<td><button class="btn primary save">Save</button><div class="hint status"></div></td>' +
      '</tr>'
    ).join('');
    document.querySelectorAll('.save').forEach(b => b.addEventListener('click', save));
  }
  async function save(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const status = tr.querySelector('.status');
    const drRaw = tr.querySelector('.dr').value.trim();
    const body = {
      name: tr.querySelector('.name').value.trim(),
      description: tr.querySelector('.desc').value.trim(),
      data_required: drRaw === '' ? [] : drRaw.split(',').map(s => s.trim()).filter(Boolean),
      approximate_trigger_rate: Number(tr.querySelector('.rate').value),
    };
    const r = await saveJson('/admin/api/triggers/' + encodeURIComponent(id), body);
    showStatus(status, r.ok, r.ok ? 'saved' : ((r.json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || 'error'));
  }
  load();
})();
`;

const STAT_RESOLUTION_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}
  async function load() {
    const res = await fetch('/admin/api/stat-resolution');
    const j = await res.json();
    if (!j.ok) return;
    const root = document.getElementById('root');
    root.classList.remove('muted');
    root.innerHTML = Object.entries(j.doc.stat_resolution).map(([sport, entry]) =>
      '<div class="card-block" data-sport="' + esc(sport) + '">' +
        '<h3 style="margin:0 0 8px;">' + esc(sport) + '</h3>' +
        '<textarea class="json" style="min-height:240px;font-family:monospace;font-size:12px;">' +
          esc(JSON.stringify(entry, null, 2)) +
        '</textarea>' +
        '<div style="margin-top:6px;display:flex;gap:8px;align-items:center;">' +
          '<button class="btn primary save">Save</button>' +
          '<span class="hint status"></span>' +
        '</div>' +
      '</div>'
    ).join('');
    document.querySelectorAll('.save').forEach(b => b.addEventListener('click', save));
  }
  async function save(ev) {
    const card = ev.target.closest('[data-sport]');
    const sport = card.dataset.sport;
    const status = card.querySelector('.status');
    let body;
    try { body = JSON.parse(card.querySelector('.json').value); }
    catch (e) { return showStatus(status, false, 'invalid JSON: ' + e.message); }
    const r = await saveJson('/admin/api/stat-resolution/' + encodeURIComponent(sport), body);
    showStatus(status, r.ok, r.ok ? 'saved' : ((r.json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || 'error'));
  }
  load();
})();
`;

const PITY_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}
  async function load() {
    const res = await fetch('/admin/api/pity');
    const j = await res.json();
    if (!j.ok) return;
    const tbody = document.querySelector('#tbl tbody');
    tbody.innerHTML = j.items.map(t =>
      '<tr data-id="' + esc(t.id) + '">' +
        '<td><code>' + esc(t.id) + '</code></td>' +
        '<td><textarea class="desc">' + esc(t.description) + '</textarea></td>' +
        '<td><input class="th" type="number" min="1" value="' + t.trigger_threshold + '" style="width:80px;" /></td>' +
        '<td><input class="tu" value="' + esc(t.tracking_unit) + '" /></td>' +
        '<td><input class="g" value="' + esc(t.guarantee) + '" /></td>' +
        '<td><input class="r" value="' + esc(t.reset_on) + '" /></td>' +
        '<td><button class="btn primary save">Save</button><div class="hint status"></div></td>' +
      '</tr>'
    ).join('');
    document.querySelectorAll('.save').forEach(b => b.addEventListener('click', save));
  }
  async function save(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const status = tr.querySelector('.status');
    const body = {
      description: tr.querySelector('.desc').value.trim(),
      trigger_threshold: Number(tr.querySelector('.th').value),
      tracking_unit: tr.querySelector('.tu').value.trim(),
      guarantee: tr.querySelector('.g').value.trim(),
      reset_on: tr.querySelector('.r').value.trim(),
    };
    const r = await saveJson('/admin/api/pity/' + encodeURIComponent(id), body);
    showStatus(status, r.ok, r.ok ? 'saved' : ((r.json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || 'error'));
  }
  load();
})();
`;

const PROGRESSION_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}
  async function load() {
    const res = await fetch('/admin/api/progression');
    const j = await res.json();
    if (!j.ok) return;
    const tbody = document.querySelector('#tbl tbody');
    tbody.innerHTML = j.doc.tiers.map(t =>
      '<tr>' +
        '<td><input class="lvl" type="number" min="1" max="13" value="' + t.level + '" style="width:60px;" /></td>' +
        '<td><input class="name" value="' + esc(t.name) + '" /></td>' +
        '<td><input class="th" type="number" min="0" value="' + t.pp_threshold + '" /></td>' +
        '<td><input class="color" value="' + esc(t.color) + '" placeholder="#RRGGBB" style="width:90px;" /></td>' +
      '</tr>'
    ).join('');
    document.getElementById('bonus').value = j.doc.tier_up_bonus_pp;
  }
  document.getElementById('save').addEventListener('click', async () => {
    const status = document.getElementById('status');
    const tiers = Array.from(document.querySelectorAll('#tbl tbody tr')).map(tr => ({
      level: Number(tr.querySelector('.lvl').value),
      name: tr.querySelector('.name').value.trim(),
      pp_threshold: Number(tr.querySelector('.th').value),
      color: tr.querySelector('.color').value.trim(),
    }));
    const body = { tiers, tier_up_bonus_pp: Number(document.getElementById('bonus').value) };
    const r = await saveJson('/admin/api/progression', body);
    showStatus(status, r.ok, r.ok ? 'saved' : ((r.json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || 'error'));
  });
  load();
})();
`;

const TRADE_RULES_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}

  let original = null; // doc loaded from server, used by the diff button.

  /** Build the current form state into the same shape the PATCH endpoint expects. */
  function readForm() {
    const caps = {};
    document.querySelectorAll('#capsBody tr[data-tier]').forEach(tr => {
      const tier = tr.dataset.tier;
      const v = Number(tr.querySelector('.cap').value);
      caps[tier] = { trades_per_season: v };
    });
    return {
      fairness: {
        max_imbalance_pct: Number(document.getElementById('f_max_imbalance_pct').value),
        pp_per_grade_point: Number(document.getElementById('f_pp_per_grade_point').value),
        max_pp_per_side: Number(document.getElementById('f_max_pp_per_side').value),
        min_players_per_side: Number(document.getElementById('f_min_players').value),
        max_players_per_side: Number(document.getElementById('f_max_players').value),
      },
      execution: {
        lock_duration_hours: Number(document.getElementById('e_lock_hours').value),
      },
      expiry: {
        proposal_ttl_hours: Number(document.getElementById('e_ttl_hours').value),
      },
      cooldown_hours_between_trade_proposals_with_same_user:
        Number(document.getElementById('e_cooldown').value),
      caps: { by_tier: caps },
      age_safety: {
        under_13_friend_list_only: document.getElementById('a_under13').checked,
      },
    };
  }

  /** Run the same fairness math the server runs, against the live form values. */
  function recompute() {
    const f = readForm().fairness;
    const aGrades = Number(document.getElementById('calc_a_grades').value) || 0;
    const aPpRaw = Math.max(0, Number(document.getElementById('calc_a_pp').value) || 0);
    const bGrades = Number(document.getElementById('calc_b_grades').value) || 0;
    const bPpRaw = Math.max(0, Number(document.getElementById('calc_b_pp').value) || 0);
    const aPp = Math.min(aPpRaw, f.max_pp_per_side);
    const bPp = Math.min(bPpRaw, f.max_pp_per_side);
    const aScore = aGrades + (f.pp_per_grade_point > 0 ? aPp / f.pp_per_grade_point : 0);
    const bScore = bGrades + (f.pp_per_grade_point > 0 ? bPp / f.pp_per_grade_point : 0);
    const denom = Math.max(aScore, bScore);
    const imbalance = denom > 0 ? Math.abs(aScore - bScore) / denom : 0;
    const threshold = (f.max_imbalance_pct || 0) / 100;
    let verdict, color;
    if (imbalance <= threshold * 0.5) { verdict = 'fair'; color = 'var(--green,#4ade80)'; }
    else if (imbalance <= threshold)  { verdict = 'slightly off'; color = 'var(--yellow,#facc15)'; }
    else                              { verdict = 'lopsided'; color = 'var(--red,#f87171)'; }
    const pct = (imbalance * 100).toFixed(1);
    const out = document.getElementById('calc_out');
    out.innerHTML =
      '<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:rgba(255,255,255,0.06);color:'+color+';font-weight:600;">'+
        esc(verdict.toUpperCase())+
      '</span>' +
      ' &nbsp; imbalance <code>'+pct+'%</code>' +
      ' &nbsp; threshold <code>±'+(threshold*100).toFixed(1)+'%</code>' +
      ' &nbsp; <span class="muted">Side A score: '+aScore.toFixed(2)+' &nbsp; Side B score: '+bScore.toFixed(2)+'</span>' +
      (aPpRaw > f.max_pp_per_side ? '<div style="color:'+color+';font-size:12px;">⚠ Side A PP capped at '+f.max_pp_per_side+'</div>' : '') +
      (bPpRaw > f.max_pp_per_side ? '<div style="color:'+color+';font-size:12px;">⚠ Side B PP capped at '+f.max_pp_per_side+'</div>' : '');
  }

  function fillForm(doc) {
    const f = doc.fairness || {};
    const e = doc.execution || {};
    const x = doc.expiry || {};
    const a = doc.age_safety || {};
    document.getElementById('f_max_imbalance_pct').value = f.max_imbalance_pct ?? 15;
    document.getElementById('f_pp_per_grade_point').value = f.pp_per_grade_point ?? 200;
    document.getElementById('f_max_pp_per_side').value = f.max_pp_per_side ?? 2000;
    document.getElementById('f_min_players').value = f.min_players_per_side ?? 1;
    document.getElementById('f_max_players').value = f.max_players_per_side ?? 3;
    document.getElementById('e_lock_hours').value = e.lock_duration_hours ?? 24;
    document.getElementById('e_ttl_hours').value = x.proposal_ttl_hours ?? 72;
    document.getElementById('e_cooldown').value =
      doc.cooldown_hours_between_trade_proposals_with_same_user ?? 6;
    document.getElementById('a_under13').checked = !!a.under_13_friend_list_only;
    const tiers = (doc.caps && doc.caps.by_tier) || {};
    const order = ['free','starter','playmaker','champion'];
    const tbody = document.getElementById('capsBody');
    tbody.innerHTML = order
      .filter(t => tiers[t])
      .map(t => '<tr data-tier="'+esc(t)+'">' +
        '<td><code>'+esc(t)+'</code></td>' +
        '<td><input class="cap" type="number" min="-1" value="'+(tiers[t].trades_per_season ?? -1)+'" style="width:90px;" title="-1 = unlimited" /></td>' +
        '<td class="muted" style="font-size:11px;">'+(Number(tiers[t].trades_per_season)===-1?'unlimited':'capped')+'</td>' +
      '</tr>').join('');
  }

  async function load() {
    const res = await fetch('/admin/api/trade-rules');
    const j = await res.json();
    if (!j.ok) return;
    original = j.doc;
    fillForm(j.doc);
    wireLive();
    recompute();
  }

  function wireLive() {
    document.querySelectorAll('input,select').forEach(el =>
      el.addEventListener('input', recompute)
    );
  }

  document.getElementById('save').addEventListener('click', async () => {
    const body = readForm();
    const status = document.getElementById('status');
    if (Number(body.fairness.min_players_per_side) > Number(body.fairness.max_players_per_side)) {
      return showStatus(status, false, 'min players must be ≤ max players');
    }
    const res = await fetch('/admin/api/trade-rules', {
      method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    const j = await res.json();
    if (res.ok && j.ok) {
      original = j.doc;
      showStatus(status, true, 'saved');
    } else {
      showStatus(status, false, ((j.errors||[]).map(e=>e.field+': '+e.message).join(', ')) || j.error || 'error');
    }
  });

  document.getElementById('diff').addEventListener('click', () => {
    const out = document.getElementById('diffOut');
    if (!original) return;
    const cur = readForm();
    const lines = [];
    const flatOrig = flatten(original);
    const flatCur = flatten(cur);
    const allKeys = new Set([...Object.keys(flatOrig), ...Object.keys(flatCur)]);
    const changedKeys = [...allKeys].filter(k => String(flatOrig[k]) !== String(flatCur[k])).sort();
    if (changedKeys.length === 0) {
      lines.push('(no changes)');
    } else {
      changedKeys.forEach(k => {
        lines.push(k + ': ' + JSON.stringify(flatOrig[k]) + ' → ' + JSON.stringify(flatCur[k]));
      });
    }
    out.style.display = 'block';
    out.textContent = lines.join('\\n');
  });

  function flatten(obj, prefix) {
    prefix = prefix || '';
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (k.startsWith('_')) continue; // skip _doc fields
      const key = prefix ? (prefix + '.' + k) : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(out, flatten(v, key));
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  load();
})();
`;

const SPORTS_CONFIG_JS = /* javascript */ `
(() => {
  ${COMMON_JS_PRELUDE}
  async function load() {
    const res = await fetch('/admin/api/sports-config');
    const j = await res.json();
    if (!j.ok) return;
    const tbody = document.querySelector('#tbl tbody');
    tbody.innerHTML = j.items.map(s => {
      const enabled = !!s.enabled;
      const reason = s.disabled_reason || '';
      return '<tr data-id="' + esc(s.id) + '">' +
        '<td><code>' + esc(s.id) + '</code></td>' +
        '<td><input class="label" value="' + esc(s.label) + '" maxlength="40" /></td>' +
        '<td><input class="league" value="' + esc(s.league) + '" maxlength="20" style="width:80px;" /></td>' +
        '<td style="text-align:center;"><input class="enabled" type="checkbox" ' + (enabled ? 'checked' : '') + ' /></td>' +
        '<td><textarea class="reason" rows="1" placeholder="(only used when disabled)" style="width:100%;min-width:200px;">' + esc(reason) + '</textarea></td>' +
        '<td><button class="btn primary save">Save</button><div class="hint status"></div></td>' +
      '</tr>';
    }).join('');
    tbody.querySelectorAll('.save').forEach(b => b.addEventListener('click', save));
    // Toggle the reason cell's visual prominence based on enabled state.
    tbody.querySelectorAll('.enabled').forEach(cb => cb.addEventListener('change', syncRowState));
    tbody.querySelectorAll('tr').forEach(syncRowFromCheckbox);
  }
  function syncRowFromCheckbox(tr) {
    const cb = tr.querySelector('.enabled');
    if (!cb) return;
    tr.querySelector('.reason').style.opacity = cb.checked ? '0.4' : '1';
  }
  function syncRowState(ev) {
    syncRowFromCheckbox(ev.target.closest('tr'));
  }
  async function save(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const status = tr.querySelector('.status');
    const body = {
      label: tr.querySelector('.label').value.trim(),
      league: tr.querySelector('.league').value.trim(),
      enabled: tr.querySelector('.enabled').checked,
      disabled_reason: tr.querySelector('.reason').value.trim(),
    };
    const r = await saveJson('/admin/api/sports-config/' + encodeURIComponent(id), body);
    showStatus(status, r.ok, r.ok ? 'saved' : ((r.json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || 'error'));
  }
  load();
})();
`;
