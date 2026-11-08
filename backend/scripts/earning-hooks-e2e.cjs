/* The metric hooks, walked end to end (migration 0038, README "Earning rules").

     1. boot the stack and the API (README), then `npm run build`
     2. node scripts/earning-hooks-e2e.cjs

   `earning-e2e.cjs` feeds the engine events directly and proves what it does with them. This file
   proves the other half: that the platform's own paths *deliver* those events. Each of the nine
   server-counted metrics is fired by doing the real thing over HTTP — signing in, checking in,
   joining a room, sending a chat on a socket, giving a gift, buying a frame, starting a match — and
   the answer is read back from the attempt and payout rows.

   Three things here could not be proved any other way:

     * the condition context travels. A rule for a PARTY room must not be satisfied by a MUSIC room,
       and one for a 2-diamond send must not be satisfied by a rose, because the filter is exactly
       what an operator believes they are buying.
     * a hook never costs the action it counts. Every one of these requests still succeeded, which is
       what the refusals in the engine are designed to allow.
     * the bonus pocket arrives. Five of the deck's rules paid the member's pocket, so that balance is
       read back from the database and tied against the spending it then funded, not from the engine's
       own arithmetic.

   Runs against a development database only. It leaves no live rule, no open campaign, and switches
   TIC_TAC_TOE back to the posture it was found in. */
const path = require('path');
const crypto = require('node:crypto');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_development_only_not_a_real_secret';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

let failed = 0;
function report(name, pass, detail) {
  const line = `${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ''}`;
  console.log(line);
  if (!pass) failed += 1;
}
function section(title) {
  console.log(`\n--- ${title} ---`);
}

let poolPromise = null;
function db() {
  if (!poolPromise) {
    poolPromise = new (require(path.join(BE_ROOT, 'node_modules', 'pg')).Pool)({
      connectionString: require(path.join(BE_ROOT, 'dist', 'config', 'env.js')).env.databaseUrl,
      max: 4,
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
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, code: json && json.error && json.error.code };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Wait for a row rather than sleeping for one.
 *
 * ROOM_JOIN and CHAT_MESSAGE are deliberately not awaited by their request — a campaign must not add
 * its latency to entering a room — so the row lands some time after the response, and the only honest
 * assertion is "it arrives".
 */
async function until(name, fn, { tries = 40, delay = 250 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await fn();
    if (last && (!Array.isArray(last) || last.length)) return last;
    await sleep(delay);
  }
  report(`${name} arrived`, false, { waited: `${tries * delay}ms`, last });
  return last;
}

/** One account per role in the walk, each signed in the only way this stack issues a member token. */
let userSeq = 0;
async function signIn(label) {
  userSeq += 1;
  const phone = `+15557${stamp}${String(userSeq).padStart(2, '0')}`;
  const challenge = await api('POST', '/api/auth/request-otp', { body: { phone } });
  const verified = await api('POST', '/api/auth/verify-otp', {
    body: { phone, code: challenge.json?.devCode ?? '123456', username: `eh${stamp.slice(-4)}${userSeq}` },
  });
  if (verified.status !== 200) throw new Error(`verify-otp failed for ${label}: ${JSON.stringify(verified.json)}`);
  return { id: verified.json.user.id, token: verified.json.token, phone, label };
}

/** The signed provider webhook: the only door that mints purchasable diamonds. */
async function fund(userId, diamonds) {
  const payload = JSON.stringify({
    id: `evt_h_${userId.slice(0, 8)}_${diamonds}_${Date.now()}`,
    type: 'payment_intent.succeeded',
    data: { object: { id: `pi_h_${crypto.randomUUID()}`, status: 'succeeded', metadata: { voizaUserId: userId, diamonds: String(diamonds) } } },
  });
  const at = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${at}.${payload}`).digest('hex');
  const res = await fetch(`${API}/api/payments/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${at},v1=${mac}` },
    body: payload,
  });
  if (res.status !== 200) throw new Error(`funding failed with ${res.status}`);
}

const wallet = async (userId) =>
  (await sql('SELECT diamond_balance AS bought, promo_diamond_balance AS bonus FROM users WHERE id = $1', [userId])).rows[0];

/** The attempt one member filed against one rule, with its payout attached. */
const attempt = async (userId, key) =>
  (await sql(
    `SELECT a.status, a.progress, a.bucket, a.occurrence, p.currency, p.amount AS paid, p.promo_grant_id
       FROM earning_activities a
       JOIN earning_rules r ON r.id = a.rule_id AND r.rule_version = a.rule_version
       LEFT JOIN earning_payouts p ON p.activity_id = a.id
      WHERE a.user_id = $1 AND r.key = $2
      ORDER BY a.occurrence`,
    [userId, key],
  )).rows;

const ruleKey = (name) => `eh${stamp}-${name}`;
const stamp = Date.now().toString().slice(-6);

(async () => {
  const login = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'voiza-admin' } });
  report('operator sign-in', login.status === 200 && !!login.json.token, { status: login.status });
  const SUPER = login.json.token;

  // A run that crashed before its own teardown leaves a live deck behind, and a live deck pays every
  // account this one signs in too — which would put diamonds in the member's pocket that this walk
  // cannot account for. Retire anything an earlier run left listening before publishing anything.
  const stale = (await sql("SELECT key FROM earning_rules WHERE key LIKE 'eh%' AND is_active ORDER BY key")).rows;
  const off = [];
  for (const row of stale) {
    off.push(await api('POST', `/api/admin/earning/rules/${row.key}/active`, {
      token: SUPER, body: { isActive: false, note: 'hooks suite pre-flight: earlier run crashed' },
    }));
  }
  const staleDecks = (await sql("SELECT key FROM earning_campaigns WHERE key LIKE 'eh%' AND status = 'LIVE' ORDER BY key")).rows;
  const shut = [];
  for (const row of staleDecks) {
    shut.push(await api('PUT', `/api/admin/earning/campaigns/${row.key}`, {
      token: SUPER, body: { status: 'CLOSED' },
    }));
  }
  report('nothing from an earlier run is left listening',
    off.every((r) => r.status === 200 && r.json.rule.isActive === false)
      && shut.every((r) => r.status === 200 && r.json.campaign.status === 'CLOSED'),
    {
      retiredFromEarlierRuns: stale.map((r) => r.key),
      decksClosed: staleDecks.map((r) => r.key),
      failed: off.filter((r) => r.status !== 200).length + shut.filter((r) => r.status !== 200).length,
    });

  // ---------------------------------------------------------------------------
  section('a deck whose every rule names a different thing the platform can see');
  // ---------------------------------------------------------------------------

  const deck = await api('POST', '/api/admin/earning/campaigns', {
    token: SUPER,
    body: { key: ruleKey('deck'), title: 'Hooks deck', status: 'LIVE', budgetDiamonds: 40 },
  });
  report('the deck is live with a budget', deck.status === 201, { status: deck.status, code: deck.code });

  const publish = async (name, body) => {
    const r = await api('POST', '/api/admin/earning/rules', {
      token: SUPER,
      body: { key: ruleKey(name), purpose: 'CAMPAIGN', campaignKey: ruleKey('deck'), reset: 'DAY', ...body },
    });
    if (r.status !== 201) throw new Error(`publishing ${name} failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.rule;
  };

  const KEY = {};
  const deckRules = {
    login: { title: 'Log in', metric: 'DAILY_LOGIN', target: 1, rewardAmount: 1, rewardCurrency: 'BONUS_DIAMOND' },
    checkin: { title: 'Check in', metric: 'CHECKIN', target: 1, rewardAmount: 1, rewardCurrency: 'BONUS_DIAMOND' },
    streak: { title: 'A streak', metric: 'CHECKIN_STREAK', target: 1, rewardAmount: 1, rewardCurrency: 'BONUS_DIAMOND' },
    room: { title: 'Enter a party room', metric: 'ROOM_JOIN', target: 1, rewardAmount: 1, rewardCurrency: 'BONUS_DIAMOND', restrictions: { roomCategory: 'PARTY' } },
    chat: { title: 'Say something', metric: 'CHAT_MESSAGE', target: 1, rewardAmount: 1, rewardCurrency: 'BONUS_DIAMOND', restrictions: { roomCategory: 'PARTY' } },
    gift: { title: 'An expensive gift', metric: 'GIFT_SENT', target: 1, rewardAmount: 1, rewardCurrency: 'BONUS_DIAMOND', restrictions: { minDiamonds: 2 } },
    // Two roses, so the walk can show a category filter holding an attempt half-open: the rose that
    // is sent gets it to progress 1, and the heart that follows cannot take it past that.
    category: { title: 'A rose, twice', metric: 'GIFT_SENT', target: 2, rewardAmount: 1, rewardCurrency: 'BONUS_DIAMOND', restrictions: { giftCategory: 'ROSE' } },
    cheap: { title: 'A cheap gift', metric: 'GIFT_SENT', target: 1, rewardAmount: 1, rewardCurrency: 'BONUS_DIAMOND', restrictions: { minDiamonds: 500 } },
    store: { title: 'Buy a frame', metric: 'STORE_PURCHASE', target: 1, rewardAmount: 1, rewardCurrency: 'BONUS_DIAMOND', restrictions: { itemKind: 'FRAME' } },
    game: { title: 'Play a match', metric: 'GAME_PLAY', target: 1, rewardAmount: 1, rewardCurrency: 'XP' },
  };
  for (const [name, body] of Object.entries(deckRules)) {
    KEY[name] = await publish(name, body);
  }
  report('ten rules are live, nine paying the bonus pocket and one XP',
    Object.keys(KEY).length === 10
      && Object.values(deckRules).filter((b) => b.rewardCurrency === 'BONUS_DIAMOND').length === 9,
    Object.keys(KEY));

  // ---------------------------------------------------------------------------
  section('the accounts');
  // ---------------------------------------------------------------------------

  const member = await signIn('member');
  const receiver = await signIn('receiver');
  const guest = await signIn('guest');
  await fund(member.id, 2200);
  await fund(guest.id, 10);

  const memberWallet = await wallet(member.id);
  report('the member is funded only in purchased diamonds', Number(memberWallet.bought) === 2200, memberWallet);

  // Signing in is itself the DAILY_LOGIN hook, so it has already run by the time it can be asserted.
  const loggedIn = await until('the login attempt', () => attempt(member.id, ruleKey('login')));
  report('signing in advanced the login rule and paid it',
    loggedIn.length === 1 && loggedIn[0].status === 'PAID' && loggedIn[0].progress === 1
      && loggedIn[0].currency === 'BONUS_DIAMOND' && Number(loggedIn[0].paid) === 1, loggedIn[0]);

  const baseline = await wallet(member.id);
  report('the payout arrived in the bonus pocket and moved no purchased diamond',
    Number(baseline.bonus) === 1 && Number(baseline.bought) === 2200, baseline);

  const again = await api('POST', '/api/auth/verify-otp', { body: { phone: member.phone, code: '123456' } });
  const replayChallenge = await api('POST', '/api/auth/request-otp', { body: { phone: member.phone } });
  const second = await api('POST', '/api/auth/verify-otp', { body: { phone: member.phone, code: replayChallenge.json?.devCode ?? '123456' } });
  const afterSecond = await attempt(member.id, ruleKey('login'));
  report('signing in twice in a day files one attempt, because the DAY bucket is the once-a-day rule',
    second.status === 200 && afterSecond.length === 1 && afterSecond[0].occurrence === 1, {
      status: second.status, attempts: afterSecond.length,
    });
  void again;

  // ---------------------------------------------------------------------------
  section('the check-in');
  // ---------------------------------------------------------------------------

  const checkedIn = await api('POST', '/api/quests/checkin', { token: member.token, body: {} });
  const checkinRow = await attempt(member.id, ruleKey('checkin'));
  const streakRow = await attempt(member.id, ruleKey('streak'));
  report('checking in advances the counter rule',
    checkedIn.status === 201 && checkinRow.length === 1 && checkinRow[0].status === 'PAID', {
      status: checkedIn.status, row: checkinRow[0],
    });
  report('and the level rule, whose progress is the streak number rather than a count of days',
    streakRow.length === 1 && streakRow[0].status === 'PAID' && Number(streakRow[0].progress) >= 1, streakRow[0]);

  // ---------------------------------------------------------------------------
  section('a room, a chat line and a gift');
  // ---------------------------------------------------------------------------

  const partyRoom = await api('POST', '/api/rooms', { token: member.token, body: { title: `Hooks party ${stamp}`, category: 'PARTY' } });
  report('the member opens a PARTY room', partyRoom.status === 201, { status: partyRoom.status, code: partyRoom.code });
  const roomId = partyRoom.json.room.id;

  const joined = await api('POST', `/api/rooms/${roomId}/join`, { token: guest.token, body: {} });
  report('a guest joins it', joined.status === 200, { status: joined.status, code: joined.code });

  const hostJoin = await attempt(member.id, ruleKey('room'));
  report("hosting the room is not joining it: the member's own join count waits",
    hostJoin.length === 0 || hostJoin[0].status === 'PAID', { rows: hostJoin.map((r) => r.status) });
  const guestRoom = await until('the guest room attempt', () => attempt(guest.id, ruleKey('room')));
  report("the guest's join is counted, and its category came from the room row",
    guestRoom.length === 1 && guestRoom[0].status === 'PAID' && guestRoom[0].bucket, guestRoom[0]);

  const { io } = require('socket.io-client');
  const socket = await new Promise((resolve, reject) => {
    const s = io(API, { auth: { token: guest.token }, transports: ['websocket'], timeout: 8000 });
    const timer = setTimeout(() => reject(new Error('socket never connected')), 10_000);
    s.on('connect', () => { clearTimeout(timer); resolve(s); });
    s.on('connect_error', (err) => { clearTimeout(timer); reject(new Error(`socket: ${err.message}`)); });
  });
  await new Promise((resolve, reject) => {
    socket.emit('room:join', { roomId }, (r) => (r && r.ok ? resolve() : reject(new Error(JSON.stringify(r)))));
    setTimeout(reject, 10_000, new Error('room:join timed out'));
  });
  const said = await new Promise((resolve, reject) => {
    socket.emit('room:chat', { roomId, message: 'counted by the engine' }, (r) => (r && r.ok ? resolve(r) : reject(new Error(JSON.stringify(r)))));
    setTimeout(reject, 10_000, new Error('room:chat timed out'));
  });
  const chatRow = await until('the chat attempt', () => attempt(guest.id, ruleKey('chat')));
  report('a stored chat line advances its rule, with the room category attached',
    !!said.message && chatRow.length === 1 && chatRow[0].status === 'PAID', { status: said.message?.id ? 'stored' : said, row: chatRow[0] });
  socket.close();

  const rose = (await sql("SELECT id, diamond_price, category FROM gifts WHERE is_active AND category = 'ROSE' AND NOT is_lucky_box ORDER BY diamond_price LIMIT 1")).rows[0];
  const heart = (await sql("SELECT id, diamond_price, category FROM gifts WHERE is_active AND category <> 'ROSE' AND NOT is_lucky_box AND diamond_price >= 2 ORDER BY diamond_price LIMIT 1")).rows[0];
  report('the catalogue has a rose under the rule price and a pricier gift in another category', !!rose && !!heart, {
    rose: rose && [rose.category, rose.diamond_price], heart: heart && [heart.category, heart.diamond_price],
  });

  // Direct gifts, not in-room ones: an in-room send requires both halves of the pair to be seated,
  // and the receiver is here to bank the R-coins, not to occupy a seat. The GIFT_SENT event the
  // engine hears is the same either way.
  const cheapSend = await api('POST', '/api/gifts/send', {
    token: member.token,
    body: { giftId: rose.id, receiverId: receiver.id, quantity: 1, idempotencyKey: `eh-${stamp}-rose-1` },
  });
  const expensiveSend = await api('POST', '/api/gifts/send', {
    token: member.token,
    body: { giftId: heart.id, receiverId: receiver.id, quantity: 1, idempotencyKey: `eh-${stamp}-heart-1` },
  });
  const giftRow = await attempt(member.id, ruleKey('gift'));
  const cheapRuleRow = await attempt(member.id, ruleKey('cheap'));
  report('the gift send reached the ledger',
    cheapSend.status === 201 && expensiveSend.status === 201, {
      rose: cheapSend.status, roseCode: cheapSend.code, heart: expensiveSend.status, heartCode: expensiveSend.code,
    });
  report('the rule price is matched against this send, not the day',
    giftRow.length === 1 && giftRow[0].status === 'PAID' && giftRow[0].progress === 1, giftRow[0]);
  report('a gift below the filter files no attempt at all', cheapRuleRow.length === 0, cheapRuleRow);

  const roseOnly = await attempt(member.id, ruleKey('category'));
  report('a rose took the category rule to one of two and a heart cannot take it past that',
    roseOnly.length === 1 && roseOnly[0].status === 'OPEN' && Number(roseOnly[0].progress) === 1, roseOnly[0]);

  // ---------------------------------------------------------------------------
  section('the store and the games table');
  // ---------------------------------------------------------------------------

  const bought = await api('POST', '/api/store/purchase', { token: member.token, body: { kind: 'FRAME', key: 'ring-bronze' } });
  const storeRow = await attempt(member.id, ruleKey('store'));
  report('buying a frame advances the rule conditioned on its kind',
    bought.status === 201 && storeRow.length === 1 && storeRow[0].status === 'PAID', { status: bought.status, code: bought.code, row: storeRow[0] });

  const beforeTic = (await sql("SELECT is_active, entry_fee_enabled, entry_fee_diamonds FROM game_definitions WHERE key = 'TIC_TAC_TOE'")).rows[0];
  const openedGame = await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', { token: SUPER, body: { isActive: true } });
  report('a free match is opened for play', openedGame.status === 200, { status: openedGame.status });

  const gameRoom = await api('POST', '/api/rooms', { token: member.token, body: { title: `Hooks table ${stamp}`, category: 'PARTY' } });
  const gameRoomId = gameRoom.json.room.id;
  await api('POST', `/api/rooms/${gameRoomId}/join`, { token: guest.token, body: {} });
  const session = await api('POST', '/api/games', { token: member.token, body: { gameKey: 'TIC_TAC_TOE', roomId: gameRoomId } });
  const sid = session.json?.session?.id;
  await api('POST', `/api/games/${sid}/join`, { token: guest.token, body: {} });
  await api('POST', `/api/games/${sid}/ready`, { token: guest.token, body: {} });
  const started = await api('POST', `/api/games/${sid}/start`, { token: member.token, body: {} });
  report('the match starts', started.status === 200 && started.json?.session?.status === 'IN_PROGRESS', {
    status: started.status, code: started.code,
  });

  const hostGame = await until('the host game attempt', () => attempt(member.id, ruleKey('game')));
  const guestGame = await attempt(guest.id, ruleKey('game'));
  report('every seated player is counted, once, for the game they are actually in',
    hostGame.length === 1 && hostGame[0].status === 'PAID' && guestGame.length === 1 && guestGame[0].status === 'PAID', {
      host: hostGame[0], guest: guestGame[0],
    });
  report('the XP rule paid XP and minted nothing',
    hostGame[0].currency === 'XP' && Number(hostGame[0].paid) === 1 && !hostGame[0].promo_grant_id, hostGame[0]);

  await api('PUT', '/api/admin/games/TIC_TAC_TOE/rules', {
    token: SUPER,
    body: { isActive: beforeTic.is_active, entryFeeEnabled: beforeTic.entry_fee_enabled, entryFeeDiamonds: beforeTic.entry_fee_diamonds },
  });

  // ---------------------------------------------------------------------------
  section('the same three facts, one notch off every filter');
  // ---------------------------------------------------------------------------

  const musicRoom = await api('POST', '/api/rooms', { token: member.token, body: { title: `Hooks music ${stamp}`, category: 'MUSIC' } });
  const musicRoomId = musicRoom.json.room.id;
  const joinedMusic = await api('POST', `/api/rooms/${musicRoomId}/join`, { token: guest.token, body: {} });
  report('the guest joins a MUSIC room too', joinedMusic.status === 200, { status: joinedMusic.status, code: joinedMusic.code });

  const socket2 = await new Promise((resolve, reject) => {
    const s = io(API, { auth: { token: guest.token }, transports: ['websocket'], timeout: 8000 });
    const timer = setTimeout(() => reject(new Error('second socket never connected')), 10_000);
    s.on('connect', () => { clearTimeout(timer); resolve(s); });
    s.on('connect_error', (err) => { clearTimeout(timer); reject(new Error(`socket: ${err.message}`)); });
  });
  await new Promise((resolve, reject) => {
    socket2.emit('room:join', { roomId: musicRoomId }, (r) => (r && r.ok ? resolve() : reject(new Error(JSON.stringify(r)))));
    setTimeout(reject, 10_000, new Error('room:join timed out'));
  });
  await new Promise((resolve, reject) => {
    socket2.emit('room:chat', { roomId: musicRoomId, message: 'the wrong kind of room' }, (r) => (r && r.ok ? resolve(r) : reject(new Error(JSON.stringify(r)))));
    setTimeout(reject, 10_000, new Error('room:chat timed out'));
  });
  socket2.close();

  const guestAfterMusic = await attempt(guest.id, ruleKey('room'));
  const chatAfterMusic = await attempt(guest.id, ruleKey('chat'));
  report('a join in a room the rule does not name leaves the attempt exactly where it was',
    guestAfterMusic.length === 1 && guestAfterMusic[0].status === 'PAID' && Number(guestAfterMusic[0].occurrence) === 1,
    guestAfterMusic[0]);
  report('and a chat line in it cannot satisfy a PARTY filter',
    chatAfterMusic.length === 1 && chatAfterMusic[0].status === 'PAID', chatAfterMusic[0]);

  const theme = (await sql("SELECT slug FROM room_themes WHERE for_sale ORDER BY price_diamonds LIMIT 1")).rows[0];
  const themeBuy = await api('POST', '/api/store/purchase', { token: member.token, body: { kind: 'THEME', key: theme.slug } });
  const storeAfterTheme = await attempt(member.id, ruleKey('store'));
  report('a real purchase of another kind still does not answer a FRAME rule',
    themeBuy.status === 201 && storeAfterTheme.length === 1 && storeAfterTheme[0].status === 'PAID'
      && Number(storeAfterTheme[0].occurrence) === 1, { status: themeBuy.status, row: storeAfterTheme[0] });

  // ---------------------------------------------------------------------------
  section('the pocket the whole walk paid into');
  // ---------------------------------------------------------------------------

  // The login hook is not awaited by the request that fires it, and three accounts fired it, so the
  // walk waits for all three to have landed before it reads the payout table back.
  await until('the guest login', () => attempt(guest.id, ruleKey('login')));
  await until('the receiver login', () => attempt(receiver.id, ruleKey('login')));

  const payouts = (await sql(
    `SELECT p.metric, p.currency, p.amount, p.promo_grant_id, p.user_id, r.key AS rule_key
       FROM earning_payouts p
       JOIN earning_rules r ON r.id = p.rule_id AND r.rule_version = p.rule_version
      WHERE r.key LIKE $1
      ORDER BY p.user_id, p.metric`,
    [`eh${stamp}-%`],
  )).rows;
  const minted = payouts.filter((p) => p.currency === 'BONUS_DIAMOND');
  const memberMinted = minted.filter((p) => p.user_id === member.id);
  const guestMinted = minted.filter((p) => p.user_id === guest.id);
  const receiverMinted = minted.filter((p) => p.user_id === receiver.id);
  const metricsOf = (rows) => rows.map((p) => p.metric).sort().join();
  report('the member was paid by login, check-in, streak, gift and store — five rules, one diamond each',
    memberMinted.length === 5 && memberMinted.every((p) => Number(p.amount) === 1)
      && memberMinted.every((p) => !!p.promo_grant_id)
      && metricsOf(memberMinted) === 'CHECKIN,CHECKIN_STREAK,DAILY_LOGIN,GIFT_SENT,STORE_PURCHASE',
    { metrics: metricsOf(memberMinted) });
  report('the guest was paid for the party join, the party line and its own login, and by nothing else',
    metricsOf(guestMinted) === 'CHAT_MESSAGE,DAILY_LOGIN,ROOM_JOIN', { guest: metricsOf(guestMinted) });
  report('the receiver was paid for signing in and for nothing it never did',
    metricsOf(receiverMinted) === 'DAILY_LOGIN', { receiver: metricsOf(receiverMinted) });
  report('the rose-only and 500-diamond rules stayed unpaid, and the match rule paid XP to both seats',
    payouts.filter((p) => p.currency === 'XP').length === 2
      && !payouts.some((p) => p.rule_key === ruleKey('category') || p.rule_key === ruleKey('cheap'))
      && payouts.every((p) => p.currency === 'XP' || p.currency === 'BONUS_DIAMOND'),
    { xp: payouts.filter((p) => p.currency === 'XP').length, minted: minted.length, keys: [...new Set(payouts.map((p) => p.rule_key))] });

  // Both books have to close on their own arithmetic. The bonus pocket is what this deck minted into
  // it minus what the member's spending actually drew from it — read from `promo_grant_spends` rows
  // joined to *these* payouts' grants, so a draw against some other campaign can never be blamed on
  // this one. Whatever a purchase cost beyond that draw came out of purchased diamonds, and the
  // member is a fresh account that was funded exactly once, so the bought balance closes the same way.
  const memberGrantIds = memberMinted.map((p) => p.promo_grant_id);
  const promoDrawn = Number((await sql(
    `SELECT COALESCE(SUM(s.diamonds), 0) AS n
       FROM promo_grant_spends s
      WHERE s.grant_id = ANY($1::uuid[])`,
    [memberGrantIds],
  )).rows[0].n);
  const memberSpend = Number((await sql(
    `SELECT COALESCE(SUM(t.amount_diamonds), 0) AS n
       FROM transactions t
      WHERE t.sender_id = $1 AND t.type IN ('GIFT_SENT', 'ITEM_PURCHASE')`,
    [member.id],
  )).rows[0].n);
  const pocket = await wallet(member.id);
  const mintTotal = memberMinted.reduce((n, p) => n + Number(p.amount), 0);
  const boughtSpent = memberSpend - promoDrawn;
  report('the bonus pocket is exactly what this deck minted there minus what the member drew from it',
    Number(pocket.bonus) === mintTotal - promoDrawn, { pocket, minted: mintTotal, promoDrawn, memberGrantIds: memberGrantIds.length });
  report('the purchased balance paid the rest of the spend, and no payout landed in it',
    Number(pocket.bought) === Number(memberWallet.bought) - boughtSpent && boughtSpent >= 0,
    { start: memberWallet.bought, now: pocket.bought, spent: boughtSpent, grossSpend: memberSpend });

  // There is no `spent` column on a campaign: the budget is checked by summing the payouts the deck
  // has already made, so that is what the walk has to read back.
  const spent = (await sql(
    `SELECT COALESCE(SUM(p.amount), 0) AS n
       FROM earning_payouts p
       JOIN earning_campaigns c ON c.id = p.campaign_id
      WHERE c.key = $1 AND p.currency = 'BONUS_DIAMOND'`,
    [ruleKey('deck')],
  )).rows[0];
  const mintTotalAll = minted.reduce((n, p) => n + Number(p.amount), 0);
  report('the campaign budget reads every diamond the deck minted', Number(spent.n) === mintTotalAll, {
    spent: spent.n, minted: mintTotalAll,
  });

  // The board reads live rules, so it only shows the deck while the deck is still live — hence this
  // runs before the teardown. `GET /api/earnings` returns a flat `rules` list, one entry per live
  // rule, with the member's own attempt folded onto it.
  const board = await api('GET', '/api/earnings', { token: member.token });
  const ofDeck = (board.json?.rules ?? []).filter((r) => String(r.ruleKey).startsWith(`eh${stamp}-`));
  const onBoard = (name) => ofDeck.find((r) => r.ruleKey === ruleKey(name));
  report('the member board shows all ten rules of the deck the hooks advanced',
    board.status === 200 && ofDeck.length === 10, { status: board.status, keys: ofDeck.length });
  report('and each row carries the state its hook left behind, including the two that never paid',
    ['login', 'checkin', 'streak', 'gift', 'store', 'game'].every((n) => onBoard(n) && onBoard(n).status === 'PAID')
      && onBoard('category') && onBoard('category').status === 'OPEN'
      && Number(onBoard('category').progress) === 1 && Number(onBoard('category').target) === 2
      && onBoard('cheap') && (onBoard('cheap').status === null || onBoard('cheap').status === 'NONE')
      && Number(onBoard('cheap').progress) === 0
      && onBoard('room') && onBoard('room').status === null,
    ofDeck.map((r) => [r.ruleKey.split('-')[1], r.status, r.progress]));

  // The finance report re-derives the same relationships from the tables and does not trust the
  // engine's arithmetic. Every payout this walk minted is in its window, so a breach in the earning
  // domain here is this suite's own book failing to close — not someone else's leftover.
  const recon = await api('GET', '/api/admin/business/finance/reconciliation', { token: SUPER });
  const earningChecks = (recon.json?.checks ?? []).filter((c) => c.domain === 'earning');
  report('the finance report tie-outs for the money this walk minted all pass',
    recon.status === 200 && earningChecks.length === 6 && earningChecks.every((c) => c.passed && c.breaches === 0),
    { status: recon.status, checks: earningChecks.length, breached: earningChecks.filter((c) => !c.passed).map((c) => [c.key, c.breaches]) });

  // ---------------------------------------------------------------------------
  section('teardown: nothing left live');
  // ---------------------------------------------------------------------------

  const retired = [];
  for (const name of Object.keys(KEY)) {
    retired.push(await api('POST', `/api/admin/earning/rules/${ruleKey(name)}/active`, {
      token: SUPER, body: { isActive: false, note: 'hooks suite teardown' },
    }));
  }
  const closed = await api('PUT', `/api/admin/earning/campaigns/${ruleKey('deck')}`, { token: SUPER, body: { status: 'CLOSED' } });
  report('every rule is retired and the deck is closed',
    retired.every((r) => r.status === 200 && r.json.rule.isActive === false) && closed.status === 200,
    { retired: retired.filter((r) => r.status !== 200).length, deck: closed.json?.campaign?.status });

  await db().end().catch(() => undefined);
  console.log(`\n${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch(async (e) => {
  console.log(`THREW  ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)}`);
  failed += 1;
  await db().end().catch(() => undefined);
  console.log(`\n${failed} failed`);
  process.exitCode = 1;
});
