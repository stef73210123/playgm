/**
 * Pack + pity-timer config loader for the server. Same schema as the
 * client's read-only view; the server's authoritative pack-roll lives in
 * `packRoller.ts`.
 */

import { loadPacksSpec, loadPityTimersSpec } from './loader.js';
import type { PackDef, PacksSpec, PityTimer, PityTimersSpec } from './types.js';

let cachedPacks: PacksSpec | null = null;
let cachedTimers: PityTimersSpec | null = null;

export function buildPacks(raw: unknown): PacksSpec {
  const spec = raw as PacksSpec;
  if (!Array.isArray(spec.packs)) throw new Error('packs: packs[] missing');
  return spec;
}

export function buildPityTimers(raw: unknown): PityTimersSpec {
  const spec = raw as PityTimersSpec;
  if (!Array.isArray(spec.pity_timers)) throw new Error('packs: pity_timers[] missing');
  return spec;
}

function getPacks(): PacksSpec {
  if (!cachedPacks) cachedPacks = buildPacks(loadPacksSpec());
  return cachedPacks;
}
function getTimers(): PityTimersSpec {
  if (!cachedTimers) cachedTimers = buildPityTimers(loadPityTimersSpec());
  return cachedTimers;
}

export function getPackDef(id: string): PackDef | null {
  return getPacks().packs.find((p) => p.pack_id === id) ?? null;
}

export function listPacks(): PackDef[] {
  return [...getPacks().packs];
}

export function listPityTimers(): PityTimer[] {
  return [...getTimers().pity_timers];
}

export function __setSpecsForTests(s: {
  packs?: PacksSpec | null;
  timers?: PityTimersSpec | null;
}): void {
  if (s.packs !== undefined) cachedPacks = s.packs;
  if (s.timers !== undefined) cachedTimers = s.timers;
}
