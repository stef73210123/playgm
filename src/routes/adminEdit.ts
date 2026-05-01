/**
 * adminEdit.ts — editable inventory pages for the admin dashboard.
 *
 * Three surfaces, each with an HTML editor + JSON API:
 *
 *   1. Player + team video links
 *      - GET    /admin/edit/players                  → HTML editor
 *      - GET    /admin/edit/teams                    → HTML editor
 *      - GET    /admin/api/players                   → list (filter: sport, team_id, q, page, per_page)
 *      - GET    /admin/api/teams                     → list (filter: sport, q)
 *      - PATCH  /admin/api/players/:id               → update video URLs (Supabase meta_json)
 *      - PATCH  /admin/api/teams/:id                 → update video URLs (Supabase meta_json)
 *
 *   2. Card templates (data/cards/pgm_card_templates.json — 20 entries)
 *      - GET    /admin/edit/cards
 *      - GET    /admin/api/cards
 *      - POST   /admin/api/cards                     → create new template
 *      - PATCH  /admin/api/cards/:id                 → update one
 *      - DELETE /admin/api/cards/:id                 → soft-delete (sets retired:true)
 *
 *   3. Trivia questions (assets/challenges/trivia_<sport>.json — ~3,250 entries)
 *      - GET    /admin/edit/trivia
 *      - GET    /admin/api/trivia                    → paginated list
 *      - POST   /admin/api/trivia                    → create new question
 *      - PATCH  /admin/api/trivia/:id                → update one
 *      - DELETE /admin/api/trivia/:id                → soft-delete (sets retired:true)
 *
 * Persistence model:
 *   - players + teams: write to Supabase via service-role client. We extend
 *     the existing meta_json JSONB column with `video_highlight_url` and
 *     `video_about_url` keys; no new columns required.
 *   - card templates + trivia: write back to the on-disk JSON file, then
 *     auto-commit (no push) so every edit lands as its own commit. Soft
 *     delete keeps history intact.
 *
 * Auth: none. Same threat model as /admin/dashboard (tunnel-only).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { supabase } from '../db/client.js';
import {
  loadChannelDefinitions,
  loadChannelActuals,
  invalidateAdvertisingCache,
  type ChannelActualsFile,
} from '../services/advertising.js';
import {
  invalidateSafetyMatrixCache,
  loadSafetyMatrix,
  validateFeature,
  type SafetyFeature,
  type SafetyMatrixFile,
} from '../services/safetyMatrix.js';
import { invalidateUserFeaturesCache } from '../services/safetyResolver.js';

// ─── Project root resolution (mirrors admin.ts) ──────────────────────────
export function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, path.resolve(cwd, '..'), path.resolve(cwd, '..', '..')];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'cards', 'pgm_card_templates.json'))) return c;
  }
  return cwd;
}
export const PROJECT_ROOT = findProjectRoot();
const CARD_TEMPLATES_PATH = path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_card_templates.json');
const TRIVIA_DIR = path.join(PROJECT_ROOT, 'assets', 'challenges');
const ADVERTISING_ACTUALS_PATH = path.join(
  PROJECT_ROOT,
  'data',
  'marketing',
  'channel_actuals.json',
);
const SAFETY_MATRIX_PATH = path.join(
  PROJECT_ROOT,
  'data',
  'safety',
  'age_feature_matrix.json',
);

// ─── Constants / validation tables ───────────────────────────────────────
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
const CARD_TYPES = ['stat_boost', 'ability', 'hybrid'] as const;
const CARD_SPORTS = ['any', 'basketball', 'baseball', 'football', 'hockey', 'soccer'] as const;
const TRIVIA_SPORTS = ['basketball', 'baseball', 'football', 'hockey', 'soccer'] as const;
const TRIVIA_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
// Categories actually present in the existing trivia pool.
const TRIVIA_CATEGORIES = [
  'rules',
  'history',
  'current_players',
  'fun',
  'lifestyle',
  'math',
  'city',
  'technique',
] as const;

const MAX_URL_LEN = 600;

type Rarity = (typeof RARITIES)[number];
type CardType = (typeof CARD_TYPES)[number];
type CardSport = (typeof CARD_SPORTS)[number];
type TriviaSport = (typeof TRIVIA_SPORTS)[number];
type TriviaDifficulty = (typeof TRIVIA_DIFFICULTIES)[number];
type TriviaCategory = (typeof TRIVIA_CATEGORIES)[number];

// ─── Types ───────────────────────────────────────────────────────────────
interface CardTemplate {
  template_id: string;
  name: string;
  card_type: CardType;
  rarity: Rarity;
  energy_cost: number;
  sport: CardSport;
  effect: unknown;
  display: {
    description_short?: string;
    description_long?: string;
    scout_callout?: string;
  };
  retired?: boolean;
}

interface CardTemplatesFile {
  version: string;
  card_templates: CardTemplate[];
}

interface TriviaQuestion {
  id: string;
  sport: TriviaSport;
  difficulty: TriviaDifficulty;
  category: TriviaCategory;
  question: string;
  answer_correct: string;
  answer_options: string[];
  explanation?: string | null;
  expires?: string | null;
  source_season?: string | null;
  needs_verification?: boolean;
  retired?: boolean;
}

// ─── Validation helpers ──────────────────────────────────────────────────
function isOneOf<T extends readonly string[]>(arr: T, v: unknown): v is T[number] {
  return typeof v === 'string' && (arr as readonly string[]).includes(v);
}

function isNonEmptyString(v: unknown, max = 1000): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function isOptionalString(v: unknown, max = 1000): boolean {
  return v == null || (typeof v === 'string' && v.length <= max);
}

function isVideoUrl(v: unknown): boolean {
  if (v === '' || v == null) return true; // empty allowed
  if (typeof v !== 'string') return false;
  if (v.length > MAX_URL_LEN) return false;
  return /^https:\/\/[^\s]+$/.test(v);
}

export interface ValidationError {
  field: string;
  message: string;
}

function validateCardTemplate(
  body: Record<string, unknown>,
  partial: boolean,
): ValidationError[] {
  const errs: ValidationError[] = [];
  const need = (k: string) => !partial && body[k] === undefined;
  if (!partial && !isNonEmptyString(body['template_id'], 80)) {
    errs.push({ field: 'template_id', message: 'required, ≤80 chars' });
  } else if (body['template_id'] !== undefined && !isNonEmptyString(body['template_id'], 80)) {
    errs.push({ field: 'template_id', message: 'must be non-empty string ≤80 chars' });
  }
  if (need('name') || (body['name'] !== undefined && !isNonEmptyString(body['name'], 80))) {
    errs.push({ field: 'name', message: 'required non-empty string ≤80 chars' });
  }
  if (need('rarity') || (body['rarity'] !== undefined && !isOneOf(RARITIES, body['rarity']))) {
    errs.push({ field: 'rarity', message: `must be one of ${RARITIES.join('|')}` });
  }
  if (
    need('card_type') ||
    (body['card_type'] !== undefined && !isOneOf(CARD_TYPES, body['card_type']))
  ) {
    errs.push({ field: 'card_type', message: `must be one of ${CARD_TYPES.join('|')}` });
  }
  if (
    need('sport') ||
    (body['sport'] !== undefined && !isOneOf(CARD_SPORTS, body['sport']))
  ) {
    errs.push({ field: 'sport', message: `must be one of ${CARD_SPORTS.join('|')}` });
  }
  if (
    need('energy_cost') ||
    (body['energy_cost'] !== undefined &&
      (!Number.isInteger(body['energy_cost']) ||
        (body['energy_cost'] as number) < 1 ||
        (body['energy_cost'] as number) > 4))
  ) {
    errs.push({ field: 'energy_cost', message: 'integer 1–4' });
  }
  if (body['display'] !== undefined) {
    const d = body['display'] as Record<string, unknown> | null;
    if (d == null || typeof d !== 'object') {
      errs.push({ field: 'display', message: 'must be object' });
    } else {
      for (const k of ['description_short', 'description_long', 'scout_callout']) {
        if (d[k] !== undefined && !isOptionalString(d[k], 400)) {
          errs.push({ field: `display.${k}`, message: 'must be string ≤400 chars' });
        }
      }
    }
  }
  return errs;
}

function validateTriviaQuestion(
  body: Record<string, unknown>,
  partial: boolean,
): ValidationError[] {
  const errs: ValidationError[] = [];
  const need = (k: string) => !partial && body[k] === undefined;
  if (
    need('sport') ||
    (body['sport'] !== undefined && !isOneOf(TRIVIA_SPORTS, body['sport']))
  ) {
    errs.push({ field: 'sport', message: `must be one of ${TRIVIA_SPORTS.join('|')}` });
  }
  if (
    need('difficulty') ||
    (body['difficulty'] !== undefined && !isOneOf(TRIVIA_DIFFICULTIES, body['difficulty']))
  ) {
    errs.push({ field: 'difficulty', message: `must be one of ${TRIVIA_DIFFICULTIES.join('|')}` });
  }
  if (
    need('category') ||
    (body['category'] !== undefined && !isOneOf(TRIVIA_CATEGORIES, body['category']))
  ) {
    errs.push({ field: 'category', message: `must be one of ${TRIVIA_CATEGORIES.join('|')}` });
  }
  if (need('question') || (body['question'] !== undefined && !isNonEmptyString(body['question'], 500))) {
    errs.push({ field: 'question', message: 'required non-empty string ≤500 chars' });
  }
  if (
    need('answer_correct') ||
    (body['answer_correct'] !== undefined && !isNonEmptyString(body['answer_correct'], 200))
  ) {
    errs.push({ field: 'answer_correct', message: 'required non-empty string ≤200 chars' });
  }
  if (body['answer_options'] !== undefined) {
    const opts = body['answer_options'];
    if (!Array.isArray(opts) || opts.length !== 4) {
      errs.push({ field: 'answer_options', message: 'array of length 4 required' });
    } else if (opts.some((o) => typeof o !== 'string' || o.length === 0)) {
      errs.push({ field: 'answer_options', message: 'each option must be non-empty string' });
    } else if (
      body['answer_correct'] !== undefined &&
      !opts.includes(body['answer_correct'])
    ) {
      errs.push({ field: 'answer_correct', message: 'must appear in answer_options' });
    } else {
      const matches = opts.filter((o) => o === body['answer_correct']).length;
      if (matches !== 1) {
        errs.push({ field: 'answer_correct', message: 'exactly one option must match' });
      }
    }
  } else if (!partial) {
    errs.push({ field: 'answer_options', message: 'required array of length 4' });
  }
  if (body['explanation'] !== undefined && !isOptionalString(body['explanation'], 800)) {
    errs.push({ field: 'explanation', message: 'must be string ≤800 chars' });
  }
  return errs;
}

/**
 * Validate an advertising-actuals PATCH body.
 * Body shape: { current_month?: {key:number}, last_month?: {key:number} }
 *
 * Rules:
 *   - All values must be numeric (no strings, no NaN, no Infinity).
 *   - No negatives.
 *   - USD-suffixed keys (*_usd) round to 2 decimals; the editor sends pre-rounded
 *     numbers but we don't reject if a 4-decimal value comes through — we accept,
 *     we just round on save. Validation only rejects bad SHAPE, not precision.
 *   - Allowed keys are filtered to the channel's metric_keys (others ignored
 *     silently — no hard error so the schema can evolve).
 */
function validateAdvertisingPayload(
  body: Record<string, unknown>,
): ValidationError[] {
  const errs: ValidationError[] = [];
  for (const period of ['current_month', 'last_month'] as const) {
    if (body[period] === undefined) continue;
    const p = body[period];
    if (p == null || typeof p !== 'object' || Array.isArray(p)) {
      errs.push({ field: period, message: 'must be object' });
      continue;
    }
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errs.push({ field: `${period}.${k}`, message: 'must be a finite number' });
        continue;
      }
      if (v < 0) {
        errs.push({ field: `${period}.${k}`, message: 'must be ≥ 0' });
      }
    }
  }
  return errs;
}

/**
 * Validate the PATCH body for /admin/api/safety-matrix/:feature_id.
 *
 * Per spec:
 *   - min_age in [5, 14], max_age in [5, 14], min ≤ max — except the 0/0 sentinel
 *     (which means "never default-on"; used for parent-only features).
 *   - requires_parent_consent_under in [0, 18]
 *   - rationale non-empty
 *
 * The full per-feature semantic check (e.g. ages_blocked / ages_with_moderation
 * shape) is done after merging via validateFeature() in safetyMatrix.ts. This
 * function only catches obviously-wrong shapes before we even attempt a merge.
 */
function validateSafetyMatrixPatch(body: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  function inAgeRange(v: unknown, allowZero: boolean): boolean {
    if (!Number.isInteger(v)) return false;
    const n = v as number;
    if (allowZero && n === 0) return true;
    return n >= 5 && n <= 14;
  }
  if (
    body['min_age_default_on'] !== undefined &&
    !inAgeRange(body['min_age_default_on'], true)
  ) {
    errs.push({ field: 'min_age_default_on', message: 'integer in [5, 14] (or 0 sentinel)' });
  }
  if (
    body['max_age_default_on'] !== undefined &&
    !inAgeRange(body['max_age_default_on'], true)
  ) {
    errs.push({ field: 'max_age_default_on', message: 'integer in [5, 14] (or 0 sentinel)' });
  }
  if (
    body['min_age_default_on'] !== undefined &&
    body['max_age_default_on'] !== undefined &&
    !((body['min_age_default_on'] as number) === 0 && (body['max_age_default_on'] as number) === 0) &&
    (body['min_age_default_on'] as number) > (body['max_age_default_on'] as number)
  ) {
    errs.push({ field: 'min_age_default_on', message: 'must be ≤ max_age_default_on' });
  }
  if (body['ages_with_moderation'] !== undefined) {
    const a = body['ages_with_moderation'];
    if (!Array.isArray(a) || !a.every((n) => Number.isInteger(n) && (n as number) >= 5 && (n as number) <= 14)) {
      errs.push({ field: 'ages_with_moderation', message: 'array of integers in [5, 14]' });
    }
  }
  if (body['ages_blocked'] !== undefined) {
    const a = body['ages_blocked'];
    if (!Array.isArray(a) || !a.every((n) => Number.isInteger(n) && (n as number) >= 5 && (n as number) <= 14)) {
      errs.push({ field: 'ages_blocked', message: 'array of integers in [5, 14]' });
    }
  }
  if (body['parent_override_allowed'] !== undefined && typeof body['parent_override_allowed'] !== 'boolean') {
    errs.push({ field: 'parent_override_allowed', message: 'must be boolean' });
  }
  if (body['requires_parent_consent_under'] !== undefined) {
    const v = body['requires_parent_consent_under'];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 18) {
      errs.push({ field: 'requires_parent_consent_under', message: 'integer in [0, 18]' });
    }
  }
  if (body['rationale'] !== undefined) {
    if (typeof body['rationale'] !== 'string' || body['rationale'].trim().length === 0) {
      errs.push({ field: 'rationale', message: 'non-empty string required' });
    }
  }
  if (body['source'] !== undefined) {
    if (typeof body['source'] !== 'string' || body['source'].trim().length === 0) {
      errs.push({ field: 'source', message: 'non-empty string required' });
    }
  }
  if (body['label'] !== undefined) {
    if (typeof body['label'] !== 'string' || body['label'].trim().length === 0) {
      errs.push({ field: 'label', message: 'non-empty string required' });
    }
  }
  return errs;
}

function validateVideoUrlPayload(body: Record<string, unknown>): ValidationError[] {
  const errs: ValidationError[] = [];
  if (body['video_highlight_url'] !== undefined && !isVideoUrl(body['video_highlight_url'])) {
    errs.push({
      field: 'video_highlight_url',
      message: `must be HTTPS URL ≤${MAX_URL_LEN} chars (or empty)`,
    });
  }
  if (body['video_about_url'] !== undefined && !isVideoUrl(body['video_about_url'])) {
    errs.push({
      field: 'video_about_url',
      message: `must be HTTPS URL ≤${MAX_URL_LEN} chars (or empty)`,
    });
  }
  return errs;
}

// ─── Disk helpers (cards + trivia) ───────────────────────────────────────
async function readCardTemplates(): Promise<CardTemplatesFile> {
  const raw = await fs.readFile(CARD_TEMPLATES_PATH, 'utf8');
  return JSON.parse(raw) as CardTemplatesFile;
}
async function writeCardTemplates(data: CardTemplatesFile): Promise<void> {
  // Match existing JSON style (2-space indent, trailing newline).
  const out = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(CARD_TEMPLATES_PATH, out, 'utf8');
}

function triviaPath(sport: TriviaSport): string {
  return path.join(TRIVIA_DIR, `trivia_${sport}.json`);
}
async function readTrivia(sport: TriviaSport): Promise<TriviaQuestion[]> {
  const raw = await fs.readFile(triviaPath(sport), 'utf8');
  return JSON.parse(raw) as TriviaQuestion[];
}
async function writeTrivia(sport: TriviaSport, data: TriviaQuestion[]): Promise<void> {
  const out = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(triviaPath(sport), out, 'utf8');
}

// ─── Auto-commit helper ──────────────────────────────────────────────────
// On save we run `git add <file> && git commit -m <subject>` with cwd at
// PROJECT_ROOT. If there's a stale .git/index.lock from a crashed previous
// run, we clear it and retry once. We never push. Failures are logged but
// non-fatal — the file write already succeeded.
export function autoCommit(relPath: string, subject: string): { ok: boolean; error?: string } {
  if (process.env['ADMIN_EDIT_AUTOCOMMIT'] === '0') {
    return { ok: true };
  }
  const lockPath = path.join(PROJECT_ROOT, '.git', 'index.lock');
  const tryOnce = (): { ok: true } | { ok: false; error: string } => {
    try {
      execFileSync('git', ['add', '--', relPath], { cwd: PROJECT_ROOT, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', subject, '--', relPath], {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  let attempt = tryOnce();
  if (!attempt.ok && /index\.lock/.test(attempt.error)) {
    try {
      if (existsSync(lockPath)) {
        // Best-effort: clear the lock and retry once.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fsSync = require('node:fs') as typeof import('node:fs');
        fsSync.unlinkSync(lockPath);
      }
    } catch {
      /* ignore */
    }
    attempt = tryOnce();
  }
  return attempt;
}

// ─── Reply helpers ───────────────────────────────────────────────────────
export function badRequest(reply: FastifyReply, errors: ValidationError[]): FastifyReply {
  reply.code(400).send({ ok: false, errors });
  return reply;
}

export function notFound(reply: FastifyReply, what: string): FastifyReply {
  reply.code(404).send({ ok: false, error: `${what} not found` });
  return reply;
}

export function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c]!;
  });
}

// ─── Route registration ──────────────────────────────────────────────────
export async function adminEditRoutes(fastify: FastifyInstance): Promise<void> {
  // ═══ HTML EDITOR PAGES ═══════════════════════════════════════════════════
  fastify.get('/admin/edit/players', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderPlayersPage();
  });
  fastify.get('/admin/edit/teams', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderTeamsPage();
  });
  fastify.get('/admin/edit/cards', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderCardsPage();
  });
  fastify.get('/admin/edit/trivia', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderTriviaPage();
  });
  fastify.get('/admin/edit/advertising', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderAdvertisingPage();
  });
  fastify.get('/admin/edit/safety', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderSafetyPage();
  });

  // ═══ SAFETY MATRIX API ═══════════════════════════════════════════════════
  fastify.get('/admin/api/safety-matrix', async (_req, reply) => {
    try {
      const file = loadSafetyMatrix();
      return { ok: true, ...file };
    } catch (err) {
      reply.code(500).send({
        ok: false,
        error: err instanceof Error ? err.message : 'failed to load safety matrix',
      });
      return reply;
    }
  });

  fastify.patch('/admin/api/safety-matrix/:feature_id', async (req, reply) => {
    const { feature_id } = req.params as { feature_id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateSafetyMatrixPatch(body);
    if (errs.length) return badRequest(reply, errs);

    let file: SafetyMatrixFile;
    try {
      file = JSON.parse(await fs.readFile(SAFETY_MATRIX_PATH, 'utf8')) as SafetyMatrixFile;
    } catch (err) {
      reply.code(500).send({
        ok: false,
        error: err instanceof Error ? err.message : 'failed to read safety matrix',
      });
      return reply;
    }
    const idx = file.features.findIndex((f) => f.feature_id === feature_id);
    if (idx === -1) return notFound(reply, `safety feature ${feature_id}`);
    const cur = file.features[idx]!;

    // Apply allowed PATCH fields. feature_id and category are immutable here —
    // structural changes go through the JSON file directly.
    const merged: SafetyFeature = {
      ...cur,
      ...(body['label'] !== undefined ? { label: body['label'] as string } : {}),
      ...(body['min_age_default_on'] !== undefined
        ? { min_age_default_on: body['min_age_default_on'] as number }
        : {}),
      ...(body['max_age_default_on'] !== undefined
        ? { max_age_default_on: body['max_age_default_on'] as number }
        : {}),
      ...(body['ages_with_moderation'] !== undefined
        ? { ages_with_moderation: body['ages_with_moderation'] as number[] }
        : {}),
      ...(body['ages_blocked'] !== undefined
        ? { ages_blocked: body['ages_blocked'] as number[] }
        : {}),
      ...(body['parent_override_allowed'] !== undefined
        ? { parent_override_allowed: body['parent_override_allowed'] as boolean }
        : {}),
      ...(body['requires_parent_consent_under'] !== undefined
        ? {
            requires_parent_consent_under: body['requires_parent_consent_under'] as number,
          }
        : {}),
      ...(body['rationale'] !== undefined ? { rationale: body['rationale'] as string } : {}),
      ...(body['source'] !== undefined ? { source: body['source'] as string } : {}),
    };

    // Whole-record validation — guards against patches that produce an
    // internally inconsistent feature (e.g. min > max after a partial update).
    const finalErr = validateFeature(merged);
    if (finalErr) {
      return badRequest(reply, [{ field: 'feature', message: finalErr }]);
    }

    file.features[idx] = merged;
    file.last_updated_iso = new Date().toISOString();
    const out = JSON.stringify(file, null, 2) + '\n';
    await fs.writeFile(SAFETY_MATRIX_PATH, out, 'utf8');
    invalidateSafetyMatrixCache();
    const commit = autoCommit(
      'data/safety/age_feature_matrix.json',
      `chore(content): update safety matrix — ${feature_id}`,
    );
    return { ok: true, item: merged, commit };
  });

  // ═══ PER-USER SAFETY OVERRIDES API ═══════════════════════════════════════
  // These endpoints power the /admin/edit/safety "Per-User Overrides" tab
  // and the dashboard summary tile. Persistence lives entirely in
  // `user_safety_overrides` (Supabase) — no JSON file mutation, no auto
  // commit. Override writes invalidate the per-user resolver cache.

  /** Aggregate counts for the dashboard tile + Per-User Overrides tab
   *  header. Cheap COUNT queries — runs every dashboard load. */
  fastify.get('/admin/api/user-safety-overrides/summary', async (_req, reply) => {
    const { data, error } = await supabase
      .from('user_safety_overrides')
      .select('user_id, feature_id');
    if (error) {
      reply.code(500).send({ ok: false, error: error.message });
      return reply;
    }
    const rows = (data ?? []) as Array<{ user_id: string; feature_id: string }>;
    const distinctUsers = new Set(rows.map((r) => r.user_id));
    const distinctFeatures = new Set(rows.map((r) => r.feature_id));
    return {
      ok: true,
      total_overrides: rows.length,
      distinct_users: distinctUsers.size,
      distinct_features: distinctFeatures.size,
    };
  });

  /** Search users by handle / id. Paginated. The Per-User tab feeds its
   *  search box with this and shows up to 25 hits. */
  fastify.get('/admin/api/user-safety-overrides/users', async (req, reply) => {
    const q = (req.query as { q?: string }).q?.trim() ?? '';
    const PER_PAGE = 25;
    let qb = supabase
      .from('profiles')
      .select('id, handle, birth_year')
      .limit(PER_PAGE);
    if (q.length) {
      // Match handle prefix or exact id.
      qb = qb.or(`handle.ilike.${q.replace(/[%_]/g, '')}%,id.eq.${q}`);
    }
    const { data, error } = await qb;
    if (error) {
      reply.code(500).send({ ok: false, error: error.message });
      return reply;
    }
    return { ok: true, users: data ?? [] };
  });

  /** All overrides for one user — feeds the inline editor. */
  fastify.get('/admin/api/user-safety-overrides/:user_id', async (req, reply) => {
    const { user_id } = req.params as { user_id: string };
    const { data, error } = await supabase
      .from('user_safety_overrides')
      .select('feature_id, enabled, reason, set_by_admin, created_at')
      .eq('user_id', user_id);
    if (error) {
      reply.code(500).send({ ok: false, error: error.message });
      return reply;
    }
    return { ok: true, user_id, overrides: data ?? [] };
  });

  /** Upsert one override. PATCH is idempotent — same (user_id, feature_id)
   *  always rewrites the existing row. `enabled: null` would be ambiguous
   *  (NULL in DB means "inherit" — which we model as no row), so we
   *  expose DELETE as the way to remove an override and revert to matrix. */
  fastify.patch(
    '/admin/api/user-safety-overrides/:user_id/:feature_id',
    async (req, reply) => {
      const { user_id, feature_id } = req.params as {
        user_id: string;
        feature_id: string;
      };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const errs: ValidationError[] = [];
      if (typeof body['enabled'] !== 'boolean') {
        errs.push({ field: 'enabled', message: 'must be boolean' });
      }
      if (typeof body['reason'] !== 'string' || !(body['reason'] as string).trim()) {
        // Required so we have an audit trail. Free-text but non-empty.
        errs.push({ field: 'reason', message: 'required (audit trail)' });
      }
      const matrix = loadSafetyMatrix();
      if (!matrix.features.some((f) => f.feature_id === feature_id)) {
        errs.push({ field: 'feature_id', message: `unknown feature ${feature_id}` });
      }
      if (errs.length) return badRequest(reply, errs);

      const setByAdmin =
        ((req.headers['x-admin-id'] as string | undefined) ?? '').trim() || 'dashboard';

      const { error } = await supabase.from('user_safety_overrides').upsert(
        {
          user_id,
          feature_id,
          enabled: body['enabled'] as boolean,
          reason: (body['reason'] as string).trim(),
          set_by_admin: setByAdmin,
        },
        { onConflict: 'user_id,feature_id' },
      );
      if (error) {
        reply.code(500).send({ ok: false, error: error.message });
        return reply;
      }
      invalidateUserFeaturesCache(user_id);
      return { ok: true, user_id, feature_id, enabled: body['enabled'] };
    },
  );

  /** Remove an override → user reverts to the age-matrix baseline. */
  fastify.delete(
    '/admin/api/user-safety-overrides/:user_id/:feature_id',
    async (req, reply) => {
      const { user_id, feature_id } = req.params as {
        user_id: string;
        feature_id: string;
      };
      const { error } = await supabase
        .from('user_safety_overrides')
        .delete()
        .eq('user_id', user_id)
        .eq('feature_id', feature_id);
      if (error) {
        reply.code(500).send({ ok: false, error: error.message });
        return reply;
      }
      invalidateUserFeaturesCache(user_id);
      return { ok: true, user_id, feature_id, removed: true };
    },
  );

  // ═══ ADVERTISING API ═════════════════════════════════════════════════════
  fastify.get('/admin/api/advertising/:channel_id', async (req, reply) => {
    const { channel_id } = req.params as { channel_id: string };
    const defs = loadChannelDefinitions();
    const def = defs.channels.find((c) => c.channel_id === channel_id);
    if (!def) return notFound(reply, `channel ${channel_id}`);
    const actuals = loadChannelActuals();
    const a = actuals.actuals_by_channel[channel_id] ?? {
      current_month: {},
      last_month: {},
      last_updated_iso: null,
    };
    return { ok: true, channel: def, actuals: a };
  });

  fastify.patch('/admin/api/advertising/:channel_id', async (req, reply) => {
    const { channel_id } = req.params as { channel_id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateAdvertisingPayload(body);
    if (errs.length) return badRequest(reply, errs);

    const defs = loadChannelDefinitions();
    const def = defs.channels.find((c) => c.channel_id === channel_id);
    if (!def) return notFound(reply, `channel ${channel_id}`);

    const file = loadChannelActuals();
    const cur = file.actuals_by_channel[channel_id] ?? {
      current_month: {},
      last_month: {},
      last_updated_iso: null,
    };

    const allowedKeys = new Set(def.metric_keys);
    function mergePeriod(
      base: Record<string, number>,
      patch: Record<string, unknown> | undefined,
    ): Record<string, number> {
      if (!patch) return base;
      const out: Record<string, number> = { ...base };
      for (const [k, v] of Object.entries(patch)) {
        if (!allowedKeys.has(k)) continue; // silently drop unknown keys
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        // Round USD values to 2 decimals.
        out[k] = /_usd$/.test(k) ? Math.round(v * 100) / 100 : v;
      }
      return out;
    }

    const nowIso = new Date().toISOString();
    const merged = {
      current_month: mergePeriod(
        cur.current_month ?? {},
        body['current_month'] as Record<string, unknown> | undefined,
      ),
      last_month: mergePeriod(
        cur.last_month ?? {},
        body['last_month'] as Record<string, unknown> | undefined,
      ),
      last_updated_iso: nowIso,
    };

    const newFile: ChannelActualsFile = {
      ...file,
      last_updated_iso: nowIso,
      actuals_by_channel: { ...file.actuals_by_channel, [channel_id]: merged },
    };
    const out = JSON.stringify(newFile, null, 2) + '\n';
    await fs.writeFile(ADVERTISING_ACTUALS_PATH, out, 'utf8');
    invalidateAdvertisingCache();
    const commit = autoCommit(
      'data/marketing/channel_actuals.json',
      `chore(content): update advertising actuals — ${channel_id}`,
    );
    return { ok: true, channel_id, actuals: merged, commit };
  });

  // ═══ PLAYERS API ═════════════════════════════════════════════════════════
  fastify.get('/admin/api/players', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(q['page'] ?? 1));
    const perPage = Math.min(200, Math.max(1, Number(q['per_page'] ?? 50)));
    const sport = q['sport'];
    const teamId = q['team_id'];
    const search = q['q'];

    let qb = supabase
      .from('players')
      .select('id, full_name, position, jersey_number, category, team_id, meta_json', {
        count: 'exact',
      })
      .order('full_name', { ascending: true })
      .range((page - 1) * perPage, page * perPage - 1);
    if (sport) qb = qb.eq('category', sport);
    if (teamId) qb = qb.eq('team_id', teamId);
    if (search) qb = qb.ilike('full_name', `%${search}%`);

    const res = (await qb) as {
      data: Array<{
        id: string;
        full_name: string;
        position: string | null;
        jersey_number: number | null;
        category: string;
        team_id: string | null;
        meta_json: Record<string, unknown> | null;
      }> | null;
      error: { message: string } | null;
      count: number | null;
    };
    if (res.error) {
      return { ok: false, error: res.error.message, items: [], total: 0, page, per_page: perPage };
    }
    const items = (res.data ?? []).map((p) => ({
      id: p.id,
      full_name: p.full_name,
      position: p.position,
      jersey_number: p.jersey_number,
      sport: p.category,
      team_id: p.team_id,
      video_highlight_url: (p.meta_json?.['video_highlight_url'] as string | undefined) ?? '',
      video_about_url: (p.meta_json?.['video_about_url'] as string | undefined) ?? '',
    }));
    return { ok: true, items, total: res.count ?? items.length, page, per_page: perPage };
  });

  fastify.patch('/admin/api/players/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateVideoUrlPayload(body);
    if (errs.length) return badRequest(reply, errs);
    return updateMetaJsonVideoUrls('players', id, body, reply);
  });

  // ═══ TEAMS API ═══════════════════════════════════════════════════════════
  fastify.get('/admin/api/teams', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const sport = q['sport'];
    const search = q['q'];
    let qb = supabase
      .from('teams')
      .select('id, full_name, name, city, abbreviation, category, meta_json', { count: 'exact' })
      .order('full_name', { ascending: true })
      .limit(500);
    if (sport) qb = qb.eq('category', sport);
    if (search) qb = qb.ilike('full_name', `%${search}%`);
    const res = (await qb) as {
      data: Array<{
        id: string;
        full_name: string;
        name: string;
        city: string | null;
        abbreviation: string | null;
        category: string;
        meta_json: Record<string, unknown> | null;
      }> | null;
      error: { message: string } | null;
      count: number | null;
    };
    if (res.error) {
      return { ok: false, error: res.error.message, items: [], total: 0 };
    }
    const items = (res.data ?? []).map((t) => ({
      id: t.id,
      full_name: t.full_name,
      name: t.name,
      city: t.city,
      abbreviation: t.abbreviation,
      sport: t.category,
      video_highlight_url: (t.meta_json?.['video_highlight_url'] as string | undefined) ?? '',
      video_about_url: (t.meta_json?.['video_about_url'] as string | undefined) ?? '',
    }));
    return { ok: true, items, total: res.count ?? items.length };
  });

  fastify.patch('/admin/api/teams/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateVideoUrlPayload(body);
    if (errs.length) return badRequest(reply, errs);
    return updateMetaJsonVideoUrls('teams', id, body, reply);
  });

  // ═══ CARDS API ═══════════════════════════════════════════════════════════
  fastify.get('/admin/api/cards', async () => {
    const file = await readCardTemplates();
    return { ok: true, version: file.version, items: file.card_templates };
  });

  fastify.post('/admin/api/cards', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateCardTemplate(body, false);
    if (errs.length) return badRequest(reply, errs);
    const file = await readCardTemplates();
    const id = body['template_id'] as string;
    if (file.card_templates.some((c) => c.template_id === id)) {
      reply.code(409).send({ ok: false, error: `template_id ${id} already exists` });
      return reply;
    }
    const tpl = body as unknown as CardTemplate;
    file.card_templates.push(tpl);
    await writeCardTemplates(file);
    const commit = autoCommit(
      'data/cards/pgm_card_templates.json',
      `chore(content): add card template ${id}`,
    );
    return { ok: true, item: tpl, commit };
  });

  fastify.patch('/admin/api/cards/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateCardTemplate(body, true);
    if (errs.length) return badRequest(reply, errs);
    const file = await readCardTemplates();
    const idx = file.card_templates.findIndex((c) => c.template_id === id);
    if (idx === -1) return notFound(reply, `card template ${id}`);
    const cur = file.card_templates[idx]!;
    const merged: CardTemplate = {
      ...cur,
      ...(body as Partial<CardTemplate>),
      display: {
        ...cur.display,
        ...((body['display'] as Record<string, string>) ?? {}),
      },
    };
    file.card_templates[idx] = merged;
    await writeCardTemplates(file);
    const commit = autoCommit(
      'data/cards/pgm_card_templates.json',
      `chore(content): update card template ${id}`,
    );
    return { ok: true, item: merged, commit };
  });

  fastify.delete('/admin/api/cards/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = await readCardTemplates();
    const idx = file.card_templates.findIndex((c) => c.template_id === id);
    if (idx === -1) return notFound(reply, `card template ${id}`);
    file.card_templates[idx] = { ...file.card_templates[idx]!, retired: true };
    await writeCardTemplates(file);
    const commit = autoCommit(
      'data/cards/pgm_card_templates.json',
      `chore(content): retire card template ${id}`,
    );
    return { ok: true, item: file.card_templates[idx], commit };
  });

  // ═══ TRIVIA API ══════════════════════════════════════════════════════════
  fastify.get('/admin/api/trivia', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const sportFilter = q['sport'];
    const difficulty = q['difficulty'];
    const search = (q['q'] ?? '').trim().toLowerCase();
    const page = Math.max(1, Number(q['page'] ?? 1));
    const perPage = Math.min(100, Math.max(1, Number(q['per_page'] ?? 25)));

    const sportsToLoad: TriviaSport[] =
      sportFilter && (TRIVIA_SPORTS as readonly string[]).includes(sportFilter)
        ? [sportFilter as TriviaSport]
        : [...TRIVIA_SPORTS];

    const all: TriviaQuestion[] = [];
    for (const s of sportsToLoad) {
      try {
        const list = await readTrivia(s);
        all.push(...list);
      } catch {
        /* skip missing file */
      }
    }
    let filtered = all;
    if (difficulty && (TRIVIA_DIFFICULTIES as readonly string[]).includes(difficulty)) {
      filtered = filtered.filter((q2) => q2.difficulty === difficulty);
    }
    if (search) {
      filtered = filtered.filter(
        (q2) =>
          q2.question.toLowerCase().includes(search) ||
          q2.id.toLowerCase().includes(search) ||
          q2.category.toLowerCase().includes(search),
      );
    }
    const total = filtered.length;
    const items = filtered.slice((page - 1) * perPage, page * perPage);
    return { ok: true, items, total, page, per_page: perPage };
  });

  fastify.post('/admin/api/trivia', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateTriviaQuestion(body, false);
    if (errs.length) return badRequest(reply, errs);
    if (!isNonEmptyString(body['id'], 80)) {
      return badRequest(reply, [{ field: 'id', message: 'required ≤80 chars' }]);
    }
    const sport = body['sport'] as TriviaSport;
    const list = await readTrivia(sport);
    const id = body['id'] as string;
    if (list.some((q2) => q2.id === id)) {
      reply.code(409).send({ ok: false, error: `trivia id ${id} already exists` });
      return reply;
    }
    const q2 = body as unknown as TriviaQuestion;
    list.push(q2);
    await writeTrivia(sport, list);
    const commit = autoCommit(
      `assets/challenges/trivia_${sport}.json`,
      `chore(content): add trivia ${sport}/${id}`,
    );
    return { ok: true, item: q2, commit };
  });

  fastify.patch('/admin/api/trivia/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errs = validateTriviaQuestion(body, true);
    if (errs.length) return badRequest(reply, errs);
    // Find which sport file holds this id.
    for (const sport of TRIVIA_SPORTS) {
      let list: TriviaQuestion[];
      try {
        list = await readTrivia(sport);
      } catch {
        continue;
      }
      const idx = list.findIndex((q2) => q2.id === id);
      if (idx === -1) continue;
      const cur = list[idx]!;
      // If sport is changing, prevent it (would require moving across files).
      if (body['sport'] !== undefined && body['sport'] !== cur.sport) {
        return badRequest(reply, [
          { field: 'sport', message: 'cannot change sport via PATCH; create+delete instead' },
        ]);
      }
      const merged: TriviaQuestion = { ...cur, ...(body as Partial<TriviaQuestion>) };
      list[idx] = merged;
      await writeTrivia(sport, list);
      const commit = autoCommit(
        `assets/challenges/trivia_${sport}.json`,
        `chore(content): update trivia ${sport}/${id}`,
      );
      return { ok: true, item: merged, commit };
    }
    return notFound(reply, `trivia ${id}`);
  });

  fastify.delete('/admin/api/trivia/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    for (const sport of TRIVIA_SPORTS) {
      let list: TriviaQuestion[];
      try {
        list = await readTrivia(sport);
      } catch {
        continue;
      }
      const idx = list.findIndex((q2) => q2.id === id);
      if (idx === -1) continue;
      list[idx] = { ...list[idx]!, retired: true };
      await writeTrivia(sport, list);
      const commit = autoCommit(
        `assets/challenges/trivia_${sport}.json`,
        `chore(content): retire trivia ${sport}/${id}`,
      );
      return { ok: true, item: list[idx], commit };
    }
    return notFound(reply, `trivia ${id}`);
  });
}

// Shared helper: PATCH meta_json.video_*_url for players or teams.
async function updateMetaJsonVideoUrls(
  table: 'players' | 'teams',
  id: string,
  body: Record<string, unknown>,
  reply: FastifyReply,
): Promise<unknown> {
  const fetchRes = (await supabase
    .from(table)
    .select('id, meta_json')
    .eq('id', id)
    .limit(1)) as {
    data: Array<{ id: string; meta_json: Record<string, unknown> | null }> | null;
    error: { message: string } | null;
  };
  if (fetchRes.error) {
    reply.code(500).send({ ok: false, error: fetchRes.error.message });
    return reply;
  }
  const row = fetchRes.data?.[0];
  if (!row) return notFound(reply, `${table} ${id}`);
  const meta = { ...(row.meta_json ?? {}) };
  if (body['video_highlight_url'] !== undefined) {
    if (body['video_highlight_url'] === '') delete meta['video_highlight_url'];
    else meta['video_highlight_url'] = body['video_highlight_url'];
  }
  if (body['video_about_url'] !== undefined) {
    if (body['video_about_url'] === '') delete meta['video_about_url'];
    else meta['video_about_url'] = body['video_about_url'];
  }
  const updRes = (await supabase
    .from(table)
    .update({ meta_json: meta })
    .eq('id', id)) as { error: { message: string } | null };
  if (updRes.error) {
    reply.code(500).send({ ok: false, error: updRes.error.message });
    return reply;
  }
  return { ok: true, id, meta_json: meta };
}

// ─── HTML pages ──────────────────────────────────────────────────────────
// Shared inline CSS — matches /admin/dashboard tokens.
export const SHARED_STYLE = /* css */ `
  :root {
    --bg: #0b0f17; --card: #131a26; --card-2: #1a2333; --text: #e6edf3;
    --muted: #8aa0b8; --accent: #6cd4ff; --green: #4ade80; --yellow: #facc15;
    --red: #f87171; --gray: #6b7280; --border: #1f2a3b;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.45; padding: 24px;
  }
  .wrap { max-width: 1280px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: 0.3px; }
  .crumbs { font-size: 13px; color: var(--muted); }
  .crumbs a { color: var(--accent); text-decoration: none; }
  .crumbs a:hover { text-decoration: underline; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; }
  .toolbar input, .toolbar select {
    background: var(--card-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 10px; font-size: 13px; min-width: 140px;
  }
  .toolbar button, .btn {
    background: var(--card-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .btn.primary { background: rgba(108, 212, 255, 0.15); border-color: var(--accent); color: var(--accent); }
  .btn.danger { background: rgba(248,113,113,.1); border-color: var(--red); color: var(--red); }
  .btn:hover { filter: brightness(1.15); }
  .card-block {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; margin-bottom: 16px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  tr.dirty { background: rgba(250,204,21,0.06); }
  td input, td select, td textarea {
    background: var(--card-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 8px; font-size: 12px; width: 100%; font-family: inherit;
  }
  td textarea { min-height: 50px; resize: vertical; }
  .pager { display: flex; gap: 8px; justify-content: center; margin: 16px 0; align-items: center; color: var(--muted); font-size: 13px; }
  .err { color: var(--red); font-size: 12px; margin-top: 4px; }
  .ok { color: var(--green); font-size: 12px; margin-top: 4px; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
  .tag.common    { background: rgba(107,114,128,.25); color: var(--muted); }
  .tag.uncommon  { background: rgba(74,222,128,.15);  color: var(--green); }
  .tag.rare      { background: rgba(108,212,255,.15); color: var(--accent); }
  .tag.epic      { background: rgba(167,139,250,.15); color: #a78bfa; }
  .tag.legendary { background: rgba(250,204,21,.15);  color: var(--yellow); }
  .row-actions { white-space: nowrap; }
  details summary { cursor: pointer; color: var(--accent); font-size: 13px; }
  details[open] summary { margin-bottom: 8px; }
  .muted { color: var(--muted); font-size: 12px; }
  .hint { color: var(--muted); font-size: 11px; margin-top: 2px; }
  @media (max-width: 720px) {
    body { padding: 14px; }
    .toolbar { flex-direction: column; align-items: stretch; }
  }
`;

export const SHARED_CRUMBS = /* html */ `
  <nav class="crumbs">
    <a href="/admin/dashboard">← Dashboard</a> ·
    <a href="/admin/edit/players">Players</a> ·
    <a href="/admin/edit/teams">Teams</a> ·
    <a href="/admin/edit/cards">Cards</a> ·
    <a href="/admin/edit/trivia">Trivia</a> ·
    <a href="/admin/edit/advertising">Advertising</a> ·
    <a href="/admin/edit/safety">Safety matrix</a> ·
    <a href="/admin/edit/packs">Packs</a> ·
    <a href="/admin/edit/earn-rates">Earn rates</a> ·
    <a href="/admin/edit/subscriptions">Subscriptions</a> ·
    <a href="/admin/edit/streaks">Streaks</a> ·
    <a href="/admin/edit/triggers">Triggers</a> ·
    <a href="/admin/edit/stat-resolution">Stat resolution</a> ·
    <a href="/admin/edit/pity">Pity</a> ·
    <a href="/admin/edit/progression">Progression</a>
  </nav>
`;

function renderPlayersPage(): string {
  return /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PlayGM Editor · Players</title>
<style>${SHARED_STYLE}</style>
</head><body>
<div class="wrap">
  <header>
    <h1>Player Video Links</h1>
    ${SHARED_CRUMBS}
  </header>
  <div class="toolbar">
    <input id="q" placeholder="Search by name…" />
    <select id="sport">
      <option value="">All sports</option>
      <option>basketball</option><option>football</option>
      <option>baseball</option><option>hockey</option><option>soccer</option>
    </select>
    <input id="team_id" placeholder="Team UUID (optional)" />
    <button class="btn" id="apply">Apply</button>
    <span class="muted" id="meta">—</span>
  </div>
  <div class="card-block">
    <table id="tbl">
      <thead><tr>
        <th>Name</th><th>Pos</th><th>#</th><th>Sport</th>
        <th>Highlight URL</th><th>About URL</th><th>Actions</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="pager">
    <button class="btn" id="prev">‹ Prev</button>
    <span id="pageInfo">page 1</span>
    <button class="btn" id="next">Next ›</button>
  </div>
</div>
<script>${PLAYERS_JS}</script>
</body></html>`;
}

function renderTeamsPage(): string {
  return /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PlayGM Editor · Teams</title>
<style>${SHARED_STYLE}</style>
</head><body>
<div class="wrap">
  <header>
    <h1>Team Video Links</h1>
    ${SHARED_CRUMBS}
  </header>
  <div class="toolbar">
    <input id="q" placeholder="Search by full name…" />
    <select id="sport">
      <option value="">All sports</option>
      <option>basketball</option><option>football</option>
      <option>baseball</option><option>hockey</option><option>soccer</option>
    </select>
    <button class="btn" id="apply">Apply</button>
    <span class="muted" id="meta">—</span>
  </div>
  <div class="card-block">
    <table id="tbl">
      <thead><tr>
        <th>Team</th><th>Abbr</th><th>Sport</th>
        <th>Highlight URL</th><th>About URL</th><th>Actions</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>
<script>${TEAMS_JS}</script>
</body></html>`;
}

function renderCardsPage(): string {
  return /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PlayGM Editor · Card Templates</title>
<style>${SHARED_STYLE}</style>
</head><body>
<div class="wrap">
  <header>
    <h1>Card Template Inventory</h1>
    ${SHARED_CRUMBS}
  </header>
  <div class="muted" style="margin-bottom:10px;">
    Source: <code>data/cards/pgm_card_templates.json</code> · auto-commits on save (no push).
  </div>
  <div class="card-block">
    <table id="tbl">
      <thead><tr>
        <th>ID</th><th>Name</th><th>Type</th><th>Rarity</th>
        <th>Energy</th><th>Sport</th><th>Description (short)</th><th>Actions</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="card-block">
    <details>
      <summary>Add new card template</summary>
      <div style="margin-top:8px;">
        <table><tbody><tr id="newRow">
          <td><input id="n_template_id" placeholder="sb_common_xyz" /></td>
          <td><input id="n_name" placeholder="Display name" /></td>
          <td><select id="n_card_type"><option>stat_boost</option><option>ability</option><option>hybrid</option></select></td>
          <td><select id="n_rarity">${RARITIES.map((r) => `<option>${r}</option>`).join('')}</select></td>
          <td><input id="n_energy_cost" type="number" min="1" max="4" value="1" /></td>
          <td><select id="n_sport">${CARD_SPORTS.map((s) => `<option>${s}</option>`).join('')}</select></td>
          <td><input id="n_desc_short" placeholder="+5% primary stat" /></td>
          <td class="row-actions"><button class="btn primary" id="addBtn">Add</button></td>
        </tr></tbody></table>
        <div id="addStatus" class="hint"></div>
      </div>
    </details>
  </div>
</div>
<script>${CARDS_JS}</script>
</body></html>`;
}

function renderTriviaPage(): string {
  return /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PlayGM Editor · Trivia</title>
<style>${SHARED_STYLE}</style>
</head><body>
<div class="wrap">
  <header>
    <h1>Trivia Question Inventory</h1>
    ${SHARED_CRUMBS}
  </header>
  <div class="muted" style="margin-bottom:10px;">
    Source: <code>assets/challenges/trivia_&lt;sport&gt;.json</code> · auto-commits on save (no push).
  </div>
  <div class="toolbar">
    <input id="q" placeholder="Search question text or id…" />
    <select id="sport">
      <option value="">All sports</option>
      ${TRIVIA_SPORTS.map((s) => `<option>${s}</option>`).join('')}
    </select>
    <select id="difficulty">
      <option value="">Any difficulty</option>
      ${TRIVIA_DIFFICULTIES.map((d) => `<option>${d}</option>`).join('')}
    </select>
    <button class="btn" id="apply">Apply</button>
    <button class="btn primary" id="newBtn">+ New question</button>
    <span class="muted" id="meta">—</span>
  </div>
  <div class="card-block">
    <table id="tbl">
      <thead><tr>
        <th>ID</th><th>Sport</th><th>Diff</th><th>Cat</th>
        <th>Question</th><th>Actions</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="pager">
    <button class="btn" id="prev">‹ Prev</button>
    <span id="pageInfo">page 1</span>
    <button class="btn" id="next">Next ›</button>
  </div>
</div>
<script>${TRIVIA_JS}</script>
</body></html>`;
}

// Inline scripts (vanilla JS, no build step). Each editor mounts its own
// state and posts JSON to the matching /admin/api endpoints.
const PLAYERS_JS = /* javascript */ `
(() => {
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let page = 1, perPage = 50;
  function paramsObj() {
    const p = new URLSearchParams();
    if (el('q').value) p.set('q', el('q').value);
    if (el('sport').value) p.set('sport', el('sport').value);
    if (el('team_id').value) p.set('team_id', el('team_id').value);
    p.set('page', page); p.set('per_page', perPage);
    return p;
  }
  async function load() {
    const res = await fetch('/admin/api/players?' + paramsObj().toString());
    const json = await res.json();
    if (!json.ok) { el('meta').textContent = json.error || 'error'; return; }
    el('meta').textContent = json.total + ' players · page ' + json.page;
    const tbody = el('tbl').querySelector('tbody');
    tbody.innerHTML = json.items.map(p => \`
      <tr data-id="\${esc(p.id)}">
        <td>\${esc(p.full_name)}</td>
        <td>\${esc(p.position||'')}</td>
        <td>\${esc(p.jersey_number||'')}</td>
        <td>\${esc(p.sport)}</td>
        <td><input class="hl" value="\${esc(p.video_highlight_url)}" placeholder="https://…" /></td>
        <td><input class="ab" value="\${esc(p.video_about_url)}" placeholder="https://…" /></td>
        <td class="row-actions"><button class="btn primary save">Save</button><div class="hint status"></div></td>
      </tr>\`).join('');
    el('pageInfo').textContent = 'page ' + json.page + ' of ' + Math.max(1, Math.ceil(json.total/perPage));
    tbody.querySelectorAll('button.save').forEach(b => b.addEventListener('click', save));
  }
  async function save(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const status = tr.querySelector('.status');
    const body = {
      video_highlight_url: tr.querySelector('.hl').value.trim(),
      video_about_url:     tr.querySelector('.ab').value.trim(),
    };
    status.textContent = 'saving…';
    const res = await fetch('/admin/api/players/' + id, {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      status.innerHTML = '<span class="err">' + esc((json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || json.error || 'error') + '</span>';
      return;
    }
    status.innerHTML = '<span class="ok">saved</span>';
    setTimeout(() => status.textContent = '', 1800);
  }
  el('apply').addEventListener('click', () => { page = 1; load(); });
  el('q').addEventListener('keydown', e => { if (e.key === 'Enter') { page = 1; load(); }});
  el('prev').addEventListener('click', () => { if (page > 1) { page--; load(); }});
  el('next').addEventListener('click', () => { page++; load(); });
  load();
})();
`;

const TEAMS_JS = /* javascript */ `
(() => {
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function paramsObj() {
    const p = new URLSearchParams();
    if (el('q').value) p.set('q', el('q').value);
    if (el('sport').value) p.set('sport', el('sport').value);
    return p;
  }
  async function load() {
    const res = await fetch('/admin/api/teams?' + paramsObj().toString());
    const json = await res.json();
    if (!json.ok) { el('meta').textContent = json.error || 'error'; return; }
    el('meta').textContent = json.items.length + ' / ' + json.total + ' teams';
    const tbody = el('tbl').querySelector('tbody');
    tbody.innerHTML = json.items.map(t => \`
      <tr data-id="\${esc(t.id)}">
        <td>\${esc(t.full_name)}</td>
        <td>\${esc(t.abbreviation||'')}</td>
        <td>\${esc(t.sport)}</td>
        <td><input class="hl" value="\${esc(t.video_highlight_url)}" placeholder="https://…" /></td>
        <td><input class="ab" value="\${esc(t.video_about_url)}" placeholder="https://…" /></td>
        <td class="row-actions"><button class="btn primary save">Save</button><div class="hint status"></div></td>
      </tr>\`).join('');
    tbody.querySelectorAll('button.save').forEach(b => b.addEventListener('click', save));
  }
  async function save(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const status = tr.querySelector('.status');
    const body = {
      video_highlight_url: tr.querySelector('.hl').value.trim(),
      video_about_url:     tr.querySelector('.ab').value.trim(),
    };
    status.textContent = 'saving…';
    const res = await fetch('/admin/api/teams/' + id, {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      status.innerHTML = '<span class="err">' + esc((json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || json.error || 'error') + '</span>';
      return;
    }
    status.innerHTML = '<span class="ok">saved</span>';
    setTimeout(() => status.textContent = '', 1800);
  }
  el('apply').addEventListener('click', load);
  el('q').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
  load();
})();
`;

const CARDS_JS = /* javascript */ `
(() => {
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const RARITIES = ${JSON.stringify(RARITIES)};
  const CARD_TYPES = ${JSON.stringify(CARD_TYPES)};
  const CARD_SPORTS = ${JSON.stringify(CARD_SPORTS)};
  function opt(arr, sel) { return arr.map(v => '<option' + (v===sel?' selected':'') + '>' + v + '</option>').join(''); }
  async function load() {
    const res = await fetch('/admin/api/cards');
    const json = await res.json();
    if (!json.ok) return;
    const tbody = el('tbl').querySelector('tbody');
    tbody.innerHTML = json.items.map(c => \`
      <tr data-id="\${esc(c.template_id)}" \${c.retired?'class="dirty"':''}>
        <td><code>\${esc(c.template_id)}</code>\${c.retired?' <span class="tag">retired</span>':''}</td>
        <td><input class="f-name" value="\${esc(c.name)}" /></td>
        <td><select class="f-card_type">\${opt(CARD_TYPES, c.card_type)}</select></td>
        <td><select class="f-rarity">\${opt(RARITIES, c.rarity)}</select></td>
        <td><input class="f-energy_cost" type="number" min="1" max="4" value="\${esc(c.energy_cost)}" /></td>
        <td><select class="f-sport">\${opt(CARD_SPORTS, c.sport)}</select></td>
        <td><input class="f-desc_short" value="\${esc((c.display||{}).description_short||'')}" /></td>
        <td class="row-actions">
          <button class="btn primary save">Save</button>
          \${c.retired?'':'<button class="btn danger del">Retire</button>'}
          <div class="hint status"></div>
        </td>
      </tr>\`).join('');
    tbody.querySelectorAll('button.save').forEach(b => b.addEventListener('click', save));
    tbody.querySelectorAll('button.del').forEach(b => b.addEventListener('click', del));
  }
  async function save(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const status = tr.querySelector('.status');
    const body = {
      name: tr.querySelector('.f-name').value,
      card_type: tr.querySelector('.f-card_type').value,
      rarity: tr.querySelector('.f-rarity').value,
      energy_cost: parseInt(tr.querySelector('.f-energy_cost').value, 10),
      sport: tr.querySelector('.f-sport').value,
      display: { description_short: tr.querySelector('.f-desc_short').value },
    };
    status.textContent = 'saving…';
    const res = await fetch('/admin/api/cards/' + encodeURIComponent(id), {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      status.innerHTML = '<span class="err">' + esc((json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || json.error || 'error') + '</span>';
      return;
    }
    status.innerHTML = '<span class="ok">saved</span>';
    setTimeout(() => status.textContent = '', 1800);
  }
  async function del(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    if (!confirm('Retire ' + id + '?')) return;
    const res = await fetch('/admin/api/cards/' + encodeURIComponent(id), { method: 'DELETE' });
    const json = await res.json();
    if (json.ok) load();
  }
  el('addBtn').addEventListener('click', async () => {
    const status = el('addStatus');
    const body = {
      template_id: el('n_template_id').value.trim(),
      name: el('n_name').value.trim(),
      card_type: el('n_card_type').value,
      rarity: el('n_rarity').value,
      energy_cost: parseInt(el('n_energy_cost').value, 10),
      sport: el('n_sport').value,
      effect: { type: 'stat_boost', stat_boosts: [] },
      display: { description_short: el('n_desc_short').value.trim() },
    };
    status.textContent = 'saving…';
    const res = await fetch('/admin/api/cards', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      status.innerHTML = '<span class="err">' + esc((json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || json.error || 'error') + '</span>';
      return;
    }
    status.innerHTML = '<span class="ok">added</span>';
    load();
  });
  load();
})();
`;

const TRIVIA_JS = /* javascript */ `
(() => {
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const SPORTS = ${JSON.stringify(TRIVIA_SPORTS)};
  const DIFF = ${JSON.stringify(TRIVIA_DIFFICULTIES)};
  const CATS = ${JSON.stringify(TRIVIA_CATEGORIES)};
  function opt(arr, sel) { return arr.map(v => '<option' + (v===sel?' selected':'') + '>' + v + '</option>').join(''); }
  let page = 1, perPage = 25;
  function paramsObj() {
    const p = new URLSearchParams();
    if (el('q').value) p.set('q', el('q').value);
    if (el('sport').value) p.set('sport', el('sport').value);
    if (el('difficulty').value) p.set('difficulty', el('difficulty').value);
    p.set('page', page); p.set('per_page', perPage);
    return p;
  }
  async function load() {
    const res = await fetch('/admin/api/trivia?' + paramsObj().toString());
    const json = await res.json();
    if (!json.ok) { el('meta').textContent = json.error || 'error'; return; }
    el('meta').textContent = json.total + ' questions · page ' + json.page;
    el('pageInfo').textContent = 'page ' + json.page + ' of ' + Math.max(1, Math.ceil(json.total/perPage));
    const tbody = el('tbl').querySelector('tbody');
    tbody.innerHTML = json.items.map(q => \`
      <tr data-id="\${esc(q.id)}">
        <td><code>\${esc(q.id)}</code>\${q.retired?' <span class="tag">retired</span>':''}</td>
        <td>\${esc(q.sport)}</td>
        <td>\${esc(q.difficulty)}</td>
        <td>\${esc(q.category)}</td>
        <td>\${esc(q.question)}</td>
        <td class="row-actions">
          <button class="btn edit">Edit</button>
          \${q.retired?'':'<button class="btn danger del">Retire</button>'}
        </td>
      </tr>
      <tr class="exp" data-id="\${esc(q.id)}" style="display:none;"><td colspan="6">
        <div style="display:grid;grid-template-columns:120px 1fr;gap:6px;align-items:center;">
          <label>Question</label><textarea class="f-question">\${esc(q.question)}</textarea>
          <label>Difficulty</label><select class="f-difficulty">\${opt(DIFF, q.difficulty)}</select>
          <label>Category</label><select class="f-category">\${opt(CATS, q.category)}</select>
          <label>Option 1</label><input class="f-opt-0" value="\${esc(q.answer_options[0]||'')}" />
          <label>Option 2</label><input class="f-opt-1" value="\${esc(q.answer_options[1]||'')}" />
          <label>Option 3</label><input class="f-opt-2" value="\${esc(q.answer_options[2]||'')}" />
          <label>Option 4</label><input class="f-opt-3" value="\${esc(q.answer_options[3]||'')}" />
          <label>Correct</label><select class="f-correct">\${[0,1,2,3].map(i => '<option value="'+i+'"'+ (q.answer_options[i]===q.answer_correct?' selected':'') +'>Option '+(i+1)+'</option>').join('')}</select>
          <label>Explanation</label><textarea class="f-explanation">\${esc(q.explanation||'')}</textarea>
        </div>
        <div style="margin-top:8px;"><button class="btn primary save">Save</button> <span class="hint status"></span></div>
      </td></tr>
    \`).join('');
    tbody.querySelectorAll('button.edit').forEach(b => b.addEventListener('click', toggle));
    tbody.querySelectorAll('button.save').forEach(b => b.addEventListener('click', save));
    tbody.querySelectorAll('button.del').forEach(b => b.addEventListener('click', del));
  }
  function toggle(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    const exp = document.querySelector('tr.exp[data-id="'+id+'"]');
    exp.style.display = exp.style.display === 'none' ? '' : 'none';
  }
  async function save(ev) {
    const exp = ev.target.closest('tr.exp');
    const id = exp.dataset.id;
    const status = exp.querySelector('.status');
    const opts = [0,1,2,3].map(i => exp.querySelector('.f-opt-'+i).value);
    const correctIdx = parseInt(exp.querySelector('.f-correct').value, 10);
    const body = {
      question: exp.querySelector('.f-question').value,
      difficulty: exp.querySelector('.f-difficulty').value,
      category: exp.querySelector('.f-category').value,
      answer_options: opts,
      answer_correct: opts[correctIdx],
      explanation: exp.querySelector('.f-explanation').value,
    };
    status.textContent = 'saving…';
    const res = await fetch('/admin/api/trivia/' + encodeURIComponent(id), {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      status.innerHTML = '<span class="err">' + esc((json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || json.error || 'error') + '</span>';
      return;
    }
    status.innerHTML = '<span class="ok">saved</span>';
    setTimeout(() => status.textContent = '', 1800);
  }
  async function del(ev) {
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id;
    if (!confirm('Retire ' + id + '?')) return;
    const res = await fetch('/admin/api/trivia/' + encodeURIComponent(id), { method: 'DELETE' });
    const json = await res.json();
    if (json.ok) load();
  }
  el('newBtn').addEventListener('click', async () => {
    const sport = prompt('Sport (' + SPORTS.join('|') + ')?');
    if (!sport || !SPORTS.includes(sport)) return alert('invalid sport');
    const id = prompt('New ID (e.g. ' + sport + '_e_rules_999):');
    if (!id) return;
    const question = prompt('Question?');
    if (!question) return;
    const opts = [0,1,2,3].map(i => prompt('Option ' + (i+1) + '?'));
    if (opts.some(o => !o)) return alert('all 4 options required');
    const correctIdx = parseInt(prompt('Correct option (1-4)?'), 10) - 1;
    if (isNaN(correctIdx) || correctIdx < 0 || correctIdx > 3) return alert('invalid correct');
    const body = {
      id, sport, difficulty: 'medium', category: 'fun',
      question, answer_options: opts, answer_correct: opts[correctIdx],
    };
    const res = await fetch('/admin/api/trivia', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.ok) load();
    else alert((json.errors||[]).map(e=>e.field+': '+e.message).join('\\n') || json.error);
  });
  el('apply').addEventListener('click', () => { page = 1; load(); });
  el('q').addEventListener('keydown', e => { if (e.key === 'Enter') { page = 1; load(); }});
  el('prev').addEventListener('click', () => { if (page > 1) { page--; load(); }});
  el('next').addEventListener('click', () => { page++; load(); });
  load();
})();
`;

// ─── Advertising editor page ─────────────────────────────────────────────
function renderAdvertisingPage(): string {
  return /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PlayGM Editor · Advertising</title>
<style>${SHARED_STYLE}</style>
</head><body>
<div class="wrap">
  <header>
    <h1>Advertising Actuals</h1>
    ${SHARED_CRUMBS}
  </header>
  <div class="muted" style="margin-bottom:10px;">
    Source: <code>data/marketing/channel_actuals.json</code> · auto-commits on save (no push).
    All targets in <code>channel_definitions.json</code> are extrapolated / industry-standard — not in any GDD.
  </div>
  <div id="ad-channels" class="muted">Loading channels…</div>
</div>
<script>${ADVERTISING_JS}</script>
</body></html>`;
}

const ADVERTISING_JS = /* javascript */ `
(() => {
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function audienceBadges(a) {
    if (!a || !a.length) return '';
    return a.map(t => {
      const cls = /COPPA|<13/.test(t) ? 'fail' : (/kid-safe|8\\+/.test(t) ? 'warn' : 'ok');
      return '<span class="status-pill ' + cls + '" style="margin-right:4px;">' + esc(t) + '</span>';
    }).join('');
  }
  async function loadAll() {
    const res = await fetch('/admin/api/advertising');
    const json = await res.json();
    if (!json || !json.channels) {
      el('ad-channels').textContent = 'Failed to load advertising data.';
      return;
    }
    const root = el('ad-channels');
    root.classList.remove('muted');
    root.innerHTML = json.channels.map(buildCardHtml).join('');
    json.channels.forEach((c) => wireCard(c));
  }
  function buildCardHtml(c) {
    const cur = (c.current || {});
    const lm  = (c.last_month || {});
    const rows = c.target ? Object.keys(c).filter(()=>false) : [];
    void rows;
    const target = c.target || {};
    const targetLines = Object.entries(target).map(([k,v]) =>
      '<div class="kv"><span class="k">' + esc(k) + '</span><span><code>' + esc(String(v)) + '</code> <span class="status-pill warn" title="' + esc(c.target_source||'') + '">extrapolated</span></span></div>'
    ).join('');
    function row(metricKey) {
      const isUsd = /_usd$/.test(metricKey);
      const step = isUsd ? '0.01' : '1';
      const min = '0';
      return '<tr data-key="' + esc(metricKey) + '">' +
        '<td><code>' + esc(metricKey) + '</code></td>' +
        '<td><input type="number" min="' + min + '" step="' + step + '" class="cur" value="' + esc(cur[metricKey] != null ? cur[metricKey] : '') + '" /></td>' +
        '<td><input type="number" min="' + min + '" step="' + step + '" class="lm"  value="' + esc(lm[metricKey]  != null ? lm[metricKey]  : '') + '" /></td>' +
        '</tr>';
    }
    return '<div class="card-block" data-channel="' + esc(c.channel_id) + '">' +
      '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
        '<div><strong>' + esc(c.display_name) + '</strong> <span class="muted">· ' + esc(c.category) + ' · KPI: <code>' + esc(c.kpi_focus) + '</code></span></div>' +
        '<div>' + audienceBadges(c.audience_constraints) + '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 240px;gap:12px;margin-top:10px;align-items:start;">' +
        '<div><table>' +
          '<thead><tr><th>Metric</th><th>Current month</th><th>Last month</th></tr></thead>' +
          '<tbody>' + c.metric_keys.map(row).join('') + '</tbody>' +
        '</table>' +
        '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;">' +
          '<button class="btn primary save">Save</button>' +
          '<span class="hint status"></span>' +
        '</div></div>' +
        '<div><div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Targets</div>' +
          targetLines + '</div>' +
      '</div>' +
    '</div>';
  }
  function wireCard(c) {
    const card = document.querySelector('[data-channel="' + c.channel_id + '"]');
    if (!card) return;
    const btn = card.querySelector('button.save');
    btn.addEventListener('click', async () => {
      const status = card.querySelector('.status');
      const current_month = {};
      const last_month = {};
      card.querySelectorAll('tr[data-key]').forEach(tr => {
        const k = tr.dataset.key;
        const cv = tr.querySelector('input.cur').value;
        const lv = tr.querySelector('input.lm').value;
        if (cv !== '') {
          const n = Number(cv);
          if (!Number.isNaN(n)) current_month[k] = n;
        }
        if (lv !== '') {
          const n = Number(lv);
          if (!Number.isNaN(n)) last_month[k] = n;
        }
      });
      status.textContent = 'saving…';
      const res = await fetch('/admin/api/advertising/' + encodeURIComponent(c.channel_id), {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ current_month, last_month })
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        status.innerHTML = '<span class="err">' + esc((json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || json.error || 'error') + '</span>';
        return;
      }
      status.innerHTML = '<span class="ok">saved · ' + (json.commit && json.commit.ok ? 'committed' : 'no commit') + '</span>';
      setTimeout(() => status.textContent = '', 2400);
    });
  }
  loadAll();
})();
`;

// ─── Safety matrix editor page ───────────────────────────────────────────
function renderSafetyPage(): string {
  return /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PlayGM Editor · Safety Matrix</title>
<style>${SHARED_STYLE}
  table.matrix th, table.matrix td { font-size: 12px; padding: 6px 8px; }
  table.matrix .ages td { text-align: center; min-width: 26px; }
  table.matrix .ages .a-allow    { background: rgba(74,222,128,.18); color: var(--green);  }
  table.matrix .ages .a-mod      { background: rgba(250,204,21,.20); color: var(--yellow); }
  table.matrix .ages .a-blocked  { background: rgba(248,113,113,.18); color: var(--red);   }
  table.matrix .ages .a-off      { background: rgba(107,114,128,.20); color: var(--muted); }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0 14px; font-size: 12px; }
  .legend span { display: inline-block; padding: 1px 8px; border-radius: 999px; }
  details.feat { background: var(--card-2); border-radius: 8px; padding: 8px 12px; margin-top: 6px; }
  details.feat summary { color: var(--text); font-weight: 500; }
  details.feat .form { display: grid; grid-template-columns: 200px 1fr; gap: 6px 12px; margin-top: 8px; align-items: center; }
  details.feat .form label { color: var(--muted); font-size: 12px; }
  details.feat textarea { min-height: 56px; }
  .tabs { display: flex; gap: 4px; margin: 4px 0 14px; border-bottom: 1px solid var(--border); }
  .tabs button { background: transparent; border: 0; color: var(--muted); padding: 8px 14px; cursor: pointer; font-weight: 600; border-bottom: 2px solid transparent; }
  .tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  details.usr { background: var(--card-2); border-radius: 8px; padding: 8px 12px; margin-top: 6px; }
  details.usr summary { color: var(--text); font-weight: 500; }
  table.usr-feat { width: 100%; margin-top: 8px; font-size: 12px; }
  table.usr-feat th, table.usr-feat td { padding: 4px 8px; text-align: left; vertical-align: top; }
  table.usr-feat .pill { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 11px; }
  table.usr-feat .pill.matrix { background: rgba(107,114,128,.20); color: var(--muted); }
  table.usr-feat .pill.override { background: rgba(99,102,241,.20); color: var(--accent); }
  .uso-search-row { display: flex; gap: 8px; margin: 6px 0; }
  .uso-search-row input { flex: 1; }
</style>
</head><body>
<div class="wrap">
  <header>
    <h1>Safety Matrix Editor</h1>
    ${SHARED_CRUMBS}
  </header>
  <div class="muted" style="margin-bottom:10px;">
    Source: <code>data/safety/age_feature_matrix.json</code> · auto-commits on save (no push). ·
    Long-form rationale lives in <code>docs/gdd/age-recommendations.md</code>.
  </div>

  <div class="tabs" id="safety-tabs">
    <button class="active" data-tab="matrix">Age Matrix</button>
    <button data-tab="peruser">Per-User Overrides</button>
  </div>

  <div class="tab-panel active" id="tab-matrix">
    <div class="legend">
      <span class="status-pill ok">allow</span>
      <span class="status-pill warn">moderated</span>
      <span class="status-pill unmeas">off (parent override)</span>
      <span class="status-pill fail">blocked (statutory floor)</span>
    </div>
    <div id="meta" class="muted">Loading…</div>
    <div class="card-block" id="matrix-grid-card">
      <table class="matrix" id="matrix-grid">
        <thead><tr id="matrix-grid-head"></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div id="features-list"></div>
  </div>

  <div class="tab-panel" id="tab-peruser">
    <div id="uso-summary" class="muted">Loading override summary…</div>
    <div class="uso-search-row">
      <input id="uso-search" type="search" placeholder="search users by handle or paste a UUID" />
      <button class="btn primary" id="uso-search-btn">Search</button>
    </div>
    <div id="uso-results"></div>
  </div>
</div>
<script>${SAFETY_JS}</script>
</body></html>`;
}

const SAFETY_JS = /* javascript */ `
(() => {
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const AGES = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

  function decideForAge(f, age) {
    if ((f.ages_blocked || []).includes(age)) return 'blocked';
    if ((f.ages_with_moderation || []).includes(age)) return 'moderated';
    const neverDefault = f.min_age_default_on === 0 && f.max_age_default_on === 0;
    if (!neverDefault && age >= f.min_age_default_on && age <= f.max_age_default_on) return 'allow';
    return f.parent_override_allowed ? 'off' : 'blocked';
  }
  function classFor(d) { return d === 'allow' ? 'a-allow' : d === 'moderated' ? 'a-mod' : d === 'off' ? 'a-off' : 'a-blocked'; }
  function symFor(d)   { return d === 'allow' ? '✓' : d === 'moderated' ? 'M' : d === 'off' ? '○' : '✗'; }

  async function load() {
    const res = await fetch('/admin/api/safety-matrix');
    const json = await res.json();
    if (!json.ok) {
      el('meta').textContent = json.error || 'failed to load matrix';
      return;
    }
    el('meta').innerHTML = '<code>v' + esc(json.version) + '</code> · ' + esc(json.features.length) + ' features · ages ' + esc(json.age_range.min) + '–' + esc(json.age_range.max) + ' · last edited <code>' + esc(new Date(json.last_updated_iso).toLocaleString()) + '</code>';

    // Compact grid: rows = features, cols = ages 5..14
    const head = ['<th style="text-align:left;">feature</th>'].concat(AGES.map(a => '<th>' + a + '</th>')).join('');
    el('matrix-grid-head').innerHTML = head;
    const body = el('matrix-grid').querySelector('tbody');
    body.innerHTML = json.features.map(f =>
      '<tr class="ages" data-id="' + esc(f.feature_id) + '">' +
        '<td style="text-align:left;"><a href="#feat-' + esc(f.feature_id) + '" style="color:var(--accent);text-decoration:none;">' + esc(f.label) + '</a></td>' +
        AGES.map(age => {
          const d = decideForAge(f, age);
          return '<td class="' + classFor(d) + '" title="' + esc(d) + '">' + symFor(d) + '</td>';
        }).join('') +
      '</tr>'
    ).join('');

    // Detailed editable list — one details block per feature.
    const list = el('features-list');
    list.innerHTML = json.features.map(f =>
      '<details class="feat" id="feat-' + esc(f.feature_id) + '" data-id="' + esc(f.feature_id) + '">' +
        '<summary><strong>' + esc(f.label) + '</strong> · <code>' + esc(f.feature_id) + '</code> · ' +
          '<span class="muted">' + esc(f.category) + '</span></summary>' +
        '<div class="form">' +
          '<label>min_age_default_on</label>' +
          '<input type="number" min="0" max="14" class="f-min_age_default_on" value="' + esc(f.min_age_default_on) + '" />' +
          '<label>max_age_default_on</label>' +
          '<input type="number" min="0" max="14" class="f-max_age_default_on" value="' + esc(f.max_age_default_on) + '" />' +
          '<label>ages_with_moderation</label>' +
          '<input class="f-ages_with_moderation" value="' + esc((f.ages_with_moderation||[]).join(',')) + '" placeholder="comma-separated, e.g. 8,9,10" />' +
          '<label>ages_blocked</label>' +
          '<input class="f-ages_blocked" value="' + esc((f.ages_blocked||[]).join(',')) + '" placeholder="comma-separated, e.g. 5,6,7" />' +
          '<label>parent_override_allowed</label>' +
          '<select class="f-parent_override_allowed">' +
            '<option value="true"' + (f.parent_override_allowed ? ' selected':'') + '>true</option>' +
            '<option value="false"' + (!f.parent_override_allowed ? ' selected':'') + '>false</option>' +
          '</select>' +
          '<label>requires_parent_consent_under</label>' +
          '<input type="number" min="0" max="18" class="f-requires_parent_consent_under" value="' + esc(f.requires_parent_consent_under) + '" />' +
          '<label>rationale</label>' +
          '<textarea class="f-rationale">' + esc(f.rationale) + '</textarea>' +
          '<label>source</label>' +
          '<input class="f-source" value="' + esc(f.source) + '" />' +
          '<label></label>' +
          '<div><button class="btn primary save">Save</button> <span class="hint status"></span></div>' +
        '</div>' +
      '</details>'
    ).join('');

    list.querySelectorAll('button.save').forEach(b => b.addEventListener('click', save));
  }

  function parseAgeList(s) {
    if (!s || !s.trim()) return [];
    return s.split(',').map(x => x.trim()).filter(Boolean).map(Number).filter(n => Number.isInteger(n));
  }

  async function save(ev) {
    const root = ev.target.closest('details.feat');
    const id = root.dataset.id;
    const status = root.querySelector('.status');
    const body = {
      min_age_default_on: parseInt(root.querySelector('.f-min_age_default_on').value, 10),
      max_age_default_on: parseInt(root.querySelector('.f-max_age_default_on').value, 10),
      ages_with_moderation: parseAgeList(root.querySelector('.f-ages_with_moderation').value),
      ages_blocked: parseAgeList(root.querySelector('.f-ages_blocked').value),
      parent_override_allowed: root.querySelector('.f-parent_override_allowed').value === 'true',
      requires_parent_consent_under: parseInt(root.querySelector('.f-requires_parent_consent_under').value, 10),
      rationale: root.querySelector('.f-rationale').value,
      source: root.querySelector('.f-source').value,
    };
    status.textContent = 'saving…';
    const res = await fetch('/admin/api/safety-matrix/' + encodeURIComponent(id), {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      status.innerHTML = '<span class="err">' + esc((json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || json.error || 'error') + '</span>';
      return;
    }
    status.innerHTML = '<span class="ok">saved · ' + (json.commit && json.commit.ok ? 'committed' : 'no commit') + '</span>';
    setTimeout(() => { status.textContent = ''; load(); }, 1600);
  }

  // ─── Tab switcher ──────────────────────────────────────────────────────
  document.querySelectorAll('#safety-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#safety-tabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById('tab-' + btn.dataset.tab);
      if (target) target.classList.add('active');
      if (btn.dataset.tab === 'peruser' && !window.__usoBootstrapped) {
        window.__usoBootstrapped = true;
        usoLoadSummary();
      }
    });
  });

  // ─── Per-user overrides ────────────────────────────────────────────────
  // Loads matrix once, caches it, then for each searched user pulls their
  // overrides + computes the per-feature effective view client-side using
  // the same decideForAge() above. Save round-trips via PATCH.
  let __matrixCache = null;
  async function ensureMatrix() {
    if (__matrixCache) return __matrixCache;
    const res = await fetch('/admin/api/safety-matrix');
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'matrix load failed');
    __matrixCache = json;
    return json;
  }

  async function usoLoadSummary() {
    const res = await fetch('/admin/api/user-safety-overrides/summary');
    const json = await res.json();
    if (!json.ok) {
      el('uso-summary').innerHTML = '<span class="err">' + esc(json.error || 'failed') + '</span>';
      return;
    }
    el('uso-summary').innerHTML =
      '<strong>' + esc(json.distinct_users) + '</strong> users with overrides ' +
      '· <strong>' + esc(json.total_overrides) + '</strong> rows ' +
      '· across <strong>' + esc(json.distinct_features) + '</strong> features';
  }

  function birthYearToAge(by) {
    if (by == null) return null;
    return new Date().getFullYear() - by;
  }

  function decisionForUser(feature, age, overrideRow) {
    if (overrideRow) return overrideRow.enabled ? 'allow' : 'blocked';
    if (age == null) return 'blocked';
    return decideForAge(feature, age);
  }

  async function usoSearch() {
    const q = el('uso-search').value.trim();
    const url = '/admin/api/user-safety-overrides/users' + (q ? '?q=' + encodeURIComponent(q) : '');
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) {
      el('uso-results').innerHTML = '<span class="err">' + esc(json.error || 'failed') + '</span>';
      return;
    }
    if (!(json.users || []).length) {
      el('uso-results').innerHTML = '<div class="muted">no users found</div>';
      return;
    }
    el('uso-results').innerHTML = json.users.map(u =>
      '<details class="usr" data-uid="' + esc(u.id) + '">' +
        '<summary><strong>' + esc(u.handle || '(no handle)') + '</strong> · <code>' + esc(u.id) + '</code> · age ' + esc(birthYearToAge(u.birth_year) ?? '?') + '</summary>' +
        '<div class="uso-body">loading…</div>' +
      '</details>'
    ).join('');
    document.querySelectorAll('details.usr').forEach(d => {
      d.addEventListener('toggle', () => {
        if (d.open && !d.dataset.loaded) {
          d.dataset.loaded = '1';
          renderUserBody(d);
        }
      });
    });
  }

  async function renderUserBody(detailsEl) {
    const userId = detailsEl.dataset.uid;
    const body = detailsEl.querySelector('.uso-body');
    const matrix = await ensureMatrix();
    const userRes = await fetch('/admin/api/user-safety-overrides/' + encodeURIComponent(userId));
    const userJson = await userRes.json();
    if (!userJson.ok) {
      body.innerHTML = '<span class="err">' + esc(userJson.error || 'failed') + '</span>';
      return;
    }
    const overrideMap = new Map();
    for (const o of (userJson.overrides || [])) overrideMap.set(o.feature_id, o);
    // Pull age from the user list above
    const summarySpan = detailsEl.querySelector('summary');
    const ageMatch = summarySpan.textContent.match(/age (\\d+|\\?)/);
    const age = ageMatch && ageMatch[1] !== '?' ? parseInt(ageMatch[1], 10) : null;

    const rows = matrix.features.map(f => {
      const override = overrideMap.get(f.feature_id);
      const baseline = age != null ? decideForAge(f, age) : 'blocked';
      const effective = decisionForUser(f, age, override);
      const source = override ? 'override' : 'matrix';
      const reason = override ? (override.reason || '') : '';
      return (
        '<tr data-fid="' + esc(f.feature_id) + '">' +
          '<td><code>' + esc(f.feature_id) + '</code><br><span class="muted">' + esc(f.label) + '</span></td>' +
          '<td><span class="pill ' + classFor(baseline) + '">' + esc(baseline) + '</span></td>' +
          '<td>' +
            '<select class="f-mode">' +
              '<option value="inherit"' + (override ? '' : ' selected') + '>inherit (matrix)</option>' +
              '<option value="allow"'   + (override && override.enabled ? ' selected' : '') + '>allow</option>' +
              '<option value="block"'   + (override && !override.enabled ? ' selected' : '') + '>block</option>' +
            '</select>' +
          '</td>' +
          '<td><input class="f-reason" placeholder="reason (required if overriding)" value="' + esc(reason) + '" /></td>' +
          '<td><span class="pill ' + (source === 'override' ? 'override' : 'matrix') + '">' + esc(effective) + '</span></td>' +
          '<td><button class="btn primary save-uso">Save</button> <span class="uso-status hint"></span></td>' +
        '</tr>'
      );
    }).join('');
    body.innerHTML =
      '<table class="usr-feat"><thead><tr>' +
        '<th>feature</th><th>matrix baseline</th><th>override</th><th>reason</th><th>effective</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
    body.querySelectorAll('button.save-uso').forEach(b => b.addEventListener('click', (ev) => saveUso(ev, userId)));
  }

  async function saveUso(ev, userId) {
    const tr = ev.target.closest('tr');
    const fid = tr.dataset.fid;
    const mode = tr.querySelector('.f-mode').value;
    const reason = tr.querySelector('.f-reason').value.trim();
    const status = tr.querySelector('.uso-status');
    if (mode === 'inherit') {
      status.textContent = 'reverting…';
      const res = await fetch('/admin/api/user-safety-overrides/' + encodeURIComponent(userId) + '/' + encodeURIComponent(fid), { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        status.innerHTML = '<span class="err">' + esc(json.error || 'error') + '</span>';
        return;
      }
      status.innerHTML = '<span class="ok">reverted</span>';
    } else {
      if (!reason) {
        status.innerHTML = '<span class="err">reason required</span>';
        return;
      }
      const enabled = mode === 'allow';
      status.textContent = 'saving…';
      const res = await fetch('/admin/api/user-safety-overrides/' + encodeURIComponent(userId) + '/' + encodeURIComponent(fid), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, reason }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        status.innerHTML = '<span class="err">' + esc((json.errors||[]).map(e=>e.field+': '+e.message).join(', ') || json.error || 'error') + '</span>';
        return;
      }
      status.innerHTML = '<span class="ok">saved</span>';
    }
    setTimeout(() => { status.textContent = ''; usoLoadSummary(); }, 1500);
  }

  el('uso-search-btn').addEventListener('click', usoSearch);
  el('uso-search').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') usoSearch(); });

  load();
})();
`;
