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

// ─── Project root resolution (mirrors admin.ts) ──────────────────────────
function findProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, path.resolve(cwd, '..'), path.resolve(cwd, '..', '..')];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'data', 'cards', 'pgm_card_templates.json'))) return c;
  }
  return cwd;
}
const PROJECT_ROOT = findProjectRoot();
const CARD_TEMPLATES_PATH = path.join(PROJECT_ROOT, 'data', 'cards', 'pgm_card_templates.json');
const TRIVIA_DIR = path.join(PROJECT_ROOT, 'assets', 'challenges');

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

interface ValidationError {
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
function autoCommit(relPath: string, subject: string): { ok: boolean; error?: string } {
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
function badRequest(reply: FastifyReply, errors: ValidationError[]): FastifyReply {
  reply.code(400).send({ ok: false, errors });
  return reply;
}

function notFound(reply: FastifyReply, what: string): FastifyReply {
  reply.code(404).send({ ok: false, error: `${what} not found` });
  return reply;
}

function escHtml(s: string): string {
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
const SHARED_STYLE = /* css */ `
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

const SHARED_CRUMBS = /* html */ `
  <nav class="crumbs">
    <a href="/admin/dashboard">← Dashboard</a> ·
    <a href="/admin/edit/players">Players</a> ·
    <a href="/admin/edit/teams">Teams</a> ·
    <a href="/admin/edit/cards">Cards</a> ·
    <a href="/admin/edit/trivia">Trivia</a>
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
