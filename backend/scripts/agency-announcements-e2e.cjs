/* End-to-end checks for agency-scoped announcements and live membership revocation. */
const path = require('path');
const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const out = [];
let failed = 0;
const report = (name, pass, detail) => {
  if (!pass) failed += 1;
  out.push((pass ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 220) : ''));
};
let poolPromise;
function db() {
  if (!poolPromise) poolPromise = new (require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool)({
    connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl, max: 4,
  });
  return poolPromise;
}
const sql = async (q, p) => (await db()).query(q, p);
async function api(method, route, options = {}) {
  const res = await fetch(API + route, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, options.token ? { authorization: 'Bearer ' + options.token } : {}),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  return { status: res.status, json, code: json?.error?.code };
}
async function memberToken(phone, username) {
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error('OTP request failed: ' + JSON.stringify(challenge.json));
  const verified = await api('POST', '/api/auth/verify-otp', {
    body: { phone, code: challenge.json.devCode || '123456', username },
  });
  if (verified.status !== 200) throw new Error('OTP verify failed: ' + JSON.stringify(verified.json));
  const wallet = await api('GET', '/api/wallet', { token: verified.json.token });
  return { token: verified.json.token, id: wallet.json.user.id };
}
(async () => {
  const stamp = Date.now().toString().slice(-8), tag = 'ann' + stamp;
  const owner = await memberToken('+9238' + stamp + '01', tag + 'owner');
  const host = await memberToken('+9238' + stamp + '02', tag + 'host');
  const removed = await memberToken('+9238' + stamp + '03', tag + 'removed');
  const outsider = await memberToken('+9238' + stamp + '04', tag + 'outsider');
  const agencyId = (await sql(
    "INSERT INTO agencies (name, commission_bps, status, owner_user_id) VALUES ($1, 1000, 'ACTIVE', $2) RETURNING id",
    [tag + ' agency', owner.id],
  )).rows[0].id;
  await sql(
    "INSERT INTO agency_hosts (agency_id, host_user_id, status) VALUES ($1, $2, 'ACTIVE'), ($1, $3, 'ACTIVE')",
    [agencyId, host.id, removed.id],
  );
  const created = await api('POST', '/api/agency/announcements', {
    token: owner.token, body: { title: 'Room schedule', body: 'Team meeting at 8 PM.' },
  });
  const announcementId = created.json?.announcement?.id;
  report('owner publishes an announcement to its active roster snapshot',
    created.status === 201 && created.json.announcement.recipientCount === 2 && !!announcementId,
    created.json?.announcement);
  const ownerList = await api('GET', '/api/agency/announcements', { token: owner.token });
  report('owner can read only its agency announcement history',
    ownerList.status === 200 && ownerList.json.announcements.length === 1
      && ownerList.json.announcements[0].readCount === 0, ownerList.json);
  const hostInbox = await api('GET', '/api/agency/announcements/inbox', { token: host.token });
  report('currently assigned host receives the published announcement',
    hostInbox.status === 200 && hostInbox.json.announcements.length === 1
      && hostInbox.json.announcements[0].isRead === false, hostInbox.json);
  const marked = await api('POST', '/api/agency/announcements/' + announcementId + '/read', { token: host.token });
  const reread = await api('GET', '/api/agency/announcements/inbox', { token: host.token });
  report('host can mark its announcement read and the receipt persists',
    marked.status === 200 && reread.json.announcements[0].isRead === true, reread.json);
  const outsiderInbox = await api('GET', '/api/agency/announcements/inbox', { token: outsider.token });
  report('unassigned member sees no agency announcements',
    outsiderInbox.status === 200 && outsiderInbox.json.announcements.length === 0, outsiderInbox.json);
  await sql("UPDATE agency_hosts SET status = 'SUSPENDED' WHERE agency_id = $1 AND host_user_id = $2", [agencyId, removed.id]);
  const revokedInbox = await api('GET', '/api/agency/announcements/inbox', { token: removed.token });
  const revokedRead = await api('POST', '/api/agency/announcements/' + announcementId + '/read', { token: removed.token });
  report('suspended host loses inbox and read access immediately',
    revokedInbox.status === 200 && revokedInbox.json.announcements.length === 0
      && revokedRead.status === 404 && revokedRead.code === 'agency_announcement_not_found',
    { inbox: revokedInbox.json, read: revokedRead.code });
  const ownerRefused = await api('GET', '/api/agency/announcements', { token: outsider.token });
  report('member without an agency cannot read owner announcement history',
    ownerRefused.status === 403 && ownerRefused.code === 'agency_not_found', ownerRefused.code);
  const invalid = await api('POST', '/api/agency/announcements', {
    token: owner.token, body: { title: ' ', body: 'empty title' },
  });
  report('invalid announcement content is rejected',
    invalid.status === 400 && invalid.code === 'invalid_announcement_title', invalid.code);
})().catch((error) => { report('suite completed without an unexpected exception', false, String(error)); })
  .finally(async () => {
    out.forEach((line) => console.log(line));
    if (poolPromise) await (await poolPromise).end();
    if (failed) process.exitCode = 1;
  });
