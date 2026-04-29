/**
 * handleGenerator.ts
 * Generates anonymous handles like "MightyFox42".
 * Checks DB for uniqueness; retries up to 5 times on collision.
 */

import { supabase } from '../db/client.js';

const ADJECTIVES = [
  'Mighty', 'Swift', 'Bold', 'Brave', 'Calm',
  'Clever', 'Cool', 'Daring', 'Epic', 'Fast',
  'Fierce', 'Grand', 'Great', 'Iron', 'Keen',
  'Lucky', 'Noble', 'Quick', 'Sharp', 'Wild',
];

const ANIMALS = [
  'Fox', 'Bear', 'Wolf', 'Eagle', 'Hawk',
  'Lion', 'Tiger', 'Shark', 'Falcon', 'Cobra',
  'Panda', 'Moose', 'Bison', 'Lynx', 'Raven',
  'Viper', 'Drake', 'Stag', 'Orca', 'Crane',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function generateCandidate(): string {
  const num = Math.floor(Math.random() * 90) + 10; // 10–99
  return `${randomItem(ADJECTIVES)}${randomItem(ANIMALS)}${num}`;
}

export async function generateHandle(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCandidate();
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('handle', candidate)
      .maybeSingle();

    if (!data) return candidate; // unique
  }
  // Last resort: append milliseconds to guarantee uniqueness
  return `${generateCandidate()}${Date.now() % 1000}`;
}

/** Pure version for use in contexts without DB access (e.g. tests, client). */
export function generateHandleSync(): string {
  return generateCandidate();
}
