/**
 * dataCorpus.ts — counts derived from local JSON spec files.
 *
 * These power the "Data Corpus" card on the admin dashboard. Each call
 * re-reads the files (filesystem stat is cheap), but we cache the assembled
 * report for 25s so polling at 30s doesn't beat up the disk.
 *
 * Files are resolved relative to this module so the counts work whether the
 * server is launched from /server or from the project root.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

// Resolve the project root by walking up from the current working directory
// until we find a known sentinel file (data/cards/pgm_card_templates.json).
// This works in both ESM (tsx runtime) and CJS (Jest under babel-jest), since
// `import.meta.url` is not available in CJS.
function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, '..'),
    path.resolve(cwd, '..', '..'),
    path.resolve(cwd, '..', '..', '..'),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'cards', 'pgm_card_templates.json'))) {
      return c;
    }
  }
  // Fall back to cwd — file reads will simply return null and surface a note.
  return cwd;
}
const PROJECT_ROOT = findProjectRoot();

const CACHE_TTL_MS = 25_000;

export interface DataCorpusReport {
  trivia_questions_total: number;
  trivia_by_sport: Record<string, number>;
  card_templates: number;
  card_pack_definitions: number;
  trigger_definitions: number;
  stat_resolution_sports: number;
  city_scenes: number;
  team_count: number;
  nfl_players_in_stat_cache: number | null;
  stat_tier_files: number;
  tier_levels: number;
  scout_voice_lines_seeded: number | null;
  sfx_total: number;
  sfx_enabled: number;
  notes?: string[];
}

export interface LastUpdatedReport {
  scenes_json: string | null;
  trivia_questions: string | null;
  card_templates: string | null;
  stat_cache_nfl: string | null;
  scout_voice_db_latest: string | null;
}

interface Cache<T> {
  value: T;
  expires_at: number;
}

let corpusCache: Cache<DataCorpusReport> | null = null;
let mtimeCache: Cache<LastUpdatedReport> | null = null;

const FILE = {
  cardTemplates: path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_card_templates.json'),
  packs:         path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_packs.json'),
  triggers:      path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_triggers.json'),
  statResolution: path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_stat_resolution.json'),
  scenes:        path.join(PROJECT_ROOT, 'src', 'data', 'scenes.json'),
  nflStatCache:  path.join(PROJECT_ROOT, 'assets', 'stat-cache', 'nfl_season_2025.json'),
  triviaDir:     path.join(PROJECT_ROOT, 'assets', 'challenges'),
  statTiersDir:  path.join(PROJECT_ROOT, 'assets', 'stat-tiers'),
  sfxManifest:   path.join(PROJECT_ROOT, 'data', 'audio', 'pgm_sfx_manifest.json'),
} as const;

const TRIVIA_FILES = [
  { sport: 'NBA', file: 'trivia_basketball.json' },
  { sport: 'NFL', file: 'trivia_football.json' },
  { sport: 'MLB', file: 'trivia_baseball.json' },
  { sport: 'NHL', file: 'trivia_hockey.json' },
  { sport: 'MLS', file: 'trivia_soccer.json' },
] as const;

const TIER_FILES = [
  'nfl-qb.json',
  'nfl-rb.json',
  'nfl-wr-te.json',
  'nfl-defense.json',
  'nfl-special.json',
] as const;

function safeReadJson(p: string): unknown | null {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function safeMtimeISO(p: string): string | null {
  try { return statSync(p).mtime.toISOString(); } catch { return null; }
}

function countArrayField(obj: unknown, key: string): number {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
  }
  return 0;
}

/** Sum tier rows across stat-tier files. Each stat has .tiers: [...]. */
function countTierLevels(): number {
  let total = 0;
  for (const f of TIER_FILES) {
    const j = safeReadJson(path.join(FILE.statTiersDir, f)) as
      | { stats?: Record<string, { tiers?: unknown[] }> }
      | null;
    if (!j?.stats) continue;
    for (const stat of Object.values(j.stats)) {
      if (Array.isArray(stat?.tiers)) total += stat.tiers.length;
    }
  }
  return total;
}

export async function getDataCorpus(opts: {
  scoutVoiceLinesCount?: number | null;
} = {}): Promise<DataCorpusReport> {
  if (corpusCache && corpusCache.expires_at > Date.now()) {
    // Refresh the supabase-derived field on every call (cheap, comes pre-fetched).
    return { ...corpusCache.value, scout_voice_lines_seeded: opts.scoutVoiceLinesCount ?? corpusCache.value.scout_voice_lines_seeded };
  }

  const notes: string[] = [];

  // Trivia
  const triviaBySport: Record<string, number> = {};
  let triviaTotal = 0;
  for (const t of TRIVIA_FILES) {
    const j = safeReadJson(path.join(FILE.triviaDir, t.file));
    const n = Array.isArray(j) ? j.length : 0;
    triviaBySport[t.sport] = n;
    triviaTotal += n;
    if (!Array.isArray(j)) notes.push(`trivia ${t.sport} file unreadable`);
  }

  // Cards / packs / triggers / stat-resolution
  const tmpl = safeReadJson(FILE.cardTemplates);
  const packs = safeReadJson(FILE.packs);
  const triggers = safeReadJson(FILE.triggers);
  const stres = safeReadJson(FILE.statResolution);
  const scenes = safeReadJson(FILE.scenes);

  // NFL stat cache — players is a Record keyed by player id.
  const nflCache = safeReadJson(FILE.nflStatCache) as
    | { players?: Record<string, unknown> }
    | null;
  const nflPlayers =
    nflCache && nflCache.players && typeof nflCache.players === 'object'
      ? Object.keys(nflCache.players).length
      : null;
  if (nflPlayers === null) notes.push('nfl_season_2025.json unreadable');

  // SFX manifest — counts feed the dashboard tile ("12 sounds — 11 enabled").
  const sfx = safeReadJson(FILE.sfxManifest) as { sfx?: Array<{ enabled?: boolean }> } | null;
  const sfxList = Array.isArray(sfx?.sfx) ? sfx.sfx : [];
  const sfxTotal = sfxList.length;
  const sfxEnabled = sfxList.filter((s) => s && s.enabled !== false).length;

  const report: DataCorpusReport = {
    trivia_questions_total: triviaTotal,
    trivia_by_sport: triviaBySport,
    card_templates: countArrayField(tmpl, 'card_templates'),
    card_pack_definitions: countArrayField(packs, 'packs'),
    trigger_definitions: countArrayField(triggers, 'triggers'),
    stat_resolution_sports: countArrayField(stres, 'stat_resolution'),
    city_scenes: countArrayField(scenes, 'scenes'),
    team_count: countArrayField(scenes, 'teams'),
    nfl_players_in_stat_cache: nflPlayers,
    stat_tier_files: TIER_FILES.length,
    tier_levels: countTierLevels(),
    scout_voice_lines_seeded: opts.scoutVoiceLinesCount ?? null,
    sfx_total: sfxTotal,
    sfx_enabled: sfxEnabled,
    ...(notes.length ? { notes } : {}),
  };

  corpusCache = { value: report, expires_at: Date.now() + CACHE_TTL_MS };
  return report;
}

export async function getLastUpdated(opts: {
  scoutVoiceDbLatest?: string | null;
} = {}): Promise<LastUpdatedReport> {
  if (mtimeCache && mtimeCache.expires_at > Date.now()) {
    return { ...mtimeCache.value, scout_voice_db_latest: opts.scoutVoiceDbLatest ?? mtimeCache.value.scout_voice_db_latest };
  }

  const report: LastUpdatedReport = {
    scenes_json: safeMtimeISO(FILE.scenes),
    trivia_questions: safeMtimeISO(path.join(FILE.triviaDir, 'trivia_basketball.json')),
    card_templates: safeMtimeISO(FILE.cardTemplates),
    stat_cache_nfl: safeMtimeISO(FILE.nflStatCache),
    scout_voice_db_latest: opts.scoutVoiceDbLatest ?? null,
  };

  mtimeCache = { value: report, expires_at: Date.now() + CACHE_TTL_MS };
  return report;
}

/** Test hook — clears caches so unit tests start clean. */
export function _resetDataCorpusCacheForTests(): void {
  corpusCache = null;
  mtimeCache = null;
}
