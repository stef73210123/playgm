/**
 * nicknameSanitizer.ts
 * Validates local-device nicknames per GDD §2:
 *   - No @ or . characters
 *   - No phone-number patterns
 *   - Max 20 characters
 *
 * Shared helper — this file is intentionally framework-agnostic so the Expo
 * client can import it directly (or a copy of it) without pulling in server deps.
 */

const PHONE_PATTERN = /\d{3,}[-.\s]?\d{3,}/;

export function isSafeNickname(str: string): boolean {
  if (!str || str.length > 20) return false;
  if (str.includes('@') || str.includes('.')) return false;
  if (PHONE_PATTERN.test(str)) return false;
  return true;
}
