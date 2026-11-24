/*
 * Server tests — run with:  node tests-server.js   (or npm test)
 *
 * 1. Accounts and rooms as pure functions.
 * 2. The real HTTP server against an in-memory PostgreSQL (pg-mem), so no
 *    Neon database is needed: two players register, meet with a code and play.
 */
'use strict';
const assert = require('assert');
const accounts = require('./server/accounts');
const rooms = require('./server/rooms');
const L = require('./server/logic');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
const throwsStatus = (fn, status) => assert.throws(fn, (e) => e.status === status);

(async () => {
  console.log('Accounts');
  await test('passwords are hashed with a salt and verified', async () => {
    const h1 = await accounts.hashPassword('secret123');
    const h2 = await accounts.hashPassword('secret123');
    assert.notStrictEqual(h1, h2);
    assert.ok(!h1.includes('secret123'));
    assert.ok(await accounts.verifyPassword('secret123', h1));
    assert.ok(!(await accounts.verifyPassword('secret124', h1)));
    assert.ok(!(await accounts.verifyPassword('x', 'garbage')));
  });
  await test('username and password rules', () => {
    assert.strictEqual(accounts.checkCredentials('Alice_01', 'abcdef'), null);
    assert.strictEqual(accounts.checkCredentials('Élodie', 'abcdef'), null);
    assert.ok(accounts.checkCredentials('ab', 'abcdef'));
    assert.ok(accounts.checkCredentials('bad name', 'abcdef'));
    assert.ok(accounts.checkCredentials('<script>', 'abcdef'));
    assert.ok(accounts.checkCredentials('alice', '12345'));
    assert.ok(accounts.checkCredentials(42, 'abcdef'));
  });

  console.log('Room codes');
  await test('codes have 6 characters with both letters and digits', () => {
    for (let i = 0; i < 2000; i++) {
      const c = rooms.generateRoomCode();
      assert.match(c, /^[A-Z0-9]{6}$/);
      assert.match(c, /[A-Z]/);
      assert.match(c, /[0-9]/);
      assert.doesNotMatch(c, /[01OIL]/);
    }
  });
  await test('codes are varied', () => {
    const set = new Set();
    for (let i = 0; i < 2000; i++) set.add(rooms.generateRoomCode());
    assert.ok(set.size > 1990);
  });
  await test('a code made only of letters (or digits) is redrawn', () => {
    // First 6 draws give "AAAAAA", then the next 6 give "A2A2A2".
    const seq = [0, 0, 0, 0, 0, 0, 0, 23, 0, 23, 0, 23];
    let k = 0;
    assert.strictEqual(rooms.generateRoomCode(() => seq[k++]), 'A2A2A2');
  });
  await test('typed codes are normalized', () => {
    assert.strictEqual(rooms.normalizeCode(' k7p-2xm '), 'K7P2XM');
    assert.strictEqual(rooms.normalizeCode('K7P2X'), null);
    assert.strictEqual(rooms.normalizeCode('K7P2XO'), null); // O is not used
    assert.strictEqual(rooms.normalizeCode("'; DROP"), null);
  });

  console.log('Rooms');
  const alice = { id: 1, username: 'alice' }, bob = { id: 2, username: 'bob' }, carol = { id: 3, username: 'carol' };
  await test('create, join, rejoin, room full', () => {
    let r = rooms.createRoom('K7P2XM', alice);
    r = rooms.joinRoom(r, bob);
    r = rooms.joinRoom(r, bob); // rejoining doesn't add a seat
    assert.deepStrictEqual(r.seats.map((s) => s.username), ['alice', 'bob']);
    for (let i = 3; i <= 6; i++) r = rooms.joinRoom(r, { id: i + 10, username: 'p' + i });
    throwsStatus(() => rooms.joinRoom(r, carol), 409);
  });
  await test('only the host starts; nobody joins after the start', () => {
    let r = rooms.joinRoom(rooms.createRoom('K7P2XM', alice), bob);
    throwsStatus(() => rooms.startGame(r, bob), 403);
    r = rooms.startGame(r, alice);
    assert.strictEqual(r.status, 'playing');
    assert.strictEqual(r.game.players.length, 2);
    throwsStatus(() => rooms.joinRoom(r, carol), 409);
  });
  await test('turns are enforced on the server', () => {
    let r = rooms.startGame(rooms.joinRoom(rooms.createRoom('K7P2XM', alice), bob), alice);
    throwsStatus(() => rooms.roll(r, bob), 409);
    throwsStatus(() => rooms.roll(r, carol), 403);
    throwsStatus(() => rooms.answer(r, alice, 0), 409);
    r = rooms.roll(r, alice, 1); // square 1: a question square
    assert.strictEqual(r.game.phase, 'question');
    throwsStatus(() => rooms.roll(r, alice, 3), 409);
    throwsStatus(() => rooms.answer(r, bob, 0), 409);
    throwsStatus(() => rooms.answer(r, alice, 9), 400);
    const q = L.QUESTIONS[r.game.pending.questionId];
    r = rooms.answer(r, alice, q.a);
    assert.strictEqual(r.game.players[0].pos, 1);
    assert.strictEqual(r.game.players[0].correct, 1);
    assert.strictEqual(r.game.current, 1); // bob's turn now
    assert.strictEqual(r.game.phase, 'roll');
    const ev = r.events[r.events.length - 1];
    assert.strictEqual(ev.type, 'answer');
    assert.strictEqual(ev.correct, true);
  });
  await test('a wrong answer sends the pawn back', () => {
    let r = rooms.startGame(rooms.joinRoom(rooms.createRoom('K7P2XM', alice), bob), alice);
    r = rooms.roll(r, alice, 2);
    const q = L.QUESTIONS[r.game.pending.questionId];
    r = rooms.answer(r, alice, (q.a + 1) % 4);
    assert.strictEqual(r.game.players[0].pos, 0);
  });
  await test('special squares pass the turn without a question', () => {
    let r = rooms.startGame(rooms.joinRoom(rooms.createRoom('K7P2XM', alice), bob), alice);
    r.game.players[0].pos = 5;
    r = rooms.roll(r, alice, 3); // 8 = bonus → 11
    assert.strictEqual(r.game.players[0].pos, 11);
    assert.strictEqual(r.game.current, 1);
  });
  await test('reaching FINISH ends the game; the host can restart', () => {
    let r = rooms.startGame(rooms.joinRoom(rooms.createRoom('K7P2XM', alice), bob), alice);
    r.game.players[0].pos = 30;
    r = rooms.roll(r, alice, 3);
    assert.strictEqual(r.status, 'over');
    assert.strictEqual(r.game.winner, 0);
    r = rooms.startGame(r, alice);
    assert.strictEqual(r.status, 'playing');
    assert.strictEqual(r.game.players[0].pos, 0);
  });
  await test('the deck is never sent to players', () => {
    const r = rooms.startGame(rooms.createRoom('K7P2XM', alice), alice);
    const v = rooms.view(r, -1);
    assert.strictEqual(v.game.deck, undefined);
    assert.ok(!JSON.stringify(v).includes('"deck"'));
  });
  await test('players who leave a game are skipped; the host role moves on', () => {
    let r = rooms.joinRoom(rooms.joinRoom(rooms.createRoom('K7P2XM', alice), bob), carol);
    r = rooms.startGame(r, alice);
    r = rooms.roll(r, alice, 1); // alice must answer…
    r = rooms.leave(r, alice);   // …but leaves
    assert.strictEqual(r.hostId, bob.id);
    assert.strictEqual(r.game.current, 1);
    assert.strictEqual(r.game.players[0].pos, 0);
    r = rooms.roll(r, bob, 2);
    r = rooms.answer(r, bob, 0);
    r = rooms.roll(r, carol, 2);
    r = rooms.answer(r, carol, 0);
    assert.strictEqual(r.game.current, 1); // alice's seat was skipped
    r = rooms.leave(r, bob);
    r = rooms.leave(r, carol);
    assert.strictEqual(r, null);         // empty room → deleted
  });
  await test('leaving the lobby frees the seat', () => {
    let r = rooms.joinRoom(rooms.createRoom('K7P2XM', alice), bob);
    r = rooms.leave(r, alice);
    assert.deepStrictEqual(r.seats.map((s) => s.username), ['bob']);
    assert.strictEqual(r.hostId, bob.id);
    assert.strictEqual(rooms.leave(r, bob), null);
  });
  await test('clients far behind get a re-sync instead of events', () => {
    let r = rooms.startGame(rooms.createRoom('K7P2XM', alice), alice);
    for (let i = 0; i < 60; i++) {
      r = rooms.roll(r, alice, 1 + (i % 6));
      if (r.status === 'over') r = rooms.startGame(r, alice);
      if (r.game.phase === 'question') r = rooms.answer(r, alice, 0);
    }
    assert.strictEqual(rooms.view(r, 1).resync, true);
    const v = rooms.view(r, r.seq - 2);
    assert.strictEqual(v.resync, false);
    assert.deepStrictEqual(v.events.map((e) => e.seq), [r.seq - 1, r.seq]);
  });

  console.log('HTTP server + SQL (in-memory PostgreSQL)');
  let server;
  try {
    const { newDb } = require('pg-mem');
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    server = await require('./server').start({ pool: new Pool(), port: 0 });
  } catch (e) {
    failed++;
    console.log('  ✗ server did not start\n      ' + e.message);
  }
  if (server) {
    const base = 'http://127.0.0.1:' + server.address().port;
    const client = () => {
      let cookie = '';
      return async (method, url, body) => {
        const res = await fetch(base + url, {
          method,
          headers: Object.assign({ cookie }, body !== undefined ? { 'content-type': 'application/json' } : {}),
          body: body !== undefined ? JSON.stringify(body) : undefined
        });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        const text = await res.text();
        const json = /json/.test(res.headers.get('content-type') || '');
        return { status: res.status, body: json && text ? JSON.parse(text) : null, raw: text, headers: res.headers };
      };
    };
    const A = client(), B = client(), C = client();

    await test('static files are served, secrets are not', async () => {
      assert.strictEqual((await A('GET', '/')).status, 200);
      assert.strictEqual((await A('GET', '/style.css')).status, 200);
      const health = await A('GET', '/api/health');
      assert.strictEqual(health.status, 200);
      assert.strictEqual(health.body.ok, true);
      assert.strictEqual((await A('GET', '/icons/shark.svg')).status, 200);
      const logo = await fetch(base + '/images/duck-runner.gif');
      assert.strictEqual(logo.status, 200);
      assert.strictEqual(logo.headers.get('content-type'), 'image/gif');
      for (const p of ['/.env', '/server.js', '/package.json', '/server/db.js', '/icons/../.env', '/%2e%2e/.env']) {
        const r = await fetch(base + p);
        assert.strictEqual(r.status, 404, p);
      }
    });
    await test('register, log in, wrong password, duplicate name', async () => {
      let r = await A('POST', '/api/register', { username: 'Alice', password: 'wonderland' });
      assert.strictEqual(r.status, 201);
      assert.match(r.headers.get('set-cookie'), /HttpOnly/);
      r = await B('POST', '/api/register', { username: 'alice', password: 'whatever1' });
      assert.strictEqual(r.status, 409);
      r = await B('POST', '/api/register', { username: 'Bob', password: 'builder' });
      assert.strictEqual(r.status, 201);
      r = await C('POST', '/api/login', { username: 'bob', password: 'nope-nope' });
      assert.strictEqual(r.status, 401);
      r = await C('POST', '/api/login', { username: 'BOB', password: 'builder' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.user.username, 'Bob');
      r = await A('GET', '/api/me');
      assert.strictEqual(r.body.user.username, 'Alice');
      assert.ok(!r.raw.includes('password'));
    });
    await test('API needs a session and JSON', async () => {
      const anon = client();
      assert.strictEqual((await anon('POST', '/api/rooms', {})).status, 401);
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=a&password=b' });
      assert.strictEqual(r.status, 415);
    });

    let code;
    await test('host creates a room, a friend joins with the code', async () => {
      let r = await A('POST', '/api/rooms', {});
      assert.strictEqual(r.status, 201);
      code = r.body.room.code;
      assert.match(code, /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{6}$/);
      assert.strictEqual((await B('GET', '/api/rooms/' + code + '?since=-1')).status, 403);
      r = await B('POST', '/api/rooms/' + code.toLowerCase() + '/join', {});
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.room.seats.map((s) => s.username), ['Alice', 'Bob']);
      assert.strictEqual((await B('POST', '/api/rooms/ZZZZ22/join', {})).status, 404);
      r = await B('GET', '/api/me');
      assert.strictEqual(r.body.roomCode, code);
    });
    await test('play: start, roll, answer, polling sees the events', async () => {
      assert.strictEqual((await B('POST', `/api/rooms/${code}/start`, {})).status, 403);
      let r = await A('POST', `/api/rooms/${code}/start`, { since: 0 });
      assert.strictEqual(r.status, 200);
      const seq = r.body.room.seq;
      assert.strictEqual((await B('POST', `/api/rooms/${code}/roll`, {})).status, 409);
      r = await A('POST', `/api/rooms/${code}/roll`, { since: seq });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.room.events[0].type, 'roll');
      // Bob's poll sees exactly the new event; a second poll says "unchanged"
      r = await B('GET', `/api/rooms/${code}?since=${seq}`);
      assert.deepStrictEqual(r.body.room.events.map((e) => e.type), ['roll']);
      r = await B('GET', `/api/rooms/${code}?since=${r.body.room.seq}`);
      assert.strictEqual(r.body.unchanged, true);
      let g = (await A('GET', `/api/rooms/${code}?since=-1`)).body.room.game;
      if (g.phase === 'question') {
        r = await A('POST', `/api/rooms/${code}/answer`, { choice: 0 });
        assert.strictEqual(r.status, 200);
        g = r.body.room.game;
      }
      assert.strictEqual(g.current, 1);
      assert.strictEqual((await B('POST', `/api/rooms/${code}/roll`, {})).status, 200);
    });
    await test('log out ends the session', async () => {
      await C('POST', '/api/logout', {});
      assert.strictEqual((await C('GET', '/api/me')).body.user, null);
      assert.strictEqual((await C('POST', '/api/rooms', {})).status, 401);
    });
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
