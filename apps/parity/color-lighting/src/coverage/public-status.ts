import {
  buildStatusIndex,
  type CoverageCaseInput,
  type CoverageStatusIndex,
  type MatrixStatus,
} from './build-status-index';
import {
  PARITY_CASE_AUTHORITY,
  PARITY_REQUIRED_CASE_IDS,
} from './required-cases';

export interface PublicParityStatusInput {
  readonly caseStatuses?: Readonly<Record<string, MatrixStatus>>;
  readonly caseBackendStatuses?: Readonly<Record<string, Readonly<Record<string, MatrixStatus>>>>;
  readonly backends: Readonly<Record<string, MatrixStatus>>;
  readonly missingPipelineIds?: readonly string[];
}

export interface InjectedVisualEvidenceStatusInput {
  readonly caseId: string;
  readonly status?: unknown;
  readonly verdict?: unknown;
}

export function mergeInjectedVisualEvidenceStatuses(
  caseStatuses: Readonly<Record<string, MatrixStatus>>,
  caseBackendStatuses: Readonly<Record<string, Readonly<Record<string, MatrixStatus>>>>,
  inputs: readonly InjectedVisualEvidenceStatusInput[],
): {
  readonly caseStatuses: Readonly<Record<string, MatrixStatus>>;
  readonly caseBackendStatuses: Readonly<Record<string, Readonly<Record<string, MatrixStatus>>>>;
} {
  const mergedCaseStatuses: Record<string, MatrixStatus> = { ...caseStatuses };
  const mergedCaseBackendStatuses: Record<string, Record<string, MatrixStatus>> = Object.fromEntries(
    Object.entries(caseBackendStatuses).map(([caseId, statuses]) => [caseId, { ...statuses }]),
  );
  for (const input of inputs) {
    const status: MatrixStatus = input.status === 'complete' && input.verdict === 'passed'
      ? 'pass'
      : 'failed';
    mergedCaseStatuses[input.caseId] = status;
    mergedCaseBackendStatuses[input.caseId] = {
      ...(mergedCaseBackendStatuses[input.caseId] ?? {}),
      'browser-webgpu': status,
    };
  }
  return { caseStatuses: mergedCaseStatuses, caseBackendStatuses: mergedCaseBackendStatuses };
}

function backendMatrixStatus(
  caseStatus: MatrixStatus,
  observedBackends: Readonly<Record<string, MatrixStatus>> | undefined,
  requiredBackends: readonly string[],
): MatrixStatus {
  if (caseStatus === 'failed') return 'failed';
  if (requiredBackends.length === 0) return 'pass';
  const backendStatuses = requiredBackends.map((backendId) => observedBackends?.[backendId] ?? 'not-executed');
  if (backendStatuses.some((status) => status === 'failed')) return 'failed';
  if (!backendStatuses.every((status) => status === 'pass')) return 'not-executed';
  return caseStatus;
}

export function buildPublicParityStatusIndex(input: PublicParityStatusInput): CoverageStatusIndex {
  const caseStatuses = input.caseStatuses ?? {};
  const caseBackendStatuses = input.caseBackendStatuses ?? {};
  const cases: CoverageCaseInput[] = PARITY_CASE_AUTHORITY.map((authorityEntry) => {
    const caseStatus = caseStatuses[authorityEntry.caseId] ?? 'not-executed';
    const observedBackends = caseBackendStatuses[authorityEntry.caseId];
    return {
      caseId: authorityEntry.caseId,
      required: authorityEntry.required,
      applicableBackends: authorityEntry.applicableBackends,
      matrixRequiredBackends: authorityEntry.matrixRequiredBackends,
      ...(observedBackends === undefined ? {} : { matrixBackendStatuses: observedBackends }),
      owner: authorityEntry.owner,
      requiredStatus: caseStatus,
      primaryStatus: observedBackends?.['browser-webgpu'] ?? 'not-executed',
      matrixStatus: backendMatrixStatus(caseStatus, observedBackends, authorityEntry.matrixRequiredBackends),
    };
  });
  return buildStatusIndex({
    cases,
    backends: input.backends,
    ...(input.missingPipelineIds === undefined ? {} : { missingPipelineIds: input.missingPipelineIds }),
  });
}

export function isPublicParityComplete(index: CoverageStatusIndex): boolean {
  return index.status === 'complete'
    && index.missingCaseIds.length === 0
    && index.missingMatrixCaseIds.length === 0
    && index.missingBackendIds.length === 0
    && index.missingPipelineIds.length === 0
    && PARITY_REQUIRED_CASE_IDS.every((caseId) => {
      const item = index.cases.find((entry) => entry.caseId === caseId);
      return item?.requiredStatus === 'pass' && item.matrixStatus === 'pass';
    });
}

export function parityCommandExitCode(input: {
  readonly browserStageOk?: boolean;
  readonly browserOk?: boolean;
  readonly statusIndex: CoverageStatusIndex;
}): 0 | 1 {
  const browserStageOk = input.browserStageOk ?? input.browserOk ?? false;
  return browserStageOk && isPublicParityComplete(input.statusIndex) ? 0 : 1;
}
