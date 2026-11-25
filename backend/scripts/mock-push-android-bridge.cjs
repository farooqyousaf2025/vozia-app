#!/usr/bin/env node
/**
 * CI-only Socket.IO bridge for the Android mock-push instrumentation test.
 * It accepts one synthetic test token and emits the same private push:mock
 * payload shape as the backend. It binds only to loopback on the CI host.
 */
const http = require('http');
const { Server } = require('socket.io');

const TOKEN = 'vozia-android-mock-push-integration-token';
const PORT = Number(process.env.ANDROID_MOCK_PUSH_PORT || 4000);
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (req.url === '/drop-transport') {
    const sockets = [...io.sockets.sockets.values()];
    sockets.forEach((socket) => socket.conn.close());
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ disconnected: sockets.length }));
  }
  res.writeHead(404);
  res.end();
});
const io = new Server(httpServer, { path: '/socket.io', cors: { origin: '*' } });
let connectionCount = 0;

io.use((socket, next) => {
  if (socket.handshake.auth?.token !== TOKEN) return next(new Error('unauthorized'));
  next();
});
io.on('connection', (socket) => {
  connectionCount += 1;
  const firstConnection = connectionCount === 1;
  socket.emit('push:mock', {
    title: firstConnection ? 'Android socket mock push integration' : 'Android socket reconnect mock push',
    body: firstConnection
      ? 'Received through VoizaSocketClient and posted by VoizaNotifier'
      : `Received after authenticated Socket.IO reconnect #${connectionCount}`,
    data: { type: 'integration_test', source: 'ci_socket_bridge', connection: String(connectionCount) },
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  process.stdout.write('Android mock-push Socket.IO bridge listening on ' + PORT + '\\n');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => io.close(() => process.exit(0)));
}
