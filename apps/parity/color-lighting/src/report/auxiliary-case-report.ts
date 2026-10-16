import type {
  CaseMetrics,
  NamedCaptures,
  ParityProvenance,
} from '../contracts/types';

export interface DawnAuxiliaryObservation {
  readonly caseId: string;
  readonly pipelineId: 'forgeax::standard';
  readonly backendId: string;
  readonly frameId: number;
  readonly bytes: readonly number[];
  readonly rawHash: string;
}

export interface AuxiliaryCaptureCaseReport {
  readonly schemaVersion: 2;
  readonly kind: 'capture-matrix';
  readonly caseId: string;
  readonly required: boolean;
  readonly invocationId: string;
  readonly sceneCaseIdentity: {
    readonly sourceHash: string;
    readonly semanticHash: string;
  };
  readonly primary: {
    readonly status: 'pass' | 'failed';
    readonly backendId: 'browser-webgpu';
    readonly forgeax: {
      readonly provenance: ParityProvenance;
      readonly captures: NamedCaptures;
    };
    readonly three: {
      readonly provenance: ParityProvenance;
      readonly captures: NamedCaptures;
    };
    readonly metrics: CaseMetrics;
  };
  readonly dawn: {
    readonly status: 'pass' | 'failed';
    readonly observations: readonly DawnAuxiliaryObservation[];
  };
  readonly verdict: 'passed' | 'failed';
  readonly status: 'complete' | 'failed';
}

export interface SerializedIblEvidence {
  readonly status: 'ready' | 'failed';
  readonly attachmentName: string;
  readonly layer: number;
  readonly bytes: readonly number[] | null;
  readonly format: string | null;
  readonly size: { readonly width: number; readonly height: number } | null;
  readonly rawHash: string | null;
  readonly frameId: number | null;
  readonly lifetime: { readonly frameId: number; readonly state: 'active' | 'retired' } | null;
  readonly capabilitySnapshot: { readonly rgba16floatRenderable: boolean };
  readonly fallbackArtifact: string | null;
  readonly lastKnownGood: string;
}

export interface SerializedIblCapability {
  readonly capabilityStatus: 'missing' | 'unsupported' | 'degraded' | 'supported';
  readonly executionStatus: 'notExecuted' | 'running' | 'partial' | 'complete';
  readonly verdict: 'notRun' | 'failed' | 'passed';
  readonly rgba16floatRenderable: boolean;
  readonly outputFormat: 'rgba16float' | null;
  readonly fallbackArtifact: 'white-cube' | null;
  readonly expectedImpact: string;
  readonly hint: string;
  readonly lastKnownGood: string;
}

export interface SerializedIblFinalDisplay {
  readonly status: SerializedIblEvidence['status'];
  readonly bytes: readonly number[] | null;
  readonly format: 'rgba8unorm' | null;
  readonly rawHash: string | null;
}

export interface IblAuxiliaryProducer {
  readonly capability: SerializedIblCapability;
  readonly evidence: SerializedIblEvidence;
  readonly finalDisplay: SerializedIblFinalDisplay;
  readonly analytic: {
    readonly environment: number;
    readonly payload: number;
    readonly reconstructed: number;
    readonly maxError: number;
  };
}

export interface IblCaseReport {
  readonly schemaVersion: 2;
  readonly kind: 'ibl';
  readonly caseId: string;
  readonly required: boolean;
  readonly invocationId: string;
  readonly producers: {
    readonly browser: IblAuxiliaryProducer;
    readonly dawn: IblAuxiliaryProducer;
  };
  readonly verdict: 'passed' | 'failed';
  readonly status: 'complete' | 'failed';
}

export type AuxiliaryCaseReport = AuxiliaryCaptureCaseReport | IblCaseReport;

function isReadyIblProducer(producer: IblAuxiliaryProducer): boolean {
  return producer.capability.capabilityStatus === 'supported'
    && producer.capability.executionStatus === 'complete'
    && producer.capability.verdict === 'passed'
    && producer.evidence.status === 'ready'
    && producer.evidence.bytes !== null
    && producer.evidence.rawHash !== null
    && producer.finalDisplay.status === 'ready'
    && producer.finalDisplay.bytes !== null
    && producer.finalDisplay.rawHash !== null
    && producer.analytic.maxError <= 1e-7;
}

export function createAuxiliaryCaptureCaseReport(input: {
  readonly caseId: string;
  readonly required: boolean;
  readonly invocationId: string;
  readonly sourceHash: string;
  readonly semanticHash: string;
  readonly forgeax: AuxiliaryCaptureCaseReport['primary']['forgeax'];
  readonly three: AuxiliaryCaptureCaseReport['primary']['three'];
  readonly metrics: CaseMetrics;
  readonly primaryStatus: 'pass' | 'failed';
  readonly dawn: AuxiliaryCaptureCaseReport['dawn'];
}): AuxiliaryCaptureCaseReport {
  const primaryStatus = input.primaryStatus;
  const status = primaryStatus === 'pass' && input.dawn.status === 'pass' ? 'complete' : 'failed';
  return {
    schemaVersion: 2,
    kind: 'capture-matrix',
    caseId: input.caseId,
    required: input.required,
    invocationId: input.invocationId,
    sceneCaseIdentity: { sourceHash: input.sourceHash, semanticHash: input.semanticHash },
    primary: {
      status: primaryStatus,
      backendId: 'browser-webgpu',
      forgeax: input.forgeax,
      three: input.three,
      metrics: input.metrics,
    },
    dawn: input.dawn,
    verdict: status === 'complete' ? 'passed' : 'failed',
    status,
  };
}

export function createIblCaseReport(input: {
  readonly caseId: string;
  readonly required: boolean;
  readonly invocationId: string;
  readonly browser: IblAuxiliaryProducer;
  readonly dawn: IblAuxiliaryProducer;
}): IblCaseReport {
  const status = isReadyIblProducer(input.browser) && isReadyIblProducer(input.dawn)
    ? 'complete'
    : 'failed';
  return {
    schemaVersion: 2,
    kind: 'ibl',
    caseId: input.caseId,
    required: input.required,
    invocationId: input.invocationId,
    producers: { browser: input.browser, dawn: input.dawn },
    verdict: status === 'complete' ? 'passed' : 'failed',
    status,
  };
}
