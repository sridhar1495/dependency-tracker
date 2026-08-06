// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── CWE labelling and reference links ────────────────────────────────────────
// Q16: the CWE cell on SV_Vulnerability Findings and the CWE key on
// SV_CWE Summary must be the same string, or the summary silently splits one
// vulnerability across two rows. Both call cweLabel(), so there is one rule.
//
// Everything here is derived from the finding objects `/api/v1/finding` already
// returns — no extra DependencyTrack call is made for any of it.

/**
 * CWE identifiers on a DT vulnerability, as numbers-or-strings without the
 * `CWE-` prefix. DT returns `cwes: [{ cweId: 79, name: '…' }]`; the prefix is
 * stripped defensively so a deployment that sends `"CWE-79"` does not render
 * as `CWE-CWE-79`.
 *
 * @param {object} vulnerability
 * @returns {string[]}
 */
function cweIdsOf(vulnerability) {
  const list = (vulnerability && vulnerability.cwes) || [];
  return list
    .map(w => (w && w.cweId != null ? String(w.cweId).trim() : ''))
    .map(id => id.replace(/^CWE-/i, ''))
    .filter(Boolean);
}

/**
 * The displayed CWE cell: `CWE-79, CWE-89`, or '' when DT mapped none.
 * @param {object} vulnerability
 * @returns {string}
 */
function cweLabel(vulnerability) {
  return cweIdsOf(vulnerability).map(id => `CWE-${id}`).join(', ');
}

/**
 * MITRE definition links for the CWEs on one finding.
 * @param {string[]} cweIds  as returned by cweIdsOf()
 * @returns {string}
 */
function cweReference(cweIds) {
  return (cweIds || [])
    .map(id => `https://cwe.mitre.org/data/definitions/${encodeURIComponent(id)}.html`)
    .join(', ');
}

/**
 * Advisory link for a vulnerability id, chosen from the id's own prefix.
 * An unrecognised prefix returns '' — a blank cell is honest, a guessed URL
 * is a broken link somebody has to check.
 *
 * @param {string} vulnId  e.g. CVE-2021-44228, GHSA-jfh8-c2jp-5v3q
 * @returns {string}
 */
function vulnReference(vulnId) {
  const id = typeof vulnId === 'string' ? vulnId.trim() : '';
  if (!id) return '';
  const enc = encodeURIComponent(id);
  if (/^CVE-/i.test(id))  return `https://nvd.nist.gov/vuln/detail/${enc}`;
  if (/^GHSA-/i.test(id)) return `https://github.com/advisories/${enc}`;
  if (/^SNYK-/i.test(id)) return `https://security.snyk.io/vuln/${enc}`;
  if (/^(OSV|GO|PYSEC|RUSTSEC|GSD)-/i.test(id)) return `https://osv.dev/vulnerability/${enc}`;
  return '';
}

module.exports = { cweIdsOf, cweLabel, cweReference, vulnReference };
