/**
 * allTimeGreatsHighlights.ts — backfill YouTube career-highlight video ids
 * onto each entry of `data/teams/all_time_greats_full.json`.
 *
 * Why a separate module from highlightsCron.ts?
 *   - The existing player-highlights cron sources from TheSportsDB
 *     (`searchPlayersByName` → `lookupPlayer.strYoutube`). All-time greats
 *     are mostly retired players whose strYoutube field is sparse — almost
 *     none have idPlayer hits in SportsDB. We need to go straight to
 *     YouTube Data API v3 search.list with the player's name + league.
 *   - The output shape is also different: highlightsCron writes a list of
 *     up to 10 game-clip videos per active player; here we want exactly
 *     ONE career-summary video per legend, persisted right onto the
 *     greats JSON so the client doesn't need a separate manifest.
 *
 * Source: YouTube Data API v3 search.list
 *   - q = `${player.name} ${LEAGUE} highlights career`
 *   - type=video, videoEmbeddable=true, maxResults=3
 *   - Take the first candidate; fall through to #2 / #3 if the first
 *     fails the embeddability re-check (videos.list?part=status).
 *
 * Quota math:
 *   - search.list = 100 units. videos.list = 1 unit per batch.
 *   - 10,000-unit daily budget → ~100 searches/day at the cap.
 *   - Default --limit is 80 to leave headroom for the existing
 *     embeddability checks the player-highlights cron makes.
 *   - 2,543 entries / 80 per day ≈ 32 days for a full pass; the existing
 *     daily cron (highlightsCron.ts) also calls this module so the
 *     backfill runs continuously without re-prompting.
 *
 * Failure handling: every external call is wrapped in try/catch; the
 * module never throws. Players whose first ~3 candidates all fail
 * embeddability are left untouched and re-tried on a subsequent run.
 *
 * Storage: in-place mutation of `data/teams/all_time_greats_full.json`.
 *   - Adds `highlight_video_id` (string) to populated entries.
 *   - Bumps a top-level `_highlights_generated_at` timestamp.
 *
 * CLI:
 *   npx tsx --import ./src/env-loader.ts src/jobs/allTimeGreatsHighlights.ts --limit 80
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { checkEmbeddability } from '../services/youtube/embeddability.js';

// ─── Tunables ───────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 80;
const SEARCH_CANDIDATES = 3;
/** Polite delay between YouTube API roundtrips. */
const YT_DELAY_MS = 150;

// Search-time region & language hint. Most career-highlight reels are
// English-language; biasing the result helps for players whose name
// matches a non-sports YouTuber abroad.
const REGION_CODE = 'US';
const RELEVANCE_LANGUAGE = 'en';

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

const LEAGUE_LABEL: Record<string, string> = {
  nba: 'NBA',
  nfl: 'NFL',
  mlb: 'MLB',
  nhl: 'NHL',
  mls: 'MLS',
};

// ─── Path resolution ────────────────────────────────────────────────────────
//
// This runs from server/ (cwd) under both tsx (dev) and node dist/ (prod).
// The data file lives at repo-root/data/teams/. Same heuristic the existing
// cron uses for assets/, but pointed at data/.

function repoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'data', 'teams', 'all_time_greats_full.json'))) return cwd;
  return path.resolve(cwd, '..');
}

function dataFilePath(): string {
  return path.join(repoRoot(), 'data', 'teams', 'all_time_greats_full.json');
}

// ─── JSON shape ─────────────────────────────────────────────────────────────

interface AllTimeGreatV2 {
  name: string;
  position: string;
  era: string;
  key_stat: string;
  jersey_number?: number | null;
  highlight_video_id?: string | null;
}

interface AllTimeGreatsFileV2 {
  version: string;
  schema_version: number;
  _doc?: string;
  _status?: string;
  _highlights_generated_at?: string;
  _todo_batch_plan?: string[];
  teams: Array<{
    teamId: string;
    league: string;
    players: AllTimeGreatV2[];
  }>;
  // Tolerate any other root-level keys.
  [k: string]: unknown;
}

async function readDataFile(): Promise<AllTimeGreatsFileV2> {
  const raw = await readFile(dataFilePath(), 'utf8');
  return JSON.parse(raw) as AllTimeGreatsFileV2;
}

async function writeDataFile(file: AllTimeGreatsFileV2): Promise<void> {
  file._highlights_generated_at = new Date().toISOString();
  // Keep trailing newline + 2-space indent to match the existing file.
  await writeFile(dataFilePath(), JSON.stringify(file, null, 2) + '\n', 'utf8');
}

// ─── YouTube search ─────────────────────────────────────────────────────────

interface SearchHit {
  videoId: string;
  title: string;
  publishedAt: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ytApiKey(): string | undefined {
  return process.env['YOUTUBE_API_KEY'];
}

let warnedMissingKey = false;
function warnMissingKey(): void {
  if (warnedMissingKey) return;
  warnedMissingKey = true;
  console.warn(
    '[allTimeGreatsHighlights] YOUTUBE_API_KEY not set — skipping. ' +
      'Set it in server/.env to enable the backfill.',
  );
}

interface SearchListResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: { title?: string; publishedAt?: string };
  }>;
}

/**
 * One search.list call. Returns up to `SEARCH_CANDIDATES` hits, embeddable
 * filter applied client-side via videos.list?part=status (the
 * `videoEmbeddable=true` query param is advisory and YouTube still
 * occasionally returns clips the owner has since toggled off).
 */
async function searchYouTube(playerName: string, league: string): Promise<SearchHit[]> {
  const key = ytApiKey();
  if (!key) {
    warnMissingKey();
    return [];
  }
  const leagueLabel = LEAGUE_LABEL[league] ?? league.toUpperCase();
  const q = `${playerName} ${leagueLabel} highlights career`;
  const params = new URLSearchParams({
    part: 'snippet',
    q,
    type: 'video',
    videoEmbeddable: 'true',
    maxResults: String(SEARCH_CANDIDATES),
    regionCode: REGION_CODE,
    relevanceLanguage: RELEVANCE_LANGUAGE,
    safeSearch: 'none',
    key,
  });
  let res: Response;
  try {
    res = await fetch(`${YT_SEARCH_URL}?${params}`);
  } catch (err) {
    console.warn(`[allTimeGreatsHighlights] network error for "${playerName}": ${(err as Error).message}`);
    return [];
  }
  if (res.status === 403 || res.status === 429) {
    console.warn(`[allTimeGreatsHighlights] rate-limited (HTTP ${res.status}) — stopping early`);
    throw new Error('youtube_quota_exceeded');
  }
  if (!res.ok) {
    console.warn(`[allTimeGreatsHighlights] HTTP ${res.status} for "${playerName}"`);
    return [];
  }
  let data: SearchListResponse;
  try {
    data = (await res.json()) as SearchListResponse;
  } catch {
    return [];
  }
  const out: SearchHit[] = [];
  for (const item of data.items ?? []) {
    const id = item.id?.videoId;
    if (!id) continue;
    out.push({
      videoId: id,
      title: item.snippet?.title ?? '',
      publishedAt: item.snippet?.publishedAt ?? null,
    });
  }
  return out;
}

// ─── Per-player resolver ────────────────────────────────────────────────────

interface ResolveResult {
  videoId: string | null;
  reason: 'ok' | 'no_search_hits' | 'no_embeddable' | 'skipped_no_key' | 'error';
}

async function resolveOne(playerName: string, league: string): Promise<ResolveResult> {
  let hits: SearchHit[];
  try {
    hits = await searchYouTube(playerName, league);
  } catch (err) {
    if ((err as Error).message === 'youtube_quota_exceeded') throw err;
    return { videoId: null, reason: 'error' };
  }
  if (hits.length === 0) {
    return { videoId: null, reason: ytApiKey() ? 'no_search_hits' : 'skipped_no_key' };
  }
  // Re-verify embeddability — videoEmbeddable=true on search is best-effort
  // and the actual flag can lag.
  const status = await checkEmbeddability(hits.map((h) => h.videoId));
  for (const h of hits) {
    const s = status.get(h.videoId);
    if (s?.embeddable) return { videoId: h.videoId, reason: 'ok' };
  }
  return { videoId: null, reason: 'no_embeddable' };
}

// ─── Main worker ────────────────────────────────────────────────────────────

export interface BackfillSummary {
  scanned: number;
  populated: number;
  no_hits: number;
  no_embeddable: number;
  errors: number;
  remaining_unfilled: number;
  total_entries: number;
  total_with_id: number;
}

interface BackfillOpts {
  /** Hard cap on YouTube searches this run. */
  limit?: number;
  /** Optional logger from a Fastify cron context. */
  log?: FastifyBaseLogger;
}

/**
 * Walk the JSON in team-then-player order and resolve a YouTube video
 * id for the first `limit` entries that don't have one. Persists once
 * at the end (or on early exit).
 */
export async function backfillAllTimeGreatsHighlights(
  opts: BackfillOpts = {},
): Promise<BackfillSummary> {
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const log = opts.log;

  const file = await readDataFile();
  const teams = Array.isArray(file.teams) ? file.teams : [];

  let scanned = 0;
  let populated = 0;
  let no_hits = 0;
  let no_embeddable = 0;
  let errors = 0;
  let stop = false;

  for (const team of teams) {
    if (stop) break;
    if (!Array.isArray(team.players)) continue;
    for (const p of team.players) {
      if (stop) break;
      if (p.highlight_video_id) continue; // already populated
      if (scanned >= limit) {
        stop = true;
        break;
      }
      scanned++;
      try {
        const r = await resolveOne(p.name, team.league);
        if (r.reason === 'ok' && r.videoId) {
          p.highlight_video_id = r.videoId;
          populated++;
        } else if (r.reason === 'no_search_hits') {
          no_hits++;
        } else if (r.reason === 'no_embeddable') {
          no_embeddable++;
        } else if (r.reason === 'skipped_no_key') {
          // Reverse the count — we didn't actually consume budget.
          scanned--;
          stop = true;
          break;
        } else if (r.reason === 'error') {
          errors++;
        }
      } catch (err) {
        if ((err as Error).message === 'youtube_quota_exceeded') {
          log?.warn?.('[allTimeGreatsHighlights] YouTube quota exhausted — saving partial progress');
          stop = true;
          break;
        }
        errors++;
      }
      await sleep(YT_DELAY_MS);
    }
  }

  // Always write back so even partial progress is durable.
  try {
    await writeDataFile(file);
  } catch (err) {
    console.warn(`[allTimeGreatsHighlights] write failed: ${(err as Error).message}`);
  }

  // Recount totals for the summary.
  let total_entries = 0;
  let total_with_id = 0;
  for (const team of teams) {
    for (const p of team.players ?? []) {
      total_entries++;
      if (p.highlight_video_id) total_with_id++;
    }
  }

  const summary: BackfillSummary = {
    scanned,
    populated,
    no_hits,
    no_embeddable,
    errors,
    remaining_unfilled: total_entries - total_with_id,
    total_entries,
    total_with_id,
  };

  const line = `[allTimeGreatsHighlights] scanned=${scanned} populated=${populated} ` +
    `no_hits=${no_hits} no_embeddable=${no_embeddable} errors=${errors} ` +
    `total=${total_with_id}/${total_entries} (remaining=${summary.remaining_unfilled})`;
  if (log) log.info(line);
  else console.log(line);

  return summary;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseLimitFromArgv(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    } else if (argv[i].startsWith('--limit=')) {
      const n = Number(argv[i].split('=')[1]);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  }
  return undefined;
}

const isMain =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  /allTimeGreatsHighlights\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  const limit = parseLimitFromArgv(process.argv.slice(2)) ?? DEFAULT_LIMIT;
  backfillAllTimeGreatsHighlights({ limit })
    .then((s) => {
      console.log('[allTimeGreatsHighlights] CLI run complete:', JSON.stringify(s, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[allTimeGreatsHighlights] CLI run FAILED:', err);
      process.exit(1);
    });
}
