/**
 * highlightsCoverage.ts — counts of players + teams that have a
 * `meta_json.video_highlight_url` populated, per league. Surfaced on the
 * admin dashboard "Highlights" card.
 *
 * Implementation: two count queries per league (covered + total) using
 * Supabase's `head:true, count:'exact'` pattern (no row payloads).
 * Every probe is wrapped so a single league failure → that league's
 * coverage shows "unmeasured", not the whole card.
 */
import { supabase } from '../db/client.js';
import { getHighlightsPipelineStatus } from '../jobs/refreshStats.js';
import { getQuotaSnapshot, isEmbeddabilityEnabled, type QuotaSnapshot } from './youtube/embeddability.js';

export interface CoverageRow {
  league: string;
  category: string;
  /** Players with meta_json.video_highlight_url set. */
  players_with: number | null;
  players_total: number | null;
  teams_with: number | null;
  teams_total: number | null;
  /** Most recent meta_json.video_highlight_pulled_at across this league. */
  last_pulled_at: string | null;
  /** Average length of meta_json.highlight_playlist across this league's
   *  records, 0..5. Lower than 5 means embeddability filter bites. */
  avg_playlist_length_players: number | null;
  avg_playlist_length_teams: number | null;
  /** Set when a query failed — coverage_pct is null in that case. */
  unmeasured?: boolean;
}

const LEAGUES: Array<{ league: string; category: string }> = [
  { league: 'NBA', category: 'basketball' },
  { league: 'NFL', category: 'football' },
  { league: 'MLB', category: 'baseball' },
  { league: 'NHL', category: 'hockey' },
  { league: 'MLS', category: 'soccer' },
];

async function safeCount(
  table: 'players' | 'teams',
  category: string,
  withHighlight: boolean,
): Promise<number | null> {
  try {
    let qb = supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('category', category);
    if (withHighlight) {
      qb = qb.not('meta_json->>video_highlight_url', 'is', null);
    }
    const res = await qb;
    return (res as { count: number | null }).count ?? null;
  } catch {
    return null;
  }
}

/**
 * Average length of meta_json.highlight_playlist across rows in a category.
 * Implementation: pull only rows that have the field set, sum lengths,
 * divide by row count. Rows without a playlist field are excluded so
 * the average reflects "what we resolved" rather than "what we tried".
 */
async function safeAvgPlaylistLength(
  table: 'players' | 'teams',
  category: string,
): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from(table)
      .select('meta_json')
      .eq('category', category)
      .not('meta_json->highlight_playlist', 'is', null)
      .limit(2000);
    if (error || !data) return null;
    const rows = data as Array<{ meta_json?: { highlight_playlist?: unknown[] } }>;
    if (rows.length === 0) return null;
    let totalLen = 0;
    let counted = 0;
    for (const r of rows) {
      const pl = r.meta_json?.highlight_playlist;
      if (Array.isArray(pl)) {
        totalLen += pl.length;
        counted++;
      }
    }
    if (counted === 0) return null;
    return Math.round((totalLen / counted) * 100) / 100;
  } catch {
    return null;
  }
}

async function safeMostRecentPull(category: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('teams')
      .select('meta_json')
      .eq('category', category)
      .not('meta_json->>video_highlight_pulled_at', 'is', null)
      .order('meta_json->>video_highlight_pulled_at', { ascending: false })
      .limit(1);
    const t = (data as Array<{ meta_json?: { video_highlight_pulled_at?: string } }> | null)?.[0];
    return t?.meta_json?.video_highlight_pulled_at ?? null;
  } catch {
    return null;
  }
}

export interface HighlightsCoverageReport {
  generated_at: string;
  pipeline: {
    last_run_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    last_summary: string | null;
  };
  totals: {
    players_with: number;
    players_total: number;
    teams_with: number;
    teams_total: number;
    players_pct: number; // 0-1
    teams_pct: number;   // 0-1
    /** League-wide average playlist length, computed across all rows
     *  that have a highlight_playlist field. 0..5. */
    avg_playlist_length: number;
  };
  /** Embeddability filter health — derived from the YouTube Data API v3
   *  call shape. */
  embeddability: {
    /** True when YOUTUBE_API_KEY is set; false means the resolver is
     *  in degraded "trust everything" mode. */
    enabled: boolean;
    /** % of TheSportsDB candidate clips that pass the embeddable check
     *  on average. Sourced from the most recent pull-highlights run. */
    hit_rate: number | null;
    quota: QuotaSnapshot;
  };
  by_league: CoverageRow[];
}

export async function getHighlightsCoverage(): Promise<HighlightsCoverageReport> {
  const rows: CoverageRow[] = [];
  for (const { league, category } of LEAGUES) {
    const [pw, pt, tw, tt, lastAt, avgPP, avgPT] = await Promise.all([
      safeCount('players', category, true),
      safeCount('players', category, false),
      safeCount('teams', category, true),
      safeCount('teams', category, false),
      safeMostRecentPull(category),
      safeAvgPlaylistLength('players', category),
      safeAvgPlaylistLength('teams', category),
    ]);
    const unmeasured = pw == null || pt == null || tw == null || tt == null;
    rows.push({
      league,
      category,
      players_with: pw,
      players_total: pt,
      teams_with: tw,
      teams_total: tt,
      last_pulled_at: lastAt,
      avg_playlist_length_players: avgPP,
      avg_playlist_length_teams: avgPT,
      ...(unmeasured ? { unmeasured: true } : {}),
    });
  }

  const sum = (k: 'players_with' | 'players_total' | 'teams_with' | 'teams_total'): number =>
    rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const players_with = sum('players_with');
  const players_total = sum('players_total');
  const teams_with = sum('teams_with');
  const teams_total = sum('teams_total');

  // Avg playlist length across all leagues — weight by row count when
  // available, fall back to simple mean of league-level numbers.
  const allLengths: number[] = [];
  for (const r of rows) {
    if (typeof r.avg_playlist_length_players === 'number') allLengths.push(r.avg_playlist_length_players);
    if (typeof r.avg_playlist_length_teams === 'number') allLengths.push(r.avg_playlist_length_teams);
  }
  const avg_playlist_length = allLengths.length > 0
    ? allLengths.reduce((a, b) => a + b, 0) / allLengths.length
    : 0;

  // Embeddability hit rate — parsed out of the last pipeline summary line
  // when the cron has produced one. Format from pull-highlights.ts:
  // "[NBA] embeddability hit rate: 42/60 = 70%"
  const pipeline = getHighlightsPipelineStatus();
  let hitRate: number | null = null;
  if (pipeline.lastSummary) {
    const m = pipeline.lastSummary.match(/embeddability hit rate: (\d+)\/(\d+) = (\d+)%/);
    if (m) {
      const pct = parseInt(m[3], 10);
      if (!Number.isNaN(pct)) hitRate = pct / 100;
    }
  }

  return {
    generated_at: new Date().toISOString(),
    pipeline: {
      last_run_at: pipeline.lastRunAt,
      last_success_at: pipeline.lastSuccessAt,
      last_error: pipeline.lastError,
      last_summary: pipeline.lastSummary,
    },
    totals: {
      players_with,
      players_total,
      teams_with,
      teams_total,
      players_pct: players_total > 0 ? players_with / players_total : 0,
      teams_pct: teams_total > 0 ? teams_with / teams_total : 0,
      avg_playlist_length: Math.round(avg_playlist_length * 100) / 100,
    },
    embeddability: {
      enabled: isEmbeddabilityEnabled(),
      hit_rate: hitRate,
      quota: getQuotaSnapshot(),
    },
    by_league: rows,
  };
}
