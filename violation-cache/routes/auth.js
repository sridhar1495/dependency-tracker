// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Authentication endpoints ──────────────────────────────────────────────────
//   POST /auth/register            create an account            (public)
//   POST /auth/check-availability  login ID / email uniqueness   (public, rate limited)
//   POST /auth/login               authenticate                  (public)
//   POST /auth/logout              revoke the current session    (authenticated)
//   GET  /auth/me                  current principal             (authenticated)
//   DELETE /auth/account           delete the account and data   (authenticated)
//
// S14: authentication failures never reveal which factor was wrong, nor whether
// an account exists (CLAUDE.md §11.1).

const { log } = require('../lib/log');
const { jsonReply, readBody } = require('../lib/http-util');
const crypto   = require('../lib/crypto');
const validate = require('../lib/validate');
const auth     = require('../lib/auth');
const users    = require('../lib/users');
const audit    = require('../lib/login-audit');
const admin    = require('../lib/admin');

/** Parse a JSON body, replying 400 and returning null when it is malformed. */
async function readJson(req, res, maxBytes) {
  let raw;
  try {
    raw = await readBody(req, maxBytes);
  } catch (e) {
    jsonReply(res, 400, { error: e.message, code: 'BODY_TOO_LARGE' });
    return null;
  }
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    jsonReply(res, 400, { error: 'Request body is not valid JSON.', code: 'BAD_JSON' });
    return null;
  }
}

/** The public shape of a principal. Never includes a token or a hash. */
function principalToApi(p) {
  return {
    loginId:   p.loginId,
    firstName: p.firstName,
    lastName:  p.lastName,
    email:     p.email,
    isAdmin:   p.isAdmin === true,
  };
}

async function handle({ method, path: parsedPath, req, res, principal }) {

  // ── POST /auth/register ─────────────────────────────────────────────────
  if (method === 'POST' && parsedPath === '/auth/register') {
    const body = await readJson(req, res);
    if (body === null) return true;

    // Names are NOT trimmed: requirement 1.4.7 states a leading or trailing
    // space is not allowed, so it is reported rather than silently corrected.
    // Login ID and email are trimmed — neither may contain a space at all, so
    // stripping paste artefacts cannot change their meaning.
    const input = {
      firstName: body.firstName,
      lastName:  body.lastName,
      loginId:   typeof body.loginId === 'string' ? body.loginId.trim() : body.loginId,
      email:     typeof body.email   === 'string' ? body.email.trim()   : body.email,
      password:  body.password,
      confirmPassword: body.confirmPassword,
    };

    const reserved = validate.reservedLoginIds(admin.loginId());
    const { valid, errors } = validate.validateRegistration(input, { reserved });
    if (!valid) {
      jsonReply(res, 400, { error: 'Please correct the highlighted fields.', code: 'VALIDATION_FAILED', errors });
      return true;
    }

    // Both identifiers are checked in one query, so a user whose login ID AND
    // email are both taken is told about both at once rather than fixing one,
    // resubmitting, and being told about the other. The unique indexes are still
    // the final arbiter below — this check can be raced, it just cannot be the
    // reason someone has to submit the form twice.
    try {
      const taken = await users.findTakenIdentifiers({ loginId: input.loginId, email: input.email });
      if (taken.loginId || taken.email) {
        const errors = {};
        // Neither message says who owns the identifier (CLAUDE.md §12).
        if (taken.loginId) errors.loginId = 'This login ID is already registered.';
        if (taken.email)   errors.email   = 'This email address is already registered.';
        jsonReply(res, 409, {
          error: Object.keys(errors).length > 1
            ? 'This login ID and email address are both already registered.'
            : Object.values(errors)[0],
          code: 'ALREADY_REGISTERED',
          errors,
        });
        return true;
      }
    } catch (err) {
      log('error', `Availability check failed during registration: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not create the account.', code: 'INTERNAL' });
      return true;
    }

    try {
      const passwordHash = await crypto.hashPassword(input.password);
      const user = await users.create({
        loginId:   input.loginId,
        email:     input.email || null,
        firstName: input.firstName,
        lastName:  input.lastName,
        passwordHash,
      });

      await audit.record({
        userId: user.id, loginIdAttempted: user.loginId, event: 'register',
        ipAddress: auth.clientIp(req), userAgent: auth.userAgent(req),
      });
      // S15: log the user id, never the login ID beside a credential.
      log('info', 'Account registered', { userId: user.id });

      jsonReply(res, 201, { ok: true, message: 'Account created. You can now sign in.' });
    } catch (err) {
      if (err.code === 'ALREADY_REGISTERED') {
        // The message deliberately does not say who owns the identifier.
        jsonReply(res, 409, {
          error: err.message, code: 'ALREADY_REGISTERED',
          errors: err.field ? { [err.field]: err.message } : {},
        });
        return true;
      }
      log('error', `Registration failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not create the account.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /auth/check-availability ───────────────────────────────────────
  // Fired on field blur and again on submit. Rate limited, and the response
  // never identifies the owner of an existing identifier (CLAUDE.md §12).
  if (method === 'POST' && parsedPath === '/auth/check-availability') {
    const body = await readJson(req, res);
    if (body === null) return true;

    const field = body.field;
    const value = typeof body.value === 'string' ? body.value.trim() : '';

    if (field !== 'loginId' && field !== 'email') {
      jsonReply(res, 400, { error: 'field must be "loginId" or "email".', code: 'BAD_FIELD' });
      return true;
    }
    if (!value) {
      jsonReply(res, 200, { available: true, field });
      return true;
    }

    try {
      if (field === 'loginId') {
        const formatError = validate.validateLoginId(value, validate.reservedLoginIds(admin.loginId()));
        if (formatError) {
          jsonReply(res, 200, { available: false, field, error: formatError });
          return true;
        }
        const available = await users.isLoginIdAvailable(value);
        // The message is present only when it applies, and never names the owner.
        jsonReply(res, 200, available
          ? { available: true, field }
          : { available: false, field, error: 'This login ID is already registered.' });
      } else {
        const formatError = validate.validateEmail(value);
        if (formatError) {
          jsonReply(res, 200, { available: false, field, error: formatError });
          return true;
        }
        const available = await users.isEmailAvailable(value);
        jsonReply(res, 200, available
          ? { available: true, field }
          : { available: false, field, error: 'This email address is already registered.' });
      }
    } catch (err) {
      log('error', `Availability check failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not check availability.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /auth/login ────────────────────────────────────────────────────
  if (method === 'POST' && parsedPath === '/auth/login') {
    const body = await readJson(req, res);
    if (body === null) return true;

    const loginId  = typeof body.loginId === 'string' ? body.loginId.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const isAdmin  = body.isAdmin === true;
    const force    = body.force === true;
    const ip       = auth.clientIp(req);
    const ua       = auth.userAgent(req);

    if (!loginId || !password) {
      jsonReply(res, 400, { error: 'Login ID and password are required.', code: 'MISSING_CREDENTIALS' });
      return true;
    }

    // Declared outside the try so the catch below can still describe the
    // principal when the unique index rejects a racing insert.
    let principalType = 'user';
    let userId = null;

    try {
      if (await auth.isLockedOut(loginId, ip)) {
        await audit.record({ loginIdAttempted: loginId, event: 'lockout', ipAddress: ip, userAgent: ua });
        jsonReply(res, 429, {
          error: `Too many failed attempts. Try again in ${auth.LOCKOUT_MINUTES} minutes.`,
          code: 'LOCKED_OUT',
        });
        return true;
      }

      // Set when an administrator reset this password. The session is still
      // issued — the user has to be signed in to choose a new password — but
      // dispatch refuses every other route until they do (server.js, S30).
      let mustChangePassword = false;

      if (isAdmin) {
        if (!admin.isEnabled()) {
          jsonReply(res, 503, { error: admin.disabledReason(), code: 'ADMIN_LOGIN_DISABLED' });
          return true;
        }
        if (!await admin.verify(loginId, password)) {
          await audit.record({ loginIdAttempted: loginId, event: 'failed', ipAddress: ip, userAgent: ua });
          jsonReply(res, 401, { error: 'Invalid login ID or password.', code: 'INVALID_CREDENTIALS' });
          return true;
        }
        principalType = 'admin';
      } else {
        const row = await users.verifyLookup(loginId);
        // Verify even when the account is unknown, so a missing account and a
        // wrong password take indistinguishable time.
        const stored = row ? row.passwordHash : '$scrypt$invalid';
        const ok = await crypto.verifyPassword(password, stored);
        if (!row || !ok) {
          await audit.record({
            userId: row ? row.id : null, loginIdAttempted: loginId,
            event: 'failed', ipAddress: ip, userAgent: ua,
          });
          jsonReply(res, 401, { error: 'Invalid login ID or password.', code: 'INVALID_CREDENTIALS' });
          return true;
        }
        userId = row.id;
        mustChangePassword = row.mustChangePassword === true;
      }

      // Single active session: report the conflict unless the caller forces it.
      // "Live" here must mean exactly what it means to every other request —
      // including the idle window — or a browser that was simply closed for a
      // while is reported as another device.
      if (!force) {
        const live = await auth.findLiveSession({ principalType, userId });
        if (live) {
          jsonReply(res, 409, {
            error: 'You are already signed in on another device or browser.',
            code: 'SESSION_EXISTS',
            session: {
              issuedAt:   live.issuedAt,
              lastSeenAt: live.lastSeenAt,
              userAgent:  live.userAgent || null,
            },
          });
          return true;
        }
      }

      const { token } = await auth.issueSession({
        userId, principalType, force, userAgent: ua, ipAddress: ip,
      });

      if (force) {
        await audit.record({ userId, loginIdAttempted: loginId, event: 'force_disconnect', ipAddress: ip, userAgent: ua });
      }
      if (principalType === 'user') await users.touchLastLogin(userId);
      await audit.clearFailures(loginId, ip);
      await audit.record({ userId, loginIdAttempted: loginId, event: 'login', ipAddress: ip, userAgent: ua });
      log('info', 'Sign-in succeeded', { userId: userId || 'admin', principalType });

      const profile = principalType === 'admin'
        ? { loginId: admin.loginId(), firstName: 'Administrator', lastName: '', email: null, isAdmin: true }
        : principalToApi({ ...(await users.findById(userId)), isAdmin: false });

      jsonReply(res, 200, { token, user: profile, mustChangePassword });
    } catch (err) {
      if (err.code === 'SESSION_EXISTS') {
        // Lost a race against a concurrent login; the partial unique index won.
        // Look the winner up so this answer carries the same detail as the
        // check above — otherwise the same dialog sometimes shows when and
        // where, and sometimes says "no details available", for reasons the
        // person signing in cannot see.
        const live = await auth.findLiveSession({ principalType, userId }).catch(() => null);
        jsonReply(res, 409, {
          error: 'You are already signed in on another device or browser.',
          code: 'SESSION_EXISTS',
          session: live ? {
            issuedAt:   live.issuedAt,
            lastSeenAt: live.lastSeenAt,
            userAgent:  live.userAgent || null,
          } : null,
        });
        return true;
      }
      log('error', `Login failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not sign in.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /auth/set-password ─────────────────────────────────────────────
  // The way out of a forced password change. Authenticated, but reachable while
  // PASSWORD_CHANGE_REQUIRED is in force — it is on the allow-list in server.js.
  //
  // S31: the current password is deliberately NOT asked for. The user does not
  // know it: an administrator set it, and requiring them to type a value they
  // were told out of band would make the reset useless. The bearer token, minted
  // seconds earlier from that very password, is the proof of possession.
  if (method === 'POST' && parsedPath === '/auth/set-password') {
    if (!principal || principal.isAdmin || !principal.userId) {
      // The administrator's password lives in the credentials file, not the
      // database, so there is nothing here for them to set (CLAUDE.md §7.4).
      jsonReply(res, 403, {
        error: 'This session cannot set a password.',
        code: 'USER_ONLY',
      });
      return true;
    }

    const body = await readJson(req, res);
    if (body === null) return true;

    try {
      const problem = validate.validatePassword(body.password)
        || validate.validatePasswordConfirm(body.password, body.confirmPassword);
      if (problem) {
        jsonReply(res, 400, { error: problem, code: 'VALIDATION_FAILED', field: 'password' });
        return true;
      }

      const hash = await crypto.hashPassword(body.password);
      const updated = await users.completePasswordChange(principal.userId, hash);
      if (!updated) {
        jsonReply(res, 404, { error: 'No such account.', code: 'NOT_FOUND' });
        return true;
      }

      // The cached principal still says mustChangePassword. Evicting it is what
      // makes the very next request succeed rather than bounce for up to a
      // minute (CLAUDE.md §7.3). The session itself stays live, so the user
      // continues straight into the dashboard.
      auth.evictUser(principal.userId);
      log('info', 'User completed a required password change', { userId: principal.userId });

      jsonReply(res, 200, { ok: true });
    } catch (err) {
      log('error', `Set password failed: ${err.message}`, { userId: principal.userId });
      jsonReply(res, 500, { error: 'Could not set the password.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── POST /auth/logout ───────────────────────────────────────────────────
  if (method === 'POST' && parsedPath === '/auth/logout') {
    const token = auth.bearerFromRequest(req);
    try {
      await auth.revokeToken(token);
      await audit.record({
        userId: principal.userId, loginIdAttempted: principal.loginId,
        event: 'logout', ipAddress: auth.clientIp(req), userAgent: auth.userAgent(req),
      });
      log('info', 'Signed out', { userId: principal.userId || 'admin' });
      jsonReply(res, 200, { ok: true });
    } catch (err) {
      log('error', `Logout failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not sign out.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── GET /auth/me ────────────────────────────────────────────────────────
  // The frontend auth gate calls this before rendering anything.
  if (method === 'GET' && parsedPath === '/auth/me') {
    jsonReply(res, 200, { user: principalToApi(principal) });
    return true;
  }

  // ── DELETE /auth/account ────────────────────────────────────────────────
  if (method === 'DELETE' && parsedPath === '/auth/account') {
    if (principal.isAdmin) {
      jsonReply(res, 403, {
        error: 'The administrator account cannot be deleted from here.',
        code: 'ADMIN_IMMUTABLE',
      });
      return true;
    }
    try {
      const { userId, loginId } = principal;
      // Audit before deletion: the row survives with user_id nulled, and the
      // attempted login ID is retained for the trail.
      await audit.record({
        userId, loginIdAttempted: loginId, event: 'delete',
        ipAddress: auth.clientIp(req), userAgent: auth.userAgent(req),
      });
      await auth.revokeUserSessions(userId);
      const removed = await users.deleteById(userId);
      auth.evictUser(userId);

      if (!removed) {
        jsonReply(res, 404, { error: 'Account not found.', code: 'NOT_FOUND' });
        return true;
      }
      log('info', 'Account deleted', { userId });
      jsonReply(res, 200, { ok: true, message: 'Your account and all its data have been deleted.' });
    } catch (err) {
      log('error', `Account deletion failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not delete the account.', code: 'INTERNAL' });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
