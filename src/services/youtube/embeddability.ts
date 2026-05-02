/**
 * youtube/embeddability.ts — filter YouTube video IDs by whether the
 * uploader has allowed third-party embedding.
 *
 * Why: TheSportsDB's `strVideo` field gives us a YouTube URL per game,
 * but ~5–15% of those clips are flagged "playback on other websites
 * has been disabled by the video owner". When that happens, the
 * iframe player shows a black box on a kid's iPad and nothing else.
 * Calling YouTube Data API v3's `videos.list?part=status` lets us
 * pre-filter so the in-app player only ever queues up clips that
 * will actually play.
 *
 * Endpoint: GET https://www.googleapis.com/youtube/v3/videos
 *   ?part=status&id=VIDEO_ID_1,VIDEO_ID_2,...&key=$YOUTUBE_API_KEY
 *
 * Quota cost: 1 unit per call (regardless of how many IDs in the
 * batch — up to 50). Default daily quota is 10,000 units, so 200
 * batched calls/day. A full playlist refresh across ~5k entities
 * needing embeddability checks ≈ 100 calls (50 IDs each) → 1% of
 * daily quota. Comfortable headroom.
 *
 * Cache: 24h in-memory map keyed on video_id. Publishers occasionally
 * flip embedding on/off but it's a once-a-quarter event for most
 * channels — 24h is plenty fresh.
 *
 * Graceful degrade: if YOUTUBE_API_KEY is unset OR the API returns
 * non-2xx (rate-limited, network error, etc.), every requested ID is
 * marked `embeddable: true` so the playlist still surfaces *something*.
 * A warning is logged once per failure mode so Stefan sees it in the
 * server logs and can decide whether to populate the key.
 */

// We read YOUTUBE_API_KEY on every call rather than caching it at module
// load. Tests need to flip the value, and the production server already
// loaded .env via env-loader before this module imports.
function ytApiKey(): string | undefined {
  return process.env['YOUTUBE_API_KEY'];
}
const YT_API_URL = 'https://www.googleapis.com/youtube/v3/videos';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  ts: number;
  result: VideoEmbedStatus;
}

const cache = new Map<string, CacheEntry>();

export interface VideoEmbedStatus {
  /** True when YouTube reports the video as embeddable AND public.
   *  Any uncertainty (network failure, missing API key) maps to true
   *  so the playlist isn't blackholed when YouTube is just slow. */
  embeddable: boolean;
  /** "public" | "unlisted" | "private" — only "public" embeds work
   *  reliably across regions. We keep this for diagnostics. */
  privacyStatus?: string;
  /** "youtube" | "creativeCommon" — informational only. */
  license?: string;
  /** Set when the call hit a fallback path. Lets the dashboard
   *  display "embeddability: degraded" honestly. */
  unverified?: boolean;
}

let warnedMissingKey = false;
let warnedRateLimit = false;

// ─── Quota tracking ─────────────────────────────────────────────────────────
//
// The Data API v3 default quota is 10,000 units per project per day, reset at
// 00:00 Pacific. `videos.list` costs 1 unit per call (regardless of batch
// size — cost scales with `part`, not `id`). We tally calls + a rolling
// daily-window aggregate so the admin dashboard's Highlights card can
// surface "X / 10,000 used today" without hitting the Console.
const QUOTA_DAILY_BUDGET = 10_000;
const dailyHistory: number[] = []; // unix-ms of each successful API call

function recordQuotaCall(): void {
  const now = Date.now();
  dailyHistory.push(now);
  // Drop entries older than 24h so the counter naturally resets.
  const cutoff = now - 24 * 60 * 60 * 1000;
  while (dailyHistory.length > 0 && dailyHistory[0] < cutoff) dailyHistory.shift();
}

export interface QuotaSnapshot {
  /** Unit cost incurred in the last rolling 24h window. Each call =
   *  1 unit (videos.list with part=status). */
  units_24h: number;
  /** Default daily quota (10,000) — overridable in the GCP Console
   *  but we have no programmatic way to read the actual cap, so this
   *  is the published default. */
  daily_budget: number;
  /** units_24h / daily_budget, 0..1. */
  utilization: number;
  /** Number of distinct video IDs cached. Useful as a "are we
   *  benefiting from the cache or burning quota" diagnostic. */
  cache_size: number;
}

export function getQuotaSnapshot(): QuotaSnapshot {
  // Trim any history older than 24h.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (dailyHistory.length > 0 && dailyHistory[0] < cutoff) dailyHistory.shift();
  const units = dailyHistory.length;
  return {
    units_24h: units,
    daily_budget: QUOTA_DAILY_BUDGET,
    utilization: units / QUOTA_DAILY_BUDGET,
    cache_size: cache.size,
  };
}

interface RawVideoStatus {
  id: string;
  status?: {
    embeddable?: boolean;
    privacyStatus?: string;
    license?: string;
  };
}

/**
 * Look up embeddability for up to N YouTube video IDs.
 * Splits into batches of 50 (the API's per-request maximum) and merges
 * the results into a single map.
 *
 * Empty input → empty map. No-op when called with [].
 */
export async function checkEmbeddability(
  videoIds: string[],
): Promise<Map<string, VideoEmbedStatus>> {
  const result = new Map<string, VideoEmbedStatus>();
  if (videoIds.length === 0) return result;

  // Dedup + drop empties.
  const uniq = Array.from(new Set(videoIds.filter(Boolean)));

  // Split into cached vs uncached.
  const now = Date.now();
  const need: string[] = [];
  for (const id of uniq) {
    const c = cache.get(id);
    if (c && now - c.ts < CACHE_TTL_MS) {
      result.set(id, c.result);
    } else {
      need.push(id);
    }
  }
  if (need.length === 0) return result;

  // Missing API key → degrade gracefully (everything embeddable).
  const key = ytApiKey();
  if (!key) {
    if (!warnedMissingKey) {
      console.warn(
        '[youtube/embeddability] YOUTUBE_API_KEY is not set — every video will pass ' +
          'the embeddability check. Set it in server/.env to enable real filtering.',
      );
      warnedMissingKey = true;
    }
    for (const id of need) {
      const r: VideoEmbedStatus = { embeddable: true, unverified: true };
      cache.set(id, { ts: now, result: r });
      result.set(id, r);
    }
    return result;
  }

  // Batch in groups of 50 (YouTube API max).
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    const params = new URLSearchParams({
      part: 'status',
      id: batch.join(','),
      key,
    });
    let res: Response;
    try {
      res = await fetch(`${YT_API_URL}?${params}`);
      recordQuotaCall();
    } catch (err) {
      // Network error → degrade for this batch.
      console.warn(
        `[youtube/embeddability] network error: ${(err as Error).message} — assuming embeddable`,
      );
      for (const id of batch) {
        const r: VideoEmbedStatus = { embeddable: true, unverified: true };
        cache.set(id, { ts: now, result: r });
        result.set(id, r);
      }
      continue;
    }

    if (res.status === 403 || res.status === 429) {
      if (!warnedRateLimit) {
        console.warn(
          `[youtube/embeddability] rate-limited (HTTP ${res.status}) — daily quota may be exhausted. ` +
            'Falling back to "all embeddable" for this batch.',
        );
        warnedRateLimit = true;
      }
      for (const id of batch) {
        const r: VideoEmbedStatus = { embeddable: true, unverified: true };
        cache.set(id, { ts: now, result: r });
        result.set(id, r);
      }
      continue;
    }

    if (!res.ok) {
      console.warn(`[youtube/embeddability] HTTP ${res.status} for batch of ${batch.length}`);
      for (const id of batch) {
        const r: VideoEmbedStatus = { embeddable: true, unverified: true };
        cache.set(id, { ts: now, result: r });
        result.set(id, r);
      }
      continue;
    }

    let data: { items?: RawVideoStatus[] };
    try {
      data = (await res.json()) as { items?: RawVideoStatus[] };
    } catch {
      for (const id of batch) {
        const r: VideoEmbedStatus = { embeddable: true, unverified: true };
        cache.set(id, { ts: now, result: r });
        result.set(id, r);
      }
      continue;
    }

    const seen = new Set<string>();
    for (const item of data.items ?? []) {
      seen.add(item.id);
      const r: VideoEmbedStatus = {
        embeddable:
          (item.status?.embeddable ?? true) && (item.status?.privacyStatus ?? 'public') === 'public',
        privacyStatus: item.status?.privacyStatus,
        license: item.status?.license,
      };
      cache.set(item.id, { ts: now, result: r });
      result.set(item.id, r);
    }
    // Any IDs YouTube didn't return at all = deleted/private. Mark non-embeddable.
    for (const id of batch) {
      if (!seen.has(id)) {
        const r: VideoEmbedStatus = { embeddable: false, privacyStatus: 'unknown' };
        cache.set(id, { ts: now, result: r });
        result.set(id, r);
      }
    }
  }

  return result;
}

/**
 * Extract a YouTube video ID from any common URL shape:
 *   - youtube.com/watch?v=XXXX
 *   - youtu.be/XXXX
 *   - youtube.com/embed/XXXX
 *   - youtube.com/shorts/XXXX
 * Returns null when the URL doesn't look like a single-video link.
 */
export function youtubeIdFromUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '');
      return /^[\w-]{6,}$/.test(id) ? id : null;
    }
    if (host.endsWith('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{6,}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:embed|shorts|watch)\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch {
    return null;
  }
  return null;
}

// ─── Test helpers ───────────────────────────────────────────────────────────

export function _resetEmbeddabilityCacheForTests(): void {
  cache.clear();
  warnedMissingKey = false;
  warnedRateLimit = false;
}

/** Returns the currently configured YouTube API key state — used by
 *  the admin dashboard to show whether the embeddability filter is
 *  in real-check mode or degraded mode. */
export function isEmbeddabilityEnabled(): boolean {
  return Boolean(ytApiKey());
}
