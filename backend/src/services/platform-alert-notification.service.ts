import { many, one, pool } from '../config/db';
import type { PlatformOperationsSnapshot } from './platform-operations.service';

export type PlatformAlertNotificationSettings = {
  enabled: boolean;
  warning: boolean;
  critical: boolean;
  notifyOnResolved: boolean;
};

export const DEFAULT_PLATFORM_ALERT_NOTIFICATION_SETTINGS: PlatformAlertNotificationSettings = {
  enabled: true,
  warning: false,
  critical: true,
  notifyOnResolved: false,
};

export type PlatformAlertNotification = {
  id: string;
  alertEventId: string;
  severity: 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
};

export async function getPlatformAlertNotificationSettings(): Promise<PlatformAlertNotificationSettings> {
  const row = await one<{ value: Partial<PlatformAlertNotificationSettings> }>(
    "SELECT value FROM system_config WHERE key = 'platform.operations.notifications'",
  ).catch(() => null);
  return { ...DEFAULT_PLATFORM_ALERT_NOTIFICATION_SETTINGS, ...(row?.value ?? {}) };
}

export async function updatePlatformAlertNotificationSettings(
  adminId: string,
  settings: PlatformAlertNotificationSettings,
): Promise<PlatformAlertNotificationSettings> {
  await pool.query(
    `INSERT INTO system_config (key, value, updated_by)
     VALUES ('platform.operations.notifications', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(settings), adminId],
  );
  return settings;
}

/** Idempotent fan-out: one inbox row per active operator, alert event and channel. */
export async function enqueuePlatformAlertNotifications(
  alerts: PlatformOperationsSnapshot['alerts'],
): Promise<void> {
  const settings = await getPlatformAlertNotificationSettings();
  if (!settings.enabled) return;
  for (const alert of alerts) {
    if (alert.severity === 'CRITICAL' ? !settings.critical : !settings.warning) continue;
    await pool.query(
      `INSERT INTO platform_alert_notifications
         (alert_event_id, admin_id, channel, severity, title, message)
       SELECT event.id, admins.id, 'IN_APP', $2, $3, $4
         FROM platform_alert_events event
         CROSS JOIN admins
        WHERE event.fingerprint = $1
          AND event.status = 'ACTIVE'
          AND admins.is_active = true
       ON CONFLICT (alert_event_id, admin_id, channel) DO NOTHING`,
      [alert.id, alert.severity, `Platform ${alert.severity.toLowerCase()} alert: ${alert.service}`, alert.message],
    );
  }
}

export async function listPlatformAlertNotifications(
  adminId: string,
  limit = 50,
): Promise<{ notifications: PlatformAlertNotification[]; unreadCount: number }> {
  const [notifications, count] = await Promise.all([
    many<PlatformAlertNotification>(
      `SELECT id, alert_event_id AS "alertEventId", severity, title, message,
              created_at AS "createdAt", read_at AS "readAt"
         FROM platform_alert_notifications
        WHERE admin_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [adminId, Math.max(1, Math.min(100, Math.floor(limit)))],
    ),
    one<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM platform_alert_notifications WHERE admin_id = $1 AND read_at IS NULL',
      [adminId],
    ),
  ]);
  return { notifications, unreadCount: Number(count?.count ?? 0) };
}

export async function markPlatformAlertNotificationRead(adminId: string, notificationId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE platform_alert_notifications
        SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND admin_id = $2`,
    [notificationId, adminId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markAllPlatformAlertNotificationsRead(adminId: string): Promise<number> {
  const result = await pool.query(
    'UPDATE platform_alert_notifications SET read_at = now() WHERE admin_id = $1 AND read_at IS NULL',
    [adminId],
  );
  return result.rowCount ?? 0;
}
