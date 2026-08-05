// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Report endpoints ──────────────────────────────────────────────────────────
//   POST   /violation-cache/report/generate      start a job
//   GET    /violation-cache/report/list          this user's reports
//   GET    /violation-cache/report/:id/download  stream the workbook
//   POST   /violation-cache/report/:id/cancel    stop a running job
//   DELETE /violation-cache/report/:id           delete metadata and bytes
//
// Reports live in the database, owned by a user. Every query is scoped by
// user_id, and someone else's report is reported as not found rather than
// forbidden — confirming its existence would leak information (CLAUDE.md §7.5).

const { log } = require('../lib/log');
const { jsonReply, readJson, requireUser } = require('../lib/http-util');
const reportsDb     = require('../lib/reports-db');
const reports       = require('../lib/reports');
const userSettings  = require('../lib/user-settings');
const dtConnections = require('../lib/dt-connections');
const validate      = require('../lib/validate');

// Report ids are uuids. Anything else is rejected here rather than handed to
// PostgreSQL, which would raise a type error for a malformed literal.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stream a report's chunks in order.
 *
 * One chunk is held in memory at a time and backpressure is respected, so a
 * large workbook never balloons the process regardless of how slowly the
 * browser reads (CLAUDE.md §13).
 */
async function streamChunks(res, reportId, chunks) {
  for (let seq = 0; seq < chunks; seq++) {
    const chunk = await reportsDb.getChunk(reportId, seq);
    if (!chunk) throw new Error(`Chunk ${seq} is missing`);
    if (!res.write(chunk)) {
      await new Promise((resolve, reject) => {
        res.once('drain', resolve);
        res.once('close', () => reject(Object.assign(new Error('Client disconnected'), { aborted: true })));
      });
    }
  }
  res.end();
}

async function handle({ method, path: parsedPath, req, res, principal }) {

  // ── POST /violation-cache/report/generate ───────────────────────────────
  if (method === 'POST' && parsedPath === '/violation-cache/report/generate') {
    const userId = requireUser(principal, res);
    if (!userId) return true;

    // 5 MB: the selected project list can be very large (CLAUDE.md §12).
    const body = await readJson(req, res, 5 * 1024 * 1024);
    if (body === null) return true;

    try {
      if (!Array.isArray(body.projects) || body.projects.length === 0) {
        jsonReply(res, 400, { error: 'projects must be a non-empty array.', code: 'VALIDATION_FAILED' });
        return true;
      }

      const riskTypes = Array.isArray(body.riskTypes) && body.riskTypes.length > 0
        ? body.riskTypes : ['security'];
      const invalid = riskTypes.filter(t => !reports.VALID_RISK_TYPES.has(t));
      if (invalid.length > 0) {
        jsonReply(res, 400, {
          error: `Invalid risk type(s): ${invalid.join(', ')}. Valid values: security, license, operational.`,
          code: 'VALIDATION_FAILED',
        });
        return true;
      }

      let conn;
      try {
        conn = await dtConnections.getResolved(userId);
      } catch (err) {
        if (err.code === 'DT_KEY_UNREADABLE') {
          jsonReply(res, 503, { error: err.message, code: 'DT_KEY_UNREADABLE' });
          return true;
        }
        throw err;
      }
      if (!conn || !conn.isConfigured || !conn.apiKey) {
        jsonReply(res, 503, {
          error: 'Configure your DependencyTrack connection in Settings before generating a report.',
          code: 'DT_NOT_CONFIGURED',
        });
        return true;
      }

      // The quota is this user's own, never a global counter.
      const { completed, running } = await reportsDb.activeCount(userId);
      const maxReports = await userSettings.getMaxReports(userId);
      if (completed + running >= maxReports) {
        jsonReply(res, 429, {
          error: `Report limit reached (${completed} completed + ${running} in progress = `
               + `${completed + running} / ${maxReports}). Delete an existing report, or ask your `
               + `administrator to raise the limit.`,
          code: 'QUOTA_REACHED',
          completedCount: completed, runningCount: running, maxReports,
        });
        return true;
      }

      // An optional name. Empty means "generate one", which is what every
      // report did before the field existed, so an untouched field is not an
      // error. The validator has already refused anything that could break a
      // Content-Disposition header or turn the name into a path.
      const nameProblem = validate.validateReportName(body.reportName);
      if (nameProblem) {
        jsonReply(res, 400, { error: nameProblem, code: 'VALIDATION_FAILED', field: 'reportName' });
        return true;
      }
      const filename = reports.reportFilename(body.reportName);

      // Stored now rather than at completion, so the list can show the name
      // while the job runs and the row can never disagree with the file.
      const report = await reportsDb.create(userId, {
        riskTypes, projectCount: body.projects.length, filename,
      });

      // Fire and forget — the browser polls /report/list (CLAUDE.md §6.6).
      reports.runReportJob(userId, report.id, conn, body.projects, riskTypes, filename)
        .catch(err => log('error', `Unhandled report job error: ${err.message}`, {
          userId, reportId: report.id,
        }));

      log('info', 'Report job created', {
        userId, reportId: report.id, projects: body.projects.length,
        named: Boolean(body.reportName && String(body.reportName).trim()),
      });
      jsonReply(res, 201, { id: report.id, filename, message: 'Report generation started' });
    } catch (err) {
      log('error', `Report generate failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not start the report.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── GET /violation-cache/report/list ────────────────────────────────────
  if (method === 'GET' && parsedPath === '/violation-cache/report/list') {
    const userId = requireUser(principal, res);
    if (!userId) return true;
    try {
      jsonReply(res, 200, await reportsDb.listForUser(userId));
    } catch (err) {
      log('error', `Report list failed: ${err.message}`, { userId });
      jsonReply(res, 500, { error: 'Could not load your reports.', code: 'INTERNAL' });
    }
    return true;
  }

  const dlMatch     = parsedPath.match(/^\/violation-cache\/report\/([^/]+)\/download$/);
  const cancelMatch = parsedPath.match(/^\/violation-cache\/report\/([^/]+)\/cancel$/);
  const idMatch     = parsedPath.match(/^\/violation-cache\/report\/([^/]+)$/);
  if (!dlMatch && !cancelMatch && !idMatch) return false;

  const userId = requireUser(principal, res);
  if (!userId) return true;

  const reportId = (dlMatch || cancelMatch || idMatch)[1];
  if (!UUID_RE.test(reportId)) {
    jsonReply(res, 404, { error: 'Report not found.', code: 'NOT_FOUND' });
    return true;
  }

  // ── GET /violation-cache/report/:id/download ──────────────────────────────
  if (method === 'GET' && dlMatch) {
    try {
      const report = await reportsDb.getForUser(userId, reportId);
      if (!report) { jsonReply(res, 404, { error: 'Report not found.', code: 'NOT_FOUND' }); return true; }
      if (report.status !== 'completed') {
        jsonReply(res, 409, { error: `Report is not ready (status: ${report.status}).`, code: 'NOT_READY' });
        return true;
      }
      const chunks = await reportsDb.chunkCount(reportId);
      if (chunks === 0) {
        jsonReply(res, 410, { error: 'The report file is no longer stored.', code: 'FILE_GONE' });
        return true;
      }

      res.writeHead(200, {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${report.filename}"`,
        'Content-Length':      report.fileSizeBytes,
        'Cache-Control':       'no-store',
      });
      await streamChunks(res, reportId, chunks);
    } catch (err) {
      if (err.aborted) {
        log('info', 'Report download aborted by the client', { userId, reportId });
        return true;
      }
      log('error', `Report download failed: ${err.message}`, { userId, reportId });
      // Headers are already out once streaming has begun; ending the response
      // early is all that is left, and the short body fails the download.
      if (!res.headersSent) jsonReply(res, 500, { error: 'Could not read the report.', code: 'INTERNAL' });
      else res.end();
    }
    return true;
  }

  // ── POST /violation-cache/report/:id/cancel ───────────────────────────────
  if (method === 'POST' && cancelMatch) {
    try {
      const report = await reportsDb.getForUser(userId, reportId);
      if (!report) { jsonReply(res, 404, { error: 'Report not found.', code: 'NOT_FOUND' }); return true; }
      if (report.status !== 'running' && report.status !== 'pending') {
        jsonReply(res, 409, {
          error: `Cannot cancel — the job is not running (status: ${report.status}).`,
          code: 'NOT_RUNNING',
        });
        return true;
      }
      if (!reports.requestCancel(reportId)) {
        // The job is recorded as running but no process here owns it — a
        // restart lost the worker. Fail it rather than leaving it stuck.
        await reportsDb.setStatus(reportId, 'failed', {
          error: 'The service restarted while this report was being generated.',
        });
        jsonReply(res, 200, { ok: true, message: 'Report marked as failed' });
        return true;
      }
      log('info', 'Report cancellation requested', { userId, reportId });
      jsonReply(res, 200, { ok: true, message: 'Cancellation requested' });
    } catch (err) {
      log('error', `Report cancel failed: ${err.message}`, { userId, reportId });
      jsonReply(res, 500, { error: 'Could not cancel the report.', code: 'INTERNAL' });
    }
    return true;
  }

  // ── DELETE /violation-cache/report/:id ────────────────────────────────────
  if (method === 'DELETE' && idMatch) {
    try {
      const report = await reportsDb.getForUser(userId, reportId);
      if (!report) { jsonReply(res, 404, { error: 'Report not found.', code: 'NOT_FOUND' }); return true; }
      if (report.status === 'running') {
        jsonReply(res, 409, { error: 'Cancel the job before deleting it.', code: 'STILL_RUNNING' });
        return true;
      }
      await reportsDb.deleteForUser(userId, reportId);
      log('info', 'Report deleted', { userId, reportId });
      jsonReply(res, 200, { ok: true });
    } catch (err) {
      log('error', `Report delete failed: ${err.message}`, { userId, reportId });
      jsonReply(res, 500, { error: 'Could not delete the report.', code: 'INTERNAL' });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
