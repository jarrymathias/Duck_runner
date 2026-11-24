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
 *   seq                                    // number of the last event
 * }
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

/** What a member sees. Events newer than `since` are included for animation. */
function view(room, since) {
  const fresh = Number.isInteger(since) && since >= 0;
  const oldest = room.events.length ? room.events[0].seq : room.seq + 1;
  // If the client is too far behind, it re-syncs from the snapshot without replaying.
  const resync = !fresh || since < oldest - 1 || since > room.seq;
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    seats: room.seats.map((s, i) => ({ seat: i, userId: s.userId, username: s.username, left: !!s.left })),
    game: publicGame(room.game),
    seq: room.seq,
    resync,
    events: resync ? [] : room.events.filter((e) => e.seq > since)
  };
}

function createRoom(code, user) {
  const room = { code, hostId: user.id, status: 'lobby', seats: [], game: null, events: [], seq: 0 };
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
  push(room, { type: 'start', text: `Game started! ${room.seats[0].username} goes first.`, state: publicGame(room.game) });
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

function roll(input, user, value = crypto.randomInt(1, 7)) {
  const room = clone(input);
  const seat = requireTurn(room, user, 'roll');
  const res = L.playRoll(room.game, value, rng);
  room.game = res.state;
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

/** `choice` is the index of the chosen option in QUESTIONS[id].o (not the shuffled letter). */
function answer(input, user, choice) {
  const room = clone(input);
  const seat = requireTurn(room, user, 'question');
  const { questionId, start, landing } = room.game.pending;
  const q = L.QUESTIONS[questionId];
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.o.length) throw new RoomError(400, 'Invalid answer.');
  const correct = choice === q.a;
  room.game = L.answerQuestion(room.game, correct);
  const skipped = passTurn(room);
  push(room, { type: 'answer', player: seat, questionId, choice, correct, start, landing, skipped, state: publicGame(room.game) });
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
      if (room.game.phase === 'question') room.game = L.answerQuestion(room.game, false);
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
  generateRoomCode, normalizeCode, view, publicGame,
  createRoom, joinRoom, startGame, roll, answer, leave
};
