/*
 * Game logic tests — run with:  node tests.js
 *
 * The logic is NOT duplicated: this file extracts the <script id="game-logic">
 * block from index.html and runs it, so the tests always check the real game.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- Load the logic from index.html ---------- */
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const match = html.match(/<script id="game-logic">([\s\S]*?)<\/script>/);
if (!match) { console.error('Could not find <script id="game-logic"> in index.html'); process.exit(1); }
const sandbox = { module: { exports: {} } };
vm.runInNewContext(match[1], sandbox, { filename: 'index.html#game-logic' });
const L = sandbox.module.exports;

/* ---------- Tiny test harness ---------- */
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + b + ', got ' + a);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function throws(fn, msg) { let t = false; try { fn(); } catch (e) { t = true; } if (!t) throw new Error(msg || 'expected an error'); }

/* Seeded RNG so the tests are deterministic */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A game with the given players, the first one placed on `pos`. */
function gameAt(pos, nPlayers = 1) {
  const players = Array.from({ length: nPlayers }, (_, i) => ({ name: 'P' + (i + 1), color: '#000' }));
  const g = L.createGame(players, { rng: mulberry32(42) });
  g.players[0].pos = pos;
  return g;
}

console.log('\nGoose Game — logic tests\n');

/* ---------- Data ---------- */
test('50 well-formed questions with valid themes', () => {
  eq(L.QUESTIONS.length, 50);
  for (const [i, q] of L.QUESTIONS.entries()) {
    ok(L.THEMES[q.t], 'question ' + i + ' has an unknown theme ' + q.t);
    eq(q.o.length, 4, 'question ' + i + ' options');
    ok(Number.isInteger(q.a) && q.a >= 0 && q.a < 4, 'question ' + i + ' answer index');
    ok(q.q && q.e, 'question ' + i + ' text/explanation');
  }
});

/* ---------- Special squares ---------- */
test('21 → 24 → 28 (bonus then bridge), no question', () => {
  const r = L.playRoll(gameAt(18), 3);
  eq(r.landing, 21);
  eq(r.effects.map((e) => [e.from, e.to]), [[21, 24], [24, 28]]);
  eq(r.state.players[0].pos, 28);
  eq(r.questionId, null);
  eq(r.state.phase, 'turnEnd');
});

test('12 → 9 (shark), no question on 9', () => {
  const r = L.playRoll(gameAt(10), 2);
  eq(r.state.players[0].pos, 9);
  eq(r.questionId, null);
  eq(r.state.pending, null);
  eq(r.state.phase, 'turnEnd');
});

test('29 → 5 (boat)', () => {
  const r = L.playRoll(gameAt(27), 2);
  eq(r.landing, 29);
  eq(r.state.players[0].pos, 5);
  eq(r.questionId, null);
});

test('8 → 11 (bonus), no question on 11', () => {
  const r = L.playRoll(gameAt(5), 3);
  eq(r.state.players[0].pos, 11);
  eq(r.questionId, null);
  eq(r.state.phase, 'turnEnd');
});

test('16 and 27 (rest): no question, no move', () => {
  for (const [from, roll, target] of [[14, 2, 16], [25, 2, 27]]) {
    const r = L.playRoll(gameAt(from), roll);
    eq(r.state.players[0].pos, target);
    eq(r.questionId, null);
    eq(r.effects.length, 1);
    eq(r.effects[0].kind, 'rest');
    eq(r.state.phase, 'turnEnd');
  }
});

test('26 (typhoon): the player skips exactly 2 turns (2 players)', () => {
  let g = gameAt(20, 2);
  let r = L.playRoll(g, 6);                  // P1 lands on 26
  eq(r.state.players[0].pos, 26);
  eq(r.state.players[0].skip, 2);
  eq(r.questionId, null);
  g = r.state;

  // Play 6 turn changes; P2 always lands on a rest square to keep it simple.
  const order = [];
  let skips = 0;
  for (let k = 0; k < 6; k++) {
    const a = L.advanceTurn(g);
    skips += a.skipped.filter((s) => s.player === 0).length;
    g = a.state;
    order.push(g.current);
    g.players[g.current].pos = 14;           // next roll of 2 → 16 (rest)
    g = L.playRoll(g, 2).state;
  }
  eq(skips, 2, 'number of skipped turns');
  eq(order, [1, 1, 1, 0, 1, 0], 'who played: P2, P2 (P1 skips), P2 (P1 skips), then P1 again');
});

test('26 (typhoon): solo player skips 2 turns then plays', () => {
  let g = L.playRoll(gameAt(20, 1), 6).state;
  const a = L.advanceTurn(g);
  eq(a.skipped.map((s) => s.remaining), [1, 0]);
  eq(a.state.current, 0);
  eq(a.state.players[0].skip, 0);
  eq(a.state.phase, 'roll');
});

/* ---------- Finish rules ---------- */
test('bounce: from 31 with a 5 → 33 then back 3 → 30 (question)', () => {
  const r = L.playRoll(gameAt(31), 5);
  eq(r.path, [32, 33, 32, 31, 30]);
  eq(r.bounced, true);
  eq(r.state.players[0].pos, 30);
  ok(r.questionId !== null, 'square 30 asks a question');
  eq(r.state.phase, 'question');
});

test('bounce onto a special square applies it: from 31 with a 6 → 29 → 5', () => {
  const r = L.playRoll(gameAt(31), 6);
  eq(r.landing, 29);
  eq(r.state.players[0].pos, 5);
});

test('exact finish: from 30 with a 3 → 33, game over', () => {
  const r = L.playRoll(gameAt(30, 2), 3);
  eq(r.state.players[0].pos, 33);
  eq(r.finished, true);
  eq(r.state.phase, 'over');
  eq(r.state.winner, 0);
  throws(() => L.playRoll(r.state, 1), 'no roll after the game is over');
  throws(() => L.advanceTurn(r.state), 'no next turn after the game is over');
});

test('ranking: position first, then correct answers', () => {
  const g = gameAt(33, 3);
  g.players[1].pos = 20; g.players[1].correct = 1;
  g.players[2].pos = 20; g.players[2].correct = 4;
  eq(L.ranking(g).map((p) => p.name), ['P1', 'P3', 'P2']);
});

/* ---------- Questions ---------- */
test('right answer: stay on the square, +1 correct', () => {
  const r = L.playRoll(gameAt(2), 1);         // → 3, a question square
  eq(r.state.phase, 'question');
  const s = L.answerQuestion(r.state, true);
  eq(s.players[0].pos, 3);
  eq(s.players[0].correct, 1);
  eq(s.phase, 'turnEnd');
});

test('wrong answer: back to the start square, special effect not re-triggered', () => {
  // Start of turn on 26 (typhoon) after the skips are over
  let g = gameAt(26);
  let r = L.playRoll(g, 4);                   // → 30, question
  eq(r.state.phase, 'question');
  let s = L.answerQuestion(r.state, false);
  eq(s.players[0].pos, 26);
  eq(s.players[0].skip, 0, 'typhoon not re-triggered');
  eq(s.players[0].correct, 0);

  // Start of turn on 16 (rest)
  r = L.playRoll(gameAt(16), 2);              // → 18, question
  s = L.answerQuestion(r.state, false);
  eq(s.players[0].pos, 16);

  // Start of turn on LEAVE
  r = L.playRoll(gameAt(0), 1);
  s = L.answerQuestion(r.state, false);
  eq(s.players[0].pos, 0);
});

test('cannot roll while a question is pending', () => {
  const r = L.playRoll(gameAt(2), 1);
  throws(() => L.playRoll(r.state, 2));
});

/* ---------- Deck ---------- */
test('deck: no repeat before all 50 questions are used, then reshuffles', () => {
  const rng = mulberry32(7);
  let deck = L.createDeck(50, rng);
  const seen = [];
  for (let k = 0; k < 150; k++) {
    const d = L.drawCard(deck, rng);
    seen.push(d.id);
    deck = d.deck;
  }
  for (let round = 0; round < 3; round++) {
    const ids = seen.slice(round * 50, round * 50 + 50);
    eq(new Set(ids).size, 50, 'round ' + (round + 1) + ' has 50 distinct questions');
  }
  ok(seen[49] !== seen[50] && seen[99] !== seen[100], 'no immediate repeat after a reshuffle');
});

test('deck inside a game: 50 question squares in a row use 50 different questions', () => {
  let g = gameAt(2);
  const ids = [];
  for (let k = 0; k < 50; k++) {
    g.players[0].pos = 2;
    g.phase = 'roll';
    const r = L.playRoll(g, 1);
    ids.push(r.questionId);
    g = L.answerQuestion(r.state, true);
  }
  eq(new Set(ids).size, 50);
});

/* ---------- Loop protection ---------- */
test('loop protection: chained specials pointing at each other stop', () => {
  const specials = { 5: { action: { kind: 'goto', to: 7 } }, 7: { action: { kind: 'goto', to: 5 } } };
  const res = L.resolveLanding(5, specials);
  eq(res.loopGuard, true);
  eq(res.needsQuestion, false);
  ok(res.effects.length <= L.MAX_CHAIN);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
