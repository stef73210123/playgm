/**
 * branding.ts
 * Replace league acronyms with plain sport names.
 * Team/player names (Lakers, Chiefs, Yankees) are never touched.
 *
 * Single source of truth for display names:
 *   NBA → Basketball | NFL → Football | MLB → Baseball | NHL → Hockey | MLS → Soccer
 */

const REPLACEMENTS: [RegExp, string][] = [
  [/\bNBA\b/g,  'Basketball'],
  [/\bNFL\b/g,  'Football'],
  [/\bMLB\b/g,  'Baseball'],
  [/\bNHL\b/g,  'Hockey'],
  [/\bMLS\b/g,  'Soccer'],
];

export function stripLeagueAcronyms(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function brandingFilter<T>(obj: T): T {
  if (typeof obj === 'string') {
    return stripLeagueAcronyms(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => brandingFilter(item)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = brandingFilter(value);
    }
    return result as T;
  }
  return obj;
}
