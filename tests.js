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

console.log('\nDuck Runner — logic tests\n');

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

/* ---------- Special squares (board picture: images/board.jpg) ---------- */
test('8 → 13 (shortcut), no question on 13', () => {
  const r = L.playRoll(gameAt(5), 3);
  eq(r.landing, 8);
  eq(r.effects.map((e) => [e.from, e.to]), [[8, 13]]);
  eq(r.state.players[0].pos, 13);
  eq(r.questionId, null);
  eq(r.state.phase, 'turnEnd');
});

test('21 → 25 (shortcut), no question on 25', () => {
  const r = L.playRoll(gameAt(18), 3);
  eq(r.effects.map((e) => [e.from, e.to]), [[21, 25]]);
  eq(r.state.players[0].pos, 25);
  eq(r.questionId, null);
});

test('24 → 28 (bridge), no question', () => {
  const r = L.playRoll(gameAt(20), 4);
  eq(r.landing, 24);
  eq(r.state.players[0].pos, 28);
  eq(r.questionId, null);
  eq(r.state.phase, 'turnEnd');
});

test('29 → 5 (boat), then the rest square 5 applies (nothing happens)', () => {
  const r = L.playRoll(gameAt(27), 2);
  eq(r.landing, 29);
  eq(r.effects.map((e) => [e.kind, e.from, e.to]), [['goto', 29, 5], ['rest', 5, 5]]);
  eq(r.state.players[0].pos, 5);
  eq(r.questionId, null);
});

test('5, 16 and 27 (rest): no question, no move', () => {
  for (const [from, roll, target] of [[3, 2, 5], [14, 2, 16], [25, 2, 27]]) {
    const r = L.playRoll(gameAt(from), roll);
    eq(r.state.players[0].pos, target);
    eq(r.questionId, null);
    eq(r.effects.length, 1);
    eq(r.effects[0].kind, 'rest');
    eq(r.state.phase, 'turnEnd');
  }
});

test('12 (shark): the player skips exactly 1 turn (2 players)', () => {
  let g = gameAt(10, 2);
  const r = L.playRoll(g, 2);                // P1 lands on 12
  eq(r.state.players[0].pos, 12);
  eq(r.state.players[0].skip, 1);
  eq(r.questionId, null);
  g = r.state;
  const order = [];
  for (let k = 0; k < 4; k++) {
    g = L.advanceTurn(g).state;
    order.push(g.current);
    g.players[g.current].pos = 14;           // next roll of 2 → 16 (rest)
    g = L.playRoll(g, 2).state;
  }
  eq(order, [1, 1, 0, 1], 'P2, P2 (P1 skips once), then P1 again');
});

test('26 (whirlpool): the player skips exactly 2 turns (2 players)', () => {
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

test('26 (whirlpool): solo player skips 2 turns then plays', () => {
  let g = L.playRoll(gameAt(20, 1), 6).state;
  const a = L.advanceTurn(g);
  eq(a.skipped.map((s) => s.remaining), [1, 0]);
  eq(a.state.current, 0);
  eq(a.state.players[0].skip, 0);
  eq(a.state.phase, 'roll');
});

/* ---------- Finish rules ---------- */
test('bounce: from 31 with a 3 → 32 then back 2 → 30 (question)', () => {
  const r = L.playRoll(gameAt(31), 3);
  eq(r.path, [32, 31, 30]);
  eq(r.bounced, true);
  eq(r.state.players[0].pos, 30);
  ok(r.questionId !== null, 'square 30 asks a question');
  eq(r.state.phase, 'question');
});

test('bounce onto a special square applies it: from 31 with a 4 → 29 → 5', () => {
  const r = L.playRoll(gameAt(31), 4);
  eq(r.path, [32, 31, 30, 29]);
  eq(r.landing, 29);
  eq(r.state.players[0].pos, 5);
});

test('exact finish: from 30 with a 2 → 32, game over', () => {
  const r = L.playRoll(gameAt(30, 2), 2);
  eq(r.state.players[0].pos, 32);
  eq(r.finished, true);
  eq(r.state.phase, 'over');
  eq(r.state.winner, 0);
  throws(() => L.playRoll(r.state, 1), 'no roll after the game is over');
  throws(() => L.advanceTurn(r.state), 'no next turn after the game is over');
});

test('ranking: position first, then correct answers', () => {
  const g = gameAt(32, 3);
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

test('wrong answer: one square back, wherever the turn started', () => {
  let r = L.playRoll(gameAt(16), 2);          // 16 → 18, question
  let s = L.answerQuestion(r.state, false);
  eq(s.players[0].pos, 17);
  eq(s.players[0].correct, 0);
  eq(s.players[0].answered, 1);

  r = L.playRoll(gameAt(11), 6);              // 11 → 17, question
  s = L.answerQuestion(r.state, false);
  eq(s.players[0].pos, 16, 'a 6 roll costs only one square, not six');
});

test('wrong answer: the square stepped back to does not trigger its effect', () => {
  // 30 → back to 29 (boat to 5): stays on 29
  let r = L.playRoll(gameAt(28), 2);
  eq(r.state.phase, 'question');
  let s = L.answerQuestion(r.state, false);
  eq(s.players[0].pos, 29);
  // 9 → back to 8 (shortcut to 13): stays on 8
  r = L.playRoll(gameAt(7), 2);
  s = L.answerQuestion(r.state, false);
  eq(s.players[0].pos, 8);
  // 27 is rest, 26 the whirlpool: 28 → back to 27, no skip
  r = L.playRoll(gameAt(25), 3);
  s = L.answerQuestion(r.state, false);
  eq(s.players[0].pos, 27);
  eq(s.players[0].skip, 0);
});

test('wrong answer on square 1: back to START, never below', () => {
  const r = L.playRoll(gameAt(0), 1);
  const s = L.answerQuestion(r.state, false);
  eq(s.players[0].pos, 0);
  eq(L.stepBackFrom(0), 0);
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

/* ---------- Adaptive draw (theme weights) ---------- */
test('weighted draw favors the heavy theme but never repeats a question', () => {
  const rng = mulberry32(7);
  let deck = L.createDeck(L.QUESTIONS.length, rng);
  const seen = new Set(), first20 = { W: 0, U: 0, R: 0, M: 0 };
  for (let i = 0; i < L.QUESTIONS.length; i++) {
    const d = L.drawCard(deck, rng, { W: 1, U: 6, R: 1, M: 1 });
    ok(!seen.has(d.id), 'question repeated: ' + d.id);
    seen.add(d.id);
    if (i < 20) first20[L.QUESTIONS[d.id].t]++;
    deck = d.deck;
  }
  eq(seen.size, L.QUESTIONS.length);
  ok(first20.U >= 9, 'expected mostly U questions first, got ' + JSON.stringify(first20));
});
test('weighted draw only picks themes still in the pile', () => {
  const uOnly = L.QUESTIONS.map((q, i) => (q.t === 'U' ? i : -1)).filter((i) => i >= 0);
  const d = L.drawCard({ draw: uOnly.slice(), discard: [], last: null }, mulberry32(1), { W: 100, U: 1 });
  eq(L.QUESTIONS[d.id].t, 'U');
});
test('playRoll passes the weights to the draw', () => {
  let hits = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = L.createGame([{ name: 'A', color: '#000' }], { rng: mulberry32(seed) });
    const r = L.playRoll(g, 1, mulberry32(seed + 100), { W: 0.01, U: 0.01, R: 50, M: 0.01 });
    if (L.QUESTIONS[r.questionId].t === 'R') hits++;
  }
  ok(hits >= 36, 'R drawn ' + hits + '/40 times');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
