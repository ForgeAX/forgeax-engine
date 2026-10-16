import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import caseReportSchema from '../../../schemas/case-report.schema.json' with { type: 'json' };
import { mergePipelineEvidenceFromPaths } from '../../report/merge-pipeline-evidence';

const repoRoot = resolve(import.meta.dirname, '../../../../../..');
const closureEnabled = process.env.FORGEAX_PARITY_RUN_CLOSURE === '1';
const directCaseIds = [
  'direct-directional-urp',
  'direct-khr-spot-urp',
  'direct-point-urp',
  'direct-spot-urp',
] as const;
const validateCaseReport = new Ajv2020({ allErrors: true, strict: false }).compile(caseReportSchema);

function configuredPath(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : resolve(repoRoot, value);
}

function producerArtifactPath(basePath: string, caseId: string): string {
  return basePath.endsWith('.json')
    ? `${basePath.slice(0, -'.json'.length)}-${caseId}.json`
    : `${basePath}-${caseId}.json`;
}

describe('M4 direct-light closure gate', () => {
  it.skipIf(!closureEnabled)('validates every persisted producer pair and unique CaseReport', async () => {
    const invocationId = process.env.FORGEAX_PARITY_INVOCATION_ID;
    if (invocationId === undefined || invocationId.length === 0) {
      throw new Error('FORGEAX_PARITY_INVOCATION_ID is required for the M4 closure gate');
    }
    const reportDirectory = configuredPath(
      process.env.FORGEAX_PARITY_REPORT_DIR,
      resolve(repoRoot, 'report/color-lighting-parity/cases'),
    );
    const urpArtifactBase = configuredPath(
      process.env.FORGEAX_PARITY_URP_ARTIFACT,
      resolve(repoRoot, 'report/color-lighting-parity/pipeline-evidence/browser-urp.json'),
    );
    const hdrpArtifactBase = configuredPath(
      process.env.FORGEAX_PARITY_HDRP_ARTIFACT,
      resolve(repoRoot, 'report/color-lighting-parity/pipeline-evidence/dawn-hdrp.json'),
    );

    for (const caseId of directCaseIds) {
      const urpPath = producerArtifactPath(urpArtifactBase, caseId);
      const hdrpPath = producerArtifactPath(hdrpArtifactBase, caseId);
      const merged = await mergePipelineEvidenceFromPaths(invocationId, [urpPath, hdrpPath]);
      expect(merged.ok, `${caseId}: ${merged.ok ? '' : merged.error.hint}`).toBe(true);
      if (!merged.ok) throw new Error(`${caseId}: ${merged.error.hint}`);

      const reportPath = resolve(reportDirectory, `${caseId}.json`);
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as unknown;
      expect(validateCaseReport(report), `${caseId}: CaseReport schema validation failed`).toBe(true);
      expect(report).toEqual(merged.value.report);
      expect(merged.value.report.caseId).toBe(caseId);
      expect(merged.value.report.required).toBe(true);
      expect(merged.value.report.status).toBe('complete');
      expect(merged.value.report.verdict).toBe('passed');
      expect(merged.value.report.attachmentEvidence.missingPipelineIds).toEqual([]);
      expect(merged.value.report.attachmentEvidence.producers).toHaveLength(2);
      expect(merged.value.report.attachmentEvidence.producers.map((entry) => entry.pipelineId)).toEqual([
        'forgeax::standard',
        'forgeax::standard',
      ]);
      expect(merged.value.report.attachmentEvidence.producers.map((entry) => entry.runtimeId)).toEqual([
        'browser',
        'dawn',
      ]);
      for (const producer of merged.value.report.attachmentEvidence.producers) {
        expect(producer.copySrc).toBe(true);
        expect(producer.lifetime).toBe('active');
        expect(producer.source).toBe('live-producer');
        expect(producer.semantic).toBe('linear-hdr');
        expect(producer.linearHdr.format).toBe('rgba16float');
        expect(producer.linearHdr.bytes.length).toBeGreaterThan(0);
        expect(producer.finalDisplay.bytes.length).toBeGreaterThan(0);
        expect(producer.linearHdr.rawHash).toMatch(/^[0-9a-f]{64}$/);
        expect(producer.finalDisplay.rawHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
