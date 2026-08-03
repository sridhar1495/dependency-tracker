// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Cryptographic primitives ──────────────────────────────────────────────────
// Everything here uses Node's built-in crypto. No bcrypt, argon2 or JWT library
// is added (CLAUDE.md §3, §7.1).
//
// Three concerns, deliberately in one module so the parameters live together:
//   • password hashing and verification  (scrypt)
//   • session token minting and hashing  (randomBytes + SHA-256)
//   • secret encryption at rest          (AES-256-GCM)

const crypto = require('crypto');

// ── Password hashing ──────────────────────────────────────────────────────────
// OWASP-recommended scrypt parameters. They are embedded in the stored string
// so they can be raised later without invalidating existing credentials.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES  = 64;
// 128 * N * r = 16 MiB for the parameters above; allow headroom so a future
// increase does not fail with "memory limit exceeded".
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * Derive a key with scrypt.
 * S10: always the ASYNCHRONOUS form. scryptSync blocks the event loop for
 * roughly 100 ms per call at these parameters, so a burst of logins would stall
 * every other request in flight (CLAUDE.md §7.1).
 */
function scryptAsync(password, salt, { N, r, p, keyLen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, dk) => {
      if (err) reject(err); else resolve(dk);
    });
  });
}

/**
 * Hash a password for storage.
 * @returns {Promise<string>} `scrypt$N$r$p$<base64 salt>$<base64 derived key>`
 */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw Object.assign(new Error('Password must be a non-empty string'), { code: 'BAD_PASSWORD' });
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const dk   = await scryptAsync(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keyLen: KEY_BYTES });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

/**
 * Verify a password against a stored hash.
 * Returns false — never throws — for a malformed or tampered hash, so a corrupt
 * row cannot be distinguished from a wrong password by an attacker.
 *
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 0 || r <= 0 || p <= 0) return false;

  let salt, expected;
  try {
    salt     = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch (_) { return false; }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = await scryptAsync(password, salt, { N, r, p, keyLen: expected.length });
  } catch (_) {
    return false; // unusable parameters in the stored hash
  }

  // Lengths are equal by construction above, but timingSafeEqual throws on a
  // mismatch, so guard explicitly.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ── Session tokens ────────────────────────────────────────────────────────────
const TOKEN_BYTES = 32; // 256 bits

/** Mint a new bearer token. The caller sends this to the browser exactly once. */
function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Hash a token for storage and lookup.
 * S11: only this value is ever written to the database or compared, so a
 * database disclosure yields no usable session.
 *
 * @returns {Buffer} 32-byte SHA-256 digest
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest();
}

/** Constant-time comparison of two buffers of any length. */
function safeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Secret encryption at rest (AES-256-GCM) ───────────────────────────────────
const GCM_KEY_BYTES   = 32;
const GCM_NONCE_BYTES = 12;

/**
 * Normalise the configured key material to 32 raw bytes.
 * Accepts 64 hex characters or base64/base64url that decodes to 32 bytes.
 */
function parseEncryptionKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(
      new Error('SECRET_ENCRYPTION_KEY is not set'), { code: 'ENCRYPTION_KEY_MISSING' }
    );
  }
  const raw = value.trim();
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    try { key = Buffer.from(raw, 'base64'); } catch (_) { key = Buffer.alloc(0); }
  }
  if (key.length !== GCM_KEY_BYTES) {
    throw Object.assign(
      new Error(
        'SECRET_ENCRYPTION_KEY must decode to 32 bytes — supply 64 hex characters ' +
        'or a base64 value of 32 bytes. install.sh generates one.'
      ),
      { code: 'ENCRYPTION_KEY_INVALID' }
    );
  }
  return key;
}

/**
 * Encrypt a secret for storage.
 * @param {string} plaintext
 * @param {Buffer} key  32 raw bytes from parseEncryptionKey()
 * @returns {{ ciphertext: Buffer, nonce: Buffer, tag: Buffer }}
 */
function encryptSecret(plaintext, key) {
  const nonce  = crypto.randomBytes(GCM_NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

/**
 * Decrypt a stored secret.
 * S12: a failure here means the key changed or the row was tampered with. The
 * caller surfaces it to the user as "re-enter your API key" and must never log
 * the ciphertext or crash the request (CLAUDE.md §7.6).
 *
 * @throws {Error} code DECRYPT_FAILED
 */
function decryptSecret({ ciphertext, nonce, tag }, key) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw Object.assign(
      new Error('Stored secret could not be decrypted'),
      { code: 'DECRYPT_FAILED', cause: err }
    );
  }
}

/** SHA-256 hex digest of a DT connection, used to share one violation cache. */
function connectionFingerprint(apiUrl, apiKey) {
  const normalised = `${String(apiUrl).replace(/\/$/, '')}\n${String(apiKey)}`;
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

module.exports = {
  hashPassword, verifyPassword,
  mintToken, hashToken, safeEqual,
  parseEncryptionKey, encryptSecret, decryptSecret, connectionFingerprint,
  SCRYPT_N, SCRYPT_R, SCRYPT_P, TOKEN_BYTES,
};
