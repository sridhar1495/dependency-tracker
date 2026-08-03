// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── PostgreSQL connection pool ────────────────────────────────────────────────
// The single point of database access for the whole service (CLAUDE.md §5.1).
// No other module may construct a Client or a Pool.
//
// The pool is created once by init() during the boot sequence and closed on
// SIGTERM.  Nothing here runs at require time.

const { Pool } = require('pg');

let _pool = null;

/**
 * Create the connection pool.  Idempotent: calling init() twice returns the
 * existing pool rather than leaking a second one.
 *
 * @param {object} dbConfig  the `db` section of lib/config.js
 * @returns {import('pg').Pool}
 */
function init(dbConfig) {
  if (_pool) return _pool;

  _pool = new Pool({
    host:     dbConfig.host,
    port:     dbConfig.port,
    user:     dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    max:      dbConfig.max,
    // P6: a runaway query must not hold a pooled connection indefinitely — with
    // max 15 connections, three stuck queries is a fifth of the pool.
    statement_timeout: dbConfig.statementTimeoutMs,
    idle_in_transaction_session_timeout: dbConfig.idleInTransactionTimeoutMs,
  });

  // A pooled client can fail while idle (server restart, network drop). Without
  // a listener this is an unhandled 'error' event and would crash the process.
  _pool.on('error', (err) => {
    if (_onPoolError) _onPoolError(err);
  });

  return _pool;
}

let _onPoolError = null;

/** Register a callback for background pool errors (wired to log() at boot). */
function onError(fn) {
  _onPoolError = fn;
}

/** The live pool. Throws if init() has not run — a programming error, not a runtime one. */
function getPool() {
  if (!_pool) throw new Error('Database pool has not been initialised — call init() during boot');
  return _pool;
}

/** True once init() has created the pool. */
function isReady() {
  return _pool !== null;
}

/**
 * Run a single parameterised statement.
 * Values are ALWAYS passed as params; never interpolate them into `text`.
 *
 * @param {string} text   SQL with $1, $2 … placeholders
 * @param {Array}  params bound values
 */
function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Run `fn` inside a transaction on a dedicated client, committing on success and
 * rolling back on any throw.  Use this for every multi-statement write so the
 * group commits or rolls back as a unit (CLAUDE.md §5.1).
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // A failed ROLLBACK must not mask the original error.
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already dead */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool. Called from the SIGTERM handler. */
async function close() {
  if (!_pool) return;
  const p = _pool;
  _pool = null;
  await p.end();
}

module.exports = { init, onError, getPool, isReady, query, tx, close };
