/**
 * Server mirror of `src/economy/progression.ts`.
 *
 * Same API surface, different loader path. Server-side this is what the
 * PP-grant pipeline reads to figure out tier-up payouts and contest gates.
 */

import { loadProgressionSpec } from './loader.js';
import type { ContestType, ProgressionSpec, Tier } from './types.js';

let cachedSpec: ProgressionSpec | null = null;

export function buildProgression(raw: unknown): ProgressionSpec {
  const spec = raw as ProgressionSpec;
  if (!Array.isArray(spec.tiers) || spec.tiers.length === 0) {
    throw new Error('progression: tiers[] missing or empty');
  }
  if (typeof spec.tier_up_bonus_pp !== 'number') {
    throw new Error('progression: tier_up_bonus_pp missing');
  }
  return spec;
}

function getSpec(): ProgressionSpec {
  if (!cachedSpec) cachedSpec = buildProgression(loadProgressionSpec());
  return cachedSpec;
}

export function listTiers(): Tier[] {
  return [...getSpec().tiers];
}

export function getTierForPP(pp: number): {
  tierIndex: number;
  level: number;
  tierName: string;
  color: string;
  ppInTier: number;
  ppForNextTier: number;
} {
  const tiers = getSpec().tiers;
  let idx = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t && pp >= t.pp_threshold) idx = i;
    else break;
  }
  const cur = tiers[idx];
  const next = tiers[Math.min(idx + 1, tiers.length - 1)];
  if (!cur || !next) throw new Error('progression: tier list inconsistent');
  const isLast = idx === tiers.length - 1;
  return {
    tierIndex: idx,
    level: cur.level,
    tierName: cur.name,
    color: cur.color,
    ppInTier: pp - cur.pp_threshold,
    ppForNextTier: isLast ? 1 : next.pp_threshold - cur.pp_threshold,
  };
}

export function getTierUpBonus(): number {
  return getSpec().tier_up_bonus_pp;
}

export function contestGate(contestType: ContestType): number {
  return getSpec().contest_gating[contestType] ?? Number.NEGATIVE_INFINITY;
}

export function __setSpecForTests(spec: ProgressionSpec | null): void {
  cachedSpec = spec;
}
