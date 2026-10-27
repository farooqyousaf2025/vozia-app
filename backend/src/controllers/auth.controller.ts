import { Request, Response } from 'express';
import { env } from '../config/env';
import { one, query } from '../config/db';
import { AdminRow, UserRow } from '../types/db';
import { hashSecret, verifySecret } from '../utils/crypto';
import { asyncHandler, normalizePhone, optionalString, requireString, ApiError } from '../utils/http';
import { toAdmin, toUser } from '../utils/serialize';
import { issueOtp, verifyOtpAndResolve } from '../services/otp.service';
import { signAdminToken, signUserToken } from '../services/token.service';
import { adminPermissions } from '../services/rbac.service';
import { registerDeviceToken } from '../services/push.service';
import { findAdminByUsername } from '../services/admin.service';

export const requestOtp = asyncHandler(async (req: Request, res: Response) => {
  const phone = normalizePhone(req.body?.phone);
  const result = await issueOtp(phone);
  res.json(result);
});

/**
 * Verifies an OTP. If the phone is the configured admin bootstrap number and the
 * code matches ADMIN_BOOTSTRAP_OTP, an admin-scoped token is returned too, which
 * is how an operator gets into the panel on a brand-new VPS.
 */
export const verifyOtp = asyncHandler(async (req: Request, res: Response) => {
  const phone = normalizePhone(req.body?.phone);
  const code = requireString(req.body?.code, 'code', { min: 4, max: 8 });
  const username = optionalString(req.body?.username, 'username', 40);

  const isAdminBootstrap = phone === env.admin.bootstrapPhone && code === env.admin.bootstrapOtp;
  if (isAdminBootstrap) {
    const admin = await ensureBootstrapAdmin();
    return res.json({
      token: signAdminToken({ sub: admin.id, username: admin.username, role: admin.role }),
      admin: toAdmin(admin),
      user: null,
    });
  }

  const { user, created } = await verifyOtpAndResolve(phone, code, { username });
  if (user.status === 'BANNED') throw ApiError.forbidden('This account has been banned', 'account_banned');

  res.json({
    token: signUserToken({
      sub: user.id,
      phone: user.phone,
      username: user.username,
      userType: user.user_type,
    }),
    user: toUser(user),
    created,
  });
});

async function ensureBootstrapAdmin(): Promise<AdminRow> {
  const existing = await findAdminByUsername(env.admin.username);
  if (existing) return existing;
  const created = await one<AdminRow>(
    `INSERT INTO admins (username, password_hash, display_name, role)
     VALUES ($1,$2,$3,'SUPER_ADMIN') ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
     RETURNING *`,
    [env.admin.username, hashSecret(env.admin.password), 'Platform administrator'],
  );
  if (!created) throw new Error('Could not bootstrap the admin account');
  return created;
}

export const login = asyncHandler(async (req: Request, res: Response) => {
  const username = requireString(req.body?.username, 'username', { max: 40 });
  const password = requireString(req.body?.password, 'password', { max: 200 });

  const admin = await findAdminByUsername(username);
  if (!admin || !verifySecret(password, admin.password_hash)) {
    throw ApiError.unauthorized('Wrong username or password', 'invalid_credentials');
  }
  res.json({
    token: signAdminToken({ sub: admin.id, username: admin.username, role: admin.role }),
    admin: toAdmin(admin),
    permissions: adminPermissions(admin.role),
  });
});

/** First run: create the operator from ADMIN_USERNAME / ADMIN_PASSWORD. */
export async function bootstrapAdmin(): Promise<void> {
  const count = await one<{ n: string }>('SELECT COUNT(*) AS n FROM admins');
  if (Number(count?.n ?? 0) > 0) return;
  await query(
    'INSERT INTO admins (username, password_hash, display_name, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [env.admin.username, hashSecret(env.admin.password), 'Platform administrator', 'SUPER_ADMIN'],
  );
  console.info(`[admin] bootstrapped operator "${env.admin.username}"`);
}

export const me = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const row = await one<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!row) throw ApiError.notFound('Account not found');
  res.json({ user: toUser(row) });
});

/**
 * Registers the FCM registration token for push. The app calls this on every
 * start (and whenever Firebase rotates the token), so a reinstall or a new phone
 * picks up the current target instead of pushing into a dead token.
 */
export const setDeviceToken = asyncHandler(async (req: Request, res: Response) => {
  const token = requireString(req.body?.deviceToken, 'deviceToken', { min: 20, max: 600 });
  await registerDeviceToken(req.user!.sub, token);
  res.json({ ok: true });
});

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const validated: Record<string, string | undefined> = {
    username: optionalString(req.body?.username, 'username', 40),
    avatarUrl: optionalString(req.body?.avatarUrl, 'avatarUrl', 500),
    bio: optionalString(req.body?.bio, 'bio', 200),
    gender: optionalString(req.body?.gender, 'gender', 10),
    countryCode: optionalString(req.body?.countryCode, 'countryCode', 2),
  };
  const columns: Record<string, string> = {
    username: 'username',
    avatarUrl: 'avatar_url',
    bio: 'bio',
    gender: 'gender',
    countryCode: 'country_code',
  };

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (validated[key] === undefined) continue;
    params.push(validated[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) throw ApiError.badRequest('Nothing to update');

  params.push(userId);
  let row: UserRow | null;
  try {
    row = await one<UserRow>(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw ApiError.conflict('That username is taken', 'username_taken');
    }
    throw err;
  }
  if (!row) throw ApiError.notFound('Account not found');
  res.json({ user: toUser(row) });
});
