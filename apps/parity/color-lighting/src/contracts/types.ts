import type { ObservationCapture } from '../capture/attachment-readback';
import type { CapabilityStatus, CaseVerdict, ExecutionStatus } from '../report/status';

export type ColorDomain = 'linearHdr' | 'linearLdr' | 'displayEncoded';
export type PrimaryMetric = 'rgba' | 'alpha' | 'occupancy';
export type PipelineIdentity = 'standard';
export type LightKind = 'directional' | 'point' | 'spot' | 'rect-area';

export interface SceneCasePipeline {
  readonly identity: PipelineIdentity;
  readonly engineId: 'forgeax::standard';
  readonly renderPath: 'forward' | 'deferred';
}

export interface SceneCaseLight {
  readonly authorityId: string;
  readonly kind: LightKind;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly range?: number;
  readonly direction?: readonly [number, number, number];
  readonly innerConeDeg?: number;
  readonly outerConeDeg?: number;
  readonly width?: number;
  readonly height?: number;
  readonly center?: readonly [number, number, number];
  readonly axisX?: readonly [number, number, number];
  readonly axisY?: readonly [number, number, number];
}

export interface SceneCaseImport {
  readonly source: 'none' | 'KHR_lights_punctual';
  readonly intensityScale: number;
  readonly rangeZero: 'no-cutoff';
  readonly cone: 'radians-to-degrees';
}

export interface SceneCaseBudget {
  readonly analyticMax: number;
  readonly roiMax: number;
  readonly byteMax: number;
}

export interface SceneDefinition {
  readonly width: number;
  readonly height: number;
  readonly background: readonly [number, number, number, number];
}

export interface SceneCaseComparison {
  readonly primaryMetric: PrimaryMetric;
}

export interface ExtendedLightingCase {
  readonly topology: 'extendedLighting';
  readonly carrier: 'rect-area' | 'spot-modifiers' | 'probe' | 'recovery';
  readonly iesSliceCount: number;
  readonly cookieSliceCount: number;
  readonly cookieMatrixCount: number;
  readonly expectedComposition: 'brdf*range*cone*ies*cookie*shadow';
  readonly cookieColorDomain: 'linear';
  readonly evidencePlan: {
    readonly expectations: readonly string[];
    readonly identity: { readonly fixtureId: string; readonly sourceKey: string };
    readonly numericRoi: {
      readonly analyticMax: number;
      readonly roiMax: number;
      readonly epsilon: number;
      readonly colorDomain: 'linearHdr';
    };
    readonly recordReceipt: {
      readonly status: 'not-run' | 'ready' | 'recovered';
      readonly byteLength: 160;
      readonly maxBytes: 160;
    };
    readonly resourceReceipt: {
      readonly status: 'not-run' | 'candidate' | 'accepted' | 'lkg' | 'recovered';
      readonly topology: 'extendedLighting';
    };
    readonly falsifiers: readonly { readonly id: string; readonly expectedFailure: string }[];
  };
}

export interface SceneCase {
  readonly caseId: string;
  readonly required: boolean;
  readonly colorDomain: ColorDomain;
  readonly pipeline?: SceneCasePipeline;
  readonly light?: SceneCaseLight;
  readonly import?: SceneCaseImport;
  readonly comparison?: SceneCaseComparison;
  readonly extendedLighting?: ExtendedLightingCase;
  readonly scene: SceneDefinition;
  readonly budget: SceneCaseBudget;
}

export type VertexColorBackend = 'browser-webgpu' | 'dawn';
export type VertexColorDomain = 'linearHdr' | 'displayEncoded';
export type VertexColorReadbackMethod = 'copyTextureToBuffer' | 'readRenderTargetPixelsAsync';
export type VertexColorCaseId =
  | 'vertex-color-vec3'
  | 'vertex-color-vec4'
  | 'vertex-color-normalized'
  | 'vertex-color-skinning'
  | 'vertex-color-mixed-primitives'
  | 'vertex-color-mask-taa'
  | 'vertex-color-no-color-baseline';
export type VertexColorRgba = readonly [number, number, number, number];

export interface VertexColorSemanticFixture {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly semantic: string;
  readonly colorDomain: VertexColorDomain;
  readonly samplePoints: readonly {
    readonly id: string;
    readonly coordinate: readonly [number, number];
  }[];
  readonly [field: string]: unknown;
}

export interface VertexColorProducerIdentity {
  readonly implementation: 'forgeax' | 'three';
  readonly version: string;
  readonly renderer: 'webgpu';
  readonly adapterId: string;
  readonly pinnedCommit: string;
  readonly buildIdentity: string;
}

export interface VertexColorSampleObservation {
  readonly id: string;
  readonly coordinate: readonly [number, number];
  readonly expected: VertexColorRgba;
  readonly observed: {
    readonly forgeax: VertexColorRgba;
    readonly three: VertexColorRgba;
  };
  readonly rgbMaxDelta: number;
  readonly alphaDelta: number;
  readonly verdict: 'passed' | 'failed';
  readonly confidence: 'high' | 'medium' | 'low';
}

export interface VertexColorProducerSample {
  readonly id: string;
  readonly coordinate: readonly [number, number];
  readonly rgba: VertexColorRgba;
}

export interface VertexColorCaptureOutput {
  readonly backend: VertexColorBackend;
  readonly frameCount: 60;
  readonly sourceSha: string;
  readonly sourceFixtureHash: string;
  readonly colorDomain: VertexColorDomain;
  readonly samples: readonly VertexColorProducerSample[];
  readonly linear: readonly number[];
  readonly final: readonly number[];
  readonly readback: VertexColorReadbackMethod;
}

export interface VertexColorFalsifierResult {
  readonly kind: 'white-color' | 'no-color-baseline';
  readonly verdict: 'passed' | 'failed';
  readonly observed: string;
}

export interface VertexColorCaseReport {
  readonly schemaVersion: 3;
  readonly kind: 'vertex-color';
  readonly caseId: string;
  readonly required: true;
  readonly invocationId: string;
  readonly backend: VertexColorBackend;
  readonly sourceSha: string;
  readonly sourceFixtureHash: string;
  readonly colorDomain: VertexColorDomain;
  readonly frameCount: 60;
  readonly epsilon: { readonly rgb: 0.05; readonly alpha: 0.05 };
  readonly producers: { readonly forgeax: VertexColorProducerIdentity; readonly three: VertexColorProducerIdentity };
  readonly samples: readonly VertexColorSampleObservation[];
  readonly falsifier: VertexColorFalsifierResult;
  readonly artifacts: readonly string[];
  readonly verdict: 'passed' | 'failed';
  readonly status: 'complete' | 'failed' | 'blocked';
}

export interface ParityProvenance {
  readonly implementation: string;
  readonly version: string;
  readonly renderer?: string;
  readonly adapterId?: string;
}

export interface NamedCaptures {
  readonly linear: readonly number[];
  readonly final: readonly number[];
  readonly hash: string;
}

export interface CaseMetrics {
  readonly analyticMax: number;
  readonly roiMax: number;
  readonly differingBytes: number;
}

export interface FirstDivergence {
  readonly owner: string;
  readonly metric: 'analytic' | 'roi' | 'bytes';
}

export interface CaseReport {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly required: boolean;
  readonly pipeline?: SceneCasePipeline;
  readonly light?: SceneCaseLight;
  readonly import?: SceneCaseImport;
  readonly provenance: {
    readonly forgeax: ParityProvenance;
    readonly three: ParityProvenance;
  };
  readonly captures: {
    readonly forgeax: NamedCaptures;
    readonly three: NamedCaptures;
  };
  readonly readback?: {
    readonly forgeax?: string;
    readonly three?: string;
  };
  readonly attachmentEvidence?: AttachmentReport;
  readonly budget: SceneCaseBudget;
  readonly metrics: CaseMetrics;
  readonly verdict: CaseVerdict;
  readonly status: 'partial' | 'failed' | 'complete';
  readonly firstDivergence?: FirstDivergence | null;
}

export type AttachmentReadbackStatus = 'complete' | 'partial' | 'failed' | 'blocked';

export interface AttachmentReport {
  readonly linearHdr: ObservationCapture;
  readonly finalDisplay: ObservationCapture;
  readonly attachmentReadbackStatus: AttachmentReadbackStatus;
  readonly capabilityStatus: CapabilityStatus;
  readonly executionStatus: ExecutionStatus;
  readonly verdict: CaseVerdict;
  readonly missingPipelineIds: readonly string[];
}

export interface ValidationDetail {
  readonly path: readonly string[];
  readonly keyword?: string;
  readonly message: string;
}

export interface ValidationError {
  readonly code: 'schema-invalid' | 'non-finite-value' | 'file-read-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: ValidationDetail;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ValidationError };

export type PipelineEvidencePipelineId = 'forgeax::standard';
export type PipelineEvidenceRuntimeId = 'browser' | 'dawn';

export interface PipelineEvidenceObservation {
  readonly kind: 'linearHdr' | 'finalDisplay';
  readonly status: 'ready';
  readonly bytes: readonly number[];
  readonly format: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly rawHash: string;
  readonly frameId: number;
  readonly pipelineId: PipelineEvidencePipelineId;
  readonly backendId: string;
}

export interface PipelineEvidenceNormalization {
  readonly authorityId: 'threeR184SquaredWindow';
  readonly intensityScale: 1;
  readonly rangeModel: 'squared-finite';
  readonly coneModel: 'radians-to-degrees';
}

export interface PipelineEvidenceArtifact {
  readonly schemaVersion: 1;
  readonly invocationId: string;
  readonly caseId: string;
  readonly sceneCase: Record<string, unknown>;
  readonly sourceHash: string;
  readonly semanticHash: string;
  readonly pipelineId: PipelineEvidencePipelineId;
  readonly runtimeId: PipelineEvidenceRuntimeId;
  readonly backendId: string;
  readonly frameId: number;
  readonly copySrc: true;
  readonly lifetime: 'active';
  readonly semantic: 'linear-hdr';
  readonly source: 'live-producer';
  readonly provenance: ParityProvenance & { readonly adapterId: string };
  readonly normalization: PipelineEvidenceNormalization;
  readonly linearHdr: PipelineEvidenceObservation;
  readonly finalDisplay: PipelineEvidenceObservation;
}

export type PipelineEvidence = PipelineEvidenceArtifact;

export interface CrossRuntimeProducerReport {
  readonly pipelineId: PipelineEvidencePipelineId;
  readonly runtimeId: PipelineEvidenceRuntimeId;
  readonly backendId: string;
  readonly frameId: number;
  readonly copySrc: true;
  readonly lifetime: 'active';
  readonly provenance: PipelineEvidenceArtifact['provenance'];
  readonly semantic: 'linear-hdr';
  readonly source: 'live-producer';
  readonly sourceHash: string;
  readonly semanticHash: string;
  readonly linearHdr: PipelineEvidenceObservation;
  readonly finalDisplay: PipelineEvidenceObservation;
}

export interface CrossRuntimeAttachmentReport {
  readonly producers: readonly CrossRuntimeProducerReport[];
  readonly attachmentReadbackStatus: 'complete' | 'failed';
  readonly capabilityStatus: 'supported';
  readonly executionStatus: 'complete' | 'partial';
  readonly verdict: 'passed' | 'failed';
  readonly capturedPipelineIds: readonly 'standard'[];
  readonly missingPipelineIds: readonly 'standard'[];
}

export interface CrossRuntimeCaseReport {
  readonly schemaVersion: 2;
  readonly caseId: string;
  readonly required: boolean;
  readonly invocationId: string;
  readonly sceneCaseIdentity: {
    readonly sourceHash: string;
    readonly semanticHash: string;
  };
  readonly attachmentEvidence: CrossRuntimeAttachmentReport;
  readonly verdict: 'passed' | 'failed';
  readonly status: 'complete' | 'failed';
}
