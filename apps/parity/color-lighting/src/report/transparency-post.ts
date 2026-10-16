import type { CaseReport } from '../contracts/types';

export const TRANSPARENCY_POST_CASE_IDS = ['transparent-ldr-urp', 'transparent-hdr-hdrp'] as const;

export interface TransparencyPostReportCheck {
  readonly ok: boolean;
  readonly missingCaseIds: readonly string[];
  readonly failedCaseIds: readonly string[];
  readonly provenanceConflicts: readonly string[];
}

export function checkTransparencyPostReports(
  reports: readonly CaseReport[],
): TransparencyPostReportCheck {
  const byId = new Map(reports.map((report) => [report.caseId, report]));
  const missingCaseIds = TRANSPARENCY_POST_CASE_IDS.filter((caseId) => !byId.has(caseId));
  const failedCaseIds: string[] = [];
  const provenanceConflicts: string[] = [];
  for (const caseId of TRANSPARENCY_POST_CASE_IDS) {
    const report = byId.get(caseId);
    if (report === undefined) continue;
    if (
      report.status !== 'complete'
      || report.verdict !== 'passed'
      || !Number.isFinite(report.metrics.analyticMax)
      || !Number.isFinite(report.metrics.roiMax)
      || report.metrics.analyticMax > report.budget.analyticMax
      || report.metrics.roiMax > report.budget.roiMax
    ) failedCaseIds.push(caseId);
    if (
      report.provenance.forgeax.adapterId === undefined
      || report.provenance.three.adapterId === undefined
      || report.provenance.forgeax.adapterId === report.provenance.three.adapterId
    ) provenanceConflicts.push(caseId);
  }
  return {
    ok: missingCaseIds.length === 0 && failedCaseIds.length === 0 && provenanceConflicts.length === 0,
    missingCaseIds,
    failedCaseIds,
    provenanceConflicts,
  };
}
