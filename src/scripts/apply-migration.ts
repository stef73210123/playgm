/**
 * apply-migration.ts — try to apply server/migrations/001_v1_schema.sql via
 * the Supabase REST `rpc('exec_sql', { sql })` function. Falls back to
 * printing instructions if that RPC isn't exposed.
 *
 * Run: npx tsx --import ./src/env-loader.ts src/scripts/apply-migration.ts
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const url = process.env['SUPABASE_URL'];
const key = process.env['SUPABASE_SERVICE_KEY'];
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing');
  process.exit(1);
}

const sqlPath = path.resolve(process.cwd(), '../server/migrations/001_v1_schema.sql');
const altPath = path.resolve(process.cwd(), 'migrations/001_v1_schema.sql');
const finalPath = (() => {
  try { readFileSync(sqlPath, 'utf8'); return sqlPath; } catch { /* */ }
  return altPath;
})();
const sql = readFileSync(finalPath, 'utf8');

const sb = createClient(url, key, { auth: { persistSession: false } });

(async () => {
  // Attempt the standard Supabase exec function name. There's no built-in
  // exec_sql; this only works if a function was created on the project.
  const candidates = ['exec_sql', 'execute_sql', 'run_sql', 'exec'];
  for (const fn of candidates) {
    const { error } = await sb.rpc(fn, { sql });
    if (!error) {
      console.log(`applied via rpc('${fn}')`);
      process.exit(0);
    }
    if (!/Could not find the function|PGRST202|PGRST204/i.test(error.message)) {
      console.error(`rpc('${fn}') errored:`, error.message);
      process.exit(2);
    }
  }
  console.error('No exec-SQL RPC available on this Supabase project.');
  console.error('Manual path: paste server/migrations/001_v1_schema.sql into the Supabase SQL Editor.');
  process.exit(3);
})();
