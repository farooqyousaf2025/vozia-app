import crypto from 'crypto';

const SCRYPT_PREFIX = 'scrypt';
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** Password/OTP hashing without pulling in bcrypt: node's scrypt is fine here. */
export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = crypto.scryptSync(secret, salt, KEY_LENGTH);
  return `${SCRYPT_PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== SCRYPT_PREFIX || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(secret, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function randomNumericCode(length = 6): string {
  let out = '';
  while (out.length < length) out += crypto.randomInt(0, 10).toString();
  return out;
}

/** Six-digit, collision-checked by the caller's INSERT retry loop. */
export function randomRoomNumber(): number {
  return 100_000 + crypto.randomInt(0, 900_000);
}
