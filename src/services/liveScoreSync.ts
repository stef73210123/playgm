/**
 * liveScoreSync.ts
 * War Room live score sync service.
 *
 * Polls TheSportsDB livescore.php every 120 s via the existing sportsdb.ts
 * client (V2/V1 detection is NOT duplicated — getLiveScores() handles it).
 *
 * On each poll:
 *  - Filters to 5 supported sport categories.
 *  - Diffs scores/status against the previous poll.
 *  - Emits 'score_update' events on the liveScoreEvents EventEmitter.
 *  - Updates active_drafts.score in Supabase for any matched entity.
 *  - Appends to server/logs/api_errors.log on 403 / 429 / 5xx.
 *
 * TODO (downstream consumers — next sprint):
 *  - WebSocket push: subscribe to liveScoreEvents and broadcast to connected clients.
 *  - Notification fan-out: notify alliance members when a drafted entity scores.
 *  - Victory Reveal pre-computation: flag drafts whose score crossed a threshold.
 */

import EventEmitter from 'node:events';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLiveScores, SportsDbHttpError } from './sportsdb.js';
import { stripLeagueAcronyms } from './branding.js';
import { supabase } from '../db/client.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR   = path.resolve(__dirname, '../../logs');
const LOG_FILE   = path.join(LOGS_DIR, 'api_errors.log');
const LOG_ROTATE = path.join(LOGS_DIR, 'api_errors.1.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// ─── Poll timing ─────────────────────────────────────────────────────────────

const POLL_MS    = 120_000; // 120 s nominal
const BACKOFF_MS = 240_000; // 240 s after a 429
const MAX_CONSECUTIVE_403 = 3;

// ─── Sport category mapping ───────────────────────────────────────────────────
// Maps TheSportsDB strSport values → internal War Room categories.

export type SportCategory = 'BASKETBALL' | 'FOOTBALL' | 'BASEBALL' | 'HOCKEY' | 'SOCCER';

/**
 * Maps raw TheSportsDB strSport values → internal War Room categories.
 * TheSportsDB uses "American Football" and "Ice Hockey" — we translate on
 * ingress so the rest of the system only ever sees clean internal codes.
 */
const SPORT_MAP: Record<string, SportCategory> = {
  'Basketball':        'BASKETBALL',
  'American Football': 'FOOTBALL',   // TheSportsDB raw → internal code
  'Baseball':          'BASEBALL',
  'Ice Hockey':        'HOCKEY',     // TheSportsDB raw → internal code
  'Soccer':            'SOCCER',
};

/**
 * Convert an internal SportCategory code to its display string.
 * The enum value IS the display name (title-cased), so this is a simple
 * lower-then-upper transform — no separate lookup table needed.
 *
 * sportDisplay('FOOTBALL')   → "Football"
 * sportDisplay('BASKETBALL') → "Basketball"
 */
export function sportDisplay(category: SportCategory): string {
  return category.charAt(0) + category.slice(1).toLowerCase();
}

// ─── Payload type ─────────────────────────────────────────────────────────────

export type ScoreUpdatePayload = {
  eventId:       string;
  sport:         SportCategory;
  /** Plain sport name — "Basketball", "Football", "Hockey", etc. */
  league:        string;
  homeTeam:      string;
  awayTeam:      string;
  homeScore:     number;
  awayScore:     number;
  /** strStatus from TheSportsDB, e.g. "Q3 05:42", "FT", "HT" */
  status:        string;
  updatedAt:     string; // ISO
  previousHome?: number;
  previousAway?: number;
};

// ─── Internal diff cache ──────────────────────────────────────────────────────

type CachedScore = {
  homeScore: number;
  awayScore: number;
  strStatus: string;
};

const scoreCache = new Map<string, CachedScore>();

// ─── Singleton EventEmitter ───────────────────────────────────────────────────

export const liveScoreEvents = new EventEmitter();

// ─── Error / backoff state ────────────────────────────────────────────────────

let consecutive403  = 0;
let skipNextCycle   = false; // set true after a 429; cleared at next poll

// ─── Lifecycle state ──────────────────────────────────────────────────────────

let running   = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Error logging ────────────────────────────────────────────────────────────

async function appendErrorLog(line: string): Promise<void> {
  try {
    await fsPromises.mkdir(LOGS_DIR, { recursive: true });

    // Rotate if file exceeds 5 MB
    try {
      const stat = await fsPromises.stat(LOG_FILE);
      if (stat.size > LOG_MAX_BYTES) {
        await fsPromises.rename(LOG_FILE, LOG_ROTATE);
      }
    } catch {
      // File may not exist yet — that's fine
    }

    const ts = new Date().toISOString();
    await fsPromises.appendFile(LOG_FILE, `[${ts}] ${line}\n`, 'utf-8');
  } catch {
    // Never crash the sync on a log write failure
  }
}

// ─── Active-drafts DB update ──────────────────────────────────────────────────

async function updateActiveDrafts(
  idHomeTeam: string | undefined,
  idAwayTeam: string | undefined,
  homeScore:  number,
  awayScore:  number,
): Promise<void> {
  try {
    const now = new Date().toISOString();

    if (idHomeTeam) {
      await supabase
        .from('active_drafts')
        .update({ score: homeScore, updated_at: now })
        .eq('entity_id', idHomeTeam)
        .eq('status', 'LIVE');
    }

    if (idAwayTeam) {
      await supabase
        .from('active_drafts')
        .update({ score: awayScore, updated_at: now })
        .eq('entity_id', idAwayTeam)
        .eq('status', 'LIVE');
    }
  } catch (err) {
    // DB errors must not break the sync loop
    console.error('[liveScoreSync] active_drafts update failed:', err);
  }
}

// ─── Single poll execution ────────────────────────────────────────────────────
// Returns the number of milliseconds to wait before the next poll.

async function executePoll(): Promise<number> {
  // 429 backoff: skip this cycle and resume with extended delay
  if (skipNextCycle) {
    skipNextCycle = false;
    console.log('[liveScoreSync] skipping poll cycle (429 backoff)');
    return BACKOFF_MS;
  }

  let events: Awaited<ReturnType<typeof getLiveScores>>;

  try {
    events = await getLiveScores();
    consecutive403 = 0; // successful response resets the 403 counter
  } catch (err) {
    if (err instanceof SportsDbHttpError) {
      const { status } = err;

      if (status === 429) {
        await appendErrorLog(
          `429 Rate Limited - endpoint=livescore.php - retryAfter=60s`,
        );
        skipNextCycle = true;
        return BACKOFF_MS;
      }

      if (status === 403) {
        consecutive403 += 1;
        await appendErrorLog(
          `403 Forbidden - endpoint=livescore.php - consecutive=${consecutive403}`,
        );
        if (consecutive403 >= MAX_CONSECUTIVE_403) {
          await appendErrorLog(
            `CRITICAL: ${MAX_CONSECUTIVE_403} consecutive 403s on livescore.php — ` +
            `Patreon key likely invalid. Stopping sync until restart.`,
          );
          console.error(
            '[liveScoreSync] CRITICAL: stopping sync after 3× 403 Forbidden',
          );
          stopLiveScoreSync();
        }
        return POLL_MS;
      }

      if (status >= 500) {
        await appendErrorLog(
          `5xx Server Error ${status} - endpoint=livescore.php`,
        );
      }
    }

    console.error('[liveScoreSync] poll error:', err);
    return POLL_MS;
  }

  // ─── Diff + emit ─────────────────────────────────────────────────────────

  let emitted = 0;

  for (const event of events) {
    // Filter to supported sports
    const sport = SPORT_MAP[event.strSport ?? ''];
    if (!sport) continue;

    const homeScore = Number(event.intHomeScore ?? 0);
    const awayScore = Number(event.intAwayScore ?? 0);
    const status    = event.strStatus ?? '';

    const cached = scoreCache.get(event.idEvent);
    const changed =
      !cached ||
      cached.homeScore !== homeScore ||
      cached.awayScore !== awayScore ||
      cached.strStatus !== status;

    if (!changed) continue;

    // Update diff cache
    scoreCache.set(event.idEvent, { homeScore, awayScore, strStatus: status });

    // Build payload — all strings already branded by sdbFetch, but we run
    // stripLeagueAcronyms() defensively so downstream code never sees raw acronyms.
    const payload: ScoreUpdatePayload = {
      eventId:      event.idEvent,
      sport,
      league:       stripLeagueAcronyms(event.strLeague ?? ''),
      homeTeam:     stripLeagueAcronyms(event.strHomeTeam),
      awayTeam:     stripLeagueAcronyms(event.strAwayTeam),
      homeScore,
      awayScore,
      status:       stripLeagueAcronyms(status),
      updatedAt:    new Date().toISOString(),
      ...(cached && {
        previousHome: cached.homeScore,
        previousAway: cached.awayScore,
      }),
    };

    liveScoreEvents.emit('score_update', payload);
    emitted += 1;

    // Persist score change to active_drafts (non-blocking, errors swallowed)
    void updateActiveDrafts(
      event.idHomeTeam,
      event.idAwayTeam,
      homeScore,
      awayScore,
    );
  }

  // Console log so the server output confirms activity (replaced by a proper
  // logger call once this module accepts a FastifyBaseLogger param in a later sprint)
  if (emitted > 0) {
    console.log(
      `[liveScoreSync] ${emitted} SCORE_UPDATE event(s) emitted`,
    );
  }

  return POLL_MS;
}

// ─── Recursive scheduler ─────────────────────────────────────────────────────

function scheduleNext(delayMs: number): void {
  if (!running) return;
  pollTimer = setTimeout(() => {
    void executePoll().then((nextDelay) => {
      scheduleNext(nextDelay);
    });
  }, delayMs);
}

// ─── Public lifecycle API ─────────────────────────────────────────────────────

export function startLiveScoreSync(): void {
  if (running) {
    console.warn('[liveScoreSync] already running — ignoring duplicate start');
    return;
  }

  running = true;
  console.log(
    `[liveScoreSync] starting — polling livescore.php every ${POLL_MS / 1000}s`,
  );

  // Graceful shutdown on process signals
  const shutdown = (): void => {
    console.log('[liveScoreSync] shutdown signal received');
    stopLiveScoreSync();
  };
  process.once('SIGINT',  shutdown);
  process.once('SIGTERM', shutdown);

  // Run once immediately, then recurse
  void executePoll().then((firstDelay) => {
    scheduleNext(firstDelay);
  });
}

export function stopLiveScoreSync(): void {
  running = false;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log('[liveScoreSync] stopped');
}
