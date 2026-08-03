// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Report endpoints: creation, listing, download, cancellation and deletion.

const fs     = require('fs');
const crypto = require('crypto');
const { log } = require('../lib/log');
const { jsonReply, readBody } = require('../lib/http-util');
const { getMaxReports } = require('../lib/app-config');
const {
  reportJobs, saveRegistry, jobToApi, runReportJob, VALID_RISK_TYPES,
} = require('../lib/reports');

async function handle({ method, path: parsedPath, req, res }) {
    // POST /violation-cache/report/generate
    if (method === 'POST' && parsedPath === '/violation-cache/report/generate') {
      try {
        const raw  = await readBody(req, 5 * 1024 * 1024); // 5 MB — project list can be large
        const body = JSON.parse(raw);
  
        if (!Array.isArray(body.projects) || body.projects.length === 0) {
          jsonReply(res, 400, { error: 'projects must be a non-empty array' });
          return true;
        }
  
        // riskTypes defaults to ['security'] for backward compatibility when omitted.
        const riskTypes = Array.isArray(body.riskTypes) && body.riskTypes.length > 0
          ? body.riskTypes
          : ['security'];
        const invalidTypes = riskTypes.filter(t => !VALID_RISK_TYPES.has(t));
        if (invalidTypes.length > 0) {
          jsonReply(res, 400, {
            error: `Invalid risk type(s): ${invalidTypes.join(', ')}. Valid values: security, license, operational`,
          });
          return true;
        }
  
        const jobs = Array.from(reportJobs.values());
        const completedCount = jobs.filter(j => j.status === 'completed').length;
        const runningCount   = jobs.filter(j => j.status === 'running').length;
        const maxReports     = getMaxReports();
        if (completedCount + runningCount >= maxReports) {
          jsonReply(res, 429, {
            error: `Report limit reached (${completedCount} completed + ${runningCount} in-progress = ${completedCount + runningCount} / ${maxReports}). ` +
                   'Delete existing reports or raise the limit in Settings.',
            completedCount,
            runningCount,
            maxReports,
          });
          return true;
        }
  
        const id  = crypto.randomUUID();
        const job = {
          id,
          status:       'pending',
          filename:     null,
          filePath:     null,
          error:        null,
          riskTypes,
          progress:     { done: 0, total: body.projects.length },
          createdAt:    new Date().toISOString(),
          updatedAt:    new Date().toISOString(),
          cancelFlag:   { cancelled: false },
          cancelReason: null,
        };
        reportJobs.set(id, job);
        saveRegistry();
  
        // Fire and forget — status is polled via /report/list
        runReportJob(id, body.projects, riskTypes).catch(err =>
          log('error', `Unhandled report job error (${id}): ${err.message}`)
        );
  
        log('info', `Report job created: ${id} (${body.projects.length} projects)`);
        jsonReply(res, 201, { id, message: 'Report generation started' });
      } catch (e) {
        log('error', `Report generate error: ${e.message}`);
        jsonReply(res, 400, { error: e.message });
      }
      return true;
    }
  
    // GET /violation-cache/report/list
    if (method === 'GET' && parsedPath === '/violation-cache/report/list') {
      const list = Array.from(reportJobs.values())
        .map(jobToApi)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      jsonReply(res, 200, list);
      return true;
    }

  // Dynamic :id routes
  const dlMatch     = parsedPath.match(/^\/violation-cache\/report\/([^/]+)\/download$/);
  const cancelMatch = parsedPath.match(/^\/violation-cache\/report\/([^/]+)\/cancel$/);
  const idMatch     = parsedPath.match(/^\/violation-cache\/report\/([^/]+)$/);

    // GET /violation-cache/report/:id/download
    if (method === 'GET' && dlMatch) {
      const id  = dlMatch[1];
      const job = reportJobs.get(id);
      if (!job) { jsonReply(res, 404, { error: 'Report not found' }); return true; }
      if (job.status !== 'completed') {
        jsonReply(res, 409, { error: `Report is not ready (status: ${job.status})` });
        return true;
      }
      if (!fs.existsSync(job.filePath)) {
        jsonReply(res, 410, { error: 'Report file no longer exists on disk' });
        return true;
      }
      try {
        const stat = fs.statSync(job.filePath);
        res.writeHead(200, {
          'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${job.filename}"`,
          'Content-Length':      stat.size,
          'Cache-Control':       'no-store',
        });
        fs.createReadStream(job.filePath).pipe(res);
      } catch (e) {
        log('error', `Report download failed (${id}): ${e.message}`);
        jsonReply(res, 500, { error: 'Failed to stream report file' });
      }
      return true;
    }
  
    // POST /violation-cache/report/:id/cancel
    if (method === 'POST' && cancelMatch) {
      const id  = cancelMatch[1];
      const job = reportJobs.get(id);
      if (!job) { jsonReply(res, 404, { error: 'Report not found' }); return true; }
      if (job.status !== 'running') {
        jsonReply(res, 409, { error: `Cannot cancel — job is not running (status: ${job.status})` });
        return true;
      }
      job.cancelFlag.cancelled = true;
      job.cancelReason = 'user';
      log('info', `Report job ${id} cancel requested by user`);
      jsonReply(res, 200, { ok: true, message: 'Cancellation requested' });
      return true;
    }
  
    // DELETE /violation-cache/report/:id
    if (method === 'DELETE' && idMatch) {
      const id  = idMatch[1];
      const job = reportJobs.get(id);
      if (!job) { jsonReply(res, 404, { error: 'Report not found' }); return true; }
      if (job.status === 'running') {
        jsonReply(res, 409, { error: 'Cancel the job before deleting it' });
        return true;
      }
      // Delete the file only for completed jobs (failed jobs never produced a file)
      if (job.status === 'completed' && job.filePath && fs.existsSync(job.filePath)) {
        try { fs.unlinkSync(job.filePath); } catch (e) {
          log('warn', `Could not delete report file ${job.filePath}: ${e.message}`);
        }
      }
      reportJobs.delete(id);
      saveRegistry();
      log('info', `Report job ${id} deleted`);
      jsonReply(res, 200, { ok: true });
      return true;
    }

  return false;
}

module.exports = { handle };
