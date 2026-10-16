import { deriveFinalCoverageStatus, type CoverageCounts, type DerivedCaseStatus } from '../report/status';
import { PARITY_REQUIRED_BACKEND_IDS } from './required-cases';

export const MATRIX_STATUSES = ['pass', 'failed', 'unsupported', 'degraded', 'not-executed'] as const;
export type MatrixStatus = (typeof MATRIX_STATUSES)[number];

export interface CoverageCaseInput {
  caseId: string;
  required: boolean;
  applicableBackends?: readonly string[];
  matrixRequiredBackends?: readonly string[];
  matrixBackendStatuses?: Readonly<Record<string, MatrixStatus>>;
  requiredStatus: MatrixStatus;
  primaryStatus: MatrixStatus;
  matrixStatus: MatrixStatus;
  owner?: string;
}

export interface CoverageStatusInput {
  cases: readonly CoverageCaseInput[];
  backends?: Readonly<Record<string, MatrixStatus>>;
  missingPipelineIds?: readonly string[];
}

export interface CoverageStatus {
  status: DerivedCaseStatus;
  required: CoverageCounts;
  primary: CoverageCounts;
  matrix: CoverageCounts;
}

export interface CoverageStatusIndex extends CoverageStatus {
  schemaVersion: 1;
  authority: 'case-manifest-and-case-report';
  cases: readonly CoverageCaseInput[];
  backends: Readonly<Record<string, MatrixStatus>>;
  missingCaseIds: readonly string[];
  missingMatrixCaseIds: readonly string[];
  missingBackendIds: readonly string[];
  missingPipelineIds: readonly string[];
}

export interface VisualEvidenceArtifact {
  kind: 'forgeax-final' | 'three-primary-final' | 'diff-roi';
  url: string;
  path: string;
  caseId: string;
  width: number;
  height: number;
  background: readonly [number, number, number, number];
  frameId: number;
  rawHash: string;
  expected: string;
  observed: string;
  verdict: 'pass' | 'fail' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
}

export interface VisualEvidenceIndex {
  caseId: string;
  width: number;
  height: number;
  background: readonly [number, number, number, number];
  framing: string;
  artifacts: VisualEvidenceArtifact[];
}

const REQUIRED_VISUAL_KINDS = ['forgeax-final', 'three-primary-final', 'diff-roi'] as const;

function emptyCounts(): CoverageCounts {
  return { total: 0, pass: 0, failed: 0, unsupported: 0, degraded: 0, notExecuted: 0 };
}

function countOne(counts: CoverageCounts, status: MatrixStatus): void {
  counts.total += 1;
  if (status === 'not-executed') counts.notExecuted += 1;
  else counts[status] += 1;
}

function countStatus(
  cases: readonly CoverageCaseInput[],
  key: keyof Pick<CoverageCaseInput, 'requiredStatus' | 'primaryStatus' | 'matrixStatus'>,
): CoverageCounts {
  const counts = emptyCounts();
  for (const item of cases) {
    if (!item.required) continue;
    countOne(counts, item[key]);
  }
  return counts;
}

function countMatrixStatus(cases: readonly CoverageCaseInput[]): CoverageCounts {
  const counts = emptyCounts();
  for (const item of cases) {
    if (!item.required) continue;
    const requiredBackends = item.matrixRequiredBackends;
    if (requiredBackends === undefined) {
      countOne(counts, item.matrixStatus);
      continue;
    }
    for (const backendId of requiredBackends) {
      countOne(counts, item.matrixBackendStatuses?.[backendId] ?? 'not-executed');
    }
  }
  return counts;
}

export function deriveCoverageStatus(input: CoverageStatusInput): CoverageStatus {
  const required = countStatus(input.cases, 'requiredStatus');
  const primary = countStatus(input.cases, 'primaryStatus');
  const matrix = countMatrixStatus(input.cases);
  return {
    status: deriveFinalCoverageStatus({ required, primary, matrix }),
    required,
    primary,
    matrix,
  };
}

export function buildStatusIndex(input: CoverageStatusInput): CoverageStatusIndex {
  const derived = deriveCoverageStatus(input);
  const missingCaseIds = input.cases
    .filter((item) => item.required && item.requiredStatus !== 'pass')
    .map((item) => item.caseId);
  const missingMatrixCaseIds = input.cases
    .filter((item) => {
      if (!item.required) return false;
      const requiredBackends = item.matrixRequiredBackends;
      if (requiredBackends === undefined) return item.matrixStatus !== 'pass';
      return requiredBackends.some((backendId) => item.matrixBackendStatuses?.[backendId] !== 'pass');
    })
    .map((item) => item.caseId);
  const backends = input.backends ?? {};
  const missingBackendIds = input.backends === undefined
    ? []
    : PARITY_REQUIRED_BACKEND_IDS.filter((backendId) => backends[backendId] !== 'pass');
  const missingPipelineIds = [...(input.missingPipelineIds ?? [])];
  const incomplete = missingCaseIds.length > 0
    || missingMatrixCaseIds.length > 0
    || missingBackendIds.length > 0
    || missingPipelineIds.length > 0;
  const status = incomplete && derived.status === 'complete' ? 'partial' : derived.status;
  return {
    schemaVersion: 1,
    authority: 'case-manifest-and-case-report',
    ...derived,
    status,
    cases: input.cases,
    backends,
    missingCaseIds,
    missingMatrixCaseIds,
    missingBackendIds,
    missingPipelineIds,
  };
}

function sameTuple(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateVisualEvidence(input: VisualEvidenceIndex): { ok: true } | { ok: false; reason: string } {
  if (input.caseId.length === 0 || input.framing.length === 0) return { ok: false, reason: 'case identity or framing is missing' };
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1) {
    return { ok: false, reason: 'visual size is invalid' };
  }
  if (input.artifacts.length !== REQUIRED_VISUAL_KINDS.length) return { ok: false, reason: 'required visual artifact is missing' };
  const kinds = input.artifacts.map((artifact) => artifact.kind);
  if (new Set(kinds).size !== kinds.length || REQUIRED_VISUAL_KINDS.some((kind) => !kinds.includes(kind))) {
    return { ok: false, reason: 'visual artifact kinds are not complete and unique' };
  }
  for (const artifact of input.artifacts) {
    if (
      artifact.caseId !== input.caseId
      || artifact.width !== input.width
      || artifact.height !== input.height
      || !sameTuple(artifact.background, input.background)
      || artifact.url.length === 0
      || artifact.path.length === 0
      || !Number.isInteger(artifact.frameId)
      || artifact.rawHash.length === 0
      || artifact.expected.length === 0
      || artifact.observed.length === 0
      || !['pass', 'fail', 'unknown'].includes(artifact.verdict)
      || !['high', 'medium', 'low'].includes(artifact.confidence)
    ) {
      return { ok: false, reason: 'visual artifact provenance does not match the case' };
    }
  }
  return { ok: true };
}
