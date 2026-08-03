// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Profile endpoints ─────────────────────────────────────────────────────────
//   GET /profile   read the signed-in user's details      (authenticated)
//   PUT /profile   update first name, last name, password (authenticated)
//
// Login ID and email are read-only. The frontend renders them disabled, and this
// module ignores them even when supplied, so a crafted request cannot change an
// identity (CLAUDE.md §9.3).

const { log } = require('../lib/log');
const { jsonReply, readBody } = require('../lib/http-util');
const crypto   = require('../lib/crypto');
const validate = require('../lib/validate');
const auth     = require('../lib/auth');
const users    = require('../lib/users');

async function readJson(req, res) {
  let raw;
  try {
    raw = await readBody(req);
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

async function handle({ method, path: parsedPath, req, res, principal }) {

  // ── GET /profile ────────────────────────────────────────────────────────
  if (method === 'GET' && parsedPath === '/profile') {
    if (principal.isAdmin) {
      jsonReply(res, 200, {
        user: {
          loginId: principal.loginId, firstName: 'Administrator', lastName: '',
          email: null, isAdmin: true, editable: false,
        },
      });
      return true;
    }
    try {
      const user = await users.findById(principal.userId);
      if (!user) {
        jsonReply(res, 404, { error: 'Account not found.', code: 'NOT_FOUND' });
        return true;
      }
      jsonReply(res, 200, {
        user: {
          loginId: user.loginId, email: user.email,
          firstName: user.firstName, lastName: user.lastName,
          createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
          isAdmin: false, editable: true,
        },
      });
    } catch (err) {
      log('error', `Profile read failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not load the profile.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── PUT /profile ────────────────────────────────────────────────────────
  if (method === 'PUT' && parsedPath === '/profile') {
    if (principal.isAdmin) {
      jsonReply(res, 403, {
        error: 'Administrator details are managed in the installation credentials file.',
        code: 'ADMIN_IMMUTABLE',
      });
      return true;
    }

    const body = await readJson(req, res);
    if (body === null) return true;

    const input = {};
    if (typeof body.firstName === 'string') input.firstName = body.firstName.trim();
    if (typeof body.lastName  === 'string') input.lastName  = body.lastName.trim();
    if (typeof body.password  === 'string' && body.password !== '') {
      input.password = body.password;
      if (body.confirmPassword !== undefined) input.confirmPassword = body.confirmPassword;
    }
    // body.loginId and body.email are deliberately not read.

    const { valid, errors } = validate.validateProfileUpdate(input);
    if (!valid) {
      jsonReply(res, 400, { error: 'Please correct the highlighted fields.', code: 'VALIDATION_FAILED', errors });
      return true;
    }
    if (Object.keys(input).length === 0) {
      jsonReply(res, 400, { error: 'Nothing to update.', code: 'NO_CHANGES' });
      return true;
    }

    try {
      const patch = {};
      if (input.firstName !== undefined) patch.firstName = input.firstName;
      if (input.lastName  !== undefined) patch.lastName  = input.lastName;
      if (input.password  !== undefined) patch.passwordHash = await crypto.hashPassword(input.password);

      const updated = await users.updateProfile(principal.userId, patch);
      if (!updated) {
        jsonReply(res, 404, { error: 'Account not found.', code: 'NOT_FOUND' });
        return true;
      }

      // A password change invalidates other sessions for this account. The
      // current session survives so the user is not signed out mid-edit.
      let passwordChanged = false;
      if (patch.passwordHash) {
        passwordChanged = true;
        auth.evictUser(principal.userId);
        log('info', 'Password changed', { userId: principal.userId });
      }

      jsonReply(res, 200, {
        ok: true,
        passwordChanged,
        user: {
          loginId: updated.loginId, email: updated.email,
          firstName: updated.firstName, lastName: updated.lastName,
          isAdmin: false, editable: true,
        },
      });
    } catch (err) {
      log('error', `Profile update failed: ${err.message}`);
      jsonReply(res, 500, { error: 'Could not update the profile.', code: 'INTERNAL' });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
