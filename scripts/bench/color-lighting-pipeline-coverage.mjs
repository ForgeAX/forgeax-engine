/**
 * Derive pipeline coverage from the persisted cross-runtime report.
 *
 * The report's capturedPipelineIds is the only pipeline identity authority;
 * producer adapter labels are deliberately not reinterpreted here.
 */
export function collectMissingPipelineIds({ reports, requiredPipelineIds, validateReport }) {
  const observed = new Set();
  for (const report of reports) {
    if (
      !validateReport(report) ||
      report?.schemaVersion !== 2 ||
      report?.status !== 'complete' ||
      report?.verdict !== 'passed'
    ) {
      continue;
    }
    for (const pipelineId of report.attachmentEvidence?.capturedPipelineIds ?? []) {
      if (typeof pipelineId === 'string') observed.add(pipelineId);
    }
  }
  return requiredPipelineIds.filter((pipelineId) => !observed.has(pipelineId));
}
