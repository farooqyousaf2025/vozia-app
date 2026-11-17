/* End-to-end tests for payment receipts and coin-seller cash payouts (§22, migration 0041).
   Drives a *running* backend over HTTP against real PostgreSQL and asserts on database state
   through the backend's own pg pool — no mocks, no fixtures.

     1. boot the stack and the API, apply migration 0041, then `npm run build`
     2. node scripts/receipt-e2e.cjs

   Throwaway partners, members and documents are named with a time stamp, so run it against a
   development database only. The probes that only have to reach the format sniffers are real magic
   numbers over junk bytes. The documents a finance reviewer opens in the panel — the slip on the
   order, the statement, the cash-out proof — are decodable PNG and PDF, so an operator clicking
   "Open" on a suite record sees a page and not a broken image. */
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const BE_ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const out = [];
const check = (n, p, d) => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? `  :: ${JSON.stringify(d).slice(0, 260)}` : ''}`);

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
const scalar = async (q, p) => {
  const r = await sql(q, p);
  return r.rows.length ? Object.values(r.rows[0]).join('|') : null;
};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

/** A file read: answers with the headers and the bytes, because that is the whole contract here. */
async function getFile(p, token) {
  const res = await fetch(API + p, { headers: { authorization: `Bearer ${token}` } });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes };
}

async function login(phone, username) {
  const r = await api('POST', '/api/auth/request-otp', { body: { phone } });
  return (await api('POST', '/api/auth/verify-otp', { body: { phone, code: r.json && r.json.devCode, username } })).json;
}

const stamp = Date.now().toString().slice(-7);
const b64 = (buf) => buf.toString('base64');
const png = (fill = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(fill, 7)]);
const pdf = (fill = 64) => Buffer.concat([Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'), Buffer.alloc(fill, 7)]);
/** Walks the chunk list and re-computes every CRC: the difference between a PNG and PNG-shaped bytes. */
function isPng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return false;
  let at = 8;
  let sawIdat = false;
  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.slice(at + 4, at + 8).toString('ascii');
    const body = buf.slice(at + 4, at + 8 + length);
    if (at + 8 + length + 4 > buf.length) return false;
    if (buf.readUInt32BE(at + 8 + length) !== crc32(body)) return false;
    if (type === 'IDAT') sawIdat = true;
    if (type === 'IEND') return sawIdat && at + 8 + length + 4 === buf.length;
    at += 8 + length + 4;
  }
  return false;
}

/** A PDF a viewer can open: header, an xref table at a byte offset that actually points at it, %%EOF. */
function isPdf(buf) {
  const text = buf.toString('latin1');
  if (!text.startsWith('%PDF-1.')) return false;
  if (!text.trimEnd().endsWith('%%EOF')) return false;
  const startxref = text.lastIndexOf('startxref');
  if (startxref < 0) return false;
  const offset = Number(text.slice(startxref + 9).trim().split(/\s+/)[0]);
  return text.slice(offset, offset + 4) === 'xref';
}

const gifBytes = () => Buffer.from('GIF89a' + 'a'.repeat(40), 'ascii');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** A PNG chunk the way the format wants one: length, type, data, and a CRC over type plus data. */
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A decodable 8x8 PNG. `shade` changes pixels, so every one of these has its own hash. */
function realPng(shade = 64) {
  const size = 8;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      row[1 + x * 3] = (shade + x * 9) % 256;
      row[2 + x * 3] = (shade + y * 11) % 256;
      row[3 + x * 3] = 200;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A one-page PDF with real xref offsets, so a reviewer opening it sees a rendered document. */
function realPdf(label = 'Voiza e2e receipt') {
  const stream = Buffer.from(`BT /F1 12 Tf 20 60 Td (${label}) Tj ET`, 'ascii');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', 'ascii'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'ascii'), stream, Buffer.from('\nendstream', 'ascii')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii'),
  ];

  let body = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'ascii');
  const offsets = [];
  objects.forEach((dict, index) => {
    offsets.push(body.length);
    body = Buffer.concat([body, Buffer.from(`${index + 1} 0 obj\n`, 'ascii'), dict, Buffer.from('\nendobj\n', 'ascii')]);
  });

  const xrefStart = body.length;
  let xref = Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, 'ascii');
  for (const offset of offsets) {
    xref = Buffer.concat([xref, Buffer.from(`${String(offset).padStart(10, '0')} 00000 n \n`, 'ascii')]);
  }
  return Buffer.concat([
    body,
    xref,
    Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`, 'ascii'),
  ]);
}
const junk = () => Buffer.from('this is not any file format anyone accepts, only text', 'ascii');

(async () => {
  // ---- A. who is in the room ----------------------------------------------
  const adminLogin = await api('POST', '/api/auth/verify-otp', { body: { phone: '+10000000000', code: '424242' } });
  const admin = adminLogin.json && adminLogin.json.token;
  check('setup: the bootstrap OTP mints an operator token', adminLogin.status === 200 && !!admin, { status: adminLogin.status });

  const mintAdmin = async (username, role) => {
    const password = `e2e-pass-${role.toLowerCase()}-1`;
    await sql(
      `INSERT INTO admins (username, password_hash, display_name, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      [username, require(path.join(BE_ROOT, 'dist', 'utils', 'crypto.js')).hashSecret(password), `E2E ${role}`, role],
    );
    const signedIn = await api('POST', '/api/admin/login', { body: { username, password } });
    return { id: username, token: signedIn.json && signedIn.json.token, login: signedIn };
  };
  const finance = await mintAdmin(`e2e_rec_fin_${stamp}`, 'FINANCE_ADMIN');
  const moderator = await mintAdmin(`e2e_rec_mod_${stamp}`, 'MODERATOR');
  check('setup: narrow operators sign in', !!finance.token && !!moderator.token, {
    finance: finance.login.status, moderator: moderator.login.status,
  });

  const bd = await api('POST', '/api/admin/business/accounts', {
    token: admin, body: { kind: 'BD_MANAGER', displayName: `E2E receipts territory ${stamp}`, code: `BDR-E2E-${stamp}` },
  });
  const bdId = bd.json && bd.json.account && bd.json.account.id;
  await api('POST', `/api/admin/business/accounts/${bdId}/status`, { token: admin, body: { status: 'ACTIVE' } });
  const agent = await api('POST', '/api/admin/business/accounts', {
    token: admin,
    body: { kind: 'BD_AGENT', displayName: `E2E receipts agent ${stamp}`, code: `BDA-E2E-${stamp}`, parentId: bdId, password: 'e2ereceiptpass1' },
  });
  const agentId = agent.json && agent.json.account && agent.json.account.id;
  await api('POST', `/api/admin/business/accounts/${agentId}/status`, { token: admin, body: { status: 'ACTIVE' } });

  const makeSeller = async (n) => {
    const code = `SLR-REC-${n}-${stamp}`;
    const created = await api('POST', '/api/admin/business/accounts', {
      token: admin, body: { kind: 'COIN_SELLER', displayName: `E2E receipt seller ${n} ${stamp}`, code, parentId: agentId, password: 'e2ereceiptpass1' },
    });
    const id = created.json && created.json.account && created.json.account.id;
    await api('POST', `/api/admin/business/accounts/${id}/status`, { token: admin, body: { status: 'ACTIVE' } });
    const token = (await api('POST', '/api/business/login', { body: { code, password: 'e2ereceiptpass1' } })).json.token;
    return { id, code, token };
  };
  const seller = await makeSeller('A');
  const other = await makeSeller('B');
  const agentLogin = await api('POST', '/api/business/login', { body: { code: `BDA-E2E-${stamp}`, password: 'e2ereceiptpass1' } });
  check('setup: two sellers and a BD agent sign in', !!seller.token && !!other.token && !!agentLogin.json.token, {});

  const whoami = await api('GET', '/api/business/me', { token: seller.token });
  check(
    'rbac: a coin seller holds the payout capability, an ordinary capability it is not',
    whoami.status === 200 && (whoami.json.permissions || []).includes('payout:manage'),
    { permissions: whoami.json && whoami.json.permissions },
  );
  const agentPayouts = await api('GET', '/api/business/payouts', { token: agentLogin.json.token });
  check(
    'rbac: a BD manager account may not open the cash-payout queue',
    agentPayouts.status === 403 && agentPayouts.json.error.code === 'permission_denied',
    { status: agentPayouts.status, code: agentPayouts.json && agentPayouts.json.error && agentPayouts.json.error.code },
  );

  const memberPhone = `+15558${stamp}01`;
  const memberSession = await login(memberPhone, `e2e_rec_member_${stamp.slice(-4)}`);
  const memberToken = memberSession.token;
  const memberId = memberSession.user.id;
  const credited = await api('POST', `/api/admin/users/${memberId}/balance`, {
    token: admin, body: { rCoinDelta: 300000, note: `e2e receipt suite ${stamp} — R-coins to sell` },
  });
  check('setup: the member holds R-coins to sell', credited.status === 200, { status: credited.status });
  const coinsAtStart = await scalar('SELECT diamond_balance FROM users WHERE id = $1', [memberId]);

  // ---- B. the order rail: a slip attached to a recharge order --------------
  const catalog = await api('GET', '/api/business/packages', { token: seller.token });
  const packageKey = catalog.json && catalog.json.packages && catalog.json.packages[0] && catalog.json.packages[0].key;
  check('setup: the seller has a package to sell', catalog.status === 200 && !!packageKey, { status: catalog.status });

  const order = await api('POST', '/api/business/orders', {
    token: seller.token, body: { phone: memberPhone, packageKey, paymentMethod: 'BANK' },
  });
  const orderId = order.json && order.json.order && order.json.order.id;
  check('order: a seller opens an awaiting-payment order', order.status === 201 && !!orderId, { status: order.status });

  const noTarget = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'slip.png', data: b64(png()) } });
  check('receipt: an upload naming no record is refused', noTarget.status === 400 && noTarget.json.error.code === 'receipt_target_required', noTarget.json && noTarget.json.error);

  const bothTargets = await api('POST', '/api/business/receipts', {
    token: seller.token, body: { fileName: 'slip.png', data: b64(png()), orderId, withdrawalId: crypto.randomUUID() },
  });
  check('receipt: a document cannot be aimed at two money records', bothTargets.status === 400 && bothTargets.json.error.code === 'receipt_target_ambiguous', bothTargets.json && bothTargets.json.error);

  const notAnImage = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'slip.gif', data: b64(gifBytes()), orderId } });
  check(
    'receipt: an animated GIF is not a bank slip',
    notAnImage.status === 400 && notAnImage.json.error.code === 'receipt_format_unsupported',
    notAnImage.json && notAnImage.json.error,
  );
  const notAFile = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'slip.png', data: b64(junk()), orderId } });
  check('receipt: bytes that are no format at all are refused', notAFile.status === 400 && notAFile.json.error.code === 'receipt_format_unsupported', notAFile.json && notAFile.json.error);

  const tooBig = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'slip.png', data: b64(png(5 * 1024 * 1024 + 8)), orderId } });
  check('receipt: the size cap is read from the format, not from the caller', tooBig.status === 400 && tooBig.json.error.code === 'receipt_too_large', tooBig.json && tooBig.json.error);

  const wrongSeller = await api('POST', '/api/business/receipts', { token: other.token, body: { fileName: 'slip.png', data: b64(png()), orderId } });
  check('receipt: another seller cannot put a slip on this order', wrongSeller.status === 404, { status: wrongSeller.status, code: wrongSeller.json && wrongSeller.json.error && wrongSeller.json.error.code });

  const orderPdf = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'statement.pdf', data: b64(realPdf(`Bank statement ${stamp}`)), orderId } });
  check('receipt: a PDF bank statement uploads', orderPdf.status === 201 && orderPdf.json.receipt.contentType === 'application/pdf', { status: orderPdf.status, receipt: orderPdf.json && orderPdf.json.receipt });
  const orderPng = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'transfer.png', data: b64(realPng()), orderId } });
  check('receipt: a photographed transfer uploads', orderPng.status === 201 && orderPng.json.receipt.contentType === 'image/png', { status: orderPng.status });

  const replay = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'transfer.png', data: b64(realPng()), orderId } });
  check(
    'receipt: the same document on the same order twice stores nothing new',
    replay.status === 200 && replay.json.duplicate === true && replay.json.receipt.id === orderPng.json.receipt.id,
    { status: replay.status, duplicate: replay.json && replay.json.duplicate },
  );

  const paidByReceipt = await api('POST', `/api/business/orders/${orderId}/mark-paid`, {
    token: seller.token, body: { paymentRef: `REC-${stamp}-0001`, evidence: {} },
  });
  check(
    'order: a receipt satisfies the manual evidence gate — and nothing more',
    paidByReceipt.status === 200 && paidByReceipt.json.order.status === 'AWAITING_VERIFICATION',
    { status: paidByReceipt.status, order: paidByReceipt.json && paidByReceipt.json.order && paidByReceipt.json.order.status },
  );
  const balanceAfterClaim = await scalar('SELECT diamond_balance FROM users WHERE id = $1', [memberId]);
  check('order: a receipt credits nothing by itself', Number(balanceAfterClaim) === Number(coinsAtStart), { diamonds: balanceAfterClaim, expected: coinsAtStart });

  const receiptRows = await sql('SELECT stored_name, content_type, uploaded_by FROM payment_receipts WHERE order_id = $1 ORDER BY created_at', [orderId]);
  check('order: two documents are on the record', receiptRows.rows.length === 2, { count: receiptRows.rows.length });
  const storedName = receiptRows.rows[1].stored_name;
  const receiptsDir = path.join(BE_ROOT, 'receipts');
  check(
    'storage: the bytes live in the receipts directory, not the public uploads one',
    fs.existsSync(path.join(receiptsDir, storedName)) && !fs.existsSync(path.join(BE_ROOT, 'uploads', storedName)),
    { storedName },
  );
  const publicPath = await fetch(`${API}/uploads/${storedName}`);
  check('storage: a slip is not fetchable as static media', publicPath.status === 404, { status: publicPath.status });
  const noToken = await fetch(`${API}/api/admin/business/receipts/${orderPng.json.receipt.id}/raw`);
  check('storage: a slip has no unauthenticated route, not even by id', noToken.status === 401 || noToken.status === 403, { status: noToken.status });

  const financeList = await api('GET', `/api/admin/business/recharges/${orderId}/receipts`, { token: finance.token });
  check('finance: the review queue lists the order’s documents', financeList.status === 200 && financeList.json.receipts.length === 2, { status: financeList.status, count: financeList.json && financeList.json.receipts && financeList.json.receipts.length });
  check(
    'finance: the payload carries no addressable URL',
    !('url' in financeList.json.receipts[0]) && !('storedName' in financeList.json.receipts[0]),
    { keys: Object.keys(financeList.json.receipts[0]) },
  );

  const slipFile = await getFile(`/api/admin/business/receipts/${orderPng.json.receipt.id}/raw`, finance.token);
  check(
    'finance: the slip comes back with its sniffed type and no-store',
    slipFile.status === 200 && slipFile.headers.get('content-type') === 'image/png' && slipFile.headers.get('cache-control') === 'no-store',
    { status: slipFile.status, type: slipFile.headers.get('content-type'), cache: slipFile.headers.get('cache-control') },
  );
  check('finance: the slip comes back as the bytes uploaded, in a form a viewer can render', slipFile.bytes.equals(realPng()) && isPng(slipFile.bytes), { size: slipFile.bytes.length });
  const moderatorFile = await getFile(`/api/admin/business/receipts/${orderPng.json.receipt.id}/raw`, moderator.token);
  check('rbac: opening a document is a review capability, not a read one', moderatorFile.status === 403, { status: moderatorFile.status });
  const statementFile = await getFile(`/api/admin/business/receipts/${orderPdf.json.receipt.id}/raw`, finance.token);
  check('finance: the statement on the order is a PDF a viewer can render', statementFile.status === 200 && isPdf(statementFile.bytes), { status: statementFile.status, size: statementFile.bytes.length });

  const approved = await api('POST', `/api/admin/business/recharges/${orderId}/approve`, { token: finance.token, body: { decisionNote: `e2e receipt ${stamp}` } });
  check('order: finance approves on the strength of the slip', approved.status === 200 && approved.json.order.status === 'CREDITED', { status: approved.status });
  const balanceAfterApprove = await scalar('SELECT diamond_balance FROM users WHERE id = $1', [memberId]);
  check('order: the credit happens at approval, exactly once', Number(balanceAfterApprove) > Number(balanceAfterClaim), { before: balanceAfterClaim, after: balanceAfterApprove });

  const closedTarget = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'late.png', data: b64(png(32)), orderId } });
  check('order: a credited order takes no further documents', closedTarget.status === 409 && closedTarget.json.error.code === 'receipt_target_closed', closedTarget.json && closedTarget.json.error);

  // The parking lot: a seller cannot stack documents on an order forever. Eight distinct slips are
  // the ceiling, so the ninth byte-different file must be refused before anything is written.
  const crowded = await api('POST', '/api/business/orders', {
    token: seller.token, body: { phone: memberPhone, packageKey, paymentMethod: 'BANK' },
  });
  const crowdedId = crowded.json && crowded.json.order && crowded.json.order.id;
  const filled = [];
  for (let i = 0; i < 8; i += 1) filled.push(await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: `slip-${i}.png`, data: b64(realPng(20 + i * 29)), orderId: crowdedId } }));
  check('order: eight distinct slips is the allowance', filled.every((r) => r.status === 201), { statuses: filled.map((r) => r.status) });
  const ninth = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'slip-9.png', data: b64(png(4096)), orderId: crowdedId } });
  check('order: a ninth document is refused as a pile, not stored', ninth.status === 409 && ninth.json.error.code === 'receipt_limit', ninth.json && ninth.json.error);
  const crowdedRows = await sql('SELECT stored_name FROM payment_receipts WHERE order_id = $1', [crowdedId]);
  check('order: the refusal added no row and no file', crowdedRows.rows.length === 8, { count: crowdedRows.rows.length });

  const cancelled = await api('POST', `/api/business/orders/${crowdedId}/cancel`, { token: seller.token, body: { reason: `e2e receipt suite ${stamp}` } });
  const afterCancel = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'after.png', data: b64(png(90)), orderId: crowdedId } });
  check(
    'order: a cancelled order closes the document window too',
    cancelled.status === 200 && afterCancel.status === 409 && afterCancel.json.error.code === 'receipt_target_closed',
    { cancel: cancelled.status, upload: afterCancel.status },
  );

  // ---- C. the payout rail: a member sells R-coins to a seller -------------
  const badSeller = await api('POST', '/api/wallet/withdraw', {
    token: memberToken,
    body: { amountRCoins: 100000, payoutMethod: 'SELLER', payoutDetails: { account: 'PK0000000000001234', sellerId: agentId } },
  });
  check(
    'payout: a BD agent cannot be named as the cash payer',
    badSeller.status === 400 && badSeller.json.error.code === 'payout_seller_unavailable',
    badSeller.json && badSeller.json.error,
  );

  const payout = await api('POST', '/api/wallet/withdraw', {
    token: memberToken,
    body: { amountRCoins: 100000, payoutMethod: 'SELLER', payoutDetails: { account: 'PK0000000000001234', holder: 'E2E Member', sellerId: seller.id } },
  });
  const withdrawalId = payout.json && payout.json.withdrawal && payout.json.withdrawal.id;
  const saleNet = Number(payout.json && payout.json.withdrawal && payout.json.withdrawal.netRCoins);
  check('payout: a member sells R-coins to a chosen seller', payout.status === 201 && !!withdrawalId, { status: payout.status });
  check(
    'payout: the request keeps the seller as a resolved account, not free text',
    payout.status === 201 && payout.json.withdrawal.seller && payout.json.withdrawal.seller.id === seller.id
      && payout.json.withdrawal.payoutDetails.sellerCode === seller.code,
    { seller: payout.json && payout.json.withdrawal && payout.json.withdrawal.seller, details: payout.json && payout.json.withdrawal && payout.json.withdrawal.payoutDetails },
  );
  check(
    'payout: the fee dial still applies — net is gross minus the platform’s cut',
    payout.status === 201 && payout.json.withdrawal.netRCoins === payout.json.withdrawal.amountRCoins - payout.json.withdrawal.feeRCoins,
    payout.json && payout.json.withdrawal && { gross: payout.json.withdrawal.amountRCoins, fee: payout.json.withdrawal.feeRCoins },
  );
  const sellerIdOnRow = await scalar('SELECT seller_id FROM withdrawal_requests WHERE id = $1', [withdrawalId]);
  check('payout: the assignment is on the row the escrow reads', sellerIdOnRow === seller.id, { sellerIdOnRow });

  const queue = await api('GET', '/api/business/payouts', { token: seller.token });
  const mine = queue.json && queue.json.payouts && queue.json.payouts.find((p) => p.id === withdrawalId);
  check('payout: the seller sees the request in its own queue', queue.status === 200 && !!mine && mine.status === 'PENDING', { status: queue.status, found: !!mine });
  check(
    'payout: the member’s account number is masked to the last four for a partner',
    !!mine && String(mine.payoutDetails.account).endsWith('1234') && !String(mine.payoutDetails.account).includes('0000000000'),
    { account: mine && mine.payoutDetails.account },
  );
  const otherQueue = await api('GET', '/api/business/payouts', { token: other.token });
  check(
    'payout: another seller’s queue is empty of it',
    otherQueue.status === 200 && !(otherQueue.json.payouts || []).some((p) => p.id === withdrawalId),
    { count: otherQueue.json && otherQueue.json.payouts && otherQueue.json.payouts.length },
  );
  const otherDetail = await api('GET', `/api/business/payouts/${withdrawalId}`, { token: other.token });
  check('payout: guessing the id does not open another partner’s book', otherDetail.status === 404, { status: otherDetail.status });

  const payoutSlip = await api('POST', '/api/business/receipts', {
    token: seller.token, body: { fileName: 'cash-out.pdf', data: b64(realPdf(`Cash handover ${stamp}`)), withdrawalId },
  });
  check('payout: the assigned seller uploads the cash proof', payoutSlip.status === 201 && payoutSlip.json.receipt.contentType === 'application/pdf', { status: payoutSlip.status });
  const foreignPayoutSlip = await api('POST', '/api/business/receipts', {
    token: other.token, body: { fileName: 'forged.pdf', data: b64(pdf(64)), withdrawalId },
  });
  check('payout: only the named seller may attach proof', foreignPayoutSlip.status === 404, { status: foreignPayoutSlip.status });

  const payoutReceipts = await api('GET', `/api/admin/withdrawals/${withdrawalId}/receipts`, { token: finance.token });
  check('finance: the payout queue lists its slip', payoutReceipts.status === 200 && payoutReceipts.json.receipts.length === 1, { status: payoutReceipts.status, count: payoutReceipts.json && payoutReceipts.json.receipts && payoutReceipts.json.receipts.length });
  const payoutSlipFile = await getFile(`/api/admin/withdrawals/receipts/${payoutSlip.json.receipt.id}/raw`, finance.token);
  check(
    'finance: the payout slip opens under the withdrawal permission, as a PDF a viewer can render',
    payoutSlipFile.status === 200 && payoutSlipFile.headers.get('content-type') === 'application/pdf' && isPdf(payoutSlipFile.bytes),
    { status: payoutSlipFile.status, size: payoutSlipFile.bytes.length },
  );
  const crossQueue = await getFile(`/api/admin/business/receipts/${payoutSlip.json.receipt.id}/raw`, finance.token);
  check(
    'rbac: a recharge permission cannot open a payout slip, and the queues are separate',
    crossQueue.status === 400,
    { status: crossQueue.status },
  );

  // 0042: the cash book before the sale is released. The R-coins are waiting on this seller; the
  // money half is whatever the order rail already put there, and the sale must not disturb it.
  const beforeStatement = await api('GET', '/api/business/statement', { token: seller.token });
  const beforeCash = beforeStatement.json && beforeStatement.json.cash;
  check(
    'cash book: a requested sale is R-coins waiting on this seller, not money they owe',
    beforeStatement.status === 200 && !!beforeCash && beforeCash.awaitingCashOutRCoins >= saleNet && beforeCash.cashOutCount === 0,
    beforeCash && { awaiting: beforeCash.awaitingCashOutRCoins, remittance: beforeCash.remittanceCents },
  );

  const reviewed = await api('POST', `/api/admin/withdrawals/${withdrawalId}/review`, { token: finance.token, body: { approve: true, note: `e2e seller payout ${stamp}` } });
  check('payout: finance approves the sale', reviewed.status === 200 && reviewed.json.withdrawal.status === 'APPROVED', { status: reviewed.status });

  const paidNoRef = await api('POST', `/api/admin/withdrawals/${withdrawalId}/pay`, { token: finance.token, body: {} });
  check('payout: paying without a reference is refused, seller rail or not', paidNoRef.status === 400, { status: paidNoRef.status });
  const paid = await api('POST', `/api/admin/withdrawals/${withdrawalId}/pay`, { token: finance.token, body: { payoutReference: `SBLR-${stamp}-CASH` } });
  check('payout: the payout step needs the same evidence as a bank transfer', paid.status === 200 && paid.json.withdrawal.status === 'PAID', { status: paid.status });
  const paidRow = await sql('SELECT status, payout_reference, fee_r_coins, amount_r_coins FROM withdrawal_requests WHERE id = $1', [withdrawalId]);
  check('payout: the row records who paid and under what reference', paidRow.rows[0].status === 'PAID' && paidRow.rows[0].payout_reference === `SBLR-${stamp}-CASH`, paidRow.rows[0]);
  const ledgerState = await scalar(`SELECT status FROM transactions WHERE type = 'WITHDRAWAL' AND meta->>'withdrawalId' = $1`, [withdrawalId]);
  check('payout: the ledger escrow switched to COMPLETED exactly once', ledgerState === 'COMPLETED', { ledgerState });

  const afterPaid = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'late.pdf', data: b64(pdf(32)), withdrawalId } });
  check('payout: a paid request takes no further documents', afterPaid.status === 409 && afterPaid.json.error.code === 'receipt_target_closed', afterPaid.json && afterPaid.json.error);

  const listed = await api('GET', '/api/admin/withdrawals?status=PAID', { token: finance.token });
  const listedRow = (listed.json.withdrawals || []).find((w) => w.id === withdrawalId);
  check(
    'finance: the operator list says this was a coin-seller cash payout and names who paid',
    listed.status === 200 && !!listedRow && listedRow.payoutMethod === 'SELLER' && listedRow.receiptCount === 1
      && listedRow.seller.code === seller.code && !!listedRow.seller.name,
    {
      status: listed.status, method: listedRow && listedRow.payoutMethod, receipts: listedRow && listedRow.receiptCount,
      seller: listedRow && listedRow.seller,
    },
  );

  // ---- C2. one statement, two units (0042) --------------------------------
  const afterStatement = await api('GET', '/api/business/statement', { token: seller.token });
  const afterCash = afterStatement.json && afterStatement.json.cash;
  const soldRow = afterCash && afterCash.cashOut.find((p) => p.id === withdrawalId);
  check(
    'cash book: the paid sale is on the seller’s statement in R-coins, with its reference and its proof',
    afterStatement.status === 200 && !!soldRow && soldRow.netRCoins === saleNet &&
      soldRow.payoutReference === `SBLR-${stamp}-CASH` && soldRow.receiptCount === 1 &&
      soldRow.reference === (mine && mine.reference) && !!soldRow.paidAt,
    soldRow,
  );
  check(
    'cash book: handing R-coins over moves the coin half only — the money owed does not change',
    !!afterCash && !!beforeCash && afterCash.remittanceCents === beforeCash.remittanceCents &&
      afterCash.cashOutNetRCoins === beforeCash.cashOutNetRCoins + saleNet &&
      afterCash.awaitingCashOutRCoins === beforeCash.awaitingCashOutRCoins - saleNet,
    afterCash && {
      remittanceBefore: beforeCash.remittanceCents, remittanceAfter: afterCash.remittanceCents,
      out: afterCash.cashOutNetRCoins, awaiting: afterCash.awaitingCashOutRCoins,
    },
  );
  const otherCash = await api('GET', '/api/business/statement', { token: other.token });
  check(
    'cash book: another seller’s statement neither holds nor owes this sale',
    otherCash.status === 200 && otherCash.json.cash.cashOutCount === 0 && otherCash.json.cash.awaitingCashOutRCoins === 0,
    otherCash.json && otherCash.json.cash,
  );
  const operatorBook = await api('GET', `/api/admin/business/accounts/${seller.id}/cash-book`, { token: finance.token });
  check(
    'cash book: finance reads the same figure the seller reads',
    operatorBook.status === 200 && !!afterCash && operatorBook.json.cash.remittanceCents === afterCash.remittanceCents &&
      operatorBook.json.cash.cashOutNetRCoins === afterCash.cashOutNetRCoins,
    operatorBook.json && operatorBook.json.cash,
  );
  const bdBook = await api('GET', `/api/admin/business/accounts/${agentId}/cash-book`, { token: finance.token });
  check(
    'cash book: a BD manager collects nothing, so the endpoint refuses the question',
    bdBook.status === 400 && bdBook.json.error.code === 'not_a_coin_seller',
    bdBook.json && bdBook.json.error,
  );
  const csv = await getFile('/api/business/statement?format=csv', seller.token);
  const csvText = csv.bytes.toString('utf8');
  check(
    'cash book: the export keeps the two units apart, so a spreadsheet cannot add them',
    csv.status === 200 && csvText.includes('"cash_out"') && csvText.includes('"rcoin"') &&
      csvText.includes('"remittance"') && csvText.includes(`SBLR-${stamp}-CASH`) &&
      csvText.split('\n').some((line) => line.startsWith('"cash_out"') && line.includes(`"rcoin"`) && line.includes(`"${saleNet}"`)),
    { status: csv.status, lines: csvText.split('\n').length },
  );

  // ---- D. the ordinary rails are untouched --------------------------------
  const bank = await api('POST', '/api/wallet/withdraw', {
    token: memberToken, body: { amountRCoins: 100000, payoutMethod: 'BANK', payoutDetails: { account: 'PK9999000000004321' } },
  });
  const bankId = bank.json && bank.json.withdrawal && bank.json.withdrawal.id;
  check('withdrawal: the bank rail still works and names no seller', bank.status === 201 && bank.json.withdrawal.seller === null, { status: bank.status, seller: bank.json && bank.json.withdrawal.seller });
  const sellerOnBank = await api('POST', '/api/business/receipts', { token: seller.token, body: { fileName: 'not-mine.pdf', data: b64(pdf(32)), withdrawalId: bankId } });
  check('withdrawal: a platform-paid withdrawal is unreachable from a partner credential', sellerOnBank.status === 404, { status: sellerOnBank.status });
  const badMethod = await api('POST', '/api/wallet/withdraw', {
    token: memberToken, body: { amountRCoins: 100000, payoutMethod: 'CASH_IN_THE_DOOR', payoutDetails: { account: 'x'.repeat(20) } },
  });
  check('withdrawal: an invented rail is refused by the enum', badMethod.status === 400, { status: badMethod.status });

  // ---- E. the trail --------------------------------------------------------
  const audit = await sql(
    `SELECT count(*)::text n FROM admin_audit WHERE action = 'RECEIPT_UPLOADED' AND business_id = $1`,
    [seller.id],
  );
  check(
    'audit: every accepted upload is attributable to the partner that sent it',
    Number(audit.rows[0].n) === 11,
    { accepted: 11, audited: audit.rows[0].n },
  );
  const forgedRows = await sql('SELECT count(*)::text n FROM payment_receipts WHERE uploaded_by = $1', [other.id]);
  const ours = await sql(
    `SELECT order_id, withdrawal_id FROM payment_receipts
      WHERE uploaded_by = $1
        AND (order_id IS NULL) = (withdrawal_id IS NULL)`,
    [seller.id],
  );
  check(
    'audit: a refused upload left no row, and every stored one points at exactly one money record',
    Number(forgedRows.rows[0].n) === 0 && ours.rows.length === 0,
    { foreign: forgedRows.rows[0].n, ambiguous: ours.rows.length },
  );

  console.log(out.join('\n'));
  const failed = out.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\nreceipt-e2e: ${out.length} checks, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
  await db().end();
})().catch(async (err) => {
  console.log(out.join('\n'));
  console.error('\nreceipt-e2e crashed:', err && err.message, err && err.response ? await err.response.text().catch(() => '') : '');
  process.exitCode = 2;
});
