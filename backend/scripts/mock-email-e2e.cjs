#!/usr/bin/env node
/** Prove mock email delivery records an outbox success without SMTP or Resend credentials. */
const path = require('node:path');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'development';
process.env.NOTIFICATION_DELIVERY_MODE = 'mock';

// A local/demo installation must not need Gmail, SMTP or Resend credentials.
for (const key of [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS',
  'SMTP_OAUTH_CLIENT_ID', 'SMTP_OAUTH_CLIENT_SECRET', 'SMTP_OAUTH_REFRESH_TOKEN',
  'ALERT_EMAIL_FROM', 'RESEND_API_KEY',
]) delete process.env[key];

const output = [];
let failures = 0;
let adminId = null;
let alertEventId = null;
let notificationId = null;
let fetchCalls = 0;
let smtpTransportCalls = 0;

function check(name, pass, detail) {
  output.push((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : ' :: ' + JSON.stringify(detail)));
  if (!pass) failures += 1;
}

const originalFetch = global.fetch;
global.fetch = (...args) => {
  fetchCalls += 1;
  throw new Error('Unexpected network request in mock email mode: ' + String(args[0]));
};

const nodemailer = require('nodemailer');
const originalCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = (...args) => {
  smtpTransportCalls += 1;
  throw new Error('Unexpected SMTP transport creation in mock email mode');
};

const BE_ROOT = path.resolve(__dirname, '..');
const { pool, closePool } = require(path.join(BE_ROOT, 'dist/config/db.js'));
const {
  deliverPendingPlatformAlertNotifications,
  emailDeliveryIsConfigured,
} = require(path.join(BE_ROOT, 'dist/services/platform-alert-notification.service.js'));

(async () => {
  check('mock mode considers email delivery configured without provider credentials',
    emailDeliveryIsConfigured() === true,
    { mode: process.env.NOTIFICATION_DELIVERY_MODE });

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const email = 'mock-email-' + suffix + '@example.invalid';

  const admin = await pool.query(
    `INSERT INTO admins (username, password_hash, role, email)
     VALUES ($1, $2, 'MODERATOR', $3) RETURNING id`,
    ['mockmail_' + suffix, 'not-a-real-password-hash', email],
  );
  adminId = admin.rows[0].id;

  const event = await pool.query(
    `INSERT INTO platform_alert_events
       (fingerprint, severity, service, metric, message, source)
     VALUES ($1, 'CRITICAL', 'backend-api', 'mock-email-test', $2, 'mock-email-e2e')
     RETURNING id`,
    ['mock-email-e2e:' + suffix, 'Mock email delivery isolation test'],
  );
  alertEventId = event.rows[0].id;

  const notification = await pool.query(
    `INSERT INTO platform_alert_notifications
       (alert_event_id, admin_id, channel, severity, title, message, delivery_status, created_at)
     VALUES ($1, $2, 'EMAIL', 'CRITICAL', $3, $4, 'PENDING', to_timestamp(1))
     RETURNING id`,
    [alertEventId, adminId, 'Mock email isolation ' + suffix, 'This message must remain local.'],
  );
  notificationId = notification.rows[0].id;

  const delivered = await deliverPendingPlatformAlertNotifications(1);
  const result = await pool.query(
    `SELECT delivery_status AS "deliveryStatus",
            attempt_count AS "attemptCount",
            delivered_at AS "deliveredAt",
            last_error AS "lastError"
       FROM platform_alert_notifications WHERE id = $1`,
    [notificationId],
  );
  const row = result.rows[0];

  check('mock worker claims and completes the queued email', delivered === 1 && row?.deliveryStatus === 'DELIVERED',
    { delivered, row });
  check('mock delivery is recorded explicitly and is not represented as a real email',
    row?.lastError === 'MOCKED: captured locally; no email was sent' && row?.deliveredAt != null,
    row);
  check('mock email delivery never creates an SMTP transport', smtpTransportCalls === 0, { smtpTransportCalls });
  check('mock email delivery never calls an external HTTP provider', fetchCalls === 0, { fetchCalls });
})().catch((error) => {
  output.push('FAIL  suite completed without an unexpected exception :: ' + (error && error.stack || error));
  failures += 1;
}).finally(async () => {
  global.fetch = originalFetch;
  nodemailer.createTransport = originalCreateTransport;
  try {
    if (notificationId) await pool.query('DELETE FROM platform_alert_notifications WHERE id = $1', [notificationId]);
    if (alertEventId) await pool.query('DELETE FROM platform_alert_events WHERE id = $1', [alertEventId]);
    if (adminId) await pool.query('DELETE FROM admins WHERE id = $1', [adminId]);
  } catch (error) {
    output.push('FAIL  test fixture cleanup :: ' + (error && error.message || error));
    failures += 1;
  }
  await closePool().catch((error) => {
    output.push('FAIL  database pool shutdown :: ' + (error && error.message || error));
    failures += 1;
  });
  output.forEach((line) => console.log(line));
  if (failures) process.exitCode = 1;
});
