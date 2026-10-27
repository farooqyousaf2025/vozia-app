/* End-to-end tests for the game engine and its money (§7, §8). Drives a *running* backend over
   HTTP against real PostgreSQL and asserts on database state through the backend's own pg pool.

     1. boot the stack and the API (README / docker-compose.yml), then `npm run build`
     2. node scripts/games-e2e.cjs

   The suite opens and closes real matches, plays the moves a player would play, and only ever
   changes TIC_TAC_TOE's rules from the admin API — the definition is left in the shipped
   free-to-play posture so the run is repeatable. Development database only. */
const path = require('path');
const crypto = require('crypto');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');
const SOCKET_IO = path.join(BE_ROOT, 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_development_only_not_a_real_secret';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const out = [];
const check = (n, p, d) => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? `  :: ${JSON.stringify(d).slice(0, 240)}` : ''}`);
/** An API error's code, or null when the response was not an ApiError — a suite that throws on a
    200 hides every check after it, so the assertion that a refusal happened must survive the success. */
const codeOf = (res) => (res && res.json && res.json.error && res.json.error.code) || null;

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
const scalar = async (q) => {
  const r = await sql(q);
  return r.rows.length ? Object.values(r.rows[0]).join('|') : null;
};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

/** The same signed provider webhook the payments suite uses — the only door that mints diamonds. */
function sign(payload, at = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${at}.${payload}`).digest('hex');
  return `t=${at},v1=${mac}`;
}

async function fund(userId, diamonds) {
  const payload = JSON.stringify({
    id: `evt_g_${userId.slice(0, 8)}_${diamonds}_${Date.now()}`,
    type: 'payment_intent.succeeded',
    data: { object: { id: `pi_g_${crypto.randomUUID()}`, status: 'succeeded', metadata: { voizaUserId: userId, diamonds: String(diamonds) } } },
  });
  const res = await fetch(`${API}/api/payments/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    body: payload,
  });
  return res.status;
}

const stamp = Date.now().toString().slice(-7);
const balance = async (id) => Number(await scalar(`select diamond_balance from users where id = '${id}'`));

let userSeq = 0;
async function makeUser(label) {
  userSeq += 1;
  // The phone is digits only: the auth service strips anything else, so a letter suffix
  // would silently collapse two test players into one account.
  const phone = `+15558${stamp}${String(userSeq).padStart(2, '0')}`;
  const otp = await api('POST', '/api/auth/request-otp', { body: { phone } });
  const verified = await api('POST', '/api/auth/verify-otp', { body: { phone, code: otp.json && otp.json.devCode, username: `e2e_${label}_${stamp.slice(-4)}_${userSeq}` } });
  return { id: verified.json.user.id, token: verified.json.token, phone, label };
}

/** Play host's winning line 0-1-2 on an empty board; the guest takes 3 and 4, which pairs
    into nothing. Returns the response to the move that ends the match. */
async function playToHostWin(host, guest, sessionId) {
  await api('POST', `/api/games/${sessionId}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 0 } } });
  await api('POST', `/api/games/${sessionId}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 3 } } });
  await api('POST', `/api/games/${sessionId}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 1 } } });
  await api('POST', `/api/games/${sessionId}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 4 } } });
  return api('POST', `/api/games/${sessionId}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 2 } } });
}

/** What migration 0001 seeds: switched off, fee-free, prize-free. The suite puts the row back
    here both before and after itself — a run that crashed half way would otherwise leave a paid
    game live in the development database, and the launch-posture checks are about what the API
    offers a player, not about the last run's leftovers. */
const SHIPPED = `is_active = false, entry_fee_enabled = false, entry_fee_diamonds = 0, entry_fee_min = 0,
  entry_fee_max = 0, prize_enabled = false, commission_bps = 0, refund_policy = 'CANCELLED',
  promo_free_entry = false, promo_until = NULL, daily_entry_limit = 50,
  prize_rules = '[{"rank":1,"share_bps":10000}]'::jsonb`;
const resetShipped = () => sql(`update game_definitions set ${SHIPPED} where key in ('TIC_TAC_TOE','QUIZ_BATTLE','LUDO')`);

(async () => {
  await resetShipped();
  const adminLogin = await api('POST', '/api/auth/verify-otp', { body: { phone: '+10000000000', code: '424242' } });
  const admin = adminLogin.json && adminLogin.json.token;
  check('rbac: the bootstrap OTP mints an operator token', adminLogin.status === 200 && !!admin, { status: adminLogin.status });

  const baseline = (await sql(
    `select entry_fee_enabled, entry_fee_diamonds, entry_fee_min, entry_fee_max, prize_enabled, commission_bps,
            is_active, daily_entry_limit, rules_version, prize_rules::text rules
       from game_definitions where key = 'TIC_TAC_TOE'`,
  )).rows[0];
  // Earlier runs leave their ledger behind, so "no money moved" is measured from here.
  const moneyRowsBefore = Number(await scalar(`select count(*) from transactions where type in ('GAME_ENTRY','GAME_PRIZE','GAME_REFUND','PLATFORM_COMMISSION')`));

  // ---- A. the shipped posture is free-to-play, and only an operator can change it ----
  const catalog = await api('GET', '/api/games', {});
  const listed = (catalog.json && catalog.json.games) || [];
  check('compliance: nothing that costs money is offered at launch',
    catalog.status === 200 && listed.every((g) => !g.entryFeeEnabled && !g.prizeEnabled && g.entryFeeMax === 0),
    { games: listed.map((g) => `${g.key}:${g.isActive}:fee${g.entryFeeDiamonds}`) });
  check('compliance: every game ships switched off until an operator opens it', listed.length === 0, { count: listed.length });

  const host = await makeUser('h');
  const guest = await makeUser('g');
  const spectator = await makeUser('s');
  check('fixture: the three players are three separate accounts',
    new Set([host.id, guest.id, spectator.id]).size === 3,
    { host: host.id, guest: guest.id, spectator: spectator.id });

  const userEditsRules = await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', { token: host.token, body: { isActive: true } });
  check('rbac: an ordinary user cannot edit game rules', userEditsRules.status === 403 || userEditsRules.status === 401, { status: userEditsRules.status });

  const room = await api('POST', '/api/rooms', { token: host.token, body: { title: `E2E Games ${stamp}`, category: 'CHAT', type: 'PUBLIC', seatCapacity: 4 } });
  const roomId = room.json && room.json.room && room.json.room.id;
  check('room: a room exists to host the matches in', room.status === 201 && !!roomId, { status: room.status });

  const tooEarly = await api('POST', '/api/games', { token: host.token, body: { gameKey: 'TIC_TAC_TOE', roomId } });
  check('rules: a disabled game cannot be opened', tooEarly.status === 403 && codeOf(tooEarly) === 'game_disabled', { status: tooEarly.status, code: codeOf(tooEarly) });

  const paidWithoutReview = await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', {
    token: admin, body: { entryFeeEnabled: true, entryFeeMax: 500, prizeEnabled: true },
  });
  check('compliance: switching on money needs an explicit compliance decision',
    paidWithoutReview.status === 403 && codeOf(paidWithoutReview) === 'compliance_unconfirmed',
    { status: paidWithoutReview.status, code: codeOf(paidWithoutReview) });

  const noMoneyMoved = await scalar(`select count(*) from transactions where type in ('GAME_ENTRY','GAME_PRIZE','GAME_REFUND','PLATFORM_COMMISSION')`);
  check('compliance: a refused switch moved no money', Number(noMoneyMoved) === moneyRowsBefore, { before: moneyRowsBefore, after: noMoneyMoved });

  const opened = await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', { token: admin, body: { isActive: true } });
  check('rules: an operator can open the free-to-play game', opened.status === 200 && opened.json.game.isActive === true, { status: opened.status });

  // ---- B. the lobby, and who is allowed to do what in it ----
  const session = await api('POST', '/api/games', { token: host.token, body: { gameKey: 'TIC_TAC_TOE', roomId } });
  const sid = session.json && session.json.session && session.json.session.id;
  check('engine: a free match opens in WAITING with no fee pinned',
    session.status === 201 && session.json.session.status === 'WAITING' && session.json.session.entryFeeDiamonds === 0,
    { status: session.json && session.json.session.status, fee: session.json && session.json.session.entryFeeDiamonds });

  const wrongHost = await api('POST', '/api/games', { token: guest.token, body: { gameKey: 'TIC_TAC_TOE', roomId } });
  check('engine: only the room host can open a game', wrongHost.status === 403 && codeOf(wrongHost) === 'not_room_host', { code: codeOf(wrongHost) });

  const joined = await api('POST', `/api/games/${sid}/join`, { token: guest.token, body: {} });
  const rejoin = await api('POST', `/api/games/${sid}/join`, { token: guest.token, body: {} });
  const overflow = await api('POST', `/api/games/${sid}/join`, { token: spectator.token, body: {} });
  check('seats: a second seat is taken once, and a third is refused',
    joined.status === 200 && rejoin.status === 409 && codeOf(rejoin) === 'already_joined' && overflow.status === 409 && codeOf(overflow) === 'game_full',
    { join: joined.status, again: rejoin.status, third: overflow.status });
  check('engine: two seated players make the match READY', joined.json.session.status === 'READY', { status: joined.json && joined.json.session.status });

  const notReady = await api('POST', `/api/games/${sid}/start`, { token: host.token, body: {} });
  check('engine: nobody is dealt a board before every player is ready',
    notReady.status === 409 && codeOf(notReady) === 'players_not_ready', { code: codeOf(notReady) });

  const guestStarts = await api('POST', `/api/games/${sid}/start`, { token: guest.token, body: {} });
  check('engine: a player cannot start a match they did not open',
    guestStarts.status === 403 && codeOf(guestStarts) === 'not_match_host', { code: codeOf(guestStarts) });

  await api('POST', `/api/games/${sid}/ready`, { token: guest.token, body: {} });
  const started = await api('POST', `/api/games/${sid}/start`, { token: host.token, body: {} });
  const board = started.json && started.json.session;
  check('engine: the server deals the board and names the first mover',
    started.status === 200 && board.status === 'IN_PROGRESS' && board.turnOwnerId === host.id && board.state.grid.every((c) => c === null),
    { status: board && board.status, turnOwner: board && board.turnOwnerId === host.id });

  // ---- C. nothing a client sends can decide the game ----
  const outOfTurn = await api('POST', `/api/games/${sid}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 8 } } });
  check('authority: a move out of turn is refused', outOfTurn.status === 400 && codeOf(outOfTurn) === 'out_of_turn', { code: codeOf(outOfTurn) });

  const outsider = await api('POST', `/api/games/${sid}/action`, { token: spectator.token, body: { type: 'MOVE', payload: { cell: 8 } } });
  check('authority: a player of another match cannot move this board', outsider.status === 403 && codeOf(outsider) === 'not_a_player', { code: codeOf(outsider) });

  const forged = await api('POST', `/api/games/${sid}/action`, {
    token: host.token,
    body: { type: 'MOVE', payload: { cell: 0, winner: host.id, score: 9999, diamonds: 999999, settlementStatus: 'SETTLED', balance: 0 } },
  });
  const forgedBoard = forged.json && forged.json.session;
  check('authority: a body that claims a winner, a score or a balance is ignored',
    forged.status === 200 && forgedBoard.status === 'IN_PROGRESS' && forgedBoard.state.grid[0] === 0 && forgedBoard.state.winnerPosition === null,
    { grid: forgedBoard && forgedBoard.state.grid, winner: forgedBoard && forgedBoard.state.winnerPosition });

  const badCell = await api('POST', `/api/games/${sid}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 42 } } });
  const takenCell = await api('POST', `/api/games/${sid}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 0 } } });
  const weirdAction = await api('POST', `/api/games/${sid}/action`, { token: guest.token, body: { type: 'CLAIM_VICTORY', payload: {} } });
  check('authority: the driver validates the cell and the verb',
    badCell.status === 400 && codeOf(badCell) === 'bad_cell' && takenCell.status === 400 && codeOf(takenCell) === 'cell_taken' && weirdAction.status === 400 && codeOf(weirdAction) === 'unknown_action',
    { badCell: codeOf(badCell), taken: codeOf(takenCell), verb: codeOf(weirdAction) });

  // ---- D. the win is the engine's, and it settles exactly once ----
  // Host already owns cell 0 (the forged move above was a legal play of cell 0), so the
  // line 0-1-2 is finished here while the guest takes 3 and 5.
  const awaitMore = await api('POST', `/api/games/${sid}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 3 } } });
  const mid = await api('POST', `/api/games/${sid}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 1 } } });
  await api('POST', `/api/games/${sid}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 5 } } });
  const won = await api('POST', `/api/games/${sid}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 2 } } });
  const done = won.json && won.json.session;
  check('engine: the third in a line ends the match and the server owns the result',
    awaitMore.status === 200 && mid.status === 200 && won.status === 200 && done.status === 'COMPLETED' && done.settlementStatus === 'SETTLED',
    { status: done && done.status, settlement: done && done.settlementStatus });

  const settleRows = Number(await scalar(`select count(*) from game_settlements where session_id = '${sid}'`));
  const freePool = (await sql(`select gross_pool, commission, prize_pool, distributed from game_settlements where session_id = '${sid}'`)).rows[0];
  check('settlement: a free match settles once and pays nothing',
    settleRows === 1 && Number(freePool.gross_pool) === 0 && Number(freePool.distributed) === 0,
    { rows: settleRows, freePool });
  check('settlement: a free match writes no entry or prize rows',
    Number(await scalar(`select count(*) from transactions where game_session_id = '${sid}'`)) === 0);

  const afterWin = await api('POST', `/api/games/${sid}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 6 } } });
  const reread = await api('GET', `/api/games/${sid}`, { token: host.token });
  check('settlement: a finished board refuses further moves and a re-read does not re-settle',
    afterWin.status === 409 && codeOf(afterWin) === 'game_not_running' && reread.json.session.status === 'COMPLETED' &&
      Number(await scalar(`select count(*) from game_settlements where session_id = '${sid}'`)) === 1,
    { move: afterWin.status, code: codeOf(afterWin) });

  // ---- E. three clients submitting the same final move at once ----
  const raceSession = await api('POST', '/api/games', { token: host.token, body: { gameKey: 'TIC_TAC_TOE', roomId } });
  const raceId = raceSession.json.session.id;
  await api('POST', `/api/games/${raceId}/join`, { token: guest.token, body: {} });
  await api('POST', `/api/games/${raceId}/ready`, { token: guest.token, body: {} });
  await api('POST', `/api/games/${raceId}/start`, { token: host.token, body: {} });
  await api('POST', `/api/games/${raceId}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 0 } } });
  await api('POST', `/api/games/${raceId}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 3 } } });
  await api('POST', `/api/games/${raceId}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 1 } } });
  await api('POST', `/api/games/${raceId}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 5 } } });
  const simultaneous = await Promise.all([
    api('POST', `/api/games/${raceId}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 2 } } }),
    api('POST', `/api/games/${raceId}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 2 } } }),
    api('POST', `/api/games/${raceId}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 2 } } }),
    api('POST', `/api/games/${raceId}/cancel`, { token: host.token, body: { reason: 'a retried cancel that must not refund a finished match' } }),
  ]);
  const raceSettlements = Number(await scalar(`select count(*) from game_settlements where session_id = '${raceId}'`));
  const raceWins = simultaneous.filter((r) => r.status === 200).length;
  check('concurrency: the same final move from three clients settles the match once',
    raceSettlements === 1 && raceWins === 1 && simultaneous[3].status === 409,
    { settlements: raceSettlements, ok: raceWins, statuses: simultaneous.map((r) => r.status) });

  // ---- F. paid entry: the ladder, the rounding, and the cut ----
  const paidRules = await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', {
    token: admin,
    body: {
      entryFeeEnabled: true, entryFeeMin: 10, entryFeeMax: 500, entryFeeDiamonds: 101,
      prizeEnabled: true, commissionBps: 50,
      prizeRules: [{ rank: 1, shareBps: 7000 }, { rank: 2, shareBps: 3000 }],
      confirmCompliance: true,
    },
  });
  const rules = paidRules.json && paidRules.json.game;
  check('compliance: a confirmed decision opens the paid rules, versioned',
    paidRules.status === 200 && paidRules.json.rulesChanged === true && Number(rules.rulesVersion) === Number(baseline.rules_version) + 1,
    { status: paidRules.status, from: baseline.rules_version, version: rules && rules.rulesVersion });

  const tooCheap = await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', { token: admin, body: { entryFeeDiamonds: 5, confirmCompliance: true } });
  const tooDear = await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', { token: admin, body: { entryFeeDiamonds: 900, confirmCompliance: true } });
  check('rules: the fee the operator sets must sit inside the band the operator set',
    tooCheap.status === 400 && codeOf(tooCheap) === 'fee_out_of_range' && tooDear.status === 400 && codeOf(tooDear) === 'fee_out_of_range',
    { low: codeOf(tooCheap), high: codeOf(tooDear) });

  await fund(host.id, 2000);
  await fund(guest.id, 2000);

  const beforeHost = await balance(host.id);
  const beforeGuest = await balance(guest.id);
  const paidSession = await api('POST', '/api/games', { token: host.token, body: { gameKey: 'TIC_TAC_TOE', roomId } });
  const pid = paidSession.json.session.id;
  check('entry: the host pays the pinned fee when the match opens',
    paidSession.status === 201 && paidSession.json.session.entryFeeDiamonds === 101 && (await balance(host.id)) === beforeHost - 101,
    { fee: paidSession.json.session.entryFeeDiamonds, delta: beforeHost - (await balance(host.id)) });

  await api('POST', `/api/games/${pid}/join`, { token: guest.token, body: {} });
  await api('POST', `/api/games/${pid}/ready`, { token: guest.token, body: {} });
  await api('POST', `/api/games/${pid}/start`, { token: host.token, body: {} });
  const paid = await playToHostWin(host, guest, pid);
  const paidDone = paid.json.session;
  check('engine: the paid match ends the same way the free one did', paidDone.status === 'COMPLETED', { status: paidDone.status });

  const book = (await sql(
    `select gross_pool, commission, prize_pool, deductions, distributed, payouts::text payouts
       from game_settlements where session_id = '${pid}'`,
  )).rows[0];
  const payouts = JSON.parse(book.payouts);
  const winnerRow = payouts.find((p) => p.userId === host.id);
  const loserRow = payouts.find((p) => p.userId === guest.id);
  const pool = Number(book.gross_pool);
  check('settlement: the pool, the cut and the ladder are the same numbers',
    Number(book.distributed) === Number(book.prize_pool) && pool === 202 && Number(book.commission) === 1 && Number(book.prize_pool) === 201,
    { book: { pool, commission: book.commission, prizePool: book.prize_pool, distributed: book.distributed } });
  check('rounding: an indivisible prize pool favours the top rank and loses nothing',
    payouts.length === 2 && winnerRow.diamonds + loserRow.diamonds === 201 && winnerRow.diamonds === 141 && loserRow.diamonds === 60 && winnerRow.rank === 1,
    { payouts: payouts.map((p) => `${p.rank}:${p.diamonds}`) });
  check('settlement: every diamond of the pool is accounted for',
    payouts.reduce((s, p) => s + p.diamonds, 0) + Number(book.commission) + Number(book.deductions) === pool,
    { distributed: payouts.reduce((s, p) => s + p.diamonds, 0), commission: Number(book.commission), pool });

  const afterHostPaid = await balance(host.id);
  const afterGuestPaid = await balance(guest.id);
  check('wallet: the winner nets the prize less the fee, and the loser keeps the difference',
    afterHostPaid === beforeHost - 101 + 141 && afterGuestPaid === beforeGuest - 101 + 60,
    { host: afterHostPaid - beforeHost, guest: afterGuestPaid - beforeGuest });

  const entries = Number(await scalar(`select count(*) from transactions where type = 'GAME_ENTRY' and game_session_id = '${pid}'`));
  const prizes = Number(await scalar(`select count(*) from transactions where type = 'GAME_PRIZE' and game_session_id = '${pid}'`));
  const cut = (await sql(`select count(*) n, coalesce(sum(amount_diamonds),0) s from transactions where type = 'PLATFORM_COMMISSION' and game_session_id = '${pid}'`)).rows[0];
  check('ledger: two entries, two prizes, one booked cut, and nothing edited',
    entries === 2 && prizes === 2 && Number(cut.n) === 1 && Number(cut.s) === 1, { entries, prizes, cut });

  const allocation = (await sql(
    `select gross_amount, platform_share, rules_version, status from commission_allocations where kind = 'GAME_SESSION' and source_id = '${pid}'`,
  )).rows[0];
  check('revenue: the platform cut is recorded against the session it came from',
    !!allocation && Number(allocation.gross_amount) === 202 && Number(allocation.platform_share) === 1 && Number(allocation.rules_version) === rules.rulesVersion,
    { allocation });

  const pinned = (await sql(`select rules::text r, rules_version from game_sessions where id = '${pid}'`)).rows[0];
  const snapshot = Number(await scalar(`select count(*) from game_rule_snapshots where game_key='TIC_TAC_TOE' and rules_version = ${rules.rulesVersion}`));
  check('versioning: the session carries the rules it was played under, and the table keeps them',
    Number(pinned.rules_version) === rules.rulesVersion && snapshot === 1 && /"shareBps": 7000/.test(pinned.r),
    { version: pinned.rules_version, snapshot });

  const history = await api('GET', '/api/games/me/history?limit=20', { token: host.token });
  const historyRow = ((history.json && history.json.games) || []).find((g) => g.sessionId === pid);
  check('history: the player can see the match they won and what it paid',
    history.status === 200 && !!historyRow && historyRow.rank === 1 && Number(historyRow.prizeDiamonds) === 141 && Number(historyRow.entryFeeDiamonds) === 101,
    { found: !!historyRow, row: historyRow });

  const eventLog = await api('GET', `/api/admin/games/${pid}/events?limit=200`, { token: admin });
  const events = (eventLog.json && eventLog.json.events) || [];
  const seqs = events.map((e) => e.seq);
  const kinds = events.map((e) => e.type);
  check('evidence: the event log shows the whole match, in order, with no gaps',
    eventLog.status === 200 && seqs.every((s, i) => s === i + 1) &&
      ['CREATED', 'JOINED', 'READY', 'STARTED', 'MOVE', 'SETTLED'].every((k) => kinds.includes(k)),
    { count: events.length, kinds: [...new Set(kinds)] });

  // ---- G. cancelling a paid lobby gives the fees back, as new rows ----
  const cancelSession = await api('POST', '/api/games', { token: host.token, body: { gameKey: 'TIC_TAC_TOE', roomId } });
  const cid = cancelSession.json.session.id;
  await api('POST', `/api/games/${cid}/join`, { token: guest.token, body: {} });
  const beforeCancel = [await balance(host.id), await balance(guest.id)];
  const cancelled = await api('POST', `/api/games/${cid}/cancel`, { token: host.token, body: { reason: 'nobody turned up' } });
  const afterCancel = [await balance(host.id), await balance(guest.id)];
  check('refund: a cancelled match returns both entry fees',
    cancelled.status === 200 && cancelled.json.session.status === 'CANCELLED' &&
      afterCancel[0] === beforeCancel[0] + 101 && afterCancel[1] === beforeCancel[1] + 101,
    { status: cancelled.json && cancelled.json.session.status, host: afterCancel[0] - beforeCancel[0], guest: afterCancel[1] - beforeCancel[1] });

  const refundRows = Number(await scalar(`select count(*) from transactions where type='GAME_REFUND' and game_session_id = '${cid}'`));
  const entryRows = Number(await scalar(`select count(*) from transactions where type='GAME_ENTRY' and game_session_id = '${cid}'`));
  check('refund: the entry rows stay where they were posted, beside the refund',
    refundRows === 2 && entryRows === 2, { refundRows, entryRows });

  const cancelAgain = await api('POST', `/api/games/${cid}/cancel`, { token: host.token, body: { reason: 'twice' } });
  check('refund: a closed match cannot be cancelled or refunded again',
    cancelAgain.status === 409 && refundRows === 2, { status: cancelAgain.status });

  // ---- H. a dispute does not quietly un-pay a settlement ----
  const beforeDispute = [await balance(host.id), await balance(guest.id)];
  const dispute = await api('POST', `/api/games/${pid}/dispute`, { token: guest.token, body: { reason: 'the last move looked instant, please check the log' } });
  const afterDispute = [await balance(host.id), await balance(guest.id)];
  check('dispute: raising one freezes nothing but pays nothing either',
    dispute.status === 201 && dispute.json.dispute.status === 'OPEN' && afterDispute[0] === beforeDispute[0] && afterDispute[1] === beforeDispute[1],
    { status: dispute.json && dispute.json.dispute.status, moved: afterDispute[0] - beforeDispute[0] });

  const disputed = await api('GET', `/api/games/${pid}`, { token: host.token });
  const openList = await api('GET', '/api/admin/disputes?status=OPEN&limit=50', { token: admin });
  check('dispute: the console sees the objection and the session says DISPUTED',
    disputed.json.session.settlementStatus === 'DISPUTED' && (openList.json.disputes || []).some((d) => d.id === dispute.json.dispute.id),
    { settlement: disputed.json.session.settlementStatus, listed: (openList.json.disputes || []).length });

  const notAPlayer = await api('POST', `/api/games/${pid}/dispute`, { token: spectator.token, body: { reason: 'not in it' } });
  check('dispute: only a player can object to a result', notAPlayer.status === 403 && codeOf(notAPlayer) === 'not_a_player', { code: codeOf(notAPlayer) });

  const beforeReview = [await balance(host.id), await balance(guest.id)];
  const reviewed = await api('POST', `/api/admin/disputes/${dispute.json.dispute.id}/review`, {
    token: admin, body: { decision: 'REFUNDED', resolution: 'operator refunded the entry fees; the prize stands until proven otherwise' },
  });
  const afterReview = [await balance(host.id), await balance(guest.id)];
  check('dispute: only an operator review moves money, and only the fees',
    reviewed.status === 200 && reviewed.json.dispute.status === 'REFUNDED' && afterReview[0] === beforeReview[0] + 101 && afterReview[1] === beforeReview[1] + 101,
    { decision: reviewed.json && reviewed.json.dispute.status, host: afterReview[0] - beforeReview[0], guest: afterReview[1] - beforeReview[1] });

  const winnerKeepsPrize = Number(await scalar(`select count(*) from transactions where type='GAME_PRIZE' and game_session_id = '${pid}'`));
  const secondReview = await api('POST', `/api/admin/disputes/${dispute.json.dispute.id}/review`, { token: admin, body: { decision: 'UPHELD', resolution: 'again' } });
  check('dispute: a settled prize is not clawed back, and a closed dispute stays closed',
    winnerKeepsPrize === 2 && secondReview.status === 409 && codeOf(secondReview) === 'dispute_closed',
    { prizes: winnerKeepsPrize, status: secondReview.status });

  const audit = await api('GET', '/api/admin/audit?targetType=game_definition&limit=50', { token: admin });
  const ruleAudit = (audit.json.entries || []).filter((e) => e.action === 'GAME_RULES_UPDATE');
  check('audit: every rules decision is recorded with the patch that made it',
    ruleAudit.length >= 2 && ruleAudit.every((e) => e.actorKind === 'admin'), { count: ruleAudit.length, actor: ruleAudit[0] && ruleAudit[0].actor });

  // ---- I. a stalled clock still ends a paid match, once ----
  const timed = await api('POST', '/api/games', { token: host.token, body: { gameKey: 'TIC_TAC_TOE', roomId } });
  const tid = timed.json.session.id;
  await api('POST', `/api/games/${tid}/join`, { token: guest.token, body: {} });
  await api('POST', `/api/games/${tid}/ready`, { token: guest.token, body: {} });
  await api('POST', `/api/games/${tid}/start`, { token: host.token, body: {} });
  await api('POST', `/api/games/${tid}/action`, { token: host.token, body: { type: 'MOVE', payload: { cell: 0 } } });
  await sql(`update game_sessions set turn_deadline_at = now() - interval '1 second' where id = '${tid}'`);
  const ticked = await api('GET', `/api/games/${tid}`, { token: host.token });
  const timedSettled = Number(await scalar(`select count(*) from game_settlements where session_id = '${tid}'`));
  check('timeout: a forfeited turn ends the match in the other seat’s favour and settles once',
    ticked.json.session.status === 'COMPLETED' && timedSettled === 1 && ticked.json.session.state.timeoutPosition === 1,
    { status: ticked.json.session.status, settlements: timedSettled });

  await api('POST', `/api/games/${tid}/action`, { token: guest.token, body: { type: 'MOVE', payload: { cell: 2 } } });
  await api('GET', `/api/games/${tid}`, { token: guest.token });
  check('timeout: a second tick cannot produce a second settlement',
    Number(await scalar(`select count(*) from game_settlements where session_id = '${tid}'`)) === 1);

  // ---- J. the entry ceiling guards both doors ----
  await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', { token: admin, body: { dailyEntryLimit: 2 } });
  const atLimit = await api('POST', '/api/games', { token: host.token, body: { gameKey: 'TIC_TAC_TOE', roomId } });
  check('limits: opening a match is stopped by the same ceiling as joining one',
    atLimit.status === 429 && codeOf(atLimit) === 'daily_entry_limit', { status: atLimit.status, code: codeOf(atLimit) });

  // The join door needs lobbies whose hosts are still under the ceiling themselves, so two
  // fresh hosts open two matches each (2 entries is inside the limit) and one chaser tries to
  // take a third seat.
  const makerA = await makeUser('a');
  const makerB = await makeUser('b');
  const chaser = await makeUser('r');
  for (const u of [makerA, makerB, chaser]) await fund(u.id, 1000);
  const roomA = await api('POST', '/api/rooms', { token: makerA.token, body: { title: `E2E Games 2 ${stamp}`, category: 'CHAT', type: 'PUBLIC', seatCapacity: 4 } });
  const roomB = await api('POST', '/api/rooms', { token: makerB.token, body: { title: `E2E Games 3 ${stamp}`, category: 'CHAT', type: 'PUBLIC', seatCapacity: 4 } });
  const openBy = async (maker, roomId) => (await api('POST', '/api/games', { token: maker.token, body: { gameKey: 'TIC_TAC_TOE', roomId } })).json.session.id;
  const joinA = await api('POST', `/api/games/${await openBy(makerA, roomA.json.room.id)}/join`, { token: chaser.token, body: {} });
  const joinB = await api('POST', `/api/games/${await openBy(makerB, roomB.json.room.id)}/join`, { token: chaser.token, body: {} });
  const joinC = await api('POST', `/api/games/${await openBy(makerA, roomA.json.room.id)}/join`, { token: chaser.token, body: {} });
  check('limits: the first two seats are allowed and the third join is refused',
    joinA.status === 200 && joinB.status === 200 && joinC.status === 429 && codeOf(joinC) === 'daily_entry_limit',
    { joins: [joinA.status, joinB.status, joinC.status], code: codeOf(joinC) });

  // ---- L. the other two drivers, played through the same engine ----
  const quizHost = await makeUser('q');
  const quizOther = await makeUser('w');
  const enabledQuiz = await api('PUT', '/api/admin/games/QUIZ_BATTLE/rules', { token: admin, body: { isActive: true } });
  const quizRoom = await api('POST', '/api/rooms', { token: quizHost.token, body: { title: `E2E Quiz ${stamp}`, category: 'CHAT', type: 'PUBLIC', seatCapacity: 4 } });
  const quizOpen = await api('POST', '/api/games', { token: quizHost.token, body: { gameKey: 'QUIZ_BATTLE', roomId: quizRoom.json.room.id } });
  const qid = quizOpen.json.session.id;
  await api('POST', `/api/games/${qid}/join`, { token: quizOther.token, body: {} });
  await api('POST', `/api/games/${qid}/ready`, { token: quizOther.token, body: {} });
  const quizStarted = await api('POST', `/api/games/${qid}/start`, { token: quizHost.token, body: {} });
  check('engine: a second driver starts on the same rails as the first',
    enabledQuiz.status === 200 && quizStarted.status === 200 && quizStarted.json.session.status === 'IN_PROGRESS' && quizStarted.json.session.entryFeeDiamonds === 0,
    { status: quizStarted.status, fee: quizStarted.json && quizStarted.json.session.entryFeeDiamonds });

  const shown = quizStarted.json.session.state;
  check('anti-cheat: the questions a player is shown never carry the answer',
    Array.isArray(shown.questions) && shown.questions.length === 5 && !JSON.stringify(shown.questions).includes('answerIndex'),
    { questions: shown.questions && shown.questions.length });

  // The answer key only exists in the server's own copy of the state, which is exactly the
  // point: the test reads it there to score a move, and the API never gave it out.
  const truth = (await sql(`select state->'questions' as qs from game_sessions where id = '${qid}'`)).rows[0].qs;
  const right = Number(truth[0].answerIndex);
  const good = await api('POST', `/api/games/${qid}/action`, { token: quizHost.token, body: { type: 'ANSWER', payload: { questionIndex: 0, optionIndex: right } } });
  const wrong = await api('POST', `/api/games/${qid}/action`, { token: quizOther.token, body: { type: 'ANSWER', payload: { questionIndex: 0, optionIndex: (right + 1) % truth[0].options.length } } });
  const scored = wrong.json.session.state.answers;
  check('authority: the engine scores the answer it received, on its own clock',
    good.status === 200 && wrong.status === 200 && scored[quizHost.id]['0'].correct === true && Number(scored[quizHost.id]['0'].points) >= 100 && scored[quizOther.id]['0'].correct === false,
    { points: scored[quizHost.id] && scored[quizHost.id]['0'].points, latency: scored[quizHost.id] && scored[quizHost.id]['0'].latencyMs });

  const past = await api('POST', `/api/games/${qid}/action`, { token: quizHost.token, body: { type: 'ANSWER', payload: { questionIndex: 0, optionIndex: right } } });
  const future = await api('POST', `/api/games/${qid}/action`, { token: quizHost.token, body: { type: 'ANSWER', payload: { questionIndex: 4, optionIndex: 0 } } });
  check('anti-cheat: only the live round can be answered, and only once',
    codeOf(past) === 'round_closed' && codeOf(future) === 'round_not_open', { past: codeOf(past), future: codeOf(future) });

  let quizDone = null;
  for (let round = 0; round < 4; round += 1) {
    await sql(`update game_sessions set turn_deadline_at = now() - interval '1 second' where id = '${qid}'`);
    quizDone = await api('GET', `/api/games/${qid}`, { token: quizHost.token });
  }
  const quizSettled = Number(await scalar(`select count(*) from game_settlements where session_id = '${qid}'`));
  const ranks = quizDone.json.session.participants;
  check('clock: a quiz nobody answers still finishes, and settles exactly once',
    quizDone.json.session.status === 'COMPLETED' && quizSettled === 1 && Number(quizDone.json.session.result.grossPool) === 0,
    { status: quizDone.json.session.status, settlements: quizSettled });
  check('standings: the player who answered correctly is placed above the one who did not',
    ranks.find((p) => p.userId === quizHost.id)?.rank === 1 && ranks.find((p) => p.userId === quizOther.id)?.rank === 2 &&
      ranks.find((p) => p.userId === quizHost.id).score > 0,
    { ranks: ranks.map((p) => `${p.userId === quizHost.id ? 'quiz' : 'other'}:${p.rank}:${p.score}`) });

  const roller = await makeUser('d');
  const waiter = await makeUser('e');
  await api('PUT', '/api/admin/games/LUDO/rules', { token: admin, body: { isActive: true } });
  const ludoRoom = await api('POST', '/api/rooms', { token: roller.token, body: { title: `E2E Ludo ${stamp}`, category: 'CHAT', type: 'PUBLIC', seatCapacity: 4 } });
  const ludoOpen = await api('POST', '/api/games', { token: roller.token, body: { gameKey: 'LUDO', roomId: ludoRoom.json.room.id } });
  const lid = ludoOpen.json.session.id;
  await api('POST', `/api/games/${lid}/join`, { token: waiter.token, body: {} });
  await api('POST', `/api/games/${lid}/ready`, { token: waiter.token, body: {} });
  const ludoStarted = await api('POST', `/api/games/${lid}/start`, { token: roller.token, body: {} });
  const seats = ludoStarted.json.session.participants;
  // The driver hands the first turn to the highest seat, so the player who opened the match
  // is not the one who moves first every time. The test follows that decision instead of
  // assuming seat 0, which is what makes it a test of the engine rather than of the guess.
  const first = seats.find((p) => p.userId === ludoStarted.json.session.turnOwnerId);
  const second = seats.find((p) => p.userId !== first.userId);
  const firstUser = first.userId === roller.id ? roller : waiter;
  const secondUser = firstUser === roller ? waiter : roller;
  check('fairness: the seat that opened the Ludo board does not automatically move first',
    ludoStarted.status === 200 && first.position === 1 && first.userId === waiter.id,
    { opener: roller.id === first.userId, position: first.position });

  const dryMove = await api('POST', `/api/games/${lid}/action`, { token: firstUser.token, body: { type: 'MOVE', payload: { piece: 0 } } });
  const otherRoll = await api('POST', `/api/games/${lid}/action`, { token: secondUser.token, body: { type: 'ROLL', payload: {} } });
  const rolled = await api('POST', `/api/games/${lid}/action`, { token: firstUser.token, body: { type: 'ROLL', payload: { roll: 6 } } });
  const reroll = await api('POST', `/api/games/${lid}/action`, { token: firstUser.token, body: { type: 'ROLL', payload: {} } });
  const bigPiece = await api('POST', `/api/games/${lid}/action`, { token: firstUser.token, body: { type: 'MOVE', payload: { piece: 9 } } });
  const dice = (await sql(`select state->'players'->'${first.position}'->>'pendingRoll' as roll from game_sessions where id = '${lid}'`)).rows[0].roll;
  const diceEvent = (await sql(`select actor_id, payload::text p from game_events where session_id = '${lid}' and type = 'DICE' order by seq`)).rows;
  check('dice: the roll is the server’s, one to six, and it is in the log',
    codeOf(dryMove) === 'no_roll' && codeOf(otherRoll) === 'out_of_turn' && rolled.status === 200 &&
      codeOf(reroll) === 'already_rolled' && codeOf(bigPiece) === 'bad_piece' &&
      Number(dice) >= 1 && Number(dice) <= 6 && diceEvent.length === 1 &&
      Number(JSON.parse(diceEvent[0].p).roll) === Number(dice) && diceEvent[0].actor_id === firstUser.id,
    { dry: codeOf(dryMove), turn: codeOf(otherRoll), twice: codeOf(reroll), piece: codeOf(bigPiece), dice, events: diceEvent.length });

  // A token in the yard may only come out on the six the server rolled — so the legality of
  // this move is decided by the roll on the row, never by the `roll: 6` in the body.
  const leaveYard = await api('POST', `/api/games/${lid}/action`, { token: firstUser.token, body: { type: 'MOVE', payload: { piece: 0, roll: 6, to: 57 } } });
  const six = Number(dice) === 6;
  const boardAfter = (await sql(`select state->'players'->'${first.position}'->'pieces' as pieces from game_sessions where id = '${lid}'`)).rows[0].pieces;
  check('dice: a token leaves the yard only on the server’s six, and a body cannot buy one',
    (six && leaveYard.status === 200 && Number(boardAfter[0]) === 0) ||
      (!six && codeOf(leaveYard) === 'illegal_move' && Number(boardAfter[0]) === -1),
    { rolled: Number(dice), status: leaveYard.status, code: codeOf(leaveYard), piece: boardAfter[0] });

  await sql(`update game_sessions set turn_deadline_at = now() - interval '1 second' where id = '${lid}'`);
  const stalled = await api('GET', `/api/games/${lid}`, { token: firstUser.token });
  const stalledSeat = stalled.json.session.state.players[String(first.position)];
  check('clock: a seat that stops moving loses the dice and the turn, not the board',
    stalled.json.session.turnOwnerId === secondUser.id && stalledSeat.pendingRoll === null &&
      stalledSeat.pieces.some((v) => v !== -1) === six,
    { turn: stalled.json.session.turnOwnerId === secondUser.id, pieces: stalledSeat.pieces });

  const ludoCancel = await api('POST', `/api/games/${lid}/cancel`, { token: roller.token, body: { reason: 'the match was only being tested' } });
  check('money: a free Ludo match that is cancelled settles nothing',
    ludoCancel.status === 200 && ludoCancel.json.session.status === 'CANCELLED' &&
      Number(await scalar(`select count(*) from game_settlements where session_id = '${lid}'`)) === 0,
    { status: ludoCancel.json && ludoCancel.json.session.status });

  await api('PUT', '/api/admin/games/QUIZ_BATTLE/rules', { token: admin, body: { isActive: false } });
  await api('PUT', '/api/admin/games/LUDO/rules', { token: admin, body: { isActive: false } });

  // ---- K. leave the shipped posture as it was found ----
  const restore = await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', {
    token: admin,
    body: {
      isActive: false, entryFeeEnabled: false, entryFeeDiamonds: 0, entryFeeMin: 0, entryFeeMax: 0,
      prizeEnabled: false, commissionBps: 0, dailyEntryLimit: 50, refundPolicy: 'CANCELLED',
      prizeRules: [{ rank: 1, shareBps: 10000 }],
    },
  });
  const afterCatalog = await api('GET', '/api/games', { token: host.token });
  check('compliance: the suite leaves every game free to play and switched off',
    restore.status === 200 && restore.json.game.entryFeeMax === 0 && restore.json.game.entryFeeEnabled === false &&
      afterCatalog.json.games.length === 0,
    { status: restore.status, listed: afterCatalog.json.games.length });

  const unexplained = Number(await scalar(
    `select count(*) from game_settlements where distributed + commission + deductions <> gross_pool`,
  ));
  const prizeSum = Number(await scalar(
    `select coalesce(sum(amount_diamonds),0) from transactions t
      where t.type = 'GAME_PRIZE'
        and exists (select 1 from game_settlements s
                     where s.session_id = t.game_session_id and s.game_key = 'TIC_TAC_TOE')`,
  ));
  const paidSum = Number(await scalar(`select coalesce(sum(distributed),0) from game_settlements where game_key = 'TIC_TAC_TOE'`));
  check('reconciliation: every settlement explains its own pool and the prize ledger equals what was paid',
    unexplained === 0 && prizeSum === paidSum, { unexplained, prizeSum, paidSum });

  const orphanPrizes = Number(await scalar(
    `select count(*) from transactions t where t.type='GAME_PRIZE'
       and not exists (select 1 from game_settlements s where s.session_id = t.game_session_id)`,
  ));
  // An entry debits the player (sender_id), a refund and a prize credit them (receiver_id):
  // every one of those rows has to point at a seat that actually exists.
  const orphanEntries = Number(await scalar(
    `select count(*) from transactions t where t.type in ('GAME_ENTRY','GAME_REFUND')
       and not exists (select 1 from game_participants p
                        where p.session_id = t.game_session_id
                          and p.user_id = coalesce(t.sender_id, t.receiver_id))`,
  ));
  check('reconciliation: no prize exists without its settlement, no entry without its seat',
    orphanPrizes === 0 && orphanEntries === 0, { orphanPrizes, orphanEntries });

  const unbalanced = Number(await scalar(
    `select count(*) from (
       select e.id, sum(l.amount_cents) filter (where l.direction='DEBIT') d, sum(l.amount_cents) filter (where l.direction='CREDIT') c
         from fin_journal_entries e join fin_journal_lines l on l.entry_id = e.id group by e.id) x
      where x.d <> x.c`,
  ));
  check('reconciliation: the double-entry book still balances after the games', unbalanced === 0, { unbalanced });

  const lines = out.filter((l) => l.startsWith('FAIL'));
  console.log(out.join('\n'));
  console.log(`\n${out.length - lines.length}/${out.length} game checks passed`);
  if (lines.length) process.exitCode = 1;
})().catch(async (err) => {
  // A run that died mid-flight must not leave a paid game live behind it.
  await resetShipped().catch(() => undefined);
  console.log(out.join('\n'));
  console.log('BUSINESS GAMES CRASH', err && err.message, err && err.stack);
  process.exitCode = 1;
});
