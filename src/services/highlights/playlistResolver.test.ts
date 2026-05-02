/**
 * playlistResolver.test.ts — exercises the embeddability filter +
 * sort-by-played_on + dedup logic of the playlist resolver. Uses
 * `_buildPlaylistForTests` to bypass network round-trips so the test
 * is hermetic and fast.
 *
 * We mock `../../db/client.js` so the module's top-level supabase import
 * doesn't throw on the missing SUPABASE_URL env in CI.
 */
jest.mock('../../db/client.js', () => ({ supabase: {} }));

import { _buildPlaylistForTests } from './playlistResolver.js';
import { _resetEmbeddabilityCacheForTests } from '../youtube/embeddability.js';

const realFetch = global.fetch;
const ORIG_KEY = process.env['YOUTUBE_API_KEY'];

afterEach(() => {
  global.fetch = realFetch;
  _resetEmbeddabilityCacheForTests();
  if (ORIG_KEY === undefined) delete process.env['YOUTUBE_API_KEY'];
  else process.env['YOUTUBE_API_KEY'] = ORIG_KEY;
});

function mockEmbeddability(rules: Record<string, boolean>): void {
  process.env['YOUTUBE_API_KEY'] = 'test-key';
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    const params = new URL(url).searchParams;
    const ids = (params.get('id') ?? '').split(',').filter(Boolean);
    const items = ids.map((id) => ({
      id,
      status: { embeddable: rules[id] ?? false, privacyStatus: 'public' },
    }));
    return new Response(JSON.stringify({ items }), { status: 200 }) as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('_buildPlaylistForTests', () => {
  it('keeps only embeddable candidates', async () => {
    mockEmbeddability({ aaa1234567: true, bbb1234567: false, ccc1234567: true });
    const events = [
      { event_id: '1', event_name: 'A', video_url: 'https://www.youtube.com/watch?v=aaa1234567', played_on: '2026-04-30' },
      { event_id: '2', event_name: 'B', video_url: 'https://www.youtube.com/watch?v=bbb1234567', played_on: '2026-04-29' },
      { event_id: '3', event_name: 'C', video_url: 'https://www.youtube.com/watch?v=ccc1234567', played_on: '2026-04-28' },
    ];
    const out = await _buildPlaylistForTests(events, 5);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.video_id)).toEqual(['aaa1234567', 'ccc1234567']);
  });

  it('sorts by played_on descending', async () => {
    mockEmbeddability({ aaa1234567: true, bbb1234567: true, ccc1234567: true });
    const events = [
      { event_id: '1', event_name: 'oldest', video_url: 'https://www.youtube.com/watch?v=aaa1234567', played_on: '2026-01-15' },
      { event_id: '2', event_name: 'newest', video_url: 'https://www.youtube.com/watch?v=bbb1234567', played_on: '2026-04-30' },
      { event_id: '3', event_name: 'middle', video_url: 'https://www.youtube.com/watch?v=ccc1234567', played_on: '2026-03-01' },
    ];
    const out = await _buildPlaylistForTests(events, 5);
    expect(out[0]?.title).toBe('newest');
    expect(out[1]?.title).toBe('middle');
    expect(out[2]?.title).toBe('oldest');
  });

  it('caps at the requested limit', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `vid${String(i).padStart(7, '0')}`);
    mockEmbeddability(Object.fromEntries(ids.map((id) => [id, true])));
    const events = ids.map((id, i) => ({
      event_id: String(i),
      event_name: `E${i}`,
      video_url: `https://www.youtube.com/watch?v=${id}`,
      played_on: `2026-04-${String(10 + i).padStart(2, '0')}`,
    }));
    const out = await _buildPlaylistForTests(events, 5);
    expect(out).toHaveLength(5);
  });

  it('dedupes by video_id when the same clip appears under two events', async () => {
    mockEmbeddability({ same1234567: true });
    const events = [
      { event_id: '1', event_name: 'A', video_url: 'https://www.youtube.com/watch?v=same1234567', played_on: '2026-04-30' },
      { event_id: '2', event_name: 'B', video_url: 'https://youtu.be/same1234567', played_on: '2026-04-29' },
    ];
    const out = await _buildPlaylistForTests(events, 5);
    expect(out).toHaveLength(1);
  });

  it('drops candidates whose URL is not a YouTube link', async () => {
    mockEmbeddability({});
    const events = [
      { event_id: '1', event_name: 'cdn-clip', video_url: 'https://cdn.example.com/clip.mp4', played_on: '2026-04-30' },
    ];
    const out = await _buildPlaylistForTests(events, 5);
    expect(out).toHaveLength(0);
  });

  it('returns embeddable: true on every entry', async () => {
    mockEmbeddability({ aaa1234567: true });
    const events = [
      { event_id: '1', event_name: 'A', video_url: 'https://www.youtube.com/watch?v=aaa1234567', played_on: '2026-04-30' },
    ];
    const out = await _buildPlaylistForTests(events, 5);
    expect(out[0]?.embeddable).toBe(true);
  });
});
