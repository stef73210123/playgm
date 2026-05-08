/**
 * dataProviderConfig.ts — server-side reader for data/system/data_provider_config.json.
 *
 * Routes each league to its stats provider. Lets ops migrate ESPN → API-Sports
 * one sport at a time without code changes — flip a value in the JSON and the
 * 60s cache picks it up on the next read.
 *
 * Default fallback rolls everything to ESPN (status quo before migration) so a
 * missing/corrupt file is safe.
 */
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../routes/adminEdit.js';

export type SportId = 'nfl' | 'nba' | 'mlb' | 'nhl' | 'mls';
export type ProviderId = 'espn' | 'thesportsdb' | 'apisports';

export interface DataProviderConfigFile {
  version: string;
  last_updated_iso?: string;
  notes?: string;
  providers: Record<SportId, ProviderId>;
}

const PATH = path.join(PROJECT_ROOT, 'data', 'system', 'data_provider_config.json');
const TTL_MS = 60 * 1000;

interface CacheEntry {
  config: DataProviderConfigFile;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

const FALLBACK: DataProviderConfigFile = {
  version: 'v1',
  providers: {
    nfl: 'espn',
    nba: 'espn',
    mlb: 'espn',
    nhl: 'espn',
    mls: 'espn',
  },
};

const VALID_PROVIDERS: ProviderId[] = ['espn', 'thesportsdb', 'apisports'];

function isValidProvider(p: unknown): p is ProviderId {
  return typeof p === 'string' && (VALID_PROVIDERS as string[]).includes(p);
}

function readFromDisk(): DataProviderConfigFile {
  try {
    const raw = fs.readFileSync(PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DataProviderConfigFile>;
    if (!parsed || typeof parsed !== 'object' || !parsed.providers) return FALLBACK;
    const merged: Record<SportId, ProviderId> = { ...FALLBACK.providers };
    for (const k of Object.keys(parsed.providers) as SportId[]) {
      const v = (parsed.providers as Record<string, unknown>)[k];
      if (isValidProvider(v)) merged[k] = v;
    }
    return { ...FALLBACK, ...parsed, providers: merged };
  } catch {
    return FALLBACK;
  }
}

export function loadDataProviderConfig(): DataProviderConfigFile {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.config;
  const config = readFromDisk();
  cache = { config, expiresAt: now + TTL_MS };
  return config;
}

export function invalidateDataProviderConfigCache(): void {
  cache = null;
}

/**
 * Resolve the provider for a given league. Order of precedence:
 *   1. The per-sport entry in data_provider_config.json
 *   2. STATS_PROVIDER env var (legacy global override)
 *   3. 'espn' fallback
 */
export function getProviderForLeague(league: SportId): ProviderId {
  const cfg = loadDataProviderConfig();
  const fromConfig = cfg.providers[league];
  if (isValidProvider(fromConfig)) return fromConfig;
  const fromEnv = (process.env.STATS_PROVIDER ?? '').toLowerCase();
  if (isValidProvider(fromEnv)) return fromEnv;
  return 'espn';
}

/**
 * Persist a per-sport provider change. Writes the JSON atomically and busts
 * the in-memory cache. The admin UI calls this; cron + route handlers see the
 * new value within 60s (or instantly if they go through invalidate).
 */
export function setProviderForLeague(league: SportId, provider: ProviderId): DataProviderConfigFile {
  if (!isValidProvider(provider)) {
    throw new Error(`[dataProviderConfig] invalid provider: ${provider}`);
  }
  const current = readFromDisk();
  const next: DataProviderConfigFile = {
    ...current,
    last_updated_iso: new Date().toISOString(),
    providers: { ...current.providers, [league]: provider },
  };
  const tmp = `${PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, PATH);
  invalidateDataProviderConfigCache();
  return next;
}
