// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Daily risk snapshots — data access ────────────────────────────────────────
// One row per DependencyTrack connection per day, written at the end of a
// violation-cache build. See db/migrations/012_risk_snapshots.sql for why the
// row is keyed by fingerprint and why both the severity and the policy
// components are stored rather than a single folded number.
//
// Q21: every calendar boundary in this module is computed in UTC, in JavaScript,
// and passed to PostgreSQL as an explicit parameter. Neither `current_date` nor
// `now()::date` appears in a statement here. Both would read the database
// container's timezone, which would make an image's TZ setting an invisible
// input to which day a measurement lands on — the same trap §6.8 describes for
// schedules, and the same answer: decide the instant here, store what was
// decided.

const { query } = require('../db/pool');
const { log } = require('./log');

// The columns, once, in one order, so the reader and the writer cannot disagree
// about what a snapshot contains.
const SEV_KEYS = ['critical', 'high', 'medium', 'low', 'unassigned'];
const POL_KEYS = [
  ['ops', 'fail'], ['ops', 'warn'], ['ops', 'info'],
  ['lic', 'fail'], ['lic', 'warn'], ['lic', 'info'],
  ['secpol', 'fail'], ['secpol', 'warn'], ['secpol', 'info'],
];

// The violation map spells security-policy in full; the snapshot columns use the
// dashboard's own abbreviation. One place knows both spellings.
const MAP_CATEGORY = { ops: 'ops', lic: 'lic', secpol: 'secpolicy' };

/** The UTC calendar day of an instant, as 'YYYY-MM-DD'. */
function utcDay(when = new Date()) {
  return new Date(when).toISOString().slice(0, 10);
}

/** Shift a 'YYYY-MM-DD' day by whole days, staying in UTC. */
function shiftDay(day, deltaDays) {
  const [y, m, d] = day.split('-').map(Number);
  // UTC has no daylight saving, so adding whole days to a UTC midnight cannot
  // land on a different wall time or skip a date.
  return utcDay(new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000));
}

/**
 * Coerce an upstream number into a non-negative integer.
 *
 * DependencyTrack embeds metrics from whatever version wrote them; a missing
 * key, a null, a string and a float have all been seen. A count that cannot be
 * read is zero, never NaN — one NaN would poison a whole day's sum and the
 * CHECK would then reject the write, losing the other fourteen good numbers.
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Fold a set of root projects and the violation map into one day's totals.
 *
 * Pure — no I/O, no clock — so it is unit-tested directly (CLAUDE.md §10.4).
 *
 * Both halves are summed over the same projects, which is what lets the graph
 * and the KPI tiles agree: the tiles sum DependencyTrack's root projects, so
 * this does too. Summing every project instead would double-count, because a
 * parent's numbers already carry its descendants'.
 *
 * @param {Array<object>} projects     root projects, each with an embedded metrics{}
 * @param {object|null} violationMap   uuid → { ops, lic, secpolicy } count maps
 */
function summarise(projects, violationMap) {
  const map = violationMap || {};
  const totals = { rootProjectCount: 0, sev: {}, pol: {} };
  for (const k of SEV_KEYS) totals.sev[k] = 0;
  for (const [cat, state] of POL_KEYS) totals.pol[`${cat}_${state}`] = 0;

  for (const p of (projects || [])) {
    if (!p || !p.uuid) continue;
    totals.rootProjectCount++;

    const m = p.metrics || {};
    for (const k of SEV_KEYS) totals.sev[k] += num(m[k]);

    const v = map[p.uuid];
    if (!v) continue;
    for (const [cat, state] of POL_KEYS) {
      const bucket = v[MAP_CATEGORY[cat]];
      if (bucket) totals.pol[`${cat}_${state}`] += num(bucket[state]);
    }
  }
  return totals;
}

/**
 * Record one day's totals, overwriting any earlier build of the same day.
 *
 * Last write wins, deliberately: a refetch at 16:00 knows more than the one at
 * 09:00, and a day should end holding its most recent measurement rather than
 * its first. captured_at moves with it, so the row says when it was taken.
 *
 * @param {string} fingerprint
 * @param {object} totals   as returned by summarise()
 * @param {Date} [when]     the instant of the build; its UTC day is the key
 */
async function upsertForDay(fingerprint, totals, when = new Date()) {
  const day = utcDay(when);
  const values = [
    fingerprint, day, num(totals.rootProjectCount),
    ...SEV_KEYS.map(k => num(totals.sev[k])),
    ...POL_KEYS.map(([cat, state]) => num(totals.pol[`${cat}_${state}`])),
  ];
  await query(
    `INSERT INTO risk_snapshots (
       fingerprint, day, root_project_count,
       sev_critical, sev_high, sev_medium, sev_low, sev_unassigned,
       ops_fail, ops_warn, ops_info,
       lic_fail, lic_warn, lic_info,
       secpol_fail, secpol_warn, secpol_info
     ) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (fingerprint, day) DO UPDATE SET
       captured_at        = now(),
       root_project_count = EXCLUDED.root_project_count,
       sev_critical       = EXCLUDED.sev_critical,
       sev_high           = EXCLUDED.sev_high,
       sev_medium         = EXCLUDED.sev_medium,
       sev_low            = EXCLUDED.sev_low,
       sev_unassigned     = EXCLUDED.sev_unassigned,
       ops_fail           = EXCLUDED.ops_fail,
       ops_warn           = EXCLUDED.ops_warn,
       ops_info           = EXCLUDED.ops_info,
       lic_fail           = EXCLUDED.lic_fail,
       lic_warn           = EXCLUDED.lic_warn,
       lic_info           = EXCLUDED.lic_info,
       secpol_fail        = EXCLUDED.secpol_fail,
       secpol_warn        = EXCLUDED.secpol_warn,
       secpol_info        = EXCLUDED.secpol_info`,
    values
  );
  return day;
}

// day is read back as text rather than as a date. node-postgres parses a `date`
// into a JS Date at LOCAL midnight, so a container an hour west of UTC would
// hand the browser the previous day for every point. to_char sidesteps the
// driver's calendar entirely.
//
// The alias shadows the column, so the query below orders by
// `risk_snapshots.day` explicitly: an unqualified `ORDER BY day` binds to this
// output expression and sorts the formatted strings instead. It happens to give
// the same order — 'YYYY-MM-DD' is lexicographically ordered — but only by
// coincidence of the format, and it costs a sort the index could have provided.
const SERIES_COLUMNS = `
  to_char(day, 'YYYY-MM-DD') AS day, root_project_count,
  sev_critical, sev_high, sev_medium, sev_low, sev_unassigned,
  ops_fail, ops_warn, ops_info,
  lic_fail, lic_warn, lic_info,
  secpol_fail, secpol_warn, secpol_info
`;

/**
 * One connection's history as a DENSE array: every day in the window is present,
 * whether or not a build happened on it.
 *
 * A gap is a fact about the data — nobody refreshed that day — and it is
 * reported as one (`captured: false`, null totals) rather than hidden by
 * carrying the previous day forward. Carrying forward would draw a flat line
 * asserting a measurement that was never taken, which is the one thing a trend
 * graph must not do.
 *
 * @param {string} fingerprint
 * @param {number} days   window size, inclusive of today
 * @param {Date} [now]    parameterised so tests can pin the window
 */
async function series(fingerprint, days, now = new Date()) {
  const { from, to } = window(days, now);

  const { rows } = await query(
    `SELECT ${SERIES_COLUMNS}
       FROM risk_snapshots
      WHERE fingerprint = $1 AND day >= $2::date AND day <= $3::date
      ORDER BY risk_snapshots.day`,
    [fingerprint, from, to]
  );

  const byDay = new Map(rows.map(r => [r.day, r]));
  return { from, to, points: densify(from, days, byDay) };
}

/** The inclusive UTC day range a window of `days` ending today covers. */
function window(days, now = new Date()) {
  const to = utcDay(now);
  return { from: shiftDay(to, -(days - 1)), to };
}

/**
 * Turn whatever rows exist into one entry per day. Pure, so both the populated
 * and the empty series are built by the same code — an account with no
 * connection gets an envelope of exactly the shape an account with a year of
 * history gets, and the caller renders one code path.
 */
function densify(from, days, byDay = new Map()) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = shiftDay(from, i);
    const r = byDay.get(day);
    if (!r) {
      out.push({ day, captured: false, rootProjectCount: null, sev: null, pol: null });
      continue;
    }
    out.push({
      day,
      captured: true,
      rootProjectCount: r.root_project_count,
      sev: {
        critical: r.sev_critical, high: r.sev_high, medium: r.sev_medium,
        low: r.sev_low, unassigned: r.sev_unassigned,
      },
      pol: {
        opsFail: r.ops_fail, opsWarn: r.ops_warn, opsInfo: r.ops_info,
        licFail: r.lic_fail, licWarn: r.lic_warn, licInfo: r.lic_info,
        secpolFail: r.secpol_fail, secpolWarn: r.secpol_warn, secpolInfo: r.secpol_info,
      },
    });
  }
  return out;
}

/**
 * The same envelope for a caller that has no connection, without asking the
 * database a question whose answer is known: no fingerprint, no rows.
 */
function emptySeries(days, now = new Date()) {
  const { from, to } = window(days, now);
  return { from, to, points: densify(from, days) };
}

/**
 * Discard history past the retention window (CLAUDE.md §13 — no unbounded table
 * growth). Runs from housekeeping, not from a request.
 */
async function sweep(retentionDays, now = new Date()) {
  const cutoff = shiftDay(utcDay(now), -retentionDays);
  const { rowCount } = await query(
    'DELETE FROM risk_snapshots WHERE day < $1::date', [cutoff]
  );
  if (rowCount) log('info', 'Swept expired risk snapshots', { removed: rowCount, before: cutoff });
  return rowCount;
}

/** How many days of history exist for a connection. For observability. */
async function countFor(fingerprint) {
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM risk_snapshots WHERE fingerprint = $1', [fingerprint]
  );
  return rows[0].n;
}

module.exports = {
  summarise, upsertForDay, series, emptySeries, sweep, countFor,
  utcDay, shiftDay, window, densify, num,
  SEV_KEYS, POL_KEYS,
};
