// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// Multi-sheet XLSX generation. The only consumer of exceljs.

const ExcelJS = require('exceljs');    // MIT-licensed Excel generation library

// ── Excel report builder ──────────────────────────────────────────────────────
/**
 * Build a multi-sheet XLSX report and write it to filePath.
 * Sheets are added only for the risk types present in reportData.riskTypes:
 *
 *   security    → Vulnerability Findings, Security Project Summary, Component Summary
 *   license     → License Violations, License Project Summary
 *   operational → Operational Violations, Operational Project Summary
 *
 * @param {string} filePath
 * @param {{ riskTypes: string[],
 *           secFindings: object[], secProjectSummary: Map, secComponentMap: Map,
 *           licViolations: object[], licProjectSummary: Map,
 *           opsViolations: object[], opsProjectSummary: Map }} reportData
 */
async function buildExcelReport(filePath, reportData) {
  const {
    riskTypes,
    secFindings, secProjectSummary, secComponentMap,
    licViolations, licProjectSummary,
    opsViolations, opsProjectSummary,
  } = reportData;

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Dependency-Track Risk Dashboard';
  wb.created  = new Date();
  wb.modified = new Date();

  function styleHeader(sheet) {
    const row = sheet.getRow(1);
    row.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF374151' } };
    row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    row.height    = 28;
    sheet.views   = [{ state: 'frozen', ySplit: 1 }];
  }

  function alternateShading(sheet) {
    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      if (rowNum % 2 === 0) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
        });
      }
    });
  }

  // ── Security sheets ───────────────────────────────────────────────────────
  if (riskTypes.includes('security')) {
    // Sheet: Vulnerability Findings
    const ws1 = wb.addWorksheet('SV_Vulnerability Findings');
    ws1.columns = [
      { header: 'S.No',            key: 'sno',        width: 6  },
      { header: 'Project Name',    key: 'projName',   width: 28 },
      { header: 'Project Version', key: 'projVer',    width: 14 },
      { header: 'Vulnerability',   key: 'vulnId',     width: 20 },
      { header: 'Severity',        key: 'severity',   width: 12 },
      { header: 'CWE',             key: 'cwe',        width: 22 },
      { header: 'Score',           key: 'score',      width: 8  },
      { header: 'Component',       key: 'component',  width: 36 },
      { header: 'Current Version', key: 'curVer',     width: 14 },
      { header: 'Latest Version',  key: 'latestVer',  width: 14 },
    ];
    styleHeader(ws1);
    secFindings.forEach((f, idx) => {
      const v    = f.vulnerability || {};
      const c    = f.component     || {};
      const cwes = (v.cwes || []).map(w => `CWE-${w.cweId}`).join(', ');
      const comp = [c.name, c.group].filter(Boolean).join('-');
      ws1.addRow({
        sno:       idx + 1,
        projName:  c.projectName    || '',
        projVer:   c.projectVersion || '',
        vulnId:    v.vulnId         || '',
        severity:  v.severity       || '',
        cwe:       cwes,
        score:     v.cvssV3BaseScore != null ? v.cvssV3BaseScore : '',
        component: comp,
        curVer:    c.version        || '',
        latestVer: c.latestVersion  || '',
      });
    });
    alternateShading(ws1);

    // Sheet: Security Project Summary
    const ws2 = wb.addWorksheet('SV_Project Summary');
    ws2.columns = [
      { header: 'S.No',            key: 'sno',        width: 6  },
      { header: 'Project Name',    key: 'projName',   width: 28 },
      { header: 'Project Version', key: 'projVer',    width: 14 },
      { header: 'Critical',        key: 'critical',   width: 10 },
      { header: 'High',            key: 'high',       width: 10 },
      { header: 'Medium',          key: 'medium',     width: 10 },
      { header: 'Low',             key: 'low',        width: 10 },
      { header: 'Unassigned',      key: 'unassigned', width: 12 },
    ];
    styleHeader(ws2);
    let sno2 = 1;
    for (const s of secProjectSummary.values()) {
      ws2.addRow({
        sno: sno2++, projName: s.name, projVer: s.version || '',
        critical: s.critical, high: s.high, medium: s.medium, low: s.low, unassigned: s.unassigned,
      });
    }

    // Sheet: Component Summary
    const ws3 = wb.addWorksheet('SV_Component Summary');
    ws3.columns = [
      { header: 'S.No',                key: 'sno',      width: 6  },
      { header: 'Component',           key: 'comp',     width: 40 },
      { header: 'Vulnerability Count', key: 'count',    width: 18 },
      { header: 'Affected Projects',   key: 'projects', width: 55 },
    ];
    styleHeader(ws3);
    let sno3 = 1;
    const sortedComps = [...secComponentMap.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [comp, entry] of sortedComps) {
      ws3.addRow({
        sno: sno3++, comp, count: entry.count,
        projects: [...entry.projects].sort().join(', '),
      });
    }
  }

  // ── License sheets ────────────────────────────────────────────────────────
  if (riskTypes.includes('license')) {
    // Sheet 1: License Violations (one row per violation)
    const wsL1 = wb.addWorksheet('LR_Violations');
    wsL1.columns = [
      { header: 'S.No',              key: 'sno',         width: 6  },
      { header: 'Project Name',      key: 'projName',    width: 28 },
      { header: 'Project Version',   key: 'projVer',     width: 14 },
      { header: 'Component',         key: 'component',   width: 36 },
      { header: 'Component Version', key: 'compVer',     width: 14 },
      { header: 'License Name',      key: 'licenseName', width: 34 },
      { header: 'License ID',        key: 'licenseId',   width: 24 },
      { header: 'Policy Condition',  key: 'license',     width: 30 },
      { header: 'Policy',            key: 'policy',      width: 30 },
      { header: 'State',             key: 'state',       width: 10 },
    ];
    styleHeader(wsL1);
    licViolations.forEach((v, idx) => {
      wsL1.addRow({
        sno:         idx + 1,
        projName:    v.projName,
        projVer:     v.projVersion,
        component:   v.component,
        compVer:     v.compVersion,
        licenseName: v.licenseName,
        licenseId:   v.licenseId,
        license:     v.license,
        policy:      v.policy,
        state:       v.state,
      });
    });
    alternateShading(wsL1);

    // Sheet 2: License Project Summary
    const wsL2 = wb.addWorksheet('LR_Project Summary');
    wsL2.columns = [
      { header: 'S.No',            key: 'sno',      width: 6  },
      { header: 'Project Name',    key: 'projName', width: 28 },
      { header: 'Project Version', key: 'projVer',  width: 14 },
      { header: 'Fail',            key: 'fail',     width: 10 },
      { header: 'Warn',            key: 'warn',     width: 10 },
      { header: 'Info',            key: 'info',     width: 10 },
    ];
    styleHeader(wsL2);
    let snoL = 1;
    for (const s of licProjectSummary.values()) {
      wsL2.addRow({ sno: snoL++, projName: s.name, projVer: s.version || '', fail: s.fail, warn: s.warn, info: s.info });
    }

    // Sheet 3: Unique License Risks — one row per unique component + component version.
    // Aggregates violation counts and affected projects across all fetched data.
    const compLicMap = new Map(); // key: "component||compVersion" → entry
    for (const v of licViolations) {
      const key = `${v.component}||${v.compVersion}`;
      if (!compLicMap.has(key)) {
        compLicMap.set(key, {
          component:   v.component,
          compVersion: v.compVersion,
          licenseName: v.licenseName,
          licenseId:   v.licenseId,
          fail: 0, warn: 0, info: 0,
          projects: new Set(),
        });
      }
      const entry = compLicMap.get(key);
      // Prefer non-empty licenseName/licenseId if a later violation has it
      if (!entry.licenseName && v.licenseName) entry.licenseName = v.licenseName;
      if (!entry.licenseId   && v.licenseId)   entry.licenseId   = v.licenseId;
      const st = v.state.toLowerCase();
      if (st === 'fail') entry.fail++;
      else if (st === 'warn') entry.warn++;
      else entry.info++;
      entry.projects.add(v.projName);
    }
    const wsL3 = wb.addWorksheet('LR_Unique Risks');
    wsL3.columns = [
      { header: 'S.No',               key: 'sno',         width: 6  },
      { header: 'Component',          key: 'component',   width: 36 },
      { header: 'Component Version',  key: 'compVer',     width: 14 },
      { header: 'License Name',       key: 'licenseName', width: 34 },
      { header: 'License ID',         key: 'licenseId',   width: 24 },
      { header: 'Total Violations',   key: 'total',       width: 16 },
      { header: 'Fail',               key: 'fail',        width: 10 },
      { header: 'Warn',               key: 'warn',        width: 10 },
      { header: 'Info',               key: 'info',        width: 10 },
      { header: 'Affected Projects',  key: 'projCount',   width: 16 },
      { header: 'Project Names',      key: 'projNames',   width: 60 },
    ];
    styleHeader(wsL3);
    // Sort by Fail desc, Warn desc, total desc
    const sortedCompsL = [...compLicMap.values()].sort((a, b) => {
      if (b.fail !== a.fail) return b.fail - a.fail;
      if (b.warn !== a.warn) return b.warn - a.warn;
      return (b.fail + b.warn + b.info) - (a.fail + a.warn + a.info);
    });
    let snoL3 = 1;
    for (const e of sortedCompsL) {
      wsL3.addRow({
        sno:         snoL3++,
        component:   e.component,
        compVer:     e.compVersion,
        licenseName: e.licenseName,
        licenseId:   e.licenseId,
        total:       e.fail + e.warn + e.info,
        fail:        e.fail,
        warn:        e.warn,
        info:        e.info,
        projCount:   e.projects.size,
        projNames:   [...e.projects].sort().join(', '),
      });
    }
    alternateShading(wsL3);
  }

  // ── Operational sheets ────────────────────────────────────────────────────
  if (riskTypes.includes('operational')) {
    // Sheet: Operational Violations
    const wsO1 = wb.addWorksheet('OR_Violations');
    wsO1.columns = [
      { header: 'S.No',              key: 'sno',       width: 6  },
      { header: 'Project Name',      key: 'projName',  width: 28 },
      { header: 'Project Version',   key: 'projVer',   width: 14 },
      { header: 'Component',         key: 'component', width: 36 },
      { header: 'Component Version', key: 'compVer',   width: 14 },
      { header: 'Policy',            key: 'policy',    width: 30 },
      { header: 'Subject',           key: 'subject',   width: 20 },
      { header: 'Condition',         key: 'condition', width: 24 },
      { header: 'State',             key: 'state',     width: 10 },
    ];
    styleHeader(wsO1);
    opsViolations.forEach((v, idx) => {
      wsO1.addRow({
        sno:       idx + 1,
        projName:  v.projName,
        projVer:   v.projVersion,
        component: v.component,
        compVer:   v.compVersion,
        policy:    v.policy,
        subject:   v.subject,
        condition: v.condition,
        state:     v.state,
      });
    });
    alternateShading(wsO1);

    // Sheet: Operational Project Summary
    const wsO2 = wb.addWorksheet('OR_Project Summary');
    wsO2.columns = [
      { header: 'S.No',            key: 'sno',      width: 6  },
      { header: 'Project Name',    key: 'projName', width: 28 },
      { header: 'Project Version', key: 'projVer',  width: 14 },
      { header: 'Fail',            key: 'fail',     width: 10 },
      { header: 'Warn',            key: 'warn',     width: 10 },
      { header: 'Info',            key: 'info',     width: 10 },
    ];
    styleHeader(wsO2);
    let snoO = 1;
    for (const s of opsProjectSummary.values()) {
      wsO2.addRow({ sno: snoO++, projName: s.name, projVer: s.version || '', fail: s.fail, warn: s.warn, info: s.info });
    }

    // Sheet 3: Unique Operational Risks — one row per unique component + version
    const opsCompMap = new Map(); // key: "component||compVersion" → entry
    for (const v of opsViolations) {
      const key = `${v.component}||${v.compVersion}`;
      if (!opsCompMap.has(key)) {
        opsCompMap.set(key, {
          component:   v.component,
          compVersion: v.compVersion,
          fail: 0, warn: 0, info: 0,
          projects: new Set(),
        });
      }
      const entry = opsCompMap.get(key);
      const st = v.state.toLowerCase();
      if (st === 'fail') entry.fail++;
      else if (st === 'warn') entry.warn++;
      else entry.info++;
      entry.projects.add(v.projName);
    }
    const wsO3 = wb.addWorksheet('OR_Unique Risks');
    wsO3.columns = [
      { header: 'S.No',              key: 'sno',       width: 6  },
      { header: 'Component',         key: 'component', width: 36 },
      { header: 'Component Version', key: 'compVer',   width: 14 },
      { header: 'Fail',              key: 'fail',      width: 10 },
      { header: 'Warn',              key: 'warn',      width: 10 },
      { header: 'Info',              key: 'info',      width: 10 },
      { header: 'Affected Projects', key: 'projCount', width: 16 },
      { header: 'Project Names',     key: 'projNames', width: 60 },
    ];
    styleHeader(wsO3);
    const sortedOpsComps = [...opsCompMap.values()].sort((a, b) => {
      if (b.fail !== a.fail) return b.fail - a.fail;
      if (b.warn !== a.warn) return b.warn - a.warn;
      return (b.fail + b.warn + b.info) - (a.fail + a.warn + a.info);
    });
    let snoO3 = 1;
    for (const e of sortedOpsComps) {
      wsO3.addRow({
        sno:       snoO3++,
        component: e.component,
        compVer:   e.compVersion,
        fail:      e.fail,
        warn:      e.warn,
        info:      e.info,
        projCount: e.projects.size,
        projNames: [...e.projects].sort().join(', '),
      });
    }
    alternateShading(wsO3);
  }

  await wb.xlsx.writeFile(filePath);
}

module.exports = { buildExcelReport };
