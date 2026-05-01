/**
 * economicMetrics.ts — live economic-system metrics for /admin/status.
 *
 * Aggregates PP flow, pack opens, card inventory, subscription mix, roster
 * activity, trivia/picks engagement, and retention from Supabase tables
 * (profiles, pp_events, play_packs, owned_scout_cards, scout_card_definitions,
 * subscriptions, rosters, h2h_matches, trivia_results, play_picks).
 *
 * Every aggregation degrades to { value: null, unmeasured: true, error } when
 * the underlying table is missing or the query fails — never throws — so a
 * single missing table never crashes the whole endpoint.
 *
 * Cached for 60s (heavier than the 25s cache used by dataCorpus / supabaseAdmin
 * because these queries pull row payloads, not just counts).
 */
import { supabase } from '../db/client.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 60_000;

// ─── Types ────────────────────────────────────────────────────────────────

export interface CountResult {
  value: number | null;
  unmeasured?: boolean;
  error?: string;
}

export interface DistributionResult {
  value: Record<string, number> | null;
  unmeasured?: boolean;
  error?: string;
}

export interface PpMetrics {
  total_earned_lifetime: CountResult;
  total_earned_24h: CountResult;
  total_earned_7d: CountResult;
  median_pp_per_user: CountResult;
  p90_pp_per_user: CountResult;
  avg_daily_earn_per_active_user: CountResult;
  distribution_by_tier: DistributionResult;
}

export interface PackMetrics {
  rookie_pack_opens_30d: CountResult;
  pro_pack_opens_30d: CountResult;
  all_star_pack_opens_30d: CountResult;
  mvp_pack_opens_30d: CountResult;
  goat_pack_opens_30d: CountResult;
  avg_packs_per_active_user_30d: CountResult;
  legendary_drop_rate_observed: {
    pro_pack: CountResult;
    all_star_pack: CountResult;
    mvp_pack: CountResult;
    goat_pack: CountResult;
  };
}

export interface CardMetrics {
  total_cards_in_circulation: CountResult;
  cards_by_rarity: DistributionResult;
  avg_cards_per_user: CountResult;
  pity_users_at_threshold: CountResult;
  legendary_pity_pct: CountResult;
}

export interface SubscriptionMetrics {
  by_tier: DistributionResult;
  paid_pct: CountResult;
  monthly_revenue_estimate_usd: CountResult;
  arpu_usd: CountResult;
  arppu_usd: CountResult;
  starter_to_playmaker_upgrade_30d: CountResult;
  playmaker_to_champion_upgrade_30d: CountResult;
}

export interface RosterMetrics {
  rosters_locked_24h: CountResult;
  rosters_with_legendary_24h: CountResult;
  avg_energy_used_per_roster: CountResult;
  h2h_matches_24h: CountResult;
  h2h_win_pp_total_24h: CountResult;
  h2h_loss_pp_total_24h: CountResult;
}

export interface TriviaPicksMetrics {
  trivia_questions_answered_24h: CountResult;
  trivia_correct_pct: CountResult;
  play_picks_made_24h: CountResult;
  play_picks_correct_pct: CountResult;
  streak_5_bonuses_24h: CountResult;
}

export interface RetentionMetrics {
  dau: CountResult;
  wau: CountResult;
  mau: CountResult;
  dau_mau_pct: CountResult;
  d1_retention_7d: CountResult;
  d7_retention: CountResult;
  d30_retention: CountResult;
}

export interface AskScoutMetrics {
  /** All Ask Scout calls in the last 24h. */
  calls_24h: CountResult;
  /** 24h calls bucketed by subscription tier. */
  calls_24h_by_tier: DistributionResult;
  /** % of 24h-calls that hit the per-tier daily cap, by tier. */
  cap_hit_rate_24h_by_tier: DistributionResult;
  /** Free-tier users who hit their cap today. Conversion-funnel KPI. */
  free_users_capped_today: CountResult;
  /** Estimated 24h Anthropic spend (Haiku 4.5 pricing × avg tokens). */
  estimated_anthropic_spend_24h_usd: CountResult;
  /** Spend / paid seats. Useful sanity-check for ARPPU vs LLM cost. */
  cost_per_paid_seat_24h_usd: CountResult;
}

export interface EconomicMetricsReport {
  pp: PpMetrics;
  packs: PackMetrics;
  cards: CardMetrics;
  subscriptions: SubscriptionMetrics;
  rosters: RosterMetrics;
  trivia_picks: TriviaPicksMetrics;
  retention: RetentionMetrics;
  ask_scout: AskScoutMetrics;
}

interface Cache<T> { value: T; expires_at: number }
let metricsCache: Cache<EconomicMetricsReport> | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────

function isoSinceHours(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function unmeasured(error: string): CountResult {
  return { value: null, unmeasured: true, error };
}

function unmeasuredDist(error: string): DistributionResult {
  return { value: null, unmeasured: true, error };
}

function isMissingTableError(msg: string | undefined): boolean {
  if (!msg) return false;
  return /does not exist|not found|schema cache|PGRST205|PGRST20[0-9]/i.test(msg);
}

/**
 * Sum a numeric column across rows matching an optional filter.
 * Supabase REST has no native SUM — we fetch the column values and reduce.
 * At the volumes we expect for an admin dashboard (tens of thousands of rows
 * at most for pp_events), this is acceptable. Returns `unmeasured` if the
 * table or column is missing.
 */
async function sumColumn(
  table: string,
  column: string,
  filter?: (q: ReturnType<typeof supabase.from>) => unknown,
): Promise<CountResult> {
  try {
    const builder = filter
      ? filter(supabase.from(table))
      : supabase.from(table).select(column);
    const { data, error } = (await builder) as {
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    };
    if (error) {
      const missing = isMissingTableError(error.message);
      return { value: null, unmeasured: missing, error: error.message };
    }
    if (!data) return unmeasured(`no rows returned from ${table}`);
    let total = 0;
    for (const row of data) {
      const v = row[column];
      if (typeof v === 'number') total += v;
    }
    return { value: total };
  } catch (err) {
    return unmeasured(err instanceof Error ? err.message : String(err));
  }
}

async function countRows(
  table: string,
  filter?: (q: ReturnType<typeof supabase.from>) => unknown,
): Promise<CountResult> {
  try {
    const builder = filter
      ? filter(supabase.from(table))
      : supabase.from(table).select('id', { count: 'exact', head: true });
    const { count, error, status } = (await builder) as {
      count: number | null;
      error: { message: string } | null;
      status?: number;
    };
    if (error) {
      const missing = isMissingTableError(error.message);
      return { value: null, unmeasured: missing, error: error.message };
    }
    if (count === null) {
      return {
        value: null,
        unmeasured: true,
        error:
          status === 204
            ? `table '${table}' missing from schema cache (HTTP 204)`
            : 'count not returned',
      };
    }
    return { value: count };
  } catch (err) {
    return unmeasured(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fetch a single numeric column as an array. Used for distribution math
 * (median, p90). Returns null + unmeasured on error.
 */
async function fetchColumn(
  table: string,
  column: string,
  filter?: (q: ReturnType<typeof supabase.from>) => unknown,
): Promise<{ value: number[] | null; unmeasured?: boolean; error?: string }> {
  try {
    const builder = filter
      ? filter(supabase.from(table))
      : supabase.from(table).select(column);
    const { data, error } = (await builder) as {
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    };
    if (error) {
      const missing = isMissingTableError(error.message);
      return { value: null, unmeasured: missing, error: error.message };
    }
    if (!data) return { value: null, unmeasured: true, error: `no rows from ${table}` };
    const out: number[] = [];
    for (const row of data) {
      const v = row[column];
      if (typeof v === 'number') out.push(v);
    }
    return { value: out };
  } catch (err) {
    return { value: null, unmeasured: true, error: err instanceof Error ? err.message : String(err) };
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const baseVal = sorted[base]!;
  const nextVal = sorted[base + 1];
  if (nextVal === undefined) return baseVal;
  return baseVal + rest * (nextVal - baseVal);
}

function pct(numerator: CountResult, denominator: CountResult): CountResult {
  if (denominator.unmeasured || denominator.value === null) {
    return { value: null, unmeasured: true, error: denominator.error ?? 'denominator unmeasured' };
  }
  if (denominator.value === 0) return { value: 0 };
  if (numerator.value === null) {
    return { value: null, unmeasured: true, error: numerator.error };
  }
  return { value: Math.round((numerator.value / denominator.value) * 1000) / 10 };
}

// ─── Subscription tier prices (from data/economy/pgm_subscriptions.json) ──

function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, '..'),
    path.resolve(cwd, '..', '..'),
    path.resolve(cwd, '..', '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'economy', 'pgm_subscriptions.json'))) return c;
  }
  return cwd;
}
const PROJECT_ROOT = findProjectRoot();

function loadSubscriptionPrices(): Record<string, number> {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, 'data', 'economy', 'pgm_subscriptions.json'), 'utf8'),
    ) as { tiers: Array<{ tier_id: string; monthly_price_usd: number }> };
    const out: Record<string, number> = {};
    for (const t of raw.tiers ?? []) out[t.tier_id] = t.monthly_price_usd;
    return out;
  } catch {
    return { free: 0, starter: 1.99, playmaker: 4.99, champion: 9.99 };
  }
}

// ─── Section builders ─────────────────────────────────────────────────────

async function buildPpMetrics(activeUserCount: number | null): Promise<PpMetrics> {
  const [lifetime, last24h, last7d, ppValuesRes, tierDist] = await Promise.all([
    sumColumn('pp_events', 'amount'),
    sumColumn('pp_events', 'amount', (q) =>
      q.select('amount').gte('created_at', isoSinceHours(24)),
    ),
    sumColumn('pp_events', 'amount', (q) =>
      q.select('amount').gte('created_at', isoSinceHours(24 * 7)),
    ),
    fetchColumn('profiles', 'pp'),
    (async (): Promise<DistributionResult> => {
      try {
        const tiers = [
          'Peewee', 'Travel', 'JV', 'Varsity', 'Semi-Pro', 'Pro', 'Starter',
          'All-Star', 'MVP', 'Champion', 'Hall of Famer', 'Legend', 'GOAT',
        ];
        const out: Record<string, number> = {};
        for (const t of tiers) {
          const { count, error } = await supabase
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('level_tier', t);
          if (error) {
            const missing = isMissingTableError(error.message);
            return { value: null, unmeasured: missing, error: error.message };
          }
          out[t] = count ?? 0;
        }
        return { value: out };
      } catch (err) {
        return unmeasuredDist(err instanceof Error ? err.message : String(err));
      }
    })(),
  ]);

  // Median + p90 from the fetched pp values.
  let median: CountResult;
  let p90: CountResult;
  if (ppValuesRes.value && ppValuesRes.value.length > 0) {
    const sorted = [...ppValuesRes.value].sort((a, b) => a - b);
    median = { value: Math.round(quantile(sorted, 0.5)) };
    p90 = { value: Math.round(quantile(sorted, 0.9)) };
  } else if (ppValuesRes.unmeasured) {
    median = unmeasured(ppValuesRes.error ?? 'profiles.pp unmeasured');
    p90 = unmeasured(ppValuesRes.error ?? 'profiles.pp unmeasured');
  } else {
    median = { value: 0 };
    p90 = { value: 0 };
  }

  // avg daily earn per active user — proxy: 24h_total / max(1, active_user_count).
  let avgDaily: CountResult;
  if (last24h.unmeasured || last24h.value === null) {
    avgDaily = unmeasured(last24h.error ?? '24h pp unmeasured');
  } else if (activeUserCount === null || activeUserCount === 0) {
    avgDaily = { value: last24h.value };
  } else {
    avgDaily = { value: Math.round((last24h.value / activeUserCount) * 10) / 10 };
  }

  return {
    total_earned_lifetime: lifetime,
    total_earned_24h: last24h,
    total_earned_7d: last7d,
    median_pp_per_user: median,
    p90_pp_per_user: p90,
    avg_daily_earn_per_active_user: avgDaily,
    distribution_by_tier: tierDist,
  };
}

async function buildPackMetrics(activeUserCount: number | null): Promise<PackMetrics> {
  // The DB pack_type enum (common/rare/epic/legendary/starter) does NOT match
  // the new 5-tier naming (rookie/pro/all_star/mvp/goat). Surface the new tiers
  // as `unmeasured` with an explanation until the schema migrates.
  const SCHEMA_NOTE =
    "play_packs.pack_type uses old enum (common/rare/epic/legendary/starter); new pack tier rookie/pro/all_star/mvp/goat not yet in schema";

  const [totalOpened30d] = await Promise.all([
    countRows('play_packs', (q) =>
      q
        .select('id', { count: 'exact', head: true })
        .not('opened_at', 'is', null)
        .gte('opened_at', isoSinceHours(24 * 30)),
    ),
  ]);

  const avgPacksPerActive: CountResult = (() => {
    if (totalOpened30d.unmeasured || totalOpened30d.value === null) {
      return unmeasured(totalOpened30d.error ?? 'pack opens unmeasured');
    }
    if (!activeUserCount) return { value: totalOpened30d.value };
    return { value: Math.round((totalOpened30d.value / activeUserCount) * 100) / 100 };
  })();

  return {
    rookie_pack_opens_30d: unmeasured(SCHEMA_NOTE),
    pro_pack_opens_30d: unmeasured(SCHEMA_NOTE),
    all_star_pack_opens_30d: unmeasured(SCHEMA_NOTE),
    mvp_pack_opens_30d: unmeasured(SCHEMA_NOTE),
    goat_pack_opens_30d: unmeasured(SCHEMA_NOTE),
    avg_packs_per_active_user_30d: avgPacksPerActive,
    legendary_drop_rate_observed: {
      pro_pack: unmeasured(SCHEMA_NOTE),
      all_star_pack: unmeasured(SCHEMA_NOTE),
      mvp_pack: unmeasured(SCHEMA_NOTE),
      goat_pack: unmeasured(SCHEMA_NOTE),
    },
  };
}

async function buildCardMetrics(userCount: number | null): Promise<CardMetrics> {
  const [total, byRarity, pityCount] = await Promise.all([
    countRows('owned_scout_cards'),
    // The scout_card_rarity enum has only 'common'/'rare'/'legendary' — the
    // 5-rarity GDD spec (common/uncommon/rare/epic/legendary) is NOT in the
    // schema yet, so uncommon + epic surface as 0 + a schema note.
    (async (): Promise<DistributionResult> => {
      try {
        // Two-step: build definition_id → rarity map, then tally.
        const defsRes = await supabase
          .from('scout_card_definitions')
          .select('id, rarity');
        if (defsRes.error) {
          const missing = isMissingTableError(defsRes.error.message);
          return { value: null, unmeasured: missing, error: defsRes.error.message };
        }
        const defMap = new Map<string, string>();
        for (const row of (defsRes.data ?? []) as Array<{ id: string; rarity: string }>) {
          defMap.set(row.id, row.rarity);
        }
        const ownedRes = await supabase
          .from('owned_scout_cards')
          .select('definition_id');
        if (ownedRes.error) {
          const missing = isMissingTableError(ownedRes.error.message);
          return { value: null, unmeasured: missing, error: ownedRes.error.message };
        }
        const out: Record<string, number> = {
          common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0,
        };
        for (const row of (ownedRes.data ?? []) as Array<{ definition_id: string }>) {
          const r = defMap.get(row.definition_id);
          if (r && r in out) out[r]! += 1;
        }
        return { value: out };
      } catch (err) {
        return unmeasuredDist(err instanceof Error ? err.message : String(err));
      }
    })(),
    // pity_state column doesn't exist on profiles in current schema.
    Promise.resolve(unmeasured('profiles.pity_state column not in schema yet')),
  ]);

  let avgPerUser: CountResult;
  if (total.unmeasured || total.value === null) {
    avgPerUser = unmeasured(total.error ?? 'card total unmeasured');
  } else if (!userCount) {
    avgPerUser = { value: total.value };
  } else {
    avgPerUser = { value: Math.round((total.value / userCount) * 100) / 100 };
  }

  let legendaryPityPct: CountResult;
  if (pityCount.unmeasured || pityCount.value === null) {
    legendaryPityPct = unmeasured(pityCount.error ?? 'pity unmeasured');
  } else if (!userCount) {
    legendaryPityPct = { value: 0 };
  } else {
    legendaryPityPct = { value: Math.round((pityCount.value / userCount) * 1000) / 10 };
  }

  return {
    total_cards_in_circulation: total,
    cards_by_rarity: byRarity,
    avg_cards_per_user: avgPerUser,
    pity_users_at_threshold: pityCount,
    legendary_pity_pct: legendaryPityPct,
  };
}

async function buildSubscriptionMetrics(userCount: number | null): Promise<SubscriptionMetrics> {
  const prices = loadSubscriptionPrices();
  const tiers = ['free', 'starter', 'playmaker', 'champion'] as const;
  const byTier = await (async (): Promise<DistributionResult> => {
    try {
      const out: Record<string, number> = {};
      for (const t of tiers) {
        const { count, error } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('subscription_tier', t);
        if (error) {
          const missing = isMissingTableError(error.message);
          return { value: null, unmeasured: missing, error: error.message };
        }
        out[t] = count ?? 0;
      }
      return { value: out };
    } catch (err) {
      return unmeasuredDist(err instanceof Error ? err.message : String(err));
    }
  })();

  let paidPct: CountResult;
  let revenueEstimate: CountResult;
  let arpu: CountResult;
  let arppu: CountResult;
  if (byTier.value && userCount) {
    const free = byTier.value['free'] ?? 0;
    const starter = byTier.value['starter'] ?? 0;
    const playmaker = byTier.value['playmaker'] ?? 0;
    const champion = byTier.value['champion'] ?? 0;
    const paid = starter + playmaker + champion;
    const total = free + paid;
    paidPct = { value: total === 0 ? 0 : Math.round((paid / total) * 1000) / 10 };
    const revenue =
      starter * (prices['starter'] ?? 0) +
      playmaker * (prices['playmaker'] ?? 0) +
      champion * (prices['champion'] ?? 0);
    revenueEstimate = { value: Math.round(revenue * 100) / 100 };
    arpu = { value: total === 0 ? 0 : Math.round((revenue / total) * 100) / 100 };
    arppu = { value: paid === 0 ? 0 : Math.round((revenue / paid) * 100) / 100 };
  } else {
    paidPct = unmeasured(byTier.error ?? 'subscription distribution unmeasured');
    revenueEstimate = unmeasured(byTier.error ?? 'subscription distribution unmeasured');
    arpu = unmeasured(byTier.error ?? 'subscription distribution unmeasured');
    arppu = unmeasured(byTier.error ?? 'subscription distribution unmeasured');
  }

  return {
    by_tier: byTier,
    paid_pct: paidPct,
    monthly_revenue_estimate_usd: revenueEstimate,
    arpu_usd: arpu,
    arppu_usd: arppu,
    starter_to_playmaker_upgrade_30d: unmeasured('no subscription_changes / upgrade_log table yet'),
    playmaker_to_champion_upgrade_30d: unmeasured('no subscription_changes / upgrade_log table yet'),
  };
}

async function buildRosterMetrics(): Promise<RosterMetrics> {
  const [rostersLocked24h, h2hMatches24h, h2hWinPp, h2hLossPp] = await Promise.all([
    countRows('rosters', (q) =>
      q
        .select('id', { count: 'exact', head: true })
        .eq('is_locked', true)
        .gte('updated_at', isoSinceHours(24)),
    ),
    countRows('h2h_matches', (q) =>
      q.select('id', { count: 'exact', head: true }).gte('created_at', isoSinceHours(24)),
    ),
    sumColumn('h2h_matches', 'pp_payout', (q) =>
      q
        .select('pp_payout')
        .gte('created_at', isoSinceHours(24))
        .not('winner_id', 'is', null),
    ),
    // Loss PP — 50 PP per non-winner side. Approximate from match count.
    (async (): Promise<CountResult> => {
      const { count, error } = await supabase
        .from('h2h_matches')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', isoSinceHours(24))
        .not('winner_id', 'is', null);
      if (error) {
        const missing = isMissingTableError(error.message);
        return { value: null, unmeasured: missing, error: error.message };
      }
      // GDD: H2H loss = 50 PP. Each resolved match has exactly one loser.
      return { value: (count ?? 0) * 50 };
    })(),
  ]);

  return {
    rosters_locked_24h: rostersLocked24h,
    rosters_with_legendary_24h: unmeasured('no card-rarity join on rosters yet'),
    avg_energy_used_per_roster: unmeasured('roster energy not summed yet'),
    h2h_matches_24h: h2hMatches24h,
    h2h_win_pp_total_24h: h2hWinPp,
    h2h_loss_pp_total_24h: h2hLossPp,
  };
}

async function buildTriviaPicksMetrics(): Promise<TriviaPicksMetrics> {
  const [triviaAnswered, triviaCorrect, picksMade, picksCorrect] = await Promise.all([
    countRows('trivia_results', (q) =>
      q.select('id', { count: 'exact', head: true }).gte('answered_at', isoSinceHours(24)),
    ),
    countRows('trivia_results', (q) =>
      q
        .select('id', { count: 'exact', head: true })
        .eq('is_correct', true)
        .gte('answered_at', isoSinceHours(24)),
    ),
    countRows('play_picks', (q) =>
      q.select('id', { count: 'exact', head: true }).gte('created_at', isoSinceHours(24)),
    ),
    countRows('play_picks', (q) =>
      q
        .select('id', { count: 'exact', head: true })
        .eq('is_correct', true)
        .gte('created_at', isoSinceHours(24)),
    ),
  ]);

  return {
    trivia_questions_answered_24h: triviaAnswered,
    trivia_correct_pct: pct(triviaCorrect, triviaAnswered),
    play_picks_made_24h: picksMade,
    play_picks_correct_pct: pct(picksCorrect, picksMade),
    streak_5_bonuses_24h: unmeasured(
      "pp_events.source enum doesn't include trivia_streak_bonus yet",
    ),
  };
}

async function buildRetentionMetrics(): Promise<RetentionMetrics> {
  // Without a sessions or last_active_at table/column, DAU/WAU/MAU + retention
  // can only be approximated from pp_events (any user with PP earnings in the
  // window is treated as active). That's a reasonable proxy for now.
  async function activeUsersSince(hours: number): Promise<CountResult> {
    try {
      const { data, error } = await supabase
        .from('pp_events')
        .select('user_id')
        .gte('created_at', isoSinceHours(hours));
      if (error) {
        const missing = isMissingTableError(error.message);
        return { value: null, unmeasured: missing, error: error.message };
      }
      const set = new Set<string>();
      for (const row of (data ?? []) as Array<{ user_id: string }>) {
        if (row.user_id) set.add(row.user_id);
      }
      return { value: set.size };
    } catch (err) {
      return unmeasured(err instanceof Error ? err.message : String(err));
    }
  }

  const [dau, wau, mau] = await Promise.all([
    activeUsersSince(24),
    activeUsersSince(24 * 7),
    activeUsersSince(24 * 30),
  ]);

  let dauMauPct: CountResult;
  if (mau.unmeasured || mau.value === null || dau.value === null) {
    dauMauPct = unmeasured('mau or dau unmeasured');
  } else if (mau.value === 0) {
    dauMauPct = { value: 0 };
  } else {
    dauMauPct = { value: Math.round((dau.value / mau.value) * 1000) / 10 };
  }

  return {
    dau,
    wau,
    mau,
    dau_mau_pct: dauMauPct,
    d1_retention_7d: unmeasured('no signup-cohort table yet'),
    d7_retention: unmeasured('no signup-cohort table yet'),
    d30_retention: unmeasured('no signup-cohort table yet'),
  };
}

// ─── Ask Scout block ──────────────────────────────────────────────────────
// Anthropic Haiku 4.5 published pricing (May 2026):
//   input  $0.0008 per 1K tokens
//   output $0.004  per 1K tokens
// Typical Ask Scout exchange (rough fixture from production traces):
//   ~600 input tokens (system prompt + question)
//   ~150 output tokens (Scout's answer; capped at max_tokens=220)
// Per-call cost ≈ (600/1000)*0.0008 + (150/1000)*0.004
//               ≈ 0.00048 + 0.00060 = $0.00108
// Constants are baked in for v1 — no runtime fetch, no per-call telemetry yet.
const HAIKU_INPUT_USD_PER_1K = 0.0008;
const HAIKU_OUTPUT_USD_PER_1K = 0.004;
const ASK_SCOUT_AVG_INPUT_TOKENS = 600;
const ASK_SCOUT_AVG_OUTPUT_TOKENS = 150;
const ASK_SCOUT_COST_PER_CALL_USD =
  (ASK_SCOUT_AVG_INPUT_TOKENS / 1000) * HAIKU_INPUT_USD_PER_1K +
  (ASK_SCOUT_AVG_OUTPUT_TOKENS / 1000) * HAIKU_OUTPUT_USD_PER_1K;

function loadAskScoutCapByTier(): Record<string, number> {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, 'data', 'economy', 'pgm_subscriptions.json'), 'utf8'),
    ) as { tiers: Array<{ tier_id: string; ask_scout_daily_cap?: number }> };
    const out: Record<string, number> = {};
    for (const t of raw.tiers ?? []) {
      out[t.tier_id] = typeof t.ask_scout_daily_cap === 'number' ? t.ask_scout_daily_cap : 0;
    }
    return out;
  } catch {
    return { free: 2, starter: 5, playmaker: 10, champion: 20 };
  }
}

async function buildAskScoutMetrics(
  paidUserCount: number | null,
): Promise<AskScoutMetrics> {
  const caps = loadAskScoutCapByTier();
  const since24h = isoSinceHours(24);
  const todayYmd = new Date().toISOString().slice(0, 10);

  // Pull (user_id, count) rows once, bucket client-side. RLS bypassed via
  // service-role client.
  const usageRes = await (async () => {
    try {
      const { data, error } = await supabase
        .from('ask_scout_usage')
        .select('user_id, count, last_request_at, ymd')
        .gte('last_request_at', since24h);
      if (error) {
        const missing = isMissingTableError(error.message);
        return { rows: null as null, error: error.message, unmeasured: missing };
      }
      return { rows: (data ?? []) as Array<{ user_id: string; count: number; ymd: string }> };
    } catch (err) {
      return {
        rows: null as null,
        error: err instanceof Error ? err.message : String(err),
        unmeasured: true,
      };
    }
  })();

  // If the usage table is missing or unreachable, surface the whole block
  // as unmeasured — but still report the deterministic cost-per-call constant
  // so the dashboard's cost panel renders something sensible.
  if (!usageRes.rows) {
    const note = usageRes.error ?? 'ask_scout_usage unmeasured';
    return {
      calls_24h: unmeasured(note),
      calls_24h_by_tier: unmeasuredDist(note),
      cap_hit_rate_24h_by_tier: unmeasuredDist(note),
      free_users_capped_today: unmeasured(note),
      estimated_anthropic_spend_24h_usd: unmeasured(note),
      cost_per_paid_seat_24h_usd: unmeasured(note),
    };
  }

  // Map user_id → tier (best-effort; no JOIN with profiles to keep this cheap).
  const userIds = Array.from(new Set(usageRes.rows.map((r) => r.user_id))).filter(Boolean);
  const tierByUser = new Map<string, string>();
  if (userIds.length > 0) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, subscription_tier')
        .in('id', userIds);
      if (!error && data) {
        for (const row of data as Array<{ id: string; subscription_tier: string }>) {
          tierByUser.set(row.id, row.subscription_tier ?? 'free');
        }
      }
    } catch {
      // Tier lookup is best-effort — fall back to 'free' below.
    }
  }

  // Bucket calls by tier. `count` in ask_scout_usage is the per-day cumulative
  // value, but rows touched in the last 24h represent the day's full activity
  // for the (user, ymd) pair, which is the right unit for "calls today".
  const callsByTier: Record<string, number> = { free: 0, starter: 0, playmaker: 0, champion: 0 };
  const cappedByTier: Record<string, number> = { free: 0, starter: 0, playmaker: 0, champion: 0 };
  const totalsByTier: Record<string, number> = { free: 0, starter: 0, playmaker: 0, champion: 0 };
  let totalCalls = 0;
  let freeCappedToday = 0;

  for (const row of usageRes.rows) {
    const tier = tierByUser.get(row.user_id) ?? 'free';
    const count = typeof row.count === 'number' ? row.count : 0;
    const cap = caps[tier] ?? 0;
    callsByTier[tier] = (callsByTier[tier] ?? 0) + count;
    totalsByTier[tier] = (totalsByTier[tier] ?? 0) + 1;
    if (cap > 0 && count >= cap) {
      cappedByTier[tier] = (cappedByTier[tier] ?? 0) + 1;
      if (tier === 'free' && row.ymd === todayYmd) freeCappedToday += 1;
    }
    totalCalls += count;
  }

  const capHitRate: Record<string, number> = {};
  for (const tier of ['free', 'starter', 'playmaker', 'champion']) {
    const total = totalsByTier[tier] ?? 0;
    capHitRate[tier] =
      total === 0 ? 0 : Math.round(((cappedByTier[tier] ?? 0) / total) * 1000) / 10;
  }

  const spendUsd = Math.round(totalCalls * ASK_SCOUT_COST_PER_CALL_USD * 10000) / 10000;
  let costPerPaidSeat: CountResult;
  if (paidUserCount && paidUserCount > 0) {
    costPerPaidSeat = { value: Math.round((spendUsd / paidUserCount) * 10000) / 10000 };
  } else {
    costPerPaidSeat = { value: spendUsd }; // degenerate: no paid users yet
  }

  return {
    calls_24h: { value: totalCalls },
    calls_24h_by_tier: { value: callsByTier },
    cap_hit_rate_24h_by_tier: { value: capHitRate },
    free_users_capped_today: { value: freeCappedToday },
    estimated_anthropic_spend_24h_usd: { value: spendUsd },
    cost_per_paid_seat_24h_usd: costPerPaidSeat,
  };
}

// ─── Main entry ───────────────────────────────────────────────────────────

export async function getEconomicMetrics(): Promise<EconomicMetricsReport> {
  if (metricsCache && metricsCache.expires_at > Date.now()) {
    return metricsCache.value;
  }

  // Anchor: fetch user count once for downstream divisions.
  const userCountRes = await countRows('profiles');
  const userCount = userCountRes.value;

  // Active-user proxy = DAU (PP earners in the last 24h).
  const dauRes = await (async (): Promise<CountResult> => {
    try {
      const { data, error } = await supabase
        .from('pp_events')
        .select('user_id')
        .gte('created_at', isoSinceHours(24));
      if (error) {
        const missing = isMissingTableError(error.message);
        return { value: null, unmeasured: missing, error: error.message };
      }
      const set = new Set<string>();
      for (const row of (data ?? []) as Array<{ user_id: string }>) {
        if (row.user_id) set.add(row.user_id);
      }
      return { value: set.size };
    } catch (err) {
      return unmeasured(err instanceof Error ? err.message : String(err));
    }
  })();
  const activeUserCount = dauRes.value;

  const [pp, packs, cards, subscriptions, rosters, triviaPicks, retention] = await Promise.all([
    buildPpMetrics(activeUserCount),
    buildPackMetrics(activeUserCount),
    buildCardMetrics(userCount),
    buildSubscriptionMetrics(userCount),
    buildRosterMetrics(),
    buildTriviaPicksMetrics(),
    buildRetentionMetrics(),
  ]);

  // Ask Scout LLM usage block. Sized off paid seats (excludes free) so
  // cost_per_paid_seat is a meaningful denominator — free users contribute
  // to spend but not to revenue.
  const subDist = subscriptions.by_tier?.value ?? null;
  const paidSeats = subDist
    ? (subDist['starter'] ?? 0) + (subDist['playmaker'] ?? 0) + (subDist['champion'] ?? 0)
    : null;
  const askScout = await buildAskScoutMetrics(paidSeats);

  const report: EconomicMetricsReport = {
    pp,
    packs,
    cards,
    subscriptions,
    rosters,
    trivia_picks: triviaPicks,
    retention,
    ask_scout: askScout,
  };

  metricsCache = { value: report, expires_at: Date.now() + CACHE_TTL_MS };
  return report;
}

/** Test hook. */
export function _resetEconomicMetricsCacheForTests(): void {
  metricsCache = null;
}

// Exported for tests — pure helpers that don't touch Supabase.
export const _internalsForTests = {
  quantile,
  pct,
  isMissingTableError,
};
