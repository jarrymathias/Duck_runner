'use strict';
/* Accounts: password hashing, session tokens and input checks (no database here). */
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,20}$/u;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 200;
const SESSION_DAYS = 30;

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Returns "scrypt$N$r$p$saltB64$hashB64". */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), { N: +N, r: +r, p: +p, keylen: expected.length });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** Returns an error message, or null if the credentials are acceptable. */
function checkCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Username: 3 to 20 characters, letters, digits, "_", "-" or "." only.';
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Password: at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) return 'Password is too long.';
  return null;
}

const newSessionToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

module.exports = { hashPassword, verifyPassword, checkCredentials, newSessionToken, hashToken, SESSION_DAYS };
