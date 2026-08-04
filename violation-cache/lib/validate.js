// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Field validation ──────────────────────────────────────────────────────────
// The authority for every field rule. The frontend mirrors these in phase 3 for
// immediate feedback, but the server always re-validates: the two must be
// changed together in the same commit (CLAUDE.md §8.8).
//
// Uniqueness is NOT checked here. It is a database concern, reached through
// lib/users.js, because only the unique index can settle a race between two
// simultaneous registrations.
//
// Why the character rules live in JavaScript rather than as SQL CHECK
// constraints: the cluster runs with locale=C, where POSIX classes such as
// [[:alpha:]] match ASCII only, so a CHECK would wrongly reject valid names
// like "José". Length and trimming are enforced in both places.

const NAME_MIN = 3,   NAME_MAX = 128;
const LOGIN_MIN = 3,  LOGIN_MAX = 64;
const PASSWORD_MIN = 8, PASSWORD_MAX = 128;
const EMAIL_MAX = 254;

// Unicode letters, with single spaces permitted between words but never at the
// start or end. \p{L} covers accented and non-Latin scripts.
const NAME_RE = /^\p{L}+(?: \p{L}+)*$/u;

// Conservative identifier charset: letters, digits, dot, underscore, hyphen.
const LOGIN_RE = /^[A-Za-z0-9._-]+$/;

// Deliberately pragmatic rather than RFC 5322 exhaustive: one @, no whitespace
// anywhere, a dot in the domain. Special characters are allowed between the
// patterns, as specified.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Login IDs that must never belong to a database user. The administrator is
// authenticated against an on-disk file, so a database row with the same login
// ID would shadow it (decision D11).
// '__administrator__' is the reserved principal seeded by migration 004 to hold
// the administrator's own dashboard configuration. Underscore IS a legal login
// character, so nothing else stops someone typing it: without this entry the
// registration would be refused only by the unique index, with a message
// implying an ordinary account holds the name.
const ALWAYS_RESERVED = ['root', 'system', 'administrator', '__administrator__'];

/** Build the reserved set, including the configured administrator login ID. */
function reservedLoginIds(adminLoginId) {
  const set = new Set(ALWAYS_RESERVED);
  if (adminLoginId) set.add(String(adminLoginId).toLowerCase());
  return set;
}

/** @returns {string|null} an error message, or null when valid */
function validateName(value, label) {
  if (typeof value !== 'string' || value.length === 0) return `${label} is required.`;
  if (value !== value.trim()) return `${label} cannot start or end with a space.`;
  if (value.length < NAME_MIN) return `${label} must be at least ${NAME_MIN} characters.`;
  if (value.length > NAME_MAX) return `${label} must be at most ${NAME_MAX} characters.`;
  if (!NAME_RE.test(value)) return `${label} may contain only letters and single spaces between words.`;
  return null;
}

function validateFirstName(value) { return validateName(value, 'First name'); }
function validateLastName(value)  { return validateName(value, 'Last name'); }

/**
 * @param {string} value
 * @param {Set<string>} [reserved] from reservedLoginIds()
 */
function validateLoginId(value, reserved) {
  if (typeof value !== 'string' || value.length === 0) return 'Login ID is required.';
  if (/\s/.test(value)) return 'Login ID cannot contain spaces.';
  if (value.length < LOGIN_MIN) return `Login ID must be at least ${LOGIN_MIN} characters.`;
  if (value.length > LOGIN_MAX) return `Login ID must be at most ${LOGIN_MAX} characters.`;
  if (!LOGIN_RE.test(value)) {
    return 'Login ID may contain only letters, digits, dot, underscore and hyphen.';
  }
  if (reserved && reserved.has(value.toLowerCase())) return 'This login ID is reserved.';
  return null;
}

/** Email is optional; an empty value is valid. */
function validateEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'Email address is not valid.';
  if (/\s/.test(value)) return 'Email address cannot contain spaces.';
  if (value.length > EMAIL_MAX) return `Email address must be at most ${EMAIL_MAX} characters.`;
  if (!EMAIL_RE.test(value)) return 'Enter a valid email address.';
  return null;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length === 0) return 'Password is required.';
  if (/\s/.test(value)) return 'Password cannot contain spaces.';
  if (value.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (value.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}

/** Confirmation must match exactly. Added beyond the original field list. */
function validatePasswordConfirm(password, confirm) {
  if (typeof confirm !== 'string' || confirm.length === 0) return 'Please confirm the password.';
  if (password !== confirm) return 'Passwords do not match.';
  return null;
}

/**
 * Validate a registration payload.
 * @returns {{ valid: boolean, errors: Record<string,string> }} errors keyed by field
 */
function validateRegistration(input, { reserved } = {}) {
  const errors = {};
  const first = validateFirstName(input.firstName);   if (first) errors.firstName = first;
  const last  = validateLastName(input.lastName);     if (last)  errors.lastName = last;
  const login = validateLoginId(input.loginId, reserved); if (login) errors.loginId = login;
  const email = validateEmail(input.email);           if (email) errors.email = email;
  const pass  = validatePassword(input.password);     if (pass)  errors.password = pass;

  // Only meaningful once the password itself is well formed.
  if (!pass && input.confirmPassword !== undefined) {
    const cf = validatePasswordConfirm(input.password, input.confirmPassword);
    if (cf) errors.confirmPassword = cf;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Validate a profile update. Login ID and email are not accepted here — the
 * frontend renders them read-only and the server ignores them regardless.
 */
function validateProfileUpdate(input) {
  const errors = {};
  if (input.firstName !== undefined) {
    const e = validateFirstName(input.firstName); if (e) errors.firstName = e;
  }
  if (input.lastName !== undefined) {
    const e = validateLastName(input.lastName); if (e) errors.lastName = e;
  }
  if (input.password !== undefined && input.password !== '') {
    const e = validatePassword(input.password); if (e) errors.password = e;
    if (!e && input.confirmPassword !== undefined) {
      const cf = validatePasswordConfirm(input.password, input.confirmPassword);
      if (cf) errors.confirmPassword = cf;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

module.exports = {
  validateFirstName, validateLastName, validateLoginId, validateEmail,
  validatePassword, validatePasswordConfirm,
  validateRegistration, validateProfileUpdate,
  reservedLoginIds, ALWAYS_RESERVED,
  NAME_MIN, NAME_MAX, LOGIN_MIN, LOGIN_MAX, PASSWORD_MIN, PASSWORD_MAX, EMAIL_MAX,
  NAME_RE, LOGIN_RE, EMAIL_RE,
};
