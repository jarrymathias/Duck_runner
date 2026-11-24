'use strict';
/*
 * Online rooms: join code generation and every room action, as pure functions.
 * A room is plain data; db.js loads it, calls one of these, and saves the result.
 *
 * room = {
 *   code, hostId, status: 'lobby' | 'playing' | 'over',
 *   seats: [{ userId, username, left }],   // seat i plays game.players[i]
 *   game: GooseLogic state | null,
 *   events: [{ seq, type, ... }],          // last MAX_EVENTS, replayed by clients
 *   seq,                                   // number of the last event
 *   gameNo,                                // 1 for the first game, +1 on each restart
 *   chat: [{ id, userId, username, seat, text | emoji, at }], chatSeq
 * }
 * Chat lives apart from the events: messages are shown at once, while game
 * events wait for the animations before them.
 */
const crypto = require('crypto');
const L = require('./logic');

const CODE_LENGTH = 6;
// No 0/O, 1/I/L: codes are read aloud and typed by hand.
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_DIGITS = '23456789';
const CODE_ALPHABET = CODE_LETTERS + CODE_DIGITS;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const MAX_PLAYERS = 6;
const MAX_EVENTS = 40;
const COLORS = ['#dc2626', '#2563eb', '#15803d', '#facc15', '#7c3aed', '#f97316'];

// Question timer. Clients show QUESTION_SECONDS; the deadline also allows for the
// roll animation before the question opens, plus a little network slack.
const QUESTION_SECONDS = 30;
const ANIMATION_ALLOWANCE_MS = 4000;
const GRACE_MS = 1500;

const MAX_CHAT = 30;
const CHAT_MAX_LENGTH = 200;
const REACTIONS = ['👍', '😂', '😮', '😬', '🎉', '🦆'];

class RoomError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Random code with letters AND digits, e.g. "K7P2XM". Uses a CSPRNG. */
function generateRoomCode(randomInt = crypto.randomInt) {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (/[A-Z]/.test(code) && /[0-9]/.test(code)) return code;
  }
}

/** Upper-cases and strips spaces/dashes; returns null if it can't be a code. */
function normalizeCode(input) {
  const code = String(input || '').toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? code : null;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const rng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const seatOf = (room, userId) => room.seats.findIndex((s) => s.userId === userId);

function push(room, event) {
  room.seq += 1;
  room.events.push(Object.assign({ seq: room.seq, at: Date.now() }, event));
  if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
}

/** Game state without the question deck, as sent to the browsers. */
function publicGame(game) {
  if (!game) return null;
  const { deck, ...rest } = game;
  return clone(rest);
}

/**
 * What a member sees. Events newer than `since` are included for animation,
 * chat messages newer than `chatSince` (or the last ones if it's negative).
 */
function view(room, since, chatSince = -1, now = Date.now()) {
  const fresh = Number.isInteger(since) && since >= 0;
  const oldest = room.events.length ? room.events[0].seq : room.seq + 1;
  // If the client is too far behind, it re-syncs from the snapshot without replaying.
  const resync = !fresh || since < oldest - 1 || since > room.seq;
  const chat = room.chat || [];
  const chatFrom = Number.isInteger(chatSince) && chatSince >= 0 && chatSince <= (room.chatSeq || 0) ? chatSince : -1;
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    seats: room.seats.map((s, i) => ({ seat: i, userId: s.userId, username: s.username, left: !!s.left })),
    game: publicGame(room.game),
    gameNo: room.gameNo || 0,
    seq: room.seq,
    resync,
    events: resync ? [] : room.events.filter((e) => e.seq > since),
    chatSeq: room.chatSeq || 0,
    chat: chatFrom < 0 ? chat.slice() : chat.filter((m) => m.id > chatFrom),
    serverNow: now,
    questionSeconds: QUESTION_SECONDS
  };
}

/** When the pending question must be answered by, or null. */
const questionDeadline = (room) =>
  room.status === 'playing' && room.game && room.game.phase === 'question' && room.game.pending
    ? room.game.pending.deadline || null : null;

/** True when the pending question ran out of time (server-side check). */
const isTimedOut = (room, now = Date.now()) => {
  const d = questionDeadline(room);
  return d !== null && now > d + GRACE_MS;
};

function createRoom(code, user) {
  const room = { code, hostId: user.id, status: 'lobby', seats: [], game: null, events: [], seq: 0, gameNo: 0, chat: [], chatSeq: 0 };
  room.seats.push({ userId: user.id, username: user.username, left: false });
  push(room, { type: 'lobby', text: `${user.username} created the room.` });
  return room;
}

function joinRoom(input, user) {
  const room = clone(input);
  const seat = seatOf(room, user.id);
  if (seat >= 0) {
    if (room.seats[seat].left && room.status === 'lobby') {
      room.seats[seat].left = false;
      push(room, { type: 'lobby', text: `${user.username} is back.` });
    }
    return room; // already a member: rejoining is always fine
  }
  if (room.status !== 'lobby') throw new RoomError(409, 'This game has already started.');
  if (room.seats.length >= MAX_PLAYERS) throw new RoomError(409, `This room is full (${MAX_PLAYERS} players max).`);
  room.seats.push({ userId: user.id, username: user.username, left: false });
  push(room, { type: 'lobby', text: `${user.username} joined.` });
  return room;
}

/** Host starts (or restarts) the game with everyone still in the room. */
function startGame(input, user) {
  const room = clone(input);
  if (room.hostId !== user.id) throw new RoomError(403, 'Only the host can start the game.');
  if (room.status === 'playing') throw new RoomError(409, 'The game is already running.');
  room.seats = room.seats.filter((s) => !s.left);
  if (room.seats.length < 1) throw new RoomError(409, 'Nobody is in the room.');
  room.game = L.createGame(room.seats.map((s, i) => ({ name: s.username, color: COLORS[i] })), { rng });
  room.status = 'playing';
  room.gameNo = (room.gameNo || 0) + 1;
  push(room, { type: 'start', gameNo: room.gameNo, text: `Game started! ${room.seats[0].username} goes first.`, state: publicGame(room.game) });
  return room;
}

function requireTurn(room, user, phase) {
  if (room.status !== 'playing' || !room.game) throw new RoomError(409, 'No game is running.');
  const seat = seatOf(room, user.id);
  if (seat < 0) throw new RoomError(403, 'You are not in this game.');
  if (room.game.current !== seat) throw new RoomError(409, "It's not your turn.");
  if (room.game.phase !== phase) throw new RoomError(409, 'You cannot do that now.');
  return seat;
}

/**
 * Ends the turn and moves on, also skipping players who left the game.
 * Returns the skipped turns in order, for the clients to announce.
 */
function passTurn(room) {
  const skipped = [];
  let guard = 0;
  do {
    const res = L.advanceTurn(room.game);
    room.game = res.state;
    skipped.push(...res.skipped);
    if (!room.seats[room.game.current].left) break;
    skipped.push({ player: room.game.current, remaining: 0, left: true });
    room.game.phase = 'turnEnd';
  } while (++guard < 100);
  return skipped;
}

/**
 * `opts.themeWeights`: favors the themes this player gets wrong (see stats.js).
 * `opts.now`: clock, for the question deadline (tests pass their own).
 */
function roll(input, user, value = crypto.randomInt(1, 7), opts = {}) {
  const room = clone(input);
  const seat = requireTurn(room, user, 'roll');
  const now = opts.now || Date.now();
  const res = L.playRoll(room.game, value, rng, opts.themeWeights || null);
  room.game = res.state;
  if (room.game.phase === 'question') {
    room.game.pending.deadline = now + QUESTION_SECONDS * 1000 + ANIMATION_ALLOWANCE_MS;
  }
  const event = {
    type: 'roll', player: seat, roll: res.roll, start: res.start, path: res.path, landing: res.landing,
    bounced: res.bounced, effects: res.effects, finalPos: res.finalPos, finished: res.finished,
    loopGuard: res.loopGuard, questionId: res.questionId, skipped: []
  };
  if (res.finished) room.status = 'over';
  else if (room.game.phase === 'turnEnd') event.skipped = passTurn(room);
  event.state = publicGame(room.game);
  push(room, event);
  return room;
}

/** Settles the pending question: `choice` null means time ran out. */
function settleQuestion(room, choice, timedOut) {
  const seat = room.game.current;
  const { questionId, start, landing } = room.game.pending;
  const correct = !timedOut && choice === L.QUESTIONS[questionId].a;
  room.game = L.answerQuestion(room.game, correct);
  const skipped = passTurn(room);
  push(room, {
    type: 'answer', player: seat, userId: room.seats[seat].userId, questionId,
    choice: timedOut ? null : choice, correct, timedOut, start, landing, skipped, state: publicGame(room.game)
  });
}

/**
 * `choice` is the index of the chosen option in QUESTIONS[id].o (not the
 * shuffled letter). An answer arriving after the deadline counts as "time's up".
 */
function answer(input, user, choice, now = Date.now()) {
  const room = clone(input);
  requireTurn(room, user, 'question');
  const q = L.QUESTIONS[room.game.pending.questionId];
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.o.length) throw new RoomError(400, 'Invalid answer.');
  const late = isTimedOut(room, now);
  settleQuestion(room, late ? null : choice, late);
  return room;
}

/** Ends a question nobody answered in time. Returns the room unchanged otherwise. */
function expireQuestion(input, now = Date.now()) {
  if (!isTimedOut(input, now)) return input;
  const room = clone(input);
  settleQuestion(room, null, true);
  return room;
}

/** A chat message or an emoji reaction from a member. */
function chat(input, user, { text, emoji } = {}, now = Date.now()) {
  const room = clone(input);
  const seat = seatOf(room, user.id);
  if (seat < 0) throw new RoomError(403, 'You are not in this game.');
  const msg = { userId: user.id, username: user.username, seat, at: now };
  if (emoji !== undefined) {
    if (!REACTIONS.includes(emoji)) throw new RoomError(400, 'Unknown reaction.');
    msg.emoji = emoji;
  } else {
    // Collapse whitespace and drop control characters; the page shows it as plain text.
    const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) throw new RoomError(400, 'Empty message.');
    if ([...clean].length > CHAT_MAX_LENGTH) throw new RoomError(400, `Messages are limited to ${CHAT_MAX_LENGTH} characters.`);
    msg.text = clean;
  }
  room.chat = room.chat || [];
  room.chatSeq = (room.chatSeq || 0) + 1;
  room.chat.push(Object.assign({ id: room.chatSeq }, msg));
  if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
  return room;
}

/**
 * Leaving the lobby frees the seat. Leaving a started game keeps the seat
 * (so the board stays the same) but its turns are skipped from now on.
 * Returns null when the room is now empty and can be deleted.
 */
function leave(input, user) {
  const room = clone(input);
  const seat = seatOf(room, user.id);
  if (seat < 0) return room;
  const name = room.seats[seat].username;

  if (room.status !== 'lobby') {
    room.seats[seat].left = true;
    const event = { type: 'leave', player: seat, text: `${name} left the game.`, skipped: [] };
    if (room.seats.every((s) => s.left)) return null;
    if (room.status === 'playing' && room.game.current === seat) {
      if (room.game.phase === 'question') { room.game = L.answerQuestion(room.game, false); }
      room.game.phase = 'turnEnd';
      event.skipped = passTurn(room);
    }
    event.state = publicGame(room.game);
    push(room, event);
  } else {
    room.seats.splice(seat, 1);
    if (!room.seats.length) return null;
    push(room, { type: 'lobby', text: `${name} left.` });
  }
  if (room.hostId === user.id) {
    const next = room.seats.find((s) => !s.left);
    if (!next) return null;
    room.hostId = next.userId;
    push(room, { type: 'lobby', text: `${next.username} is now the host.` });
  }
  return room;
}

module.exports = {
  CODE_LENGTH, CODE_ALPHABET, MAX_PLAYERS, RoomError,
  QUESTION_SECONDS, ANIMATION_ALLOWANCE_MS, GRACE_MS, REACTIONS, CHAT_MAX_LENGTH,
  generateRoomCode, normalizeCode, view, publicGame, questionDeadline, isTimedOut,
  createRoom, joinRoom, startGame, roll, answer, expireQuestion, chat, leave
};
