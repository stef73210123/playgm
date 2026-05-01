/**
 * Server mirror of `src/economy/cards.ts`. Used by packRoller, shards, and
 * triggerEvaluator to look up template / trigger / stat metadata.
 */

import {
  loadCardTemplatesSpec,
  loadTriggersSpec,
  loadStatResolutionSpec,
} from './loader.js';
import type {
  CardTemplate,
  CardTemplatesSpec,
  Rarity,
  ResolutionSport,
  ResolvedStats,
  StatResolutionSpec,
  TriggerSpec,
  TriggersSpec,
} from './types.js';

let cachedTemplates: CardTemplatesSpec | null = null;
let cachedTriggers: TriggersSpec | null = null;
let cachedResolution: StatResolutionSpec | null = null;

export function buildCardTemplates(raw: unknown): CardTemplatesSpec {
  const spec = raw as CardTemplatesSpec;
  if (!Array.isArray(spec.card_templates)) throw new Error('cards: templates missing');
  return spec;
}

export function buildTriggers(raw: unknown): TriggersSpec {
  const spec = raw as TriggersSpec;
  if (!Array.isArray(spec.triggers)) throw new Error('cards: triggers missing');
  return spec;
}

export function buildStatResolution(raw: unknown): StatResolutionSpec {
  const spec = raw as StatResolutionSpec;
  if (!spec.stat_resolution) throw new Error('cards: stat_resolution missing');
  return spec;
}

function getTemplates(): CardTemplatesSpec {
  if (!cachedTemplates) cachedTemplates = buildCardTemplates(loadCardTemplatesSpec());
  return cachedTemplates;
}
function getTriggers(): TriggersSpec {
  if (!cachedTriggers) cachedTriggers = buildTriggers(loadTriggersSpec());
  return cachedTriggers;
}
function getResolution(): StatResolutionSpec {
  if (!cachedResolution) cachedResolution = buildStatResolution(loadStatResolutionSpec());
  return cachedResolution;
}

export function getTemplate(id: string): CardTemplate | null {
  return getTemplates().card_templates.find((t) => t.template_id === id) ?? null;
}

export function listTemplatesByRarity(rarity: Rarity): CardTemplate[] {
  return getTemplates().card_templates.filter((t) => t.rarity === rarity);
}

export function listAllTemplates(): CardTemplate[] {
  return [...getTemplates().card_templates];
}

export function getTrigger(id: string): TriggerSpec | null {
  return getTriggers().triggers.find((t) => t.trigger_id === id) ?? null;
}

export function getStatResolution(
  sport: ResolutionSport,
  position: string,
): ResolvedStats {
  const root = getResolution().stat_resolution[sport];
  if (!root) throw new Error(`cards: unknown sport "${sport}" for stat resolution`);
  const byPos = root.by_position[position];
  return {
    primary: byPos?.primary ?? root.default_primary,
    secondary: byPos?.secondary ?? root.default_secondary,
    tertiary: byPos?.tertiary ?? root.default_tertiary,
    default_stats: root.default_stats,
    star_threshold: root.star_threshold,
  };
}

export function __setSpecsForTests(s: {
  templates?: CardTemplatesSpec | null;
  triggers?: TriggersSpec | null;
  resolution?: StatResolutionSpec | null;
}): void {
  if (s.templates !== undefined) cachedTemplates = s.templates;
  if (s.triggers !== undefined) cachedTriggers = s.triggers;
  if (s.resolution !== undefined) cachedResolution = s.resolution;
}
