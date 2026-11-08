/* End-to-end tests for Become a Partner (migration 0035, README "Become a Partner").
   Drives a *running* backend over HTTP and asserts on database state through the backend's own
   pg pool — no mocks, no fixtures.

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/partner-e2e.cjs

   Runs against a development database. Members, applications, agencies and business accounts are
   named with a stamp and left behind — an application that has been decided cannot be erased without
   deleting the audit row beside it — but everything this run opens is closed again: the two
   `system_config` switches are restored, the three operators it signs in are disabled, the grants it
   mints are revoked, and the rooms it creates for the gate test are closed.

   The checks worth reading first are the three that decide whether the module means anything.

     * A grant is the APPROVED row, never a column. A member cannot write their own `user_type`, an
       approval raises exactly the role that was asked for, and a revocation takes the row out of the
       set the readers query. Each of those breaks if the state moves to `users.user_type`, which
       `room.service.ts` has been writing for anyone who opened a room.
     * The applicant is the token. Nothing on this router takes a user id, and the one place a body
       can name an account is ignored rather than trusted.
     * Approval activates what the role IS, and no more. A coin seller with no BD above it is refused
       for the money reason, an agency name that is taken is refused, and a second BD manager needs
       the switch turned on first.

   Everything else is the queue's own behaviour: the live index behind one-open-application-per-role,
   the merge that lets an information request ask for one thing, the note an operator must give before
   refusing, and the permission that separates reading the queue from deciding it. */
const path = require('path');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');
const OTP = process.env.OTP_MOCK_CODE || '123456';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

let failed = 0;
const out = [];
function report(name, pass, detail) {
  if (!pass) failed += 1;
  out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 260)}` : ''}`);
}

let poolPromise = null;
function db() {
  if (!poolPromise) {
    poolPromise = new (require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool)({
      connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl,
      max: 6,
    });
  }
  return poolPromise;
}
const sql = async (q, p) => (await db()).query(q, p);

async function api(method, p, { token, body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  try {
    json = type.includes('json') ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: res.status,
    json,
    code: json && json.error && json.error.code,
    message: json && json.error && json.error.message,
  };
}

const stamp = Date.now().toString().slice(-7);
let seat = 0;

/** One phone number per member. Five submissions an hour are allowed per account, so the run needs
    more than one account to exercise the refusals without tripping its own rate limit. */
async function member(tag) {
  seat += 1;
  const phone = `+1555${stamp}${String(seat).padStart(2, '0')}`;
  const username = `partner_${tag}_${stamp}`.slice(0, 40);
  const r = await api('POST', '/api/auth/request-otp', { body: { phone } });
  if (r.status !== 200) throw new Error(`request-otp failed for ${tag}: ${JSON.stringify(r.json)}`);
  const v = await api('POST', '/api/auth/verify-otp', { body: { phone, code: OTP, username } });
  if (v.status !== 200) throw new Error(`verify-otp failed for ${tag}: ${JSON.stringify(v.json)}`);
  // The name is read back from the response, not from the one asked for: an account is addressed by
  // what the server stored, and the queue search below is only meaningful against that.
  return { token: v.json.token, id: v.json.user.id, username: v.json.user.username };
}

async function operator(role) {
  const username = `e2e_pa_${role.toLowerCase()}_${stamp}`.slice(0, 40);
  const password = `e2e-pa-${role}-${stamp}`;
  const created = await api('POST', '/api/admin/operators', { token: SUPER, body: { username, password, role } });
  if (created.status !== 201) throw new Error(`operator ${role} failed: ${JSON.stringify(created.json)}`);
  operatorIds.push(created.json.operator.id);
  const signed = await api('POST', '/api/admin/login', { body: { username, password } });
  // The name as well as the id: the DTO hands an operator the reviewer's username, because that is
  // what a person reading the queue recognises, not the row's primary key.
  return { id: created.json.operator.id, username, token: signed.json.token, permissions: signed.json.permissions };
}

// The answers each form asks for, spelled as the spec spells them. A field name that drifts here is a
// drift in the spec itself, and the refusals below are what would catch it.
const hostAnswers = (over) => ({
  fullName: `E2E Host ${stamp}`,
  country: 'bd',
  city: 'Dhaka',
  ageConfirmed: true,
  ...over,
});
const agencyAnswers = (name, over) => ({
  agencyName: name,
  ownerFullName: `E2E Owner ${stamp}`,
  country: 'BD',
  city: 'Dhaka',
  teamSize: 12,
  recruitmentExperience: 'Five years recruiting and paying hosts in three markets.',
  ...over,
});
const sellerAnswers = (over) => ({
  businessOrFullName: `E2E Seller ${stamp}`,
  location: 'Dhaka, BD',
  contactPhone: '+15550001122',
  expectedMonthlyVolume: 50000,
  verificationDetails: 'Bank transfer every Friday against the order reference.',
  ...over,
});
const bdAnswers = (over) => ({
  fullName: `E2E BD ${stamp}`,
  country: 'BD',
  city: 'Dhaka',
  experience: 'Recruited and managed a network of thirty agencies across two markets.',
  languages: 'en, bn',
  coverageArea: 'South Asia',
  ...over,
});

const grant = (application) => application && application.grant;

// The super-admin token, set once the suite has signed in; `operator` needs it to create the
// three limited accounts the permission checks run as.
let SUPER = null;

// Everything this run leaves switched on, in the wrong state, if it throws. The header promises the
// database comes back as it was found, and that only holds if the walk-out also runs on the failure
// path — so these live at module scope, and RESTORE below is assigned as soon as there is anything to
// clean up. `createdRooms` carries the token that owns each room: a room closes for its host, not for
// whoever happens to be cleaning up.
const createdRooms = [];
const operatorIds = [];
let RESTORE = null;

const setConfig = (key, value) =>
  api('PUT', `/api/admin/business/config/${encodeURIComponent(key)}`, { token: SUPER, body: { value } });

/** The migration defaults, so a crash mid-run cannot leave the development backend gating rooms. */
const DEFAULTS = {
  'roles.hostApplicationRequired': { enabled: false },
  'business.bd': { multiManager: false },
};

async function walkOut() {
  if (!RESTORE) return;
  try {
    await RESTORE();
    out.push('PASS  the environment was put back after a throw');
  } catch (err) {
    out.push(`FAIL  cleanup after the throw itself failed :: ${err && err.message}`);
  }
}

(async () => {
  const adminLogin = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } });
  if (adminLogin.status !== 200) {
    console.log(`FAIL  backend/admin login is required :: ${adminLogin.status}`);
    console.log('\n0/1 partner checks passed — could not sign in as admin');
    process.exit(1);
  }
  SUPER = adminLogin.json.token;

  // The two switches this module reads. Both are restored at the end, whatever happens below.
  const originalHostGate = await sql("SELECT value FROM system_config WHERE key = 'roles.hostApplicationRequired'");
  const originalMultiBd = await sql("SELECT value FROM system_config WHERE key = 'business.bd'");

  const A = await member('host');
  const A2 = await member('refusals');
  const B = await member('agency');
  const C = await member('seller');
  const D = await member('bd');
  const E = await member('nobody');
  const F = await member('question');
  const N = await member('other');
  const accounts = [A, A2, B, C, D, E, F, N];

  const readOps = await operator('FINANCE_ADMIN');
  const reviewOps = await operator('OPERATIONS_ADMIN');
  const noOps = await operator('MODERATOR');

  let walkedOut = false;
  RESTORE = async () => {
    if (walkedOut) return;
    walkedOut = true;
    await setConfig('roles.hostApplicationRequired', originalHostGate.rows[0] ? originalHostGate.rows[0].value : DEFAULTS['roles.hostApplicationRequired']);
    await setConfig('business.bd', originalMultiBd.rows[0] ? originalMultiBd.rows[0].value : DEFAULTS['business.bd']);
    // Nothing filed here is left waiting for an operator. A decided row refuses the withdraw and the
    // response is ignored — history stays history, which is the point of the audit trail below.
    const waiting = await sql(
      "SELECT id, user_id FROM role_applications WHERE user_id = ANY($1::uuid[]) AND status IN ('PENDING','INFO_REQUESTED')",
      [accounts.map((a) => a.id)],
    );
    for (const row of waiting.rows) {
      const owner = accounts.find((a) => a.id === row.user_id);
      if (owner) await api('POST', `/api/role-applications/${row.id}/cancel`, { token: owner.token });
    }
    for (const room of createdRooms) await api('POST', `/api/rooms/${room.id}/close`, { token: room.token });
    for (const id of operatorIds) await api('POST', `/api/admin/operators/${id}/disable`, { token: SUPER, body: { reason: `partner-e2e-${stamp} finished` } });
  };

  const apply = (m, role, data, extra) => api('POST', '/api/role-applications', { token: m.token, body: { role, data, ...extra } });
  const mine = async (m) => (await api('GET', '/api/role-applications/mine', { token: m.token })).json;
  const detail = (id, token = SUPER) => api('GET', `/api/admin/partner-applications/${id}`, { token });

  // ---------------------------------------------------------------------------
  // 1. the catalogue is the form
  // ---------------------------------------------------------------------------
  const catalogue = await api('GET', '/api/role-applications/roles', { token: A.token });
  const roles = (catalogue.json && catalogue.json.roles) || [];
  report('the picker answers the four roles and nothing else', catalogue.status === 200 && roles.length === 4, {
    status: catalogue.status,
    roles: roles.map((r) => r.role),
  });
  report(
    'every role carries its own fields, copy and benefits',
    roles.every((r) => r.title && r.blurb && Array.isArray(r.benefits) && r.benefits.length > 0 && Array.isArray(r.fields) && r.fields.length >= 4),
    roles.map((r) => `${r.role}:${(r.fields || []).length}`),
  );
  report(
    'the four forms ask different questions',
    new Set(roles.flatMap((r) => (r.fields || []).map((f) => f.key))).size >= 18,
    new Set(roles.flatMap((r) => (r.fields || []).map((f) => f.key))).size,
  );
  const hostForm = roles.find((r) => r.role === 'HOST');
  report(
    'the age confirmation is a checkbox the server requires as a boolean',
    (hostForm?.fields || []).some((f) => f.key === 'ageConfirmed' && f.input === 'CHECKBOX' && f.required === true),
  );
  report('a fresh account is granted nothing and has nothing open', roles.every((r) => r.granted === false && r.openApplication === null));
  const listed = (catalogue.json && catalogue.json.agencies) || [];
  if (listed.length > 0) {
    const rows = await sql("SELECT count(*) AS n FROM agencies WHERE status = 'ACTIVE'");
    report(
      'the agency shortlist the Host form offers is exactly the ACTIVE agencies',
      Number(rows.rows[0].n) >= listed.length && listed.length <= 50,
      { listed: listed.length, active: rows.rows[0].n },
    );
  }

  const oneForm = await api('GET', '/api/role-applications/form/COIN_SELLER', { token: A.token });
  const lowerForm = await api('GET', '/api/role-applications/form/coin_seller', { token: A.token });
  const unknownForm = await api('GET', '/api/role-applications/form/SPONSOR', { token: A.token });
  const anonForm = await api('GET', '/api/role-applications/form/HOST');
  report('one role form reads on its own, in either case', oneForm.status === 200 && lowerForm.status === 200 && lowerForm.json.role === 'COIN_SELLER', {
    one: oneForm.status,
    lower: lowerForm.status,
  });
  report('a role that does not exist is a 404, not an empty form', unknownForm.status === 404 && unknownForm.code === 'unknown_role', unknownForm.code);
  report('the specs are not public: the questions are read with the token that would file them', anonForm.status === 401, anonForm.status);

  // ---------------------------------------------------------------------------
  // 2. nobody hands themselves a role
  // ---------------------------------------------------------------------------
  const selfPatch = await api('PATCH', '/api/auth/me', { token: E.token, body: { username: E.username, userType: 'COIN_SELLER' } });
  const markerRow = await sql('SELECT user_type FROM users WHERE id = $1', [E.id]);
  report(
    'the profile update writes its five columns and nothing else: userType is not one of them',
    selfPatch.status === 200 && markerRow.rows[0].user_type === 'USER',
    { status: selfPatch.status, userType: markerRow.rows[0].user_type },
  );
  const anonApply = await api('POST', '/api/role-applications', { body: { role: 'HOST', data: hostAnswers() } });
  report('applying needs an account', anonApply.status === 401, anonApply.status);

  const hijack = await apply(A, 'HOST', hostAnswers(), { userId: E.id, user_id: E.id, id: E.id });
  const hijackRow = await sql('SELECT user_id FROM role_applications WHERE id = $1', [hijack.json.application.id]);
  report(
    'the applicant is the token; a body that names another account is ignored',
    hijack.status === 201 && hijackRow.rows[0].user_id === A.id,
    { status: hijack.status, owner: hijackRow.rows[0].user_id === A.id },
  );
  const hostAppId = hijack.json.application.id;
  report('a filed application waits for a person', hijack.json.application.status === 'PENDING' && hijack.json.application.reviewedBy === null);
  report(
    'a stored answer is normalised, not echoed: bd becomes BD and the number stays a number',
    hijack.json.application.data.country === 'BD' && hijack.json.application.data.ageConfirmed === true,
    hijack.json.application.data,
  );

  // The name one agency will file under. Declared here because the two checks below — the text-area
  // minimum and the taken-name refusal — have to disagree about the same row, not two similar ones.
  const agencyName = `e2e_agency_${stamp}`;

  // ---------------------------------------------------------------------------
  // 3. the server validates, from its own spec, every time
  // ---------------------------------------------------------------------------
  const missing = await apply(A2, 'HOST', { fullName: `E2E ${stamp}`, country: 'BD', ageConfirmed: true });
  report('a required question left out is refused by name', missing.status === 400 && missing.code === 'field_required', missing.message);
  const invented = await apply(A2, 'HOST', hostAnswers({ commissionPercent: 40 }));
  report(
    'a field the form does not ask for is refused, not stored',
    invented.status === 400 && invented.code === 'unexpected_field',
    invented.message,
  );
  const underage = await apply(A2, 'HOST', hostAnswers({ ageConfirmed: false }));
  report('a confirmation left unticked is a refusal, not a false answer', underage.status === 400 && underage.code === 'confirmation_required', underage.code);
  // Two letters is the shape; anything else — three characters, or two that are not a country — is
  // refused before a row exists. `USA` fails on length and `B$` fails on the pattern.
  const threeLetters = await apply(F, 'HOST', hostAnswers({ country: 'USA' }));
  report('a country is two characters or nothing', threeLetters.status === 400 && /country/.test(threeLetters.message || ''), threeLetters.message);
  const notACountry = await apply(F, 'HOST', hostAnswers({ country: 'B$' }));
  report('two characters that are not a country code are refused as well', notACountry.status === 400 && notACountry.code === 'invalid_country', notACountry.code);
  const bogusAgency = await apply(A2, 'HOST', hostAnswers({ preferredAgencyId: '22222222-2222-4222-8222-222222222222' }));
  report(
    'a preferred agency must be a row that exists and is recruiting',
    bogusAgency.status === 400 && bogusAgency.code === 'preferred_agency_not_found',
    bogusAgency.code,
  );
  const tinyTeam = await apply(B, 'AGENCY', agencyAnswers(agencyName, { teamSize: 0 }));
  report('a number is bounded by the form, not by the client', tinyTeam.status === 400 && /teamSize/.test(tinyTeam.message || ''), tinyTeam.message);
  const shortStory = await apply(B, 'AGENCY', agencyAnswers(agencyName, { recruitmentExperience: 'yes' }));
  report('a text area enforces its own minimum', shortStory.status === 400 && /recruitmentExperience/.test(shortStory.message || ''), shortStory.message);
  const badEmail = await apply(C, 'COIN_SELLER', sellerAnswers({ contactEmail: 'not-an-email' }));
  report('an optional contact email is still an email when given', badEmail.status === 400 && badEmail.code === 'invalid_email', { status: badEmail.status, code: badEmail.code });
  const badPhone = await apply(C, 'COIN_SELLER', sellerAnswers({ contactPhone: 'abc' }));
  report('a contact phone is normalised to E.164 or refused', badPhone.status === 400, { status: badPhone.status, message: badPhone.message });
  const nothingStored = await sql("SELECT count(*)::int AS n FROM role_applications WHERE status = 'PENDING' AND user_id = ANY($1::uuid[])", [
    [A2.id, C.id, D.id, E.id, N.id],
  ]);
  report('every refusal above filed nothing', nothingStored.rows[0].n === 0, nothingStored.rows[0]);

  // ---------------------------------------------------------------------------
  // 4. one live application per role, and what frees it
  // ---------------------------------------------------------------------------
  const twice = await apply(A, 'HOST', hostAnswers());
  report('a second tap is the same queue item, not a second chance', twice.status === 409 && twice.code === 'application_already_open', twice.code);

  const otherRole = await apply(A, 'AGENCY', agencyAnswers(`e2e_two_roles_${stamp}`));
  report('a different role is a different application', otherRole.status === 201, otherRole.status);
  const twoLive = await sql(
    "SELECT count(*)::int AS n FROM role_applications WHERE user_id = $1 AND status IN ('PENDING','INFO_REQUESTED','APPROVED')",
    [A.id],
  );
  report('the live index allows one row per (account, role), not one per account', twoLive.rows[0].n === 2, twoLive.rows[0]);

  const nApplied = await apply(N, 'HOST', hostAnswers());
  const foreign = nApplied.json.application.id;
  const foreignCancel = await api('POST', `/api/role-applications/${foreign}/cancel`, { token: A.token });
  report('one account cannot withdraw another account’s application', foreignCancel.status === 403 && foreignCancel.code === 'not_yours', foreignCancel.code);
  const foreignSupplement = await api('POST', `/api/role-applications/${foreign}/supplement`, { token: A.token, body: { data: { city: 'X' } } });
  report('and cannot answer for it either', foreignSupplement.status === 403 && foreignSupplement.code === 'not_yours', foreignSupplement.code);

  const withdrew = await api('POST', `/api/role-applications/${foreign}/cancel`, { token: N.token });
  report('the author can withdraw it, and the row stays as history', withdrew.status === 200 && withdrew.json.application.status === 'CANCELLED', withdrew.json.application.status);
  const reopened = await apply(N, 'HOST', hostAnswers());
  report('a withdrawn application frees the slot, so the member can change their mind', reopened.status === 201, { status: reopened.status, code: reopened.code });
  const cancelTwice = await api('POST', `/api/role-applications/${foreign}/cancel`, { token: N.token });
  report('withdrawing twice is refused', cancelTwice.status === 409 && cancelTwice.code === 'application_not_open', cancelTwice.code);
  // The same refusal against a row that an operator has *decided* belongs in section 6, after the
  // approval — withdrawn here it would take A's only Host application off the queue and every check
  // that reads that id afterwards would fail for the wrong reason.

  // ---------------------------------------------------------------------------
  // 5. reading the queue and deciding it are different permissions
  // ---------------------------------------------------------------------------
  const queue = await api('GET', '/api/admin/partner-applications?status=PENDING&limit=100', { token: SUPER });
  report(
    'the queue lists open applications with the account behind them',
    queue.status === 200 && queue.json.applications.some((a) => a.id === hostAppId && a.applicant && a.applicant.username === A.username),
    { status: queue.status, total: queue.json.total },
  );
  const byRole = await api('GET', '/api/admin/partner-applications?role=COIN_SELLER&limit=100', { token: SUPER });
  report('the queue filters by role', byRole.status === 200 && byRole.json.applications.every((a) => a.role === 'COIN_SELLER'), byRole.json.total);
  // Searching for A, not B: at this point B has filed nothing that survives — its two attempts were
  // refused in section 3 — so an empty result here would be correct and prove nothing.
  const searched = await api('GET', `/api/admin/partner-applications?search=${A.username}&limit=10`, { token: SUPER });
  report(
    'and finds a member by the name on their profile',
    searched.status === 200 && searched.json.applications.length > 0 && searched.json.applications.every((a) => a.applicant.username === A.username),
    { total: searched.json.total, usernames: searched.json.applications.map((a) => a.applicant.username) },
  );
  const adminForms = await api('GET', '/api/admin/partner-applications/forms', { token: SUPER });
  report('the panel reads the same specs, with the agency names beside them', adminForms.status === 200 && adminForms.json.roles.length === 4 && Array.isArray(adminForms.json.agencies), adminForms.status);

  const modRead = await api('GET', '/api/admin/partner-applications?limit=5', { token: noOps.token });
  report('a moderator is not a partner reviewer', modRead.status === 403, { status: modRead.status, code: modRead.code });
  const modDecide = await api('POST', `/api/admin/partner-applications/${hostAppId}/approve`, { token: noOps.token, body: {} });
  report('and cannot decide one either', modDecide.status === 403, modDecide.status);
  const financeDecide = await api('POST', `/api/admin/partner-applications/${hostAppId}/approve`, { token: readOps.token, body: {} });
  report('a finance operator reads the queue but does not grant roles', financeDecide.status === 403 && !readOps.permissions.includes('application:review'), {
    status: financeDecide.status,
    permissions: readOps.permissions.filter((p) => p.startsWith('application')),
  });
  const userDecide = await api('POST', `/api/admin/partner-applications/${hostAppId}/approve`, { token: A.token, body: {} });
  report('a member token cannot reach the deciding side at all', userDecide.status === 401 || userDecide.status === 403, userDecide.status);

  // ---------------------------------------------------------------------------
  // 6. an approval activates exactly the role that was asked for
  // ---------------------------------------------------------------------------
  const approved = await api('POST', `/api/admin/partner-applications/${hostAppId}/approve`, { token: reviewOps.token, body: { note: `e2e ${stamp}: welcome` } });
  report('an operator approves a Host', approved.status === 200 && approved.json.application.status === 'APPROVED', { status: approved.status, code: approved.code });
  report('the approval is credited to the operator who gave it', approved.json.application.reviewedBy === reviewOps.username, {
    reviewedBy: approved.json.application.reviewedBy,
    operator: reviewOps.username,
  });
  const hostMine = await mine(A);
  report('the grant is the row: the account now reads as an approved Host', hostMine.activeRoles.join() === 'HOST', hostMine.activeRoles);
  const hostMarker = await sql('SELECT user_type FROM users WHERE id = $1', [A.id]);
  report('the profile marker is raised for display, and nothing reads it as proof', hostMarker.rows[0].user_type === 'HOST', hostMarker.rows[0]);
  const grantedCatalogue = await api('GET', '/api/role-applications/roles', { token: A.token });
  const hostCard = grantedCatalogue.json.roles.find((r) => r.role === 'HOST');
  const hostQueueRows = await sql("SELECT count(*)::int AS n FROM role_applications WHERE user_id = $1 AND role = 'HOST' AND status IN ('PENDING','INFO_REQUESTED')", [A.id]);
  report(
    'the picker shows the role as held, still points at that row, and leaves nothing waiting in the queue',
    hostCard.granted === true && hostCard.openApplication.status === 'APPROVED' && hostQueueRows.rows[0].n === 0,
    { granted: hostCard.granted, open: hostCard.openApplication.status, waiting: hostQueueRows.rows[0] },
  );
  const reapply = await apply(A, 'HOST', hostAnswers());
  report('a held role cannot be applied for twice', reapply.status === 409 && reapply.code === 'role_already_granted', reapply.code);

  // Applying for AGENCY above was allowed by the live index; approving HOST must not have granted it.
  const stillOnlyHost = await mine(A);
  const noAgencyYet = await sql('SELECT count(*)::int AS n FROM agencies WHERE owner_user_id = $1', [A.id]);
  report(
    'a Host approval opens no agency, no BD office and no seller desk',
    stillOnlyHost.activeRoles.join() === 'HOST' && noAgencyYet.rows[0].n === 0,
    { activeRoles: stillOnlyHost.activeRoles, agencies: noAgencyYet.rows[0].n },
  );
  const decidedTwice = await api('POST', `/api/admin/partner-applications/${hostAppId}/approve`, { token: reviewOps.token, body: {} });
  report('a decided row cannot be decided again', decidedTwice.status === 409 && decidedTwice.code === 'application_already_decided', decidedTwice.code);
  const decidedCancel = await api('POST', `/api/role-applications/${hostAppId}/cancel`, { token: A.token });
  report(
    'a decided application cannot be withdrawn — once it is a grant, only an operator can take it back',
    decidedCancel.status === 409 && decidedCancel.code === 'application_not_open',
    { status: decidedCancel.status, code: decidedCancel.code },
  );

  // ---- agency ----
  const agencyApplied = await apply(B, 'AGENCY', agencyAnswers(agencyName));
  const agencyAppId = agencyApplied.json.application.id;
  report('the agency form files once its number and story pass', agencyApplied.status === 201, { status: agencyApplied.status, message: agencyApplied.message });
  const agencyApproved = await api('POST', `/api/admin/partner-applications/${agencyAppId}/approve`, { token: reviewOps.token, body: {} });
  const agencyGrant = grant(agencyApproved.json.application);
  report('an approved agency is an ACTIVE agency the applicant owns', agencyApproved.status === 200 && agencyGrant.kind === 'AGENCY' && agencyGrant.status === 'ACTIVE', agencyGrant);
  const agencyRow = await sql('SELECT name, status, owner_user_id, commission_bps FROM agencies WHERE id = $1', [agencyGrant.id]);
  report('the agency row carries the applicant as its owner', agencyRow.rows[0] && agencyRow.rows[0].owner_user_id === B.id && agencyRow.rows[0].name === agencyName, agencyRow.rows[0]);
  const agencyAccount = await sql("SELECT count(*)::int AS n FROM fin_accounts WHERE category = 'AGENCY' AND owner_id = $1", [agencyGrant.id]);
  report('and its earnings account exists before its first gift', agencyAccount.rows[0].n === 1, agencyAccount.rows[0]);

  const takenName = await apply(F, 'AGENCY', agencyAnswers(agencyName));
  const takenApproved = await api('POST', `/api/admin/partner-applications/${takenName.json.application.id}/approve`, { token: reviewOps.token, body: {} });
  report(
    'a second agency with the same name is refused at approval, not silently duplicated',
    takenApproved.status === 409 && takenApproved.code === 'agency_name_taken',
    { status: takenApproved.status, code: takenApproved.code },
  );
  await api('POST', `/api/role-applications/${takenName.json.application.id}/cancel`, { token: F.token });

  // ---- coin seller: the money rule ----
  const sellerApplied = await apply(C, 'COIN_SELLER', sellerAnswers());
  const sellerAppId = sellerApplied.json.application.id;
  report('a seller with a bad email and phone in it never got filed; this one did', sellerApplied.status === 201, sellerApplied.status);
  const sellerNoParent = await api('POST', `/api/admin/partner-applications/${sellerAppId}/approve`, { token: reviewOps.token, body: {} });
  report(
    'a coin seller cannot be approved without the BD account it reports to',
    sellerNoParent.status === 400 && sellerNoParent.code === 'seller_bd_required',
    sellerNoParent.code,
  );
  const anySeller = await sql("SELECT id FROM business_accounts WHERE kind = 'COIN_SELLER' AND status <> 'CLOSED' LIMIT 1");
  const wrongParent = await api('POST', `/api/admin/partner-applications/${sellerAppId}/approve`, {
    token: reviewOps.token,
    body: { bdAccountId: anySeller.rows[0] ? anySeller.rows[0].id : '22222222-2222-4222-8222-222222222222' },
  });
  report('and a seller cannot report to another seller', wrongParent.status === 400 && wrongParent.code === 'invalid_parent', wrongParent.code);
  const bdParent = await sql("SELECT id FROM business_accounts WHERE kind = 'BD_MANAGER' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1");
  if (!bdParent.rows[0]) throw new Error('this suite needs one ACTIVE BD_MANAGER business account to attach a seller to');
  const sellerApproved = await api('POST', `/api/admin/partner-applications/${sellerAppId}/approve`, {
    token: reviewOps.token,
    body: { bdAccountId: bdParent.rows[0].id },
  });
  const sellerGrant = grant(sellerApproved.json.application);
  report('naming the BD turns the application into an ACTIVE partner account', sellerApproved.status === 200 && sellerGrant.kind === 'BUSINESS_ACCOUNT' && sellerGrant.status === 'ACTIVE', sellerGrant);
  const sellerRow = await sql('SELECT kind, status, parent_id, max_order_diamonds, code FROM business_accounts WHERE id = $1', [sellerGrant.id]);
  report(
    'the seller inherits the configured limits and sits under its BD',
    sellerRow.rows[0].kind === 'COIN_SELLER' && sellerRow.rows[0].parent_id === bdParent.rows[0].id && Number(sellerRow.rows[0].max_order_diamonds) > 0,
    sellerRow.rows[0],
  );
  const sellerNoPassword = await sql('SELECT password_hash FROM business_accounts WHERE id = $1', [sellerGrant.id]);
  report(
    'the approval opens the partner account but sets no panel password — an operator hands that over',
    sellerNoPassword.rows[0].password_hash === null,
    { hasHash: sellerNoPassword.rows[0].password_hash !== null },
  );

  // ---- BD manager: the one-office rule ----
  const bdApplied = await apply(D, 'BD_MANAGER', bdAnswers());
  const bdAppId = bdApplied.json.application.id;
  const bdSingle = await api('POST', `/api/admin/partner-applications/${bdAppId}/approve`, { token: reviewOps.token, body: {} });
  report('a second BD manager is refused while the switch says one office is enough', bdSingle.status === 403 && bdSingle.code === 'multi_manager_disabled', bdSingle.code);
  await setConfig('business.bd', { multiManager: true });
  const bdApproved = await api('POST', `/api/admin/partner-applications/${bdAppId}/approve`, { token: reviewOps.token, body: {} });
  const bdGrant = grant(bdApproved.json.application);
  report('with the switch on, the same decision goes through', bdApproved.status === 200 && bdGrant.status === 'ACTIVE', { status: bdApproved.status, code: bdApproved.code });
  const bdRow = await sql('SELECT kind, market_country, display_name FROM business_accounts WHERE id = $1', [bdGrant.id]);
  report(
    'the territory the applicant wrote is stored for the operator to scope',
    bdRow.rows[0].kind === 'BD_MANAGER' && bdRow.rows[0].market_country === 'BD',
    bdRow.rows[0],
  );

  // ---------------------------------------------------------------------------
  // 7. an information request asks for one thing, not for the whole form again
  // ---------------------------------------------------------------------------
  const questionApplied = await apply(F, 'HOST', hostAnswers());
  const questionId = questionApplied.json.application.id;
  report('the account that was refused a country can file one once it is right', questionApplied.status === 201, questionApplied.status);
  const askNoNote = await api('POST', `/api/admin/partner-applications/${questionId}/request-info`, { token: reviewOps.token, body: {} });
  report('an operator cannot ask for more information without saying what', askNoNote.status === 400, askNoNote.status);
  const asked = await api('POST', `/api/admin/partner-applications/${questionId}/request-info`, {
    token: reviewOps.token,
    body: { note: 'Which rooms did you host last year?' },
  });
  report('the row waits on the applicant, with the question attached', asked.status === 200 && asked.json.application.status === 'INFO_REQUESTED', asked.json.application.infoRequestNote);
  const supplementAnswer = await api('POST', `/api/role-applications/${questionId}/supplement`, { token: F.token, body: { data: { experience: 'Two years of night rooms in Dhaka.' } } });
  report('answering one question sends the row back to the queue', supplementAnswer.status === 200 && supplementAnswer.json.application.status === 'PENDING', supplementAnswer.json.application.status);
  report(
    'and the answers already filed are kept: only what was asked for changed',
    supplementAnswer.json.application.data.fullName === hostAnswers().fullName && typeof supplementAnswer.json.application.data.ageConfirmed === 'boolean',
    supplementAnswer.json.application.data,
  );
  const supplementEarly = await api('POST', `/api/role-applications/${hostAppId}/supplement`, { token: A.token, body: { data: { city: 'Chattogram' } } });
  report('a row that is not waiting on the applicant refuses an answer', supplementEarly.status === 409 && supplementEarly.code === 'not_waiting_for_information', supplementEarly.code);
  const rejectNoNote = await api('POST', `/api/admin/partner-applications/${questionId}/reject`, { token: reviewOps.token, body: {} });
  report('a refusal without a reason is refused', rejectNoNote.status === 400, rejectNoNote.status);
  const rejected = await api('POST', `/api/admin/partner-applications/${questionId}/reject`, { token: reviewOps.token, body: { note: 'Not enough history to pay for a room.' } });
  report('the operator’s reason is stored on the row', rejected.status === 200 && rejected.json.application.status === 'REJECTED', rejected.json.application.decisionNote);
  const rejectedMine = await mine(F);
  report(
    'and the member reads that reason, in the answer’s own history',
    rejectedMine.applications.some((a) => a.id === questionId && a.decisionNote === 'Not enough history to pay for a room.'),
    rejectedMine.applications.map((a) => `${a.role}:${a.status}`),
  );
  const reviewReadDenied = await api('POST', `/api/admin/partner-applications/${reopened.json.application.id}/approve`, { token: readOps.token, body: {} });
  report('a finance operator still cannot mint a role after reading it first', reviewReadDenied.status === 403, reviewReadDenied.status);

  // ---------------------------------------------------------------------------
  // 8. the create-room gate is the switch it claims to be
  // ---------------------------------------------------------------------------
  await setConfig('roles.hostApplicationRequired', { enabled: true });
  const gateRead = await api('GET', '/api/admin/business/config/roles.hostApplicationRequired', { token: SUPER });
  report('the panel reads the switch back as it was written', gateRead.status === 200 && gateRead.json.value.enabled === true, gateRead.json.value);
  const deniedRoom = await api('POST', '/api/rooms', { token: E.token, body: { title: `e2e gate ${stamp}` } });
  report(
    'with the switch on, an account with no approved role cannot open a room',
    deniedRoom.status === 403 && deniedRoom.code === 'role_approval_required',
    { status: deniedRoom.status, code: deniedRoom.code },
  );
  const hostRoom = await api('POST', '/api/rooms', { token: A.token, body: { title: `e2e gate host ${stamp}` } });
  if (hostRoom.json && hostRoom.json.room) createdRooms.push({ id: hostRoom.json.room.id, token: A.token });
  report('an approved Host passes the same gate', hostRoom.status === 201, { status: hostRoom.status, code: hostRoom.code, message: hostRoom.message });
  // B's agency grant is revoked further down; while it is live it must satisfy the gate too.
  const agencyRoom = await api('POST', '/api/rooms', { token: B.token, body: { title: `e2e gate agency ${stamp}` } });
  if (agencyRoom.json && agencyRoom.json.room) createdRooms.push({ id: agencyRoom.json.room.id, token: B.token });
  report('and so does any other approved partner role — the gate is not a Host-only club', agencyRoom.status === 201, { status: agencyRoom.status, code: agencyRoom.code });

  // ---------------------------------------------------------------------------
  // 9. revoking stops the money paths the approval opened
  // ---------------------------------------------------------------------------
  const revokeNoReason = await api('POST', `/api/admin/partner-applications/${sellerAppId}/revoke`, { token: reviewOps.token, body: {} });
  report('a revocation without a reason is refused', revokeNoReason.status === 400, revokeNoReason.status);
  const sellerRevoked = await api('POST', `/api/admin/partner-applications/${sellerAppId}/revoke`, { token: reviewOps.token, body: { reason: 'e2e: the rails were not verifiable.' } });
  report('the grant is withdrawn, with the reason beside it', sellerRevoked.status === 200 && sellerRevoked.json.application.status === 'REVOKED', sellerRevoked.json.application.revokeReason);
  const suspendedSeller = await sql('SELECT status, suspended_reason FROM business_accounts WHERE id = $1', [sellerGrant.id]);
  report(
    'and the partner account is suspended, so its panel paths stop working',
    suspendedSeller.rows[0].status === 'SUSPENDED' && suspendedSeller.rows[0].suspended_reason === 'e2e: the rails were not verifiable.',
    suspendedSeller.rows[0],
  );
  const revokedMine = await mine(C);
  report('the member no longer holds the role', !revokedMine.activeRoles.includes('COIN_SELLER'), revokedMine.activeRoles);
  const applyAgain = await apply(C, 'COIN_SELLER', sellerAnswers());
  report('a revoked member may ask again — revocation is not a life ban', applyAgain.status === 201, { status: applyAgain.status, code: applyAgain.code });
  const revokeTwice = await api('POST', `/api/admin/partner-applications/${sellerAppId}/revoke`, { token: reviewOps.token, body: { reason: 'e2e: twice.' } });
  report('and cannot be revoked twice', revokeTwice.status === 409 && revokeTwice.code === 'grant_already_revoked', revokeTwice.code);
  const revokePending = await api('POST', `/api/admin/partner-applications/${applyAgain.json.application.id}/revoke`, { token: reviewOps.token, body: { reason: 'e2e: nothing was granted.' } });
  report('a row that granted nothing cannot be revoked', revokePending.status === 409 && revokePending.code === 'not_a_live_grant', revokePending.code);
  await api('POST', `/api/role-applications/${applyAgain.json.application.id}/cancel`, { token: C.token });

  const agencyRevoked = await api('POST', `/api/admin/partner-applications/${agencyAppId}/revoke`, { token: reviewOps.token, body: { reason: 'e2e: closing the roster.' } });
  const suspendedAgency = await sql('SELECT status FROM agencies WHERE id = $1', [grant(agencyRevoked.json.application).id]);
  report('revoking an agency suspends the agency, not merely the row', suspendedAgency.rows[0].status === 'SUSPENDED', suspendedAgency.rows[0]);
  const hostRevoked = await api('POST', `/api/admin/partner-applications/${hostAppId}/revoke`, { token: reviewOps.token, body: { reason: 'e2e: the run ends here.' } });
  const markerAfterRevoke = await sql('SELECT user_type FROM users WHERE id = $1', [A.id]);
  report(
    'a revoked Host loses the grant while the display marker stays — only the row is proof',
    hostRevoked.status === 200 && markerAfterRevoke.rows[0].user_type === 'HOST' && !(await mine(A)).activeRoles.includes('HOST'),
    { marker: markerAfterRevoke.rows[0].user_type, active: (await mine(A)).activeRoles },
  );
  const bdRevoked = await api('POST', `/api/admin/partner-applications/${bdAppId}/revoke`, { token: reviewOps.token, body: { reason: 'e2e: one office again.' } });
  report('the extra BD office is closed too', bdRevoked.status === 200, bdRevoked.status);
  const gateAfterRevoke = await api('POST', '/api/rooms', { token: A.token, body: { title: `e2e gate after ${stamp}` } });
  report('and with the switch still on, a revoked host is refused a room', gateAfterRevoke.status === 403 && gateAfterRevoke.code === 'role_approval_required', {
    status: gateAfterRevoke.status,
    code: gateAfterRevoke.code,
  });
  if (gateAfterRevoke.json && gateAfterRevoke.json.room) createdRooms.push({ id: gateAfterRevoke.json.room.id, token: A.token });

  // ---------------------------------------------------------------------------
  // 10. the audit trail carries both halves
  // ---------------------------------------------------------------------------
  // `admin_audit.target_id` is TEXT by design (migration 0003: it also names gift ids and room ids),
  // so the uuid list is cast to text rather than to uuid.
  const audit = await sql(
    "SELECT action, actor_system, admin_id, summary FROM admin_audit WHERE target_type = 'role_application' AND target_id = ANY($1::text[]) ORDER BY created_at",
    [[hostAppId, agencyAppId, sellerAppId, questionId]],
  );
  const actions = audit.rows.map((r) => r.action);
  report(
    'the submission is logged with no admin behind it',
    audit.rows.some((r) => r.action === 'ROLE_APPLICATION_SUBMIT' && r.admin_id === null && r.actor_system === 'partner-application'),
    actions,
  );
  report('every decision names the operator who made it', audit.rows.filter((r) => r.action.startsWith('ROLE_APPLICATION_APPROVE')).every((r) => r.admin_id === reviewOps.id), actions);
  report(
    'the whole life of one application reads back in order',
    actions.includes('ROLE_APPLICATION_SUBMIT') &&
      actions.includes('ROLE_APPLICATION_INFO_REQUEST') &&
      actions.includes('ROLE_APPLICATION_SUPPLEMENT') &&
      actions.includes('ROLE_APPLICATION_REJECT') &&
      actions.includes('ROLE_APPLICATION_REVOKE'),
    actions,
  );
  const queueShowsAudit = await detail(sellerAppId, SUPER);
  report('the panel reads the applicant beside the answers', queueShowsAudit.status === 200 && queueShowsAudit.json.application.applicant.username === C.username, queueShowsAudit.status);

  // ---------------------------------------------------------------------------
  // 11. put the development database back
  // ---------------------------------------------------------------------------
  // The same walk-out the failure path runs, so the checks below read the environment the next suite
  // will find rather than the one this suite borrowed.
  await RESTORE();
  const restored = await api('GET', '/api/rooms', { token: E.token });
  report('with the switch restored, an ordinary member reads the room list as before', restored.status === 200, restored.status);
  const gateOff = await sql("SELECT value FROM system_config WHERE key = 'roles.hostApplicationRequired'");
  report('and the gate is off again, not merely unread', gateOff.rows[0].value.enabled === false, gateOff.rows[0].value);
  const unblockedRoom = await api('POST', '/api/rooms', { token: E.token, body: { title: `e2e gate off ${stamp}` } });
  report('the gate is the switch, not a new permanent rule: an account with no grant hosts again', unblockedRoom.status === 201, {
    status: unblockedRoom.status,
    code: unblockedRoom.code,
  });
  const openEnded = await sql(
    "SELECT count(*)::int AS n FROM role_applications WHERE user_id = ANY($1::uuid[]) AND status IN ('PENDING','INFO_REQUESTED')",
    [accounts.map((a) => a.id)],
  );
  report('no application from this run is left waiting for an operator', openEnded.rows[0].n === 0, openEnded.rows[0]);
  const liveGrants = await sql(
    "SELECT count(*)::int AS n FROM role_applications WHERE user_id = ANY($1::uuid[]) AND status = 'APPROVED'",
    [accounts.map((a) => a.id)],
  );
  report('and this run leaves no account holding a partner role', liveGrants.rows[0].n === 0, liveGrants.rows[0]);
  if (unblockedRoom.json && unblockedRoom.json.room) {
    await api('POST', `/api/rooms/${unblockedRoom.json.room.id}/close`, { token: E.token });
  }
  await db().end();

  console.log(out.join('\n'));
  console.log(`\n${out.length - failed}/${out.length} partner checks passed${failed ? ` — ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  await walkOut();
  console.log(out.join('\n'));
  console.log(`\nFAIL  suite threw :: ${err && err.stack ? err.stack : err}`);
  await db().end().catch(() => {});
  process.exit(1);
});
