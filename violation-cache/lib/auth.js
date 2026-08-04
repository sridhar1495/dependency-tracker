// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Session authentication ────────────────────────────────────────────────────
// Issue, validate and revoke bearer-token sessions, plus brute-force protection.
//
// Performance: validating a token on every request would otherwise cost one
// database round trip per API call. An in-process cache holds validated tokens
// for 60 seconds, and the idle clock is flushed at most once per minute per
// session (CLAUDE.md §7.3, §13).
//
// Revocation — logout, force-disconnect, account deletion — must ALWAYS evict
// the cache entry, otherwise a revoked token stays usable for up to 60 seconds.
// Every revocation path in this module does so.

const { log }      = require('./log');
const crypto       = require('./crypto');
const sessions     = require('./sessions');
const users        = require('./users');
const audit        = require('./login-audit');

const CACHE_TTL_MS      = 60 * 1000;      // revalidate against the database this often
const TOUCH_INTERVAL_MS = 60 * 1000;      // flush last_seen_at at most this often
const LOCKOUT_THRESHOLD = 5;              // failures before lockout
const LOCKOUT_MINUTES   = 15;

// tokenHashHex → { principal, cachedAt, lastTouchedAt }
const _tokenCache = new Map();

let _cfg = null;

/** @param {{ session: { absoluteHours: number, idleHours: number } }} cfg */
function configure(cfg) { _cfg = cfg; }

function cfg() {
  if (!_cfg) throw new Error('auth has not been configured — call configure() during boot');
  return _cfg;
}

const keyOf = (tokenHash) => tokenHash.toString('hex');

/** Drop a single token from the cache. Called on every revocation path. */
function evict(tokenHash) {
  _tokenCache.delete(keyOf(tokenHash));
}

/** Drop every cached token belonging to a user. Used by force-disconnect and deletion. */
function evictUser(userId) {
  for (const [k, v] of _tokenCache) {
    if (v.principal && v.principal.userId === userId) _tokenCache.delete(k);
  }
}

/** Drop every cached administrator token. */
function evictAdmin() {
  for (const [k, v] of _tokenCache) {
    if (v.principal && v.principal.principalType === 'admin') _tokenCache.delete(k);
  }
}

/** Cache size, for observability and tests. */
function cacheSize() { return _tokenCache.size; }

/** Empty the cache entirely. Test helper and SIGTERM tidy-up. */
function clearCache() { _tokenCache.clear(); }

// ── Brute-force protection ────────────────────────────────────────────────────

/**
 * Is this (login ID, address) pair currently locked out?
 * Backed by login_audit rather than process memory so the count survives a
 * restart and is visible to an administrator.
 */
async function isLockedOut(loginId, ipAddress) {
  const failures = await audit.recentFailures(loginId, ipAddress, LOCKOUT_MINUTES);
  return failures >= LOCKOUT_THRESHOLD;
}

// ── Session issue ─────────────────────────────────────────────────────────────

/**
 * Issue a session and return the raw token exactly once.
 *
 * @param {object} p
 * @param {string} [p.userId]        omitted for the administrator
 * @param {string} p.principalType   'user' | 'admin'
 * @param {boolean} [p.force]        revoke an existing live session first
 * @returns {Promise<{ token: string, session: object }>}
 * @throws {Error} code SESSION_EXISTS when a live session exists and force is false
 */
async function issueSession({ userId = null, principalType, force = false, userAgent = null, ipAddress = null }) {
  if (force) {
    if (principalType === 'admin') {
      await sessions.revokeAdmin();
      evictAdmin();
    } else {
      await sessions.revokeAllForUser(userId);
      evictUser(userId);
    }
  }

  const token     = crypto.mintToken();
  const tokenHash = crypto.hashToken(token);

  const session = await sessions.create({
    tokenHash,
    userId,
    principalType,
    absoluteHours: cfg().session.absoluteHours,
    userAgent,
    ipAddress,
  });

  return { token, session };
}

// ── Session validation (the hot path) ─────────────────────────────────────────

/**
 * Resolve a bearer token to a principal.
 *
 * @param {string} token raw bearer token from the Authorization header
 * @returns {Promise<object|null>} principal, or null when the token is not live
 */
async function resolveToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;

  const tokenHash = crypto.hashToken(token);
  const key       = keyOf(tokenHash);
  const now       = Date.now();

  const cached = _tokenCache.get(key);
  if (cached && (now - cached.cachedAt) < CACHE_TTL_MS) {
    // P11: cache hit costs zero database queries. The idle clock is still
    // advanced, but at most once per minute per session.
    if ((now - cached.lastTouchedAt) >= TOUCH_INTERVAL_MS) {
      cached.lastTouchedAt = now;
      sessions.touch(cached.principal.sessionId)
        .catch(e => log('warn', `Failed to update session activity: ${e.message}`));
    }
    return cached.principal;
  }

  const row = await sessions.findLiveByTokenHash(tokenHash, cfg().session.idleHours);
  if (!row) {
    _tokenCache.delete(key);
    return null;
  }

  const isAdmin = row.principalType === 'admin';

  const principal = {
    sessionId:     row.id,
    // S28: the SESSION row keeps user_id NULL for the administrator — the
    // sessions_principal_shape constraint requires it and nothing here changes
    // that. The resolved principal instead carries the reserved data identity
    // from migration 004, so the administrator's own settings, DependencyTrack
    // connection and reports flow through the ordinary per-user paths without
    // any route needing to know they are the administrator.
    userId:        isAdmin ? users.ADMIN_PRINCIPAL_ID : row.userId,
    principalType: row.principalType,
    loginId:       isAdmin ? null : row.loginId,
    firstName:     row.firstName || null,
    lastName:      row.lastName  || null,
    email:         row.email     || null,
    isAdmin,
    // S30: set when an administrator reset this password. Dispatch refuses
    // every route except set-password and logout while it is true, so the
    // password the administrator chose can only ever be spent replacing
    // itself — it never becomes a working credential for this user's data.
    mustChangePassword: row.mustChangePassword === true,
  };

  _tokenCache.set(key, { principal, cachedAt: now, lastTouchedAt: now });

  // Advance the idle clock on the way through, so an active session does not
  // fall out of its idle window while being used.
  sessions.touch(row.id).catch(e => log('warn', `Failed to update session activity: ${e.message}`));

  return principal;
}

// ── Revocation ────────────────────────────────────────────────────────────────

/** Revoke the session behind a token. Always evicts the cache entry. */
async function revokeToken(token) {
  const tokenHash = crypto.hashToken(token);
  const revoked   = await sessions.revokeByTokenHash(tokenHash);
  evict(tokenHash);
  return revoked;
}

/** Revoke every live session for a user and evict their cached tokens. */
async function revokeUserSessions(userId) {
  const n = await sessions.revokeAllForUser(userId);
  evictUser(userId);
  return n;
}

// ── Request helpers ───────────────────────────────────────────────────────────

/** Extract the bearer token from an Authorization header. */
function bearerFromRequest(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Best-effort client address, honouring the nginx X-Forwarded-For header. */
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || null;
}

/** Truncated user agent, for the force-disconnect prompt. */
function userAgent(req) {
  const ua = req.headers && req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 255) : null;
}

// ── Background maintenance ────────────────────────────────────────────────────

/**
 * Delete sessions that can never authenticate again, and purge expired audit
 * rows. Without this both tables grow without bound (CLAUDE.md §13).
 */
async function sweep() {
  try {
    const sessionsRemoved = await sessions.sweepExpired();
    const auditRemoved    = await audit.purgeOlderThan(90);
    if (sessionsRemoved || auditRemoved) {
      log('info', 'Session sweep complete', { sessionsRemoved, auditRemoved });
    }
  } catch (e) {
    log('warn', `Session sweep failed: ${e.message}`);
  }
}

module.exports = {
  configure, issueSession, resolveToken, revokeToken, revokeUserSessions,
  isLockedOut, bearerFromRequest, clientIp, userAgent, sweep,
  evict, evictUser, evictAdmin, clearCache, cacheSize,
  LOCKOUT_THRESHOLD, LOCKOUT_MINUTES, CACHE_TTL_MS, TOUCH_INTERVAL_MS,
  // Re-exported so route modules have one import for the whole auth surface.
  users, sessions, audit,
};
