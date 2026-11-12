import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { createProfiler } from '@forgeax/engine-profiler';
import type { FrameReceipt, FrameReceiptObservation } from '@forgeax/engine-render';
import {
  AMBIENT_OCCLUSION_GTAO,
  AMBIENT_OCCLUSION_QUALITY_HIGH,
  AMBIENT_OCCLUSION_QUALITY_MEDIUM,
  AMBIENT_OCCLUSION_SSAO,
  AmbientOcclusion,
  MeshFilter,
  MeshRenderer,
  PointLight,
  Skylight,
} from '@forgeax/engine-render';
import type {
  RendererHostAssembly,
  RendererLegacyHostAdapter,
} from '@forgeax/engine-render/internal/construct-renderer';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { MorphWeights, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import {
  composeLinearLightingReference,
  computeGtaoRawReference,
  filterGtaoReference,
  GTAO_COMPARISON_BUDGET,
  materialNormalFieldMetrics,
  reverseZDeviceDepth,
  sampleGtaoBilinearLinearClamp,
} from '../../../render/src/__tests__/gtao-reference';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
} from '../../../render/src/gpu-usage';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  base64Bytes,
  byteChannel,
  byteErrorMetrics,
  captureForwardGtaoBuffer,
  captureForwardGtaoLinearHdr,
  captureForwardGtaoTarget,
  ForwardGtaoCaptureNotReadyError,
  type ForwardGtaoLinearCapture,
  ForwardGtaoLinearCaptureNotReadyError,
  linearErrorMetrics,
  recordedClusterOwnerWrite,
  recordedStandardMainFragmentSource,
  rgba16FloatPixel,
  rgba16FloatRgb,
  sha256Hex,
  stableForwardGtaoGraphTargetProjection,
} from './helpers/forward-gtao-capture';
import {
  consumeVerifiedForwardGtaoCandidateFault,
  describeForwardGtaoFailure,
  requireNoForwardGtaoRendererErrors,
  throwForForwardGtaoRendererErrors,
  type VerifiedForwardGtaoCandidateFault,
  verifyForwardGtaoCandidateFault,
  writeForwardGtaoFailureReport,
} from './helpers/forward-gtao-failure';
import { resolveForwardGtaoMaterialLineage } from './helpers/forward-gtao-material-lineage';
import {
  createForwardGtaoOrthographicCamera,
  createForwardGtaoOrthographicReferenceField,
  createForwardGtaoReferenceField,
  createForwardGtaoScene,
  FORWARD_GTAO_FIXTURE,
} from './helpers/forward-gtao-scene';
import { createForwardGtaoSceneDataConsumer } from './helpers/forward-gtao-scene-data';

type DebugDrawHost = RendererHostAssembly['debugDrawHost'] &
  Pick<
    RendererLegacyHostAdapter,
    | 'getCurrentGraphTarget'
    | 'requestGraphTargetCapture'
    | 'cancelGraphTargetCapture'
    | 'setGtaoExecutionOverrideForConformance'
    | 'armGtaoCandidatePreparationFailureForConformance'
    | 'setClusterWorkObservationForConformance'
    | 'clusterWorkObservationForConformance'
    | 'clusterWorkFrameTraceForConformance'
    | 'setFeatureGraphTraceForConformance'
    | 'featureGraphTraceForConformance'
  >;
type ClusterWorkObservation = NonNullable<
  ReturnType<RendererLegacyHostAdapter['clusterWorkObservationForConformance']>
>;
type CapturedClusterWork = Extract<ClusterWorkObservation, { readonly status: 'captured' }>;
type RendererInspection = ReturnType<RendererHostAssembly['renderer']['inspect']>;
type SceneDataSurfacePlan = NonNullable<
  ReturnType<ReturnType<typeof createForwardGtaoSceneDataConsumer>['latestPlan']>
>;
type SceneDataSurfaceTarget = NonNullable<ReturnType<DebugDrawHost['getCurrentGraphTarget']>>;
type SceneDataFrameTrace = NonNullable<
  ReturnType<DebugDrawHost['clusterWorkFrameTraceForConformance']>
>;
type FinalDisplayObservation = Extract<
  NonNullable<FrameReceiptObservation['observations']>[number],
  { readonly domain: 'final-display' }
>;
type DirectStrengthCaptureMetadata = {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly backendId?: string;
  readonly format: string;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
  readonly readbackIdentity: number;
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly footprint: {
    readonly resourceCount: number;
    readonly bindGroupCount: number;
  };
};
type CapturedSceneDataCopyTape = Readonly<{
  readonly tape: EncodedTape;
  readonly receipt: Readonly<{
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly presentation: FrameReceipt['presentation'];
  }>;
  readonly recordFrameNumber: number;
  readonly frameTrace: SceneDataFrameTrace;
  readonly graphPassNames: readonly string[];
  readonly perFramePassNames: readonly string[];
  readonly consumerPlanFrameNumber: number | null;
  readonly consumerSubmittedWork: unknown;
}>;
type GtaoInspection = NonNullable<
  NonNullable<RendererInspection['standardLighting']>['ambientOcclusion']
>;
type CandidatePreparationFaultSnapshot = {
  readonly event: unknown;
  readonly error: unknown;
  readonly inspection: RendererInspection;
};

type FeatureGraphDiagnosticSnapshot = Readonly<{
  readonly features: readonly string[];
  readonly featureDiagnostic:
    | {
        readonly identity: string;
        readonly status: string;
        readonly latestError: unknown;
      }
    | { readonly status: 'not-obtained' };
  readonly featureHost: unknown;
  readonly featureGraph: unknown;
  readonly perFramePassNames: readonly string[];
  readonly standardGraphPassNames: readonly string[];
  readonly receipt: unknown;
  readonly recordFrameNumber: number | null;
  readonly publicObservationFrameId: number | null;
  readonly deviceGeneration: number;
  readonly graphGeneration: number | null;
  readonly viewIdentity: string | null;
  readonly planOwner: unknown;
  readonly target: unknown;
  readonly submittedWork: unknown;
  readonly featureGraphTrace: unknown;
}>;

type FeatureGraphDiagnosticRow = Readonly<{
  readonly phase: string;
  readonly publicReceiptFrameId: number | null;
  readonly retainedRecordFrameNumber: number | null;
  readonly snapshot: FeatureGraphDiagnosticSnapshot;
}>;

const MAX_FEATURE_GRAPH_DIAGNOSTIC_ROWS = 8;
const SCENE_DATA_OBSERVATION_SENTINEL = 0xa5c39e71;

function observationSentinelMetrics(bytes: Uint8Array, expectedWordCount: number) {
  if (bytes.byteLength !== expectedWordCount * Uint32Array.BYTES_PER_ELEMENT) {
    throw new Error(
      `SceneData observation sentinel readback size ${bytes.byteLength} does not match ${expectedWordCount} words`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let remainingSentinelWords = 0;
  for (let word = 0; word < expectedWordCount; word += 1) {
    if (
      view.getUint32(word * Uint32Array.BYTES_PER_ELEMENT, true) === SCENE_DATA_OBSERVATION_SENTINEL
    ) {
      remainingSentinelWords += 1;
    }
  }
  return Object.freeze({
    sentinelWord: SCENE_DATA_OBSERVATION_SENTINEL,
    totalWords: expectedWordCount,
    remainingSentinelWords,
    overwrittenWords: expectedWordCount - remainingSentinelWords,
    fullyOverwritten: remainingSentinelWords === 0,
  });
}

function frameResourceLabel(resource: ReturnType<typeof buildFrameModel>['resources'][number]) {
  const descriptor = resource.descriptor;
  if (
    descriptor === null ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    !('desc' in descriptor)
  ) {
    return undefined;
  }
  const desc = descriptor.desc;
  if (desc === null || typeof desc !== 'object' || Array.isArray(desc) || !('label' in desc)) {
    return undefined;
  }
  return typeof desc.label === 'string' ? desc.label : undefined;
}

function rememberFeatureGraphDiagnostic(
  rows: FeatureGraphDiagnosticRow[],
  row: FeatureGraphDiagnosticRow,
): void {
  if (rows.length >= MAX_FEATURE_GRAPH_DIAGNOSTIC_ROWS) {
    const replaceable = rows.findIndex(
      (candidate) => candidate.phase !== 'before-consumer-activation',
    );
    rows.splice(replaceable < 0 ? 0 : replaceable, 1);
  }
  rows.push(Object.freeze(row));
}

function validatedClusterFrameReceipt(
  receipt: FrameReceipt,
  observation: ClusterWorkObservation | undefined,
  frameTrace: SceneDataFrameTrace | undefined,
): {
  readonly observation: ClusterWorkObservation;
  readonly frameTrace: SceneDataFrameTrace;
  readonly pendingBarrier: boolean;
} {
  if (observation === undefined) {
    throw new Error(`Cluster owner observation is disabled after frame ${receipt.frameId}`);
  }
  if (frameTrace === undefined) {
    throw new Error(`Cluster frame trace is disabled after public receipt ${receipt.frameId}`);
  }
  if (
    observation.status === 'captured' &&
    observation.frameNumber !== frameTrace.recordFrameNumber
  ) {
    throw new Error(
      `Cluster owner record frame ${observation.frameNumber} does not match trace record frame ${frameTrace.recordFrameNumber}; public receipt ${receipt.frameId}`,
    );
  }
  const pendingBarrier = frameTrace.recordStatus === 'pending';
  if (
    (!pendingBarrier && frameTrace.recordStatus !== 'submitted') ||
    (pendingBarrier && receipt.presentation !== 'pending') ||
    frameTrace.observationFrameId !== receipt.frameId ||
    frameTrace.receipt?.publicReceiptFrameId !== receipt.frameId ||
    frameTrace.receipt?.presentation !== receipt.presentation ||
    frameTrace.receipt?.completion !== 'completed'
  ) {
    throw new Error(
      `RenderSystem attempt trace does not match public receipt ${receipt.frameId}: ${JSON.stringify(frameTrace)}`,
    );
  }
  if (
    observation.status !== 'captured' &&
    (!pendingBarrier || observation.reason !== 'awaiting-write')
  ) {
    throw new Error(
      `Cluster owner observation is unavailable after non-barrier frame ${receipt.frameId}: ${JSON.stringify({ observation, frameTrace })}`,
    );
  }
  return { observation, frameTrace, pendingBarrier };
}

function featureDiagnosticProjection(
  inspection: RendererInspection,
): FeatureGraphDiagnosticSnapshot['featureDiagnostic'] {
  const row = inspection.featureDiagnostics.find(
    (candidate) => candidate.identity === 'test.forward-gtao-scene-data-consumer',
  );
  return row === undefined
    ? { status: 'not-obtained' }
    : {
        identity: row.identity,
        status: row.status,
        latestError: row.latestError === undefined ? null : describeFailure(row.latestError),
      };
}

function featureHostProjection(inspection: RendererInspection) {
  const signature = inspection.featureHost?.signatures.find(
    (row) => row.featureIdentity === 'test.forward-gtao-scene-data-consumer',
  );
  return {
    prepared: inspection.featureHost?.prepared ?? null,
    signature:
      signature === undefined
        ? null
        : {
            featureIdentity: signature.featureIdentity,
            calls: signature.calls,
            cacheHits: signature.cacheHits,
            cacheMisses: signature.cacheMisses,
            nativeCalls: signature.nativeCalls ?? null,
          },
  };
}

function featureGraphProjection(inspection: RendererInspection) {
  const graph = inspection.featureGraph;
  return graph === undefined
    ? null
    : {
        planRevision: graph.planRevision,
        ensureCalls: graph.ensureCalls,
        reuseHits: graph.reuseHits,
        rebuildAttempts: graph.rebuildAttempts,
        compileAttempts: graph.compileAttempts,
        compileSuccesses: graph.compileSuccesses,
        compileFailures: graph.compileFailures,
        validationFailures: graph.validationFailures,
        buildFailures: graph.buildFailures,
        accepted: graph.accepted,
        rejected: graph.rejected,
        abandoned: graph.abandoned,
        last: graph.last,
      };
}

function sceneDataPlanOwner(plan: SceneDataSurfacePlan | undefined) {
  return plan === undefined
    ? { status: 'not-obtained' }
    : {
        featureFrameNumber: plan.frameNumber,
        viewIdentity: plan.viewIdentity,
        normalSchema: plan.normal.schema,
        depthSchema: plan.depth.schema,
        normalOwner: plan.normalOwner,
        depthOwner: plan.depthOwner,
      };
}

function diagnosticReceipt(receipt: FrameReceipt | undefined) {
  return receipt === undefined
    ? { status: 'not-obtained' }
    : {
        frameId: receipt.frameId,
        presentation: receipt.presentation,
        deviceGeneration: receipt.deviceGeneration,
        graphGeneration: receipt.graphGeneration ?? null,
      };
}

function diagnosticTarget(target: SceneDataSurfaceTarget | undefined) {
  return target === undefined
    ? { status: 'not-obtained' }
    : {
        name: target.name,
        recordFrameNumber: target.recordFrameNumber,
        graphGeneration: target.graphGeneration,
        textureIdentity: target.textureIdentity,
        descriptor: graphTargetDescriptorProjection(target),
      };
}

function featureGraphDiagnosticSnapshot(args: {
  readonly renderer: RendererHostAssembly['renderer'];
  readonly debugHost: DebugDrawHost;
  readonly receipt: FrameReceipt | undefined;
  readonly plan: SceneDataSurfacePlan | undefined;
  readonly submissionSnapshots: ReturnType<
    ReturnType<typeof createForwardGtaoSceneDataConsumer>['submittedWorkSnapshots']
  >;
}): FeatureGraphDiagnosticSnapshot {
  const inspection = args.renderer.inspect();
  const trace = args.debugHost.featureGraphTraceForConformance();
  const frameTrace = args.debugHost.clusterWorkFrameTraceForConformance();
  const target = args.debugHost.getCurrentGraphTarget('standard-scene-surface-normal');
  const submittedWork =
    args.plan === undefined
      ? undefined
      : args.submissionSnapshots.find((row) => row.planFrameNumber === args.plan?.frameNumber);
  return Object.freeze({
    features: Object.freeze([...inspection.features]),
    featureDiagnostic: featureDiagnosticProjection(inspection),
    featureHost: featureHostProjection(inspection),
    featureGraph: featureGraphProjection(inspection),
    perFramePassNames: Object.freeze([...inspection.perFramePassNames]),
    standardGraphPassNames: Object.freeze([...inspection.output.graphPassNames]),
    receipt: diagnosticReceipt(args.receipt),
    recordFrameNumber: frameTrace?.recordFrameNumber ?? null,
    publicObservationFrameId: frameTrace?.observationFrameId ?? null,
    deviceGeneration: args.receipt?.deviceGeneration ?? inspection.frame.deviceGeneration,
    graphGeneration:
      args.receipt?.graphGeneration ??
      target?.graphGeneration ??
      inspection.recoveryEvidence.graph.generation ??
      null,
    viewIdentity: args.plan?.viewIdentity ?? null,
    planOwner: sceneDataPlanOwner(args.plan),
    target: diagnosticTarget(target),
    submittedWork: submittedWork ?? { status: 'not-obtained' },
    featureGraphTrace: trace ?? { status: 'not-obtained' },
  });
}

function graphTargetDescriptorProjection(
  target: NonNullable<ReturnType<DebugDrawHost['getCurrentGraphTarget']>>,
) {
  return {
    format: target.descriptor.format,
    size: {
      width: target.descriptor.size.width,
      height: target.descriptor.size.height,
    },
    usage: target.descriptor.usage,
    sample: target.descriptor.sample,
  };
}

type CandidateRetryDisplaySnapshot = Readonly<{
  readonly requestDomain: 'final-display';
  readonly outputMetadata: FinalDisplayObservation['metadata'];
  readonly receipt: Readonly<{
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly graphGeneration: number | undefined;
    readonly presentation: FrameReceipt['presentation'];
    readonly observationDomains: FrameReceipt['observationDomains'];
  }> | null;
  readonly completedTrace: SceneDataFrameTrace | null;
  readonly clusterObservation: ClusterWorkObservation | null;
  readonly ambientOcclusion: GtaoInspection | null;
  readonly currentTargets: readonly ReturnType<typeof diagnosticTarget>[];
}>;

function snapshotCandidateRetryDisplay(input: {
  readonly output: FinalDisplayObservation;
  readonly receipt: FrameReceipt | undefined;
  readonly inspection: RendererInspection;
  readonly debugHost: DebugDrawHost;
  readonly frameTrace: SceneDataFrameTrace | undefined;
  readonly clusterObservation: ClusterWorkObservation | undefined;
}): CandidateRetryDisplaySnapshot {
  const names = ['standard-scene-surface-normal', 'ssao-raw', 'ssao-blurred'] as const;
  return Object.freeze({
    requestDomain: 'final-display',
    outputMetadata: Object.freeze({ ...input.output.metadata }),
    receipt:
      input.receipt === undefined
        ? null
        : Object.freeze({
            frameId: input.receipt.frameId,
            deviceGeneration: input.receipt.deviceGeneration,
            graphGeneration: input.receipt.graphGeneration,
            presentation: input.receipt.presentation,
            observationDomains: input.receipt.observationDomains,
          }),
    completedTrace: input.frameTrace ?? null,
    clusterObservation: input.clusterObservation ?? null,
    ambientOcclusion: input.inspection.standardLighting?.ambientOcclusion ?? null,
    currentTargets: Object.freeze(
      names.map((name) => diagnosticTarget(input.debugHost.getCurrentGraphTarget(name))),
    ),
  });
}

function assertCandidateRetryDisplaySnapshot(input: {
  readonly snapshot: CandidateRetryDisplaySnapshot;
  readonly receipt: FrameReceipt | undefined;
  readonly frameTrace: SceneDataFrameTrace | undefined;
  readonly clusterObservation: ClusterWorkObservation | undefined;
}): { readonly ambientOcclusion: GtaoInspection } {
  const { snapshot, receipt, frameTrace, clusterObservation } = input;
  if (receipt === undefined) {
    throw new Error('GTAO candidate retry final-display receipt is missing');
  }
  const ambientOcclusion = requireGtaoInspection(
    snapshot.ambientOcclusion ?? undefined,
    'GTAO candidate retry',
  );
  const clusterEvidence = validatedClusterFrameReceipt(receipt, clusterObservation, frameTrace);
  expect(snapshot.requestDomain).toBe('final-display');
  expect(receipt.observationDomains).toEqual(['final-display']);
  expect(snapshot.outputMetadata.frameId).toBe(receipt.frameId);
  expect(snapshot.outputMetadata.deviceGeneration).toBe(receipt.deviceGeneration);
  expect(snapshot.outputMetadata.graphGeneration).toBe(receipt.graphGeneration);
  expect(ambientOcclusion.graphGeneration).toBe(receipt.graphGeneration);
  expect(clusterEvidence.frameTrace.graphGeneration).toBe(receipt.graphGeneration);
  expect(clusterEvidence.frameTrace.receipt?.completion).toBe('completed');
  expect(snapshot.currentTargets).toMatchObject([
    {
      name: 'standard-scene-surface-normal',
      graphGeneration: receipt.graphGeneration,
      recordFrameNumber: frameTrace?.recordFrameNumber,
      textureIdentity: expect.any(Number),
      descriptor: expect.any(Object),
    },
    {
      name: 'ssao-raw',
      graphGeneration: receipt.graphGeneration,
      recordFrameNumber: frameTrace?.recordFrameNumber,
      textureIdentity: expect.any(Number),
      descriptor: expect.any(Object),
    },
    {
      name: 'ssao-blurred',
      graphGeneration: receipt.graphGeneration,
      recordFrameNumber: frameTrace?.recordFrameNumber,
      textureIdentity: expect.any(Number),
      descriptor: expect.any(Object),
    },
  ]);
  return { ambientOcclusion };
}

function assertCandidateRetryTargetCapture(
  capture: Awaited<ReturnType<typeof captureForwardGtaoTarget>>,
): void {
  expect(capture.frameTrace).toMatchObject({
    observationFrameId: capture.publicReceiptFrameId,
    graphGeneration: capture.graphGeneration,
    receipt: {
      publicReceiptFrameId: capture.publicReceiptFrameId,
      deviceGeneration: capture.deviceGeneration,
      presentation: 'ready',
      completion: 'completed',
    },
  });
}

function directStrengthGraphSnapshot(
  renderer: RendererHostAssembly['renderer'],
  debugHost: DebugDrawHost,
  receipt: FrameReceipt | undefined,
  outputMetadata: DirectStrengthCaptureMetadata,
) {
  if (receipt?.graphGeneration === undefined) {
    throw new Error('final-display frame is missing its graph generation receipt');
  }
  const frameTrace = debugHost.clusterWorkFrameTraceForConformance();
  validatedClusterFrameReceipt(
    receipt,
    debugHost.clusterWorkObservationForConformance(),
    frameTrace,
  );
  if (frameTrace === undefined) {
    throw new Error(`final-display receipt ${receipt.frameId} has no RenderSystem frame trace`);
  }
  const inspection = renderer.inspect();
  const captureMetadata = {
    publicReceiptFrameId: receipt.frameId,
    frameId: outputMetadata.frameId,
    deviceGeneration: outputMetadata.deviceGeneration,
    graphGeneration: outputMetadata.graphGeneration,
    backendId: outputMetadata.backendId ?? null,
    textureIdentity: outputMetadata.textureIdentity,
    readbackIdentity: outputMetadata.readbackIdentity,
    format: outputMetadata.format,
    width: outputMetadata.width,
    height: outputMetadata.height,
    bytesPerRow: outputMetadata.bytesPerRow,
    footprint: outputMetadata.footprint,
  };
  if (
    receipt.presentation !== 'ready' ||
    frameTrace.receipt?.completion !== 'completed' ||
    outputMetadata.frameId !== receipt.frameId ||
    outputMetadata.deviceGeneration !== receipt.deviceGeneration ||
    outputMetadata.graphGeneration !== receipt.graphGeneration ||
    outputMetadata.backendId !== inspection.capabilities.backendKind
  ) {
    throw new Error(
      `final-display capture metadata does not match its ready completed receipt: ${JSON.stringify(captureMetadata)}`,
    );
  }
  const graphTargets = (['standard-scene-surface-normal', 'ssao-raw', 'ssao-blurred'] as const).map(
    (name) => {
      const target = debugHost.getCurrentGraphTarget(name);
      if (target === undefined) throw new Error(`Direct AO frame is missing ${name}`);
      expect(target.graphGeneration).toBe(receipt.graphGeneration);
      expect(target.recordFrameNumber).toBe(frameTrace.recordFrameNumber);
      return target;
    },
  );
  const targets = graphTargets.map(diagnosticTarget);
  return {
    receiptFrameId: receipt.frameId,
    recordFrameNumber: frameTrace.recordFrameNumber,
    frameTraceReceiptFrameId: frameTrace.receipt?.publicReceiptFrameId ?? null,
    receiptPresentation: receipt.presentation,
    receiptCompletion: frameTrace.receipt?.completion ?? null,
    captureMetadata,
    graphGeneration: receipt.graphGeneration,
    deviceGeneration: receipt.deviceGeneration,
    backendKind: inspection.capabilities.backendKind,
    passNames: [...inspection.output.graphPassNames],
    perFramePassNames: [...inspection.perFramePassNames],
    directLightingStrength:
      inspection.standardLighting?.ambientOcclusion?.numerical.directLightingStrength,
    targets,
    stableTargets: graphTargets.map((target) =>
      stableForwardGtaoGraphTargetProjection({
        name: target.name,
        recordFrameNumber: target.recordFrameNumber,
        graphGeneration: target.graphGeneration,
        textureIdentity: target.textureIdentity,
        descriptor: graphTargetDescriptorProjection(target),
      }),
    ),
  };
}

function directStrengthGraphIdentity(snapshot: ReturnType<typeof directStrengthGraphSnapshot>) {
  const {
    receiptFrameId: _receiptFrameId,
    recordFrameNumber: _recordFrameNumber,
    frameTraceReceiptFrameId: _frameTraceReceiptFrameId,
    receiptPresentation: _receiptPresentation,
    receiptCompletion: _receiptCompletion,
    captureMetadata: _captureMetadata,
    directLightingStrength: _directLightingStrength,
    targets: _frameTargetDiagnostics,
    ...identity
  } = snapshot;
  return identity;
}

function capturedTargetDescriptorProjection(
  capture: Awaited<ReturnType<typeof captureForwardGtaoTarget>>,
) {
  return {
    format: capture.format,
    size: { width: capture.width, height: capture.height },
    usage: capture.usage,
    sample: capture.sample,
  };
}

function assertSceneDataSettlement(args: {
  readonly receipt: FrameReceipt | undefined;
  readonly plan: SceneDataSurfacePlan | undefined;
  readonly target: SceneDataSurfaceTarget | undefined;
  readonly trace: SceneDataFrameTrace | undefined;
  readonly graphPassNames: readonly string[];
  readonly perFramePassNames: readonly string[];
  readonly errors: readonly unknown[];
}) {
  if (
    args.receipt === undefined ||
    args.plan === undefined ||
    args.target === undefined ||
    args.trace === undefined ||
    args.plan.normalOwner === undefined ||
    args.plan.depthOwner === undefined
  ) {
    throw new Error(
      `completed SceneData settlement is missing its plan, target, or trace: ${JSON.stringify({
        receiptFrameId: args.receipt?.frameId,
        plan: args.plan,
        target:
          args.target === undefined ? undefined : graphTargetDescriptorProjection(args.target),
        trace: args.trace,
      })}`,
    );
  }
  expect(args.receipt.presentation).toBe('ready');
  expect(args.trace.recordStatus).toBe('submitted');
  expect(args.trace.observationFrameId).toBe(args.receipt.frameId);
  expect(args.trace.receipt).toMatchObject({
    publicReceiptFrameId: args.receipt.frameId,
    deviceGeneration: args.receipt.deviceGeneration,
    presentation: 'ready',
    completion: 'completed',
  });
  expect(args.plan.normal.schema).toBe('forgeax::scene-data::standard-surface-normal-v1');
  expect(args.plan.depth.schema).toBe('forgeax::scene-data::standard-surface-depth-v1');
  expect(args.plan.normalOwner).toMatchObject({
    featureIdentity: expect.any(String),
    viewIdentity: args.plan.viewIdentity,
    planIdentity: expect.any(String),
    generation: expect.any(Number),
    deviceGeneration: args.receipt.deviceGeneration,
    surfaceAdmissionIdentity: expect.any(String),
    surfaceAdmissionRevision: expect.any(Number),
  });
  expect(args.plan.depthOwner).toMatchObject({
    featureIdentity: args.plan.normalOwner.featureIdentity,
    viewIdentity: args.plan.normalOwner.viewIdentity,
    planIdentity: args.plan.normalOwner.planIdentity,
    generation: args.plan.normalOwner.generation,
    deviceGeneration: args.plan.normalOwner.deviceGeneration,
    surfaceAdmissionIdentity: args.plan.normalOwner.surfaceAdmissionIdentity,
    surfaceAdmissionRevision: args.plan.normalOwner.surfaceAdmissionRevision,
  });
  expect(args.target.recordFrameNumber).toBe(args.trace.recordFrameNumber);
  expect(args.target.graphGeneration).toBe(args.trace.graphGeneration);
  expect(args.graphPassNames).toEqual(
    expect.arrayContaining(['standard-scene-surface-data', 'ssao-calc', 'ssao-blur']),
  );
  expect(args.perFramePassNames).toContain('surface-normal-depth-consumer');
  expect(args.errors).toEqual([]);
  return Object.freeze({
    publicReceiptFrameId: args.receipt.frameId,
    deviceGeneration: args.receipt.deviceGeneration,
    featureFrameNumber: args.plan.frameNumber,
    recordFrameNumber: args.trace.recordFrameNumber,
    graphGeneration: args.target.graphGeneration,
    textureIdentity: args.target.textureIdentity,
    owner: Object.freeze({ ...args.plan.normalOwner }),
    descriptor: graphTargetDescriptorProjection(args.target),
  });
}

function expectClusterWorkPhase(
  rows: readonly {
    readonly phase: string;
    readonly receiptPresentation: 'ready' | 'pending';
    readonly observation: ClusterWorkObservation;
    readonly frameTrace: NonNullable<
      ReturnType<DebugDrawHost['clusterWorkFrameTraceForConformance']>
    >;
  }[],
  phase: string,
  expected: Partial<CapturedClusterWork>,
): void {
  const phaseRows = rows.filter((row) => row.phase === phase);
  expect(phaseRows.length).toBeGreaterThan(0);
  const capturedRows = phaseRows.filter(
    (row): row is typeof row & { readonly observation: CapturedClusterWork } =>
      row.observation.status === 'captured',
  );
  expect(capturedRows.some((row) => row.receiptPresentation === 'ready')).toBe(true);
  for (const row of capturedRows) {
    expect(row.observation).toMatchObject({ status: 'captured', ...expected });
  }
  for (const row of phaseRows.filter((candidate) => candidate.receiptPresentation === 'pending')) {
    expect(row.frameTrace.receipt?.presentation).toBe('pending');
    expect(['pending', 'submitted']).toContain(row.frameTrace.recordStatus);
  }
}

function packedNormalWordsLow24(bytes: Uint8Array): readonly number[] {
  if (bytes.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`packed normal bytes are not u32 aligned: ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += Uint32Array.BYTES_PER_ELEMENT) {
    words.push(view.getUint32(offset, true) & 0x00ff_ffff);
  }
  return words;
}

function compareSceneDataConsumerOutput(
  field: ReturnType<typeof createForwardGtaoReferenceField>,
  normalTargetBytes: Uint8Array,
  consumerBytes: Uint8Array,
) {
  const pixels = field.width * field.height;
  if (normalTargetBytes.byteLength !== pixels * 4 || consumerBytes.byteLength !== pixels * 8) {
    throw new Error(
      `SceneData consumer readback size mismatch: normal=${normalTargetBytes.byteLength}, consumer=${consumerBytes.byteLength}, pixels=${pixels}`,
    );
  }
  const target = new DataView(
    normalTargetBytes.buffer,
    normalTargetBytes.byteOffset,
    normalTargetBytes.byteLength,
  );
  const consumer = new DataView(
    consumerBytes.buffer,
    consumerBytes.byteOffset,
    consumerBytes.byteLength,
  );
  let normalMismatchCount = 0;
  let depthCount = 0;
  let maximumAbsolute = 0;
  let squareSum = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const normalWord = consumer.getUint32(pixel * 8, true);
    if (normalWord !== target.getUint32(pixel * 4, true)) normalMismatchCount += 1;
    const position = field.positions[pixel];
    if (position === undefined) continue;
    const actualDepth = consumer.getFloat32(pixel * 8 + 4, true);
    const expectedDepth = reverseZDeviceDepth(field.projection, position);
    const absolute = Math.abs(actualDepth - expectedDepth);
    maximumAbsolute = Math.max(maximumAbsolute, absolute);
    squareSum += absolute * absolute;
    depthCount += 1;
  }
  return {
    normalMismatchCount,
    depth: {
      count: depthCount,
      maximumAbsolute,
      rmsAbsolute: Math.sqrt(squareSum / Math.max(depthCount, 1)),
    },
  };
}

async function assertCandidatePreparationFailure(args: {
  readonly acceptedReceipt:
    | { readonly frameId: number; readonly graphGeneration?: number }
    | undefined;
  readonly previousAo: GtaoInspection | undefined;
  readonly requestedExtent: { readonly width: number; readonly height: number };
  readonly errors: unknown[];
  readonly performFaultDraw: () => Promise<{
    readonly receipt: FrameReceipt;
    readonly snapshots: readonly CandidatePreparationFaultSnapshot[];
  }>;
}): Promise<{
  readonly candidateGeneration: number;
  readonly previousAo: GtaoInspection;
  readonly receipt: FrameReceipt;
  readonly verifiedFailure: VerifiedForwardGtaoCandidateFault;
}> {
  if (args.acceptedReceipt?.graphGeneration === undefined) {
    throw new Error(
      'a completed accepted GTAO receipt is required before candidate fault injection',
    );
  }
  if (args.previousAo === undefined) {
    throw new Error('accepted GTAO inspection is missing before candidate fault injection');
  }
  const fault = await args.performFaultDraw();
  const verifiedFailure = verifyForwardGtaoCandidateFault({
    errors: args.errors,
    snapshots: fault.snapshots,
  });
  const snapshot = verifiedFailure.snapshot as CandidatePreparationFaultSnapshot;
  if (snapshot === undefined)
    throw new Error('post-allocation AO candidate failure snapshot is missing');
  const error = verifiedFailure.evidence as {
    readonly code?: unknown;
    readonly detail?: {
      readonly cause?: {
        readonly code?: unknown;
        readonly detail?: {
          readonly candidateGeneration?: unknown;
          readonly passNames?: unknown;
        };
      };
    };
  };
  expect(error).toMatchObject({
    code: 'graph-build-failed',
    detail: {
      cause: {
        code: 'gtao-candidate-preparation-fault-injected',
        detail: {
          phase: 'post-allocation-before-promotion',
          candidateGeneration: verifiedFailure.candidateGeneration,
          deviceGeneration: snapshot.inspection.frame.deviceGeneration,
        },
      },
    },
  });
  const candidateGeneration = verifiedFailure.candidateGeneration;
  if (fault.receipt.graphGeneration === undefined) {
    throw new Error('candidate failure receipt omitted its graph generation');
  }
  expect(error.detail?.cause?.detail?.passNames).toEqual(
    expect.arrayContaining(['gtao-calc-compute', 'ssao-blur']),
  );
  const candidateAllocation = snapshot.inspection.renderGraphGenerationAllocation;
  const candidateAllocationEntry = candidateAllocation?.entries.find(
    (entry) => entry.generation === candidateGeneration,
  );
  expect(candidateAllocationEntry).toBeDefined();
  expect(candidateAllocationEntry?.allocation.liveBytes).toBeGreaterThan(0);
  expect(snapshot.inspection.standardLighting?.ambientOcclusion?.graphGeneration).toBe(
    args.previousAo.graphGeneration,
  );
  expect(snapshot.inspection.standardLighting?.ambientOcclusion?.output.extent).toEqual(
    args.previousAo.output.extent,
  );
  expect(snapshot.inspection.standardLighting?.ambientOcclusion?.output.extent).not.toEqual(
    args.requestedExtent,
  );
  expect(fault.receipt.frameId).not.toBe(args.acceptedReceipt.frameId);
  expect(fault.receipt.graphGeneration).toBe(args.acceptedReceipt.graphGeneration);
  expect(fault.receipt.graphGeneration).not.toBe(candidateGeneration);
  return {
    candidateGeneration,
    previousAo: args.previousAo,
    receipt: fault.receipt,
    verifiedFailure,
  };
}

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

const describeFailure = describeForwardGtaoFailure;

function requireWebGpuCanvasContext(canvas: HTMLCanvasElement): void {
  if (canvas.getContext('webgpu') === null) {
    throw new Error('WebGPU Forward GTAO canvas context is unavailable');
  }
}

function failureRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requirePresent<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

type MorphCoverageRejectionEvidence = Readonly<{
  readonly weights: 1;
  readonly missingContributorId: string;
  readonly sourceTuple: readonly [number, number, number, number];
  readonly error: unknown;
  readonly rendererEvent: unknown;
}>;

async function captureRejectedRendererDraw(
  draw: () => Promise<FrameReceipt>,
  phase: string,
): Promise<unknown> {
  try {
    await draw();
  } catch (error) {
    return error;
  }
  throw new Error(`${phase} unexpectedly produced a receipt`);
}

function assertMorphSceneDataRejection(
  error: unknown,
  expected: {
    readonly weights: 1;
    readonly entityKey: number;
    readonly materialHandle: number;
  },
): Omit<MorphCoverageRejectionEvidence, 'rendererEvent'> {
  const wrapper = failureRecord(error);
  const wrapperDetail = failureRecord(wrapper?.detail);
  const cause = failureRecord(wrapperDetail?.cause);
  const detail = failureRecord(cause?.detail);
  expect(wrapper).toMatchObject({
    name: 'RendererOperationError',
    code: 'device-operation-failed',
    detail: {
      operation: 'renderer-event',
      cause: {
        code: 'scene-data-unavailable',
        detail: {
          schema: 'forgeax::scene-data::standard-surface-normal-v1',
          reason: 'coverage-incomplete',
          recovery: 'next-frame',
        },
      },
    },
  });
  const ids = detail?.missingContributorIds;
  if (
    !Array.isArray(ids) ||
    ids.length !== 3 ||
    typeof ids[0] !== 'string' ||
    !ids.every((id) => typeof id === 'string')
  ) {
    throw new Error(
      `Custom Morph rejection has no three published contributor ids: ${JSON.stringify(detail)}`,
    );
  }
  const contributors = detail?.missingContributors;
  if (!Array.isArray(contributors) || contributors.length !== 3) {
    throw new Error(
      `Custom Morph rejection has no three published contributor details: ${JSON.stringify(detail)}`,
    );
  }
  const missingContributorId = ids[0];
  const sourceTuple = JSON.parse(missingContributorId) as unknown;
  if (!Array.isArray(sourceTuple) || sourceTuple.length !== 4) {
    throw new Error(
      `Morph contributor id is not a four-part source tuple: ${missingContributorId}`,
    );
  }
  expect(sourceTuple).toEqual([0, expected.entityKey, expected.materialHandle, expect.any(Number)]);
  expect(missingContributorId).toBe(JSON.stringify(sourceTuple));
  expect(new Set(ids).size).toBe(3);
  expect(contributors.map((row) => failureRecord(row)?.selectedPass).sort()).toEqual([
    'Center',
    'Center',
    'Left',
  ]);
  for (const contributor of contributors) {
    const row = failureRecord(contributor);
    expect(row?.id).toBe(JSON.stringify(row?.sourceTuple));
    expect(ids).toContain(row?.id);
    expect(row?.sourceTuple).toEqual([
      0,
      expected.entityKey,
      expected.materialHandle,
      expect.any(Number),
    ]);
    expect(row).toMatchObject({
      reason: 'authored-program-not-standard-pbr',
      deformation: 'morph',
      morphWeightsPresent: true,
      skinBindingPresent: false,
      expectedFragmentEntry: 'fs_ao_input',
    });
  }
  return {
    weights: expected.weights,
    missingContributorId,
    sourceTuple: sourceTuple as [number, number, number, number],
    error: describeFailure(error),
  };
}

async function captureMorphCoverageRejection(args: {
  readonly draw: () => Promise<FrameReceipt>;
  readonly errors: unknown[];
  readonly weights: 1;
  readonly entityKey: number;
  readonly materialHandle: number;
}): Promise<MorphCoverageRejectionEvidence> {
  const errorCount = args.errors.length;
  const error = await captureRejectedRendererDraw(args.draw, `MorphWeights=${args.weights}`);
  const rendererErrors = args.errors.splice(errorCount);
  expect(rendererErrors).toHaveLength(1);
  const evidence = assertMorphSceneDataRejection(error, args);
  const eventEvidence = assertMorphSceneDataRejection(rendererErrors[0], args);
  expect(eventEvidence.sourceTuple).toEqual(evidence.sourceTuple);
  return { ...evidence, rendererEvent: describeFailure(rendererErrors[0]) };
}

function expectMorphFailurePreservesAcceptedFrame(args: {
  readonly acceptedFrameId: number;
  readonly currentFrameId: number;
  readonly acceptedReceipt: unknown;
  readonly failureReceipt: unknown;
  readonly acceptedTrace: SceneDataFrameTrace;
  readonly failureFrameTrace: unknown;
  readonly acceptedReadback: unknown;
  readonly failureReadback: unknown;
}): void {
  expect(args.currentFrameId).toBe(args.acceptedFrameId);
  expect(args.failureReceipt).toEqual({
    status: 'not-produced',
    operation: 'renderer.draw',
    lastSuccessfulReceipt: args.acceptedReceipt,
  });
  expect(args.failureFrameTrace).toEqual({
    status: 'not-produced',
    operation: 'renderer.draw',
    lastCompletedBeforeFailure: args.acceptedTrace,
  });
  expect(args.failureReadback).toEqual({
    status: 'not-produced',
    operation: 'renderer.draw',
    lastSuccessfulCapture: args.acceptedReadback,
  });
}

function registryLookupKeysFromErrors(errors: readonly unknown[]): readonly string[] {
  const keys = new Set<string>();
  for (const error of errors) {
    const detail = failureRecord(failureRecord(error)?.detail);
    const causeDetail = failureRecord(failureRecord(detail?.cause)?.detail);
    const contributors = causeDetail?.missingContributors;
    if (!Array.isArray(contributors)) continue;
    for (const contributorValue of contributors) {
      const candidates = failureRecord(contributorValue)?.programCandidates;
      if (!Array.isArray(candidates)) continue;
      for (const candidateValue of candidates) {
        const key = failureRecord(candidateValue)?.registryLookupKey;
        if (typeof key === 'string') keys.add(key);
      }
    }
  }
  return Object.freeze([...keys].sort());
}

async function registryArtifactsForErrors(
  registry: Parameters<typeof resolveForwardGtaoMaterialLineage>[0],
  errors: readonly unknown[],
): Promise<readonly unknown[]> {
  const artifacts = [];
  for (const key of registryLookupKeysFromErrors(errors)) {
    try {
      const result = registry.findMaterialArtifact(key);
      if (!result.ok) {
        artifacts.push({ key, status: 'missing', error: describeFailure(result.error) });
        continue;
      }
      const artifact = result.value;
      const sourceBytes = new TextEncoder().encode(artifact.source);
      artifacts.push({
        key,
        status: 'ready',
        sourceByteLength: sourceBytes.byteLength,
        sourceSha256: await sha256Hex(sourceBytes),
        programIdentity: artifact.program.identity,
        programEntryPoints: artifact.program.entryPoints ?? [],
        receipt:
          artifact.receipt === undefined
            ? undefined
            : {
                directEntry: artifact.receipt.directEntry,
                entryPoints: artifact.receipt.entryPoints ?? [],
                receiptIdentity: artifact.receipt.receiptIdentity,
                generation: artifact.receipt.generation,
              },
      });
    } catch (error) {
      artifacts.push({ key, status: 'inspection-failed', error: describeFailure(error) });
    }
  }
  return Object.freeze(artifacts);
}

function maxDisplayDelta(
  left: Uint8Array,
  right: Uint8Array,
  bytesPerRow: number,
  width: number,
  height: number,
) {
  let maximum = 0;
  let changed = 0;
  for (let y = 4; y < height - 4; y += 1) {
    for (let x = 4; x < width - 4; x += 1) {
      let pixelDelta = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        pixelDelta = Math.max(
          pixelDelta,
          Math.abs(
            (left[y * bytesPerRow + x * 4 + channel] ?? 0) -
              (right[y * bytesPerRow + x * 4 + channel] ?? 0),
          ),
        );
      }
      maximum = Math.max(maximum, pixelDelta);
      if (pixelDelta > 2) changed += 1;
    }
  }
  return { maximum, changed };
}

function findContactReferencePixel(
  referenceField: ReturnType<typeof createForwardGtaoReferenceField>,
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
  outputHeight: number,
  filteredReference: Uint8Array,
): number {
  return referenceField.positions.findIndex((position, index) => {
    if (position === undefined || Math.abs(position[2] + 4) > 0.02) return false;
    const x = index % inputWidth;
    const y = Math.floor(index / inputWidth);
    const aoX = Math.min(outputWidth - 1, Math.floor(((x + 0.5) / inputWidth) * outputWidth));
    const aoY = Math.min(outputHeight - 1, Math.floor(((y + 0.5) / inputHeight) * outputHeight));
    return (filteredReference[aoY * outputWidth + aoX] ?? 255) < 200;
  });
}

function requireContactReferencePixel(
  referenceField: ReturnType<typeof createForwardGtaoReferenceField>,
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
  outputHeight: number,
  filteredReference: Uint8Array,
): number {
  const index = findContactReferencePixel(
    referenceField,
    inputWidth,
    inputHeight,
    outputWidth,
    outputHeight,
    filteredReference,
  );
  if (index < 0) throw new Error('CPU GTAO oracle found no occluded receiver pixel');
  return index;
}

function requireGtaoInspection(
  inspection: GtaoInspection | undefined,
  stage: string,
): GtaoInspection {
  if (inspection === undefined) throw new Error(`${stage} GTAO inspection is missing`);
  return inspection;
}

async function fetchGtaoManifestBytes(): Promise<Uint8Array> {
  const response = await fetch('/shaders/manifest.json');
  if (!response.ok) {
    throw new Error(`engine shader manifest fetch failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function captureLinearWithReadyRetry(input: {
  readonly renderer: RendererHostAssembly['renderer'];
  readonly debugHost: DebugDrawHost;
  readonly draw: () => Promise<FrameReceipt>;
  readonly setFailureOperation: (operation: string) => void;
  readonly setFailureReceipt: (receipt: unknown) => void;
  readonly setFailureFrameTrace: (trace: unknown) => void;
  readonly setFailureReadback: (readback: unknown) => void;
}): Promise<ForwardGtaoLinearCapture> {
  input.setFailureOperation('capture-linear-hdr');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const capture = await captureForwardGtaoLinearHdr(input.renderer, input.draw);
      input.setFailureReceipt({
        frameId: capture.frameId,
        deviceGeneration: capture.deviceGeneration,
        graphGeneration: capture.graphGeneration,
        readbackIdentity: capture.readbackIdentity,
      });
      input.setFailureFrameTrace(input.debugHost.clusterWorkFrameTraceForConformance());
      input.setFailureReadback({
        target: 'linear-hdr',
        format: capture.format,
        width: capture.width,
        height: capture.height,
        byteLength: capture.bytes.byteLength,
        sha256: await sha256Hex(capture.bytes),
      });
      return capture;
    } catch (error) {
      if (!(error instanceof ForwardGtaoLinearCaptureNotReadyError)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('linear HDR capture did not produce a ready receipt');
}

type RhiCaptureResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

type RhiCapturePort = {
  captureFrame(): Promise<RhiCaptureResult<EncodedTape>>;
  frameBoundary(): Promise<RhiCaptureResult<unknown>>;
};

async function captureRecordedReceiptFrame(input: {
  readonly recorder: RhiCapturePort;
  readonly draw: () => Promise<FrameReceipt>;
  readonly frameTrace: () => ReturnType<DebugDrawHost['clusterWorkFrameTraceForConformance']>;
}) {
  const capturePending = input.recorder.captureFrame();
  value(await input.recorder.frameBoundary());
  let receipt: FrameReceipt | undefined;
  let drawFailed = false;
  let drawError: unknown;
  try {
    receipt = await input.draw();
  } catch (error) {
    drawFailed = true;
    drawError = error;
  } finally {
    value(await input.recorder.frameBoundary());
  }
  const tape = value(await capturePending);
  if (drawFailed) throw drawError;
  if (receipt === undefined) throw new Error('recorded renderer draw did not return a receipt');
  return Object.freeze({ tape, receipt, frameTrace: input.frameTrace() });
}

type ForwardGtaoTargetCapture = Awaited<ReturnType<typeof captureForwardGtaoTarget>>;
type ForwardGtaoFinalLightingRhiCapture = {
  readonly tape: EncodedTape;
  readonly receipt: FrameReceipt;
  readonly frameTrace: ReturnType<DebugDrawHost['clusterWorkFrameTraceForConformance']>;
};

function analyzeForwardGtaoFinalLightingContact(input: {
  readonly filteredReference: Uint8Array;
  readonly raw: ForwardGtaoTargetCapture;
  readonly actualFiltered: ForwardGtaoTargetCapture;
  readonly fullWidth: number;
  readonly fullHeight: number;
  readonly contactIndex: number;
  readonly emissive: readonly [number, number, number];
  readonly indirect: readonly [number, number, number];
  readonly direct: readonly [number, number, number];
  readonly actual: readonly [number, number, number];
}) {
  const contactX = input.contactIndex % input.fullWidth;
  const contactY = Math.floor(input.contactIndex / input.fullWidth);
  const uv = {
    u: (contactX + 0.5) / input.fullWidth,
    v: (contactY + 0.5) / input.fullHeight,
  };
  const nearestX = Math.min(input.raw.width - 1, Math.floor(uv.u * input.raw.width));
  const nearestY = Math.min(input.raw.height - 1, Math.floor(uv.v * input.raw.height));
  const nearestVisibility =
    (input.filteredReference[nearestY * input.raw.width + nearestX] ?? 255) / 255;
  const bilinear = sampleGtaoBilinearLinearClamp(
    input.filteredReference,
    input.raw.width,
    input.raw.height,
    uv.u,
    uv.v,
  );
  const visibility = bilinear.value / 255;
  const compose = (screenVisibility: number) =>
    composeLinearLightingReference({
      indirect: input.indirect,
      direct: input.direct,
      emissive: input.emissive,
      screenVisibility,
      materialOcclusion: 1,
      directLightingStrength: 0,
    });
  const expectedNearest = compose(nearestVisibility);
  const expectedBilinear = compose(visibility);
  const errors = linearErrorMetrics(
    Float32Array.from(input.actual),
    Float32Array.from(expectedBilinear),
  );
  const channelErrors = input.actual.map((actual, channel) => {
    const expected = expectedBilinear[channel] ?? 0;
    return {
      channel,
      actual,
      expected,
      error: actual - expected,
      absoluteError: Math.abs(actual - expected),
    };
  });
  const texels = [
    input.filteredReference[bilinear.y0 * input.raw.width + bilinear.x0] ?? 255,
    input.filteredReference[bilinear.y0 * input.raw.width + bilinear.x1] ?? 255,
    input.filteredReference[bilinear.y1 * input.raw.width + bilinear.x0] ?? 255,
    input.filteredReference[bilinear.y1 * input.raw.width + bilinear.x1] ?? 255,
  ];
  return {
    pixel: { x: contactX, y: contactY, index: input.contactIndex },
    uv,
    nearest: {
      texel: { x: nearestX, y: nearestY },
      visibility: nearestVisibility,
      expectedRgb: expectedNearest,
    },
    bilinear: {
      coordinates: {
        x0: bilinear.x0,
        x1: bilinear.x1,
        y0: bilinear.y0,
        y1: bilinear.y1,
        tx: bilinear.tx,
        ty: bilinear.ty,
      },
      referenceTexels: texels,
      actualFilteredTexels: [
        input.actualFiltered.bytes[bilinear.y0 * input.actualFiltered.width + bilinear.x0] ?? 0,
        input.actualFiltered.bytes[bilinear.y0 * input.actualFiltered.width + bilinear.x1] ?? 0,
        input.actualFiltered.bytes[bilinear.y1 * input.actualFiltered.width + bilinear.x0] ?? 0,
        input.actualFiltered.bytes[bilinear.y1 * input.actualFiltered.width + bilinear.x1] ?? 0,
      ],
      weights: bilinear.weights,
      visibilityByte: bilinear.value,
      visibility,
      expectedRgb: expectedBilinear,
    },
    expectedBilinear,
    actualRgb: input.actual,
    channelErrors,
    errors,
    lightingComponents: {
      emissive: input.emissive,
      indirect: input.indirect,
      direct: input.direct,
    },
  };
}

async function forwardGtaoCaptureEvidence(capture: ForwardGtaoTargetCapture) {
  return {
    name: capture.name,
    format: capture.format,
    width: capture.width,
    height: capture.height,
    bytesPerTexel: capture.bytesPerTexel,
    bytesPerRow: capture.width * capture.bytesPerTexel,
    byteLength: capture.bytes.byteLength,
    sha256: await sha256Hex(capture.bytes),
    rgbaBase64: base64Bytes(capture.bytes),
    publicReceiptFrameId: capture.publicReceiptFrameId,
    targetRecordFrameNumber: capture.targetRecordFrameNumber,
    graphGeneration: capture.graphGeneration,
    deviceGeneration: capture.deviceGeneration,
    textureIdentity: capture.textureIdentity,
    preparation: capture.preparation,
  };
}

async function writeForwardGtaoFinalLightingEvidence(input: {
  readonly path: string;
  readonly tapePath: string;
  readonly fixture: typeof FORWARD_GTAO_FIXTURE;
  readonly manifestIdentity: unknown;
  readonly inputIdentity: string;
  readonly contact: ReturnType<typeof analyzeForwardGtaoFinalLightingContact>;
  readonly fullExtent: { readonly width: number; readonly height: number };
  readonly aoExtent: { readonly width: number; readonly height: number };
  readonly tape: ForwardGtaoFinalLightingRhiCapture;
  readonly tapeModel: ReturnType<typeof buildFrameModel>;
  readonly tapeSummary: ReturnType<typeof summarizeFrame>;
  readonly shaderSource: string | undefined;
  readonly registry: Parameters<typeof resolveForwardGtaoMaterialLineage>[0];
  readonly selectedMaterial: Parameters<typeof resolveForwardGtaoMaterialLineage>[1];
  readonly captures: {
    readonly normal: ForwardGtaoTargetCapture;
    readonly raw: ForwardGtaoTargetCapture;
    readonly filtered: ForwardGtaoTargetCapture;
    readonly linearHdr: ForwardGtaoLinearCapture;
  };
  readonly normalTexture: {
    readonly format: string;
    readonly shape: unknown;
    readonly data: Uint8Array;
  };
}): Promise<void> {
  let publication: unknown = { status: 'not-resolved' };
  if (input.shaderSource !== undefined) {
    try {
      publication = {
        status: 'resolved',
        capturedSourceSha256: await sha256Hex(new TextEncoder().encode(input.shaderSource)),
        lineage: resolveForwardGtaoMaterialLineage(
          input.registry,
          input.selectedMaterial,
          input.shaderSource,
        ),
      };
    } catch (error) {
      publication = { status: 'resolution-failed', error: describeFailure(error) };
    }
  }
  const resources = input.tapeModel.resources
    .filter((resource) =>
      /linear|hdr|ao|normal|surface|depth/i.test(frameResourceLabel(resource) ?? ''),
    )
    .map((resource) => ({
      resourceId: resource.resourceId,
      kind: resource.kind,
      label: frameResourceLabel(resource) ?? null,
      descriptor: resource.descriptor,
    }));
  const budgetSha256 = await sha256Hex(
    new TextEncoder().encode(JSON.stringify(GTAO_COMPARISON_BUDGET)),
  );
  const [normal, raw, filtered] = await Promise.all([
    forwardGtaoCaptureEvidence(input.captures.normal),
    forwardGtaoCaptureEvidence(input.captures.raw),
    forwardGtaoCaptureEvidence(input.captures.filtered),
  ]);
  const linearHdr = input.captures.linearHdr;
  await commands.writeFile(
    input.path,
    JSON.stringify(
      {
        schema: 'forgeax::forward-gtao-final-lighting-bilinear-evidence::1',
        fixture: input.fixture,
        manifestIdentity: input.manifestIdentity,
        inputIdentity: input.inputIdentity,
        contact: {
          ...input.contact,
          fullExtent: input.fullExtent,
          aoExtent: input.aoExtent,
          actualLinearHdrRgb: input.contact.actualRgb,
          aoControls: { materialOcclusion: 1, directLightingStrength: 0 },
        },
        frozenBudget: {
          identity: 'GTAO_COMPARISON_BUDGET',
          value: GTAO_COMPARISON_BUDGET,
          sha256: budgetSha256,
        },
        captures: {
          normal,
          raw,
          filtered,
          linearHdr: {
            frameId: linearHdr.frameId,
            deviceGeneration: linearHdr.deviceGeneration,
            graphGeneration: linearHdr.graphGeneration,
            textureIdentity: linearHdr.textureIdentity,
            readbackIdentity: linearHdr.readbackIdentity,
            format: linearHdr.format,
            width: linearHdr.width,
            height: linearHdr.height,
            bytesPerRow: linearHdr.bytesPerRow,
            byteLength: linearHdr.bytes.byteLength,
            sha256: await sha256Hex(linearHdr.bytes),
            rgbaBase64: base64Bytes(linearHdr.bytes),
            timings: linearHdr.gpuTimings,
            draws: linearHdr.draws,
          },
        },
        rhiFrame: {
          path: input.tapePath,
          digest: input.tape.tape.digest,
          byteLength: input.tape.tape.byteLength,
          receipt: {
            frameId: input.tape.receipt.frameId,
            presentation: input.tape.receipt.presentation,
            deviceGeneration: input.tape.receipt.deviceGeneration,
            graphGeneration: input.tape.receipt.graphGeneration ?? null,
          },
          recordFrameNumber: input.tape.frameTrace?.recordFrameNumber ?? null,
          frameTrace: input.tape.frameTrace,
          matchesLinearHdrReceipt: input.tape.receipt.frameId === linearHdr.frameId,
          summary: input.tapeSummary,
          resources: { rows: resources.slice(0, 64), omitted: Math.max(0, resources.length - 64) },
          shaderSourceSha256:
            input.shaderSource === undefined
              ? null
              : await sha256Hex(new TextEncoder().encode(input.shaderSource)),
          publication,
        },
        normalTexture: {
          format: input.normalTexture.format,
          shape: input.normalTexture.shape,
          sha256: await sha256Hex(input.normalTexture.data),
        },
      },
      null,
      2,
    ),
  );
}

type ForwardGtaoSceneConsumer = ReturnType<typeof createForwardGtaoSceneDataConsumer>;
type ForwardGtaoObservedFrame = NonNullable<
  Extract<
    Awaited<ReturnType<RendererHostAssembly['renderer']['observe']>>,
    { readonly ok: true }
  >['value']['observations']
>[number];
type ForwardGtaoSceneConsumerReceipt = {
  readonly publicReceiptFrameId: number;
  readonly recordFrameNumber: number;
  readonly plan: NonNullable<ReturnType<ForwardGtaoSceneConsumer['latestPlan']>>;
};
type ForwardGtaoSceneDataTargetName = 'ssao-raw' | 'ssao-blurred' | 'standard-scene-surface-normal';

async function captureSceneDataConsumerSettlement(input: {
  readonly renderer: RendererHostAssembly['renderer'];
  readonly debugHost: DebugDrawHost;
  readonly capture: () => Promise<ForwardGtaoObservedFrame>;
  readonly captureTarget: (
    name: ForwardGtaoSceneDataTargetName,
  ) => Promise<Awaited<ReturnType<typeof captureForwardGtaoTarget>>>;
  readonly captureLinear: () => Promise<Awaited<ReturnType<typeof captureForwardGtaoLinearHdr>>>;
  readonly surfaceDataConsumer: ForwardGtaoSceneConsumer;
  readonly surfaceObservationBuffer: Parameters<
    ForwardGtaoSceneConsumer['setObservationBuffer']
  >[0];
  readonly surfaceConsumerReceipts: ForwardGtaoSceneConsumerReceipt[];
  readonly featureGraphDiagnosticRows: FeatureGraphDiagnosticRow[];
  readonly errors: unknown[];
  readonly width: number;
  readonly height: number;
  readonly getLastReadyReceipt: () => FrameReceipt | undefined;
  readonly getSceneDataCopyTape: () => CapturedSceneDataCopyTape | undefined;
  readonly setClusterWorkPhase: (phase: string) => void;
  readonly setSettlementFeatureGraphTrace: (
    trace: ReturnType<DebugDrawHost['featureGraphTraceForConformance']>,
  ) => void;
}) {
  const {
    renderer,
    debugHost,
    capture,
    captureTarget,
    captureLinear,
    surfaceDataConsumer,
    surfaceObservationBuffer,
    surfaceConsumerReceipts,
    featureGraphDiagnosticRows,
    errors,
    width,
    height,
    getLastReadyReceipt,
    getSceneDataCopyTape,
    setClusterWorkPhase,
    setSettlementFeatureGraphTrace,
  } = input;
  debugHost.setGtaoExecutionOverrideForConformance('fragment');
  const fragmentOutput = await capture();
  const fragmentInspection = renderer.inspect().standardLighting?.ambientOcclusion;
  if (fragmentInspection === undefined) throw new Error('fragment GTAO inspection is missing');
  debugHost.setFeatureGraphTraceForConformance(surfaceDataConsumer.feature.identity);
  const activationSnapshot = featureGraphDiagnosticSnapshot({
    renderer,
    debugHost,
    receipt: getLastReadyReceipt(),
    plan: surfaceDataConsumer.latestPlan(),
    submissionSnapshots: surfaceDataConsumer.submittedWorkSnapshots(),
  });
  rememberFeatureGraphDiagnostic(featureGraphDiagnosticRows, {
    phase: 'before-consumer-activation',
    publicReceiptFrameId: getLastReadyReceipt()?.frameId ?? null,
    retainedRecordFrameNumber: activationSnapshot.recordFrameNumber,
    snapshot: activationSnapshot,
  });
  surfaceDataConsumer.setEnabled(true);
  setClusterWorkPhase('scene-data-consumer-settlement');
  const settlementOutput = await capture();
  const settlementReceipt = getLastReadyReceipt();
  const settlementDiagnosticRows = featureGraphDiagnosticRows.filter(
    (row) => row.publicReceiptFrameId === settlementReceipt?.frameId,
  );
  if (
    settlementDiagnosticRows.length !== 2 ||
    settlementDiagnosticRows[0]?.phase !== 'post-completion-pre-observe' ||
    settlementDiagnosticRows[1]?.phase !== 'post-observe'
  ) {
    throw new Error(
      `settlement diagnostic snapshots are incomplete for public receipt ${settlementReceipt?.frameId}: ${JSON.stringify(settlementDiagnosticRows)}`,
    );
  }
  setSettlementFeatureGraphTrace(debugHost.featureGraphTraceForConformance());
  debugHost.setFeatureGraphTraceForConformance(undefined);
  const settlementRows = surfaceConsumerReceipts.filter(
    (row) => row.publicReceiptFrameId === settlementReceipt?.frameId,
  );
  if (settlementRows.length !== 1) {
    throw new Error(
      `expected exactly one SceneData plan for settlement receipt ${settlementReceipt?.frameId}, got ${settlementRows.length}: ${JSON.stringify(settlementRows)}`,
    );
  }
  const settlementPlan = settlementRows[0]?.plan;
  const settlementInspection = renderer.inspect();
  const settlement = assertSceneDataSettlement({
    receipt: settlementReceipt,
    plan: settlementPlan,
    target: debugHost.getCurrentGraphTarget('standard-scene-surface-normal'),
    trace: debugHost.clusterWorkFrameTraceForConformance(),
    graphPassNames: settlementInspection.output.graphPassNames,
    perFramePassNames: settlementInspection.perFramePassNames,
    errors,
  });
  expect(settlementOutput.domain).toBe('final-display');
  const sceneDataReadback = await (async () => {
    const fragmentNormal = await captureTarget('standard-scene-surface-normal');
    const sceneDataCopyTape = getSceneDataCopyTape();
    if (sceneDataCopyTape === undefined) {
      throw new Error('armed SceneData target-copy draw did not produce an RHI tape');
    }
    const sceneDataCopyTapeModel = buildFrameModel(sceneDataCopyTape.tape.tape);
    const sceneDataCopyTapeSummary = summarizeFrame(sceneDataCopyTapeModel);
    const observationBufferResource = sceneDataCopyTapeModel.resources.find(
      (resource) =>
        resource.kind === 'buffer' &&
        frameResourceLabel(resource) === 'forward-gtao.test.surface-data-observation',
    );
    const observationBufferWrites = sceneDataCopyTape.tape.tape.events.flatMap(
      (event, eventIndex) =>
        event.kind === 'writeBuffer' && event.handleId === observationBufferResource?.resourceId
          ? [
              {
                eventIndex,
                bufferOffset: event.bufferOffset,
                size: event.size,
                dataHash: event.dataHash,
              },
            ]
          : [],
    );
    const textureToBufferCopies = sceneDataCopyTape.tape.tape.events.flatMap((event, eventIndex) =>
      event.kind === 'copyTextureToBuffer'
        ? [
            {
              eventIndex,
              textureHandleId: event.source.textureHandleId,
              bufferHandleId: event.destination.bufferHandleId,
              bytesPerRow: event.destination.bytesPerRow ?? null,
              copySize: event.copySize,
            },
          ]
        : [],
    );
    const sceneDataCopyTapePath =
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgpu-scene-data-readback-rhi-diagnostic-20261101-4b7499c.rhitape';
    await commands.writeFile(
      sceneDataCopyTapePath,
      base64Bytes(sceneDataCopyTape.tape.bytes),
      'base64',
    );
    expect(fragmentNormal.preparation.recordFrameNumber).toBeGreaterThan(
      settlement.recordFrameNumber,
    );
    expect(fragmentNormal.preparation.graphGeneration).toBe(settlement.graphGeneration);
    expect(fragmentNormal.preparation.textureIdentity).toBe(settlement.textureIdentity);
    expect(fragmentNormal.preparation.descriptor).toEqual(settlement.descriptor);
    expect(capturedTargetDescriptorProjection(fragmentNormal)).toEqual(settlement.descriptor);
    const surfaceCopyTrace = fragmentNormal.frameTrace.graphTargetCopy;
    if (surfaceCopyTrace === undefined) {
      throw new Error(
        `surface target capture did not encode a copy: ${JSON.stringify(fragmentNormal.frameTrace)}`,
      );
    }
    expect(surfaceCopyTrace.encoded).toBe(true);
    expect(surfaceCopyTrace.expectedIdentity).toEqual(surfaceCopyTrace.actualIdentity);
    expect(surfaceCopyTrace.expectedIdentity).toMatchObject({
      graphGeneration: settlement.graphGeneration,
      textureIdentity: settlement.textureIdentity,
      recordFrameNumber: fragmentNormal.targetRecordFrameNumber,
    });
    expect(fragmentNormal.frameTrace.receipt).toMatchObject({
      publicReceiptFrameId: fragmentNormal.publicReceiptFrameId,
      deviceGeneration: settlement.deviceGeneration,
      presentation: 'ready',
      completion: 'completed',
    });
    expect(fragmentNormal.bytes.byteLength).toBe(
      fragmentNormal.width * fragmentNormal.height * fragmentNormal.bytesPerTexel,
    );
    const surfaceConsumerRows = surfaceConsumerReceipts.filter(
      (row) => row.publicReceiptFrameId === fragmentNormal.publicReceiptFrameId,
    );
    if (surfaceConsumerRows.length !== 1) {
      throw new Error(
        `expected exactly one surface-data consumer plan for completed normal readback receipt ${fragmentNormal.publicReceiptFrameId}, got ${surfaceConsumerRows.length}: ${JSON.stringify(surfaceConsumerRows)}`,
      );
    }
    const surfaceConsumerReceipt = surfaceConsumerRows[0];
    if (surfaceConsumerReceipt === undefined) {
      throw new Error(
        `surface-data receipt row disappeared for ${fragmentNormal.publicReceiptFrameId}`,
      );
    }
    const normalOwner = surfaceConsumerReceipt.plan.normalOwner;
    const depthOwner = surfaceConsumerReceipt.plan.depthOwner;
    const surfaceConsumerBytes = await captureForwardGtaoBuffer(
      debugHost,
      surfaceObservationBuffer,
      surfaceDataConsumer.observationBytes,
    );
    expect(surfaceConsumerReceipt.recordFrameNumber).toBe(fragmentNormal.targetRecordFrameNumber);
    expect(fragmentNormal.frameTrace.recordFrameNumber).toBe(
      surfaceConsumerReceipt.recordFrameNumber,
    );
    expect(surfaceConsumerReceipt.plan.normal.schema).toBe(
      'forgeax::scene-data::standard-surface-normal-v1',
    );
    expect(surfaceConsumerReceipt.plan.depth.schema).toBe(
      'forgeax::scene-data::standard-surface-depth-v1',
    );
    expect(normalOwner).toMatchObject({
      featureIdentity: settlement.owner.featureIdentity,
      viewIdentity: surfaceConsumerReceipt.plan.viewIdentity,
      planIdentity: settlement.owner.planIdentity,
      generation: settlement.owner.generation,
      deviceGeneration: fragmentNormal.deviceGeneration,
      surfaceAdmissionIdentity: settlement.owner.surfaceAdmissionIdentity,
      surfaceAdmissionRevision: settlement.owner.surfaceAdmissionRevision,
    });
    expect(depthOwner).toMatchObject({
      featureIdentity: normalOwner?.featureIdentity,
      viewIdentity: surfaceConsumerReceipt.plan.viewIdentity,
      planIdentity: normalOwner?.planIdentity,
      generation: normalOwner?.generation,
      deviceGeneration: fragmentNormal.deviceGeneration,
      surfaceAdmissionIdentity: normalOwner?.surfaceAdmissionIdentity,
      surfaceAdmissionRevision: normalOwner?.surfaceAdmissionRevision,
    });
    expect(fragmentNormal.graphGeneration).toBe(fragmentNormal.preparation.graphGeneration);
    expect(fragmentNormal.textureIdentity).toBe(fragmentNormal.preparation.textureIdentity);
    const surfaceReadbackInspection = renderer.inspect();
    expect(surfaceReadbackInspection.output.graphPassNames).toEqual(
      expect.arrayContaining(['standard-scene-surface-data', 'ssao-calc']),
    );
    expect(surfaceReadbackInspection.perFramePassNames).toContain('surface-normal-depth-consumer');
    const sceneDataReferenceField = createForwardGtaoReferenceField(width, height);
    const sceneDataConsumerMetrics = compareSceneDataConsumerOutput(
      sceneDataReferenceField,
      fragmentNormal.bytes,
      surfaceConsumerBytes,
    );
    const sceneDataNormalMetrics = materialNormalFieldMetrics(
      sceneDataReferenceField,
      fragmentNormal.bytes,
    );
    const sentinelMetrics = observationSentinelMetrics(
      surfaceConsumerBytes,
      surfaceDataConsumer.observationBytes / Uint32Array.BYTES_PER_ELEMENT,
    );
    const surfaceConsumerEvidencePath =
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgpu-scene-data-consumer-rhi-diagnostic-20261101-4b7499c.json';
    await commands.writeFile(
      surfaceConsumerEvidencePath,
      JSON.stringify(
        {
          schema: 'forgeax::forward-gtao-scene-data-consumer-evidence::1',
          producer: 'standard-scene-surface-data',
          consumer: 'surface-normal-depth-consumer',
          frame: {
            settlement,
            targetCopyTape: {
              path: sceneDataCopyTapePath,
              byteLength: sceneDataCopyTape.tape.byteLength,
              digest: sceneDataCopyTape.tape.digest,
              tapeReceipt: sceneDataCopyTape.receipt,
              tapeRecordFrameNumber: sceneDataCopyTape.recordFrameNumber,
              readbackReceipt: {
                publicReceiptFrameId: fragmentNormal.publicReceiptFrameId,
                targetRecordFrameNumber: fragmentNormal.targetRecordFrameNumber,
              },
              frameTrace: sceneDataCopyTape.frameTrace,
              graphPassNames: sceneDataCopyTape.graphPassNames,
              perFramePassNames: sceneDataCopyTape.perFramePassNames,
              consumerPlanFrameNumber: sceneDataCopyTape.consumerPlanFrameNumber,
              consumerSubmittedWork: sceneDataCopyTape.consumerSubmittedWork,
              observationBufferResourceId: observationBufferResource?.resourceId ?? null,
              observationBufferSentinelWrites: observationBufferWrites,
              textureToBufferCopies,
              summary: sceneDataCopyTapeSummary,
              matchesReadbackReceipt:
                sceneDataCopyTape.receipt.frameId === fragmentNormal.publicReceiptFrameId &&
                sceneDataCopyTape.recordFrameNumber === fragmentNormal.targetRecordFrameNumber,
            },
            recordFrameNumber: surfaceConsumerReceipt.recordFrameNumber,
            publicReceiptFrameId: surfaceConsumerReceipt.publicReceiptFrameId,
            targetRecordFrameNumber: fragmentNormal.targetRecordFrameNumber,
            graphGeneration: fragmentNormal.graphGeneration,
            textureIdentity: fragmentNormal.textureIdentity,
            deviceGeneration: fragmentNormal.deviceGeneration,
            surfaceAdmissionIdentity: normalOwner?.surfaceAdmissionIdentity,
            surfaceAdmissionRevision: normalOwner?.surfaceAdmissionRevision,
          },
          target: {
            name: fragmentNormal.name,
            format: fragmentNormal.format,
            width: fragmentNormal.width,
            height: fragmentNormal.height,
            byteLength: fragmentNormal.bytes.byteLength,
            sha256: await sha256Hex(fragmentNormal.bytes),
            base64: base64Bytes(fragmentNormal.bytes),
          },
          consumerOutput: {
            byteLength: surfaceConsumerBytes.byteLength,
            sha256: await sha256Hex(surfaceConsumerBytes),
            base64: base64Bytes(surfaceConsumerBytes),
            metrics: sceneDataConsumerMetrics,
            normalReferenceMetrics: sceneDataNormalMetrics,
            sentinel: sentinelMetrics,
          },
        },
        null,
        2,
      ),
    );
    expect(sceneDataCopyTape.receipt.frameId).toBe(fragmentNormal.publicReceiptFrameId);
    expect(sceneDataCopyTape.recordFrameNumber).toBe(fragmentNormal.targetRecordFrameNumber);
    expect(sceneDataCopyTape.frameTrace.graphTargetCopy?.encoded).toBe(true);
    expect(observationBufferResource).toBeDefined();
    expect(observationBufferWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bufferOffset: 0,
          size: surfaceDataConsumer.observationBytes,
        }),
      ]),
    );
    expect(textureToBufferCopies.length).toBeGreaterThan(0);
    expect(sceneDataCopyTape.graphPassNames).toEqual(
      expect.arrayContaining(['standard-scene-surface-data', 'ssao-calc']),
    );
    expect(sceneDataCopyTape.perFramePassNames).toContain('surface-normal-depth-consumer');
    expect(sceneDataCopyTape.consumerSubmittedWork).toMatchObject({
      works: [
        expect.objectContaining({
          passNames: ['surface-normal-depth-consumer'],
          resolvedDispatchCount: 1,
        }),
      ],
    });
    expect(sentinelMetrics.fullyOverwritten).toBe(true);
    expect(sceneDataConsumerMetrics.normalMismatchCount).toBe(0);
    expect(sceneDataNormalMetrics.count).toBeGreaterThan(1_000);
    expect(sceneDataNormalMetrics.maxAngularRadians).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.materialNormalX12Y12AngularRadians,
    );
    expect(sceneDataNormalMetrics.firstMismatch).toBeUndefined();
    expect(sceneDataConsumerMetrics.depth.maximumAbsolute).toBeLessThanOrEqual(1e-5);
    surfaceDataConsumer.setEnabled(false);
    const fragmentRaw = await captureTarget('ssao-raw');
    const fragmentBlurred = await captureTarget('ssao-blurred');
    const fragmentLinear = await captureLinear();
    return {
      fragmentNormal,
      sceneDataConsumerMetrics,
      sceneDataNormalMetrics,
      fragmentRaw,
      fragmentBlurred,
      fragmentLinear,
    };
  })();
  const { fragmentNormal, fragmentRaw, fragmentBlurred, fragmentLinear } = sceneDataReadback;
  expect(renderer.inspect().output.graphPassNames).toEqual(
    expect.arrayContaining(['ssao-calc', 'ssao-blur', 'main']),
  );
  return {
    fragmentOutput,
    fragmentInspection,
    fragmentNormal,
    fragmentRaw,
    fragmentBlurred,
    fragmentLinear,
  };
}

it('runs production Forward GTAO compute and fragment graph variants on WebGPU through lighting', {
  timeout: 180_000,
}, async () => {
  const canvas = document.createElement('canvas');
  const width = FORWARD_GTAO_FIXTURE.width;
  const height = FORWARD_GTAO_FIXTURE.height;
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  requireWebGpuCanvasContext(canvas);
  const recorder = value(attachRecorder(webgpu));
  const profiler = createProfiler();
  const surfaceDataConsumer = createForwardGtaoSceneDataConsumer(width, height);
  const hostAssembly = value(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      captureGpuTimings: true,
      profiler,
      features: [surfaceDataConsumer.feature],
    }),
  );
  const renderer = hostAssembly.renderer;
  const debugHost = hostAssembly.debugDrawHost as DebugDrawHost;
  const surfaceObservationBuffer = value(
    debugHost.device.createBuffer({
      label: 'forward-gtao.test.surface-data-observation',
      size: surfaceDataConsumer.observationBytes,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
    }),
  );
  surfaceDataConsumer.setObservationBuffer(surfaceObservationBuffer);
  const errors: unknown[] = [];
  let failureOperation = 'renderer.setup';
  let failureCameraConfig: unknown;
  let failureReceipt: unknown;
  let failureFrameTrace: unknown;
  let failureReadback: unknown;
  let failureManifestSummary: unknown;
  let captureCandidatePreparationFault = false;
  let candidateRetryDisplaySnapshot: CandidateRetryDisplaySnapshot | undefined;
  const candidatePreparationFaultSnapshots: {
    readonly event: unknown;
    readonly error: unknown;
    readonly inspection: ReturnType<typeof renderer.inspect>;
  }[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    errors.push(event.error);
    if (
      captureCandidatePreparationFault &&
      (event.error as { readonly code?: unknown }).code === 'graph-build-failed'
    ) {
      candidatePreparationFaultSnapshots.push(
        Object.freeze({
          event: event.error,
          error: describeFailure(event.error),
          inspection: renderer.inspect(),
        }),
      );
    }
  });
  const world = new World({ assets: hostAssembly.assets });
  const { assets, camera, material, normalTexture, skylight, pointLight } = createForwardGtaoScene(
    world,
    width,
    height,
  );
  expect(debugHost.clusterWorkObservationForConformance()).toBeUndefined();
  debugHost.setClusterWorkObservationForConformance(true);
  expect(debugHost.clusterWorkObservationForConformance()).toEqual({
    status: 'unavailable',
    reason: 'awaiting-write',
  });
  const lease = value(renderer.attach(world));
  const completedFrameWallMs: number[] = [];
  const clusterWorkObservations: {
    readonly phase: string;
    readonly receiptFrameId: number;
    readonly receiptPresentation: 'ready' | 'pending';
    readonly recordFrameNumber: number;
    readonly observationFrameId: number | undefined;
    readonly observation: ClusterWorkObservation;
    readonly frameTrace: NonNullable<
      ReturnType<DebugDrawHost['clusterWorkFrameTraceForConformance']>
    >;
  }[] = [];
  const surfaceConsumerReceipts: {
    readonly publicReceiptFrameId: number;
    readonly recordFrameNumber: number;
    readonly plan: NonNullable<ReturnType<typeof surfaceDataConsumer.latestPlan>>;
  }[] = [];
  const featureGraphDiagnosticRows: FeatureGraphDiagnosticRow[] = [];
  let sceneDataCopyTape: CapturedSceneDataCopyTape | undefined;
  let sceneDataCopyTapeCaptureStarted = false;
  let settlementFeatureGraphTrace:
    | ReturnType<DebugDrawHost['featureGraphTraceForConformance']>
    | undefined;
  let clusterWorkPhase = 'cluster-cold';
  const draw = async (selectedCamera: typeof camera = camera, allowRendererErrors = false) => {
    failureOperation = 'renderer.draw';
    const startedAt = performance.now();
    propagateTransforms(world).unwrap();
    world.update(1 / 60).unwrap();
    const cameraAo = world.hasComponent(selectedCamera, AmbientOcclusion)
      ? { ...world.get(selectedCamera, AmbientOcclusion).unwrap() }
      : undefined;
    failureCameraConfig = {
      width,
      height,
      operation: failureOperation,
      ambientOcclusion: cameraAo ?? null,
      algorithm:
        cameraAo === undefined
          ? null
          : cameraAo.algorithm === AMBIENT_OCCLUSION_GTAO
            ? 'gtao'
            : cameraAo.algorithm === AMBIENT_OCCLUSION_SSAO
              ? 'ssao'
              : 'unknown',
    };
    const previousReceipt = failureReceipt;
    const previousReadback = failureReadback;
    const previousCompletedFrameTrace = debugHost.clusterWorkFrameTraceForConformance();
    const recordDrawFailureWithoutReceipt = () => {
      failureReceipt = {
        status: 'not-produced',
        operation: failureOperation,
        lastSuccessfulReceipt: previousReceipt ?? null,
      };
      failureFrameTrace = {
        status: 'not-produced',
        operation: failureOperation,
        lastCompletedBeforeFailure: previousCompletedFrameTrace ?? null,
      };
      failureReadback = {
        status: 'not-produced',
        operation: failureOperation,
        lastSuccessfulCapture: previousReadback ?? null,
      };
    };
    let result: ReturnType<typeof renderer.draw>;
    try {
      result = renderer.draw({
        leases: [lease],
        camera: { lease, entityKey: selectedCamera },
        environment: { lease },
      });
    } catch (cause) {
      recordDrawFailureWithoutReceipt();
      throw cause;
    }
    if (!result.ok) {
      recordDrawFailureWithoutReceipt();
      throw result.error;
    }
    const receipt = result.value;
    failureReceipt = {
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      graphGeneration: receipt.graphGeneration,
      presentation: receipt.presentation,
    };
    failureOperation = 'receipt.completed';
    const surfacePlanForDraw = surfaceDataConsumer.latestPlan();
    value(await receipt.completed);
    if (debugHost.featureGraphTraceForConformance() !== undefined) {
      const diagnosticSnapshot = featureGraphDiagnosticSnapshot({
        renderer,
        debugHost,
        receipt,
        plan: surfacePlanForDraw,
        submissionSnapshots: surfaceDataConsumer.submittedWorkSnapshots(),
      });
      rememberFeatureGraphDiagnostic(featureGraphDiagnosticRows, {
        phase: 'post-completion-pre-observe',
        publicReceiptFrameId: receipt.frameId,
        retainedRecordFrameNumber: diagnosticSnapshot.recordFrameNumber,
        snapshot: diagnosticSnapshot,
      });
    }
    const frameEvidence = validatedClusterFrameReceipt(
      receipt,
      debugHost.clusterWorkObservationForConformance(),
      debugHost.clusterWorkFrameTraceForConformance(),
    );
    const { observation: clusterObservation, frameTrace } = frameEvidence;
    failureFrameTrace = frameTrace;
    clusterWorkObservations.push({
      phase: clusterWorkPhase,
      receiptFrameId: receipt.frameId,
      receiptPresentation: receipt.presentation,
      recordFrameNumber: frameTrace.recordFrameNumber,
      observationFrameId: frameTrace.observationFrameId,
      observation: clusterObservation,
      frameTrace,
    });
    if (surfacePlanForDraw !== undefined) {
      surfaceConsumerReceipts.push({
        publicReceiptFrameId: receipt.frameId,
        recordFrameNumber: frameTrace.recordFrameNumber,
        plan: surfacePlanForDraw,
      });
    }
    completedFrameWallMs.push(performance.now() - startedAt);
    if (!allowRendererErrors) {
      throwForForwardGtaoRendererErrors({
        errors,
        output: renderer.inspect().output,
        receipt: failureReceipt,
        frameTrace,
      });
    }
    return receipt;
  };
  let lastReadyReceipt: Awaited<ReturnType<typeof draw>> | undefined;
  const capture = async (selectedCamera: typeof camera = camera) => {
    const presentations = new Map<string, number>();
    const startedAt = Date.now();
    const deadline = startedAt + 30_000;
    let attempts = 0;
    let lastReceipt:
      | {
          readonly frameId: number;
          readonly presentation: unknown;
          readonly pendingReason: unknown;
        }
      | undefined;
    while (Date.now() < deadline) {
      attempts += 1;
      renderer.requestObservation?.(['final-display']);
      const receipt = await draw(selectedCamera);
      const presentation = String(receipt.presentation);
      presentations.set(presentation, (presentations.get(presentation) ?? 0) + 1);
      lastReceipt = {
        frameId: receipt.frameId,
        presentation: receipt.presentation,
        pendingReason: receipt.presentationPendingReason,
      };
      if (receipt.presentation !== 'ready') {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      failureOperation = 'renderer.observe(final-display)';
      const observed = value(await renderer.observe(receipt, { include: ['final-display'] }));
      const output = observed.observations?.find((entry) => entry.domain === 'final-display');
      if (output === undefined) throw new Error('final-display observation missing');
      lastReadyReceipt = receipt;
      if (debugHost.featureGraphTraceForConformance() !== undefined) {
        const planForReceipt = surfaceConsumerReceipts.find(
          (row) => row.publicReceiptFrameId === receipt.frameId,
        )?.plan;
        const diagnosticSnapshot = featureGraphDiagnosticSnapshot({
          renderer,
          debugHost,
          receipt,
          plan: planForReceipt,
          submissionSnapshots: surfaceDataConsumer.submittedWorkSnapshots(),
        });
        rememberFeatureGraphDiagnostic(featureGraphDiagnosticRows, {
          phase: 'post-observe',
          publicReceiptFrameId: receipt.frameId,
          retainedRecordFrameNumber: diagnosticSnapshot.recordFrameNumber,
          snapshot: diagnosticSnapshot,
        });
      }
      return output;
    }
    const inspection = renderer.inspect();
    throw new Error(
      `WebGPU Forward GTAO frame did not become ready: ${JSON.stringify({
        presentations: [...presentations.entries()],
        attempts,
        elapsedMs: Date.now() - startedAt,
        lastReceipt,
        backend: inspection.capabilities.backendKind,
        graphPassNames: inspection.output.graphPassNames,
        errors,
      })}`,
    );
  };
  const captureTarget = async (
    name: 'ssao-raw' | 'ssao-blurred' | 'standard-scene-surface-normal',
    selectedCamera: typeof camera = camera,
  ) => {
    failureOperation = `capture-target:${name}`;
    let targetDrawNumber = 0;
    const drawWithFinalDisplayDemand = async () => {
      const requested = renderer.requestObservation?.(['final-display']);
      if (requested === undefined) throw new Error('final-display observation is unavailable');
      value(requested);
      const drawNumber = targetDrawNumber;
      targetDrawNumber += 1;
      const captureArmedSceneDataCopy =
        name === 'standard-scene-surface-normal' &&
        drawNumber % 2 === 1 &&
        !sceneDataCopyTapeCaptureStarted;
      let capturePending: ReturnType<typeof recorder.captureFrame> | undefined;
      if (captureArmedSceneDataCopy) {
        sceneDataCopyTapeCaptureStarted = true;
        capturePending = recorder.captureFrame();
        value(await recorder.frameBoundary());
        const sentinelWords = new Uint32Array(
          surfaceDataConsumer.observationBytes / Uint32Array.BYTES_PER_ELEMENT,
        );
        sentinelWords.fill(SCENE_DATA_OBSERVATION_SENTINEL);
        value(debugHost.device.queue.writeBuffer(surfaceObservationBuffer, 0, sentinelWords));
      }
      let receipt: Awaited<ReturnType<typeof draw>> | undefined;
      try {
        receipt = await draw(selectedCamera);
      } finally {
        if (capturePending !== undefined) {
          value(await recorder.frameBoundary());
          const tape = value(await capturePending);
          const frameTrace = debugHost.clusterWorkFrameTraceForConformance();
          if (receipt !== undefined && frameTrace !== undefined) {
            const inspection = renderer.inspect();
            const consumerPlan = surfaceConsumerReceipts.find(
              (row) => row.publicReceiptFrameId === receipt?.frameId,
            )?.plan;
            const submittedSnapshots = surfaceDataConsumer.submittedWorkSnapshots();
            const consumerSubmittedWork =
              consumerPlan === undefined
                ? undefined
                : submittedSnapshots.find(
                    (row) => row.planFrameNumber === consumerPlan.frameNumber,
                  );
            sceneDataCopyTape = Object.freeze({
              tape,
              receipt: Object.freeze({
                frameId: receipt.frameId,
                deviceGeneration: receipt.deviceGeneration,
                presentation: receipt.presentation,
              }),
              recordFrameNumber: frameTrace.recordFrameNumber,
              frameTrace,
              graphPassNames: Object.freeze([...inspection.output.graphPassNames]),
              perFramePassNames: Object.freeze([...inspection.perFramePassNames]),
              consumerPlanFrameNumber: consumerPlan?.frameNumber ?? null,
              consumerSubmittedWork: consumerSubmittedWork ?? null,
            });
          }
        }
      }
      if (receipt === undefined) throw new Error('renderer.draw did not return a receipt');
      if (receipt.presentation === 'ready') {
        failureOperation = 'renderer.observe(final-display)';
        const observed = value(await renderer.observe(receipt, { include: ['final-display'] }));
        if (!observed.observations?.some((row) => row.domain === 'final-display')) {
          throw new Error(`final-display preparation observation missing for ${receipt.frameId}`);
        }
      }
      return receipt;
    };
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const capture = await captureForwardGtaoTarget(debugHost, name, drawWithFinalDisplayDemand);
        failureReceipt = {
          publicReceiptFrameId: capture.publicReceiptFrameId,
          recordFrameNumber: capture.targetRecordFrameNumber,
          graphGeneration: capture.graphGeneration,
          textureIdentity: capture.textureIdentity,
          deviceGeneration: capture.deviceGeneration,
          presentation: 'ready',
        };
        failureFrameTrace = capture.frameTrace;
        failureReadback = {
          target: name,
          format: capture.format,
          width: capture.width,
          height: capture.height,
          byteLength: capture.bytes.byteLength,
          sha256: await sha256Hex(capture.bytes),
        };
        return capture;
      } catch (error) {
        if (!(error instanceof ForwardGtaoCaptureNotReadyError)) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`${name} target capture did not produce a ready attempt`);
  };
  const captureLinear = (selectedCamera: typeof camera = camera) =>
    captureLinearWithReadyRetry({
      renderer,
      debugHost,
      draw: () => draw(selectedCamera),
      setFailureOperation: (operation) => {
        failureOperation = operation;
      },
      setFailureReceipt: (receipt) => {
        failureReceipt = receipt;
      },
      setFailureFrameTrace: (trace) => {
        failureFrameTrace = trace;
      },
      setFailureReadback: (readback) => {
        failureReadback = readback;
      },
    });
  let finalLightingRhiCapture:
    | {
        readonly tape: EncodedTape;
        readonly receipt: FrameReceipt;
        readonly frameTrace: ReturnType<DebugDrawHost['clusterWorkFrameTraceForConformance']>;
      }
    | undefined;
  const captureLinearWithRhiTape = (selectedCamera: typeof camera = camera) =>
    captureLinearWithReadyRetry({
      renderer,
      debugHost,
      draw: async () => {
        const captured = await captureRecordedReceiptFrame({
          recorder,
          draw: () => draw(selectedCamera),
          frameTrace: () => debugHost.clusterWorkFrameTraceForConformance(),
        });
        finalLightingRhiCapture = captured;
        return captured.receipt;
      },
      setFailureOperation: (operation) => {
        failureOperation = operation;
      },
      setFailureReceipt: (receipt) => {
        failureReceipt = receipt;
      },
      setFailureFrameTrace: (trace) => {
        failureFrameTrace = trace;
      },
      setFailureReadback: (readback) => {
        failureReadback = readback;
      },
    });
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');
    const manifestBytes = await fetchGtaoManifestBytes();
    const manifestIdentity = {
      url: new URL('/shaders/manifest.json', location.href).href,
      byteLength: manifestBytes.byteLength,
      sha256: await sha256Hex(manifestBytes),
    };
    const registryIdentity = {
      worldUsesHostAssets: assets === hostAssembly.assets,
      worldUsesHostShaderRegistry: assets.shaderRegistry === hostAssembly.assets.shaderRegistry,
    };
    failureManifestSummary = { ...manifestIdentity, registryIdentity };
    expect(registryIdentity).toEqual({
      worldUsesHostAssets: true,
      worldUsesHostShaderRegistry: true,
    });
    const inputIdentity = await sha256Hex(
      new TextEncoder().encode(
        JSON.stringify({
          fixture: FORWARD_GTAO_FIXTURE,
          normalTexture: [191, 159, 234, 255],
          boxes: [
            { center: [0, 0, -4.005], size: [20, 20, 0.01] },
            { center: [0, 0, -3.9], size: [1.4, 1.4, 0.2] },
          ],
        }),
      ),
    );
    const profilerSession = value(
      profiler.startCapture({ frameLimit: 96, eventLimit: 16_384, detail: 'nested' }),
    );
    const workloadStartedAt = performance.now();
    const withoutAo = await capture();
    const noAoLinear = await captureLinear();
    const coldRows = clusterWorkObservations.filter(
      (row) => row.phase === 'cluster-cold' && row.observation.status === 'captured',
    );
    expect(coldRows.some((row) => row.receiptPresentation === 'ready')).toBe(true);
    const coldClusterWork = coldRows[0];
    expect(coldClusterWork?.observation).toMatchObject({
      status: 'captured',
      invocations: 1,
      packedLightSlots: 1,
      writeSucceeded: true,
    });
    expect(coldClusterWork?.receiptFrameId).toBeGreaterThan(0);
    expect(
      coldClusterWork?.observation.status === 'captured'
        ? coldClusterWork.observation.acceptedWriteBytes
        : 0,
    ).toBeGreaterThan(0);
    for (const row of coldRows.slice(1)) {
      expect(row.observation).toMatchObject({
        status: 'captured',
        invocations: 1,
        packedLightSlots: 0,
        acceptedWriteBytes: 0,
        writeSucceeded: true,
      });
    }
    clusterWorkPhase = 'cluster-unchanged';
    await draw();
    const steadyClusterWork = clusterWorkObservations.at(-1)?.observation;
    expect(steadyClusterWork).toMatchObject({
      status: 'captured',
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });
    world.set(pointLight, PointLight, { intensity: 9, range: 12 }).unwrap();
    clusterWorkPhase = 'light-value-change';
    await draw();
    const changedLightWork = clusterWorkObservations.at(-1)?.observation;
    expect(changedLightWork).toMatchObject({
      status: 'captured',
      invocations: 1,
      packedLightSlots: 1,
      writeSucceeded: true,
    });
    expect(
      changedLightWork?.status === 'captured' ? changedLightWork.acceptedWriteBytes : 0,
    ).toBeGreaterThan(0);
    world.set(pointLight, PointLight, { intensity: 8, range: 12 }).unwrap();
    clusterWorkPhase = 'light-value-restored';
    await draw();
    const restoredLightWork = clusterWorkObservations.at(-1)?.observation;
    expect(restoredLightWork).toMatchObject({
      status: 'captured',
      invocations: 1,
      packedLightSlots: 1,
      writeSucceeded: true,
    });
    expect(
      restoredLightWork?.status === 'captured' ? restoredLightWork.acceptedWriteBytes : 0,
    ).toBeGreaterThan(0);
    const noAoInspection = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(noAoInspection?.status).toBe('off');
    expect(noAoInspection?.passes).toEqual([]);
    expect(debugHost.getCurrentGraphTarget('ssao-raw')).toBeUndefined();
    expect(debugHost.getCurrentGraphTarget('ssao-blurred')).toBeUndefined();

    world.removeComponent(skylight, Skylight).unwrap();
    world.removeComponent(pointLight, PointLight).unwrap();
    const emissiveOnly = await captureLinear();
    world.addComponent(skylight, { component: Skylight, data: {} }).unwrap();
    const indirectOnly = await captureLinear();
    world.removeComponent(skylight, Skylight).unwrap();
    world
      .addComponent(pointLight, {
        component: PointLight,
        data: { intensity: 8, range: 12 },
      })
      .unwrap();
    const directOnly = await captureLinear();
    world.addComponent(skylight, { component: Skylight, data: {} }).unwrap();
    const restoredNoAoLinear = await captureLinear();
    const restoredNoAoMetrics = linearErrorMetrics(
      rgba16FloatRgb(noAoLinear),
      rgba16FloatRgb(restoredNoAoLinear),
    );
    expect(restoredNoAoMetrics.maxAbsolute).toBe(0);
    expect(restoredNoAoMetrics.rmsAbsolute).toBe(0);

    world
      .addComponent(camera, {
        component: AmbientOcclusion,
        data: {
          algorithm: AMBIENT_OCCLUSION_GTAO,
          directLightingStrength: 0,
          radius: FORWARD_GTAO_FIXTURE.radius,
          bias: FORWARD_GTAO_FIXTURE.bias,
          intensity: FORWARD_GTAO_FIXTURE.intensity,
          thickness: FORWARD_GTAO_FIXTURE.thickness,
          distanceExponent: FORWARD_GTAO_FIXTURE.distanceExponent,
          distanceFallOff: FORWARD_GTAO_FIXTURE.distanceFallOff,
          resolutionScale: FORWARD_GTAO_FIXTURE.resolutionScale,
          quality: AMBIENT_OCCLUSION_QUALITY_HIGH,
        },
      })
      .unwrap();
    clusterWorkPhase = 'gtao-enabled-cold';
    const fragmentStage = await captureSceneDataConsumerSettlement({
      renderer,
      debugHost,
      capture: () => capture(),
      captureTarget,
      captureLinear: () => captureLinear(),
      surfaceDataConsumer,
      surfaceObservationBuffer,
      surfaceConsumerReceipts,
      featureGraphDiagnosticRows,
      errors,
      width,
      height,
      getLastReadyReceipt: () => lastReadyReceipt,
      getSceneDataCopyTape: () => sceneDataCopyTape,
      setClusterWorkPhase: (phase) => {
        clusterWorkPhase = phase;
      },
      setSettlementFeatureGraphTrace: (trace) => {
        settlementFeatureGraphTrace = trace;
      },
    });
    const {
      fragmentOutput,
      fragmentInspection,
      fragmentNormal,
      fragmentRaw,
      fragmentBlurred,
      fragmentLinear,
    } = fragmentStage;
    debugHost.setGtaoExecutionOverrideForConformance('compute');
    const computeOutput = await capture();
    const computeInspection = requireGtaoInspection(
      renderer.inspect().standardLighting?.ambientOcclusion,
      'compute',
    );
    const computeNormal = await captureTarget('standard-scene-surface-normal');
    const computeRaw = await captureTarget('ssao-raw');
    const computeBlurred = await captureTarget('ssao-blurred');
    const computeLinear = await captureLinearWithRhiTape();
    const capturedFinalLightingFrame = finalLightingRhiCapture;
    if (capturedFinalLightingFrame === undefined) {
      throw new Error('ready final-lighting draw did not produce its one-shot RHI tape');
    }
    const finalLightingTapePath =
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgpu-final-lighting-bilinear-b1b074d-20261101.rhitape';
    await commands.writeFile(
      finalLightingTapePath,
      base64Bytes(capturedFinalLightingFrame.tape.bytes),
      'base64',
    );
    const finalLightingTapeModel = buildFrameModel(capturedFinalLightingFrame.tape.tape);
    const finalLightingTapeSummary = summarizeFrame(finalLightingTapeModel);
    let finalLightingShaderSource: string | undefined;
    try {
      finalLightingShaderSource = recordedStandardMainFragmentSource(finalLightingTapeModel);
    } catch {
      finalLightingShaderSource = undefined;
    }
    const referenceField = createForwardGtaoReferenceField(width, height);
    const fragmentNormalMetrics = materialNormalFieldMetrics(referenceField, fragmentNormal.bytes);
    const normalErrors = materialNormalFieldMetrics(referenceField, computeNormal.bytes);
    const selectedMaterial = assets.read(material).unwrap();
    const selectedNormalTexture = assets.read(normalTexture).unwrap();
    const normalTextureBytes = selectedNormalTexture.data;
    const normalCaptureIdentity = async (capture: typeof computeNormal) => ({
      format: capture.format,
      width: capture.width,
      height: capture.height,
      bytesPerRow: capture.width * capture.bytesPerTexel,
      byteLength: capture.bytes.byteLength,
      frameId: capture.publicReceiptFrameId,
      targetRecordFrameNumber: capture.targetRecordFrameNumber,
      publicReceiptFrameId: capture.publicReceiptFrameId,
      graphGeneration: capture.graphGeneration,
      deviceGeneration: capture.deviceGeneration,
      textureIdentity: capture.textureIdentity,
      preparation: capture.preparation,
      frameTrace: capture.frameTrace,
      sha256: await sha256Hex(capture.bytes),
      rgbaBase64: base64Bytes(capture.bytes),
      actualLow24Words: packedNormalWordsLow24(capture.bytes),
    });
    const normalEvidencePath =
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgpu-normal-reference-rhi-diagnostic-20261101-4b7499c.json';
    const normalEvidence = {
      schema: 'forgeax::forward-gtao-normal-reference-evidence::1',
      fixture: FORWARD_GTAO_FIXTURE,
      manifestIdentity,
      inputIdentity,
      selectedMaterial: {
        assetHandle: Number(material),
        assetSha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(selectedMaterial))),
        forwardPass: selectedMaterial.passes?.find((pass) => pass.name === 'forward'),
      },
      normalTexture: {
        assetHandle: Number(normalTexture),
        format: selectedNormalTexture.format,
        shape: selectedNormalTexture.shape,
        rgba: Array.from(normalTextureBytes),
        sha256: await sha256Hex(normalTextureBytes),
        tangentContract: 'decode RG in [0,1], remap to [-1,1], reconstruct positive Z; ignore B',
      },
      frozenAngularBudgetRadians: GTAO_COMPARISON_BUDGET.materialNormalX12Y12AngularRadians,
      fragment: {
        execution: fragmentInspection.execution,
        capture: await normalCaptureIdentity(fragmentNormal),
        metrics: fragmentNormalMetrics,
        maxErrorPixel: fragmentNormalMetrics.maxError,
      },
      compute: {
        execution: computeInspection.execution,
        capture: await normalCaptureIdentity(computeNormal),
        metrics: normalErrors,
        maxErrorPixel: normalErrors.maxError,
      },
    };
    await commands.writeFile(
      normalEvidencePath,
      JSON.stringify(
        {
          ...normalEvidence,
          selectedShaderPublication: {
            status: 'pending-captured-work-lineage',
            reason: 'raw fragment/compute captures are persisted before source identity admission',
          },
        },
        null,
        2,
      ),
    );
    expectClusterWorkPhase(clusterWorkObservations, 'gtao-enabled-cold', {
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });
    expect(renderer.inspect().output.graphPassNames).toEqual(
      expect.arrayContaining(['gtao-calc-compute', 'ssao-blur', 'main']),
    );
    expect(renderer.inspect().output.graphPassNames).not.toContain('ssao-calc');
    expect(fragmentInspection.execution).toBe('fragment');
    expect(computeInspection.execution).toBe('compute');
    expect(computeInspection.input.extent).toEqual({ width, height });
    expect(computeInspection.output.extent).toEqual({
      width: Math.round(width * FORWARD_GTAO_FIXTURE.resolutionScale),
      height: Math.round(height * FORWARD_GTAO_FIXTURE.resolutionScale),
    });
    expect(computeRaw.format).toBe('rgba8unorm');
    expect(computeBlurred.format).toBe('r8unorm');
    expect(computeRaw.bytes.byteLength).toBe(computeRaw.width * computeRaw.height * 4);
    expect(computeBlurred.bytes.byteLength).toBe(computeBlurred.width * computeBlurred.height);
    const referenceConfig = {
      outputWidth: computeRaw.width,
      outputHeight: computeRaw.height,
      radius: computeInspection.numerical.radius,
      bias: computeInspection.numerical.bias,
      intensity: computeInspection.numerical.intensity,
      thickness: computeInspection.numerical.thickness,
      distanceExponent: computeInspection.numerical.distanceExponent,
      distanceFallOff: computeInspection.numerical.distanceFallOff,
      sampleBudget: computeInspection.numerical.sampleBudget,
    };
    const rawReference = computeGtaoRawReference(referenceField, referenceConfig);
    const filteredReference = filterGtaoReference(
      referenceField,
      rawReference,
      referenceConfig.radius,
    );
    const rawVisibilityErrors = byteErrorMetrics(
      byteChannel(computeRaw.bytes, computeRaw.bytesPerTexel, 0),
      byteChannel(rawReference.rgba, 4, 0),
    );
    expect(rawVisibilityErrors.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
    );
    expect(rawVisibilityErrors.rms).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError,
    );
    const rawNormalErrors = [1, 2].map((channel) =>
      byteErrorMetrics(
        byteChannel(computeRaw.bytes, computeRaw.bytesPerTexel, channel),
        byteChannel(rawReference.rgba, 4, channel),
      ),
    );
    for (const metrics of rawNormalErrors) {
      expect(metrics.maxAbsolute).toBeLessThanOrEqual(GTAO_COMPARISON_BUDGET.rawNormalMaxByteError);
      expect(metrics.rms).toBeLessThanOrEqual(GTAO_COMPARISON_BUDGET.rawNormalRmsByteError);
    }
    expect(
      byteChannel(computeRaw.bytes, computeRaw.bytesPerTexel, 3).every((byte) => byte === 255),
    ).toBe(true);
    const filteredErrors = byteErrorMetrics(computeBlurred.bytes, filteredReference);
    expect(filteredErrors.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.filteredVisibilityMaxByteError,
    );
    expect(filteredErrors.rms).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.filteredVisibilityRmsByteError,
    );
    expect(normalErrors.count).toBeGreaterThan(1_000);
    expect(normalErrors.maxAngularRadians).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.materialNormalX12Y12AngularRadians,
    );
    expect(normalErrors.firstMismatch).toBeUndefined();
    const fragmentRawVsCompute = byteErrorMetrics(fragmentRaw.bytes, computeRaw.bytes);
    const fragmentFilterVsCompute = byteErrorMetrics(fragmentBlurred.bytes, computeBlurred.bytes);
    const fragmentLinearVsCompute = linearErrorMetrics(
      rgba16FloatRgb(fragmentLinear),
      rgba16FloatRgb(computeLinear),
    );
    expect(fragmentRawVsCompute.maxAbsolute).toBeLessThanOrEqual(1);
    expect(fragmentFilterVsCompute.maxAbsolute).toBeLessThanOrEqual(1);
    expect(fragmentLinearVsCompute.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxAbsoluteError,
    );
    expect(fragmentLinearVsCompute.maxRelative).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxRelativeError,
    );
    expect(fragmentLinearVsCompute.rmsAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingRmsAbsoluteError,
    );
    expect(fragmentNormalMetrics.firstMismatch).toBeUndefined();
    const changedByAo = maxDisplayDelta(
      withoutAo.bytes,
      computeOutput.bytes,
      withoutAo.metadata.bytesPerRow,
      width,
      height,
    );
    const stageDelta = maxDisplayDelta(
      fragmentOutput.bytes,
      computeOutput.bytes,
      fragmentOutput.metadata.bytesPerRow,
      width,
      height,
    );
    expect(changedByAo.maximum).toBeGreaterThan(2);
    expect(changedByAo.changed).toBeGreaterThan(8);
    expect(stageDelta.maximum).toBeLessThanOrEqual(1);

    const contactIndex = requireContactReferencePixel(
      referenceField,
      width,
      height,
      computeRaw.width,
      computeRaw.height,
      filteredReference,
    );
    const emissive = rgba16FloatPixel(
      emissiveOnly,
      contactIndex % width,
      Math.floor(contactIndex / width),
    );
    const indirectWithEmission = rgba16FloatPixel(
      indirectOnly,
      contactIndex % width,
      Math.floor(contactIndex / width),
    );
    const directWithEmission = rgba16FloatPixel(
      directOnly,
      contactIndex % width,
      Math.floor(contactIndex / width),
    );
    const indirect = indirectWithEmission.map((value, channel) => value - (emissive[channel] ?? 0));
    const direct = directWithEmission.map((value, channel) => value - (emissive[channel] ?? 0));
    expect(Math.max(...indirect)).toBeGreaterThan(0.01);
    expect(Math.max(...direct)).toBeGreaterThan(0.01);
    expect(Math.max(...emissive)).toBeGreaterThan(0.01);
    const actualLighting = rgba16FloatPixel(
      computeLinear,
      contactIndex % width,
      Math.floor(contactIndex / width),
    );
    const lightingContact = analyzeForwardGtaoFinalLightingContact({
      filteredReference,
      raw: computeRaw,
      actualFiltered: computeBlurred,
      fullWidth: width,
      fullHeight: height,
      contactIndex,
      emissive: emissive as [number, number, number],
      indirect: indirect as [number, number, number],
      direct: direct as [number, number, number],
      actual: actualLighting as [number, number, number],
    });
    const contactX = lightingContact.pixel.x;
    const contactY = lightingContact.pixel.y;
    const contactVisibility = lightingContact.bilinear.visibility;
    const ao0 = lightingContact.errors;
    const selectedNormalTextureForLighting = assets.read(normalTexture).unwrap();
    const finalLightingEvidencePath =
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgpu-final-lighting-bilinear-b1b074d-20261101.json';
    await writeForwardGtaoFinalLightingEvidence({
      path: finalLightingEvidencePath,
      tapePath: finalLightingTapePath,
      fixture: FORWARD_GTAO_FIXTURE,
      manifestIdentity: failureManifestSummary,
      inputIdentity,
      contact: lightingContact,
      fullExtent: { width, height },
      aoExtent: { width: computeRaw.width, height: computeRaw.height },
      tape: capturedFinalLightingFrame,
      tapeModel: finalLightingTapeModel,
      tapeSummary: finalLightingTapeSummary,
      shaderSource: finalLightingShaderSource,
      registry: assets.shaderRegistry,
      selectedMaterial,
      captures: {
        normal: computeNormal,
        raw: computeRaw,
        filtered: computeBlurred,
        linearHdr: computeLinear,
      },
      normalTexture: {
        format: selectedNormalTextureForLighting.format,
        shape: selectedNormalTextureForLighting.shape,
        data: selectedNormalTextureForLighting.data,
      },
    });
    expect(capturedFinalLightingFrame.receipt.frameId).toBe(computeLinear.frameId);
    expect(capturedFinalLightingFrame.frameTrace?.receipt).toMatchObject({
      publicReceiptFrameId: computeLinear.frameId,
      completion: 'completed',
    });
    expect(ao0.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxAbsoluteError,
    );
    expect(ao0.maxRelative).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxRelativeError,
    );
    expect(ao0.rmsAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingRmsAbsoluteError,
    );
    const sameDemandAo0Output = await capture();
    const sameDemandAo0Graph = directStrengthGraphSnapshot(
      renderer,
      debugHost,
      lastReadyReceipt,
      sameDemandAo0Output.metadata,
    );
    expect(sameDemandAo0Output.metadata.graphGeneration).toBe(sameDemandAo0Graph.graphGeneration);
    expect(sameDemandAo0Output.metadata.deviceGeneration).toBe(sameDemandAo0Graph.deviceGeneration);
    expect(sameDemandAo0Graph.directLightingStrength).toBe(0);
    world.set(camera, AmbientOcclusion, { directLightingStrength: 1 }).unwrap();
    const sameDemandAo1Output = await capture();
    const sameDemandAo1Graph = directStrengthGraphSnapshot(
      renderer,
      debugHost,
      lastReadyReceipt,
      sameDemandAo1Output.metadata,
    );
    expect(sameDemandAo1Output.metadata.graphGeneration).toBe(sameDemandAo1Graph.graphGeneration);
    expect(sameDemandAo1Output.metadata.deviceGeneration).toBe(sameDemandAo1Graph.deviceGeneration);
    expect(sameDemandAo1Graph.directLightingStrength).toBe(1);
    expect(sameDemandAo1Graph.receiptFrameId).toBe(sameDemandAo1Graph.frameTraceReceiptFrameId);
    expect(sameDemandAo0Graph.receiptFrameId).toBe(sameDemandAo0Graph.frameTraceReceiptFrameId);
    expect(directStrengthGraphIdentity(sameDemandAo1Graph)).toEqual(
      directStrengthGraphIdentity(sameDemandAo0Graph),
    );
    const directStrengthInspection = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(directStrengthInspection?.numerical.directLightingStrength).toBe(1);
    const directAoLinear = await captureLinear();
    const directAoOutput = await capture();
    const expectedAo1 = composeLinearLightingReference({
      indirect: indirect as [number, number, number],
      direct: direct as [number, number, number],
      emissive: emissive as [number, number, number],
      screenVisibility: contactVisibility,
      materialOcclusion: 1,
      directLightingStrength: 1,
    });
    const ao1 = linearErrorMetrics(
      Float32Array.from(rgba16FloatPixel(directAoLinear, contactX, contactY)),
      Float32Array.from(expectedAo1),
    );
    expect(ao1.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxAbsoluteError,
    );
    expect(ao1.maxRelative).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxRelativeError,
    );
    expect(ao1.rmsAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingRmsAbsoluteError,
    );

    const aoErrorCount = errors.length;
    world.set(camera, AmbientOcclusion, { radius: 0 }).unwrap();
    clusterWorkPhase = 'ao-prepare-failure';
    await draw(camera, true);
    const aoPreparationFailures = errors.splice(aoErrorCount).map(describeFailure);
    expect(aoPreparationFailures).toEqual([
      expect.objectContaining({
        name: 'RendererOperationError',
        code: 'device-operation-failed',
        expected: 'the active device generation completes the renderer-owned operation',
        hint: 'inspect renderer state and the structured cause, then retry or recover',
        detail: expect.objectContaining({
          operation: 'renderer-event',
          cause: expect.objectContaining({
            code: 'ssao-radius-non-positive',
            expected: 'SSAO radius must be > 0',
            hint: expect.stringMatching(
              /radius.*positive value.*remove AmbientOcclusion.*disable AO/i,
            ),
            detail: { paramName: 'radius', value: 0 },
          }),
        }),
      }),
    ]);
    expect(renderer.inspect().standardLighting?.ambientOcclusion.status).toBe('off');
    expect(renderer.inspect().output.graphPassNames).not.toContain('ssao-calc');
    expect(debugHost.getCurrentGraphTarget('ssao-raw')).toBeUndefined();
    expect(debugHost.getCurrentGraphTarget('ssao-blurred')).toBeUndefined();
    world.set(camera, AmbientOcclusion, { radius: FORWARD_GTAO_FIXTURE.radius }).unwrap();
    clusterWorkPhase = 'ao-recovery';
    await capture();
    const recoveredAfterAoFailure = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(recoveredAfterAoFailure?.status).toBe('active');
    expect(recoveredAfterAoFailure?.algorithm).toBe('gtao');
    expectClusterWorkPhase(clusterWorkObservations, 'ao-prepare-failure', {
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });
    expectClusterWorkPhase(clusterWorkObservations, 'ao-recovery', {
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });

    const requestedFaultExtent = {
      width: Math.round(width * 0.75),
      height: Math.round(height * 0.75),
    };
    requireNoForwardGtaoRendererErrors(errors, 'GTAO candidate preparation fault injection');
    world.set(camera, AmbientOcclusion, { resolutionScale: 0.75 }).unwrap();
    const previousCandidateFaultAo = renderer.inspect().standardLighting?.ambientOcclusion;
    const {
      candidateGeneration,
      previousAo,
      receipt: candidateFaultReceipt,
      verifiedFailure: verifiedCandidateFailure,
    } = await assertCandidatePreparationFailure({
      acceptedReceipt: lastReadyReceipt,
      previousAo: previousCandidateFaultAo,
      requestedExtent: requestedFaultExtent,
      errors,
      performFaultDraw: async () => {
        debugHost.armGtaoCandidatePreparationFailureForConformance();
        captureCandidatePreparationFault = true;
        clusterWorkPhase = 'ao-candidate-preparation-failure';
        try {
          const receipt = await draw(camera, true);
          return {
            receipt,
            snapshots: [...candidatePreparationFaultSnapshots],
          };
        } finally {
          captureCandidatePreparationFault = false;
        }
      },
    });
    const candidateFaultRows = clusterWorkObservations.filter(
      (row) => row.phase === 'ao-candidate-preparation-failure',
    );
    expect(candidateFaultRows).toHaveLength(1);
    expect(candidateFaultRows[0]).toMatchObject({
      receiptFrameId: candidateFaultReceipt.frameId,
      receiptPresentation: candidateFaultReceipt.presentation,
      frameTrace: {
        observationFrameId: candidateFaultReceipt.frameId,
        receipt: {
          publicReceiptFrameId: candidateFaultReceipt.frameId,
          presentation: candidateFaultReceipt.presentation,
          completion: 'completed',
        },
      },
    });
    expectClusterWorkPhase(clusterWorkObservations, 'ao-candidate-preparation-failure', {
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });
    consumeVerifiedForwardGtaoCandidateFault(errors, verifiedCandidateFailure);
    expect(errors).toEqual([]);

    const candidateRetryOutput = await capture();
    const candidateRetryReceipt = lastReadyReceipt;
    const candidateRetryFrameTrace = debugHost.clusterWorkFrameTraceForConformance();
    const candidateRetryClusterObservation = debugHost.clusterWorkObservationForConformance();
    const candidateRetryDisplay = snapshotCandidateRetryDisplay({
      output: candidateRetryOutput,
      receipt: candidateRetryReceipt,
      inspection: renderer.inspect(),
      debugHost,
      frameTrace: candidateRetryFrameTrace,
      clusterObservation: candidateRetryClusterObservation,
    });
    candidateRetryDisplaySnapshot = candidateRetryDisplay;
    const { ambientOcclusion: candidateRetryAo } = assertCandidateRetryDisplaySnapshot({
      snapshot: candidateRetryDisplay,
      receipt: candidateRetryReceipt,
      frameTrace: candidateRetryFrameTrace,
      clusterObservation: candidateRetryClusterObservation,
    });
    expect(candidateRetryAo.status).toBe('active');
    expect(candidateRetryAo.algorithm).toBe('gtao');
    expect(candidateRetryAo.output.extent).toEqual(requestedFaultExtent);
    expect(candidateRetryAo.graphGeneration).not.toBe(previousAo.graphGeneration);
    expect(renderer.inspect().output.graphPassNames).toEqual(
      expect.arrayContaining(['gtao-calc-compute', 'ssao-blur', 'main']),
    );
    const candidateRetryRaw = await captureTarget('ssao-raw');
    const candidateRetryFiltered = await captureTarget('ssao-blurred');
    const candidateRetryLinear = await captureLinear();
    const candidateRetryLinearAo = requireGtaoInspection(
      renderer.inspect().standardLighting?.ambientOcclusion,
      'GTAO candidate retry linear HDR',
    );
    const candidateRetryLinearTrace = debugHost.clusterWorkFrameTraceForConformance();
    if (candidateRetryLinearTrace === undefined) {
      throw new Error('GTAO candidate retry linear HDR frame trace is missing');
    }
    expect([candidateRetryRaw.width, candidateRetryRaw.height]).toEqual([
      requestedFaultExtent.width,
      requestedFaultExtent.height,
    ]);
    expect([candidateRetryFiltered.width, candidateRetryFiltered.height]).toEqual([
      requestedFaultExtent.width,
      requestedFaultExtent.height,
    ]);
    expect(candidateRetryOutput.metadata.graphGeneration).toBe(candidateRetryAo.graphGeneration);
    expect(candidateRetryRaw.graphGeneration).toBe(candidateRetryAo.graphGeneration);
    expect(candidateRetryFiltered.graphGeneration).toBe(candidateRetryAo.graphGeneration);
    assertCandidateRetryTargetCapture(candidateRetryRaw);
    assertCandidateRetryTargetCapture(candidateRetryFiltered);
    expect(candidateRetryLinearAo.status).toBe('active');
    expect(candidateRetryLinearAo.algorithm).toBe('gtao');
    expect(candidateRetryLinearAo.output.extent).toEqual(requestedFaultExtent);
    expect(candidateRetryLinear.graphGeneration).toBe(candidateRetryLinearAo.graphGeneration);
    expect(candidateRetryLinearTrace).toMatchObject({
      observationFrameId: candidateRetryLinear.frameId,
      graphGeneration: candidateRetryLinear.graphGeneration,
      receipt: {
        publicReceiptFrameId: candidateRetryLinear.frameId,
        deviceGeneration: candidateRetryLinear.deviceGeneration,
        presentation: 'ready',
        completion: 'completed',
      },
    });
    const retryAllocation = renderer.inspect().renderGraphGenerationAllocation;
    expect(retryAllocation?.entries.some((entry) => entry.generation === candidateGeneration)).toBe(
      false,
    );
    expect(retryAllocation?.pendingRetirementBytes).toBe(0);
    expect(errors).toEqual([]);
    expect(verifiedCandidateFailure.event).toMatchObject({
      code: 'graph-build-failed',
      detail: {
        cause: {
          code: 'gtao-candidate-preparation-fault-injected',
          detail: {
            phase: 'post-allocation-before-promotion',
            candidateGeneration,
            deviceGeneration: verifiedCandidateFailure.snapshot.inspection.frame.deviceGeneration,
          },
        },
      },
    });
    expect(verifiedCandidateFailure.snapshot.error).toEqual(verifiedCandidateFailure.evidence);

    const preStructural = candidateRetryAo.graphGeneration;
    world.set(camera, AmbientOcclusion, { resolutionScale: 1 }).unwrap();
    clusterWorkPhase = 'ao-structural-resolution';
    await capture();
    const fullResolutionInspection = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(clusterWorkObservations.at(-1)?.observation).toMatchObject({
      status: 'captured',
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });
    expect(fullResolutionInspection?.graphGeneration).not.toBe(preStructural);
    expect(fullResolutionInspection?.output.extent).toEqual({ width, height });
    const fullResolutionRaw = await captureTarget('ssao-raw');
    expect([fullResolutionRaw.width, fullResolutionRaw.height]).toEqual([width, height]);
    expect(fullResolutionRaw.textureIdentity).not.toBe(computeRaw.textureIdentity);

    debugHost.setGtaoExecutionOverrideForConformance(undefined);
    world
      .set(camera, AmbientOcclusion, {
        algorithm: AMBIENT_OCCLUSION_SSAO,
        quality: AMBIENT_OCCLUSION_QUALITY_MEDIUM,
        resolutionScale: FORWARD_GTAO_FIXTURE.resolutionScale,
      })
      .unwrap();
    await capture();
    const ssaoTransitionInspection = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(ssaoTransitionInspection?.algorithm).toBe('ssao');
    expect(ssaoTransitionInspection?.numerical.quality).toBe('medium');
    expect(renderer.inspect().output.graphPassNames).toEqual(
      expect.arrayContaining(['ssao-calc', 'ssao-blur', 'main']),
    );
    const ssaoTransitionRaw = await captureTarget('ssao-raw');
    debugHost.setGtaoExecutionOverrideForConformance('compute');
    world
      .set(camera, AmbientOcclusion, {
        algorithm: AMBIENT_OCCLUSION_GTAO,
        quality: AMBIENT_OCCLUSION_QUALITY_HIGH,
        resolutionScale: FORWARD_GTAO_FIXTURE.resolutionScale,
      })
      .unwrap();
    await capture();
    const restoredGtaoInspection = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(restoredGtaoInspection?.algorithm).toBe('gtao');
    expect(restoredGtaoInspection?.numerical.quality).toBe('high');
    expect(restoredGtaoInspection?.execution).toBe('compute');
    expect(renderer.inspect().output.graphPassNames).toContain('gtao-calc-compute');

    clusterWorkPhase = 'ao-disabled';
    world.removeComponent(camera, AmbientOcclusion).unwrap();
    await capture();
    expect(renderer.inspect().standardLighting?.ambientOcclusion.status).toBe('off');
    expect(clusterWorkObservations.at(-1)?.observation).toMatchObject({
      status: 'captured',
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });
    expect(renderer.inspect().output.graphPassNames).not.toContain('ssao-calc');
    expect(renderer.inspect().output.graphPassNames).not.toContain('gtao-calc-compute');
    expect(debugHost.getCurrentGraphTarget('ssao-raw')).toBeUndefined();
    expect(debugHost.getCurrentGraphTarget('ssao-blurred')).toBeUndefined();

    const orthographicCamera = createForwardGtaoOrthographicCamera(world);
    clusterWorkPhase = 'ao-recovery';
    world
      .addComponent(orthographicCamera, {
        component: AmbientOcclusion,
        data: {
          algorithm: AMBIENT_OCCLUSION_GTAO,
          directLightingStrength: 0,
          radius: FORWARD_GTAO_FIXTURE.radius,
          bias: FORWARD_GTAO_FIXTURE.bias,
          intensity: FORWARD_GTAO_FIXTURE.intensity,
          thickness: FORWARD_GTAO_FIXTURE.thickness,
          distanceExponent: FORWARD_GTAO_FIXTURE.distanceExponent,
          distanceFallOff: FORWARD_GTAO_FIXTURE.distanceFallOff,
          resolutionScale: 1,
          quality: AMBIENT_OCCLUSION_QUALITY_HIGH,
        },
      })
      .unwrap();
    debugHost.setGtaoExecutionOverrideForConformance('fragment');
    const orthographicOutput = await capture(orthographicCamera);
    expectClusterWorkPhase(clusterWorkObservations, 'ao-recovery', {
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });
    const orthographicInspection = requireGtaoInspection(
      renderer.inspect().standardLighting?.ambientOcclusion,
      'orthographic',
    );
    expect(orthographicInspection.status).toBe('active');
    expect(orthographicInspection?.execution).toBe('fragment');
    expect(orthographicInspection?.input.extent).toEqual({ width, height });
    expect(orthographicInspection?.output.extent).toEqual({ width, height });
    const orthographicNormal = await captureTarget(
      'standard-scene-surface-normal',
      orthographicCamera,
    );
    const orthographicRaw = await captureTarget('ssao-raw', orthographicCamera);
    const orthographicFiltered = await captureTarget('ssao-blurred', orthographicCamera);
    const orthographicLinear = await captureLinear(orthographicCamera);
    const orthographicField = createForwardGtaoOrthographicReferenceField(width, height);
    const orthographicRawReference = computeGtaoRawReference(orthographicField, {
      outputWidth: orthographicRaw.width,
      outputHeight: orthographicRaw.height,
      radius: orthographicInspection.numerical.radius,
      bias: orthographicInspection.numerical.bias,
      intensity: orthographicInspection.numerical.intensity,
      thickness: orthographicInspection.numerical.thickness,
      distanceExponent: orthographicInspection.numerical.distanceExponent,
      distanceFallOff: orthographicInspection.numerical.distanceFallOff,
      sampleBudget: orthographicInspection.numerical.sampleBudget,
    });
    const orthographicFilteredReference = filterGtaoReference(
      orthographicField,
      orthographicRawReference,
      orthographicInspection.numerical.radius,
    );
    const orthographicRawMetrics = byteErrorMetrics(
      orthographicRaw.bytes,
      orthographicRawReference.rgba,
    );
    const orthographicFilterMetrics = byteErrorMetrics(
      orthographicFiltered.bytes,
      orthographicFilteredReference,
    );
    const orthographicNormalMetrics = materialNormalFieldMetrics(
      orthographicField,
      orthographicNormal.bytes,
    );
    expect(orthographicRawMetrics.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
    );
    expect(orthographicRawMetrics.rms).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError,
    );
    expect(orthographicFilterMetrics.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.filteredVisibilityMaxByteError,
    );
    expect(orthographicFilterMetrics.rms).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.filteredVisibilityRmsByteError,
    );
    expect(orthographicNormalMetrics.firstMismatch).toBeUndefined();

    const beforeResize = orthographicRaw;
    canvas.width = width + 2;
    canvas.height = height + 2;
    const resizedOutput = await capture(orthographicCamera);
    const resizedRaw = await captureTarget('ssao-raw', orthographicCamera);
    expect([resizedOutput.metadata.width, resizedOutput.metadata.height]).toEqual([
      width + 2,
      height + 2,
    ]);
    expect([resizedRaw.width, resizedRaw.height]).toEqual([width + 2, height + 2]);
    expect(resizedRaw.graphGeneration).not.toBe(beforeResize.graphGeneration);
    expect(resizedRaw.textureIdentity).not.toBe(beforeResize.textureIdentity);

    world.removeComponent(orthographicCamera, AmbientOcclusion).unwrap();
    await capture(orthographicCamera);
    expect(renderer.inspect().standardLighting?.ambientOcclusion.status).toBe('off');
    expect(renderer.inspect().output.graphPassNames).not.toContain('ssao-calc');
    expect(renderer.inspect().output.graphPassNames).not.toContain('gtao-calc-fragment');
    expect(debugHost.getCurrentGraphTarget('ssao-raw')).toBeUndefined();
    world
      .addComponent(orthographicCamera, {
        component: AmbientOcclusion,
        data: {
          algorithm: AMBIENT_OCCLUSION_GTAO,
          directLightingStrength: 0,
          radius: FORWARD_GTAO_FIXTURE.radius,
          bias: FORWARD_GTAO_FIXTURE.bias,
          intensity: FORWARD_GTAO_FIXTURE.intensity,
          thickness: FORWARD_GTAO_FIXTURE.thickness,
          distanceExponent: FORWARD_GTAO_FIXTURE.distanceExponent,
          distanceFallOff: FORWARD_GTAO_FIXTURE.distanceFallOff,
          resolutionScale: 1,
          quality: AMBIENT_OCCLUSION_QUALITY_HIGH,
        },
      })
      .unwrap();
    await capture(orthographicCamera);
    const recoveredRaw = await captureTarget('ssao-raw', orthographicCamera);
    const rigidAoBeforeMorph = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(rigidAoBeforeMorph?.status).toBe('active');
    expect(rigidAoBeforeMorph?.algorithm).toBe('gtao');
    expect(rigidAoBeforeMorph?.execution).toBe('fragment');
    expect(recoveredRaw.graphGeneration).not.toBe(beforeResize.graphGeneration);

    const morphSource = createBoxGeometry(0.5, 0.8, 0.2).unwrap();
    const morphPositions = morphSource.attributes.position as Float32Array;
    const morphDelta = new Float32Array(morphPositions.length);
    for (let vertex = 0; vertex < morphPositions.length; vertex += 3) {
      if ((morphPositions[vertex] ?? 0) > 0) morphDelta[vertex] = 0.75;
    }
    const morphMesh = assets
      .create({ ...morphSource, morphTargets: [{ position: morphDelta }] })
      .unwrap();
    const morphEntity = world
      .spawn(
        { component: Transform, data: { pos: [0.95, 0, -3.9] } },
        { component: MeshFilter, data: { assetHandle: morphMesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world
      .addComponent(morphEntity, {
        component: MorphWeights,
        data: { weights: new Float32Array([0]) },
      })
      .unwrap();
    clusterWorkPhase = 'morph-neutral';
    expect(errors).toEqual([]);
    const neutralMorphRaw = await captureTarget('ssao-raw', orthographicCamera);
    const neutralMorphFrame = renderer.inspect();
    const neutralMorphInspection = requireGtaoInspection(
      neutralMorphFrame.standardLighting?.ambientOcclusion,
      'Neutral MorphWeights baseline',
    );
    expect(neutralMorphInspection.status).toBe('active');
    expect(neutralMorphInspection.algorithm).toBe('gtao');
    expect(neutralMorphInspection.execution).toBe('fragment');
    expect(surfaceDataConsumer.latestPlan()).toBeUndefined();
    expect(neutralMorphFrame.perFramePassNames).not.toContain('surface-normal-depth-consumer');
    expect([neutralMorphRaw.width, neutralMorphRaw.height]).toEqual([canvas.width, canvas.height]);
    expect(neutralMorphFrame.frame.frameId).toBe(neutralMorphRaw.publicReceiptFrameId);
    expect(errors).toEqual([]);

    const acceptedNeutralFrameId = neutralMorphFrame.frame.frameId;
    const acceptedNeutralTrace = requirePresent(
      debugHost.clusterWorkFrameTraceForConformance(),
      'Neutral MorphWeights readback has no completed frame trace before weighted Morph acceptance',
    );
    const acceptedNeutralReceiptEvidence = failureReceipt;
    const acceptedNeutralReadbackEvidence = failureReadback;
    const acceptedNeutralReadbackSha256 = await sha256Hex(neutralMorphRaw.bytes);
    const acceptedRawTarget = requirePresent(
      debugHost.getCurrentGraphTarget('ssao-raw'),
      'Neutral MorphWeights readback has no current raw target',
    );
    expect(acceptedNeutralFrameId).toBe(neutralMorphRaw.publicReceiptFrameId);
    expect(neutralMorphRaw.publicReceiptFrameId).toBeGreaterThan(recoveredRaw.publicReceiptFrameId);
    expect(neutralMorphRaw.graphGeneration).toBe(neutralMorphInspection.graphGeneration);
    expect(neutralMorphRaw.frameTrace).toEqual(acceptedNeutralTrace);
    expect(acceptedNeutralTrace).toMatchObject({
      recordStatus: 'submitted',
      recordFrameNumber: neutralMorphRaw.targetRecordFrameNumber,
      observationFrameId: neutralMorphRaw.publicReceiptFrameId,
      graphGeneration: neutralMorphRaw.graphGeneration,
      receipt: {
        publicReceiptFrameId: neutralMorphRaw.publicReceiptFrameId,
        deviceGeneration: neutralMorphRaw.deviceGeneration,
        presentation: 'ready',
        completion: 'completed',
      },
      graphTargetCopy: {
        targetName: 'ssao-raw',
        recordFrameNumber: neutralMorphRaw.targetRecordFrameNumber,
        expectedIdentity: {
          graphGeneration: neutralMorphRaw.graphGeneration,
          recordFrameNumber: neutralMorphRaw.targetRecordFrameNumber,
          textureIdentity: neutralMorphRaw.textureIdentity,
        },
        actualIdentity: {
          graphGeneration: neutralMorphRaw.graphGeneration,
          recordFrameNumber: neutralMorphRaw.targetRecordFrameNumber,
          textureIdentity: neutralMorphRaw.textureIdentity,
        },
        encoded: true,
      },
    });
    expect(acceptedRawTarget).toMatchObject({
      recordFrameNumber: neutralMorphRaw.targetRecordFrameNumber,
      graphGeneration: neutralMorphRaw.graphGeneration,
      textureIdentity: neutralMorphRaw.textureIdentity,
      descriptor: {
        format: neutralMorphRaw.format,
        size: { width: neutralMorphRaw.width, height: neutralMorphRaw.height },
        usage: neutralMorphRaw.usage,
        sample: neutralMorphRaw.sample,
      },
    });
    expect(neutralMorphRaw.preparation).toMatchObject({
      recordFrameNumber: neutralMorphRaw.targetRecordFrameNumber - 1,
      deviceGeneration: neutralMorphRaw.deviceGeneration,
      graphGeneration: neutralMorphRaw.graphGeneration,
      textureIdentity: neutralMorphRaw.textureIdentity,
      descriptor: {
        format: neutralMorphRaw.format,
        size: { width: neutralMorphRaw.width, height: neutralMorphRaw.height },
        usage: neutralMorphRaw.usage,
        sample: neutralMorphRaw.sample,
      },
    });
    expect(acceptedNeutralReceiptEvidence).toMatchObject({
      publicReceiptFrameId: neutralMorphRaw.publicReceiptFrameId,
      recordFrameNumber: neutralMorphRaw.targetRecordFrameNumber,
      deviceGeneration: neutralMorphRaw.deviceGeneration,
      graphGeneration: neutralMorphRaw.graphGeneration,
      textureIdentity: neutralMorphRaw.textureIdentity,
      presentation: 'ready',
    });
    expect(acceptedNeutralReadbackEvidence).toMatchObject({
      target: 'ssao-raw',
      width: neutralMorphRaw.width,
      height: neutralMorphRaw.height,
      sha256: acceptedNeutralReadbackSha256,
    });
    // Valid Morph now publishes the deformed AO surface. Keep the negative
    // boundary below with a published custom program that has no Standard AO surface.
    world.set(morphEntity, MorphWeights, { weights: new Float32Array([1]) }).unwrap();
    clusterWorkPhase = 'morph-weighted';
    const weightedMorphRaw = await captureTarget('ssao-raw', orthographicCamera);
    expect(weightedMorphRaw.publicReceiptFrameId).toBeGreaterThan(acceptedNeutralFrameId);
    expect(
      weightedMorphRaw.bytes.some((byte, index) => byte !== neutralMorphRaw.bytes[index]),
    ).toBe(true);
    expect(weightedMorphRaw.frameTrace.receipt).toMatchObject({
      presentation: 'ready',
      completion: 'completed',
    });
    const weightedMorphInspection = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(weightedMorphInspection).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
      execution: 'fragment',
    });
    expect(errors).toEqual([]);
    const acceptedWeightedReceiptEvidence = failureReceipt;
    const acceptedWeightedReadbackEvidence = failureReadback;
    const acceptedWeightedTrace = requirePresent(
      debugHost.clusterWorkFrameTraceForConformance(),
      'Weighted Morph has no completed frame trace',
    );
    assets.configurePackIndex('/__material-programs/pack-index.json');
    const unsupportedMorphMaterial = value(
      await assets.load(assets.parseGuid('8f50ae65-6e0a-40b4-8949-b47006edab90'), 'material'),
    );
    world.set(morphEntity, MeshRenderer, { materials: [unsupportedMorphMaterial] }).unwrap();
    const acceptedClusterObservationCount = clusterWorkObservations.length;
    const acceptedSurfaceReceiptCount = surfaceConsumerReceipts.length;

    world.set(morphEntity, MorphWeights, { weights: new Float32Array([1]) }).unwrap();
    clusterWorkPhase = 'morph-unsupported-program';
    failureReceipt = acceptedWeightedReceiptEvidence;
    failureReadback = acceptedWeightedReadbackEvidence;
    const weightedRejection = await captureMorphCoverageRejection({
      draw: () => draw(orthographicCamera),
      errors,
      weights: 1,
      entityKey: Number(morphEntity),
      materialHandle: Number(unsupportedMorphMaterial),
    });
    expectMorphFailurePreservesAcceptedFrame({
      acceptedFrameId: weightedMorphRaw.publicReceiptFrameId,
      currentFrameId: renderer.inspect().frame.frameId,
      acceptedReceipt: acceptedWeightedReceiptEvidence,
      failureReceipt,
      acceptedTrace: acceptedWeightedTrace,
      failureFrameTrace,
      acceptedReadback: acceptedWeightedReadbackEvidence,
      failureReadback,
    });
    expect(surfaceDataConsumer.latestPlan()).toBeUndefined();
    expect(clusterWorkObservations).toHaveLength(acceptedClusterObservationCount);
    expect(surfaceConsumerReceipts).toHaveLength(acceptedSurfaceReceiptCount);
    expect(clusterWorkObservations.some((row) => row.phase === 'morph-unsupported-program')).toBe(
      false,
    );
    expect(errors).toEqual([]);
    const weightedFailureBoundary = Object.freeze({
      receipt: failureReceipt,
      frameTrace: failureFrameTrace,
      readback: failureReadback,
    });

    const morphAfterRejectionInspection = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(morphAfterRejectionInspection).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
      execution: 'fragment',
      graphGeneration: weightedMorphRaw.graphGeneration,
    });

    world.set(morphEntity, MeshRenderer, { materials: [material] }).unwrap();
    world.removeComponent(morphEntity, MorphWeights).unwrap();
    clusterWorkPhase = 'morph-recovery';
    const morphRecoveredRaw = await captureTarget('ssao-raw', orthographicCamera);
    const morphRecoveryFrame = renderer.inspect();
    const morphRecoveryReceiptEvidence = failureReceipt;
    const morphRecoveryReadbackEvidence = failureReadback;
    const morphRecoveryInspection = requireGtaoInspection(
      morphRecoveryFrame.standardLighting?.ambientOcclusion,
      'Morph removal recovery',
    );
    const morphRecoveryTarget = requirePresent(
      debugHost.getCurrentGraphTarget('ssao-raw'),
      'Rigid AO recovery has no current raw target',
    );
    expect(morphRecoveryInspection.status).toBe('active');
    expect(morphRecoveryInspection.algorithm).toBe('gtao');
    expect(morphRecoveryInspection.execution).toBe('fragment');
    expect([morphRecoveredRaw.width, morphRecoveredRaw.height]).toEqual([
      canvas.width,
      canvas.height,
    ]);
    expect(morphRecoveryFrame.frame.frameId).toBe(morphRecoveredRaw.publicReceiptFrameId);
    expect(morphRecoveredRaw.publicReceiptFrameId).toBeGreaterThan(acceptedNeutralFrameId);
    expect(morphRecoveredRaw.graphGeneration).toBe(morphRecoveryInspection.graphGeneration);
    expect(morphRecoveryTarget).toMatchObject({
      recordFrameNumber: morphRecoveredRaw.targetRecordFrameNumber,
      graphGeneration: morphRecoveredRaw.graphGeneration,
      textureIdentity: morphRecoveredRaw.textureIdentity,
      descriptor: {
        format: morphRecoveredRaw.format,
        size: { width: morphRecoveredRaw.width, height: morphRecoveredRaw.height },
        usage: morphRecoveredRaw.usage,
        sample: morphRecoveredRaw.sample,
      },
    });
    expect(morphRecoveredRaw.frameTrace).toMatchObject({
      recordStatus: 'submitted',
      recordFrameNumber: morphRecoveredRaw.targetRecordFrameNumber,
      graphGeneration: morphRecoveredRaw.graphGeneration,
      observationFrameId: morphRecoveredRaw.publicReceiptFrameId,
      receipt: {
        publicReceiptFrameId: morphRecoveredRaw.publicReceiptFrameId,
        deviceGeneration: morphRecoveredRaw.deviceGeneration,
        presentation: 'ready',
        completion: 'completed',
      },
      graphTargetCopy: {
        targetName: 'ssao-raw',
        recordFrameNumber: morphRecoveredRaw.targetRecordFrameNumber,
        expectedIdentity: {
          graphGeneration: morphRecoveredRaw.graphGeneration,
          recordFrameNumber: morphRecoveredRaw.targetRecordFrameNumber,
          textureIdentity: morphRecoveredRaw.textureIdentity,
        },
        actualIdentity: {
          graphGeneration: morphRecoveredRaw.graphGeneration,
          recordFrameNumber: morphRecoveredRaw.targetRecordFrameNumber,
          textureIdentity: morphRecoveredRaw.textureIdentity,
        },
        encoded: true,
      },
    });
    expect(morphRecoveredRaw.graphGeneration).toBe(morphRecoveryInspection.graphGeneration);
    expect(morphRecoveredRaw.preparation).toMatchObject({
      recordFrameNumber: morphRecoveredRaw.targetRecordFrameNumber - 1,
      deviceGeneration: morphRecoveredRaw.deviceGeneration,
      graphGeneration: morphRecoveredRaw.graphGeneration,
      textureIdentity: morphRecoveredRaw.textureIdentity,
      descriptor: {
        format: morphRecoveredRaw.format,
        size: { width: morphRecoveredRaw.width, height: morphRecoveredRaw.height },
        usage: morphRecoveredRaw.usage,
        sample: morphRecoveredRaw.sample,
      },
    });
    expect(surfaceDataConsumer.latestPlan()).toBeUndefined();
    expect(surfaceConsumerReceipts).toHaveLength(acceptedSurfaceReceiptCount);
    expect(morphRecoveryFrame.perFramePassNames).not.toContain('surface-normal-depth-consumer');
    expectClusterWorkPhase(clusterWorkObservations, 'morph-recovery', {
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });
    const morphRecoveredRawSha256 = await sha256Hex(morphRecoveredRaw.bytes);
    expect(morphRecoveryReceiptEvidence).toMatchObject({
      publicReceiptFrameId: morphRecoveredRaw.publicReceiptFrameId,
      recordFrameNumber: morphRecoveredRaw.targetRecordFrameNumber,
      deviceGeneration: morphRecoveredRaw.deviceGeneration,
      graphGeneration: morphRecoveredRaw.graphGeneration,
      textureIdentity: morphRecoveredRaw.textureIdentity,
      presentation: 'ready',
    });
    expect(morphRecoveryReadbackEvidence).toMatchObject({
      target: 'ssao-raw',
      width: morphRecoveredRaw.width,
      height: morphRecoveredRaw.height,
      sha256: morphRecoveredRawSha256,
    });
    const morphEvidence = {
      mesh: { extent: [0.5, 0.8, 0.2], target: morphDelta, weights: [0, 1] },
      neutralBaseline: {
        name: neutralMorphRaw.name,
        morphWeights: [0],
        publicReceiptFrameId: neutralMorphRaw.publicReceiptFrameId,
        graphGeneration: neutralMorphRaw.graphGeneration,
        deviceGeneration: neutralMorphRaw.deviceGeneration,
        recordFrameNumber: neutralMorphRaw.targetRecordFrameNumber,
        textureIdentity: neutralMorphRaw.textureIdentity,
        descriptor: acceptedRawTarget.descriptor,
        frameTrace: acceptedNeutralTrace,
        rawSha256: acceptedNeutralReadbackSha256,
      },
      weightedAccepted: {
        publicReceiptFrameId: weightedMorphRaw.publicReceiptFrameId,
        frameTrace: weightedMorphRaw.frameTrace,
        sha256: await sha256Hex(weightedMorphRaw.bytes),
      },
      rejections: [
        {
          ...weightedRejection,
          unsupportedCustomProgram: true,
          failureBoundary: weightedFailureBoundary,
        },
      ],
      recoveredRaw: {
        name: morphRecoveredRaw.name,
        publicReceiptFrameId: morphRecoveredRaw.publicReceiptFrameId,
        graphGeneration: morphRecoveredRaw.graphGeneration,
        deviceGeneration: morphRecoveredRaw.deviceGeneration,
        recordFrameNumber: morphRecoveredRaw.targetRecordFrameNumber,
        textureIdentity: morphRecoveredRaw.textureIdentity,
        descriptor: morphRecoveryTarget.descriptor,
        receipt: morphRecoveryReceiptEvidence,
        frameTrace: morphRecoveredRaw.frameTrace,
        sha256: morphRecoveredRawSha256,
      },
    };

    world.set(pointLight, PointLight, { intensity: 9, range: 12 }).unwrap();
    clusterWorkPhase = 'tape-light-value-change';
    const capturePending = recorder.captureFrame();
    value(await recorder.frameBoundary());
    const tapeReceipt = await draw(camera);
    value(await recorder.frameBoundary());
    const encodedTape = value(await capturePending);
    const decodedTape = value(decodeTape(encodedTape.bytes));
    const tapeModel = buildFrameModel(decodedTape);
    const capturedStandardSource = recordedStandardMainFragmentSource(tapeModel);
    const selectedMaterialLineage = resolveForwardGtaoMaterialLineage(
      hostAssembly.assets.shaderRegistry,
      selectedMaterial,
      capturedStandardSource,
    );
    const selectedMaterialSourceSha256 = await sha256Hex(
      new TextEncoder().encode(capturedStandardSource),
    );
    await commands.writeFile(
      normalEvidencePath,
      JSON.stringify(
        {
          ...normalEvidence,
          selectedShaderPublication: {
            status: 'resolved-from-captured-main-work',
            ...selectedMaterialLineage,
            capturedSourceSha256: selectedMaterialSourceSha256,
            capturedWorkIndex: tapeModel.works.find(
              (work) =>
                work.pipeline.status === 'available' &&
                work.pipeline.shaders.some(
                  (shader) =>
                    shader.stage === 'fragment' && shader.source === capturedStandardSource,
                ),
            )?.workIndex,
            tapeDigest: encodedTape.digest,
            tapeByteLength: encodedTape.byteLength,
            tapeReceiptFrameId: tapeReceipt.frameId,
          },
        },
        null,
        2,
      ),
    );
    const recordedOwnerWrite = recordedClusterOwnerWrite(decodedTape, tapeModel, 'storage-buffer');
    const tapeClusterObservation = clusterWorkObservations.at(-1)?.observation;
    expect(tapeClusterObservation).toMatchObject({
      status: 'captured',
      invocations: 1,
      transport: 'storage-buffer',
      scope: 'light-data-buffer',
      packedLightSlots: 1,
      writeSucceeded: true,
    });
    if (tapeClusterObservation?.status !== 'captured') {
      throw new Error('missing captured storage-buffer Cluster observation');
    }
    expect(tapeClusterObservation.frameNumber).toBe(
      clusterWorkObservations.at(-1)?.recordFrameNumber,
    );
    expect(clusterWorkObservations.at(-1)?.receiptFrameId).toBe(tapeReceipt.frameId);
    expect(recordedOwnerWrite.bytes).toBe(tapeClusterObservation.acceptedWriteBytes);
    expect(recordedOwnerWrite.bytes).toBeGreaterThan(0);
    expect(recordedOwnerWrite.calls).toBeGreaterThan(0);
    await commands.writeFile(
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgpu-cluster-cost-rhi-diagnostic-20261101-4b7499c.rhitape',
      base64Bytes(encodedTape.bytes),
      'base64',
    );
    world.set(pointLight, PointLight, { intensity: 8, range: 12 }).unwrap();

    const profileResult = profilerSession.finish();
    if (!profileResult.ok) throw profileResult.error;
    const profile = profileResult.value;
    const outputArtifact = async (capture: {
      readonly bytes: Uint8Array;
      readonly frameId?: number;
      readonly targetRecordFrameNumber?: number;
      readonly publicReceiptFrameId?: number;
      readonly graphGeneration?: number;
      readonly textureIdentity?: number;
      readonly readbackIdentity?: number;
      readonly width?: number;
      readonly height?: number;
      readonly format?: string;
    }) => ({
      format: capture.format,
      width: capture.width,
      height: capture.height,
      frameId: capture.frameId,
      targetRecordFrameNumber: capture.targetRecordFrameNumber,
      publicReceiptFrameId: capture.publicReceiptFrameId ?? capture.frameId,
      graphGeneration: capture.graphGeneration,
      textureIdentity: capture.textureIdentity,
      readbackIdentity: capture.readbackIdentity,
      byteLength: capture.bytes.byteLength,
      sha256: await sha256Hex(capture.bytes),
      base64: base64Bytes(capture.bytes),
    });
    const report = {
      schema: 'forgeax::forward-gtao-conformance::1',
      backend: 'webgpu',
      fixture: FORWARD_GTAO_FIXTURE,
      manifestIdentity,
      inputIdentity,
      selectedMaterialLineage: {
        ...selectedMaterialLineage,
        capturedSourceSha256: selectedMaterialSourceSha256,
      },
      frozenBudget: GTAO_COMPARISON_BUDGET,
      inspections: {
        off: noAoInspection,
        fragment: fragmentInspection,
        compute: computeInspection,
        directStrength1: directStrengthInspection,
        aoPreparationFailures,
        recoveredAfterAoFailure,
        afterMorphRejection: morphAfterRejectionInspection,
        fullResolution: fullResolutionInspection,
        ssaoTransition: ssaoTransitionInspection,
        restoredGtao: restoredGtaoInspection,
        orthographic: orthographicInspection,
      },
      passNames: renderer.inspect().output.graphPassNames,
      metrics: {
        rawVisibilityErrors,
        rawNormalErrors,
        filteredErrors,
        fragmentRawVsCompute,
        fragmentFilterVsCompute,
        fragmentLinearVsCompute,
        normalErrors,
        ao0,
        ao1,
        morphRejections: morphEvidence.rejections.map(({ weights, missingContributorId }) => ({
          weights,
          missingContributorId,
        })),
      },
      contactPixel: { x: contactX, y: contactY, screenVisibility: contactVisibility },
      morph: {
        meshExtent: morphEvidence.mesh.extent,
        targetPositionComponents: morphEvidence.mesh.target.length,
        weights: morphEvidence.mesh.weights,
        neutralBaseline: morphEvidence.neutralBaseline,
        weightedAccepted: morphEvidence.weightedAccepted,
        rejections: morphEvidence.rejections,
        recoveredRaw: morphEvidence.recoveredRaw,
      },
      cost: {
        completedFrameWallMs,
        completedFrameMeasurement: 'world-update+renderer.draw+receipt.completed',
        totalWallMs: performance.now() - workloadStartedAt,
        profiler: { completeness: profile.completeness, records: profile.records },
        gpuTimings: computeLinear.gpuTimings,
        clusterWorkObservations,
        recordedClusterWrite: {
          digest: encodedTape.digest,
          byteLength: encodedTape.byteLength,
          frameId: tapeReceipt.frameId,
          ownerWrites: recordedOwnerWrite,
          summary: summarizeFrame(tapeModel),
        },
      },
      captures: {
        noAoLinear: await outputArtifact(noAoLinear),
        emissiveOnly: await outputArtifact(emissiveOnly),
        indirectOnly: await outputArtifact(indirectOnly),
        directOnly: await outputArtifact(directOnly),
        fragment: {
          normal: await outputArtifact(fragmentNormal),
          raw: await outputArtifact(fragmentRaw),
          filtered: await outputArtifact(fragmentBlurred),
          linearHdr: await outputArtifact(fragmentLinear),
        },
        compute: {
          normal: await outputArtifact(computeNormal),
          raw: await outputArtifact(computeRaw),
          filtered: await outputArtifact(computeBlurred),
          linearHdr: await outputArtifact(computeLinear),
        },
        directStrength1: {
          linearHdr: await outputArtifact(directAoLinear),
          finalDisplay: await outputArtifact({
            bytes: directAoOutput.bytes,
            width: directAoOutput.metadata.width,
            height: directAoOutput.metadata.height,
            format: directAoOutput.metadata.format,
            frameId: directAoOutput.metadata.frameId,
            readbackIdentity: directAoOutput.metadata.readbackIdentity,
            graphGeneration: directAoOutput.metadata.graphGeneration,
            textureIdentity: directAoOutput.metadata.textureIdentity,
          }),
        },
        fullResolutionRaw: await outputArtifact(fullResolutionRaw),
        ssaoTransitionRaw: await outputArtifact(ssaoTransitionRaw),
        orthographic: {
          finalDisplay: await outputArtifact({
            bytes: orthographicOutput.bytes,
            width: orthographicOutput.metadata.width,
            height: orthographicOutput.metadata.height,
            format: orthographicOutput.metadata.format,
            frameId: orthographicOutput.metadata.frameId,
            readbackIdentity: orthographicOutput.metadata.readbackIdentity,
            graphGeneration: orthographicOutput.metadata.graphGeneration,
            textureIdentity: orthographicOutput.metadata.textureIdentity,
          }),
          linearHdr: await outputArtifact(orthographicLinear),
          normal: await outputArtifact(orthographicNormal),
          raw: await outputArtifact(orthographicRaw),
          filtered: await outputArtifact(orthographicFiltered),
          resizedRaw: await outputArtifact(resizedRaw),
          recoveredRaw: await outputArtifact(recoveredRaw),
          rawReferenceMetrics: orthographicRawMetrics,
          filteredReferenceMetrics: orthographicFilterMetrics,
          normalMetrics: orthographicNormalMetrics,
        },
        morphRecoveryRaw: await outputArtifact(morphRecoveredRaw),
      },
      receipt: {
        frameId: computeLinear.frameId,
        deviceGeneration: computeLinear.deviceGeneration,
        graphGeneration: computeLinear.graphGeneration,
        readbackIdentity: computeLinear.readbackIdentity,
        draws: computeLinear.draws,
      },
      candidateRetryDisplay: candidateRetryDisplaySnapshot,
      errors: errors.map(describeFailure),
    };
    await commands.writeFile(
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgpu-consumer-settlement-conformance-rhi-diagnostic-20261101-4b7499c.json',
      JSON.stringify(report, null, 2),
    );
    expect(errors).toEqual([]);
  } catch (failure) {
    await writeForwardGtaoFailureReport({
      writeFile: commands.writeFile,
      path: 'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgpu-consumer-settlement-failure-rhi-diagnostic-20261101-4b7499c.json',
      failure,
      context: {
        backend: 'webgpu',
        manifestSummary: failureManifestSummary,
        registryArtifacts: {
          sameWorldRegistry: assets.shaderRegistry === hostAssembly.assets.shaderRegistry,
          renderer: await registryArtifactsForErrors(hostAssembly.assets.shaderRegistry, errors),
          world: await registryArtifactsForErrors(assets.shaderRegistry, errors),
        },
        cameraConfig: failureCameraConfig,
        operation: failureOperation,
        receipt: failureReceipt,
        frameTrace: failureFrameTrace,
        readback: failureReadback,
        rendererErrors: errors,
        diagnostics: {
          candidateRetryDisplay: candidateRetryDisplaySnapshot ?? null,
          retainedRecordFrameNumber:
            debugHost.featureGraphTraceForConformance()?.retainedRecordFrameNumber ??
            featureGraphDiagnosticRows.at(-1)?.retainedRecordFrameNumber ??
            null,
          trace: settlementFeatureGraphTrace ?? debugHost.featureGraphTraceForConformance() ?? null,
          snapshots: [...featureGraphDiagnosticRows],
          submittedWork: surfaceDataConsumer.submittedWorkSnapshots(),
        },
      },
    });
    throw failure;
  } finally {
    debugHost.setFeatureGraphTraceForConformance(undefined);
    debugHost.setGtaoExecutionOverrideForConformance(undefined);
    unsubscribe();
    lease.dispose();
    value(await renderer.dispose());
    value(await debugHost.device.destroyBuffer(surfaceObservationBuffer));
    canvas.remove();
  }
});
