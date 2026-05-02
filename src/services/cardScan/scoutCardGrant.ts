/**
 * scoutCardGrant.ts — grant a PlayGM scout card from a card-scan match.
 *
 * Per docs/card-scan-ip-policy.md: when /cards/scan finds an athlete in
 * our roster, we grant a PlayGM-designed scout card. Rarity is decided
 * by the player's PlayGM overall_grade — NOT by the rarity of the
 * physical card scanned. The grade-to-rarity mapping lives in
 * `data/cards/scan_grade_to_rarity.json`.
 *
 * Duplicate handling follows Option B from the IP policy: if the user
 * already owns this player's scout card, we politely deny and grant a
 * 50 PP "stats refreshed" consolation. Cap is still consumed (the scan
 * happened).
 *
 * The grant write goes through the service-role Supabase client (bypasses
 * RLS) and uses an idempotent upsert so concurrent scans for the same
 * player can't double-write.
 */

import { supabase } from '../../db/client.js';
import { loadScanGradeRaritySpec } from '../../economy/loader.js';
import type { Grade } from '../ratings/computeRatings.js';
import type { Rarity } from '../cardScanLLM.js';
import type { IndexedPlayer } from './playerMatcher.js';

// ─── Spec ────────────────────────────────────────────────────────────────────

interface ScanRaritySpec {
  version: string;
  grade_to_rarity: Record<Grade, Rarity>;
  needs_more_games_threshold_grade: Grade;
  already_owned_pp_refresh: number;
}

let _spec: ScanRaritySpec | null = null;
function getSpec(): ScanRaritySpec {
  if (_spec) return _spec;
  _spec = loadScanGradeRaritySpec() as ScanRaritySpec;
  return _spec;
}

/** Test seam — drop the cached spec. */
export function _resetGrantSpecForTests(): void {
  _spec = null;
}

// ─── Grade → rarity mapping ─────────────────────────────────────────────────

const GRADE_RANK: Record<Grade, number> = {
  'A+': 13, 'A': 12, 'A-': 11,
  'B+': 10, 'B': 9,  'B-': 8,
  'C+': 7,  'C': 6,  'C-': 5,
  'D+': 4,  'D': 3,  'D-': 2,
  'F':  1,
};

export function rarityForGrade(grade: Grade): Rarity {
  return getSpec().grade_to_rarity[grade] ?? 'common';
}

export function needsMoreGamesBadge(grade: Grade): boolean {
  const threshold = getSpec().needs_more_games_threshold_grade;
  return GRADE_RANK[grade] <= GRADE_RANK[threshold];
}

// ─── Grant ───────────────────────────────────────────────────────────────────

export interface GrantInput {
  user_id: string;
  player: IndexedPlayer;
  /** PlayGM overall_grade for the player (looked up in player_ratings table). */
  grade: Grade;
}

export type GrantOutcome =
  | {
      kind: 'granted';
      template_id: string;
      player_id: string;
      rarity: Rarity;
      grade: Grade;
      needs_more_games: boolean;
    }
  | {
      kind: 'already_owned';
      player_id: string;
      pp_refresh: number;
    };

/**
 * Synthesize the scout card template_id for a (player, rarity) pair.
 * Format: `pgm_scout_{rarity}_{external_id_safe}` so the inventory is
 * uniquely keyed even when two scans grant the same player at different
 * grades (e.g. a mid-season grade change).
 */
function scoutTemplateId(player: IndexedPlayer, rarity: Rarity): string {
  const safe = player.external_id.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return `pgm_scout_${rarity}_${safe}`;
}

/**
 * Grant the scout card via card_inventory. If the user already owns this
 * player's scout card at any rarity, fall through to Option B (deny + PP
 * refresh) per the IP policy.
 *
 * This function is the authoritative place where the scan grant is
 * materialized. Wallet writes for the consolation PP go through a separate
 * pp_events ledger insert handled by the caller (route).
 */
export async function grantScoutCard(input: GrantInput): Promise<GrantOutcome> {
  const rarity = rarityForGrade(input.grade);
  const template_id = scoutTemplateId(input.player, rarity);
  const player_id = input.player.external_id;

  // Already-owned check: any inventory row for this user + player counts.
  // Rarity changes over time as the player's stats accrue, so we don't
  // re-grant just because rarity drifted up — that's a separate "promote"
  // surface we may add later.
  const { data: existing, error: lookupErr } = await supabase
    .from('card_inventory')
    .select('id')
    .eq('user_id', input.user_id)
    .eq('player_id', player_id)
    .ilike('template_id', 'pgm_scout_%')
    .limit(1);
  if (lookupErr) throw new Error(`scoutCardGrant lookup failed: ${lookupErr.message}`);

  if (existing && existing.length > 0) {
    return {
      kind: 'already_owned',
      player_id,
      pp_refresh: getSpec().already_owned_pp_refresh,
    };
  }

  // Idempotent upsert. Conflict on (user_id, template_id, player_id, art_variant)
  // means the user already had this exact (rarity, player) combo and we treat
  // it as already_owned even though the broader pgm_scout_% lookup missed.
  const { error: insErr } = await supabase
    .from('card_inventory')
    .upsert(
      {
        user_id: input.user_id,
        template_id,
        player_id,
        art_variant: 'default',
      },
      { onConflict: 'user_id,template_id,player_id,art_variant', ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`scoutCardGrant insert failed: ${insErr.message}`);

  return {
    kind: 'granted',
    template_id,
    player_id,
    rarity,
    grade: input.grade,
    needs_more_games: needsMoreGamesBadge(input.grade),
  };
}
