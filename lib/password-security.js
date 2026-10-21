const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const PASSWORD_HASH_PREFIX = 'denix-scrypt';
const PASSWORD_HASH_VERSION = 'v1';
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});

function isPasswordHash(value) {
  return String(value || '').startsWith(`${PASSWORD_HASH_PREFIX}$${PASSWORD_HASH_VERSION}$`);
}

function legacySafeEqual(candidate, storedValue) {
  const candidateDigest = crypto.createHash('sha256').update(String(candidate)).digest();
  const storedDigest = crypto.createHash('sha256').update(String(storedValue)).digest();
  return crypto.timingSafeEqual(candidateDigest, storedDigest);
}

async function hashPassword(password) {
  const cleanPassword = typeof password === 'string' ? password : '';
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(cleanPassword, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);

  return [
    PASSWORD_HASH_PREFIX,
    PASSWORD_HASH_VERSION,
    SCRYPT_OPTIONS.N,
    SCRYPT_OPTIONS.r,
    SCRYPT_OPTIONS.p,
    salt.toString('base64url'),
    Buffer.from(derivedKey).toString('base64url')
  ].join('$');
}

async function verifyPassword(password, storedValue) {
  const cleanPassword = typeof password === 'string' ? password : '';
  const stored = String(storedValue || '');

  if (!cleanPassword || !stored) return false;
  if (!isPasswordHash(stored)) return legacySafeEqual(cleanPassword, stored);

  const parts = stored.split('$');
  if (parts.length !== 7) return false;

  const [, version, nValue, rValue, pValue, saltValue, hashValue] = parts;
  if (version !== PASSWORD_HASH_VERSION) return false;

  const N = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);
  if (![N, r, p].every(Number.isInteger)) return false;
  if (N < 16384 || r < 8 || p < 1) return false;

  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(hashValue, 'base64url');
    if (salt.length < 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;

    const actual = Buffer.from(await scrypt(cleanPassword, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_OPTIONS.maxmem
    }));

    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = {
  PASSWORD_HASH_PREFIX,
  PASSWORD_HASH_VERSION,
  SCRYPT_OPTIONS,
  hashPassword,
  verifyPassword,
  isPasswordHash
};
