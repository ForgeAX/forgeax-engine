import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AttachmentReport, CaseReport, CrossRuntimeCaseReport, VertexColorCaseReport } from '../contracts/types';

export async function writeCaseReport(
  path: string,
  report: CaseReport,
  attachmentEvidence?: AttachmentReport,
): Promise<void> {
  if (report.status === 'complete' && report.verdict !== 'passed') {
    throw new Error('complete CaseReport requires a passed verdict');
  }
  await mkdir(dirname(path), { recursive: true });
  const output = attachmentEvidence === undefined ? report : { ...report, attachmentEvidence };
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

export async function writeCrossRuntimeCaseReport(
  path: string,
  report: CrossRuntimeCaseReport,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function writeVertexColorCaseReport(
  path: string,
  report: VertexColorCaseReport,
): Promise<void> {
  if (report.frameCount !== 60 || report.verdict !== 'passed' || report.status !== 'complete') {
    throw new Error('vertex-color report writer only publishes complete passing evidence');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
