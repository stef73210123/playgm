/**
 * highlights.test.ts — unit tests for the SportsDB premium highlights
 * service. We mock `fetch` directly so tests run offline and deterministic.
 */
import {
  fetchPlayerHighlight,
  fetchTeamHighlights,
  fetchLatestLeagueHighlights,
  _resetHighlightsCacheForTests,
} from './highlights.js';

const realFetch = global.fetch;

function mockFetch(handler: (url: string) => { status: number; body: unknown }): void {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const u = input.toString();
    const r = handler(u);
    return new Response(JSON.stringify(r.body), { status: r.status }) as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = realFetch;
  _resetHighlightsCacheForTests();
});

describe('fetchPlayerHighlight', () => {
  it('returns canonical https URL when strYoutube is populated', async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        lookup: [
          {
            idPlayer: '1',
            strYoutube: 'https://www.youtube.com/@kingjames',
            strInstagram: 'instagram.com/kj',
          },
        ],
      },
    }));
    const r = await fetchPlayerHighlight('1');
    expect(r.youtube_url).toBe('https://www.youtube.com/@kingjames');
    expect(r.instagram_url).toBe('https://instagram.com/kj');
  });

  it('upgrades bare youtube domain to https://', async () => {
    mockFetch(() => ({
      status: 200,
      body: { lookup: [{ idPlayer: '1', strYoutube: 'www.youtube.com/@scout' }] },
    }));
    const r = await fetchPlayerHighlight('1');
    expect(r.youtube_url).toBe('https://www.youtube.com/@scout');
  });

  it('returns null for empty strYoutube', async () => {
    mockFetch(() => ({ status: 200, body: { lookup: [{ idPlayer: '1', strYoutube: '' }] } }));
    const r = await fetchPlayerHighlight('1');
    expect(r.youtube_url).toBeNull();
  });

  it('returns null on 401 without throwing', async () => {
    mockFetch(() => ({ status: 401, body: {} }));
    const r = await fetchPlayerHighlight('1');
    expect(r.youtube_url).toBeNull();
  });

  it('returns null on 429 (rate limit) without throwing', async () => {
    mockFetch(() => ({ status: 429, body: {} }));
    const r = await fetchPlayerHighlight('1');
    expect(r.youtube_url).toBeNull();
  });
});

describe('fetchTeamHighlights', () => {
  it('filters out events without https video URL', async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        schedule: [
          { idEvent: 1, strEvent: 'A vs B', strVideo: 'https://www.youtube.com/watch?v=aaa', dateEvent: '2026-04-30' },
          { idEvent: 2, strEvent: 'C vs D', strVideo: '',                                     dateEvent: '2026-04-29' },
          { idEvent: 3, strEvent: 'E vs F', strVideo: 'http://insecure.example/v',           dateEvent: '2026-04-28' },
          { idEvent: 4, strEvent: 'G vs H', strVideo: 'https://www.youtube.com/watch?v=bbb', dateEvent: '2026-04-27' },
        ],
      },
    }));
    const out = await fetchTeamHighlights('1', 5);
    expect(out).toHaveLength(2);
    expect(out[0]?.video_url).toContain('aaa');
    expect(out[1]?.video_url).toContain('bbb');
  });

  it('respects the limit parameter', async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      idEvent: i,
      strEvent: `E${i}`,
      strVideo: `https://www.youtube.com/watch?v=v${i}`,
      dateEvent: `2026-04-${String(10 + i).padStart(2, '0')}`,
    }));
    mockFetch(() => ({ status: 200, body: { schedule: events } }));
    const out = await fetchTeamHighlights('1', 3);
    expect(out).toHaveLength(3);
  });

  it('returns [] on 404', async () => {
    mockFetch(() => ({ status: 404, body: {} }));
    const out = await fetchTeamHighlights('1');
    expect(out).toEqual([]);
  });
});

describe('fetchLatestLeagueHighlights', () => {
  it('reverses to newest-first', async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        schedule: [
          { idEvent: 1, strEvent: 'old', strVideo: 'https://yt/1', dateEvent: '2026-01-01' },
          { idEvent: 2, strEvent: 'mid', strVideo: 'https://yt/2', dateEvent: '2026-02-01' },
          { idEvent: 3, strEvent: 'new', strVideo: 'https://yt/3', dateEvent: '2026-04-30' },
        ],
      },
    }));
    const out = await fetchLatestLeagueHighlights('4387', '2025-2026', 5);
    expect(out[0]?.event_name).toBe('new');
    expect(out[2]?.event_name).toBe('old');
  });
});
