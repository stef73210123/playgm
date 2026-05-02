/**
 * highlightsCron.ts — daily refresh of team + player highlight videos.
 *
 * Schedule (America/New_York):
 *   - 05:30 ET daily — refresh team highlights (delegates to the existing
 *     pull-highlights script, --force) AND a rotating slice of player
 *     highlights (capped at PLAYER_DAILY_CAP per run).
 *
 * Why a separate cron from `refreshStats.ts`?
 *   - The existing 05:00 ET highlights cron only does team-level highlight
 *     refresh and only force-refreshes weekly (Sun 06:00 ET). Player-level
 *     highlights (per-player playlists keyed by name → idPlayer →
 *     strYoutube + team event playlist) had no scheduled refresh — that's
 *     the gap this module closes.
 *
 * Scope decision (the spec said either was acceptable):
 *   - We refresh BOTH teams and players DAILY here. Team refresh just
 *     calls into the existing pull-highlights script with --force so the
 *     legacy meta_json.highlight_playlist (per-team) stays fresh on the
 *     same daily cadence. Player refresh writes to the new per-sport
 *     player highlight files described below.
 *   - The existing 05:00 ET (delta) and Sun 06:00 ET (force) team-only
 *     crons in refreshStats.ts are left in place unchanged so we don't
 *     destabilize that path.
 *
 * Source: TheSportsDB premium (`SPORTSDB_V2_KEY`)
 *   - For each player in `assets/stat-cache/{sport}_season_*.json` we run
 *     `searchPlayersByName(full_name)` → take the first matching idPlayer
 *     in the same league/category → `lookupPlayer` for `strYoutube`,
 *     plus `fetchTeamHighlights` (via the player's resolved idTeam, when
 *     known) for per-game video URLs.
 *   - Resolved video IDs go through the YouTube embeddability filter
 *     (status.embeddable === true && privacyStatus === public) — capped
 *     at 10 per player.
 *
 * Storage: `assets/stat-cache/highlights_players_${sport}.json`
 *   {
 *     "sport": "nba",
 *     "generated_at": "...ISO...",
 *     "players": [
 *       {
 *         "playerId": "espn:4278039",
 *         "name": "Nickeil Alexander-Walker",
 *         "sport": "nba",
 *         "videos": [
 *           { "videoId": "...", "title": "...", "publishedAt": "...", "thumbnail": "..." }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Rate limit: PLAYER_DAILY_CAP (2,500) refreshes per cron run. A rotating
 * cursor in `server/state/highlights-cursor.json` records the last index
 * processed per sport so consecutive days walk through the full roster
 * without re-doing the same head every time.
 *
 * Failure handling: every external call is wrapped in try/catch; the cron
 * never throws. If process.env.SENTRY_DSN is set we surface to Sentry
 * (not currently wired in this repo — falls through to console).
 */
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  fetchPlayerHighlight,
  fetchTeamHighlights,
} from '../services/sportsdb/highlights.js';
import { searchPlayersByName, lookupPlayer } from '../services/sportsdb.js';
import { checkEmbeddability, youtubeIdFromUrl } from '../services/youtube/embeddability.js';

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Hard daily ceiling for SportsDB+YouTube round-trips per cron run. */
const PLAYER_DAILY_CAP = 2_500;
/** Max videos persisted per player. */
const VIDEOS_PER_PLAYER = 10;
/** Per-player polite delay between SportsDB roundtrips. */
const SPORTSDB_DELAY_MS = 150;
/** Number of candidate events pulled per player team for embed-filter headroom. */
const CANDIDATES_PER_PLAYER = 20;

// ─── Sport / file resolution ────────────────────────────────────────────────

const SPORTS = ['nba', 'nfl', 'mlb', 'nhl', 'mls'] as const;
type Sport = (typeof SPORTS)[number];

const STAT_CACHE_GLOB: Record<Sport, string> = {
  nba: 'nba_season_2025-26.json',
  nfl: 'nfl_season_2025.json',
  mlb: 'mlb_season_2026.json',
  nhl: 'nhl_season_2025-26.json',
  mls: 'mls_season_2026.json',
};

const SPORT_TO_CATEGORY: Record<Sport, string> = {
  nba: 'basketball',
  nfl: 'american football',
  mlb: 'baseball',
  nhl: 'ice hockey',
  mls: 'soccer',
};

/** Resolve repo-root regardless of dist/ vs src/ at runtime. */
function repoRoot(): string {
  // Both `tsx src/...` (dev) and `node dist/src/...` (prod) resolve cwd to
  // the server/ folder, so the assets folder is one directory up.
  const cwd = process.cwd();
  // server/ → ../assets, repo-root/ → ./assets — handle both.
  if (existsSync(path.join(cwd, 'assets'))) return cwd;
  return path.resolve(cwd, '..');
}

function statCachePath(sport: Sport): string {
  return path.join(repoRoot(), 'assets', 'stat-cache', STAT_CACHE_GLOB[sport]);
}

function highlightsOutPath(sport: Sport): string {
  return path.join(repoRoot(), 'assets', 'stat-cache', `highlights_players_${sport}.json`);
}

function cursorPath(): string {
  // Server-relative — keep state alongside the server process.
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'server'))) {
    return path.join(cwd, 'server', 'state', 'highlights-cursor.json');
  }
  return path.join(cwd, 'state', 'highlights-cursor.json');
}

// ─── State (cursor) ─────────────────────────────────────────────────────────

interface CursorState {
  /** Per-sport last index *processed* (i.e. start next run at value+1 mod len). */
  cursors: Partial<Record<Sport, number>>;
  updated_at: string;
}

async function readCursor(): Promise<CursorState> {
  try {
    const raw = await readFile(cursorPath(), 'utf8');
    const parsed = JSON.parse(raw) as CursorState;
    if (parsed && typeof parsed === 'object' && parsed.cursors) return parsed;
  } catch {
    // missing / malformed → start fresh
  }
  return { cursors: {}, updated_at: new Date().toISOString() };
}

async function writeCursor(state: CursorState): Promise<void> {
  state.updated_at = new Date().toISOString();
  await mkdir(path.dirname(cursorPath()), { recursive: true });
  await writeFile(cursorPath(), JSON.stringify(state, null, 2), 'utf8');
}

// ─── stat-cache reader ──────────────────────────────────────────────────────

interface StatCachePlayer {
  external_id?: string;
  full_name?: string;
  team?: string;
  team_abbr?: string;
}
interface StatCacheFile {
  league?: string;
  season?: string;
  players?: StatCachePlayer[];
}

async function readStatCache(sport: Sport): Promise<StatCachePlayer[]> {
  try {
    const raw = await readFile(statCachePath(sport), 'utf8');
    const parsed = JSON.parse(raw) as StatCacheFile;
    return Array.isArray(parsed.players) ? parsed.players : [];
  } catch (err) {
    console.warn(`[highlights-cron] could not read stat-cache for ${sport}:`, (err as Error).message);
    return [];
  }
}

// ─── Output file ────────────────────────────────────────────────────────────

export interface PlayerHighlightVideo {
  videoId: string;
  title: string;
  publishedAt: string | null;
  thumbnail: string | null;
}

export interface PlayerHighlightEntry {
  playerId: string;
  name: string;
  sport: Sport;
  videos: PlayerHighlightVideo[];
}

interface HighlightsFile {
  sport: Sport;
  generated_at: string;
  players: PlayerHighlightEntry[];
}

async function readExistingHighlights(sport: Sport): Promise<HighlightsFile> {
  try {
    const raw = await readFile(highlightsOutPath(sport), 'utf8');
    const parsed = JSON.parse(raw) as HighlightsFile;
    if (parsed && Array.isArray(parsed.players)) {
      return { sport, generated_at: parsed.generated_at, players: parsed.players };
    }
  } catch {
    // missing → fresh
  }
  return { sport, generated_at: new Date().toISOString(), players: [] };
}

async function writeHighlights(sport: Sport, file: HighlightsFile): Promise<void> {
  file.generated_at = new Date().toISOString();
  await mkdir(path.dirname(highlightsOutPath(sport)), { recursive: true });
  // Keep a stable order — sort by name for diff-friendliness.
  file.players.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(highlightsOutPath(sport), JSON.stringify(file, null, 2), 'utf8');
}

// ─── Sentry / error surface ─────────────────────────────────────────────────

function reportError(scope: string, err: unknown): void {
  // No Sentry SDK is wired into this repo today; if/when it is, we'd
  // import once at the top and call Sentry.captureException(err, { tags: { scope } }).
  const e = err as Error;
  console.warn(`[highlights-cron] ${scope}:`, e?.message ?? err);
}

// ─── Per-player resolver ────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ResolvedCandidate {
  videoId: string;
  title: string;
  publishedAt: string | null;
  thumbnail: string | null;
}

function youtubeThumbForId(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/**
 * Pull candidate video clips for one player:
 *   1. searchPlayersByName(full_name) to get an idPlayer
 *   2. lookupPlayer(idPlayer) for strYoutube channel URL (kept as a
 *      candidate when it resolves to a single-video URL — channel-level
 *      URLs can't go through the embed filter so they're skipped here).
 *   3. fetchTeamHighlights(idTeam) for per-game video URLs.
 *
 * Returns up to CANDIDATES_PER_PLAYER candidates, NOT yet embed-filtered.
 */
async function gatherPlayerCandidates(
  player: StatCachePlayer,
  sport: Sport,
): Promise<ResolvedCandidate[]> {
  const candidates: ResolvedCandidate[] = [];
  const fullName = player.full_name?.trim();
  if (!fullName) return candidates;

  // 1. Resolve to a SportsDB idPlayer.
  let idPlayer: string | undefined;
  let idTeam: string | undefined;
  try {
    const matches = await searchPlayersByName(fullName);
    // Prefer one whose strSport matches the league. SportsDB sport names:
    //   "Basketball" / "American Football" / "Baseball" / "Ice Hockey" / "Soccer"
    const wantSport = SPORT_TO_CATEGORY[sport].toLowerCase();
    const filtered = matches.filter(
      (m) => (m.strSport ?? '').toLowerCase() === wantSport,
    );
    const pick = filtered[0] ?? matches[0];
    if (pick) {
      idPlayer = String(pick.idPlayer ?? '');
      idTeam = pick.idTeam ? String(pick.idTeam) : undefined;
    }
  } catch (err) {
    reportError(`searchPlayersByName ${fullName}`, err);
  }

  // 2. Lookup details (strYoutube). Only useful when it's a single-video URL.
  if (idPlayer) {
    try {
      const lookup = await fetchPlayerHighlight(idPlayer);
      if (lookup.youtube_url) {
        const vid = youtubeIdFromUrl(lookup.youtube_url);
        if (vid) {
          candidates.push({
            videoId: vid,
            title: `${fullName} — Highlights`,
            publishedAt: null,
            thumbnail: youtubeThumbForId(vid),
          });
        }
      }
      // Refresh team id from the full lookup if missing.
      if (!idTeam) {
        try {
          const full = await lookupPlayer(idPlayer);
          if (full?.idTeam) idTeam = String(full.idTeam);
        } catch (err) {
          reportError(`lookupPlayer ${idPlayer}`, err);
        }
      }
    } catch (err) {
      reportError(`fetchPlayerHighlight ${idPlayer}`, err);
    }
  }

  // 3. Per-team game highlights.
  if (idTeam) {
    try {
      const events = await fetchTeamHighlights(idTeam, CANDIDATES_PER_PLAYER);
      for (const ev of events) {
        const vid = youtubeIdFromUrl(ev.video_url);
        if (!vid) continue;
        candidates.push({
          videoId: vid,
          title: ev.event_name || `${fullName} — Game`,
          publishedAt: ev.played_on,
          thumbnail: youtubeThumbForId(vid),
        });
        if (candidates.length >= CANDIDATES_PER_PLAYER) break;
      }
    } catch (err) {
      reportError(`fetchTeamHighlights ${idTeam}`, err);
    }
  }

  return candidates;
}

/** Filter through YouTube embeddability and dedup video ids. */
async function embedFilter(
  candidates: ResolvedCandidate[],
): Promise<ResolvedCandidate[]> {
  if (candidates.length === 0) return [];
  // Dedup before the API call to save quota.
  const seen = new Set<string>();
  const uniq: ResolvedCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.videoId)) continue;
    seen.add(c.videoId);
    uniq.push(c);
  }
  let status: Map<string, { embeddable: boolean }>;
  try {
    status = await checkEmbeddability(uniq.map((c) => c.videoId));
  } catch (err) {
    reportError('checkEmbeddability', err);
    return uniq.slice(0, VIDEOS_PER_PLAYER);
  }
  return uniq.filter((c) => status.get(c.videoId)?.embeddable === true);
}

// ─── Main worker ────────────────────────────────────────────────────────────

interface RunSummary {
  teams: number;
  players: number;
  skipped: number;
  perSport: Record<Sport, { processed: number; written: number; skipped: number }>;
}

/**
 * Refresh team highlights via the existing pull-highlights script
 * (force mode), so the team-side meta_json.highlight_playlist gets bumped
 * on the same daily schedule. Returns the rough team count (parsed from
 * the script's last summary line) or null when we can't infer it.
 */
async function refreshTeamHighlightsViaScript(log?: FastifyBaseLogger): Promise<number> {
  return new Promise((resolve) => {
    let teamsTouched = 0;
    let lastLine = '';
    log?.info('[highlights-cron] kicking off team-side pull-highlights --teams-only --force');
    const cwd = path.resolve(process.cwd());
    let child;
    try {
      child = spawn(
        'npx',
        ['tsx', '--import', './src/env-loader.ts', 'src/scripts/pull-highlights.ts', '--teams-only', '--force'],
        { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      reportError('spawn pull-highlights', err);
      return resolve(0);
    }
    child.stdout.on('data', (b: Buffer) => {
      const s = b.toString();
      lastLine = s.trim().split('\n').pop() ?? lastLine;
      const m = s.match(/teams done: (\d+)\/(\d+) updated/);
      if (m) teamsTouched = Number(m[1]);
    });
    child.stderr.on('data', (b: Buffer) => {
      log?.warn({ msg: b.toString().trim() }, '[highlights-cron] script stderr');
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        log?.info(`[highlights-cron] team script ok — ${lastLine}`);
      } else {
        reportError('pull-highlights script', new Error(`exit ${code ?? 'null'}`));
      }
      resolve(teamsTouched);
    });
    child.on('error', (err: Error) => {
      reportError('pull-highlights spawn', err);
      resolve(0);
    });
  });
}

/**
 * Refresh player highlights for one sport, walking from the cursor and
 * processing up to `cap` players. Returns counts.
 */
async function refreshPlayersForSport(
  sport: Sport,
  cap: number,
  cursor: number,
  log?: FastifyBaseLogger,
): Promise<{ processed: number; written: number; skipped: number; nextCursor: number }> {
  const players = await readStatCache(sport);
  if (players.length === 0) {
    log?.info(`[highlights-cron] ${sport}: empty stat-cache, skipping`);
    return { processed: 0, written: 0, skipped: 0, nextCursor: 0 };
  }

  const file = await readExistingHighlights(sport);
  const byId = new Map<string, PlayerHighlightEntry>();
  for (const e of file.players) byId.set(e.playerId, e);

  let processed = 0;
  let written = 0;
  let skipped = 0;
  const start = cursor % players.length;
  let i = start;
  while (processed < cap) {
    const p = players[i];
    if (p) {
      const playerId = p.external_id ?? `${sport}:${p.full_name ?? `idx${i}`}`;
      try {
        const candidates = await gatherPlayerCandidates(p, sport);
        const keepers = await embedFilter(candidates);
        if (keepers.length > 0) {
          const entry: PlayerHighlightEntry = {
            playerId,
            name: p.full_name ?? '(unknown)',
            sport,
            videos: keepers.slice(0, VIDEOS_PER_PLAYER).map((k) => ({
              videoId: k.videoId,
              title: k.title,
              publishedAt: k.publishedAt,
              thumbnail: k.thumbnail,
            })),
          };
          byId.set(playerId, entry);
          written++;
        } else {
          skipped++;
          log?.debug?.(`[highlights-cron] ${sport} ${p.full_name}: no embeddable videos`);
        }
      } catch (err) {
        skipped++;
        reportError(`refresh ${sport}/${p.full_name}`, err);
      }
      processed++;
      await sleep(SPORTSDB_DELAY_MS);
    }
    i = (i + 1) % players.length;
    if (i === start) break; // wrapped a full loop
  }

  // Persist after each sport so a later crash doesn't lose the work.
  file.players = Array.from(byId.values());
  try {
    await writeHighlights(sport, file);
  } catch (err) {
    reportError(`writeHighlights ${sport}`, err);
  }

  return { processed, written, skipped, nextCursor: i };
}

/**
 * One full daily refresh — teams + a slice of players, capped at
 * PLAYER_DAILY_CAP across all sports.
 */
export async function refreshHighlightsNow(log?: FastifyBaseLogger): Promise<RunSummary> {
  const summary: RunSummary = {
    teams: 0,
    players: 0,
    skipped: 0,
    perSport: {} as RunSummary['perSport'],
  };

  // Teams (delegates to existing script). Failures don't crash player work.
  try {
    summary.teams = await refreshTeamHighlightsViaScript(log);
  } catch (err) {
    reportError('refreshTeamHighlightsViaScript', err);
  }

  // Players — split the daily budget across sports proportionally to
  // their roster size, then walk from the per-sport cursor.
  const cursor = await readCursor();
  const sportSizes: Array<{ sport: Sport; size: number }> = [];
  for (const sport of SPORTS) {
    const players = await readStatCache(sport);
    sportSizes.push({ sport, size: players.length });
  }
  const totalSize = sportSizes.reduce((s, x) => s + x.size, 0) || 1;

  for (const { sport, size } of sportSizes) {
    if (size === 0) {
      summary.perSport[sport] = { processed: 0, written: 0, skipped: 0 };
      continue;
    }
    // Proportional allocation, min 50 / sport when budget allows.
    const portion = Math.max(50, Math.round((size / totalSize) * PLAYER_DAILY_CAP));
    const cap = Math.min(portion, size);
    const startCursor = cursor.cursors[sport] ?? 0;
    let result;
    try {
      result = await refreshPlayersForSport(sport, cap, startCursor, log);
    } catch (err) {
      reportError(`refreshPlayersForSport ${sport}`, err);
      result = { processed: 0, written: 0, skipped: 0, nextCursor: startCursor };
    }
    summary.perSport[sport] = {
      processed: result.processed,
      written: result.written,
      skipped: result.skipped,
    };
    summary.players += result.written;
    summary.skipped += result.skipped;
    cursor.cursors[sport] = result.nextCursor;
  }

  try {
    await writeCursor(cursor);
  } catch (err) {
    reportError('writeCursor', err);
  }

  const line = `[highlights-cron] refreshed ${summary.teams} teams, ${summary.players} players, ${summary.skipped} skipped`;
  if (log) log.info(line);
  else console.log(line);

  return summary;
}

// ─── Cron registration ──────────────────────────────────────────────────────

export interface HighlightsCronHandle {
  stop: () => void;
}

/**
 * Register the daily cron. Returns a handle so tests / shutdown hooks
 * can stop it. Schedule: 05:00 ET every day (America/New_York).
 *
 * NOTE: the legacy 05:00 ET cron in `refreshStats.ts` already does a
 * delta team-only pull. We schedule this NEW cron at 05:30 ET so the
 * two never overlap.
 */
export function startHighlightsCron(log?: FastifyBaseLogger): HighlightsCronHandle {
  const tz = 'America/New_York';
  const expr = '30 5 * * *';
  const task = cron.schedule(
    expr,
    () => {
      void refreshHighlightsNow(log).catch((err) => reportError('cron tick', err));
    },
    { timezone: tz },
  );
  log?.info(
    `[highlights-cron] scheduled daily ${expr} (${tz}) — team + player highlight refresh, cap=${PLAYER_DAILY_CAP} players/day`,
  );
  return { stop: () => task.stop() };
}

// ─── CLI invocation ─────────────────────────────────────────────────────────
//
// Allow:  `node dist/src/jobs/highlightsCron.js`  for a one-shot run.
// And:    `node -e "require('./server/dist/src/jobs/highlightsCron').refreshHighlightsNow()"`
//
// The ESM equivalent of `require.main === module`:
const isMain =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  process.argv[1].endsWith('highlightsCron.js');

if (isMain) {
  refreshHighlightsNow()
    .then((s) => {
      console.log('[highlights-cron] CLI run complete:', JSON.stringify(s, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[highlights-cron] CLI run FAILED:', err);
      process.exit(1);
    });
}
