import { randomBytes } from 'crypto';

/**
 * References the programme asks to be unique per transaction (§22 step 3, §25).
 *
 * They are human-transcribable on purpose: a seller reads one out over the phone to support,
 * and a finance operator pastes it into a bank statement. `I L O U` and `-` are left out of
 * the alphabet because they are the characters that get mistyped.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function shortCode(prefix: string, entropyBytes = 6): string {
  const bytes = randomBytes(entropyBytes);
  let tail = '';
  for (const byte of bytes) tail += ALPHABET[byte % ALPHABET.length];
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `${prefix}${stamp}${tail}`;
}
