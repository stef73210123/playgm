/**
 * supabaseAdmin.ts — count queries for the /admin/status dashboard.
 *
 * Every query is `head:true, count:'exact'` so we get the row count in the
 * response headers without paying for the row payload. Errors return
 * { value: null, unmeasured: true, error } — never throw — so a single
 * missing table doesn't crash the whole status endpoint.
 *
 * Counts are cached for 25s to match the dashboard's 30s polling cadence.
 */
import { supabase } from '../db/client.js';

const CACHE_TTL_MS = 25_000;

export interface CountResult {
  value: number | null;
  unmeasured?: boolean;
  error?: string;
}

export interface UsersAndSessionsReport {
  user_count: CountResult;
  active_sessions_24h: CountResult;
  users_signed_up_today: CountResult;
  users_signed_up_7d: CountResult;
  users_signed_up_30d: CountResult;
  subscriptions_by_tier: Record<string, number> | null;
  subscriptions_by_tier_unmeasured?: { error: string };
}

export interface GameplayCountersReport {
  rosters_created: CountResult;
  cards_owned: CountResult;
  trivia_questions_answered: CountResult;
  trivia_correct_pct: CountResult;
  play_picks_made: CountResult;
  play_picks_correct_pct: CountResult;
  packs_opened: CountResult;
  card_scans_attempted: CountResult;
  card_scans_matched: CountResult;
}

interface Cache<T> { value: T; expires_at: number }

let usersCache: Cache<UsersAndSessionsReport> | null = null;
let gameplayCache: Cache<GameplayCountersReport> | null = null;
let scoutVoiceCache: Cache<{ count: number | null; latest: string | null }> | null = null;

// Supabase query builders are thenables but not real Promises — they get
// awaited as-is. We type the filter callback's return as `unknown` and let
// `await` coerce.
type CountResp = {
  count: number | null;
  error: { message: string } | null;
  status?: number;
};

async function countRows(
  table: string,
  filter?: (q: ReturnType<typeof supabase.from>) => unknown,
): Promise<CountResult> {
  try {
    const builder = filter
      ? filter(supabase.from(table))
      : supabase.from(table).select('id', { count: 'exact', head: true });
    const { count, error, status } = (await builder) as CountResp;
    if (error) {
      const msg = error.message ?? String(error);
      // Postgres "relation does not exist" / PGRST205 → mark unmeasured.
      const missing = /does not exist|not found|schema cache|PGRST205/i.test(msg);
      return { value: null, unmeasured: missing, error: msg };
    }
    // Supabase REST returns HTTP 204 (No Content) with count:null for tables
    // that aren't in the schema cache — error is silently absent. Treat that
    // as "unmeasured" so missing tables show up in the punch list rather than
    // as a deceptive zero.
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
    return {
      value: null,
      unmeasured: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isoSinceHours(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export async function getUsersAndSessions(): Promise<UsersAndSessionsReport> {
  if (usersCache && usersCache.expires_at > Date.now()) return usersCache.value;

  const [userCount, today, last7d, last30d, subs] = await Promise.all([
    countRows('profiles'),
    countRows('profiles', (q) =>
      q
        .select('id', { count: 'exact', head: true })
        .gte('created_at', isoSinceHours(24)),
    ),
    countRows('profiles', (q) =>
      q
        .select('id', { count: 'exact', head: true })
        .gte('created_at', isoSinceHours(24 * 7)),
    ),
    countRows('profiles', (q) =>
      q
        .select('id', { count: 'exact', head: true })
        .gte('created_at', isoSinceHours(24 * 30)),
    ),
    // Tier breakdown — group via separate count queries so a missing column
    // doesn't tank everything.
    (async () => {
      try {
        const tiers = ['free', 'starter', 'playmaker', 'champion'] as const;
        const out: Record<string, number> = {};
        for (const tier of tiers) {
          const { count, error } = await supabase
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('subscription_tier', tier);
          if (error) {
            return { ok: false as const, error: error.message };
          }
          out[tier] = count ?? 0;
        }
        return { ok: true as const, value: out };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })(),
  ]);

  const report: UsersAndSessionsReport = {
    user_count: userCount,
    // No sessions table yet — track in punch list.
    active_sessions_24h: { value: null, unmeasured: true, error: 'no sessions table' },
    users_signed_up_today: today,
    users_signed_up_7d: last7d,
    users_signed_up_30d: last30d,
    subscriptions_by_tier: subs.ok ? subs.value : null,
    ...(subs.ok ? {} : { subscriptions_by_tier_unmeasured: { error: subs.error } }),
  };

  usersCache = { value: report, expires_at: Date.now() + CACHE_TTL_MS };
  return report;
}

export async function getGameplayCounters(): Promise<GameplayCountersReport> {
  if (gameplayCache && gameplayCache.expires_at > Date.now()) return gameplayCache.value;

  const [
    rosters,
    cardsOwned,
    triviaAnswered,
    triviaCorrect,
    playPicks,
    playPicksCorrect,
    packsOpened,
    cardScans,
    cardScansMatched,
  ] = await Promise.all([
    countRows('rosters'),
    countRows('owned_scout_cards'),
    countRows('trivia_results'),
    countRows('trivia_results', (q) =>
      q.select('id', { count: 'exact', head: true }).eq('is_correct', true),
    ),
    countRows('play_picks'),
    countRows('play_picks', (q) =>
      q.select('id', { count: 'exact', head: true }).eq('is_correct', true),
    ),
    // play_packs.opened_at is non-null when the pack has been opened.
    countRows('play_packs', (q) =>
      q.select('id', { count: 'exact', head: true }).not('opened_at', 'is', null),
    ),
    countRows('card_scans'),
    countRows('card_scans', (q) =>
      q.select('id', { count: 'exact', head: true }).not('matched_template_id', 'is', null),
    ),
  ]);

  // Derive the two pct fields. If the underlying table is unmeasured, propagate.
  function pct(numerator: CountResult, denominator: CountResult): CountResult {
    if (denominator.unmeasured || denominator.value === null) {
      return { value: null, unmeasured: true, error: denominator.error ?? 'denominator unmeasured' };
    }
    if (denominator.value === 0) return { value: 0 };
    if (numerator.value === null) return { value: null, unmeasured: true, error: numerator.error };
    return { value: Math.round((numerator.value / denominator.value) * 1000) / 10 };
  }

  const report: GameplayCountersReport = {
    rosters_created: rosters,
    cards_owned: cardsOwned,
    trivia_questions_answered: triviaAnswered,
    trivia_correct_pct: pct(triviaCorrect, triviaAnswered),
    play_picks_made: playPicks,
    play_picks_correct_pct: pct(playPicksCorrect, playPicks),
    packs_opened: packsOpened,
    card_scans_attempted: cardScans,
    card_scans_matched: cardScansMatched,
  };

  gameplayCache = { value: report, expires_at: Date.now() + CACHE_TTL_MS };
  return report;
}

/** Best-effort scout voice line count + latest timestamp (table may not exist yet). */
export async function getScoutVoiceStats(): Promise<{ count: number | null; latest: string | null }> {
  if (scoutVoiceCache && scoutVoiceCache.expires_at > Date.now()) return scoutVoiceCache.value;

  // Try a few plausible table names — none may exist yet.
  const candidates = ['scout_voice_lines', 'scout_takes', 'scout_voice_db'];
  let count: number | null = null;
  let latest: string | null = null;
  for (const t of candidates) {
    try {
      const { count: c, error } = await supabase
        .from(t)
        .select('id', { count: 'exact', head: true });
      if (!error && c !== null) {
        count = c;
        // Fetch latest created_at if column exists; ignore failure.
        const { data } = await supabase
          .from(t)
          .select('created_at')
          .order('created_at', { ascending: false })
          .limit(1);
        if (data && data[0]?.created_at) latest = String(data[0].created_at);
        break;
      }
    } catch {
      /* try next */
    }
  }

  const value = { count, latest };
  scoutVoiceCache = { value, expires_at: Date.now() + CACHE_TTL_MS };
  return value;
}

export function _resetSupabaseAdminCacheForTests(): void {
  usersCache = null;
  gameplayCache = null;
  scoutVoiceCache = null;
}
