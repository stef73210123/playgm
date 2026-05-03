/**
 * sportsConfig.ts — server-side reader for data/system/sports_config.json.
 *
 * Used by route handlers + the stats refresh job to skip disabled sports
 * (e.g. MLS). 60-second in-memory cache; the admin editor invalidates on
 * save so a toggle takes effect immediately.
 *
 * Schema mirrors src/utils/sports.ts on the client side. Sport ids are
 * lowercase ("nfl", "nba", "mlb", "nhl", "mls") and map 1:1 to the Sport
 * enum used in client code.
 */
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../routes/adminEdit.js';

export type SportId = 'nfl' | 'nba' | 'mlb' | 'nhl' | 'mls';

export interface SportConfigEntry {
  enabled: boolean;
  label: string;
  league: string;
  disabled_reason?: string;
}

export interface SportsConfigFile {
  version: string;
  last_updated_iso?: string;
  sports: Record<SportId, SportConfigEntry>;
}

const SPORTS_CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'system', 'sports_config.json');
const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  config: SportsConfigFile;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

const FALLBACK: SportsConfigFile = {
  version: 'v1',
  sports: {
    nfl: { enabled: true, label: 'Football', league: 'NFL' },
    nba: { enabled: true, label: 'Basketball', league: 'NBA' },
    mlb: { enabled: true, label: 'Baseball', league: 'MLB' },
    nhl: { enabled: true, label: 'Hockey', league: 'NHL' },
    mls: { enabled: false, label: 'Soccer', league: 'MLS', disabled_reason: 'Awaiting data source' },
  },
};

function readFromDisk(): SportsConfigFile {
  try {
    const raw = fs.readFileSync(SPORTS_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SportsConfigFile>;
    if (!parsed || typeof parsed !== 'object' || !parsed.sports) return FALLBACK;
    return { ...FALLBACK, ...parsed, sports: { ...FALLBACK.sports, ...parsed.sports } };
  } catch {
    return FALLBACK;
  }
}

/** Return the full sports_config doc (cached). */
export function loadSportsConfig(): SportsConfigFile {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.config;
  const config = readFromDisk();
  cache = { config, expiresAt: now + CACHE_TTL_MS };
  return config;
}

/** Drop the cache so the next read hits disk. Wired from the admin editor. */
export function invalidateSportsConfigCache(): void {
  cache = null;
}

/** Lowercase sport ids that are currently enabled. */
export function getEnabledSportIds(): SportId[] {
  const cfg = loadSportsConfig();
  return (Object.keys(cfg.sports) as SportId[]).filter(
    (id) => cfg.sports[id]?.enabled !== false,
  );
}

/**
 * True if the given sport id (case-insensitive) is currently enabled.
 * Accepts both lowercase ("nba") and uppercase ("NBA") for ergonomics —
 * client routes use enum values which serialize as upper.
 */
export function isSportEnabled(sport: string): boolean {
  if (!sport) return false;
  const id = sport.toLowerCase() as SportId;
  const entry = loadSportsConfig().sports[id];
  if (!entry) return true; // unknown id → fail open (defensive)
  return entry.enabled !== false;
}

/** Disabled-reason string (admin-set) for a disabled sport, or null. */
export function disabledReason(sport: string): string | null {
  const id = sport.toLowerCase() as SportId;
  const entry = loadSportsConfig().sports[id];
  if (!entry || entry.enabled !== false) return null;
  return entry.disabled_reason && entry.disabled_reason.length > 0
    ? entry.disabled_reason
    : 'sport disabled';
}
