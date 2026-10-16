export declare const PERFORMANCE_ADMISSION_SCHEMA_VERSION: 'hello-taa-performance-admission/1';
export declare const WEBGL2_PERFORMANCE_ADMISSION_SCHEMA_VERSION: 'hello-taa-webgl2-performance-admission/1';
export declare const RESOLUTIONS: readonly [
  { readonly name: '1080p'; readonly width: 1920; readonly height: 1080 },
  { readonly name: '1440p'; readonly width: 2560; readonly height: 1440 },
  { readonly name: '4K'; readonly width: 3840; readonly height: 2160 },
];
export declare const PERFORMANCE_ADMISSION_THRESHOLDS: {
  readonly native1080p: { readonly medianMs: 1.5; readonly p95Ms: 2.5 };
  readonly cpuWebgl2: { readonly relativeMedian: 0.2 };
};
export interface RunnerFacts {
  readonly environment: string;
  readonly os: string;
  readonly arch: string;
  readonly queue: string;
}
export interface CpuAffinityProvenance {
  readonly ok: true;
  readonly mode: 'none' | 'taskset';
  readonly reason: string;
  readonly runnerCpus: number;
  readonly containerized: boolean;
  readonly allowedCpuCount: number;
  readonly allowedCpuList: string;
  readonly selectedCpuCount?: number;
  readonly selectedCpuList?: string;
}
export type CpuAffinityResult =
  | { readonly ok: true; readonly cpuAffinity: CpuAffinityProvenance }
  | { readonly ok: false; readonly reason: string };
export type RunnerProvenanceResult =
  | { readonly ok: true; readonly runnerName: string; readonly runnerClass: string; readonly runnerFacts: RunnerFacts }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly runnerName: string | null;
      readonly runnerFacts: Partial<RunnerFacts>;
      readonly runnerClass?: string;
    };

export interface TemporalTargetDescriptor {
  readonly format: 'rgba16float';
  readonly width: number;
  readonly height: number;
  readonly sampleCount: 1;
  readonly bytes: number;
}
export interface TemporalTargetObservation {
  readonly identity: 'standard-scene-temporal';
  readonly producerId: 'forgeax::standard::scene-data';
  readonly schema: 'forgeax::scene-data::temporal-v1';
  readonly targetCount: 1;
  readonly descriptor: TemporalTargetDescriptor;
}
export interface DawnTemporalState {
  readonly status: 'stable' | 'off' | 'first-frame' | 'reset' | 'aborted';
  readonly historyValid: boolean;
  readonly historyAttempt: 'none' | 'begun' | 'committed' | 'aborted';
  readonly epoch: number;
}
export interface DawnCreationObservation {
  readonly texture: number;
  readonly buffer: number;
  readonly pipeline: number;
}
export interface DawnSummary {
  readonly backend: 'webgpu';
  readonly framesObserved: number;
  readonly temporal: DawnTemporalState;
  readonly temporalTarget: TemporalTargetObservation;
  readonly creation: DawnCreationObservation;
  readonly passes: readonly string[];
}
export interface PerformanceIdentity {
  readonly testedRevision: string;
  readonly sourceRevision: string;
  readonly buildDigest: string;
  readonly source: { readonly path: string; readonly sha256: string };
  readonly build: { readonly command: string; readonly packageSha256: string };
}
export interface CorrectnessEvidence {
  readonly schemaVersion: typeof PERFORMANCE_ADMISSION_SCHEMA_VERSION;
  readonly lane: 'correctness-lavapipe';
  readonly status: 'pass';
  readonly acceptance: 'correctness-only';
  readonly timingAdmission: 'not-admitted';
  readonly testedRevision: string;
  readonly sourceRevision: string;
  readonly buildDigest: string;
  readonly runner: { readonly class: string; readonly queue: string; readonly execution: string };
  readonly backend: 'webgpu';
  readonly gpuTimestamp: false;
  readonly source: PerformanceIdentity['source'];
  readonly build: PerformanceIdentity['build'];
  readonly observed: {
    readonly frames: number;
    readonly backend: 'webgpu';
    readonly temporal: DawnTemporalState;
    readonly producerPassCount: number;
    readonly motionBlurPassCount: number;
    readonly rasterPassCount: number;
    readonly temporalTargetCount: number;
    readonly temporalTarget: TemporalTargetObservation;
    readonly creation: DawnCreationObservation;
    readonly passes: readonly string[];
  };
  readonly resolutions: readonly {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly temporalTarget: { readonly format: 'rgba16float'; readonly sampleCount: 1; readonly bytes: number };
  }[];
}
export interface PerformanceAdmissionTiming {
  readonly source: 'wall-time' | 'page-rAF';
  readonly unit: 'ms' | 'ms/frame';
  readonly gpuTimestamp: false;
}
export interface PerformanceAdmissionPassStats {
  readonly producer: { readonly median: number; readonly p95: number };
  readonly blur: { readonly median: number; readonly p95: number };
}
/** Counts active logical work; passTrace remains the compiled topology. */
export interface PerformanceAdmissionPassCounters {
  readonly off: { readonly producer: 1; readonly blur: 0 };
  readonly on: { readonly producer: 1; readonly blur: 1 };
}
export interface ActivePassInspection {
  readonly perFramePassNames?: readonly string[];
  readonly passes?: readonly string[];
  readonly temporalTarget?: { readonly targetCount?: number };
  readonly motionBlur?: {
    readonly enabled?: boolean;
    readonly status?: string;
    readonly temporalDemand?: string | null;
  };
}
export interface PerformanceAdmissionBuildArtifact {
  readonly root: 'apps/hello/taa/dist';
  readonly indexSha256: string;
  readonly shaderManifestSha256: string;
  readonly sourcePayload: 'apps/hello/taa/index.html+src';
}
export type AccelerationAttestation =
  | { readonly kind: 'direct-device' }
  | {
      readonly kind: 'provider-backed-paravirtual';
      readonly provider: 'github-hosted/macos-15-xlarge';
      readonly deviceType: 'AppleParavirtGPU';
      readonly driver: 'AppleParavirtGPUMetalIOGPUFamily';
      readonly requestedBackend: 'metal';
      readonly isFallbackAdapter: false;
    };
export interface PhysicalAdapterFacts {
  readonly source: string;
  readonly vendor: string;
  readonly device: string;
  readonly driver: string;
  readonly deviceType: string;
  readonly physicalGpu: boolean;
  readonly requestedBackend: string | null;
  readonly isFallbackAdapter: boolean | null;
  readonly accelerationAttestation?: AccelerationAttestation;
  readonly provider?: string;
  readonly reason?: string;
}
export interface PerformanceAdmissionLaneBase {
  readonly warmupCount: number;
  readonly testedRevision: string;
  readonly sourceRevision: string;
  readonly buildDigest: string;
  readonly runnerName: string;
  readonly runnerClass: string;
  readonly runnerFacts: RunnerFacts;
  readonly cpuAffinity: CpuAffinityProvenance;
  readonly queue: string;
  readonly execution: string;
  readonly backend: string;
  readonly adapter: string;
  readonly resolution: { readonly width: 1920; readonly height: 1080 };
  readonly timing: PerformanceAdmissionTiming;
  readonly rawSamplesMs: { readonly off: readonly number[]; readonly on: readonly number[] };
  readonly passCounters: PerformanceAdmissionPassCounters;
  readonly rawPassSamplesMs?: { readonly producer: readonly number[]; readonly blur: readonly number[] };
  readonly passStatsMs?: PerformanceAdmissionPassStats;
}
export interface PerformanceAdmissionNativeLane extends PerformanceAdmissionLaneBase {
  readonly capabilities: { readonly timestampQuery: boolean; readonly rgba16floatRenderable: boolean };
  readonly adapterFacts: PhysicalAdapterFacts;
  readonly deltaMs: { readonly median: number; readonly p95: number };
}
export interface PerformanceAdmissionCpuLane extends PerformanceAdmissionLaneBase {
  readonly capabilities: { readonly compute: boolean; readonly storageBuffer: boolean; readonly rgba16floatRenderable: boolean };
  readonly relativeMedian: number;
}
export interface PerformanceAdmissionEvidence {
  readonly schemaVersion: typeof PERFORMANCE_ADMISSION_SCHEMA_VERSION;
  readonly lane: 'performance-admission';
  readonly status: 'pass';
  readonly testedRevision: string;
  readonly sourceRevision: string;
  readonly buildDigest: string;
  readonly buildArtifact: PerformanceAdmissionBuildArtifact;
  readonly protocol: { readonly sampleCount: number; readonly order: readonly ['off', 'on'] };
  readonly native1080p: PerformanceAdmissionNativeLane;
  readonly cpuWebgl2: PerformanceAdmissionCpuLane;
  readonly verdict: { readonly native1080p: 'pass' | 'fail'; readonly cpuWebgl2: 'pass' | 'fail'; readonly overall: 'pass' | 'fail' };
}
export interface PerformanceAdmissionUnavailableEvidence {
  readonly schemaVersion: typeof PERFORMANCE_ADMISSION_SCHEMA_VERSION;
  readonly lane: 'performance-admission';
  readonly status: 'unavailable';
  readonly acceptance: 'fail-closed';
  readonly exitPolicy: 'fail-closed';
  readonly runner: { readonly class: 'unknown'; readonly queue: 'unknown'; readonly execution: 'wall-time' };
  readonly runnerName?: string | null;
  readonly runnerFacts?: Partial<RunnerFacts>;
  readonly cpuAffinity?: CpuAffinityProvenance | null;
  readonly backend: 'unavailable';
  readonly gpuTimestamp: false;
  readonly reason: string;
  readonly thresholds: typeof PERFORMANCE_ADMISSION_THRESHOLDS;
}
export interface PerformanceAdmissionNativeSummary {
  readonly backend: 'webgpu';
  readonly framesObserved: number;
  readonly errors: readonly unknown[];
  readonly drawErrors: readonly unknown[];
  readonly resolution: { readonly width: 1920; readonly height: 1080 };
  readonly testedRevision: string;
  readonly sourceRevision: string;
  readonly buildDigest: string;
  readonly buildArtifact: PerformanceAdmissionBuildArtifact;
  readonly performanceAdmission:
    | {
        readonly status: 'available';
        readonly runnerName: string;
        readonly runnerClass: string;
        readonly runnerFacts: RunnerFacts;
        readonly cpuAffinity: CpuAffinityProvenance;
        readonly queue: string;
        readonly execution: string;
        readonly backend: 'webgpu-native' | 'webgpu';
        readonly adapter: string;
        readonly capabilities: { readonly timestampQuery: boolean; readonly rgba16floatRenderable: true };
        readonly adapterFacts: PhysicalAdapterFacts;
      }
    | { readonly status: 'unavailable'; readonly reason: string };
  readonly timing: {
    readonly source: 'wall-time';
    readonly unit: 'ms';
    readonly gpuTimestamp: false;
    readonly warmupCount: number;
    readonly sampleCount: number;
    readonly order: readonly ['off', 'on'];
    readonly offMs: readonly number[];
    readonly onMs: readonly number[];
    readonly passCounters: PerformanceAdmissionPassCounters;
    readonly rawPassSamplesMs?: { readonly producer: readonly number[]; readonly blur: readonly number[] };
  };
}
export interface PerformanceAdmissionCpuProducer {
  readonly schemaVersion: typeof WEBGL2_PERFORMANCE_ADMISSION_SCHEMA_VERSION;
  readonly status: 'observed';
  readonly testedRevision: string;
  readonly sourceRevision: string;
  readonly buildDigest: string;
  readonly buildArtifact: PerformanceAdmissionBuildArtifact;
  readonly runnerName: string;
  readonly runnerClass: string;
  readonly runnerFacts: RunnerFacts;
  readonly cpuAffinity: CpuAffinityProvenance;
  readonly queue: string;
  readonly execution: string;
  readonly adapterId: string;
  readonly backend: 'wgpu-webgl2';
  readonly capabilities: { readonly compute: false; readonly storageBuffer: false; readonly rgba16floatRenderable: true };
  readonly resolution: { readonly width: 1920; readonly height: 1080 };
  readonly timing: { readonly source: 'page-rAF'; readonly unit: 'ms/frame'; readonly gpuTimestamp: false };
  readonly protocol: { readonly warmupCount: number; readonly sampleCount: number; readonly order: readonly ['off', 'on'] };
  readonly rawSamplesMs: { readonly off: readonly number[]; readonly on: readonly number[] };
  readonly passCounters: PerformanceAdmissionPassCounters;
  readonly rawPassSamplesMs?: { readonly producer: readonly number[]; readonly blur: readonly number[] };
}
export interface PerformanceAdmissionAssemblyResult {
  readonly evidence: PerformanceAdmissionEvidence | undefined;
  readonly reason: string | undefined;
}
export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
}
export declare function temporalTargetBytes(width: number, height: number): number;
export declare function activePassCountersFromInspection(
  inspection?: ActivePassInspection,
): { readonly producer: number; readonly blur: number };
export declare function runnerProvenanceFromEnv(
  environment?: Readonly<Record<string, string | undefined>>,
): RunnerProvenanceResult;
export declare function cpuAffinityFromEnv(
  environment?: Readonly<Record<string, string | undefined>>,
): CpuAffinityResult;
export declare function performanceIdentityFromEnv(
  environment?: Readonly<Record<string, string | undefined>>,
  cwd?: string,
): {
  readonly checkoutRevision: string;
  readonly testedRevision: string;
  readonly sourceRevision: string;
  readonly testedRevisionMatchesCheckout: boolean;
};
export declare const ACCELERATION_ATTESTATION_KINDS: readonly ['direct-device', 'provider-backed-paravirtual'];
export declare function qualifiedNativeFromAttestation(
  attestation: AccelerationAttestation | undefined,
  context?: {
    readonly physicalGpu?: boolean;
    readonly provider?: string;
    readonly requestedBackend?: string | null;
    readonly isFallbackAdapter?: boolean;
    readonly runnerFacts?: Partial<RunnerFacts>;
  },
): boolean;
export declare function createCorrectnessEvidence(summary: DawnSummary, identity: PerformanceIdentity): CorrectnessEvidence;
export declare function validateCorrectnessEvidence(evidence: CorrectnessEvidence): ValidationResult;
export declare function quantile(samples: readonly number[], q: number): number | null;
export declare function assemblePerformanceAdmissionEvidence(
  nativeSummary: PerformanceAdmissionNativeSummary,
  cpuProducer: PerformanceAdmissionCpuProducer,
  identity: { readonly testedRevision: string; readonly sourceRevision: string; readonly buildDigest: string },
): PerformanceAdmissionAssemblyResult;
export declare function validatePerformanceAdmissionEvidence(evidence: PerformanceAdmissionEvidence | PerformanceAdmissionUnavailableEvidence): ValidationResult;
export declare function performanceAdmissionUnavailable(reason: string): PerformanceAdmissionUnavailableEvidence;
