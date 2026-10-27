/* A recording HTTP sink for the LiveKit webhook: prints exactly what the SFU
   delivers (headers, raw bytes, and the claims inside the delivery JWT) so the
   signature contract can be verified against a real server instead of the docs.

     node scripts/livekit-webhook-sink.cjs [port]

   Then point a LiveKit instance at it, e.g. keys:
     webhook: { urls: ["http://127.0.0.1:4111/"], api_key: <key> }
   and create/finish a room. `match` compares the sha256 claim with the digest of
   the received bytes — the check backend/src/controllers/livekit.controller.ts
   makes, and the reason that route must buffer raw bytes rather than parsed JSON. */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.argv[2] || 4111);

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const auth = req.headers.authorization || req.headers.authorize || '';
    let claims = {};
    try {
      claims = JSON.parse(Buffer.from(auth.replace(/^Bearer\s+/i, '').split('.')[1], 'base64url').toString('utf8'));
    } catch (e) {
      claims = { parseError: e.message };
    }
    const digest = crypto.createHash('sha256').update(raw).digest('base64');
    console.log(JSON.stringify({
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'],
      authHeaderName: req.headers.authorization ? 'authorization' : req.headers.authorize ? 'authorize' : 'none',
      authStartsWithBearer: /^Bearer\s/i.test(auth),
      rawLen: raw.length,
      claimKind: claims.kind,
      claimIssuer: claims.iss,
      claimSha256: claims.sha256,
      digestMatchesBody: digest === claims.sha256,
      event: (() => { try { return JSON.parse(raw.toString('utf8')).event; } catch { return null; } })(),
    }));
    // 500 keeps LiveKit retrying, which also proves its redelivery behaviour.
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('sink');
  });
}).listen(PORT, '127.0.0.1', () => console.log(`webhook sink listening on http://127.0.0.1:${PORT}/`));
