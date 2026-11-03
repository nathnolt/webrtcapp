// WebRTC demo server
//  - HTTP(S) static file server for the demo page (plain node:http, no framework)
//  - WebSocket signaling (rooms with a host-chosen size, see signaling.js) that relays offer/answer/ICE candidates
//  - A minimal built-in STUN server (UDP) so you don't need an external one
//  - /api/ice-config tells the browser which ICE servers to use (STUN + optional TURN)

import http from 'http';
import https from 'https';
import fs from 'fs';
import dgram from 'dgram';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Hub } from './signaling.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HTTP_PORT = Number(process.env.PORT || 3000);
const STUN_PORT = Number(process.env.STUN_PORT || 3478);
const STUN_ENABLED = process.env.STUN !== 'off';
// Hard safety limit for "no limit" rooms (everyone connects to everyone, so big rooms melt browsers)
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE || 50);
// Optional TURN (you need to run a real TURN server such as coturn, see README)
const TURN_URL = process.env.TURN_URL; // e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349"
const TURN_USER = process.env.TURN_USER;
const TURN_PASS = process.env.TURN_PASS;
// Optional HTTPS (needed for camera/mic on any non-localhost origin)
const SSL_KEY = process.env.SSL_KEY;
const SSL_CERT = process.env.SSL_CERT;

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ───────────────────────── HTTP (plain node:http, no framework) ─────────────────────────
// Normally the page lives in ./public. If index.html is sitting right next to server.js instead
// ("flat" layout), serve from there, but only index.html and app.js (never server.js etc.).
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const FLAT_LAYOUT = PUBLIC_DIR === __dirname;
const FLAT_ALLOWED = new Set(['index.html', 'app.js']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end('Bad request'); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  // Block path traversal ("/../server.js" etc.)
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  if (FLAT_LAYOUT && !FLAT_ALLOWED.has(path.relative(PUBLIC_DIR, file))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found. Looked in: ${PUBLIC_DIR}\nMake sure index.html and app.js are in a "public" folder next to server.js.`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function requestListener(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  const url = new URL(req.url, 'http://placeholder');
  if (url.pathname === '/api/ice-config') {
    const host = (req.headers.host || 'localhost').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '[$1]');
    const iceServers = [];
    if (STUN_ENABLED) iceServers.push({ urls: `stun:${host}:${STUN_PORT}` });
    if (TURN_URL && TURN_USER && TURN_PASS) {
      iceServers.push({ urls: TURN_URL.split(','), username: TURN_USER, credential: TURN_PASS });
    }
    return sendJson(res, 200, { iceServers });
  }
  serveStatic(req, res, url.pathname);
}

const server = SSL_KEY && SSL_CERT
  ? https.createServer({ key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) }, requestListener)
  : http.createServer(requestListener);

// ───────────────────────── Signaling ─────────────────────────
// Room logic lives in signaling.js (so it can be tested without sockets); this is just the WebSocket glue.
const hub = new Hub({ maxRoomSize: MAX_ROOM_SIZE, log });
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const conn = hub.connect({ send: (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj)) });
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  log(`ws connect ${conn.id} from ${req.socket.remoteAddress}`);
  ws.on('message', (raw) => hub.message(conn, raw.toString()));
  ws.on('close', () => hub.disconnect(conn));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ───────────────────────── STUN (RFC 5389 Binding only) ─────────────────────────
// A STUN server does one thing: tell a client "this is the public IP:port I see you coming from".
// That is the whole protocol we need to implement.
const MAGIC_COOKIE = 0x2112a442;

function handleStun(sock, msg, rinfo) {
  if (msg.length < 20) return;
  const type = msg.readUInt16BE(0);
  const cookie = msg.readUInt32BE(4);
  if (type !== 0x0001 || cookie !== MAGIC_COOKIE) return; // only Binding Requests

  const ip = rinfo.address.split('.').map(Number);
  const attr = Buffer.alloc(12); // XOR-MAPPED-ADDRESS, IPv4
  attr.writeUInt16BE(0x0020, 0);
  attr.writeUInt16BE(8, 2);
  attr.writeUInt8(0x01, 5); // family IPv4
  attr.writeUInt16BE(rinfo.port ^ (MAGIC_COOKIE >>> 16), 6);
  const cookieBytes = msg.subarray(4, 8);
  for (let i = 0; i < 4; i++) attr[8 + i] = ip[i] ^ cookieBytes[i];

  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0101, 0); // Binding Success Response
  header.writeUInt16BE(attr.length, 2);
  msg.copy(header, 4, 4, 20); // magic cookie + transaction id
  sock.send(Buffer.concat([header, attr]), rinfo.port, rinfo.address);
  log(`STUN binding: told ${rinfo.address}:${rinfo.port} that it is ${rinfo.address}:${rinfo.port}`);
}

if (STUN_ENABLED) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (m, r) => handleStun(sock, m, r));
  sock.on('error', (e) => log('STUN error:', e.message));
  sock.bind(STUN_PORT, () => log(`STUN server listening on udp/${STUN_PORT}`));
}

// HOST=127.0.0.1 keeps Node private so only a reverse proxy (Apache) can reach it.
server.listen(HTTP_PORT, process.env.HOST || undefined, () => {
  const proto = SSL_KEY ? 'https' : 'http';
  log(`Serving files from: ${PUBLIC_DIR}${FLAT_LAYOUT ? ' (flat layout; index.html + app.js only)' : ''}`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) log('WARNING: index.html not found there, the page will 404!');
  log(`Demo page:  ${proto}://localhost:${HTTP_PORT}`);
  log(`Signaling:  ${proto === 'https' ? 'wss' : 'ws'}://localhost:${HTTP_PORT}/ws`);
  log(TURN_URL ? `TURN configured: ${TURN_URL}` : 'No TURN configured (set TURN_URL/TURN_USER/TURN_PASS)');
});
