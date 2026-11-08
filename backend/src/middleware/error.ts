import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { ApiError } from '../utils/http';

export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`No route for ${req.method} ${req.originalUrl}`));
}

/** Postgres error codes worth surfacing as client errors instead of 500s. */
const PG_CODES: Record<string, { status: number; code: string; message?: string }> = {
  '22P02': { status: 400, code: 'invalid_identifier' }, // invalid text representation (bad UUID)
  '23505': { status: 409, code: 'conflict' }, // unique violation
  '23503': { status: 409, code: 'referenced_row_missing' }, // foreign key
  '23514': { status: 400, code: 'constraint_violated' }, // check constraint
  // A deadlock is always the loser's fault and always safe to replay: PostgreSQL rolled that one
  // transaction back and committed the other, so nothing was half-spent. Saying 500 here tells a
  // caller their money move failed when the honest answer is "you do not know yet, ask again".
  '40P01': { status: 409, code: 'retry', message: 'The request collided with another change; retry it' },
};

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;

  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  const pgCode = (err as { code?: string })?.code;
  if (pgCode && PG_CODES[pgCode]) {
    const mapped = PG_CODES[pgCode];
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message ?? 'The request conflicts with current data' } });
    return;
  }

  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    return;
  }

  // body-parser raises this once a request passes the 64kb cap; without a branch
  // it would surface as an opaque 500.
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is larger than 64kb' } });
    return;
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      // never leak internals on a public VPS, but make local debugging readable
      message: env.isProduction ? 'Something went wrong on our side' : (err as Error)?.message ?? 'Unknown error',
    },
  });
}
