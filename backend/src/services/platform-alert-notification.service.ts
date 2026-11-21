import crypto from 'node:crypto';
import { env } from '../config/env';
import { many, one, pool } from '../config/db';
import type { PlatformOperationsSnapshot } from './platform-operations.service';

export type PlatformAlertNotificationSettings = {
  enabled: boolean;
  warning: boolean;
  critical: boolean;
  email: boolean;
  webhook: boolean;
};

export const DEFAULT_PLATFORM_ALERT_NOTIFICATION_SETTINGS: PlatformAlertNotificationSettings = {
  enabled: true, warning: false, critical: true, email: false, webhook: false,
};

export type PlatformAlertNotification = {
  id: string;
  alertEventId: string;
  severity: 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  channel: 'IN_APP' | 'EMAIL' | 'WEBHOOK';
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'RETRY' | 'FAILED' | 'SKIPPED';
  attemptCount: number;
  deliveredAt: string | null;
  lastError: string | null;
};

export async function getPlatformAlertNotificationSettings(): Promise<PlatformAlertNotificationSettings> {
  const row = await one<{ value: Partial<PlatformAlertNotificationSettings> }>(
    "SELECT value FROM system_config WHERE key = 'platform.operations.notifications'",
  ).catch(() => null);
  return { ...DEFAULT_PLATFORM_ALERT_NOTIFICATION_SETTINGS, ...(row?.value ?? {}) };
}

export async function updatePlatformAlertNotificationSettings(
  adminId: string, settings: PlatformAlertNotificationSettings,
): Promise<PlatformAlertNotificationSettings> {
  await pool.query(
    `INSERT INTO system_config (key, value, updated_by)
     VALUES ('platform.operations.notifications', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(settings), adminId],
  );
  return settings;
}

export async function getAdminAlertEmail(adminId: string): Promise<string | null> {
  const row = await one<{ email: string | null }>('SELECT email FROM admins WHERE id = $1', [adminId]);
  return row?.email ?? null;
}

export async function updateAdminAlertEmail(adminId: string, email: string | null): Promise<string | null> {
  const row = await one<{ email: string | null }>(
    'UPDATE admins SET email = $2 WHERE id = $1 RETURNING email', [adminId, email],
  );
  return row?.email ?? null;
}

/** Idempotent fan-out: one row per alert event, active operator and enabled channel. */
export async function enqueuePlatformAlertNotifications(
  alerts: PlatformOperationsSnapshot['alerts'],
): Promise<void> {
  const settings = await getPlatformAlertNotificationSettings();
  if (!settings.enabled) return;
  for (const alert of alerts) {
    if (alert.severity === 'CRITICAL' ? !settings.critical : !settings.warning) continue;
    const title = `Platform ${alert.severity.toLowerCase()} alert: ${alert.service}`;
    const channels: Array<'IN_APP' | 'EMAIL' | 'WEBHOOK'> = ['IN_APP'];
    if (settings.email && env.alertDelivery.resendApiKey && env.alertDelivery.emailFrom) channels.push('EMAIL');
    if (settings.webhook && env.alertDelivery.webhookUrl && env.alertDelivery.webhookSecret) channels.push('WEBHOOK');
    for (const channel of channels) {
      await pool.query(
        `INSERT INTO platform_alert_notifications
           (alert_event_id, admin_id, channel, severity, title, message, delivery_status)
         SELECT event.id, admins.id, $2, $3, $4, $5, CASE WHEN $2 = 'IN_APP' THEN 'DELIVERED' ELSE 'PENDING' END
           FROM platform_alert_events event
           CROSS JOIN admins
          WHERE event.fingerprint = $1 AND event.status = 'ACTIVE' AND admins.is_active = true
            AND ($2 <> 'EMAIL' OR (admins.email IS NOT NULL AND admins.email <> ''))
         ON CONFLICT (alert_event_id, admin_id, channel) DO NOTHING`,
        [alert.id, channel, alert.severity, title, alert.message],
      );
    }
  }
}

export async function listPlatformAlertNotifications(
  adminId: string, limit = 50,
): Promise<{ notifications: PlatformAlertNotification[]; unreadCount: number }> {
  const [notifications, count] = await Promise.all([
    many<PlatformAlertNotification>(
      `SELECT id, alert_event_id AS "alertEventId", severity, title, message,
              created_at AS "createdAt", read_at AS "readAt", channel,
              delivery_status AS "deliveryStatus", attempt_count AS "attemptCount",
              delivered_at AS "deliveredAt", last_error AS "lastError"
         FROM platform_alert_notifications WHERE admin_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [adminId, Math.max(1, Math.min(100, Math.floor(limit)))],
    ),
    one<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM platform_alert_notifications WHERE admin_id = $1 AND channel = \'IN_APP\' AND read_at IS NULL',
      [adminId],
    ),
  ]);
  return { notifications, unreadCount: Number(count?.count ?? 0) };
}

export async function markPlatformAlertNotificationRead(adminId: string, notificationId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE platform_alert_notifications SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND admin_id = $2 AND channel = 'IN_APP'`, [notificationId, adminId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markAllPlatformAlertNotificationsRead(adminId: string): Promise<number> {
  const result = await pool.query(
    "UPDATE platform_alert_notifications SET read_at = now() WHERE admin_id = $1 AND channel = 'IN_APP' AND read_at IS NULL",
    [adminId],
  );
  return result.rowCount ?? 0;
}

type DeliveryRow = { id: string; channel: 'EMAIL' | 'WEBHOOK'; email: string | null; severity: string; title: string; message: string; attemptCount: number };

async function deliverEmail(row: DeliveryRow): Promise<void> {
  if (!row.email || !env.alertDelivery.resendApiKey || !env.alertDelivery.emailFrom) throw new Error('Email delivery is not configured or admin email is missing');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.alertDelivery.resendApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.alertDelivery.emailFrom, to: [row.email],
      subject: row.title,
      text: `${row.severity} platform alert\n\n${row.message}\n\nOpen the Voiza Admin Panel → Platform Operations for details.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
}

async function deliverWebhook(row: DeliveryRow): Promise<void> {
  const url = env.alertDelivery.webhookUrl;
  const secret = env.alertDelivery.webhookSecret;
  if (!url || !secret) throw new Error('Signed alert webhook is not configured');
  const body = JSON.stringify({ id: row.id, severity: row.severity, title: row.title, message: row.message, createdAt: new Date().toISOString() });
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-voiza-signature': `sha256=${signature}`, 'x-voiza-event': 'platform.alert', 'x-voiza-notification-id': row.id },
    body, signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
}

/** Bounded background worker. Claims rows transactionally and retries with capped exponential backoff. */
export async function deliverPendingPlatformAlertNotifications(batchSize = 10): Promise<number> {
  let delivered = 0;
  for (let index = 0; index < Math.max(1, Math.min(25, batchSize)); index += 1) {
    const client = await pool.connect();
    let row: DeliveryRow | null = null;
    try {
      await client.query('BEGIN');
      const claimed = await client.query<DeliveryRow>(
        `SELECT n.id, n.channel, a.email, n.severity, n.title, n.message, n.attempt_count AS "attemptCount"
           FROM platform_alert_notifications n
           JOIN admins a ON a.id = n.admin_id
          WHERE n.channel <> 'IN_APP'
            AND (n.delivery_status IN ('PENDING','RETRY') OR (n.delivery_status = 'SENDING' AND n.claimed_at < now() - interval '2 minutes'))
            AND n.next_attempt_at <= now()
          ORDER BY n.created_at
          LIMIT 1 FOR UPDATE OF n SKIP LOCKED`,
      );
      row = claimed.rows[0] ?? null;
      if (!row) { await client.query('COMMIT'); break; }
      await client.query("UPDATE platform_alert_notifications SET attempt_count = attempt_count + 1, delivery_status = 'SENDING', claimed_at = now() WHERE id = $1", [row.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }

    try {
      if (row.channel === 'EMAIL') await deliverEmail(row);
      else await deliverWebhook(row);
      await pool.query(
        "UPDATE platform_alert_notifications SET delivery_status = 'DELIVERED', delivered_at = now(), claimed_at = NULL, last_error = NULL WHERE id = $1",
        [row.id],
      );
      delivered += 1;
    } catch (error) {
      const attempt = row.attemptCount + 1;
      const terminal = attempt >= 8;
      const delaySeconds = Math.min(3600, 15 * (2 ** Math.min(attempt - 1, 8)));
      await pool.query(
        `UPDATE platform_alert_notifications
            SET delivery_status = $2, claimed_at = NULL, next_attempt_at = now() + ($3::text || ' seconds')::interval,
                last_error = $4
          WHERE id = $1`,
        [row.id, terminal ? 'FAILED' : 'RETRY', delaySeconds, (error as Error).message.slice(0, 1000)],
      );
    }
  }
  return delivered;
}
