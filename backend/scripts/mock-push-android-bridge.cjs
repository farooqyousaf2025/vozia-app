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
  res.writeHead(404);
  res.end();
});
const io = new Server(httpServer, { path: '/socket.io', cors: { origin: '*' } });

io.use((socket, next) => {
  if (socket.handshake.auth?.token !== TOKEN) return next(new Error('unauthorized'));
  next();
});
io.on('connection', (socket) => {
  socket.emit('push:mock', {
    title: 'Android socket mock push integration',
    body: 'Received through VoizaSocketClient and posted by VoizaNotifier',
    data: { type: 'integration_test', source: 'ci_socket_bridge' },
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  process.stdout.write('Android mock-push Socket.IO bridge listening on ' + PORT + '\\n');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => io.close(() => process.exit(0)));
}
