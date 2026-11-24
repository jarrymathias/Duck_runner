'use strict';
/*
 * PostgreSQL (Neon) access. Settings come from .env: either DATABASE_URL (the
 * whole Neon connection string), or the PG* variables (PGHOST, PGUSER,
 * PGPASSWORD, PGDATABASE, PGPORT), which `pg` reads itself.
 */
const { Pool } = require('pg');
const { SESSION_DAYS } = require('./accounts');

let pool = null;

function connect(options = {}) {
  const url = process.env.DATABASE_URL || '';
  const host = url ? new URL(url).hostname : process.env.PGHOST || '';
  const local = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(host);
  pool = options.pool || new Pool({
    // sslmode/channel_binding are removed: SSL is set just below.
    connectionString: url ? url.replace(/([?&])(sslmode|channel_binding)=[^&]*&?/g, '$1').replace(/[?&]$/, '') : undefined,
    ssl: local || process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  pool.on && pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

const query = (text, params) => pool.query(text, params);

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      username      text NOT NULL,
      password_hash text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username))');
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY,
      user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS rooms (
      code       text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
}

/* ---------------- Users & sessions ---------------- */

/** Returns the new user, or null if the username is taken. */
async function createUser(username, passwordHash) {
  try {
    const { rows } = await query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, passwordHash]);
    return rows[0];
  } catch (err) {
    if (err.code === '23505') return null; // unique_violation
    throw err;
  }
}

async function findUserByName(username) {
  const { rows } = await query(
    'SELECT id, username, password_hash FROM users WHERE lower(username) = lower($1)', [username]);
  return rows[0] || null;
}

async function createSession(tokenHash, userId) {
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [tokenHash, userId]);
}

async function userForSession(tokenHash) {
  const { rows } = await query(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash]);
  return rows[0] || null;
}

const deleteSession = (tokenHash) => query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);

/* ---------------- Rooms ---------------- */

/** Inserts the room unless the code is taken; returns true on success. */
async function insertRoom(room) {
  const { rowCount } = await query(
    'INSERT INTO rooms (code, data) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [room.code, room]);
  return rowCount === 1;
}

async function getRoom(code) {
  const { rows } = await query('SELECT data FROM rooms WHERE code = $1', [code]);
  return rows[0] ? rows[0].data : null;
}

/** The most recent room the user is still in, if any (to resume after a reload). */
async function currentRoomCode(userId) {
  const { rows } = await query(
    `SELECT code FROM rooms WHERE data->'seats' @> $1::jsonb ORDER BY updated_at DESC LIMIT 1`,
    [JSON.stringify([{ userId, left: false }])]);
  return rows[0] ? rows[0].code : null;
}

/**
 * Locks the room row, runs `change(room)` and saves what it returns
 * (null deletes the room). Two players acting at once are applied one after
 * the other. Returns { before, after }, or null if the room doesn't exist.
 */
async function updateRoom(code, change) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM rooms WHERE code = $1 FOR UPDATE', [code]);
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    const before = rows[0].data;
    const after = change(before);
    if (after) await client.query('UPDATE rooms SET data = $2, updated_at = now() WHERE code = $1', [code, after]);
    else await client.query('DELETE FROM rooms WHERE code = $1', [code]);
    await client.query('COMMIT');
    return { before, after };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Removes expired sessions and rooms nobody touched for a week. */
async function cleanup() {
  await query('DELETE FROM sessions WHERE expires_at < now()');
  await query(`DELETE FROM rooms WHERE updated_at < now() - interval '7 days'`);
}

module.exports = {
  connect, migrate, cleanup,
  createUser, findUserByName, createSession, userForSession, deleteSession,
  insertRoom, getRoom, currentRoomCode, updateRoom
};
