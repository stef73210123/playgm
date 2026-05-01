/**
 * economicTargets.ts — static read-only lookup of beta validation targets.
 *
 * Sourced from:
 *   - docs/gdd/economic-system.md §10 (PP swing variables, progression gaps,
 *     H2H rewards, streak day-14 placement)
 *   - docs/gdd/card-system.md §12 (legendary drop rates, ability trigger
 *     window, legendary pity user-pct, per-player limit)
 *   - data/economy/pgm_subscriptions.json (tier prices)
 *   - data/cards/pgm_packs.json (legendary drop rates per pack)
 *   - data/cards/pgm_pity_timers.json (legendary pity threshold)
 *
 * Anything labelled `extrapolated` or `industry-standard` is NOT in the GDD
 * — surface flag so Stefan can replace with a real target.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, '..'),
    path.resolve(cwd, '..', '..'),
    path.resolve(cwd, '..', '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'cards', 'pgm_packs.json'))) return c;
  }
  return cwd;
}
const PROJECT_ROOT = findProjectRoot();

interface PackSpec {
  pack_id: string;
  pp_cost: number | null;
  drop_rates?: { legendary?: number };
}

function safeReadJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
}

export interface EconomicTargets {
  pp: {
    pro_pack_cost: { current: number; target_min: number; target_max: number; source: string };
  };
  progression: {
    all_star_to_mvp_gap: { current: number; soften_to_if_churn: number; source: string };
    h2h_loss_pp: { current: number; raise_to_if_churn: number; source: string };
  };
  cards: {
    legendary_drop_rates: {
      pro_pack: { current: number; source: string };
      all_star_pack: { current: number; source: string };
      mvp_pack: { current: number; source: string };
      goat_pack: { current: number; source: string };
    };
    ability_trigger_rate_window: { min: number; max: number; source: string };
    legendary_pity_user_pct_target: { max: number; source: string };
    per_player_limit: { current: number; alt: number; source: string };
  };
  streak: {
    day_14_all_star_pack: { current: string; alt: string; source: string };
  };
  business: {
    target_arpu_usd_monthly: { value: number; source: string; flag: 'extrapolated' };
    target_paid_conversion_pct: { value: number; source: string; flag: 'industry-standard' };
    target_d30_retention_pct: { value: number; source: string; flag: 'industry-standard' };
  };
  notes?: string[];
}

let cache: EconomicTargets | null = null;

export function getEconomicTargets(): EconomicTargets {
  if (cache) return cache;

  const notes: string[] = [];

  // Read pack specs to source legendary drop rates per pack.
  const packsRaw = safeReadJson<{ packs: PackSpec[] }>(
    path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_packs.json'),
  );
  const packs = packsRaw?.packs ?? [];
  function legendaryRate(packId: string): number {
    const p = packs.find((x) => x.pack_id === packId);
    return p?.drop_rates?.legendary ?? 0;
  }
  function packCost(packId: string): number | null {
    const p = packs.find((x) => x.pack_id === packId);
    return p?.pp_cost ?? null;
  }

  const proPackCost = packCost('pro_pack');
  if (proPackCost == null) notes.push('pro_pack pp_cost missing from pgm_packs.json');

  const targets: EconomicTargets = {
    pp: {
      pro_pack_cost: {
        current: proPackCost ?? 1000,
        target_min: Math.round((proPackCost ?? 1000) * 0.75),
        target_max: Math.round((proPackCost ?? 1000) * 1.25),
        source: 'GDD economic-system §10 — swing variable ±25%',
      },
    },
    progression: {
      all_star_to_mvp_gap: {
        current: 9000,
        soften_to_if_churn: 7500,
        source: 'GDD economic-system §10',
      },
      h2h_loss_pp: {
        current: 50,
        raise_to_if_churn: 75,
        source: 'GDD economic-system §10',
      },
    },
    cards: {
      legendary_drop_rates: {
        pro_pack: {
          current: legendaryRate('pro_pack'),
          source: 'GDD card-system §12 (also pgm_packs.json)',
        },
        all_star_pack: {
          current: legendaryRate('all_star_pack'),
          source: 'GDD card-system §12 (also pgm_packs.json)',
        },
        mvp_pack: {
          current: legendaryRate('mvp_pack'),
          source: 'GDD card-system §12 (also pgm_packs.json)',
        },
        goat_pack: {
          current: legendaryRate('goat_pack'),
          source: 'GDD card-system §12 (also pgm_packs.json)',
        },
      },
      ability_trigger_rate_window: {
        min: 0.30,
        max: 0.50,
        source: 'GDD card-system §12 — ability trigger rates ~30–50%',
      },
      legendary_pity_user_pct_target: {
        max: 0.05,
        source: 'GDD card-system §12 — legendary pity should affect <5% of users',
      },
      per_player_limit: {
        current: 2,
        alt: 3,
        source: 'GDD card-system §12 — open question (2 vs. 3)',
      },
    },
    streak: {
      day_14_all_star_pack: {
        current: 'All-Star Pack on Day 14',
        alt: 'All-Star Pack on Day 10',
        source: 'GDD economic-system §10',
      },
    },
    business: {
      target_arpu_usd_monthly: {
        value: 1.50,
        source: 'extrapolated from subscription mix (free / $1.99 / $4.99 / $9.99)',
        flag: 'extrapolated',
      },
      target_paid_conversion_pct: {
        value: 0.05,
        source: 'industry standard for kids freemium (5%)',
        flag: 'industry-standard',
      },
      target_d30_retention_pct: {
        value: 0.20,
        source: 'industry standard for engagement-heavy mobile games (20%)',
        flag: 'industry-standard',
      },
    },
    ...(notes.length ? { notes } : {}),
  };

  cache = targets;
  return targets;
}

/** Test hook. */
export function _resetEconomicTargetsCacheForTests(): void {
  cache = null;
}
