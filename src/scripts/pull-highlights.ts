/**
 * pull-highlights.ts — backfill SportsDB premium YouTube highlight URLs
 * into players.meta_json and teams.meta_json.
 *
 * Players:
 *   - For every player with a non-null `external_id` (= TheSportsDB
 *     idPlayer), call `lookupPlayer` and write
 *     `meta_json.video_highlight_url` when SportsDB has one.
 *   - Skip rows that already have a value unless --force is passed.
 *
 * Teams:
 *   - For every team with a non-null `external_id` (= idTeam), pull the
 *     last N events with strVideo and write
 *     `meta_json.recent_highlights` as
 *     `[{event_id, event_name, video_url, played_on}]` (newest first).
 *   - Also writes `meta_json.video_highlight_url` to the most recent
 *     event's URL so the existing /admin/edit/teams editor (which
 *     already renders this field) shows a value out-of-the-box.
 *
 * Both writes set `meta_json.video_highlight_pulled_at = nowISO()` so
 * the daily cron can skip rows refreshed in the last N days.
 *
 * Usage:
 *   npm run pull:highlights                     # idempotent, players + teams
 *   npm run pull:highlights -- --force          # overwrite existing values
 *   npm run pull:highlights -- --players-only   # skip teams loop
 *   npm run pull:highlights -- --teams-only     # skip players loop
 *   npm run pull:highlights -- --max-age-days=30  # only refresh rows older than N days
 *   npm run pull:highlights -- --league=NFL     # restrict to one league
 *   npm run pull:highlights -- --limit=200      # cap items processed (debugging)
 */
import 'dotenv/config';
import { supabase } from '../db/client.js';
import {
  fetchPlayerHighlight,
  fetchTeamHighlights,
} from '../services/sportsdb/highlights.js';
import {
  refreshTeamPlaylist,
  refreshPlayerPlaylist,
  type PlaylistEntry,
} from '../services/highlights/playlistResolver.js';
import { isEmbeddabilityEnabled } from '../services/youtube/embeddability.js';

interface CliOpts {
  force: boolean;
  playersOnly: boolean;
  teamsOnly: boolean;
  maxAgeDays: number;
  league: string | null;
  limit: number | null;
  perTeamHighlights: number;
  delayMs: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    force: false,
    playersOnly: false,
    teamsOnly: false,
    maxAgeDays: 30,
    league: null,
    limit: null,
    perTeamHighlights: 3,
    delayMs: 200,
  };
  for (const a of argv) {
    if (a === '--force') opts.force = true;
    else if (a === '--players-only') opts.playersOnly = true;
    else if (a === '--teams-only') opts.teamsOnly = true;
    else if (a.startsWith('--max-age-days=')) opts.maxAgeDays = Number(a.split('=')[1]);
    else if (a.startsWith('--league=')) opts.league = String(a.split('=')[1]).toUpperCase();
    else if (a.startsWith('--limit=')) opts.limit = Number(a.split('=')[1]);
    else if (a.startsWith('--per-team=')) opts.perTeamHighlights = Number(a.split('=')[1]);
    else if (a.startsWith('--delay-ms=')) opts.delayMs = Number(a.split('=')[1]);
  }
  return opts;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LEAGUE_TO_CATEGORY: Record<string, string> = {
  NBA: 'basketball',
  NFL: 'football',
  MLB: 'baseball',
  NHL: 'hockey',
  MLS: 'soccer',
};

function shouldRefresh(meta: Record<string, unknown> | null, opts: CliOpts): boolean {
  if (opts.force) return true;
  if (!meta) return true;
  const url = meta['video_highlight_url'];
  if (!url || typeof url !== 'string') return true;
  const pulledAt = meta['video_highlight_pulled_at'];
  if (typeof pulledAt !== 'string') return false; // has URL but no timestamp — leave alone
  const ageMs = Date.now() - Date.parse(pulledAt);
  return ageMs > opts.maxAgeDays * 24 * 60 * 60 * 1000;
}

interface PlayerRow {
  id: string;
  external_id: string | null;
  full_name: string | null;
  category: string | null;
  team_id: string | null;
  meta_json: Record<string, unknown> | null;
}

interface TeamRow {
  id: string;
  external_id: string | null;
  full_name: string | null;
  name: string | null;
  category: string | null;
  meta_json: Record<string, unknown> | null;
}

async function pullPlayers(opts: CliOpts): Promise<{ processed: number; updated: number }> {
  console.log('[pull-highlights] Loading players from Supabase…');
  let q = supabase
    .from('players')
    .select('id, external_id, full_name, category, team_id, meta_json')
    .not('external_id', 'is', null);
  if (opts.league && LEAGUE_TO_CATEGORY[opts.league]) {
    q = q.eq('category', LEAGUE_TO_CATEGORY[opts.league]);
  }
  const { data, error } = await q.returns<PlayerRow[]>();
  if (error) {
    console.error(`[pull-highlights] players query failed: ${error.message}`);
    return { processed: 0, updated: 0 };
  }
  const players = data ?? [];
  const total = opts.limit != null ? Math.min(players.length, opts.limit) : players.length;
  console.log(`[pull-highlights] ${total} players to consider (of ${players.length} with external_id)`);

  let processed = 0;
  let updated = 0;
  let lastLog = Date.now();

  // Track playlist length so we can report avg per league.
  const playlistLengths: number[] = [];

  for (let i = 0; i < total; i++) {
    const p = players[i];
    if (!p.external_id) continue;
    processed++;
    if (!shouldRefresh(p.meta_json, opts)) continue;

    const { youtube_url } = await fetchPlayerHighlight(p.external_id);
    let playlist: PlaylistEntry[] = [];
    if (youtube_url) {
      // Step 1: write the curated single-URL field (back-compat).
      const meta = { ...(p.meta_json ?? {}), video_highlight_url: youtube_url, video_highlight_pulled_at: new Date().toISOString() };
      const { error: uerr } = await supabase.from('players').update({ meta_json: meta }).eq('id', p.id);
      if (uerr) {
        console.warn(`[pull-highlights]   players ${p.full_name} update failed: ${uerr.message}`);
      } else {
        updated++;
        // Step 2: also resolve the new highlight_playlist (writes its
        // own field). Reads the freshest meta_json by re-passing the
        // updated version.
        playlist = await refreshPlayerPlaylist(
          { ...p, meta_json: meta },
          { force: opts.force, limit: 10 },
        );
        playlistLengths.push(playlist.length);
      }
    }

    if (Date.now() - lastLog > 5000) {
      const lg = (p.category ?? '?').toUpperCase().slice(0, 3);
      const avgPl = playlistLengths.length
        ? (playlistLengths.reduce((a, b) => a + b, 0) / playlistLengths.length).toFixed(1)
        : '0';
      console.log(`  [${lg}] processed ${i + 1}/${total} players, ${updated} highlights found, avg playlist=${avgPl}`);
      lastLog = Date.now();
    }
    await sleep(opts.delayMs);
  }
  const avgPlaylist = playlistLengths.length
    ? playlistLengths.reduce((a, b) => a + b, 0) / playlistLengths.length
    : 0;
  console.log(
    `[pull-highlights] players done: ${updated}/${processed} updated, avg playlist length=${avgPlaylist.toFixed(2)}`,
  );
  return { processed, updated };
}

async function pullTeams(opts: CliOpts): Promise<{ processed: number; updated: number }> {
  console.log('[pull-highlights] Loading teams from Supabase…');
  let q = supabase
    .from('teams')
    .select('id, external_id, full_name, name, category, meta_json')
    .not('external_id', 'is', null);
  if (opts.league && LEAGUE_TO_CATEGORY[opts.league]) {
    q = q.eq('category', LEAGUE_TO_CATEGORY[opts.league]);
  }
  const { data, error } = await q.returns<TeamRow[]>();
  if (error) {
    console.error(`[pull-highlights] teams query failed: ${error.message}`);
    return { processed: 0, updated: 0 };
  }
  const teams = data ?? [];
  const total = opts.limit != null ? Math.min(teams.length, opts.limit) : teams.length;
  console.log(`[pull-highlights] ${total} teams to consider`);

  let processed = 0;
  let updated = 0;
  const playlistLengths: number[] = [];

  // Per-league embeddability hit-rate tally (kept-of-candidates).
  const leagueHits: Record<string, { kept: number; candidates: number }> = {};

  for (let i = 0; i < total; i++) {
    const t = teams[i];
    if (!t.external_id) continue;
    processed++;
    if (!shouldRefresh(t.meta_json, opts)) continue;

    // Pull 25 candidates (vs the legacy 3, then 15) so the playlist
    // resolver has ~2.5× headroom against the YouTube embeddability filter
    // for the new 10-card carousel.
    const events = await fetchTeamHighlights(t.external_id, 25);
    if (events.length > 0) {
      const meta = {
        ...(t.meta_json ?? {}),
        // Back-compat: keep the older `recent_highlights` field that
        // the existing modal still reads. Trim to the user-visible 10.
        recent_highlights: events.slice(0, 10),
        video_highlight_url: events[0]?.video_url,
        video_highlight_pulled_at: new Date().toISOString(),
      };
      const { error: uerr } = await supabase.from('teams').update({ meta_json: meta }).eq('id', t.id);
      if (uerr) {
        console.warn(`[pull-highlights]   teams ${t.name} update failed: ${uerr.message}`);
        await sleep(opts.delayMs);
        continue;
      }
      updated++;

      // Resolve the embeddable-filtered playlist, writing it to
      // meta_json.highlight_playlist on the same row.
      const playlist = await refreshTeamPlaylist(
        { ...t, meta_json: meta },
        { force: opts.force, limit: 10 },
      );
      playlistLengths.push(playlist.length);

      // Hit-rate accounting — cap candidates at 25 so the ratio is
      // honest (we never feed more than 25 into the filter).
      const lg = (t.category ?? 'unknown').toLowerCase();
      const cand = Math.min(events.length, 25);
      leagueHits[lg] = leagueHits[lg] ?? { kept: 0, candidates: 0 };
      leagueHits[lg].candidates += cand;
      leagueHits[lg].kept += playlist.length;
    }
    await sleep(opts.delayMs);
    if ((i + 1) % 10 === 0) {
      const lg = (t.category ?? '?').toUpperCase().slice(0, 3);
      console.log(`  [${lg}] processed ${i + 1}/${total} teams, ${updated} highlights found`);
    }
  }
  const avgPlaylist = playlistLengths.length
    ? playlistLengths.reduce((a, b) => a + b, 0) / playlistLengths.length
    : 0;
  console.log(
    `[pull-highlights] teams done: ${updated}/${processed} updated, avg playlist length=${avgPlaylist.toFixed(2)}`,
  );
  for (const [lg, { kept, candidates }] of Object.entries(leagueHits)) {
    const pct = candidates > 0 ? Math.round((kept / candidates) * 100) : 0;
    console.log(`  [${lg.toUpperCase()}] embeddability hit rate: ${kept}/${candidates} = ${pct}%`);
  }
  return { processed, updated };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log('[pull-highlights] config:', JSON.stringify(opts));
  if (!isEmbeddabilityEnabled()) {
    console.warn(
      '[pull-highlights] WARNING: YOUTUBE_API_KEY is not set. The embeddability filter ' +
        'will degrade to "trust everything" — get a key at https://console.cloud.google.com → ' +
        'APIs & Services → Library → YouTube Data API v3 → Enable → Credentials.',
    );
  }
  const t0 = Date.now();

  const results: Record<string, { processed: number; updated: number }> = {};
  if (!opts.teamsOnly) {
    results.players = await pullPlayers(opts);
  }
  if (!opts.playersOnly) {
    results.teams = await pullTeams(opts);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[pull-highlights] DONE in ${elapsed}s`, results);
}

main().catch((err) => {
  console.error('[pull-highlights] FATAL', err);
  process.exit(1);
});
