/* End-to-end checks for agency-owned, informational weekly host attendance goals. */
const path = require('path');
const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const out = [];
let failed = 0;
const report = (name, pass, detail) => {
  if (!pass) failed += 1;
  out.push((pass ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 240) : ''));
};
let poolPromise;
function db() {
  if (!poolPromise) poolPromise = new (require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool)({
    connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl, max: 4,
  });
  return poolPromise;
}
const sql = async (q, p) => (await db()).query(q, p);
async function api(method, route, options) {
  options = options || {};
  const res = await fetch(API + route, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, options.token ? { authorization: 'Bearer ' + options.token } : {}),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = res.headers.get('content-type') && res.headers.get('content-type').includes('json')
    ? JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8')) : null;
  return { status: res.status, json, code: json && json.error && json.error.code };
}
async function memberToken(phone, username) {
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (challenge.status !== 200) throw new Error('OTP request failed: ' + JSON.stringify(challenge.json));
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: challenge.json.devCode || '123456', username } });
  if (verified.status !== 200) throw new Error('OTP verify failed: ' + JSON.stringify(verified.json));
  const wallet = await api('GET', '/api/wallet', { token: verified.json.token });
  return { token: verified.json.token, id: wallet.json.user.id };
}
(async () => {
  const stamp = Date.now().toString().slice(-8);
  const tag = 'goal' + stamp;
  const owner = await memberToken('+9237' + stamp + '01', tag + 'owner');
  const hostA = await memberToken('+9237' + stamp + '02', tag + 'hosta');
  const hostB = await memberToken('+9237' + stamp + '03', tag + 'hostb');
  const plain = await memberToken('+9237' + stamp + '04', tag + 'plain');
  const agency = (await sql(
    "INSERT INTO agencies (name, commission_bps, status, owner_user_id) VALUES ($1, 1000, 'ACTIVE', $2) RETURNING id",
    [tag + ' agency', owner.id],
  )).rows[0].id;
  await sql(
    "INSERT INTO agency_hosts (agency_id, host_user_id, status) VALUES ($1, $2, 'ACTIVE'), ($1, $3, 'ACTIVE')",
    [agency, hostA.id, hostB.id],
  );
  const addCheckin = async (host, day) => sql(
    "INSERT INTO room_host_checkins (room_id, room_number, room_title, host_user_id, host_username, checked_in_at, checked_out_at) VALUES (NULL, 900001, 'Goal fixture', $1, $2, now() - ($3::int * INTERVAL '1 day'), now())",
    [host.id, tag + 'host', day],
  );
  await addCheckin(hostA, 0);
  await addCheckin(hostA, 1);
  await addCheckin(hostA, 2);
  await addCheckin(hostB, 0);
  for (let day = 3; day < 100; day += 1) await addCheckin(hostA, day);

  const initial = await api('GET', '/api/agency/goals', { token: owner.token });
  const initialHosts = initial.json && initial.json.goals && initial.json.goals.hosts || [];
  const a = initialHosts.find(h => h.username === tag + 'hosta');
  const b = initialHosts.find(h => h.username === tag + 'hostb');
  report('owner reads the default weekly goal and active-host progress',
    initial.status === 200 && initial.json.goals.weeklyAttendanceTargetDays === 5
      && initial.json.goals.activeHostCount === 2 && a && a.attendanceDays === 3
      && a.progressPercent === 60 && a.remainingDays === 2 && b && b.attendanceDays === 1,
    initial.json && initial.json.goals);

  const refused = await api('GET', '/api/agency/goals', { token: plain.token });
  report('a member without an agency cannot read another agency goals',
    refused.status === 403 && refused.code === 'agency_not_found', refused.code);

  const changed = await api('PUT', '/api/agency/goals', {
    token: owner.token, body: { weeklyAttendanceTargetDays: 3 },
  });
  const changedA = changed.json && changed.json.goals && changed.json.goals.hosts.find(h => h.username === tag + 'hosta');
  const changedB = changed.json && changed.json.goals && changed.json.goals.hosts.find(h => h.username === tag + 'hostb');
  report('owner can set a 3-day target and progress recalculates without changing attendance',
    changed.status === 200 && changed.json.goals.weeklyAttendanceTargetDays === 3
      && changedA && changedA.attendanceDays === 3 && changedA.metTarget === true
      && changedA.progressPercent === 100 && changedB && changedB.attendanceDays === 1
      && changedB.progressPercent === 33,
    changed.json && changed.json.goals);

  const persisted = await api('GET', '/api/agency/goals', { token: owner.token });
  report('the selected target persists on subsequent reads',
    persisted.status === 200 && persisted.json.goals.weeklyAttendanceTargetDays === 3,
    persisted.json && persisted.json.goals && persisted.json.goals.weeklyAttendanceTargetDays);

  for (const invalid of [0, 8, 1.5, '3', null]) {
    const result = await api('PUT', '/api/agency/goals', {
      token: owner.token, body: { weeklyAttendanceTargetDays: invalid },
    });
    report('invalid target ' + JSON.stringify(invalid) + ' is refused',
      result.status === 400 && result.code === 'invalid_attendance_target', result.code);
  }

  const final = await api('GET', '/api/agency/goals', { token: owner.token });
  report('rejected target changes leave the saved target unchanged',
    final.status === 200 && final.json.goals.weeklyAttendanceTargetDays === 3,
    final.json && final.json.goals && final.json.goals.weeklyAttendanceTargetDays);

  const recognition = await api('GET', '/api/agency/recognition', { token: owner.token });
  const recognitionHosts = recognition.json && recognition.json.recognition && recognition.json.recognition.hosts || [];
  const recognisedA = recognitionHosts.find(h => h.username === tag + 'hosta');
  const recognisedB = recognitionHosts.find(h => h.username === tag + 'hostb');
  report('owner sees verified lifetime attendance milestones with earned dates',
    recognition.status === 200 && recognition.json.recognition.activeHostCount === 2
      && recognisedA && recognisedA.attendanceDays === 100
      && recognisedA.milestones.length === 4
      && recognisedA.milestones.every(m => typeof m.unlockedAt === 'string')
      && recognisedA.milestones[0].code === 'FIRST_CHECK_IN'
      && recognisedA.milestones[3].code === 'HUNDRED_DAYS'
      && recognisedB && recognisedB.attendanceDays === 1
      && recognisedB.milestones.filter(m => m.unlockedAt !== null).length === 1,
    recognition.json && recognition.json.recognition);

  const recognitionRefused = await api('GET', '/api/agency/recognition', { token: plain.token });
  report('members without an agency cannot read host recognition',
    recognitionRefused.status === 403 && recognitionRefused.code === 'agency_not_found',
    recognitionRefused.code);

  const checkinCount = await sql("SELECT COUNT(*)::int AS count FROM room_host_checkins WHERE host_user_id IN ($1, $2)", [hostA.id, hostB.id]);
  const recognitionAgain = await api('GET', '/api/agency/recognition', { token: owner.token });
  const countAfterRead = await sql("SELECT COUNT(*)::int AS count FROM room_host_checkins WHERE host_user_id IN ($1, $2)", [hostA.id, hostB.id]);
  report('reading recognition is read-only and does not create attendance records',
    recognitionAgain.status === 200 && checkinCount.rows[0].count === countAfterRead.rows[0].count,
    { before: checkinCount.rows[0].count, after: countAfterRead.rows[0].count });

  out.push('');
  out.push(out.filter(line => line.startsWith('PASS')).length + '/' + (out.length - 1) + ' agency-host-goals checks passed');
  process.stdout.write(out.join('\n') + '\n');
  await db().end();
  process.exit(failed ? 1 : 0);
})().catch(async error => {
  process.stdout.write(out.join('\n') + '\n');
  console.error('AGENCY HOST GOALS E2E CRASH', error);
  if (poolPromise) await db().end().catch(() => {});
  process.exitCode = 1;
});
