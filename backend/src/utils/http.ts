import { NextFunction, Request, RequestHandler, Response } from 'express';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'error',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, code = 'bad_request', details?: unknown) {
    return new ApiError(400, message, code, details);
  }
  static unauthorized(message = 'Authentication required', code = 'unauthorized') {
    return new ApiError(401, message, code);
  }
  static forbidden(message = 'Not allowed', code = 'forbidden', details?: unknown) {
    return new ApiError(403, message, code, details);
  }
  static notFound(message = 'Not found', code = 'not_found') {
    return new ApiError(404, message, code);
  }
  static conflict(message: string, code = 'conflict') {
    return new ApiError(409, message, code);
  }
  static tooManyRequests(message = 'Slow down', code = 'rate_limited') {
    return new ApiError(429, message, code);
  }
  static paymentInsufficient(message: string, details?: unknown) {
    return new ApiError(402, message, 'insufficient_balance', details);
  }
  /** A third-party (SMS gateway, PSP) failed or answered oddly. */
  static badGateway(message: string, code = 'upstream_unavailable', details?: unknown) {
    return new ApiError(502, message, code, details);
  }
}

/** Keeps controllers free of try/catch noise. */
export function asyncHandler<T extends RequestHandler>(fn: T): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function requireString(value: unknown, field: string, opts?: { max?: number; min?: number }): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  const min = opts?.min ?? 1;
  const max = opts?.max ?? 500;
  if (trimmed.length < min) throw ApiError.badRequest(`${field} must be at least ${min} characters`);
  if (trimmed.length > max) throw ApiError.badRequest(`${field} must be at most ${max} characters`);
  return trimmed;
}

export function optionalString(value: unknown, field: string, max = 500): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, { max });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids that land in a `uuid` column. A malformed value is refused by Postgres with 22P02, which
 * the error handler reports as an opaque conflict; checking the shape here names the field
 * instead, so an operator who pastes the wrong thing learns which box was wrong.
 */
export function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field, { min: 36, max: 36 });
  if (!UUID_RE.test(text)) throw ApiError.badRequest(`${field} must be a UUID`, 'invalid_uuid');
  return text;
}

export function optionalUuid(value: unknown, field: string): string | undefined {
  const text = optionalString(value, field, 36);
  if (text !== undefined && !UUID_RE.test(text)) {
    throw ApiError.badRequest(`${field} must be a UUID`, 'invalid_uuid');
  }
  return text;
}

export function requireInt(value: unknown, field: string, opts: { min?: number; max?: number }): number {
  const parsed = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw ApiError.badRequest(`${field} must be an integer`);
  }
  if (opts.min !== undefined && parsed < opts.min) {
    throw ApiError.badRequest(`${field} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw ApiError.badRequest(`${field} must be <= ${opts.max}`);
  }
  return parsed;
}

export function optionalInt(value: unknown, field: string, opts: { min?: number; max?: number }): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireInt(value, field, opts);
}

export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw ApiError.badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** The same question as `requireEnum`, asked of a filter that may be left blank. */
export function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireEnum(value, field, allowed);
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw ApiError.badRequest(`${field} must be a boolean`);
}

const E164 = /^\+?[1-9]\d{5,14}$/;

export function normalizePhone(value: unknown, field = 'phone'): string {
  const raw = requireString(value, field, { min: 6, max: 20 });
  const digits = raw.startsWith('+') ? `+${raw.slice(1).replace(/\D/g, '')}` : raw.replace(/\D/g, '');
  if (!E164.test(digits)) throw ApiError.badRequest(`${field} must be a valid E.164 phone number`);
  return digits;
}
