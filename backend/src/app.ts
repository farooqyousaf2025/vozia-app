import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { env } from './config/env';
import { ping } from './config/db';
import { redis } from './config/redis';
import routes from './routes';
import { errorHandler, notFound } from './middleware/error';

// Augmenting IncomingMessage (what body-parser's `verify` receives, and what
// Express Request extends) keeps the raw bytes visible on both sides.
declare module 'http' {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind nginx / a VPS reverse proxy
  app.use(helmet({ crossOriginResourcePolicy: false }));

  const origins = env.corsOrigin === '*' ? true : env.corsOrigin.split(',').map((s) => s.trim());
  app.use(
    cors({
      origin: origins,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  // LiveKit delivers webhooks as `application/webhook+json`, a type express.json
  // ignores, so its `verify` hook never runs and the signature could not be checked
  // against the real bytes. Buffer them for that one route instead.
  app.use('/api/livekit/webhook', express.raw({ type: () => true, limit: '64kb' }));

  // Stripe signs the exact bytes it posts, so the webhook needs them unparsed
  // too. Same reasoning as the LiveKit route above.
  app.use('/api/payments/stripe/webhook', express.raw({ type: () => true, limit: '64kb' }));

  // Party payloads are tiny. `verify` also keeps the untouched bytes around, which
  // the LiveKit webhook signature check needs (re-serialised JSON would not match).
  app.use(
    express.json({
      limit: '64kb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.get('/health', async (_req, res) => {
    const [db, redisUp] = await Promise.all([ping(), redis.ping().then(() => true).catch(() => false)]);
    res.status(db ? 200 : 503).json({
      ok: db,
      service: 'voiza-backend',
      version: '1.0.0',
      dependencies: { postgres: db, redis: redisUp, livekitUrl: env.livekit.publicUrl },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Gift icons/animations and demo avatars are stored in the database as
  // root-relative paths (`/gifts/rose.png`), so the API origin has to serve them.
  // backend/public holds generated placeholders; replacing that directory with
  // real art (or a CDN mirror) needs no change on either client.
  app.use(
    express.static(path.resolve(__dirname, '..', 'public'), {
      index: false,
      maxAge: '1h',
    }),
  );

  app.use('/api', routes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
