import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from '../utils/http';

export type AuthScope = 'user' | 'admin' | 'business';

export type AccessTokenPayload = {
  sub: string;
  scope: 'user';
  phone: string;
  username: string;
  userType: string;
};

export type AdminTokenPayload = {
  sub: string;
  scope: 'admin';
  username: string;
  role: string;
};

/**
 * A BD representative or coin seller. `kind` is only a hint for the UI — the middleware
 * re-reads the account row, so a suspended partner is locked out on the next request
 * rather than when this token happens to expire.
 */
export type BusinessTokenPayload = {
  sub: string;
  scope: 'business';
  code: string;
  kind: string;
};

export type TokenPayload = AccessTokenPayload | AdminTokenPayload | BusinessTokenPayload;

export function signUserToken(input: Omit<AccessTokenPayload, 'scope'>): string {
  return jwt.sign({ ...input, scope: 'user' }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function signAdminToken(input: Omit<AdminTokenPayload, 'scope'>): string {
  return jwt.sign({ ...input, scope: 'admin' }, env.jwtSecret, {
    expiresIn: '12h',
  });
}

export function signBusinessToken(input: Omit<BusinessTokenPayload, 'scope'>): string {
  return jwt.sign({ ...input, scope: 'business' }, env.jwtSecret, { expiresIn: '12h' });
}

export function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, env.jwtSecret) as TokenPayload;
  } catch (err) {
    const expired = err instanceof Error && err.name === 'TokenExpiredError';
    throw ApiError.unauthorized(expired ? 'Session expired' : 'Invalid token', expired ? 'token_expired' : 'invalid_token');
  }
}
