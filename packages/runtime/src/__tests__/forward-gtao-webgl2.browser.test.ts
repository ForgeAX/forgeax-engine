import { World } from '@forgeax/engine-ecs';
import { createProfiler } from '@forgeax/engine-profiler';
import {
  AMBIENT_OCCLUSION_GTAO,
  AMBIENT_OCCLUSION_QUALITY_HIGH,
  AMBIENT_OCCLUSION_SSAO,
  AmbientOcclusion,
  type FrameReceipt,
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
  type RecorderAttachment,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-wgpu';
import { propagateTransforms } from '@forgeax/engine-scene';
import { expandShaderManifestPublication } from '@forgeax/engine-shader';
import type { ShaderReflection } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import {
  composeLinearLightingReference,
  computeGtaoRawReference,
  filterGtaoReference,
  GTAO_COMPARISON_BUDGET,
  materialNormalFieldMetrics,
  sampleGtaoBilinearLinearClamp,
} from '../../../render/src/__tests__/gtao-reference';
import { deriveStandardClusterReflectedAbi } from '../../../render/src/light-buffer-layout';
import { SSAO_UNIFORM_INTENSITY_OFFSET } from '../../../render/src/ssao-uniform';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  assertForwardGtaoLinearCaptureJoin,
  base64Bytes,
  byteChannel,
  byteErrorMetrics,
  captureForwardGtaoLinearHdr,
  captureForwardGtaoTarget,
  ForwardGtaoCaptureNotReadyError,
  type ForwardGtaoLinearCapture,
  ForwardGtaoLinearCaptureNotReadyError,
  type ForwardGtaoTargetCapture,
  linearErrorMetrics,
  recordedClusterOwnerWrite,
  rgba16FloatPixel,
  rgba16FloatRgb,
  sha256Hex,
  validateForwardGtaoTargetAttempt,
} from './helpers/forward-gtao-capture';
import {
  describeForwardGtaoFailure,
  writeForwardGtaoFailureReport,
} from './helpers/forward-gtao-failure';
import {
  comparePackedAo,
  decodePackedAoRegion,
  recordedBufferResourceId,
  recordedShaderWorkEventIndex,
  recordedUniformPayload,
} from './helpers/forward-gtao-packed-ao';
import {
  createForwardGtaoReferenceField,
  createForwardGtaoScene,
  FORWARD_GTAO_FIXTURE,
} from './helpers/forward-gtao-scene';

const GPU_TEXTURE_USAGE_COPY_SRC = 0x01;
const GPU_BUFFER_USAGE_MAP_READ = 0x01;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_MAP_MODE_READ = 0x01;
type DebugDrawHost = RendererHostAssembly['debugDrawHost'] &
  Pick<
    RendererLegacyHostAdapter,
    | 'getCurrentGraphTarget'
    | 'requestGraphTargetCapture'
    | 'cancelGraphTargetCapture'
    | 'setClusterWorkObservationForConformance'
    | 'clusterWorkObservationForConformance'
    | 'clusterWorkFrameTraceForConformance'
  >;
type ClusterWorkObservation = NonNullable<
  ReturnType<RendererLegacyHostAdapter['clusterWorkObservationForConformance']>
>;
type CapturedClusterWork = Extract<ClusterWorkObservation, { readonly status: 'captured' }>;
type ClusterWorkFrameTrace = NonNullable<
  ReturnType<DebugDrawHost['clusterWorkFrameTraceForConformance']>
>;
type StandardLightingInspection = ReturnType<
  RendererHostAssembly['renderer']['inspect']
>['standardLighting'];
type ClusterWorkObservationRow = {
  readonly phase: string;
  readonly receiptFrameId: number;
  readonly deviceGeneration: number;
  readonly receiptPresentation: 'ready' | 'pending';
  readonly recordFrameNumber: number;
  readonly observationFrameId: number | undefined;
  readonly observation: ClusterWorkObservation;
  readonly frameTrace: ClusterWorkFrameTrace;
  readonly clusterTarget?: {
    readonly graphGeneration: number;
    readonly recordFrameNumber: number;
    readonly textureIdentity: number;
    readonly descriptor: {
      readonly format: string;
      readonly size: { readonly width: number; readonly height: number };
      readonly usage: number;
      readonly sample: number;
    };
  };
};

type CapturedClusterWorkRow = ClusterWorkObservationRow & {
  readonly observation: CapturedClusterWork;
};
type LinearCaptureEvidence = {
  readonly receipt: ForwardGtaoLinearCapture['receipt'];
  readonly linearAttachment: {
    readonly graphGeneration: number;
    readonly textureIdentity: number;
    readonly readbackIdentity: number;
  };
  readonly frameTrace?: ClusterWorkFrameTrace;
  readonly workRow?: ClusterWorkObservationRow;
  readonly latestObservedWorkRow?: ClusterWorkObservationRow;
  readonly clusterTarget?: ClusterWorkObservationRow['clusterTarget'];
  readonly readback: {
    readonly textureIdentity: number;
    readonly readbackIdentity: number;
    readonly width: number;
    readonly height: number;
    readonly format: string;
    readonly byteLength: number;
    readonly sha256: string;
  };
};

function requireCapturedClusterWorkRow(
  row: ClusterWorkObservationRow | undefined,
): CapturedClusterWorkRow {
  const observation = row?.observation;
  if (row === undefined || observation?.status !== 'captured') {
    throw new Error('missing active AO Cluster transport generation observation');
  }
  return { ...row, observation };
}

function acceptedClusterWriteBytes(observation: ClusterWorkObservation | undefined): number {
  return observation?.status === 'captured' ? observation.acceptedWriteBytes : 0;
}

function requireCapturedClusterWork(
  observation: ClusterWorkObservation | undefined,
  message: string,
): CapturedClusterWork {
  if (observation?.status !== 'captured') throw new Error(message);
  return observation;
}

function expectStableClusterRows(rows: readonly ClusterWorkObservationRow[]): void {
  for (const row of rows) {
    expect(row.observation).toMatchObject({
      status: 'captured',
      invocations: 1,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
      writeSucceeded: true,
    });
  }
}

function expectNoClusterWritesDuringCaptures(rows: readonly ClusterWorkObservationRow[]): void {
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((row) => row.receiptPresentation === 'ready')).toBe(true);
  for (const row of rows) {
    if (row.observation.status === 'captured') {
      expect(row.observation).toMatchObject({
        invocations: 1,
        packedLightSlots: 0,
        acceptedWriteBytes: 0,
        writeSucceeded: true,
      });
    } else {
      expect(row.receiptPresentation).toBe('pending');
      expect(row.observation).toMatchObject({ status: 'unavailable', reason: 'awaiting-write' });
    }
  }
}

async function captureStableWebgl2AoInputs(input: {
  readonly captureTarget: (
    name: 'ssao-raw' | 'ssao-blurred' | 'standard-scene-surface-normal',
  ) => Promise<ForwardGtaoTargetCapture>;
  readonly observations: readonly ClusterWorkObservationRow[];
}) {
  const normalStart = input.observations.length;
  const normalTarget = await input.captureTarget('standard-scene-surface-normal');
  expectNoClusterWritesDuringCaptures(input.observations.slice(normalStart));
  const rawStart = input.observations.length;
  const rawTarget = await input.captureTarget('ssao-raw');
  expectNoClusterWritesDuringCaptures(input.observations.slice(rawStart));
  const blurredStart = input.observations.length;
  const blurredTarget = await input.captureTarget('ssao-blurred');
  expectNoClusterWritesDuringCaptures(input.observations.slice(blurredStart));
  return {
    normalTarget,
    rawTarget,
    rawReceipt: { frameId: rawTarget.publicReceiptFrameId, presentation: 'ready' as const },
    blurredTarget,
    blurredReceipt: {
      frameId: blurredTarget.publicReceiptFrameId,
      presentation: 'ready' as const,
    },
  };
}

function requirePresent<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function expectNoLocalClusterWork(
  lighting: StandardLightingInspection,
  observation: ClusterWorkObservation,
  frameTrace: ClusterWorkFrameTrace,
): void {
  expect(lighting).toMatchObject({
    transport: 'not-required',
    producer: 'none',
    requested: 0,
    admitted: 0,
    shadowed: 0,
    indexCount: 0,
    occupied: 0,
    clusterGridBytes: 0,
    lightIndexListBytes: 0,
    lightDataBytes: 0,
    lightBoundsBytes: 0,
    ambientOcclusion: {
      requested: false,
      status: 'off',
      execution: 'none',
      reason: 'disabled',
      work: { rawPixels: 0, filterTapBudget: 0, depthCandidateBudget: 0 },
      output: { clusterRegionBytes: 0 },
      passes: [],
    },
  });
  expect(observation).toEqual({ status: 'unavailable', reason: 'awaiting-write' });
  expect(frameTrace.clusterWork).toBeUndefined();
}

function assertClusterFrameConformance(input: {
  readonly expectedTransport: 'required' | 'not-required';
  readonly receiptFrameId: number;
  readonly receiptPresentation: 'ready' | 'pending';
  readonly observation: ClusterWorkObservation;
  readonly frameTrace: ClusterWorkFrameTrace;
  readonly standardLighting: () => StandardLightingInspection;
}): void {
  const { observation, frameTrace, receiptFrameId, receiptPresentation } = input;
  if (
    observation.status === 'captured' &&
    observation.frameNumber !== frameTrace.recordFrameNumber
  ) {
    throw new Error(
      `Cluster owner record frame ${observation.frameNumber} does not match trace record frame ${frameTrace.recordFrameNumber}; public receipt ${receiptFrameId}`,
    );
  }
  const pendingBarrier = frameTrace.recordStatus === 'pending';
  if (
    (!pendingBarrier && frameTrace.recordStatus !== 'submitted') ||
    (pendingBarrier && receiptPresentation !== 'pending') ||
    frameTrace.observationFrameId !== receiptFrameId ||
    frameTrace.receipt?.publicReceiptFrameId !== receiptFrameId ||
    frameTrace.receipt?.presentation !== receiptPresentation ||
    frameTrace.receipt?.completion !== 'completed'
  ) {
    throw new Error(
      `RenderSystem attempt trace does not match public receipt ${receiptFrameId}: ${JSON.stringify(frameTrace)}`,
    );
  }
  if (input.expectedTransport === 'not-required') {
    if (pendingBarrier) {
      expect(observation).toEqual({ status: 'unavailable', reason: 'awaiting-write' });
      expect(frameTrace.clusterWork).toBeUndefined();
    } else {
      expectNoLocalClusterWork(input.standardLighting(), observation, frameTrace);
    }
    return;
  }
  if (
    observation.status !== 'captured' &&
    (!pendingBarrier || observation.reason !== 'awaiting-write')
  ) {
    throw new Error(
      `Cluster owner observation is unavailable after non-barrier frame ${receiptFrameId}: ${JSON.stringify({ observation, frameTrace })}`,
    );
  }
}

function expectClusterTransportReplacement(
  rows: readonly ClusterWorkObservationRow[],
  phase: string,
  previous: CapturedClusterWork,
): number {
  const phaseRows = rows.filter((row) => row.phase === phase);
  const capturedRows = phaseRows.filter(
    (row): row is ClusterWorkObservationRow & { readonly observation: CapturedClusterWork } =>
      row.observation.status === 'captured',
  );
  expect(capturedRows.some((row) => row.receiptPresentation === 'ready')).toBe(true);
  const replacementRows = capturedRows.filter(
    (row) => row.observation.clusterTransportGeneration !== previous.clusterTransportGeneration,
  );
  expect(replacementRows.length).toBeGreaterThan(0);
  const generations = new Set(
    replacementRows.map((row) => row.observation.clusterTransportGeneration),
  );
  expect(generations.size).toBe(1);
  const generation = replacementRows[0]?.observation.clusterTransportGeneration;
  if (generation === undefined) throw new Error(`missing ${phase} transport generation`);
  expect(generation).toBeGreaterThan(previous.clusterTransportGeneration);
  const initializations = replacementRows.filter((row) => row.observation.acceptedWriteBytes > 0);
  if (initializations.length !== 1) {
    throw new Error(
      `expected one ${phase} Cluster initialization; phase rows=${JSON.stringify(phaseRows)}`,
    );
  }
  const initialization = initializations[0];
  const expectedUsedRows = previous.clusterUsedRows ?? 0;
  const expectedRowBytes = previous.clusterRowBytes ?? 0;
  const expectedUsedRegionBytes = expectedUsedRows * expectedRowBytes;
  expect(expectedUsedRegionBytes).toBeGreaterThan(0);
  expect(initialization?.observation).toMatchObject({
    invocations: 1,
    packedLightSlots: 1,
    acceptedWriteBytes: expectedUsedRegionBytes,
    writeSucceeded: true,
    clusterTransportGeneration: generation,
    clusterUsedRows: expectedUsedRows,
    clusterRowBytes: expectedRowBytes,
  });
  expect(initialization?.frameTrace.clusterTransportGeneration).toBe(generation);
  const steadyReadyRows = replacementRows.filter(
    (row) =>
      row.receiptPresentation === 'ready' &&
      row.receiptFrameId > (initialization?.receiptFrameId ?? Number.POSITIVE_INFINITY),
  );
  if (steadyReadyRows.length === 0) {
    throw new Error(
      `no completed ready steady Cluster row after ${phase} initialization; phase rows=${JSON.stringify(phaseRows)}`,
    );
  }
  for (const row of steadyReadyRows) {
    if (
      row.observation.invocations !== 1 ||
      row.observation.packedLightSlots !== 0 ||
      row.observation.acceptedWriteBytes !== 0 ||
      !row.observation.writeSucceeded ||
      row.observation.clusterTransportGeneration !== generation ||
      row.observation.clusterUsedRows !== expectedUsedRows ||
      row.observation.clusterRowBytes !== expectedRowBytes
    ) {
      throw new Error(
        `unexpected ${phase} steady Cluster work; phase rows=${JSON.stringify(phaseRows)}`,
      );
    }
  }
  return generation;
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    const failure = result.error;
    const detail =
      failure instanceof Error && 'detail' in failure
        ? JSON.stringify((failure as Error & { readonly detail: unknown }).detail)
        : undefined;
    throw new Error(
      `${failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)}${detail === undefined ? '' : `; detail=${detail}`}`,
      { cause: failure },
    );
  }
  return result.value;
}

const describeFailure = describeForwardGtaoFailure;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    const chunk = bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function prepareClusterCapture(host: DebugDrawHost) {
  const target = host.getCurrentGraphTarget('standard-cluster-tables');
  if (target === undefined) throw new Error('missing graph texture standard-cluster-tables');
  if ((target.descriptor.usage & GPU_TEXTURE_USAGE_COPY_SRC) === 0) {
    throw new Error(
      `Cluster target is not copy-readable before readback: ${JSON.stringify({
        graphGeneration: target.graphGeneration,
        recordFrameNumber: target.recordFrameNumber,
        textureIdentity: target.textureIdentity,
        descriptor: target.descriptor,
      })}`,
    );
  }
  const { width, height } = target.descriptor.size;
  const expectedRecordFrameNumber = target.recordFrameNumber + 1;
  if (!Number.isSafeInteger(expectedRecordFrameNumber)) {
    throw new Error(
      `Cluster target record frame cannot bind next copy attempt: ${target.recordFrameNumber}`,
    );
  }
  const bytesPerRow = Math.ceil((width * 16) / 256) * 256;
  const buffer = value(
    host.device.createBuffer({
      label: 'standard-cluster-tables.browser-readback',
      size: bytesPerRow * height,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    }),
  );
  value(host.device.queue.writeBuffer(buffer, 0, new Uint8Array(16).fill(0xa5)));
  const request = {
    name: 'standard-cluster-tables',
    buffer,
    bytesPerRow,
    width,
    height,
    expected: {
      format: 'rgba32uint',
      width,
      height,
      usage: GPU_TEXTURE_USAGE_COPY_SRC,
      identity: {
        graphGeneration: target.graphGeneration,
        recordFrameNumber: expectedRecordFrameNumber,
        textureIdentity: target.textureIdentity,
      },
    },
  } as const;
  host.requestGraphTargetCapture(request);
  return { buffer, bytesPerRow, width, height, target, expectedRecordFrameNumber, request };
}

function derivePublishedStandardClusterAbi(manifestBytes: Uint8Array) {
  const expandedManifest = expandShaderManifestPublication(
    JSON.parse(new TextDecoder().decode(manifestBytes)),
  ).manifest as {
    readonly materialShaders?: readonly {
      readonly identifier: string;
      readonly variants: readonly {
        readonly defines: Readonly<Record<string, boolean>>;
        readonly reflection?: ShaderReflection;
      }[];
    }[];
  };
  const standardPbr = expandedManifest.materialShaders?.find(
    (entry) => entry.identifier === 'forgeax::default-standard-pbr',
  );
  if (standardPbr === undefined) throw new Error('published Standard PBR material is missing');
  const reflectedAbi = deriveStandardClusterReflectedAbi(
    standardPbr.variants
      .filter(
        (variant) =>
          variant.defines.CLUSTER_FORWARD_AVAILABLE === true &&
          variant.defines.STORAGE_BUFFER_AVAILABLE === true,
      )
      .map((variant) => variant.reflection),
  );
  if (reflectedAbi === undefined) {
    throw new Error('published Standard PBR variants do not resolve one reflected Cluster ABI');
  }
  return reflectedAbi;
}

async function captureControlledWebgl2Lighting(input: {
  readonly algorithm: typeof AMBIENT_OCCLUSION_GTAO | typeof AMBIENT_OCCLUSION_SSAO;
  readonly world: World;
  readonly skylight: ReturnType<typeof createForwardGtaoScene>['skylight'];
  readonly pointLight: ReturnType<typeof createForwardGtaoScene>['pointLight'];
  readonly beforeLinear: ForwardGtaoLinearCapture;
  readonly captureLinear: (
    clusterTransport?: 'required' | 'not-required',
  ) => Promise<ForwardGtaoLinearCapture>;
  readonly setPhase: (phase: string) => void;
}): Promise<
  | {
      readonly emissiveOnlyLinear: ForwardGtaoLinearCapture;
      readonly indirectOnlyLinear: ForwardGtaoLinearCapture;
      readonly directOnlyLinear: ForwardGtaoLinearCapture;
    }
  | undefined
> {
  if (input.algorithm !== AMBIENT_OCCLUSION_GTAO) return undefined;
  input.world.removeComponent(input.skylight, Skylight).unwrap();
  input.world.removeComponent(input.pointLight, PointLight).unwrap();
  input.setPhase('emissive-only-no-lights');
  const emissiveOnlyLinear = await input.captureLinear('not-required');
  input.world.addComponent(input.skylight, { component: Skylight, data: {} }).unwrap();
  input.setPhase('indirect-only-no-local-lights');
  const indirectOnlyLinear = await input.captureLinear('not-required');
  input.world.removeComponent(input.skylight, Skylight).unwrap();
  input.world
    .addComponent(input.pointLight, {
      component: PointLight,
      data: { intensity: 8, range: 12 },
    })
    .unwrap();
  const directOnlyLinear = await input.captureLinear();
  input.world.addComponent(input.skylight, { component: Skylight, data: {} }).unwrap();
  const restoredNoAoLinear = await input.captureLinear();
  const restoredMetrics = linearErrorMetrics(
    rgba16FloatRgb(input.beforeLinear),
    rgba16FloatRgb(restoredNoAoLinear),
  );
  expect(restoredMetrics.maxAbsolute).toBe(0);
  expect(restoredMetrics.rmsAbsolute).toBe(0);
  return { emissiveOnlyLinear, indirectOnlyLinear, directOnlyLinear };
}

async function readClusterCapture(
  host: DebugDrawHost,
  capture: ReturnType<typeof prepareClusterCapture>,
  receipt: FrameReceipt,
) {
  try {
    const attempt = await validateForwardGtaoTargetAttempt(
      host,
      'standard-cluster-tables',
      capture.target,
      receipt,
      capture.expectedRecordFrameNumber,
    );
    const { target, trace } = attempt;
    await host.device.queue.onSubmittedWorkDone();
    const mapped = value(await capture.buffer.mapAsync(GPU_MAP_MODE_READ));
    const range = value(mapped.getMappedRange());
    const bytes = new Uint8Array(range.slice(0));
    mapped.unmap();
    if (bytes.byteLength !== capture.bytesPerRow * capture.height) {
      throw new Error(
        `Cluster readback byte length mismatch: ${JSON.stringify({
          captured: capture.target,
          actual: target,
          receipt: {
            frameId: receipt.frameId,
            deviceGeneration: receipt.deviceGeneration,
            presentation: receipt.presentation,
          },
          trace,
          actualByteLength: bytes.byteLength,
          expectedByteLength: capture.bytesPerRow * capture.height,
        })}`,
      );
    }
    return {
      bytes,
      byteLength: bytes.byteLength,
      bytesPerRow: capture.bytesPerRow,
      format: target.descriptor.format,
      width: capture.width,
      height: capture.height,
      usage: target.descriptor.usage,
      graphGeneration: target.graphGeneration,
      deviceGeneration: receipt.deviceGeneration,
      textureIdentity: target.textureIdentity,
      targetRecordFrameNumber: target.recordFrameNumber,
      publicReceiptFrameId: receipt.frameId,
      receiptPresentation: 'ready' as const,
      receiptCompleted: true as const,
    };
  } finally {
    host.cancelGraphTargetCapture(capture.request);
    value(await host.device.destroyBuffer(capture.buffer));
  }
}

async function captureWebgl2PackedAoTapeFrame(input: {
  readonly host: DebugDrawHost;
  readonly recorder: RecorderAttachment;
  readonly clusterCapture: ReturnType<typeof prepareClusterCapture>;
  readonly observations: readonly ClusterWorkObservationRow[];
  readonly stimulateLightChange: () => void;
  readonly draw: () => Promise<FrameReceipt>;
}) {
  const pending = input.recorder.captureFrame();
  value(await input.recorder.frameBoundary());
  input.stimulateLightChange();
  const receipt = await input.draw();
  value(await input.recorder.frameBoundary());
  const encoded = value(await pending);
  const tape = value(decodeTape(encoded.bytes));
  const frameModel = buildFrameModel(tape);
  const ownerWrite = recordedClusterOwnerWrite(tape, frameModel, 'cpu-texture');
  const workRow = input.observations.at(-1);
  if (workRow === undefined) throw new Error('missing captured AO/Cluster tape frame row');
  const clusterTarget = workRow.clusterTarget;
  if (clusterTarget === undefined) {
    throw new Error(
      `AO/Cluster tape receipt ${workRow.receiptFrameId} has no Cluster target identity: ${JSON.stringify(workRow)}`,
    );
  }
  const graphGeneration = workRow.frameTrace.graphGeneration;
  if (graphGeneration === undefined) {
    throw new Error(
      `AO/Cluster tape receipt ${workRow.receiptFrameId} has no graph generation: ${JSON.stringify(workRow.frameTrace)}`,
    );
  }
  const clusterReadback = await readClusterCapture(input.host, input.clusterCapture, receipt);
  return {
    receipt,
    encoded,
    tape,
    frameModel,
    ownerWrite,
    workRow,
    clusterTarget,
    graphGeneration,
    clusterReadback,
  };
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

it.each([
  ['SSAO', AMBIENT_OCCLUSION_SSAO],
  ['GTAO', AMBIENT_OCCLUSION_GTAO],
])(
  'runs production Forward %s inputs, filtering, Cluster packing and lighting on WebGL2',
  {
    timeout: 180_000,
  },
  async (_algorithmName, algorithm) => {
    await backend.ensureReady();
    const recorder = value(attachRecorder(backend));
    const width = FORWARD_GTAO_FIXTURE.width;
    const height = FORWARD_GTAO_FIXTURE.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    document.body.append(canvas);
    const profiler = createProfiler();
    const hostAssembly = value(
      await constructRuntimeRendererHost(canvas, {
        rhi: recorder.backend.rhi,
        captureGpuTimings: true,
        profiler,
        rhiInstrumentation: {
          resolveSurfaceDevice(device) {
            const unwrapped = recorder.backend.unwrapDeviceForSurface(device);
            if (!unwrapped.ok) throw unwrapped.error;
            return ok(unwrapped.value);
          },
        },
      }),
    );
    const renderer = hostAssembly.renderer;
    const debugHost = hostAssembly.debugDrawHost as DebugDrawHost;
    const errors: unknown[] = [];
    let failureOperation = 'renderer.setup';
    let failureReceipt: unknown;
    let failureFrameTrace: unknown;
    let failureClusterWorkRow: unknown;
    let failureReadback: unknown;
    let failureComparisonEvidence: unknown;
    let failureManifestSummary: unknown;
    const unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const world = new World({ assets: hostAssembly.assets });
    const { camera, skylight, pointLight } = createForwardGtaoScene(world, width, height);
    expect(debugHost.clusterWorkObservationForConformance()).toBeUndefined();
    debugHost.setClusterWorkObservationForConformance(true);
    expect(debugHost.clusterWorkObservationForConformance()).toEqual({
      status: 'unavailable',
      reason: 'awaiting-write',
    });
    const lease = value(renderer.attach(world));
    const completedFrameWallMs: number[] = [];
    const clusterWorkObservations: ClusterWorkObservationRow[] = [];
    const linearCaptureEvidence = new Map<ForwardGtaoLinearCapture, LinearCaptureEvidence>();
    const evidenceForLinearCapture = (capture: ForwardGtaoLinearCapture): LinearCaptureEvidence => {
      const evidence = linearCaptureEvidence.get(capture);
      if (evidence === undefined) {
        throw new Error(`linear HDR capture ${capture.frameId} has no same-frame evidence`);
      }
      return evidence;
    };
    let clusterWorkPhase = 'cluster-cold';
    const draw = async (clusterTransport: 'required' | 'not-required' = 'required') => {
      failureOperation = 'renderer.draw';
      const startedAt = performance.now();
      propagateTransforms(world).unwrap();
      world.update(1 / 60).unwrap();
      const drawResult = renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
      if (!drawResult.ok) {
        throw new Error(
          `renderer.draw failed: ${JSON.stringify(describeFailure(drawResult.error))}; renderer events: ${JSON.stringify(errors.map(describeFailure))}`,
          { cause: drawResult.error },
        );
      }
      const receipt = drawResult.value;
      failureReceipt = {
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        presentation: receipt.presentation,
      };
      failureOperation = 'receipt.completed';
      value(await receipt.completed);
      if (errors.length > 0) {
        const failure = errors[0];
        if (failure instanceof Error && 'detail' in failure) {
          throw new Error(
            `${failure.name}: ${failure.message}; detail=${JSON.stringify((failure as Error & { readonly detail: unknown }).detail)}`,
            { cause: failure },
          );
        }
        throw failure;
      }
      const clusterObservation = debugHost.clusterWorkObservationForConformance();
      if (clusterObservation === undefined) {
        throw new Error(`Cluster owner observation is disabled after frame ${receipt.frameId}`);
      }
      const frameTrace = debugHost.clusterWorkFrameTraceForConformance();
      failureFrameTrace = frameTrace;
      if (frameTrace === undefined) {
        throw new Error(`Cluster frame trace is disabled after public receipt ${receipt.frameId}`);
      }
      assertClusterFrameConformance({
        expectedTransport: clusterTransport,
        receiptFrameId: receipt.frameId,
        receiptPresentation: receipt.presentation,
        observation: clusterObservation,
        frameTrace,
        standardLighting: () => renderer.inspect().standardLighting,
      });
      const clusterTarget = debugHost.getCurrentGraphTarget('standard-cluster-tables');
      clusterWorkObservations.push({
        phase: clusterWorkPhase,
        receiptFrameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        receiptPresentation: receipt.presentation,
        recordFrameNumber: frameTrace.recordFrameNumber,
        observationFrameId: frameTrace.observationFrameId,
        observation: clusterObservation,
        frameTrace,
        ...(clusterTarget === undefined
          ? {}
          : {
              clusterTarget: {
                graphGeneration: clusterTarget.graphGeneration,
                recordFrameNumber: clusterTarget.recordFrameNumber,
                textureIdentity: clusterTarget.textureIdentity,
                descriptor: {
                  format: clusterTarget.descriptor.format,
                  size: clusterTarget.descriptor.size,
                  usage: clusterTarget.descriptor.usage,
                  sample: clusterTarget.descriptor.sample,
                },
              },
            }),
      });
      completedFrameWallMs.push(performance.now() - startedAt);
      return receipt;
    };
    const capture = async () => {
      failureOperation = 'renderer.observe(final-display)';
      for (let attempt = 0; attempt < 120; attempt += 1) {
        renderer.requestObservation?.(['final-display']);
        const receipt = await draw();
        if (receipt.presentation !== 'ready') continue;
        const observations = value(await renderer.observe(receipt, { include: ['final-display'] }));
        const result = observations.observations?.find((row) => row.domain === 'final-display');
        if (result === undefined) throw new Error('final-display observation missing');
        return result;
      }
      throw new Error('WebGL2 Forward AO frame did not become ready');
    };
    const drawWithFinalDisplayDemand = async () => {
      const requested = renderer.requestObservation?.(['final-display']);
      if (requested === undefined) throw new Error('final-display observation is unavailable');
      value(requested);
      const receipt = await draw();
      if (receipt.presentation === 'ready') {
        const observed = value(await renderer.observe(receipt, { include: ['final-display'] }));
        if (!observed.observations?.some((row) => row.domain === 'final-display')) {
          throw new Error(`final-display preparation observation missing for ${receipt.frameId}`);
        }
      }
      return receipt;
    };
    const captureTarget = async (
      name: 'ssao-raw' | 'ssao-blurred' | 'standard-scene-surface-normal',
    ) => {
      failureOperation = `capture-target:${name}`;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          const captured = await captureForwardGtaoTarget(
            debugHost,
            name,
            drawWithFinalDisplayDemand,
          );
          failureReceipt = {
            publicReceiptFrameId: captured.publicReceiptFrameId,
            recordFrameNumber: captured.targetRecordFrameNumber,
            graphGeneration: captured.graphGeneration,
            textureIdentity: captured.textureIdentity,
            deviceGeneration: captured.deviceGeneration,
            presentation: 'ready',
          };
          failureFrameTrace = captured.frameTrace;
          failureReadback = {
            target: name,
            format: captured.format,
            width: captured.width,
            height: captured.height,
            byteLength: captured.bytes.byteLength,
            sha256: await sha256Hex(captured.bytes),
          };
          return captured;
        } catch (error) {
          if (!(error instanceof ForwardGtaoCaptureNotReadyError)) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      throw new Error(`${name} target capture did not produce a ready attempt`);
    };
    const captureLinear = async (clusterTransport: 'required' | 'not-required' = 'required') => {
      failureOperation = 'capture-linear-hdr';
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          const captured = await captureForwardGtaoLinearHdr(renderer, () =>
            draw(clusterTransport),
          );
          failureOperation = 'capture-linear-hdr:receipt-evidence';
          const frameTrace = debugHost.clusterWorkFrameTraceForConformance();
          const latestObservedWorkRow = clusterWorkObservations.at(-1);
          const workRow =
            latestObservedWorkRow?.receiptFrameId === captured.frameId
              ? latestObservedWorkRow
              : undefined;
          failureReceipt = {
            receipt: captured.receipt,
            linearAttachment: {
              graphGeneration: captured.graphGeneration,
              textureIdentity: captured.textureIdentity,
              readbackIdentity: captured.readbackIdentity,
            },
          };
          failureFrameTrace = frameTrace;
          failureClusterWorkRow =
            workRow ??
            (latestObservedWorkRow === undefined
              ? { status: 'not-obtained-for-capture' }
              : {
                  status: 'latest-row-belongs-to-another-capture',
                  latestObservedWorkRow,
                });
          const readback = {
            target: 'linear-hdr',
            format: captured.format,
            width: captured.width,
            height: captured.height,
            byteLength: captured.bytes.byteLength,
            textureIdentity: captured.textureIdentity,
            readbackIdentity: captured.readbackIdentity,
          };
          failureReadback = readback;
          const captureHash = await sha256Hex(captured.bytes);
          failureOperation = 'capture-linear-hdr:receipt-evidence-join';
          failureReadback = { ...readback, sha256: captureHash };
          const evidence: LinearCaptureEvidence = {
            receipt: captured.receipt,
            linearAttachment: {
              graphGeneration: captured.graphGeneration,
              textureIdentity: captured.textureIdentity,
              readbackIdentity: captured.readbackIdentity,
            },
            ...(frameTrace === undefined ? {} : { frameTrace }),
            ...(workRow === undefined ? {} : { workRow }),
            ...(latestObservedWorkRow === undefined ? {} : { latestObservedWorkRow }),
            ...(workRow?.clusterTarget === undefined
              ? {}
              : { clusterTarget: workRow.clusterTarget }),
            readback: {
              textureIdentity: captured.textureIdentity,
              readbackIdentity: captured.readbackIdentity,
              width: captured.width,
              height: captured.height,
              format: captured.format,
              byteLength: captured.bytes.byteLength,
              sha256: captureHash,
            },
          };
          linearCaptureEvidence.set(captured, evidence);
          assertForwardGtaoLinearCaptureJoin({
            transport: clusterTransport,
            capture: captured,
            frameTrace,
            workRow,
          });
          return captured;
        } catch (error) {
          if (!(error instanceof ForwardGtaoLinearCaptureNotReadyError)) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      throw new Error('linear HDR capture did not produce a ready receipt');
    };
    try {
      expect(renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
      const manifestResponse = await fetch('/shaders/manifest.json');
      if (!manifestResponse.ok) {
        throw new Error(`engine shader manifest fetch failed: ${manifestResponse.status}`);
      }
      const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
      const manifestIdentity = {
        url: new URL('/shaders/manifest.json', location.href).href,
        byteLength: manifestBytes.byteLength,
        sha256: await sha256Hex(manifestBytes),
      };
      failureManifestSummary = manifestIdentity;
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
        profiler.startCapture({ frameLimit: 48, eventLimit: 8_192, detail: 'nested' }),
      );
      const workloadStartedAt = performance.now();
      const before = await capture();
      const beforeLinear = await captureLinear();
      const coldRows = clusterWorkObservations.filter((row) => row.phase === 'cluster-cold');
      const coldWork = coldRows[0];
      expect(coldWork?.observation).toMatchObject({
        status: 'captured',
        invocations: 1,
        packedLightSlots: 1,
        writeSucceeded: true,
      });
      expect(coldWork?.receiptFrameId).toBeGreaterThan(0);
      expect(acceptedClusterWriteBytes(coldWork?.observation)).toBeGreaterThan(0);
      expectStableClusterRows(coldRows.slice(1));
      const controlledLighting = await captureControlledWebgl2Lighting({
        algorithm,
        world,
        skylight,
        pointLight,
        beforeLinear,
        captureLinear,
        setPhase: (phase) => {
          clusterWorkPhase = phase;
        },
      });
      const emissiveOnlyLinear = controlledLighting?.emissiveOnlyLinear;
      const indirectOnlyLinear = controlledLighting?.indirectOnlyLinear;
      const directOnlyLinear = controlledLighting?.directOnlyLinear;
      clusterWorkPhase = 'cluster-unchanged';
      await draw();
      expect(clusterWorkObservations.at(-1)?.observation).toMatchObject({
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
      expect(acceptedClusterWriteBytes(changedLightWork)).toBeGreaterThan(0);
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
      expect(acceptedClusterWriteBytes(restoredLightWork)).toBeGreaterThan(0);
      const preAoClusterWork = [...clusterWorkObservations]
        .reverse()
        .find(
          (row) => row.phase === 'light-value-restored' && row.observation.status === 'captured',
        );
      const preAoObservation = requireCapturedClusterWork(
        preAoClusterWork?.observation,
        'missing pre-AO Cluster transport observation',
      );
      world
        .addComponent(camera, {
          component: AmbientOcclusion,
          data: {
            algorithm,
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
      clusterWorkPhase = 'ao-enabled-cold';
      const after = await capture();
      const afterLinear = await captureLinear();
      await capture();
      const aoClusterTransportGeneration = expectClusterTransportReplacement(
        clusterWorkObservations,
        'ao-enabled-cold',
        preAoObservation,
      );
      const aoInspection = requirePresent(
        renderer.inspect().standardLighting?.ambientOcclusion,
        'WebGL2 AO inspection is missing',
      );
      const stableAoInputs = await captureStableWebgl2AoInputs({
        captureTarget,
        observations: clusterWorkObservations,
      });
      const { normalTarget, rawTarget, rawReceipt, blurredTarget, blurredReceipt } = stableAoInputs;
      const evidenceRoot = 'packages/runtime/reports/portable-gpu-data-kernels-and-ao';
      const clusterCapture = prepareClusterCapture(debugHost);
      const tapeTransaction = await captureWebgl2PackedAoTapeFrame({
        host: debugHost,
        recorder,
        clusterCapture,
        observations: clusterWorkObservations,
        stimulateLightChange: () => {
          world.set(pointLight, PointLight, { intensity: 9, range: 12 }).unwrap();
          clusterWorkPhase = 'tape-light-value-change';
        },
        draw: drawWithFinalDisplayDemand,
      });
      const {
        receipt: capturedReceipt,
        encoded,
        tape: decoded,
        frameModel,
        ownerWrite: recordedOwnerWrite,
        workRow: tapeWorkRow,
        clusterTarget: tapeClusterTarget,
        graphGeneration: tapeGraphGeneration,
        clusterReadback,
      } = tapeTransaction;
      await commands.writeFile(
        `${evidenceRoot}/forward-${algorithm}-webgl2-conformance.rhitape`,
        bytesToBase64(encoded.bytes),
        'base64',
      );
      await commands.writeFile(
        `${evidenceRoot}/forward-${algorithm}-webgl2-conformance-frame.json`,
        JSON.stringify(
          {
            digest: encoded.digest,
            byteLength: encoded.byteLength,
            summary: summarizeFrame(frameModel),
            frameModel,
            capturedReceipt: {
              frameId: capturedReceipt.frameId,
              deviceGeneration: capturedReceipt.deviceGeneration,
              presentation: capturedReceipt.presentation,
              graphGeneration: tapeGraphGeneration,
            },
            clusterObservation: tapeWorkRow.observation,
            clusterTarget: tapeClusterTarget,
            clusterReadback: {
              format: clusterReadback.format,
              width: clusterReadback.width,
              height: clusterReadback.height,
              bytesPerRow: clusterReadback.bytesPerRow,
              byteLength: clusterReadback.byteLength,
              graphGeneration: clusterReadback.graphGeneration,
              deviceGeneration: clusterReadback.deviceGeneration,
              textureIdentity: clusterReadback.textureIdentity,
              targetRecordFrameNumber: clusterReadback.targetRecordFrameNumber,
              publicReceiptFrameId: clusterReadback.publicReceiptFrameId,
              sha256: await sha256Hex(clusterReadback.bytes),
              base64: bytesToBase64(clusterReadback.bytes),
            },
          },
          null,
          2,
        ),
      );
      const tapeClusterObservation = clusterWorkObservations.at(-1)?.observation;
      expect(tapeClusterObservation).toMatchObject({
        status: 'captured',
        invocations: 1,
        transport: 'cpu-texture',
        scope: 'cluster-texture-host-regions',
        packedLightSlots: 1,
        writeSucceeded: true,
      });
      const capturedTapeClusterObservation = requireCapturedClusterWork(
        tapeClusterObservation,
        'missing captured texture-table Cluster observation',
      );
      expect(capturedTapeClusterObservation.frameNumber).toBe(
        clusterWorkObservations.at(-1)?.recordFrameNumber,
      );
      expect(clusterWorkObservations.at(-1)?.receiptFrameId).toBe(capturedReceipt.frameId);
      expect(recordedOwnerWrite.bytes).toBe(capturedTapeClusterObservation.acceptedWriteBytes);
      expect(recordedOwnerWrite.bytes).toBeGreaterThan(0);
      expect(recordedOwnerWrite.calls).toBeGreaterThan(0);
      expect(tapeWorkRow.receiptFrameId).toBe(capturedReceipt.frameId);
      expect(tapeWorkRow.deviceGeneration).toBe(capturedReceipt.deviceGeneration);
      expect(tapeWorkRow.recordFrameNumber).toBe(clusterCapture.expectedRecordFrameNumber);
      expect(tapeClusterTarget).toMatchObject({
        graphGeneration: clusterCapture.target.graphGeneration,
        recordFrameNumber: clusterCapture.expectedRecordFrameNumber,
        textureIdentity: clusterCapture.target.textureIdentity,
        descriptor: {
          format: clusterCapture.target.descriptor.format,
          size: clusterCapture.target.descriptor.size,
          usage: clusterCapture.target.descriptor.usage,
          sample: clusterCapture.target.descriptor.sample,
        },
      });
      expect(tapeGraphGeneration).toBe(clusterCapture.target.graphGeneration);
      expect(clusterReadback).toMatchObject({
        format: 'rgba32uint',
        width: clusterCapture.width,
        height: clusterCapture.height,
        bytesPerRow: clusterCapture.bytesPerRow,
        byteLength: clusterCapture.bytesPerRow * clusterCapture.height,
        graphGeneration: tapeClusterTarget.graphGeneration,
        deviceGeneration: tapeWorkRow.deviceGeneration,
        textureIdentity: tapeClusterTarget.textureIdentity,
        targetRecordFrameNumber: tapeClusterTarget.recordFrameNumber,
        publicReceiptFrameId: tapeWorkRow.receiptFrameId,
        receiptPresentation: 'ready',
        receiptCompleted: true,
      });
      world.set(pointLight, PointLight, { intensity: 8, range: 12 }).unwrap();
      clusterWorkPhase = 'tape-light-value-restored';
      const restoredReceipt = await draw();
      const restoredObservation = clusterWorkObservations.at(-1)?.observation;
      expect(restoredReceipt.presentation).toBe('ready');
      expect(restoredObservation).toMatchObject({
        status: 'captured',
        invocations: 1,
        packedLightSlots: 1,
        writeSucceeded: true,
      });
      expect(acceptedClusterWriteBytes(restoredObservation)).toBeGreaterThan(0);
      const stableCapturePending = recorder.captureFrame();
      value(await recorder.frameBoundary());
      clusterWorkPhase = 'tape-light-unchanged-follow-up';
      const stableReceipt = await draw();
      value(await recorder.frameBoundary());
      const stableEncoded = value(await stableCapturePending);
      const stableTape = value(decodeTape(stableEncoded.bytes));
      const stableFrameModel = buildFrameModel(stableTape);
      const stableOwnerWrite = recordedClusterOwnerWrite(
        stableTape,
        stableFrameModel,
        'cpu-texture',
      );
      const stableObservation = clusterWorkObservations.at(-1)?.observation;
      await commands.writeFile(
        `${evidenceRoot}/forward-${algorithm}-webgl2-stable-follow-up.rhitape`,
        bytesToBase64(stableEncoded.bytes),
        'base64',
      );
      await commands.writeFile(
        `${evidenceRoot}/forward-${algorithm}-webgl2-stable-follow-up.json`,
        JSON.stringify(
          {
            digest: stableEncoded.digest,
            byteLength: stableEncoded.byteLength,
            summary: summarizeFrame(stableFrameModel),
            receipt: {
              frameId: stableReceipt.frameId,
              presentation: stableReceipt.presentation,
            },
            clusterObservation: stableObservation,
            ownerWrite: stableOwnerWrite,
          },
          null,
          2,
        ),
      );
      expect(stableReceipt.presentation).toBe('ready');
      expect(stableObservation).toMatchObject({
        status: 'captured',
        invocations: 1,
        packedLightSlots: 0,
        acceptedWriteBytes: 0,
        writeSucceeded: true,
      });
      expect(stableOwnerWrite.calls).toBe(0);
      expect(stableOwnerWrite.bytes).toBe(0);
      const reflectedAbi = derivePublishedStandardClusterAbi(manifestBytes);
      const clusterUniformResourceId = recordedBufferResourceId(frameModel, 'hdrp-cluster-uniform');
      const standardMainEventIndex = recordedShaderWorkEventIndex(
        frameModel,
        'fs_opaque',
        clusterUniformResourceId,
        'sampleStandardAmbientOcclusion',
      );
      const ssaoUniformResourceId = recordedBufferResourceId(frameModel, 'hdrp-ssao-uniform');
      const clusterPackEventIndex = recordedShaderWorkEventIndex(
        frameModel,
        'fs_ssao_cluster_pack',
        ssaoUniformResourceId,
      );
      const clusterUniformPayload = recordedUniformPayload(
        decoded,
        frameModel,
        'hdrp-cluster-uniform',
        standardMainEventIndex,
      );
      const ssaoUniformPayload = recordedUniformPayload(
        decoded,
        frameModel,
        'hdrp-ssao-uniform',
        clusterPackEventIndex,
      );
      const packedAoRegion = decodePackedAoRegion({
        clusterUniformBytes: clusterUniformPayload.bytes,
        clusterAoByteOffset: reflectedAbi.clusterUniformOffsets.ao,
        ssaoUniformBytes: ssaoUniformPayload.bytes,
        ssaoClusterPackByteOffset: SSAO_UNIFORM_INTENSITY_OFFSET + 32,
      });
      const packedComparison = comparePackedAo(clusterReadback, blurredTarget, packedAoRegion);
      expect(renderer.inspect().standardLighting).toMatchObject({ transport: 'cpu-texture' });
      expect(renderer.inspect().output.graphPassNames).toEqual(
        expect.arrayContaining([
          'standard-scene-surface-data',
          'ssao-calc',
          'ssao-blur',
          'ssao-cluster-pack',
          'main',
        ]),
      );
      const displayDelta = maxDisplayDelta(
        before.bytes,
        after.bytes,
        before.metadata.bytesPerRow,
        width,
        height,
      );
      expect(rawReceipt.presentation).toBe('ready');
      expect(blurredReceipt.presentation).toBe('ready');
      expect(capturedReceipt.presentation).toBe('ready');
      expect(
        packedComparison.mismatches,
        `AO Cluster words match blurred values: ${JSON.stringify(packedComparison)}`,
      ).toBe(0);
      expect(
        Array.from(byteChannel(rawTarget.bytes, rawTarget.bytesPerTexel, 0)).some((v) => v < 253),
      ).toBe(true);
      expect(Array.from(blurredTarget.bytes).some((v) => v < 253)).toBe(true);
      const centerPixel = (observation: typeof before) =>
        Array.from(
          observation.bytes.subarray(
            Math.floor(height / 2) * observation.metadata.bytesPerRow + Math.floor(width / 2) * 4,
            Math.floor(height / 2) * observation.metadata.bytesPerRow +
              Math.floor(width / 2) * 4 +
              4,
          ),
        );
      const centerAo = {
        raw:
          rawTarget.bytes[(Math.floor(height / 2) * rawTarget.width + Math.floor(width / 2)) * 4] ??
          0,
        blurred:
          blurredTarget.bytes[
            Math.floor((height / 2) * FORWARD_GTAO_FIXTURE.resolutionScale) * blurredTarget.width +
              Math.floor((width / 2) * FORWARD_GTAO_FIXTURE.resolutionScale)
          ] ?? 0,
      };
      let rawReferenceMetrics: ReturnType<typeof byteErrorMetrics> | undefined;
      let filteredReferenceMetrics: ReturnType<typeof byteErrorMetrics> | undefined;
      let normalMetrics: ReturnType<typeof materialNormalFieldMetrics> | undefined;
      let rawNormalMetrics: ReturnType<typeof byteErrorMetrics>[] = [];
      if (algorithm === AMBIENT_OCCLUSION_GTAO) {
        expect(aoInspection.execution).toBe('fragment');
        expect(aoInspection.input.extent).toEqual({ width, height });
        expect(aoInspection.output.extent).toEqual({
          width: Math.round(width * FORWARD_GTAO_FIXTURE.resolutionScale),
          height: Math.round(height * FORWARD_GTAO_FIXTURE.resolutionScale),
        });
        const field = createForwardGtaoReferenceField(width, height);
        const rawReference = computeGtaoRawReference(field, {
          outputWidth: rawTarget.width,
          outputHeight: rawTarget.height,
          radius: aoInspection.numerical.radius,
          bias: aoInspection.numerical.bias,
          intensity: aoInspection.numerical.intensity,
          thickness: aoInspection.numerical.thickness,
          distanceExponent: aoInspection.numerical.distanceExponent,
          distanceFallOff: aoInspection.numerical.distanceFallOff,
          sampleBudget: aoInspection.numerical.sampleBudget,
        });
        const filteredReference = filterGtaoReference(
          field,
          rawReference,
          aoInspection.numerical.radius,
        );
        rawReferenceMetrics = byteErrorMetrics(
          byteChannel(rawTarget.bytes, rawTarget.bytesPerTexel, 0),
          byteChannel(rawReference.rgba, 4, 0),
        );
        expect(rawReferenceMetrics.maxAbsolute).toBeLessThanOrEqual(
          GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
        );
        expect(rawReferenceMetrics.rms).toBeLessThanOrEqual(
          GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError,
        );
        rawNormalMetrics = [1, 2].map((channel) =>
          byteErrorMetrics(
            byteChannel(rawTarget.bytes, rawTarget.bytesPerTexel, channel),
            byteChannel(rawReference.rgba, 4, channel),
          ),
        );
        expect(
          rawNormalMetrics.every(
            (metrics) =>
              metrics.maxAbsolute <= GTAO_COMPARISON_BUDGET.rawNormalMaxByteError &&
              metrics.rms <= GTAO_COMPARISON_BUDGET.rawNormalRmsByteError,
          ),
        ).toBe(true);
        filteredReferenceMetrics = byteErrorMetrics(blurredTarget.bytes, filteredReference);
        expect(filteredReferenceMetrics.maxAbsolute).toBeLessThanOrEqual(
          GTAO_COMPARISON_BUDGET.filteredVisibilityMaxByteError,
        );
        expect(filteredReferenceMetrics.rms).toBeLessThanOrEqual(
          GTAO_COMPARISON_BUDGET.filteredVisibilityRmsByteError,
        );
        normalMetrics = materialNormalFieldMetrics(field, normalTarget.bytes);
        expect(normalMetrics.count).toBeGreaterThan(1_000);
        expect(normalMetrics.maxAngularRadians).toBeLessThanOrEqual(
          GTAO_COMPARISON_BUDGET.materialNormalX12Y12AngularRadians,
        );
        expect(normalMetrics.firstMismatch).toBeUndefined();
      }
      world.set(camera, AmbientOcclusion, { directLightingStrength: 1 }).unwrap();
      await capture();
      const directAoLinear = await captureLinear();
      const directAo = await capture();
      const directAoDelta = maxDisplayDelta(
        after.bytes,
        directAo.bytes,
        after.metadata.bytesPerRow,
        width,
        height,
      );
      let ao0LightingMetrics: ReturnType<typeof linearErrorMetrics> | undefined;
      let ao1LightingMetrics: ReturnType<typeof linearErrorMetrics> | undefined;
      let contactPixel:
        | {
            readonly x: number;
            readonly y: number;
            readonly u: number;
            readonly v: number;
            readonly visibility: number;
          }
        | undefined;
      if (algorithm === AMBIENT_OCCLUSION_GTAO) {
        if (
          emissiveOnlyLinear === undefined ||
          indirectOnlyLinear === undefined ||
          directOnlyLinear === undefined
        ) {
          throw new Error('GTAO controlled lighting captures are incomplete');
        }
        const field = createForwardGtaoReferenceField(width, height);
        const rawReference = computeGtaoRawReference(field, {
          outputWidth: rawTarget.width,
          outputHeight: rawTarget.height,
          radius: aoInspection.numerical.radius,
          bias: aoInspection.numerical.bias,
          intensity: aoInspection.numerical.intensity,
          thickness: aoInspection.numerical.thickness,
          distanceExponent: aoInspection.numerical.distanceExponent,
          distanceFallOff: aoInspection.numerical.distanceFallOff,
          sampleBudget: aoInspection.numerical.sampleBudget,
        });
        const filteredReference = filterGtaoReference(
          field,
          rawReference,
          aoInspection.numerical.radius,
        );
        const index = field.positions.findIndex((position, pixelIndex) => {
          if (position === undefined || Math.abs(position[2] + 4) > 0.02) return false;
          const x = pixelIndex % width;
          const y = Math.floor(pixelIndex / width);
          const u = (x + 0.5) / width;
          const v = (y + 0.5) / height;
          return (
            sampleGtaoBilinearLinearClamp(
              filteredReference,
              rawTarget.width,
              rawTarget.height,
              u,
              v,
            ).value < 200
          );
        });
        if (index < 0) throw new Error('CPU GTAO oracle found no occluded receiver pixel');
        const x = index % width;
        const y = Math.floor(index / width);
        const u = (x + 0.5) / width;
        const v = (y + 0.5) / height;
        const referenceFilteredSample = sampleGtaoBilinearLinearClamp(
          filteredReference,
          rawTarget.width,
          rawTarget.height,
          u,
          v,
        );
        const actualFilteredSample = sampleGtaoBilinearLinearClamp(
          blurredTarget.bytes,
          blurredTarget.width,
          blurredTarget.height,
          u,
          v,
        );
        const tapCoordinates = [
          [referenceFilteredSample.x0, referenceFilteredSample.y0],
          [referenceFilteredSample.x1, referenceFilteredSample.y0],
          [referenceFilteredSample.x0, referenceFilteredSample.y1],
          [referenceFilteredSample.x1, referenceFilteredSample.y1],
        ] as const;
        const actualTapCoordinates = [
          [actualFilteredSample.x0, actualFilteredSample.y0],
          [actualFilteredSample.x1, actualFilteredSample.y0],
          [actualFilteredSample.x0, actualFilteredSample.y1],
          [actualFilteredSample.x1, actualFilteredSample.y1],
        ] as const;
        const nearestAoX = Math.min(rawTarget.width - 1, Math.floor(u * rawTarget.width));
        const nearestAoY = Math.min(rawTarget.height - 1, Math.floor(v * rawTarget.height));
        const nearestDiagnostic =
          filteredReference[nearestAoY * rawTarget.width + nearestAoX] ?? 255;
        const screenVisibility = referenceFilteredSample.value / 255;
        const emissive = rgba16FloatPixel(emissiveOnlyLinear, x, y);
        const indirect = rgba16FloatPixel(indirectOnlyLinear, x, y).map(
          (value, channel) => value - (emissive[channel] ?? 0),
        );
        const direct = rgba16FloatPixel(directOnlyLinear, x, y).map(
          (value, channel) => value - (emissive[channel] ?? 0),
        );
        const expectedAo0 = composeLinearLightingReference({
          indirect: indirect as [number, number, number],
          direct: direct as [number, number, number],
          emissive: emissive as [number, number, number],
          screenVisibility,
          materialOcclusion: 1,
          directLightingStrength: 0,
        });
        const expectedAo1 = composeLinearLightingReference({
          indirect: indirect as [number, number, number],
          direct: direct as [number, number, number],
          emissive: emissive as [number, number, number],
          screenVisibility,
          materialOcclusion: 1,
          directLightingStrength: 1,
        });
        const actualAo0 = rgba16FloatPixel(afterLinear, x, y);
        const actualAo1 = rgba16FloatPixel(directAoLinear, x, y);
        const ao0ChannelErrors = actualAo0.map(
          (value, channel) => value - (expectedAo0[channel] ?? 0),
        );
        const ao1ChannelErrors = actualAo1.map(
          (value, channel) => value - (expectedAo1[channel] ?? 0),
        );
        ao0LightingMetrics = linearErrorMetrics(
          Float32Array.from(actualAo0),
          Float32Array.from(expectedAo0),
        );
        ao1LightingMetrics = linearErrorMetrics(
          Float32Array.from(actualAo1),
          Float32Array.from(expectedAo1),
        );
        failureComparisonEvidence = {
          contactPixel: { x, y, u, v },
          displayDelta,
          directAoDelta,
          referenceFiltered: {
            filter: 'bilinear-linear-clamp',
            tapCoordinates,
            tapValues: referenceFilteredSample.texels,
            weights: referenceFilteredSample.weights,
            interpolation: {
              tx: referenceFilteredSample.tx,
              ty: referenceFilteredSample.ty,
            },
            value: referenceFilteredSample.value,
            visibility: screenVisibility,
          },
          actualFiltered: {
            filter: 'bilinear-linear-clamp',
            tapCoordinates: actualTapCoordinates,
            tapValues: actualFilteredSample.texels,
            weights: actualFilteredSample.weights,
            interpolation: {
              tx: actualFilteredSample.tx,
              ty: actualFilteredSample.ty,
            },
            value: actualFilteredSample.value,
            visibility: actualFilteredSample.value / 255,
          },
          nearestDiagnostic: {
            x: nearestAoX,
            y: nearestAoY,
            value: nearestDiagnostic,
            visibility: nearestDiagnostic / 255,
          },
          rawTarget: {
            receipt: rawTarget.frameTrace.receipt,
            frameTrace: rawTarget.frameTrace,
            target: rawTarget.preparation,
            readback: {
              byteLength: rawTarget.bytes.byteLength,
              sha256: await sha256Hex(rawTarget.bytes),
            },
          },
          filteredTarget: {
            receipt: blurredTarget.frameTrace.receipt,
            frameTrace: blurredTarget.frameTrace,
            target: blurredTarget.preparation,
            readback: {
              byteLength: blurredTarget.bytes.byteLength,
              sha256: await sha256Hex(blurredTarget.bytes),
            },
          },
          captures: {
            emissiveOnly: evidenceForLinearCapture(emissiveOnlyLinear),
            indirectOnly: evidenceForLinearCapture(indirectOnlyLinear),
            directOnly: evidenceForLinearCapture(directOnlyLinear),
            ao0: evidenceForLinearCapture(afterLinear),
            ao1: evidenceForLinearCapture(directAoLinear),
          },
          lighting: {
            emissive,
            indirect,
            direct,
            materialOcclusion: 1,
            ao0: {
              directLightingStrength: 0,
              expected: expectedAo0,
              actual: actualAo0,
              signedChannelErrors: ao0ChannelErrors,
              absoluteChannelErrors: ao0ChannelErrors.map((error) => Math.abs(error)),
              metrics: ao0LightingMetrics,
            },
            ao1: {
              directLightingStrength: 1,
              expected: expectedAo1,
              actual: actualAo1,
              signedChannelErrors: ao1ChannelErrors,
              absoluteChannelErrors: ao1ChannelErrors.map((error) => Math.abs(error)),
              metrics: ao1LightingMetrics,
            },
          },
        };
        expect(Math.max(...indirect)).toBeGreaterThan(0.01);
        expect(Math.max(...direct)).toBeGreaterThan(0.01);
        expect(Math.max(...emissive)).toBeGreaterThan(0.01);
        for (const metrics of [ao0LightingMetrics, ao1LightingMetrics]) {
          expect(metrics.maxAbsolute).toBeLessThanOrEqual(
            GTAO_COMPARISON_BUDGET.linearLightingMaxAbsoluteError,
          );
          expect(metrics.maxRelative).toBeLessThanOrEqual(
            GTAO_COMPARISON_BUDGET.linearLightingMaxRelativeError,
          );
          expect(metrics.rmsAbsolute).toBeLessThanOrEqual(
            GTAO_COMPARISON_BUDGET.linearLightingRmsAbsoluteError,
          );
        }
        contactPixel = { x, y, u, v, visibility: screenVisibility };
      }
      expect(
        displayDelta.maximum,
        `AO changes controlled final lighting pixels; before=${JSON.stringify(centerPixel(before))}; after=${JSON.stringify(centerPixel(after))}; ao=${JSON.stringify(centerAo)}; packed=${JSON.stringify(packedComparison)}; comparison=${JSON.stringify(failureComparisonEvidence)}`,
      ).toBeGreaterThan(2);
      expect(displayDelta.changed).toBeGreaterThan(8);
      expect(
        directAoDelta.maximum,
        `directLightingStrength independently attenuates direct light; ambient-only=${JSON.stringify(centerPixel(after))}; direct-AO=${JSON.stringify(centerPixel(directAo))}; comparison=${JSON.stringify(failureComparisonEvidence)}`,
      ).toBeGreaterThan(2);
      expect(directAoDelta.changed).toBeGreaterThan(8);
      const activeAoGraphPassNames = [...renderer.inspect().output.graphPassNames];
      const activeAoClusterWork = requireCapturedClusterWorkRow(
        [...clusterWorkObservations]
          .reverse()
          .find(
            (row) =>
              row.phase !== 'ao-disabled' &&
              row.observation.status === 'captured' &&
              row.observation.clusterTransportGeneration === aoClusterTransportGeneration,
          ),
      );
      clusterWorkPhase = 'ao-disabled';
      world.removeComponent(camera, AmbientOcclusion).unwrap();
      await capture();
      await capture();
      const disabledAoInspection = renderer.inspect().standardLighting?.ambientOcclusion;
      expect(disabledAoInspection?.status).toBe('off');
      const disabledAoGraphPassNames = [...renderer.inspect().output.graphPassNames];
      for (const passName of [
        'ssao-calc',
        'gtao-calc-compute',
        'gtao-calc-fragment',
        'ssao-blur',
        'ssao-cluster-pack',
      ]) {
        expect(disabledAoGraphPassNames).not.toContain(passName);
      }
      expect(debugHost.getCurrentGraphTarget('ssao-raw')).toBeUndefined();
      expect(debugHost.getCurrentGraphTarget('ssao-blurred')).toBeUndefined();
      expectClusterTransportReplacement(
        clusterWorkObservations,
        'ao-disabled',
        activeAoClusterWork.observation,
      );

      const profile = value(profilerSession.finish());
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
        readonly bytesPerRow?: number;
        readonly usage?: number;
      }) => ({
        format: capture.format,
        width: capture.width,
        height: capture.height,
        bytesPerRow: capture.bytesPerRow,
        usage: capture.usage,
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
      if (algorithm === AMBIENT_OCCLUSION_GTAO) {
        const report = {
          schema: 'forgeax::forward-gtao-conformance::1',
          backend: 'wgpu-webgl2',
          fixture: FORWARD_GTAO_FIXTURE,
          manifestIdentity,
          inputIdentity,
          frozenBudget: GTAO_COMPARISON_BUDGET,
          inspection: aoInspection,
          graphPassNames: activeAoGraphPassNames,
          disabledAo: {
            inspection: disabledAoInspection,
            graphPassNames: disabledAoGraphPassNames,
            clusterWork: clusterWorkObservations.at(-1)?.observation,
          },
          metrics: {
            lightingComparison: failureComparisonEvidence,
            rawReferenceMetrics,
            rawNormalMetrics,
            filteredReferenceMetrics,
            normalMetrics,
            packedComparison,
            directAoDelta,
            maximumDelta: displayDelta.maximum,
            changedPixels: displayDelta.changed,
            ao0LightingMetrics,
            ao1LightingMetrics,
          },
          cost: {
            completedFrameWallMs,
            completedFrameMeasurement: 'world-update+renderer.draw+receipt.completed',
            completedWorkWallMs: performance.now() - workloadStartedAt,
            gpuTiming: directAoLinear.gpuTimings,
            profiler: { completeness: profile.completeness, records: profile.records },
            clusterWorkObservations,
            recordedClusterWrite: {
              digest: encoded.digest,
              byteLength: encoded.byteLength,
              frameId: capturedReceipt.frameId,
              ownerWrites: recordedOwnerWrite,
            },
          },
          captures: {
            beforeLinear: await outputArtifact(beforeLinear),
            ao0Linear: await outputArtifact(afterLinear),
            ...(emissiveOnlyLinear === undefined
              ? {}
              : { emissiveOnly: await outputArtifact(emissiveOnlyLinear) }),
            ...(indirectOnlyLinear === undefined
              ? {}
              : { indirectOnly: await outputArtifact(indirectOnlyLinear) }),
            ...(directOnlyLinear === undefined
              ? {}
              : { directOnly: await outputArtifact(directOnlyLinear) }),
            normal: await outputArtifact(normalTarget),
            raw: await outputArtifact(rawTarget),
            filtered: await outputArtifact(blurredTarget),
            ao1Linear: await outputArtifact(directAoLinear),
            contactPixel,
            cluster: await outputArtifact({
              bytes: clusterReadback.bytes,
              width: clusterReadback.width,
              height: clusterReadback.height,
              format: clusterReadback.format,
              bytesPerRow: clusterReadback.bytesPerRow,
              usage: clusterReadback.usage,
              frameId: clusterReadback.targetRecordFrameNumber,
              targetRecordFrameNumber: clusterReadback.targetRecordFrameNumber,
              publicReceiptFrameId: clusterReadback.publicReceiptFrameId,
              graphGeneration: clusterReadback.graphGeneration,
              textureIdentity: clusterReadback.textureIdentity,
            }),
          },
          receipt: {
            frameId: afterLinear.frameId,
            deviceGeneration: afterLinear.deviceGeneration,
            graphGeneration: afterLinear.graphGeneration,
            readbackIdentity: afterLinear.readbackIdentity,
            draws: afterLinear.draws,
            tapeDigest: encoded.digest,
            tapeByteLength: encoded.byteLength,
            tapeSummary: summarizeFrame(frameModel),
            capturedFrameId: capturedReceipt.frameId,
          },
          errors: errors.map(describeFailure),
        };
        await commands.writeFile(
          'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgl2-conformance.json',
          JSON.stringify(report, null, 2),
        );
      }
      expect(errors).toEqual([]);
    } catch (failure) {
      await writeForwardGtaoFailureReport({
        writeFile: commands.writeFile,
        path: `packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-webgl2-${algorithm === AMBIENT_OCCLUSION_GTAO ? 'gtao' : 'ssao'}-failure.json`,
        failure,
        context: {
          backend: 'wgpu-webgl2',
          manifestSummary: failureManifestSummary,
          cameraConfig: {
            width,
            height,
            algorithm: algorithm === AMBIENT_OCCLUSION_GTAO ? 'gtao' : 'ssao',
            quality: FORWARD_GTAO_FIXTURE.quality,
            resolutionScale: FORWARD_GTAO_FIXTURE.resolutionScale,
          },
          operation: failureOperation,
          receipt: failureReceipt,
          frameTrace: failureFrameTrace,
          readback: failureReadback,
          diagnostics: {
            clusterWorkRow: failureClusterWorkRow,
            comparisonEvidence: failureComparisonEvidence,
            linearCaptureEvidence: [...linearCaptureEvidence.values()],
          },
          rendererErrors: errors,
        },
      });
      throw failure;
    } finally {
      unsubscribe();
      lease.dispose();
      value(await renderer.dispose());
      value(await recorder.dispose());
      canvas.remove();
    }
  },
);
