# PlayGM Server

Fastify + TypeScript backend for the PlayGM app. Connects to Supabase Postgres and TheSportsDB.

---

## Prerequisites

- Node.js 20+
- A Supabase project (free tier works)

---

## Setup

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable              | Required | Description                                           |
|-----------------------|----------|-------------------------------------------------------|
| `SUPABASE_URL`        | Yes      | Your Supabase project URL                            |
| `SUPABASE_SERVICE_KEY`| Yes      | Service-role key (from Supabase → Settings → API)    |
| `SUPABASE_ANON_KEY`   | Yes      | Anon key (from Supabase → Settings → API)            |
| `SPORTSDB_V2_KEY`     | No       | Patreon key for V2 — omit to use free V1             |
| `PORT`                | No       | Defaults to `3001`                                   |
| `NODE_ENV`            | No       | `development` or `production`                        |

### 3. Run database migrations

Open **Supabase Dashboard → SQL Editor** and paste the contents of:

```
src/db/schema.sql
```

Then (optionally) paste `src/db/seed.sql` for local test data.

Alternatively with psql:
```bash
psql $SUPABASE_DB_URL -f src/db/schema.sql
psql $SUPABASE_DB_URL -f src/db/seed.sql
```

### 4. Start dev server

```bash
npm run dev
```

Server starts on `http://localhost:3001`. Verify:

```bash
curl http://localhost:3001/health
# → {"ok":true,"version":"2026.1"}
```

---

## Production build

```bash
npm run build
npm start
```

---

## Data sync jobs (cron)

| Job              | Schedule       | Description                                      |
|------------------|----------------|--------------------------------------------------|
| Live score poll  | Every 2 min    | Updates `active_drafts.score` from live API      |
| Full stats sync  | Daily at 3am UTC | Upserts teams + players into `sports_master_data` |
| Morning Reveal   | Daily at 6am UTC | Awards play_points for overnight wins            |

Both jobs also run **once on startup** in `NODE_ENV=development`.

---

## API summary

All routes require `Authorization: Bearer <handle>` header.

| Method | Path                          | Description                    |
|--------|-------------------------------|--------------------------------|
| GET    | /health                       | Health check                   |
| GET    | /profile                      | Current user profile           |
| POST   | /profile/bootstrap            | Create anonymous profile       |
| PATCH  | /profile/initials             | Update 2-char initials         |
| PATCH  | /profile/timezone             | Update IANA timezone           |
| GET    | /cards                        | All cards (with cooldown info) |
| POST   | /cards/open-pack              | Open a play pack               |
| POST   | /draft                        | Create draft pick              |
| GET    | /draft/active                 | Active drafts                  |
| GET    | /draft/history                | Completed drafts               |
| GET    | /scouting-report/:entityId    | Scouting report for entity     |
| GET    | /trivia/next                  | Next trivia question           |
| POST   | /trivia/answer                | Submit trivia answer           |
| POST   | /alliances                    | Create alliance                |
| POST   | /alliances/join               | Join alliance by invite code   |
| GET    | /alliances/current            | Current alliance + members     |
| POST   | /packs/gift                   | Gift a pack to another user    |
