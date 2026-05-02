/**
 * embeddability.test.ts — unit tests for the YouTube Data API v3
 * embeddability filter. Mocks `fetch` so tests run offline.
 */
import {
  checkEmbeddability,
  youtubeIdFromUrl,
  _resetEmbeddabilityCacheForTests,
  getQuotaSnapshot,
  isEmbeddabilityEnabled,
} from './embeddability.js';

const realFetch = global.fetch;
const ORIG_KEY = process.env['YOUTUBE_API_KEY'];

beforeEach(() => {
  process.env['YOUTUBE_API_KEY'] = 'test-key';
  _resetEmbeddabilityCacheForTests();
});

afterEach(() => {
  global.fetch = realFetch;
  _resetEmbeddabilityCacheForTests();
  if (ORIG_KEY === undefined) delete process.env['YOUTUBE_API_KEY'];
  else process.env['YOUTUBE_API_KEY'] = ORIG_KEY;
});

function mockJson(handler: (url: string) => { status: number; body: unknown }): jest.Mock {
  const fn = jest.fn(async (input: RequestInfo | URL) => {
    const r = handler(input.toString());
    return new Response(JSON.stringify(r.body), { status: r.status }) as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('youtubeIdFromUrl', () => {
  it('extracts id from watch?v= form', () => {
    expect(youtubeIdFromUrl('https://www.youtube.com/watch?v=abc12345xyz')).toBe('abc12345xyz');
  });
  it('extracts id from youtu.be short form', () => {
    expect(youtubeIdFromUrl('https://youtu.be/zzzzzzzzzzz')).toBe('zzzzzzzzzzz');
  });
  it('extracts id from /embed/', () => {
    expect(youtubeIdFromUrl('https://www.youtube.com/embed/foo_bar123')).toBe('foo_bar123');
  });
  it('returns null for non-YouTube hosts', () => {
    expect(youtubeIdFromUrl('https://example.com/v/abc')).toBeNull();
  });
  it('returns null for malformed input', () => {
    expect(youtubeIdFromUrl('not-a-url')).toBeNull();
    expect(youtubeIdFromUrl('')).toBeNull();
  });
});

describe('checkEmbeddability — with API key', () => {
  it('returns embeddable=true when API responds OK with embeddable: true', async () => {
    mockJson(() => ({
      status: 200,
      body: {
        items: [
          { id: 'aaa', status: { embeddable: true, privacyStatus: 'public', license: 'youtube' } },
          { id: 'bbb', status: { embeddable: false, privacyStatus: 'public' } },
          { id: 'ccc', status: { embeddable: true, privacyStatus: 'private' } },
        ],
      },
    }));
    const r = await checkEmbeddability(['aaa', 'bbb', 'ccc']);
    expect(r.get('aaa')?.embeddable).toBe(true);
    expect(r.get('bbb')?.embeddable).toBe(false);
    // private privacyStatus → not really embeddable
    expect(r.get('ccc')?.embeddable).toBe(false);
  });

  it('treats missing IDs in response as not-embeddable', async () => {
    mockJson(() => ({
      status: 200,
      body: { items: [{ id: 'aaa', status: { embeddable: true, privacyStatus: 'public' } }] },
    }));
    const r = await checkEmbeddability(['aaa', 'missing']);
    expect(r.get('aaa')?.embeddable).toBe(true);
    expect(r.get('missing')?.embeddable).toBe(false);
  });

  it('reuses cache on second call for same id', async () => {
    const fn = mockJson(() => ({
      status: 200,
      body: { items: [{ id: 'aaa', status: { embeddable: true, privacyStatus: 'public' } }] },
    }));
    await checkEmbeddability(['aaa']);
    await checkEmbeddability(['aaa']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully on HTTP 429 (rate limit)', async () => {
    mockJson(() => ({ status: 429, body: {} }));
    const r = await checkEmbeddability(['aaa', 'bbb']);
    expect(r.get('aaa')?.embeddable).toBe(true);
    expect(r.get('aaa')?.unverified).toBe(true);
    expect(r.get('bbb')?.embeddable).toBe(true);
    expect(r.get('bbb')?.unverified).toBe(true);
  });

  it('records a quota call per network request', async () => {
    mockJson(() => ({
      status: 200,
      body: { items: [{ id: 'aaa', status: { embeddable: true, privacyStatus: 'public' } }] },
    }));
    const before = getQuotaSnapshot().units_24h;
    await checkEmbeddability(['aaa']);
    const after = getQuotaSnapshot().units_24h;
    expect(after).toBeGreaterThan(before);
  });

  it('handles empty input as no-op', async () => {
    const fn = mockJson(() => ({ status: 200, body: { items: [] } }));
    const r = await checkEmbeddability([]);
    expect(r.size).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('isEmbeddabilityEnabled reflects YOUTUBE_API_KEY state', () => {
    expect(isEmbeddabilityEnabled()).toBe(true);
    delete process.env['YOUTUBE_API_KEY'];
    expect(isEmbeddabilityEnabled()).toBe(false);
  });
});

describe('checkEmbeddability — without API key', () => {
  it('returns all-true with unverified flag when YOUTUBE_API_KEY is unset', async () => {
    delete process.env['YOUTUBE_API_KEY'];
    const fn = mockJson(() => ({ status: 200, body: { items: [] } }));
    const r = await checkEmbeddability(['aaa', 'bbb']);
    expect(r.get('aaa')?.embeddable).toBe(true);
    expect(r.get('aaa')?.unverified).toBe(true);
    expect(r.get('bbb')?.embeddable).toBe(true);
    // No fetch call when key missing.
    expect(fn).not.toHaveBeenCalled();
  });
});
