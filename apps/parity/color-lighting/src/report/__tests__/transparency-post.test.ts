import { describe, expect, it } from 'vitest';
import type { CaseReport } from '../../contracts/types';
import { checkTransparencyPostReports } from '../transparency-post';

function report(caseId: string, passed = true): CaseReport {
  return {
    schemaVersion: 1,
    caseId,
    required: true,
    provenance: {
      forgeax: { implementation: 'forgeax', version: 'workspace', adapterId: 'forgeax-webgpu' },
      three: { implementation: 'three', version: 'r184', renderer: 'webgpu', adapterId: 'three-r184-webgpu' },
    },
    captures: {
      forgeax: { linear: [], final: [1], hash: 'forgeax' },
      three: { linear: [], final: [1], hash: 'three' },
    },
    budget: { analyticMax: 0.05, roiMax: 0.05, byteMax: 255 },
    metrics: { analyticMax: passed ? 0.01 : 0.06, roiMax: passed ? 0.01 : 0.06, differingBytes: 0 },
    verdict: passed ? 'passed' : 'failed',
    status: passed ? 'complete' : 'failed',
  };
}

describe('transparency post report gate', () => {
  it('requires both paired cases and finite analytic/ROI budgets', () => {
    expect(checkTransparencyPostReports([
      report('transparent-ldr-urp'),
      report('transparent-hdr-hdrp'),
    ]).ok).toBe(true);
    expect(checkTransparencyPostReports([report('transparent-ldr-urp')]).missingCaseIds).toEqual([
      'transparent-hdr-hdrp',
    ]);
    expect(checkTransparencyPostReports([
      report('transparent-ldr-urp', false),
      report('transparent-hdr-hdrp'),
    ]).failedCaseIds).toEqual(['transparent-ldr-urp']);
  });
});
