/* Live end-to-end for the social graph and the room-community controls (migration 0022).
   `e2e-live.cjs` covers the money path and the room lifecycle; this suite drives the half that
   only exists once accounts can follow, block, report, queue for a microphone and hand a room over.

     1. boot Postgres, Redis, LiveKit and the API (see README)
     2. node scripts/social-e2e.cjs

   It creates throwaway accounts and one throwaway room, each named with a time stamp, so run it
   against a development database only. Override the target with E2E_API_URL and the operator
   credentials with E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD. */
const BASE = process.env.E2E_API_URL
  ? `${process.env.E2E_API_URL.replace(/\/$/, '')}/api`
  : 'http://127.0.0.1:4000/api';
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD || 'voiza-admin';
// The code the backend answers with while OTP_MOCK_CODE is set.
const OTP = process.env.E2E_OTP || '123456';

const out = [];
const check = (name, ok, detail) => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  if (!ok) process.exitCode = 1;
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

/** Errors answer as `{ error: { code, message } }`; the code is what each assertion cares about. */
const code = (r) => r.json?.error?.code;
/** Seats come back as a sparse list of DTOs, so find the seat by index rather than by position. */
const seat = (list, index) => (list ?? []).find((s) => s.seatIndex === index);

async function signUp(phone, username) {
  const r = await call('POST', '/auth/request-otp', { body: { phone } });
  if (r.status !== 200) throw new Error(`request-otp failed for ${phone}: ${JSON.stringify(r.json)}`);
  const v = await call('POST', '/auth/verify-otp', { body: { phone, code: OTP, username } });
  if (v.status !== 200) throw new Error(`verify-otp failed for ${phone}: ${JSON.stringify(v.json)}`);
  return v.json;
}

(async () => {
  const stamp = Date.now().toString().slice(-7);
  const a = await signUp(`+1555${stamp}01`, `social_a_${stamp}`);
  const b = await signUp(`+1555${stamp}02`, `social_b_${stamp}`);
  const c = await signUp(`+1555${stamp}03`, `social_c_${stamp}`);
  const [A, B, C] = [a.token, b.token, c.token];
  check('signup: three accounts exist', Boolean(A && B && C));

  // --- follows --------------------------------------------------------------
  const follow = await call('POST', `/users/${b.user.id}/follow`, { token: A });
  check('follow: counts move on both sides of the edge',
    follow.status === 200 && follow.json.following === true && follow.json.counts.following === 1, follow.json?.counts);

  const again = await call('POST', `/users/${b.user.id}/follow`, { token: A });
  check('follow: a repeat tap is a no-op, not a second edge', again.status === 200 && again.json.counts.following === 1, again.json?.counts);

  const rel = await call('GET', `/users/${b.user.id}/relationship`, { token: A });
  check('relationship: the caller is following, nothing is blocked',
    rel.json?.following === true && rel.json?.interactionBlocked === false, rel.json);

  const list = await call('GET', `/users/${b.user.id}/followers?page=1&limit=10`, { token: B });
  check('followers: the reverse direction is indexed and readable', list.json?.users?.some((u) => u.id === a.user.id), list.json?.total);

  const selfFollow = await call('POST', `/users/${a.user.id}/follow`, { token: A });
  check('follow: yourself is refused', selfFollow.status === 400, code(selfFollow));

  // --- blocks ---------------------------------------------------------------
  const block = await call('POST', `/users/${c.user.id}/block`, { token: A, body: { reason: 'suite' } });
  check('block: written once, counted once', block.status === 200 && block.json.counts.blocked === 1, block.json?.counts);

  const blockedFollow = await call('POST', `/users/${a.user.id}/follow`, { token: C });
  check('block: read symmetrically — the blocked side cannot follow back',
    blockedFollow.status === 403 && code(blockedFollow) === 'interaction_blocked', code(blockedFollow));

  const blockedGift = await call('POST', '/gifts/send', { token: C, body: { receiverId: a.user.id, giftId: '00000000-0000-0000-0000-000000000000', quantity: 1 } });
  check('block: the money path refuses before it touches a balance',
    blockedGift.status === 403 && code(blockedGift) === 'interaction_blocked', code(blockedGift));

  const blockedReport = await call('POST', `/users/${a.user.id}/report`, { token: C, body: { reason: 'SPAM' } });
  check('block: the moderation channel stays open to the blocked member', blockedReport.status === 201, code(blockedReport));

  const blockedProfile = await call('GET', `/users/${a.user.id}`, { token: C });
  check('block: a profile is still readable — a block is not an invisibility cloak', blockedProfile.status === 200);

  const unblock = await call('DELETE', `/users/${c.user.id}/block`, { token: A });
  check('unblock: the edge is gone, the counts follow', unblock.status === 200 && unblock.json.counts.blocked === 0, unblock.json?.counts);

  // --- reports + the operator queue ----------------------------------------
  const rep = await call('POST', `/users/${a.user.id}/report`, { token: B, body: { reason: 'HARASSMENT', details: 'suite' } });
  check('report: filed as PENDING', rep.status === 201 && rep.json.report.status === 'PENDING', rep.json?.report?.status);

  const dup = await call('POST', `/users/${a.user.id}/report`, { token: B, body: { reason: 'SPAM' } });
  check('report: one open report per pair, a repeat tap is a 409', dup.status === 409 && code(dup) === 'report_already_open', code(dup));

  const badReason = await call('POST', `/users/${a.user.id}/report`, { token: C, body: { reason: 'NOT_A_REASON' } });
  check('report: a reason outside the vocabulary is a 400', badReason.status === 400, code(badReason));

  const selfReport = await call('POST', `/users/${a.user.id}/report`, { token: A, body: { reason: 'SPAM' } });
  check('report: yourself is refused', selfReport.status === 400, code(selfReport));

  const login = await call('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
  const adminToken = login.json?.token;
  check('admin: the operator signs in', login.status === 200 && Boolean(adminToken));

  const queue = await call('GET', '/admin/reports?status=PENDING&limit=50', { token: adminToken });
  const mine = (queue.json?.reports ?? []).find((r) => r.id === rep.json.report.id);
  check('admin: the queue lists the report with both parties resolved',
    Boolean(mine) && mine.target.username === a.user.username && mine.reporter.username === b.user.username, queue.json?.total);

  const review = await call('POST', `/admin/reports/${rep.json.report.id}/review`, {
    token: adminToken,
    body: { decision: 'ACTIONED', resolution: 'suite: warned' },
  });
  check('admin: a decision closes the report and bans nothing on its own',
    review.status === 200 && review.json.report.status === 'ACTIONED' && review.json.banned === false, review.json?.report?.status);

  const dismissBan = await call('POST', `/admin/reports/${rep.json.report.id}/review`, {
    token: adminToken,
    body: { decision: 'DISMISSED', banUser: true },
  });
  check('admin: DISMISSED cannot carry a ban', dismissBan.status === 409 || dismissBan.status === 400, code(dismissBan));

  const reopened = await call('POST', `/users/${a.user.id}/report`, { token: B, body: { reason: 'SPAM' } });
  check('report: a decided pair can report again (the partial index only covers PENDING)', reopened.status === 201, code(reopened));

  const social = await call('GET', `/admin/users/${a.user.id}/social`, { token: adminToken });
  check('admin: the social summary shows both directions of reports',
    social.status === 200 && social.json.reportsAgainst?.length >= 2, social.json?.counts);

  const anonQueue = await call('GET', '/admin/reports');
  check('admin: the queue is not a public endpoint', anonQueue.status === 401);

  // --- room community -------------------------------------------------------
  const room = await call('POST', '/rooms', { token: A, body: { title: `Social suite ${stamp}`, category: 'PARTY' } });
  const roomId = room.json?.room?.id;
  check('room: the host opens a room', room.status === 201 && Boolean(roomId), code(room));

  await call('POST', `/rooms/${roomId}/join`, { token: B });
  await call('POST', `/rooms/${roomId}/join`, { token: C });

  const announce = await call('POST', `/rooms/${roomId}/announcement`, { token: A, body: { announcement: 'Mic check at 9' } });
  check('announcement: a host pins a notice', announce.status === 200 && announce.json.room.announcement === 'Mic check at 9', announce.json?.room?.announcementUpdatedAt);

  const announceTooLong = await call('POST', `/rooms/${roomId}/announcement`, { token: A, body: { announcement: 'x'.repeat(301) } });
  check('announcement: 301 characters is a 400, not a silent truncation', announceTooLong.status === 400, code(announceTooLong));

  const nonHostAnnounce = await call('POST', `/rooms/${roomId}/announcement`, { token: B, body: { announcement: 'not mine' } });
  check('announcement: only the host owns the banner', nonHostAnnounce.status === 403, code(nonHostAnnounce));

  const openSeat = await call('POST', `/rooms/${roomId}/seat`, { token: B, body: { seatIndex: 2 } });
  check('seat: tap-to-sit still works while approval is off (the default)',
    openSeat.status === 200 && seat(openSeat.json.seats, 2)?.user?.id === b.user.id, code(openSeat));

  await call('POST', `/rooms/${roomId}/seat/2/leave`, { token: B });
  const approval = await call('PATCH', `/rooms/${roomId}`, { token: A, body: { speakerApprovalRequired: true } });
  check('seat: the host turns approval on for this room only',
    approval.status === 200 && approval.json.room.speakerApprovalRequired === true, code(approval));

  const asked = await call('POST', `/rooms/${roomId}/seat`, { token: B, body: { seatIndex: 3 } });
  check('seat: with approval on, the same call is a 202 and a queued request',
    asked.status === 202 && asked.json.requested === true && asked.json.request.status === 'PENDING', asked.json?.request?.seatIndex);

  const askedTwice = await call('POST', `/rooms/${roomId}/seat`, { token: B, body: { seatIndex: 4 } });
  check('seat: a second tap reuses the open request instead of queueing twice', askedTwice.status === 202, askedTwice.json?.request?.id);

  const hostSeat = await call('POST', `/rooms/${roomId}/seat`, { token: C, body: { seatIndex: 0 } });
  check('seat: the host seat is never requestable', hostSeat.status === 403, code(hostSeat));

  const queueRoom = await call('GET', `/rooms/${roomId}/speaker-requests`, { token: A });
  const req0 = (queueRoom.json?.requests ?? [])[0];
  check('seat: the queue names the requester by their own id, not the request id',
    queueRoom.status === 200 && req0?.user?.id === b.user.id && req0.id !== b.user.id, queueRoom.json?.requests?.length);

  const peekQueue = await call('GET', `/rooms/${roomId}/speaker-requests`, { token: B });
  check('seat: a listener cannot read the queue', peekQueue.status === 403, code(peekQueue));

  const approved = await call('POST', `/rooms/${roomId}/speaker-requests/${req0.id}/approve`, { token: A });
  check('seat: approval seats the member in the seat they asked for',
    approved.status === 200 && approved.json.request.status === 'APPROVED' && seat(approved.json.seats, req0.seatIndex)?.user?.id === b.user.id,
    code(approved));

  const decideAgain = await call('POST', `/rooms/${roomId}/speaker-requests/${req0.id}/approve`, { token: A });
  check('seat: a decided request cannot be decided again', decideAgain.status === 409, code(decideAgain));

  await call('POST', `/rooms/${roomId}/seat/${req0.seatIndex}/leave`, { token: B });
  const invite = await call('POST', `/rooms/${roomId}/seat/5/invite`, { token: A, body: { userId: b.user.id } });
  check('seat: the host can seat a listener without a request', invite.status === 200 && seat(invite.json.seats, 5)?.user?.id === b.user.id, code(invite));

  const rejectFlow = await call('POST', `/rooms/${roomId}/seat`, { token: C, body: { seatIndex: 6 } });
  const reject = await call('POST', `/rooms/${roomId}/speaker-requests/${rejectFlow.json?.request?.id}/reject`, { token: A });
  check('seat: a rejection is recorded with who decided', reject.status === 200 && reject.json.request.status === 'REJECTED', code(reject));

  const notHostApprove = await call('POST', `/rooms/${roomId}/speaker-requests/${rejectFlow.json?.request?.id}/approve`, { token: C });
  check('seat: only the host decides', notHostApprove.status === 403, code(notHostApprove));

  const cancel = await call('POST', `/rooms/${roomId}/seat`, { token: C, body: { seatIndex: 7 } });
  const cancelled = await call('POST', `/rooms/${roomId}/speaker-requests/cancel`, { token: C });
  const afterCancel = await call('GET', `/rooms/${roomId}/speaker-requests`, { token: A });
  check('seat: the member can withdraw their own request',
    cancel.status === 202 && cancelled.status === 200 && cancelled.json.cancelled === 1 && (afterCancel.json?.requests ?? []).length === 0,
    cancelled.json);

  const off = await call('PATCH', `/rooms/${roomId}`, { token: A, body: { speakerApprovalRequired: false } });
  await call('POST', `/rooms/${roomId}/seat/5/leave`, { token: B });
  const afterOff = await call('POST', `/rooms/${roomId}/seat`, { token: B, body: { seatIndex: 1 } });
  check('seat: turning approval off returns this room to tap-to-sit',
    off.status === 200 && afterOff.status === 200 && seat(afterOff.json.seats, 1)?.user?.id === b.user.id, code(afterOff));

  // --- favorites ------------------------------------------------------------
  const fav = await call('POST', `/rooms/${roomId}/favorite`, { token: B });
  check('favorites: a saved room', fav.status === 200 && fav.json.favorited === true, fav.json);

  const favList = await call('GET', '/rooms/favorites', { token: B });
  check('favorites: the list is about the caller, not the room', (favList.json?.rooms ?? []).some((r) => r.id === roomId), favList.json?.rooms?.length);

  const unfav = await call('DELETE', `/rooms/${roomId}/favorite`, { token: B });
  const favList2 = await call('GET', '/rooms/favorites', { token: B });
  check('favorites: un-saving removes it', unfav.status === 200 && !(favList2.json?.rooms ?? []).some((r) => r.id === roomId));

  // --- ownership transfer ---------------------------------------------------
  // d never joins, so this is a genuine "target is absent" case rather than an ordering artifact.
  const d = await signUp(`+1555${stamp}04`, `social_d_${stamp}`);
  const absentTransfer = await call('POST', `/rooms/${roomId}/transfer`, { token: A, body: { userId: d.user.id } });
  check('transfer: an absent member cannot be handed a live room', absentTransfer.status === 400 && code(absentTransfer) === 'not_in_room', code(absentTransfer));

  const selfTransfer = await call('POST', `/rooms/${roomId}/transfer`, { token: A, body: { userId: a.user.id } });
  check('transfer: to yourself is refused', selfTransfer.status === 400, code(selfTransfer));

  const transfer = await call('POST', `/rooms/${roomId}/transfer`, { token: A, body: { userId: b.user.id, note: 'brb' } });
  check('transfer: the room changes hands',
    transfer.status === 200 && transfer.json.room.host?.id === b.user.id && transfer.json.previousHostId === a.user.id, code(transfer));

  const detail = await call('GET', `/rooms/${roomId}`, { token: A });
  check('transfer: the new host owns seat 0',
    detail.json?.room?.host?.id === b.user.id && seat(detail.json?.seats, 0)?.user?.id === b.user.id, seat(detail.json?.seats, 0)?.user?.username);

  const oldHostModerates = await call('POST', `/rooms/${roomId}/announcement`, { token: A, body: { announcement: 'no longer mine' } });
  check('transfer: the previous host loses every control', oldHostModerates.status === 403, code(oldHostModerates));

  const clear = await call('POST', `/rooms/${roomId}/announcement`, { token: B, body: { announcement: null } });
  check('transfer: the new host owns the notice and can clear it', clear.status === 200 && clear.json.room.announcement === null, clear.json?.room?.announcement);

  const history = await call('GET', `/users/${b.user.id}/relationship`, { token: A });
  check('transfer: the graph is untouched by a room changing hands', history.status === 200 && history.json?.following === true, history.json);

  await call('DELETE', `/rooms/${roomId}`, { token: B });

  console.log(out.join('\n'));
  const failed = out.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${out.length - failed}/${out.length} live social checks passed`);
})().catch((err) => {
  console.log(out.join('\n'));
  console.error('\nSUITE ABORTED:', err.message);
  process.exit(1);
});
