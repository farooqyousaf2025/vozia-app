import { env } from '../config/env';
import { many, one, query, withTransaction } from '../config/db';
import { rateLimit } from '../config/redis';
import { sendSms, smsIsConfigured } from './sms.service';
import { hashSecret, randomNumericCode, verifySecret } from '../utils/crypto';
import { ApiError } from '../utils/http';
import { UserRow } from '../types/db';

type OtpRecord = {
  id: string;
  code_hash: string;
  attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
};

/**
 * OTP delivery. With SMS_PROVIDER=mock (the development default) the code is
 * logged instead of sent; production boots refuse to start in that mode, so the
 * log line can never leak a live code on a VPS. With twilio/vonage configured,
 * a gateway failure throws — issueOtp must not answer `sent: true` for a text
 * that never left.
 */
async function deliver(phone: string, code: string): Promise<void> {
  if (!smsIsConfigured()) {
    console.info(`[otp] ${phone} -> ${code}`);
    return;
  }
  const minutes = Math.max(1, Math.round(env.auth.otpTtlSeconds / 60));
  await sendSms(phone, `Your Voiza code is ${code}. It expires in ${minutes} minute${minutes > 1 ? 's' : ''}.`);
}

export async function issueOtp(phone: string, purpose = 'LOGIN'): Promise<{ sent: true; devCode?: string }> {
  const remaining = await rateLimit(`otp:${phone}`, env.auth.otpRequestPerMinute, 60);
  if (remaining === -1) {
    throw ApiError.tooManyRequests('Too many code requests for this number. Try again in a minute.');
  }

  const code = env.auth.otpMockCode || randomNumericCode(6);
  await one(
    `INSERT INTO otp_codes (phone, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    [phone, hashSecret(code), purpose, env.auth.otpTtlSeconds],
  );
  await query('DELETE FROM otp_codes WHERE phone = $1 AND expires_at < now() - interval \'10 minutes\'', [phone]);

  await deliver(phone, code);
  // The echo is the substitute for a gateway, not a convenience: once a real
  // provider is configured the text is the only honest way to receive a code,
  // so /request-otp stops returning it.
  return env.isProduction || smsIsConfigured() ? { sent: true } : { sent: true, devCode: code };
}

/** Marks the code consumed and returns nothing; throws on any failure mode. */
async function consumeOtp(phone: string, code: string, purpose: string): Promise<void> {
  const record = await one<OtpRecord>(
    `SELECT id, code_hash, attempts, expires_at, consumed_at
       FROM otp_codes
      WHERE phone = $1 AND purpose = $2
      ORDER BY created_at DESC LIMIT 1`,
    [phone, purpose],
  );
  if (!record) throw ApiError.badRequest('Request a code first', 'otp_missing');
  if (record.consumed_at) throw ApiError.badRequest('This code was already used', 'otp_consumed');
  if (record.expires_at.getTime() < Date.now()) throw ApiError.badRequest('This code has expired', 'otp_expired');
  if (record.attempts >= env.auth.otpMaxAttempts) throw ApiError.tooManyRequests('Too many wrong attempts; request a new code');

  if (!verifySecret(code, record.code_hash)) {
    await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [record.id]);
    throw ApiError.badRequest('Wrong code', 'otp_invalid');
  }

  // Lock the row so two concurrent verifies cannot both consume one code.
  await withTransaction(async (client) => {
    const locked = await client.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM otp_codes WHERE id = $1 FOR UPDATE',
      [record.id],
    );
    if (locked.rows[0]?.consumed_at) throw ApiError.badRequest('This code was already used', 'otp_consumed');
    await client.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [record.id]);
  });
}

export type ProvisionedUser = { user: UserRow; created: boolean };

/**
 * Verify a code and return (creating on first login) the account.
 * A banned account can authenticate for reads but every mutating path re-checks
 * status, so a ban is enforced at the socket/room/gift layer rather than here.
 */
export async function verifyOtpAndResolve(
  phone: string,
  code: string,
  opts: { username?: string; avatarUrl?: string | null; purpose?: string } = {},
): Promise<ProvisionedUser> {
  await consumeOtp(phone, code, opts.purpose ?? 'LOGIN');
  return resolveUserByPhone(phone, opts);
}

export async function resolveUserByPhone(
  phone: string,
  opts: { username?: string; avatarUrl?: string | null } = {},
): Promise<ProvisionedUser> {
  const existing = await one<UserRow>('SELECT * FROM users WHERE phone = $1', [phone]);
  if (existing) return { user: existing, created: false };

  const username = opts.username ?? deriveUsername(phone);
  const collision = await one<{ n: string }>('SELECT 1 AS n FROM users WHERE username = $1', [username]);
  const finalName = collision ? `${username}_${randomNumericCode(4)}` : username;

  const inserted = await one<UserRow>(
    `INSERT INTO users (phone, username, avatar_url, user_type)
     VALUES ($1, $2, $3, 'USER')
     RETURNING *`,
    [phone, finalName, opts.avatarUrl ?? null],
  );
  if (!inserted) throw new Error('Failed to provision user');
  return { user: inserted, created: true };
}

function deriveUsername(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `voiza_${digits.slice(-6)}`;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const rows = await many<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}
