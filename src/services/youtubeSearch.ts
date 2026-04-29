/**
 * youtubeSearch.ts
 * Fetches YouTube highlight videos for a given entity (team or player).
 *
 * Primary:  YouTube Data API v3 — requires YOUTUBE_API_KEY in env.
 * Fallback: scrape YouTube search results page for ytInitialData video entries.
 */

const YT_API_KEY = process.env['YOUTUBE_API_KEY'];
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const SCRAPE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface VideoResult {
  id: string;
  title: string;
  /** YouTube channel name — used for the official-source allowlist filter. */
  channel?: string;
}

// ─── Official-source allowlist ─────────────────────────────────────────────
// We only show highlights coming from a league, individual team, major
// sports network, or an obvious official mirror. This keeps random fan
// re-uploads (which often have inaccurate scores or doctored audio) out
// of the kid-facing film room.
const OFFICIAL_CHANNEL_PATTERNS = [
  // Leagues (official)
  /^NBA$/i,
  /^NFL$/i,
  /^MLB$/i,
  /^NHL$/i,
  /^MLS$/i,
  /^WNBA$/i,
  /^Major League /i,
  /\bofficial\b/i,
  // Networks
  /^ESPN$/i,
  /^Bleacher Report$/i,
  /^Fox Sports$/i,
  /^CBS Sports$/i,
  /^NBC Sports$/i,
  /^TNT Sports$/i,
  /^House of Highlights$/i, // owned by Bleacher Report (official-adjacent)
  // Common per-team channels — extend as needed
  /(Lakers|Celtics|Warriors|Bulls|Nets|Heat|Nuggets|Bucks|76ers|Mavericks|Suns)/i,
  /(Patriots|Chiefs|Eagles|Cowboys|Bills|Ravens|Packers|49ers|Giants)/i,
  /(Yankees|Dodgers|Red Sox|Cubs|Mets|Braves|Astros|Cardinals)/i,
  /(Avalanche|Oilers|Maple Leafs|Bruins|Rangers|Penguins|Lightning)/i,
  /(LAFC|Inter Miami|Galaxy|Atlanta United)/i,
];

function isOfficialChannel(channel: string | undefined): boolean {
  if (!channel) return false;
  return OFFICIAL_CHANNEL_PATTERNS.some((p) => p.test(channel));
}

// ─── API path ─────────────────────────────────────────────────────────────────

async function searchWithApi(query: string, maxResults: number): Promise<VideoResult[]> {
  // Fetch a wider pool than the caller asked for so we can filter down
  // to official channels and still return the requested count.
  const fetchCount = Math.min(50, maxResults * 6);
  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(fetchCount),
    order: 'relevance',
    key: YT_API_KEY!,
  });
  const res = await fetch(`${YT_API_BASE}/search?${params}`);
  if (!res.ok) throw new Error(`YouTube API ${res.status}`);
  const data = (await res.json()) as {
    items: Array<{ id: { videoId: string }; snippet: { title: string; channelTitle: string } }>;
  };
  const all = data.items.map((item) => ({
    id: item.id.videoId,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
  }));
  const official = all.filter((v) => isOfficialChannel(v.channel));
  // If we got at least one official result, return only those (capped).
  // Otherwise return the unfiltered head — better to show something than
  // an empty film room when the search lands in an unusual edge case.
  return (official.length > 0 ? official : all).slice(0, maxResults);
}

// ─── Scrape path ──────────────────────────────────────────────────────────────

function parseScrapedHtml(html: string, maxResults: number): VideoResult[] {
  const all: VideoResult[] = [];
  const seen = new Set<string>();

  // Match specifically "videoRenderer":{"videoId":"..." to avoid thumbnails/previews
  const rendererRegex = /"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let m: RegExpExecArray | null;

  // Cast a wider net than maxResults so we can apply the official-channel
  // filter below and still return the requested count.
  const cap = Math.min(50, maxResults * 6);
  while ((m = rendererRegex.exec(html)) !== null && all.length < cap) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);

    // Scan up to 8 KB after the videoRenderer for the title + channel
    // metadata. The scraped JSON keeps ownerText.runs[0].text as the
    // channel display name.
    const chunk = html.slice(m.index, m.index + 8000);
    const titleFull = chunk.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
    const title = titleFull?.[1] ?? id;
    const channelMatch = chunk.match(/"ownerText":\{"runs":\[\{"text":"([^"]+)"/)
      ?? chunk.match(/"longBylineText":\{"runs":\[\{"text":"([^"]+)"/);
    const channel = channelMatch?.[1];
    all.push({ id, title, channel });
  }
  const official = all.filter((v) => isOfficialChannel(v.channel));
  return (official.length > 0 ? official : all).slice(0, maxResults);
}

async function searchWithScrape(query: string, maxResults: number): Promise<VideoResult[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': SCRAPE_UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`YouTube scrape HTTP ${res.status}`);
  const html = await res.text();
  return parseScrapedHtml(html, maxResults);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Query-shaping rules:
 *   - Player: `{name} highlights {year}` — personal highlights package.
 *   - Team:   `{name} highlights recent game {year}` — emphasize most
 *             recent game recap so the film-room feels current.
 *   - Game:   `entityName` is treated as a free-form recap query (e.g.
 *             "Heat vs Nuggets recap") which the caller has already
 *             shaped to point at one specific matchup.
 * The season year is derived from the current date so queries stay
 * fresh without a redeploy.
 */
export async function searchHighlights(
  entityName: string,
  maxResults = 5,
  entityType: 'player' | 'team' | 'game' = 'player',
): Promise<VideoResult[]> {
  const year = new Date().getFullYear();
  let query: string;
  if (entityType === 'game') {
    // Caller already built a game-specific phrase. Append the year so
    // the YouTube ranking favors current-season recaps.
    query = `${entityName} ${year}`;
  } else if (entityType === 'team') {
    query = `${entityName} highlights recent game ${year}`;
  } else {
    query = `${entityName} highlights ${year}`;
  }
  if (YT_API_KEY) {
    return searchWithApi(query, maxResults);
  }
  return searchWithScrape(query, maxResults);
}
