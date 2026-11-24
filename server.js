'use strict';
/*
 * Duck Runner — online server.
 *   npm install
 *   npm start            → http://localhost:3000
 *
 * Serves the game page and a small JSON API for accounts and rooms.
 * Settings come from .env (see .env.example).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
if (fs.existsSync(path.join(ROOT, '.env')) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(path.join(ROOT, '.env'));
}

const db = require('./server/db');
const accounts = require('./server/accounts');
const rooms = require('./server/rooms');

const COOKIE = 'goose_sid';
const MAX_BODY = 10 * 1024;

/* ---------------- Static files (whitelist: never serve .env or the server code) ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };
function staticPath(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') return 'index.html';
  if (urlPath === '/style.css') return 'style.css';
  const m = urlPath.match(/^\/(icons|images)\/([a-z0-9_-]+\.(svg|png|jpg|gif))$/i);
  return m ? path.join(m[1], m[2]) : null;
}

/* ---------------- Small HTTP helpers ---------------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      // Also blocks cross-site HTML form posts (CSRF): they can't send JSON.
      return reject(new HttpError(415, 'Expected a JSON body.'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted || process.env.NODE_ENV === 'production';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` + (secure ? '; Secure' : '');
}

/* ---------------- Brute-force protection on login/register ---------------- */
const attempts = new Map(); // ip -> { count, reset }
function rateLimit(req, limit = 20, windowMs = 10 * 60 * 1000) {
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) { a = { count: 0, reset: now + windowMs }; attempts.set(ip, a); }
  if (++a.count > limit) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  if (attempts.size > 10000) for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
}

/* ---------------- Room polling shortcut ----------------
   Clients poll every second. This process is the only writer, so it remembers
   each room's last event number and answers "nothing new" without the database. */
const knownSeq = new Map(); // code -> seq
function remember(room, code) {
  if (room) knownSeq.set(room.code, room.seq);
  else knownSeq.delete(code);
}

/* ---------------- API ---------------- */
async function currentUser(req) {
  const token = cookies(req)[COOKIE];
  return token ? db.userForSession(accounts.hashToken(token)) : null;
}
async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'Please log in.');
  return user;
}
function codeFrom(raw) {
  const code = rooms.normalizeCode(raw);
  if (!code) throw new HttpError(404, 'No game has this code.');
  return code;
}
function requireMember(room, user) {
  if (!room) throw new HttpError(404, 'No game has this code.');
  if (!room.seats.some((s) => s.userId === user.id)) throw new HttpError(403, 'Join this game first.');
}

async function startSession(req, res, user, status) {
  const token = accounts.newSessionToken();
  await db.createSession(accounts.hashToken(token), user.id);
  send(res, status, { user: { id: user.id, username: user.username } },
    { 'Set-Cookie': sessionCookie(req, token, accounts.SESSION_DAYS * 86400) });
}

/** Runs a room action under a row lock and answers with the member's view. */
async function act(res, code, user, since, change) {
  const result = await db.updateRoom(code, (room) => {
    requireMember(room, user);
    return change(room);
  });
  if (!result) throw new HttpError(404, 'No game has this code.');
  remember(result.after, code);
  if (!result.after) return send(res, 200, { closed: true });
  send(res, 200, { room: rooms.view(result.after, since) });
}

const routes = [
  ['POST', /^\/api\/register$/, async (req, res) => {
    rateLimit(req);
    const { username, password } = await readJson(req);
    const problem = accounts.checkCredentials(username, password);
    if (problem) throw new HttpError(400, problem);
    const user = await db.createUser(username, await accounts.hashPassword(password));
    if (!user) throw new HttpError(409, 'This username is already taken.');
    await startSession(req, res, user, 201);
  }],

  ['POST', /^\/api\/login$/, async (req, res) => {
    rateLimit(req);
    const { username, password } = await readJson(req);
    const user = typeof username === 'string' && typeof password === 'string' ? await db.findUserByName(username) : null;
    if (!user || !(await accounts.verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, 'Wrong username or password.');
    }
    await startSession(req, res, user, 200);
  }],

  ['POST', /^\/api\/logout$/, async (req, res) => {
    const token = cookies(req)[COOKIE];
    if (token) await db.deleteSession(accounts.hashToken(token));
    send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }],

  ['GET', /^\/api\/me$/, async (req, res) => {
    const user = await currentUser(req);
    if (!user) return send(res, 200, { user: null });
    send(res, 200, { user, roomCode: await db.currentRoomCode(user.id) });
  }],

  ['POST', /^\/api\/rooms$/, async (req, res) => {
    const user = await requireUser(req);
    for (let tries = 0; tries < 10; tries++) {
      const room = rooms.createRoom(rooms.generateRoomCode(), user);
      if (await db.insertRoom(room)) {
        remember(room);
        return send(res, 201, { room: rooms.view(room, 0) });
      }
    }
    throw new HttpError(503, 'Could not create a game code, please retry.');
  }],

  ['GET', /^\/api\/rooms\/([^/]+)$/, async (req, res, m, url) => {
    const user = await requireUser(req);
    const code = codeFrom(m[1]);
    const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : -1;
    if (Number.isInteger(since) && since >= 0 && knownSeq.get(code) === since) {
      return send(res, 200, { unchanged: true, seq: since });
    }
    const room = await db.getRoom(code);
    requireMember(room, user);
    remember(room);
    send(res, 200, { room: rooms.view(room, since) });
  }],

  ['POST', /^\/api\/rooms\/([^/]+)\/(join|start|roll|answer|leave)$/, async (req, res, m) => {
    const user = await requireUser(req);
    const code = codeFrom(m[1]);
    const body = await readJson(req);
    const since = Number.isInteger(body.since) ? body.since : -1;
    const action = m[2];

    if (action === 'join') {
      const result = await db.updateRoom(code, (room) => rooms.joinRoom(room, user));
      if (!result) throw new HttpError(404, 'No game has this code.');
      remember(result.after);
      return send(res, 200, { room: rooms.view(result.after, -1) });
    }
    const change = {
      start: (room) => rooms.startGame(room, user),
      roll: (room) => rooms.roll(room, user),
      answer: (room) => rooms.answer(room, user, body.choice),
      leave: (room) => rooms.leave(room, user)
    }[action];
    await act(res, code, user, since, change);
  }]
];

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (url.pathname.startsWith('/api/')) {
    try {
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await fn(req, res, m, url);
      }
      throw new HttpError(404, 'Not found.');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[api]', req.method, url.pathname, err);
      return send(res, status, { error: status === 500 ? 'Server error, please retry.' : err.message });
    }
  }

  const file = req.method === 'GET' || req.method === 'HEAD' ? staticPath(url.pathname) : null;
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

async function start(options = {}) {
  db.connect(options);
  await db.migrate();
  const server = http.createServer(handle);
  const port = options.port !== undefined ? options.port : Number(process.env.PORT) || 3000;
  await new Promise((resolve) => server.listen(port, resolve));
  const timer = setInterval(() => db.cleanup().catch((e) => console.error('[db] cleanup:', e.message)), 60 * 60 * 1000);
  timer.unref();
  db.cleanup().catch(() => {});
  return server;
}

if (require.main === module) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('Database address missing in .env: paste your Neon connection string as DATABASE_URL=postgresql://... (or fill PGHOST). See .env.example.');
    process.exit(1);
  }
  start().then((server) => {
    console.log('✓ Connected to the database, tables ready.');
    console.log(`🦆 Duck Runner is running on http://localhost:${server.address().port}`);
  }).catch((err) => {
    console.error('Could not start:', err.message);
    process.exit(1);
  });
}

module.exports = { start };
