import { createClient } from '@supabase/supabase-js';

const url = process.env['SUPABASE_URL'];
// Service-role key bypasses RLS — preferred for server-side operations.
// Falls back to anon key for local dev when only the publishable key is available.
const key = process.env['SUPABASE_SERVICE_KEY'] ?? process.env['SUPABASE_ANON_KEY'];

if (!url || !key) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY. Copy server/.env.example → server/.env and fill in your credentials.'
  );
}

// Masked key for safe boot logging (first 10 + last 4 chars)
const maskedKey = key.length > 14 ? `${key.slice(0, 10)}…${key.slice(-4)}` : '***';
const keyType = process.env['SUPABASE_SERVICE_KEY'] ? 'service_role' : 'anon';
console.log(`[supabase] Connecting to ${url} using ${keyType} key: ${maskedKey}`);

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});
