// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Per-user DependencyTrack connection ───────────────────────────────────────
// Each user has exactly one connection row, seeded at registration with
// is_configured = false so the dashboard shows mock data until they set it up.
//
// S17: the API key is stored AES-256-GCM encrypted and is NEVER returned to a
// browser. Callers are told only whether a key is configured (CLAUDE.md §7.6).
// The plaintext exists only inside this process, for the duration of a request.
//
// The fingerprint is a SHA-256 of the normalised URL plus the key. Users whose
// credentials produce the same fingerprint share one violation cache build.

const { query } = require('../db/pool');
const { log } = require('./log');
const {
  encryptSecret, decryptSecret, connectionFingerprint,
} = require('./crypto');

// api_key_ciphertext is bytea; never SELECT * on this table (CLAUDE.md §5.1).
const SAFE_COLUMNS = `
  user_id AS "userId", api_url AS "apiUrl", frontend_url AS "frontendUrl",
  is_configured AS "isConfigured", fingerprint,
  (api_key_ciphertext IS NOT NULL) AS "hasApiKey",
  updated_at AS "updatedAt"
`;

let _key = null;

/** @param {Buffer} encryptionKey 32 raw bytes from crypto.parseEncryptionKey() */
function configure(encryptionKey) { _key = encryptionKey; }

function key() {
  if (!_key) throw new Error('dt-connections has not been configured — call configure() during boot');
  return _key;
}

/**
 * The connection as the browser may see it. Contains no key material —
 * only `hasApiKey`.
 */
async function getForClient(userId) {
  const { rows } = await query(
    `SELECT ${SAFE_COLUMNS} FROM dt_connections WHERE user_id = $1`, [userId]
  );
  return rows[0] || null;
}

/**
 * The connection with the API key decrypted, for server-side use only.
 * Never put the result in an HTTP response.
 *
 * @returns {Promise<{apiUrl,apiKey,frontendUrl,isConfigured,fingerprint}|null>}
 * @throws {Error} code DT_KEY_UNREADABLE when decryption fails
 */
async function getResolved(userId) {
  const { rows } = await query(
    `SELECT api_url AS "apiUrl", frontend_url AS "frontendUrl",
            is_configured AS "isConfigured", fingerprint,
            api_key_ciphertext AS ct, api_key_nonce AS nonce, api_key_tag AS tag
       FROM dt_connections WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;

  let apiKey = '';
  if (row.ct && row.nonce && row.tag) {
    try {
      apiKey = decryptSecret({ ciphertext: row.ct, nonce: row.nonce, tag: row.tag }, key());
    } catch (err) {
      // S18: never log the ciphertext, and never crash the request. The user is
      // asked to re-enter the key (CLAUDE.md §7.6).
      log('error', 'Stored DT API key could not be decrypted', { userId });
      throw Object.assign(
        new Error('Your stored DependencyTrack API key could not be read. Please re-enter it in Settings.'),
        { code: 'DT_KEY_UNREADABLE' }
      );
    }
  }

  return {
    apiUrl: row.apiUrl, apiKey, frontendUrl: row.frontendUrl,
    isConfigured: row.isConfigured, fingerprint: row.fingerprint,
  };
}

/**
 * Update a user's connection.
 *
 * A blank or omitted apiKey leaves the stored key untouched, so the UI can save
 * a URL change without asking for the key again — the browser never has it to
 * send back.
 *
 * `is_configured` becomes true only when there is both a URL and a key, since
 * that is exactly the condition under which live data can be fetched.
 */
async function save(userId, { apiUrl, apiKey, frontendUrl }) {
  // The URL and frontend URL are NOT encrypted, so read them through the
  // non-decrypting projection. Using getResolved() here would lose them
  // whenever the stored key happens to be unreadable — which is exactly when
  // the user is trying to fix it by entering a new one.
  const current = await getForClient(userId);

  const nextUrl      = apiUrl !== undefined ? String(apiUrl).trim().replace(/\/$/, '') : (current ? current.apiUrl : '');
  const nextFrontend = frontendUrl !== undefined ? String(frontendUrl).trim().replace(/\/$/, '') : (current ? current.frontendUrl : '');

  const hasNewKey = typeof apiKey === 'string' && apiKey.trim() !== '';
  // Control characters routinely arrive with a pasted key.
  const cleanKey  = hasNewKey ? apiKey.replace(/[\x00-\x1F\x7F]/g, '').trim() : null;

  // Only decrypt when we actually need the existing key, and treat an
  // unreadable one as absent rather than propagating the error.
  let effectiveKey = cleanKey || '';
  if (!hasNewKey) {
    try {
      const resolved = await getResolved(userId);
      effectiveKey = resolved ? resolved.apiKey : '';
    } catch (_) {
      effectiveKey = '';
    }
  }

  const configured  = Boolean(nextUrl && effectiveKey);
  const fingerprint = configured ? connectionFingerprint(nextUrl, effectiveKey) : null;

  if (hasNewKey) {
    const sealed = encryptSecret(cleanKey, key());
    await query(
      `UPDATE dt_connections
          SET api_url = $2, frontend_url = $3,
              api_key_ciphertext = $4, api_key_nonce = $5, api_key_tag = $6,
              is_configured = $7, fingerprint = $8
        WHERE user_id = $1`,
      [userId, nextUrl, nextFrontend, sealed.ciphertext, sealed.nonce, sealed.tag,
       configured, fingerprint]
    );
    log('info', 'DT connection saved', {
      userId, apiUrl: nextUrl, apiKey: `***${cleanKey.slice(-4)}`, configured,
    });
  } else {
    await query(
      `UPDATE dt_connections
          SET api_url = $2, frontend_url = $3, is_configured = $4, fingerprint = $5
        WHERE user_id = $1`,
      [userId, nextUrl, nextFrontend, configured, fingerprint]
    );
    log('info', 'DT connection updated (key unchanged)', { userId, apiUrl: nextUrl, configured });
  }

  return getForClient(userId);
}

/** Forget the stored key and mark the connection unconfigured. */
async function clearKey(userId) {
  await query(
    `UPDATE dt_connections
        SET api_key_ciphertext = NULL, api_key_nonce = NULL, api_key_tag = NULL,
            is_configured = false, fingerprint = NULL
      WHERE user_id = $1`,
    [userId]
  );
  log('info', 'DT API key cleared', { userId });
}

/**
 * Every distinct configured connection, for the scheduler and cache sweeper.
 * Returns decrypted keys — server-side use only.
 */
async function listConfigured() {
  const { rows } = await query(
    `SELECT user_id AS "userId", api_url AS "apiUrl", fingerprint,
            api_key_ciphertext AS ct, api_key_nonce AS nonce, api_key_tag AS tag
       FROM dt_connections WHERE is_configured = true`
  );
  const out = [];
  for (const row of rows) {
    try {
      out.push({
        userId: row.userId, apiUrl: row.apiUrl, fingerprint: row.fingerprint,
        apiKey: decryptSecret({ ciphertext: row.ct, nonce: row.nonce, tag: row.tag }, key()),
      });
    } catch (_) {
      // One unreadable row must not stop the scheduler for everyone else.
      log('warn', 'Skipping connection with an unreadable API key', { userId: row.userId });
    }
  }
  return out;
}

/**
 * One-time seed of existing accounts from the legacy .env connection.
 *
 * Without this, upgrading a working single-tenant deployment would leave every
 * account unconfigured and the dashboard showing mock data until each user
 * re-entered a connection they never had to enter before. Guarded by
 * system_state so it can only ever run once.
 *
 * @returns {Promise<{ ran: boolean, seeded: number, reason?: string }>}
 */
async function migrateLegacyConnection({ apiUrl, apiKey, frontendUrl }) {
  const MARKER = 'legacy_dt_connection_migrated';

  const { rows: done } = await query('SELECT 1 FROM system_state WHERE key = $1', [MARKER]);
  if (done.length) return { ran: false, reason: 'already migrated' };

  if (!apiUrl || !apiKey) {
    // Record the marker anyway: there was nothing to migrate, and re-checking
    // on every boot forever is pointless.
    await query(
      'INSERT INTO system_state (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [MARKER, JSON.stringify({ seeded: 0, reason: 'no legacy connection in .env' })]
    );
    return { ran: false, reason: 'no legacy connection configured' };
  }

  const cleanKey    = apiKey.replace(/[\x00-\x1F\x7F]/g, '').trim();
  const cleanUrl    = String(apiUrl).trim().replace(/\/$/, '');
  const fingerprint = connectionFingerprint(cleanUrl, cleanKey);
  const sealed      = encryptSecret(cleanKey, key());

  // Only accounts that have not configured anything themselves.
  const { rowCount } = await query(
    `UPDATE dt_connections
        SET api_url = $1, frontend_url = $2,
            api_key_ciphertext = $3, api_key_nonce = $4, api_key_tag = $5,
            is_configured = true, fingerprint = $6
      WHERE is_configured = false`,
    [cleanUrl, String(frontendUrl || '').trim().replace(/\/$/, ''),
     sealed.ciphertext, sealed.nonce, sealed.tag, fingerprint]
  );

  await query(
    'INSERT INTO system_state (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [MARKER, JSON.stringify({ seeded: rowCount, apiUrl: cleanUrl, at: new Date().toISOString() })]
  );

  log('info', 'Seeded existing accounts from the legacy .env DT connection', {
    seeded: rowCount, apiUrl: cleanUrl, apiKey: `***${cleanKey.slice(-4)}`,
  });
  return { ran: true, seeded: rowCount };
}

module.exports = {
  configure, getForClient, getResolved, save, clearKey, listConfigured,
  migrateLegacyConnection,
};
