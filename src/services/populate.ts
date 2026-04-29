/**
 * populate.ts — TheSportsDB → Postgres bulk populator
 *
 * Walks the 5 leagues (NBA / NFL / MLB / NHL / MLS) and idempotently fills
 * the typed reference tables defined in schema.sql:
 *   leagues → seasons → teams → players → games → standings → venues
 *
 * Data NOT populated here (see DATA_ARCHITECTURE.md flag list):
 *   - player_game_stats (box scores) — requires ESPN layer or manual mapping
 *   - players.photo_url            — §2A.B forbids SportsDB cutouts
 *   - teams.brand_pack_url         — §2A.C requires owned abstract marks
 *   - venues.skyline_url           — §1 prefers owned skyline photography
 *
 * Run via:
 *   cd server && npm run populate            # full run
 *   cd server && npm run populate -- --skip-players  # teams + games only
 */

import { supabase } from '../db/client.js';
import {
  lookupAllTeams,
  lookupAllPlayers,
  lookupPlayer,
  getEventsNextLeague,
  getEventsPastLeague,
  getStandings,
  getEventStats,
  type SportsDbTeam,
  type SportsDbPlayer,
  type SportsDbEvent,
  type SportsDbStanding,
  type SportsDbEventStat,
} from './sportsdb.js';

// ─── League configuration (fixed 5-row reference data) ─────────────────────

interface LeagueDef {
  external_id: string;
  acronym: 'NBA' | 'NFL' | 'MLB' | 'NHL' | 'MLS';
  name: string;
  generic_name: string;       // §2A editorial name
  category: 'basketball' | 'football' | 'baseball' | 'hockey' | 'soccer';
  country: string;
  current_season: string;
}

const LEAGUES: LeagueDef[] = [
  { external_id: '4387', acronym: 'NBA', name: 'NBA',                generic_name: 'Pro Basketball', category: 'basketball', country: 'USA', current_season: '2025-2026' },
  { external_id: '4391', acronym: 'NFL', name: 'NFL',                generic_name: 'Pro Football',   category: 'football',   country: 'USA', current_season: '2025-2026' },
  { external_id: '4424', acronym: 'MLB', name: 'MLB',                generic_name: 'Pro Baseball',   category: 'baseball',   country: 'USA', current_season: '2026' },
  { external_id: '4380', acronym: 'NHL', name: 'NHL',                generic_name: 'Pro Hockey',     category: 'hockey',     country: 'USA', current_season: '2025-2026' },
  { external_id: '4346', acronym: 'MLS', name: 'MLS',                generic_name: 'Pro Soccer',     category: 'soccer',     country: 'USA', current_season: '2026' },
];

// ─── Helper: rate-limited iteration (TheSportsDB v2 caps ~30 req/min) ─────

const REQUEST_DELAY_MS = 250; // 4 req/sec — well under the cap

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Stage 1: leagues + seasons ────────────────────────────────────────────

async function populateLeagues(): Promise<Record<string, string>> {
  console.log('[populate] Stage 1/5 — leagues + seasons');
  const leagueIdByAcronym: Record<string, string> = {};

  for (const league of LEAGUES) {
    const { data, error } = await supabase
      .from('leagues')
      .upsert(
        {
          external_id: league.external_id,
          acronym: league.acronym,
          name: league.name,
          generic_name: league.generic_name,
          category: league.category,
          country: league.country,
          current_season: league.current_season,
        },
        { onConflict: 'external_id' },
      )
      .select('id')
      .single();

    if (error || !data) {
      console.error(`[populate]  league ${league.acronym} failed:`, error?.message);
      continue;
    }
    leagueIdByAcronym[league.acronym] = data.id as string;

    // Upsert current season as is_current.
    const { error: seasonErr } = await supabase
      .from('seasons')
      .upsert(
        {
          league_id: data.id,
          season_label: league.current_season,
          is_current: true,
        },
        { onConflict: 'league_id,season_label' },
      );
    if (seasonErr) {
      console.warn(`[populate]  season for ${league.acronym} failed:`, seasonErr.message);
    }

    console.log(`[populate]   ✓ ${league.acronym} → ${data.id}`);
  }

  return leagueIdByAcronym;
}

// ─── Stage 2: teams ────────────────────────────────────────────────────────

interface TeamRow {
  external_id: string;
  league_id: string;
  category: LeagueDef['category'];
  name: string;
  city: string | null;
  full_name: string;
  abbreviation: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  meta_json: Record<string, unknown>;
  last_synced: string;
}

function teamRowFromSportsDb(t: SportsDbTeam, league: LeagueDef, leagueId: string): TeamRow {
  // SportsDB returns full name in strTeam; "Los Angeles Lakers" splits to city + name.
  // Heuristic: last 1-2 words = team name. Not perfect — flagged in meta_json.
  const parts = t.strTeam.trim().split(' ');
  const teamName = parts.length >= 2 ? parts.slice(-1)[0] : t.strTeam;
  const city = parts.length >= 2 ? parts.slice(0, -1).join(' ') : null;

  return {
    external_id: t.idTeam,
    league_id: leagueId,
    category: league.category,
    name: teamName,
    city,
    full_name: t.strTeam,
    abbreviation: t.strTeamShort ?? null,
    primary_color: t.strColour1 ?? null,
    secondary_color: t.strColour2 ?? null,
    // §2A: we deliberately do NOT store strBadge / strLogo here.
    // brand_pack_url stays null until owned-asset pipeline lands.
    meta_json: {
      sportsdb_league: t.strLeague,
      heuristic_split: parts.length >= 2,
    },
    last_synced: new Date().toISOString(),
  };
}

async function populateTeams(
  leagueIdByAcronym: Record<string, string>,
): Promise<Map<string, string>> {
  console.log('[populate] Stage 2/5 — teams');
  const dbTeamIdByExternalId = new Map<string, string>();

  for (const league of LEAGUES) {
    const leagueId = leagueIdByAcronym[league.acronym];
    if (!leagueId) continue;

    let teams: SportsDbTeam[];
    try {
      teams = await lookupAllTeams(league.external_id);
    } catch (err) {
      console.error(`[populate]  ${league.acronym} team lookup failed:`, err);
      continue;
    }
    await sleep(REQUEST_DELAY_MS);

    if (teams.length === 0) {
      console.warn(`[populate]   ${league.acronym}: no teams returned`);
      continue;
    }

    const rows = teams.map(t => teamRowFromSportsDb(t, league, leagueId));
    const { data, error } = await supabase
      .from('teams')
      .upsert(rows, { onConflict: 'external_id' })
      .select('id, external_id');

    if (error) {
      console.error(`[populate]   ${league.acronym} teams upsert failed:`, error.message);
      continue;
    }

    for (const row of data ?? []) {
      dbTeamIdByExternalId.set(row.external_id as string, row.id as string);
    }
    console.log(`[populate]   ✓ ${league.acronym}: ${rows.length} teams`);
  }

  return dbTeamIdByExternalId;
}

// ─── Stage 3: players (with full bio enrichment) ──────────────────────────

interface PlayerRow {
  external_id: string;
  team_id: string | null;
  category: LeagueDef['category'];
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  jersey_number: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  date_of_birth: string | null;
  nationality: string | null;
  // §2A.B: photo_url stays NULL on populate.
  photo_url: null;
  meta_json: Record<string, unknown>;
  last_synced: string;
}

// ── Bio parsing helpers ────────────────────────────────────────────────────

/** Parses TheSportsDB height strings into centimeters. Tries patterns in
 *  preference order — metric is always more accurate than imperial because
 *  imperial loses precision when SportsDB rounded to whole inches. Handles:
 *    "203 cm"                 → 203
 *    "190cm"                  → 190
 *    "1.93 m"                 → 193
 *    "6 ft 8 in"              → 203
 *    "6'8\""                  → 203
 *    "6' 4\""                 → 193   (space inside imperial)
 *    "6 ft 6 in (1.98 m)"     → 198   (prefers parenthesized metric)
 *    "190 cm (6 ft 3 in)"     → 190
 *  Returns null on unrecognized format.
 */
export function parseHeightToCm(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // 1) Prefer metric appearing anywhere in the string. Some SportsDB rows
  //    have "6 ft 6 in (1.98 m)"; the parenthesized metric is the source of
  //    truth and we should snap to it.
  const m = s.match(/(\d+(?:\.\d+)?)\s*m\b/);
  if (m) {
    const v = parseFloat(m[1]);
    if (v >= 1.2 && v <= 2.4) return Math.round(v * 100);
  }
  const cm = s.match(/(\d+(?:\.\d+)?)\s*cm\b/);
  if (cm) {
    const v = parseFloat(cm[1]);
    if (v >= 120 && v <= 240) return Math.round(v);
  }

  // 2) Imperial: "6 ft 8 in" / "6 ft 8" / "6'8" / "6' 8\"" — also tolerates
  //    trailing parenthesized metric annotation we already tried above.
  const ftIn = s.match(/(\d+)\s*(?:ft|')\s*(\d+)?\s*(?:in|")?/);
  if (ftIn) {
    const ft = parseInt(ftIn[1], 10);
    const inch = ftIn[2] ? parseInt(ftIn[2], 10) : 0;
    if (ft >= 4 && ft <= 8) return Math.round(ft * 30.48 + inch * 2.54);
  }
  return null;
}

/** Parses TheSportsDB weight strings into kilograms. Tries metric first.
 *  Handles:
 *    "102 kg" / "102kg"          → 102
 *    "224 lbs" / "224 lb"        → 102
 *    "225 lb (102 kg)"           → 102 (parenthesized metric wins)
 *    "78.46kg"                   → 78
 *    "152 lbs"                   → 69
 *    "190" (bare — assume lbs)   → 86
 *  Returns null on unrecognized format.
 */
export function parseWeightToKg(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  // 1) Metric first
  const kg = s.match(/(\d+(?:\.\d+)?)\s*kg\b/);
  if (kg) {
    const v = parseFloat(kg[1]);
    if (v >= 30 && v <= 250) return Math.round(v);
  }
  // 2) Imperial — accept lb / lbs / pounds
  const lbs = s.match(/(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/);
  if (lbs) {
    const v = parseFloat(lbs[1]);
    if (v >= 60 && v <= 500) return Math.round(v * 0.453592);
  }
  // 3) Bare number — SportsDB US-sports convention is pounds
  const bare = s.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) {
    const v = parseFloat(bare[1]);
    if (v >= 60 && v <= 500) return Math.round(v * 0.453592);
  }
  return null;
}

function playerRowFromSportsDb(
  p: SportsDbPlayer,
  league: LeagueDef,
  teamDbId: string | null,
): PlayerRow {
  const nameParts = p.strPlayer.trim().split(' ');
  const firstName = nameParts[0] ?? null;
  const lastName = nameParts.slice(1).join(' ') || null;
  const jersey = p.strNumber ? parseInt(p.strNumber, 10) : null;

  return {
    external_id: p.idPlayer,
    team_id: teamDbId,
    category: league.category,
    full_name: p.strPlayer,
    first_name: firstName,
    last_name: lastName,
    position: p.strPosition ?? null,
    jersey_number: Number.isFinite(jersey) ? jersey : null,
    height_cm: parseHeightToCm(p.strHeight),
    weight_kg: parseWeightToKg(p.strWeight),
    date_of_birth: p.dateBorn ?? null,
    nationality: p.strNationality ?? null,
    photo_url: null,
    meta_json: {
      // Bio fields the Scouting Report renders directly:
      college: p.strCollege ?? null,
      birth_location: p.strBirthLocation ?? null,
      description: p.strDescriptionEN ?? null,
      signing_year: p.strSigning ?? null,
      handedness: p.strHandedness ?? null,
      side: p.strSide ?? null,
      status: p.strStatus ?? null,
      raw_height: p.strHeight ?? null,   // keep raw for debugging
      raw_weight: p.strWeight ?? null,
      // sportsdb_thumb / sportsdb_cutout intentionally omitted (§2A.B).
    },
    last_synced: new Date().toISOString(),
  };
}

interface PopulatePlayersOpts {
  /** When true, after the team-level list each player is enriched via
   *  /lookup/player/{id} to fetch height/weight/description fields that
   *  /list/players omits. ~3.5x slower but produces full Scouting Report
   *  data. Default: true. */
  enrich?: boolean;
}

async function populatePlayers(opts: PopulatePlayersOpts = {}): Promise<void> {
  const enrich = opts.enrich ?? true;
  console.log(`[populate] Stage 3 — players${enrich ? ' (enriched bio)' : ''}`);
  let totalPlayers = 0;
  let totalEnriched = 0;

  for (const league of LEAGUES) {
    const { data: teamsForLeague, error } = await supabase
      .from('teams')
      .select('id, external_id, full_name')
      .eq('category', league.category);

    if (error || !teamsForLeague) {
      console.error(`[populate]  ${league.acronym} team list fetch failed:`, error?.message);
      continue;
    }

    let leaguePlayerCount = 0;
    for (const team of teamsForLeague) {
      let players: SportsDbPlayer[];
      try {
        players = await lookupAllPlayers(team.external_id as string);
      } catch (err) {
        console.warn(`[populate]   ${team.full_name}: player lookup failed`, err);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
      await sleep(REQUEST_DELAY_MS);

      if (players.length === 0) continue;

      // ── Optional per-player enrichment ──
      // /list/players omits height/weight/description on most leagues.
      // /lookup/player/{id} returns the full bio.
      if (enrich) {
        const enriched: SportsDbPlayer[] = [];
        for (const p of players) {
          try {
            const full = await lookupPlayer(p.idPlayer);
            enriched.push(full ? { ...p, ...full } : p);
            if (full) totalEnriched++;
          } catch {
            enriched.push(p);
          }
          await sleep(REQUEST_DELAY_MS);
        }
        players = enriched;
      }

      const rows = players.map(p => playerRowFromSportsDb(p, league, team.id as string));

      // Upsert in chunks of 100 to stay under Supabase request size limits.
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        const { error: playerErr } = await supabase
          .from('players')
          .upsert(chunk, { onConflict: 'external_id' });
        if (playerErr) {
          console.warn(`[populate]   ${team.full_name}: chunk upsert failed`, playerErr.message);
        }
      }

      leaguePlayerCount += rows.length;
      process.stdout.write(`[populate]   ${league.acronym}/${team.full_name}: ${rows.length} players\r`);
    }

    console.log(`[populate]   ✓ ${league.acronym}: ${leaguePlayerCount} players                   `);
    totalPlayers += leaguePlayerCount;
  }

  console.log(`[populate] Stage 3 complete: ${totalPlayers} total players, ${totalEnriched} enriched`);
}

// ─── Stage 4: games ────────────────────────────────────────────────────────

async function populateGames(): Promise<void> {
  console.log('[populate] Stage 4/5 — games (next + past windows per league)');

  // Fetch league + season ids in one pass.
  const { data: leagueRows } = await supabase
    .from('leagues')
    .select('id, external_id, acronym, category');
  const { data: seasonRows } = await supabase
    .from('seasons')
    .select('id, league_id, season_label, is_current')
    .eq('is_current', true);

  if (!leagueRows || !seasonRows) {
    console.error('[populate]  cannot resolve leagues/seasons for games stage');
    return;
  }

  const seasonIdByLeagueId = new Map<string, string>();
  for (const s of seasonRows) seasonIdByLeagueId.set(s.league_id as string, s.id as string);

  // Fetch team ids in one pass to map external → db.
  const { data: teamRows } = await supabase
    .from('teams')
    .select('id, external_id');
  const teamIdByExt = new Map<string, string>();
  for (const t of teamRows ?? []) teamIdByExt.set(t.external_id as string, t.id as string);

  for (const league of leagueRows) {
    const leagueExtId = league.external_id as string;
    const leagueDbId = league.id as string;
    const seasonDbId = seasonIdByLeagueId.get(leagueDbId) ?? null;

    let events: SportsDbEvent[] = [];
    try {
      const [next, past] = await Promise.all([
        getEventsNextLeague(leagueExtId),
        getEventsPastLeague(leagueExtId),
      ]);
      events = [...next, ...past];
    } catch (err) {
      console.error(`[populate]  ${league.acronym} games fetch failed:`, err);
      continue;
    }
    await sleep(REQUEST_DELAY_MS);

    if (events.length === 0) {
      console.warn(`[populate]   ${league.acronym}: no games`);
      continue;
    }

    const rows = events.map(e => ({
      external_id: e.idEvent,
      league_id: leagueDbId,
      season_id: seasonDbId,
      category: league.category as LeagueDef['category'],
      date_event: e.dateEvent ?? null,
      time_event: e.strTime ?? null,
      starts_at: e.strTimestamp ?? null,
      status: deriveGameStatus(e),
      home_team_id: e.idHomeTeam ? teamIdByExt.get(e.idHomeTeam) ?? null : null,
      away_team_id: e.idAwayTeam ? teamIdByExt.get(e.idAwayTeam) ?? null : null,
      home_score: e.intHomeScore != null ? Number(e.intHomeScore) : null,
      away_score: e.intAwayScore != null ? Number(e.intAwayScore) : null,
      meta_json: { venue: e.strVenue ?? null },
      last_synced: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from('games')
      .upsert(rows, { onConflict: 'external_id' });
    if (error) {
      console.error(`[populate]   ${league.acronym} games upsert failed:`, error.message);
      continue;
    }

    console.log(`[populate]   ✓ ${league.acronym}: ${rows.length} games`);
  }
}

function deriveGameStatus(e: SportsDbEvent): 'scheduled' | 'live' | 'final' | 'postponed' | 'cancelled' {
  if (e.strPostponed === 'yes') return 'postponed';
  const status = (e.strStatus ?? '').toLowerCase();
  if (status.includes('final') || status === 'ft' || status === 'aot') return 'final';
  if (status.includes('live') || status.includes('progress') || status === '1h' || status === '2h') return 'live';
  if (status.includes('cancel')) return 'cancelled';
  // If both scores are populated, treat as final.
  if (e.intHomeScore != null && e.intAwayScore != null) return 'final';
  return 'scheduled';
}

// ─── Stage 5: standings ────────────────────────────────────────────────────

async function populateStandings(): Promise<void> {
  console.log('[populate] Stage 5/5 — standings');

  const { data: leagueRows } = await supabase
    .from('leagues')
    .select('id, external_id, acronym, current_season');
  const { data: seasonRows } = await supabase
    .from('seasons')
    .select('id, league_id, season_label')
    .eq('is_current', true);
  const { data: teamRows } = await supabase
    .from('teams')
    .select('id, external_id');

  if (!leagueRows || !teamRows) {
    console.error('[populate]  cannot resolve leagues/teams for standings');
    return;
  }

  const seasonIdByLeagueId = new Map<string, string>();
  for (const s of seasonRows ?? []) seasonIdByLeagueId.set(s.league_id as string, s.id as string);

  const teamIdByExt = new Map<string, string>();
  for (const t of teamRows) teamIdByExt.set(t.external_id as string, t.id as string);

  for (const league of leagueRows) {
    const seasonLabel = league.current_season as string;
    let standings: SportsDbStanding[] = [];
    try {
      standings = await getStandings(league.external_id as string, seasonLabel);
    } catch (err) {
      console.warn(`[populate]   ${league.acronym} standings fetch failed:`, err);
      continue;
    }
    await sleep(REQUEST_DELAY_MS);

    if (standings.length === 0) {
      console.warn(`[populate]   ${league.acronym}: no standings (off-season?)`);
      continue;
    }

    const rows = standings
      .map(s => {
        const teamDbId = teamIdByExt.get(s.idTeam);
        if (!teamDbId) return null;
        return {
          league_id: league.id as string,
          season_id: seasonIdByLeagueId.get(league.id as string) ?? null,
          team_id: teamDbId,
          rank: s.intRank ? Number(s.intRank) : null,
          played: s.intPlayed ? Number(s.intPlayed) : null,
          wins: s.intWin ? Number(s.intWin) : null,
          losses: s.intLoss ? Number(s.intLoss) : null,
          draws: s.intDraw ? Number(s.intDraw) : null,
          goals_for: s.intGoalsFor ? Number(s.intGoalsFor) : null,
          goals_against: s.intGoalsAgainst ? Number(s.intGoalsAgainst) : null,
          goal_difference: s.intGoalDifference ? Number(s.intGoalDifference) : null,
          points: s.intPoints ? Number(s.intPoints) : null,
          form: s.strForm ?? null,
          last_synced: new Date().toISOString(),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const { error } = await supabase
      .from('standings')
      .upsert(rows, { onConflict: 'season_id,team_id' });
    if (error) {
      console.error(`[populate]   ${league.acronym} standings upsert failed:`, error.message);
      continue;
    }

    console.log(`[populate]   ✓ ${league.acronym}: ${rows.length} standings`);
  }
}

// ─── Stage 6: per-game player stats (drives season totals + career highs) ──

/** Convert SportsDB raw stat row to our normalized stats_json bag.
 *  Strips id-* fields and empty values; coerces numeric fields. */
function normalizeStatRow(s: SportsDbEventStat): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v == null || v === '') continue;
    if (k.startsWith('idEvent') || k === 'idPlayer' || k === 'idTeam') continue;
    if (k === 'strPlayer' || k === 'strTeam') continue;
    // Coerce numerics where possible.
    if (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v)) {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Crude per-sport fantasy-point computation. The Scout's score is the SUM
 *  of these across all games in a roster. Tuned for "kid-friendly":
 *    NBA: 1*pts + 1.2*reb + 1.5*ast + 3*stl + 3*blk - 1*to
 *    NFL: 0.04*passYds + 4*passTd - 1*int + 0.1*rushYds + 6*rushTd
 *         + 0.1*recYds + 6*recTd
 *    MLB: 1*hits + 2*hr + 1*rbi + 1*runs + 1*sb (batters);
 *         5*win + 0.5*so - 1*er (pitchers)
 *    NHL: 2*goals + 1*assists + 0.5*shots
 *    MLS: 4*goals + 2*assists - 1*yc - 3*rc
 *  Falls back to 0 when stats_json doesn't carry the relevant fields.
 */
function computeFantasyPoints(
  category: LeagueDef['category'],
  stats: Record<string, number | string>,
): number {
  const num = (k: string) => (typeof stats[k] === 'number' ? (stats[k] as number) : 0);
  switch (category) {
    case 'basketball':
      return num('intPoints') + 1.2 * num('intRebounds') + 1.5 * num('intAssists')
        + 3 * num('intSteals') + 3 * num('intBlocks') - num('intTurnovers');
    case 'football':
      return 0.04 * num('intPassingYards') + 4 * num('intPassingTouchdowns')
        - num('intInterceptions')
        + 0.1 * num('intRushingYards') + 6 * num('intRushingTouchdowns')
        + 0.1 * num('intReceivingYards') + 6 * num('intReceivingTouchdowns');
    case 'baseball': {
      const batting = num('intHits') + 2 * num('intHomeRuns') + num('intRBIs')
        + num('intRuns') + num('intStolenBases');
      const pitching = 5 * num('intWins') + 0.5 * num('intStrikeouts') - num('intEarnedRuns');
      return batting + pitching;
    }
    case 'hockey':
      return 2 * num('intGoals') + num('intAssists') + 0.5 * num('intShots');
    case 'soccer':
      return 4 * num('intGoals') + 2 * num('intAssists')
        - num('intYellowCards') - 3 * num('intRedCards');
    default:
      return 0;
  }
}

interface PopulateGameStatsOpts {
  /** How many recent (status='final') games per league to pull stats for.
   *  SportsDB rate limits make full-season pulls expensive; default 30
   *  per league = 150 games × ~25 stat rows ≈ 3,750 rows total. */
  recentGamesPerLeague?: number;
}

async function populateGameStats(opts: PopulateGameStatsOpts = {}): Promise<void> {
  const recentLimit = opts.recentGamesPerLeague ?? 30;
  console.log(`[populate] Stage 6 — player_game_stats (last ${recentLimit} final games per league)`);

  const { data: playerRows } = await supabase
    .from('players')
    .select('id, external_id');
  const playerIdByExt = new Map<string, string>();
  for (const p of playerRows ?? []) playerIdByExt.set(p.external_id as string, p.id as string);

  const { data: teamRows } = await supabase
    .from('teams')
    .select('id, external_id');
  const teamIdByExt = new Map<string, string>();
  for (const t of teamRows ?? []) teamIdByExt.set(t.external_id as string, t.id as string);

  const { data: leagueRows } = await supabase
    .from('leagues')
    .select('id, acronym, category');
  if (!leagueRows) {
    console.error('[populate]  cannot resolve leagues for game stats');
    return;
  }

  let totalStatRows = 0;
  let gamesProcessed = 0;
  let gamesWithStats = 0;

  for (const league of leagueRows) {
    const { data: games } = await supabase
      .from('games')
      .select('id, external_id, date_event')
      .eq('league_id', league.id as string)
      .eq('status', 'final')
      .order('date_event', { ascending: false })
      .limit(recentLimit);

    if (!games || games.length === 0) {
      console.warn(`[populate]   ${league.acronym}: no final games yet`);
      continue;
    }

    let leagueRowCount = 0;
    for (const game of games) {
      gamesProcessed++;
      let stats: SportsDbEventStat[] = [];
      try {
        stats = await getEventStats(game.external_id as string);
      } catch {
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
      await sleep(REQUEST_DELAY_MS);

      if (stats.length === 0) continue;
      gamesWithStats++;

      const rows = stats
        .map(s => {
          if (!s.idPlayer) return null;
          const playerDbId = playerIdByExt.get(s.idPlayer);
          if (!playerDbId) return null;
          const teamDbId = s.idTeam ? teamIdByExt.get(s.idTeam) ?? null : null;
          const normalized = normalizeStatRow(s);
          const fp = computeFantasyPoints(league.category as LeagueDef['category'], normalized);
          const minutes = typeof normalized['intMinutes'] === 'number'
            ? (normalized['intMinutes'] as number)
            : null;
          return {
            game_id: game.id as string,
            player_id: playerDbId,
            team_id: teamDbId,
            game_date: game.date_event as string,
            minutes_played: minutes,
            fantasy_points: Math.round(fp * 100) / 100,
            did_play: minutes == null ? true : minutes > 0,
            stats_json: normalized,
            source: 'sportsdb',
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (rows.length === 0) continue;

      // Chunked upsert.
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        const { error } = await supabase
          .from('player_game_stats')
          .upsert(chunk, { onConflict: 'game_id,player_id' });
        if (error) {
          console.warn(`[populate]   ${league.acronym} stat chunk failed:`, error.message);
        }
      }
      leagueRowCount += rows.length;
    }

    console.log(`[populate]   ✓ ${league.acronym}: ${leagueRowCount} stat rows from ${games.length} games`);
    totalStatRows += leagueRowCount;
  }

  console.log(
    `[populate] Stage 6 complete: ${totalStatRows} player_game_stats rows ` +
    `(${gamesWithStats}/${gamesProcessed} games returned eventstats)`,
  );
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export interface PopulateOptions {
  skipPlayers?: boolean;
  skipGames?: boolean;
  skipStandings?: boolean;
  skipGameStats?: boolean;
  /** Skip the per-player /lookup/player enrichment pass. Faster but loses
   *  height/weight/description on most leagues. Default: false. */
  skipPlayerEnrichment?: boolean;
  /** How many recent final games per league to pull box-score stats for. */
  recentGamesPerLeague?: number;
}

export async function populate(opts: PopulateOptions = {}): Promise<void> {
  const t0 = Date.now();
  console.log('[populate] Starting full SportsDB → Postgres populate');

  const leagueIdByAcronym = await populateLeagues();
  await populateTeams(leagueIdByAcronym);

  if (!opts.skipPlayers) {
    await populatePlayers({ enrich: !opts.skipPlayerEnrichment });
  } else console.log('[populate] Stage 3 SKIPPED (--skip-players)');

  if (!opts.skipGames) await populateGames();
  else console.log('[populate] Stage 4 SKIPPED (--skip-games)');

  if (!opts.skipStandings) await populateStandings();
  else console.log('[populate] Stage 5 SKIPPED (--skip-standings)');

  if (!opts.skipGameStats) {
    await populateGameStats({ recentGamesPerLeague: opts.recentGamesPerLeague });
  } else console.log('[populate] Stage 6 SKIPPED (--skip-game-stats)');

  // Refresh aggregates.
  try {
    await supabase.rpc('refresh_materialized_views');
    console.log('[populate] Materialized views refreshed');
  } catch (err) {
    console.warn('[populate] MV refresh failed (safe to ignore on first run):', err);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[populate] Done in ${elapsed}s`);
}
