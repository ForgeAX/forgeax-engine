import type { AttachmentEvidence } from '../capture/attachment-readback';
import { validateAttachmentEvidence } from '../capture/attachment-readback';
import type { AttachmentReport } from '../contracts/types';

export type CapabilityStatus = 'missing' | 'unsupported' | 'degraded' | 'supported';
export type ExecutionStatus = 'notExecuted' | 'running' | 'partial' | 'complete';
export type CaseVerdict = 'notRun' | 'failed' | 'passed';
export type DerivedCaseStatus = 'partial' | 'failed' | 'complete';

export interface CoverageCounts {
  total: number;
  pass: number;
  failed: number;
  unsupported: number;
  degraded: number;
  notExecuted: number;
}

export interface FinalCoverageStatusInput {
  readonly required: CoverageCounts;
  readonly primary: CoverageCounts;
  readonly matrix: CoverageCounts;
}

export function deriveFinalCoverageStatus(input: FinalCoverageStatusInput): DerivedCaseStatus {
  const groups = [input.required, input.primary, input.matrix];
  if (groups.some((group) => group.total === 0)) return 'partial';
  if (groups.some((group) => group.failed > 0)) return 'failed';
  if (groups.some((group) => group.pass !== group.total)) return 'partial';
  return 'complete';
}

export interface CaseStatusInput {
  readonly capabilityStatus: CapabilityStatus;
  readonly executionStatus: ExecutionStatus;
  readonly verdict: CaseVerdict;
  readonly required?: boolean;
  readonly primary?: boolean;
  readonly matrixComplete?: boolean;
  readonly readbackComplete?: boolean;
}

export function deriveCaseStatus(input: CaseStatusInput): DerivedCaseStatus {
  if (input.capabilityStatus === 'missing' || input.capabilityStatus === 'unsupported') return 'failed';
  if (input.capabilityStatus === 'degraded') return 'partial';
  if (input.executionStatus !== 'complete' || input.verdict !== 'passed') {
    return input.verdict === 'failed' ? 'failed' : 'partial';
  }
  if (input.readbackComplete === false) return 'partial';
  if (input.required === true && input.primary !== true) return 'partial';
  if (input.matrixComplete === false) return 'partial';
  return 'complete';
}

export function deriveAttachmentReportStatus(input: AttachmentReport): DerivedCaseStatus {
  if (input.missingPipelineIds.length > 0) return 'failed';
  if (input.capabilityStatus === 'missing' || input.capabilityStatus === 'unsupported') return 'failed';
  if (input.attachmentReadbackStatus === 'failed') return 'failed';
  if (
    input.capabilityStatus === 'degraded' ||
    input.attachmentReadbackStatus !== 'complete' ||
    input.executionStatus !== 'complete' ||
    input.verdict !== 'passed'
  ) {
    return 'partial';
  }
  return 'complete';
}

const REQUIRED_PIPELINES = ['forgeax::standard'] as const;

export interface PipelineAuditObservation {
  readonly caseId: string;
  readonly pipelineId: 'forgeax::standard';
  readonly evidence: AttachmentEvidence;
  readonly semantic: 'linear-hdr';
  readonly source: 'live-producer' | 'replay' | 'final-canvas';
  readonly copySrc: boolean;
  readonly lifetime: 'active' | 'retired';
  readonly size: { readonly width: number; readonly height: number };
  readonly normalization: {
    readonly authorityId: 'threeR184SquaredWindow' | 'other';
    readonly intensityScale: number;
    readonly rangeModel: 'squared-finite' | 'unsquared' | 'guessed';
    readonly coneModel: 'radians-to-degrees' | 'guessed';
  };
}

export interface CrossPipelineAuditInput {
  readonly caseId: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly missingPipelineIds: readonly string[];
  readonly urp: PipelineAuditObservation;
  readonly hdrp: PipelineAuditObservation;
}

export interface CrossPipelineAuditResult {
  readonly ok: boolean;
  readonly missingPipelineIds: readonly string[];
  readonly firstDivergence: { readonly owner: 'cross-pipeline'; readonly metric: 'linearHdr.rawHash' } | null;
  readonly reasons: readonly string[];
}

function completeAttachmentReport(observation: PipelineAuditObservation): AttachmentReport {
  return {
    linearHdr: observation.evidence.linearHdr,
    finalDisplay: observation.evidence.finalDisplay,
    attachmentReadbackStatus: 'complete',
    capabilityStatus: 'supported',
    executionStatus: 'complete',
    verdict: 'passed',
    missingPipelineIds: [],
  };
}

function auditObservation(
  expectedCaseId: string,
  expectedPipelineId: PipelineAuditObservation['pipelineId'],
  expectedSize: { readonly width: number; readonly height: number },
  observation: PipelineAuditObservation,
): string[] {
  const reasons: string[] = [];
  const evidenceResult = validateAttachmentEvidence(observation.evidence, expectedPipelineId);
  if (!evidenceResult.ok) reasons.push(evidenceResult.error.reason);
  if (observation.caseId !== expectedCaseId) reasons.push('case identity mismatch');
  if (observation.pipelineId !== expectedPipelineId) reasons.push('pipeline identity mismatch');
  if (observation.semantic !== 'linear-hdr') reasons.push('semantic is not linear-hdr');
  if (observation.source !== 'live-producer') reasons.push('capture source is not a live producer');
  if (!observation.copySrc) reasons.push('producer attachment lacks COPY_SRC');
  if (observation.lifetime !== 'active') reasons.push('producer attachment lifetime is stale');
  if (observation.evidence.linearHdr.format !== 'rgba16float') reasons.push('linear format is not rgba16float');
  if (!/^(rgba|bgra)8unorm$/.test(observation.evidence.finalDisplay.format ?? '')) {
    reasons.push('final format is not native unorm');
  }
  if (
    observation.size.width !== expectedSize.width
    || observation.size.height !== expectedSize.height
    || observation.evidence.linearHdr.size?.width !== observation.size.width
    || observation.evidence.linearHdr.size?.height !== observation.size.height
  ) {
    reasons.push('producer size is not the SceneCase size');
  }
  if (
    observation.normalization.authorityId !== 'threeR184SquaredWindow'
    || observation.normalization.intensityScale !== 1
    || observation.normalization.rangeModel !== 'squared-finite'
    || observation.normalization.coneModel !== 'radians-to-degrees'
  ) {
    reasons.push('light normalization is not the frozen authority');
  }
  if (deriveAttachmentReportStatus(completeAttachmentReport(observation)) !== 'complete') {
    reasons.push('attachment report is not complete');
  }
  return reasons;
}

export function auditCrossPipelineEvidence(input: CrossPipelineAuditInput): CrossPipelineAuditResult {
  const reasons = [
    ...auditObservation(input.caseId, 'forgeax::standard', input.size, input.urp),
    ...auditObservation(input.caseId, 'forgeax::standard', input.size, input.hdrp),
  ];
  const observedPipelineIds = new Set([input.urp.pipelineId, input.hdrp.pipelineId]);
  const missingPipelineIds = [
    ...new Set([
      ...input.missingPipelineIds,
      ...REQUIRED_PIPELINES.filter((pipelineId) => !observedPipelineIds.has(pipelineId)),
    ]),
  ];
  if (missingPipelineIds.length > 0) reasons.push('required pipeline evidence is missing');
  if (input.urp === input.hdrp || input.urp.evidence === input.hdrp.evidence) reasons.push('same evidence object used for both pipelines');
  return {
    ok: reasons.length === 0,
    missingPipelineIds,
    firstDivergence: reasons.length === 0 ? { owner: 'cross-pipeline', metric: 'linearHdr.rawHash' } : null,
    reasons,
  };
}
