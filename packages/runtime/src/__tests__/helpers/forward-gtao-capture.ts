import type { FrameReceipt, FrameReceiptObservation, Renderer } from '@forgeax/engine-render';
import type {
  RendererHostAssembly,
  RendererLegacyHostAdapter,
} from '@forgeax/engine-render/internal/construct-renderer';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import type { FrameModel, V7Tape } from '@forgeax/engine-rhi-debug';
import type {
  ClusterWorkFrameIdentity,
  ClusterWorkObservation,
} from '../../../../render/src/record/cluster-work-conformance';

const GPU_TEXTURE_USAGE_COPY_SRC = 0x01;
const GPU_BUFFER_USAGE_MAP_READ = 0x01;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_MAP_MODE_READ = 0x01;
export type ForwardGtaoTargetName =
  | 'ssao-raw'
  | 'ssao-blurred'
  | 'standard-scene-surface-normal'
  | 'gbuffer-normal-roughness'
  | 'standard-cluster-tables';
type ForwardGtaoCaptureTargetName = Exclude<ForwardGtaoTargetName, 'standard-cluster-tables'>;

export type ForwardGtaoCaptureHost = RendererHostAssembly['debugDrawHost'] &
  Pick<
    RendererLegacyHostAdapter,
    | 'getCurrentGraphTarget'
    | 'requestGraphTargetCapture'
    | 'cancelGraphTargetCapture'
    | 'clusterWorkFrameTraceForConformance'
  >;

export type ForwardGtaoFrameTrace = NonNullable<
  ReturnType<RendererLegacyHostAdapter['clusterWorkFrameTraceForConformance']>
>;
export type ForwardGtaoPresentation = FrameReceipt['presentation'];

export interface ForwardGtaoCompletedReceipt {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly presentation: ForwardGtaoPresentation;
  readonly completed: Promise<unknown>;
}

export interface ForwardGtaoTargetCapture {
  readonly name: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly bytesPerTexel: number;
  readonly usage: number;
  readonly sample: number;
  readonly targetRecordFrameNumber: number;
  readonly deviceGeneration: number;
  readonly publicReceiptFrameId: number;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
  readonly preparation: {
    readonly recordFrameNumber: number;
    readonly publicReceiptFrameId: number;
    readonly deviceGeneration: number;
    readonly graphGeneration: number;
    readonly textureIdentity: number;
    readonly descriptor: {
      readonly format: string;
      readonly size: { readonly width: number; readonly height: number };
      readonly usage: number;
      readonly sample: number;
    };
  };
  readonly frameTrace: ForwardGtaoFrameTrace;
  readonly bytes: Uint8Array;
}

export class ForwardGtaoCaptureNotReadyError extends Error {
  constructor(
    readonly targetName: string,
    readonly publicReceiptFrameId: number,
    readonly presentation: ForwardGtaoPresentation,
    readonly frameTrace: ForwardGtaoFrameTrace | undefined,
  ) {
    super(
      `${targetName} record attempt ${frameTrace?.recordFrameNumber ?? 'unknown'} produced public receipt ${publicReceiptFrameId} with presentation ${presentation}`,
    );
    this.name = 'ForwardGtaoCaptureNotReadyError';
  }
}

export class ForwardGtaoLinearCaptureNotReadyError extends Error {
  constructor(
    readonly publicReceiptFrameId: number,
    readonly presentation: ForwardGtaoPresentation,
  ) {
    super(`linear HDR public receipt ${publicReceiptFrameId} has presentation ${presentation}`);
    this.name = 'ForwardGtaoLinearCaptureNotReadyError';
  }
}

export interface ForwardGtaoLinearCapture {
  readonly receipt: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly presentation: ForwardGtaoPresentation;
    readonly graphGeneration?: number;
    readonly completion: 'pending' | 'completed';
  };
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
  readonly readbackIdentity: number;
  readonly backendId?: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly bytes: Uint8Array;
  readonly gpuTimings: unknown;
  readonly draws: FrameReceiptObservation['draws'];
}

export type ForwardGtaoLinearCaptureTransport = 'required' | 'not-required';

export interface ForwardGtaoLinearCaptureWorkRow {
  readonly receiptFrameId: number;
  readonly deviceGeneration: number;
  readonly receiptPresentation: ForwardGtaoPresentation;
  readonly recordFrameNumber: number;
  readonly observationFrameId: number | undefined;
  readonly observation: ClusterWorkObservation;
  readonly frameTrace: ForwardGtaoFrameTrace;
}

function linearCaptureReceiptMatchesAttachment(capture: ForwardGtaoLinearCapture): boolean {
  return (
    capture.receipt.frameId === capture.frameId &&
    capture.receipt.deviceGeneration === capture.deviceGeneration &&
    capture.receipt.presentation === 'ready' &&
    capture.receipt.completion === 'completed' &&
    (capture.receipt.graphGeneration === undefined ||
      capture.receipt.graphGeneration === capture.graphGeneration)
  );
}

function linearFrameTraceMatchesCapture(
  capture: ForwardGtaoLinearCapture,
  frameTrace: ForwardGtaoFrameTrace,
): boolean {
  const receipt = frameTrace.receipt;
  return (
    frameTrace.recordStatus === 'submitted' &&
    frameTrace.observationFrameId === capture.frameId &&
    frameTrace.deviceGeneration === capture.deviceGeneration &&
    receipt?.publicReceiptFrameId === capture.frameId &&
    receipt.deviceGeneration === capture.deviceGeneration &&
    receipt.presentation === 'ready' &&
    receipt.completion === 'completed'
  );
}

function linearFrameTracesMatch(
  left: ForwardGtaoFrameTrace,
  right: ForwardGtaoFrameTrace,
): boolean {
  return (
    left.recordFrameNumber === right.recordFrameNumber &&
    left.recordStatus === right.recordStatus &&
    left.observationFrameId === right.observationFrameId &&
    left.deviceGeneration === right.deviceGeneration &&
    left.graphGeneration === right.graphGeneration &&
    left.viewEntityKey === right.viewEntityKey &&
    left.clusterTransportGeneration === right.clusterTransportGeneration &&
    linearClusterWorkMatches(left.clusterWork, right.clusterWork) &&
    left.receipt?.publicReceiptFrameId === right.receipt?.publicReceiptFrameId &&
    left.receipt?.deviceGeneration === right.receipt?.deviceGeneration &&
    left.receipt?.presentation === right.receipt?.presentation &&
    left.receipt?.completion === right.receipt?.completion &&
    left.graphTargetCopy?.targetName === right.graphTargetCopy?.targetName &&
    left.graphTargetCopy?.recordFrameNumber === right.graphTargetCopy?.recordFrameNumber &&
    left.graphTargetCopy?.encoded === right.graphTargetCopy?.encoded &&
    left.graphTargetCopy?.reason === right.graphTargetCopy?.reason &&
    linearFrameIdentitiesMatch(
      left.graphTargetCopy?.expectedIdentity,
      right.graphTargetCopy?.expectedIdentity,
    ) &&
    linearFrameIdentitiesMatch(
      left.graphTargetCopy?.actualIdentity,
      right.graphTargetCopy?.actualIdentity,
    )
  );
}

function linearFrameIdentitiesMatch(
  left: ClusterWorkFrameIdentity | undefined,
  right: ClusterWorkFrameIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.graphGeneration === right.graphGeneration &&
    left.recordFrameNumber === right.recordFrameNumber &&
    left.textureIdentity === right.textureIdentity
  );
}

function linearClusterWorkMatches(
  left: ForwardGtaoFrameTrace['clusterWork'],
  right: ForwardGtaoFrameTrace['clusterWork'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.status === 'unavailable' || right.status === 'unavailable') {
    return (
      left.status === 'unavailable' &&
      right.status === 'unavailable' &&
      left.reason === right.reason
    );
  }
  return (
    left.frameNumber === right.frameNumber &&
    left.viewEntityKey === right.viewEntityKey &&
    left.deviceGeneration === right.deviceGeneration &&
    left.graphGeneration === right.graphGeneration &&
    left.clusterTransportGeneration === right.clusterTransportGeneration &&
    left.clusterUsedRows === right.clusterUsedRows &&
    left.clusterRowBytes === right.clusterRowBytes &&
    left.transport === right.transport &&
    left.scope === right.scope &&
    left.packedLightSlots === right.packedLightSlots &&
    left.acceptedWriteBytes === right.acceptedWriteBytes &&
    left.writeSucceeded === right.writeSucceeded &&
    left.errorCode === right.errorCode &&
    left.invocations === right.invocations
  );
}

function linearCaptureWorkRowMatches(
  capture: ForwardGtaoLinearCapture,
  frameTrace: ForwardGtaoFrameTrace,
  workRow: ForwardGtaoLinearCaptureWorkRow,
): boolean {
  return (
    workRow.receiptFrameId === capture.frameId &&
    workRow.deviceGeneration === capture.deviceGeneration &&
    workRow.receiptPresentation === 'ready' &&
    workRow.recordFrameNumber === frameTrace.recordFrameNumber &&
    workRow.observationFrameId === capture.frameId &&
    linearFrameTracesMatch(workRow.frameTrace, frameTrace)
  );
}

function linearClusterTransportMatches(
  transport: ForwardGtaoLinearCaptureTransport,
  capture: ForwardGtaoLinearCapture,
  frameTrace: ForwardGtaoFrameTrace,
  workRow: ForwardGtaoLinearCaptureWorkRow,
): boolean {
  if (transport === 'required') {
    const observation = workRow.observation;
    const sample = frameTrace.clusterWork;
    return (
      observation.status === 'captured' &&
      sample?.status === 'captured' &&
      linearClusterWorkMatches(observation, sample) &&
      frameTrace.graphGeneration !== undefined &&
      frameTrace.graphGeneration === capture.graphGeneration &&
      workRow.frameTrace.graphGeneration === capture.graphGeneration &&
      observation.frameNumber === workRow.recordFrameNumber &&
      observation.deviceGeneration === capture.deviceGeneration &&
      observation.graphGeneration === capture.graphGeneration &&
      sample.frameNumber === workRow.recordFrameNumber &&
      sample.deviceGeneration === capture.deviceGeneration &&
      sample.graphGeneration === capture.graphGeneration
    );
  }
  const observation = workRow.observation;
  return (
    observation.status === 'unavailable' &&
    observation.reason === 'awaiting-write' &&
    frameTrace.clusterWork === undefined &&
    workRow.frameTrace.clusterWork === undefined &&
    (frameTrace.graphGeneration === undefined ||
      frameTrace.graphGeneration === capture.graphGeneration) &&
    (workRow.frameTrace.graphGeneration === undefined ||
      workRow.frameTrace.graphGeneration === capture.graphGeneration)
  );
}

function linearCaptureJoinError(input: {
  readonly transport: ForwardGtaoLinearCaptureTransport;
  readonly capture: ForwardGtaoLinearCapture;
  readonly frameTrace: ForwardGtaoFrameTrace | undefined;
  readonly workRow: ForwardGtaoLinearCaptureWorkRow | undefined;
}): Error {
  const { capture } = input;
  return new Error(
    `linear HDR capture ${capture.frameId} has mismatched completed receipt evidence: ${JSON.stringify(
      {
        transport: input.transport,
        capture: {
          receipt: capture.receipt,
          frameId: capture.frameId,
          deviceGeneration: capture.deviceGeneration,
          graphGeneration: capture.graphGeneration,
          textureIdentity: capture.textureIdentity,
          readbackIdentity: capture.readbackIdentity,
          width: capture.width,
          height: capture.height,
        },
        frameTrace: input.frameTrace,
        workRow: input.workRow,
      },
    )}`,
  );
}

export function assertForwardGtaoLinearCaptureJoin(input: {
  readonly transport: ForwardGtaoLinearCaptureTransport;
  readonly capture: ForwardGtaoLinearCapture;
  readonly frameTrace: ForwardGtaoFrameTrace | undefined;
  readonly workRow: ForwardGtaoLinearCaptureWorkRow | undefined;
}): void {
  const { capture, frameTrace, workRow } = input;
  if (
    frameTrace === undefined ||
    workRow === undefined ||
    !linearCaptureReceiptMatchesAttachment(capture) ||
    !linearFrameTraceMatchesCapture(capture, frameTrace) ||
    !linearCaptureWorkRowMatches(capture, frameTrace, workRow) ||
    !linearClusterTransportMatches(input.transport, capture, frameTrace, workRow)
  ) {
    throw linearCaptureJoinError({
      transport: input.transport,
      capture,
      frameTrace,
      workRow,
    });
  }
}

export interface ForwardGtaoStableGraphTargetProjection {
  readonly name: string;
  readonly graphGeneration: number;
  readonly textureIdentity: number;
  readonly descriptor: {
    readonly format: string;
    readonly size: { readonly width: number; readonly height: number };
    readonly usage: number;
    readonly sample: number;
  };
}

export interface ForwardGtaoGraphTargetProjectionInput
  extends ForwardGtaoStableGraphTargetProjection {
  readonly recordFrameNumber: number;
}

export function stableForwardGtaoGraphTargetProjection(
  target: ForwardGtaoGraphTargetProjectionInput,
): ForwardGtaoStableGraphTargetProjection {
  return {
    name: target.name,
    graphGeneration: target.graphGeneration,
    textureIdentity: target.textureIdentity,
    descriptor: {
      format: target.descriptor.format,
      size: {
        width: target.descriptor.size.width,
        height: target.descriptor.size.height,
      },
      usage: target.descriptor.usage,
      sample: target.descriptor.sample,
    },
  };
}

export interface ForwardGtaoByteErrorMetrics {
  readonly count: number;
  readonly maxAbsolute: number;
  readonly meanAbsolute: number;
  readonly rms: number;
}

export interface ForwardGtaoRecordedOwnerWrite {
  readonly resourceHandleId: string;
  readonly calls: number;
  readonly bytes: number;
}

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function bytesPerTexel(format: string): number {
  switch (format) {
    case 'r8unorm':
      return 1;
    case 'r32uint':
      return 4;
    case 'rgba8unorm':
      return 4;
    default:
      throw new Error(`unsupported Forward GTAO readback format ${format}`);
  }
}

function descriptorLabel(
  descriptor: FrameModel['resources'][number]['descriptor'],
): string | undefined {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return undefined;
  }
  if (!('desc' in descriptor)) return undefined;
  const desc = descriptor.desc;
  if (desc === null || typeof desc !== 'object' || Array.isArray(desc)) return undefined;
  if (!('label' in desc)) return undefined;
  return typeof desc.label === 'string' ? desc.label : undefined;
}

function isStandardMainWork(work: FrameModel['works'][number]): boolean {
  return (
    work.pipeline.status === 'available' &&
    work.pipeline.shaders.some(
      (shader) =>
        shader.stage === 'fragment' &&
        ['fs_main', 'fs_opaque', 'fs_transparent'].includes(shader.entryPoint ?? '') &&
        shader.source?.includes('sampleStandardAmbientOcclusion') === true,
    )
  );
}

/** Return the single WGSL source consumed by the captured Standard main draw(s). */
export function recordedStandardMainFragmentSource(model: FrameModel): string {
  const sources = new Set(
    model.works
      .filter(isStandardMainWork)
      .flatMap((work) =>
        work.pipeline.status === 'available'
          ? work.pipeline.shaders.flatMap((shader) =>
              shader.stage === 'fragment' && shader.source !== null ? [shader.source] : [],
            )
          : [],
      ),
  );
  if (sources.size !== 1) {
    throw new Error(`expected one captured Standard fragment source, found ${sources.size}`);
  }
  const [source] = sources;
  if (source === undefined) throw new Error('captured Standard fragment source is missing');
  return source;
}

/** Resolve the real Cluster resource consumed by Standard `fs_main`, then count its tape writes. */
export function recordedClusterOwnerWrite(
  tape: V7Tape,
  model: FrameModel,
  transport: 'storage-buffer' | 'cpu-texture',
): ForwardGtaoRecordedOwnerWrite {
  const resourceKind = transport === 'storage-buffer' ? 'buffer' : 'texture';
  const label = transport === 'storage-buffer' ? 'hdrp-light-data' : 'standard-cluster-tables';
  const namedResources = model.resources.filter(
    (resource) => resource.kind === resourceKind && descriptorLabel(resource.descriptor) === label,
  );
  const mainWorks = model.works.filter(isStandardMainWork);
  const boundResources = namedResources.filter((resource) => {
    const boundIds = new Set([resource.resourceId]);
    if (transport === 'cpu-texture') {
      for (const view of model.resources) {
        if (view.kind !== 'texture-view') continue;
        const descriptor = view.descriptor;
        if (
          descriptor !== null &&
          typeof descriptor === 'object' &&
          !Array.isArray(descriptor) &&
          'kind' in descriptor &&
          'sourceHandleId' in descriptor &&
          descriptor.kind === 'createTextureView' &&
          descriptor.sourceHandleId === resource.resourceId
        ) {
          boundIds.add(view.resourceId);
        }
      }
    }
    return mainWorks.some((work) =>
      work.bindings.some(
        (binding) => binding.resourceId !== null && boundIds.has(binding.resourceId),
      ),
    );
  });
  if (boundResources.length !== 1) {
    throw new Error(
      `expected one bound Standard Cluster ${transport} resource, found ${boundResources.length}`,
    );
  }
  const resourceHandleId = boundResources[0]?.resourceId;
  if (resourceHandleId === undefined) throw new Error(`missing ${label} resource handle`);

  const ownerEvents = tape.events.filter((event) =>
    transport === 'storage-buffer'
      ? event.kind === 'writeBuffer' && event.handleId === resourceHandleId
      : event.kind === 'writeTexture' && event.destination.textureHandleId === resourceHandleId,
  );
  const bytes = ownerEvents.reduce((total, event) => {
    if (event.kind === 'writeBuffer') return total + event.size;
    if (event.kind !== 'writeTexture') return total;
    const extent = textureExtentDimensions(event.size);
    const rowBytes = event.dataLayout.bytesPerRow ?? extent.width * 16;
    const rows = extent.height * extent.depthOrArrayLayers;
    return total + rowBytes * rows;
  }, 0);
  return { resourceHandleId, calls: ownerEvents.length, bytes };
}

function textureExtentDimensions(size: Parameters<RhiQueue['writeTexture']>[3]): {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
} {
  if ('width' in size) {
    return {
      width: size.width,
      height: size.height ?? 1,
      depthOrArrayLayers: size.depthOrArrayLayers ?? 1,
    };
  }
  const [width = 1, height = 1, depthOrArrayLayers = 1] = [...size];
  return { width, height, depthOrArrayLayers };
}

type CurrentGtaoGraphTarget = NonNullable<
  ReturnType<ForwardGtaoCaptureHost['getCurrentGraphTarget']>
>;

interface CompletedTargetAttempt {
  readonly target: CurrentGtaoGraphTarget;
  readonly trace: ForwardGtaoFrameTrace;
}

interface ReadyTargetPreparation {
  readonly target: CurrentGtaoGraphTarget;
  readonly trace: ForwardGtaoFrameTrace;
  readonly receipt: ForwardGtaoCompletedReceipt;
}

function assertCompletedReceipt(completion: unknown): void {
  if (
    typeof completion === 'object' &&
    completion !== null &&
    'ok' in completion &&
    completion.ok === false &&
    'error' in completion
  ) {
    throw completion.error;
  }
}

function assertTargetIdentityUnchanged(
  name: string,
  before: CurrentGtaoGraphTarget,
  after: CurrentGtaoGraphTarget | undefined,
  expectedRecordFrameNumber: number,
  receipt: ForwardGtaoCompletedReceipt,
  trace: ForwardGtaoFrameTrace,
): asserts after is CurrentGtaoGraphTarget {
  if (
    after === undefined ||
    after.recordFrameNumber !== expectedRecordFrameNumber ||
    after.graphGeneration !== before.graphGeneration ||
    after.textureIdentity !== before.textureIdentity ||
    after.descriptor.format !== before.descriptor.format ||
    after.descriptor.size.width !== before.descriptor.size.width ||
    after.descriptor.size.height !== before.descriptor.size.height ||
    after.descriptor.usage !== before.descriptor.usage ||
    after.descriptor.sample !== before.descriptor.sample
  ) {
    throw new Error(
      `${name} graph target changed before record frame ${expectedRecordFrameNumber} / public receipt ${receipt.frameId} readback completed; trace=${JSON.stringify(trace)}`,
    );
  }
}

function assertTargetCaptureTrace(
  name: string,
  target: CurrentGtaoGraphTarget,
  receipt: ForwardGtaoCompletedReceipt,
  trace: ForwardGtaoFrameTrace,
  expectedRecordFrameNumber: number,
): void {
  if (
    trace.recordFrameNumber !== expectedRecordFrameNumber ||
    trace.recordStatus !== 'submitted' ||
    trace.observationFrameId !== receipt.frameId ||
    trace.graphTargetCopy?.targetName !== name ||
    trace.graphTargetCopy.recordFrameNumber !== expectedRecordFrameNumber ||
    trace.graphTargetCopy.encoded !== true ||
    trace.graphTargetCopy.expectedIdentity?.graphGeneration !== target.graphGeneration ||
    trace.graphTargetCopy.expectedIdentity.recordFrameNumber !== expectedRecordFrameNumber ||
    trace.graphTargetCopy.expectedIdentity.textureIdentity !== target.textureIdentity ||
    trace.graphTargetCopy.actualIdentity?.graphGeneration !== target.graphGeneration ||
    trace.graphTargetCopy.actualIdentity.recordFrameNumber !== expectedRecordFrameNumber ||
    trace.graphTargetCopy.actualIdentity.textureIdentity !== target.textureIdentity ||
    trace.receipt?.publicReceiptFrameId !== receipt.frameId ||
    trace.receipt.deviceGeneration !== receipt.deviceGeneration ||
    trace.receipt.presentation !== receipt.presentation ||
    trace.receipt.completion !== 'completed'
  ) {
    throw new Error(
      `${name} copy/receipt attempt trace did not match record frame ${expectedRecordFrameNumber} and public receipt ${receipt.frameId}: ${JSON.stringify(trace)}`,
    );
  }
}

async function validateTargetCaptureAttempt(
  host: ForwardGtaoCaptureHost,
  name: ForwardGtaoTargetName,
  target: CurrentGtaoGraphTarget,
  receipt: ForwardGtaoCompletedReceipt,
  expectedRecordFrameNumber: number,
): Promise<CompletedTargetAttempt> {
  assertCompletedReceipt(await receipt.completed);
  const trace = host.clusterWorkFrameTraceForConformance();
  if (receipt.presentation !== 'ready') {
    throw new ForwardGtaoCaptureNotReadyError(name, receipt.frameId, receipt.presentation, trace);
  }
  if (trace === undefined) {
    throw new Error(`${name} missing opt-in frame trace for public receipt ${receipt.frameId}`);
  }
  const completedTarget = host.getCurrentGraphTarget(name);
  assertTargetIdentityUnchanged(
    name,
    target,
    completedTarget,
    expectedRecordFrameNumber,
    receipt,
    trace,
  );
  assertTargetCaptureTrace(name, completedTarget, receipt, trace, expectedRecordFrameNumber);
  return { target: completedTarget, trace };
}

export const validateForwardGtaoTargetAttempt = validateTargetCaptureAttempt;

async function prepareTargetCapture(
  host: ForwardGtaoCaptureHost,
  name: ForwardGtaoCaptureTargetName,
  receipt: ForwardGtaoCompletedReceipt,
): Promise<ReadyTargetPreparation> {
  await assertCompletedReceipt(await receipt.completed);
  const trace = host.clusterWorkFrameTraceForConformance();
  if (receipt.presentation !== 'ready') {
    throw new ForwardGtaoCaptureNotReadyError(name, receipt.frameId, receipt.presentation, trace);
  }
  if (trace === undefined) {
    throw new Error(
      `${name} preparation frame is missing conformance trace for receipt ${receipt.frameId}`,
    );
  }
  const target = host.getCurrentGraphTarget(name);
  if (target === undefined) throw new Error(`missing graph target ${name} after preparation frame`);
  if (
    trace.recordStatus !== 'submitted' ||
    trace.recordFrameNumber !== target.recordFrameNumber ||
    trace.observationFrameId !== receipt.frameId ||
    trace.receipt?.publicReceiptFrameId !== receipt.frameId ||
    trace.receipt.deviceGeneration !== receipt.deviceGeneration ||
    trace.receipt.presentation !== receipt.presentation ||
    trace.receipt.completion !== 'completed' ||
    (trace.graphGeneration !== undefined && trace.graphGeneration !== target.graphGeneration) ||
    (target.descriptor.usage & GPU_TEXTURE_USAGE_COPY_SRC) === 0
  ) {
    throw new Error(
      `${name} preparation target and completed receipt disagree: ${JSON.stringify({
        target: {
          recordFrameNumber: target.recordFrameNumber,
          graphGeneration: target.graphGeneration,
          textureIdentity: target.textureIdentity,
          format: target.descriptor.format,
          size: target.descriptor.size,
          usage: target.descriptor.usage,
        },
        receipt: {
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          presentation: receipt.presentation,
        },
        trace,
      })}`,
    );
  }
  return { target, trace, receipt };
}

async function readTargetCaptureBytes(
  host: ForwardGtaoCaptureHost,
  buffer: Buffer,
  width: number,
  height: number,
  bytesPerTexel: number,
  bytesPerRow: number,
): Promise<Uint8Array> {
  await host.device.queue.onSubmittedWorkDone();
  const mapped = value(await buffer.mapAsync(GPU_MAP_MODE_READ));
  const range = value(mapped.getMappedRange());
  const padded = new Uint8Array(range.slice(0));
  mapped.unmap();
  const bytes = new Uint8Array(width * height * bytesPerTexel);
  for (let y = 0; y < height; y += 1) {
    bytes.set(
      padded.subarray(y * bytesPerRow, y * bytesPerRow + width * bytesPerTexel),
      y * width * bytesPerTexel,
    );
  }
  return bytes;
}

export async function captureForwardGtaoTarget(
  host: ForwardGtaoCaptureHost,
  name: ForwardGtaoCaptureTargetName,
  draw: () => Promise<ForwardGtaoCompletedReceipt>,
): Promise<ForwardGtaoTargetCapture> {
  const preparedReceipt = await draw();
  const preparation = await prepareTargetCapture(host, name, preparedReceipt);
  const { target } = preparation;
  const texelBytes = bytesPerTexel(target.descriptor.format);
  const { width, height } = target.descriptor.size;
  const expectedRecordFrameNumber = preparation.trace.recordFrameNumber + 1;
  if (!Number.isSafeInteger(expectedRecordFrameNumber)) {
    throw new Error(
      `${name} preparation record frame cannot bind the next copy attempt: ${JSON.stringify({
        preparationRecordFrameNumber: preparation.trace.recordFrameNumber,
        preparationReceiptFrameId: preparedReceipt.frameId,
      })}`,
    );
  }
  const alignedBytesPerRow = Math.ceil((width * texelBytes) / 256) * 256;
  const buffer = value(
    host.device.createBuffer({
      label: `forward-gtao.${name}.readback`,
      size: alignedBytesPerRow * height,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    }),
  );
  let receipt: ForwardGtaoCompletedReceipt | undefined;
  let request: Parameters<RendererLegacyHostAdapter['requestGraphTargetCapture']>[0] | undefined;
  try {
    request = {
      name,
      buffer,
      bytesPerRow: alignedBytesPerRow,
      width,
      height,
      expected: {
        format: target.descriptor.format,
        width,
        height,
        usage: GPU_TEXTURE_USAGE_COPY_SRC,
        identity: {
          graphGeneration: target.graphGeneration,
          recordFrameNumber: expectedRecordFrameNumber,
          textureIdentity: target.textureIdentity,
        },
      },
    };
    host.requestGraphTargetCapture(request);
    receipt = await draw();
    const attempt = await validateTargetCaptureAttempt(
      host,
      name,
      target,
      receipt,
      expectedRecordFrameNumber,
    );
    const completedTarget = attempt.target;
    const bytes = await readTargetCaptureBytes(
      host,
      buffer,
      width,
      height,
      texelBytes,
      alignedBytesPerRow,
    );
    return {
      name,
      format: completedTarget.descriptor.format,
      width,
      height,
      bytesPerTexel: texelBytes,
      usage: completedTarget.descriptor.usage,
      sample: completedTarget.descriptor.sample,
      targetRecordFrameNumber: completedTarget.recordFrameNumber,
      deviceGeneration: receipt.deviceGeneration,
      publicReceiptFrameId: receipt.frameId,
      graphGeneration: completedTarget.graphGeneration,
      textureIdentity: completedTarget.textureIdentity,
      preparation: {
        recordFrameNumber: preparation.trace.recordFrameNumber,
        publicReceiptFrameId: preparedReceipt.frameId,
        deviceGeneration: preparedReceipt.deviceGeneration,
        graphGeneration: target.graphGeneration,
        textureIdentity: target.textureIdentity,
        descriptor: {
          format: target.descriptor.format,
          size: {
            width: target.descriptor.size.width,
            height: target.descriptor.size.height,
          },
          usage: target.descriptor.usage,
          sample: target.descriptor.sample,
        },
      },
      frameTrace: attempt.trace,
      bytes,
    };
  } finally {
    if (request !== undefined) host.cancelGraphTargetCapture(request);
    value(await host.device.destroyBuffer(buffer));
  }
}

/** Copy an explicitly test-owned feature buffer after its producing receipt completed. */
export async function captureForwardGtaoBuffer(
  host: ForwardGtaoCaptureHost,
  source: Buffer,
  byteLength: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength % 4 !== 0) {
    throw new Error(`invalid Forward GTAO feature readback size ${byteLength}`);
  }
  const readback = value(
    host.device.createBuffer({
      label: 'forward-gtao.scene-data-consumer.readback',
      size: byteLength,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    }),
  );
  try {
    const encoder = value(
      host.device.createCommandEncoder({ label: 'forward-gtao.scene-data-consumer.copy' }),
    );
    encoder.copyBufferToBuffer(source, 0, readback, 0, byteLength);
    const command = value(encoder.finish());
    value(host.device.queue.submit([command]));
    await host.device.queue.onSubmittedWorkDone();
    const mapped = value(await readback.mapAsync(GPU_MAP_MODE_READ));
    try {
      const range = value(mapped.getMappedRange());
      return new Uint8Array(range.slice(0));
    } finally {
      mapped.unmap();
    }
  } finally {
    value(await host.device.destroyBuffer(readback));
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  stableBytes.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', stableBytes.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export function channelBytes(capture: ForwardGtaoTargetCapture, channel: number): Uint8Array {
  if (channel < 0 || channel >= capture.bytesPerTexel) {
    throw new Error(`channel ${channel} is outside ${capture.name} texel width`);
  }
  const bytes = new Uint8Array(capture.width * capture.height);
  for (let pixel = 0; pixel < bytes.length; pixel += 1) {
    bytes[pixel] = capture.bytes[pixel * capture.bytesPerTexel + channel] ?? 0;
  }
  return bytes;
}

export async function captureForwardGtaoLinearHdr(
  renderer: Pick<Renderer, 'observe' | 'requestObservation'>,
  draw: () => Promise<FrameReceipt>,
): Promise<ForwardGtaoLinearCapture> {
  if (renderer.requestObservation === undefined) {
    throw new Error('renderer does not support receipt-bound linear HDR observations');
  }
  value(renderer.requestObservation(['linear-hdr']));
  const receipt = await draw();
  value(await receipt.completed);
  if (receipt.presentation !== 'ready') {
    throw new ForwardGtaoLinearCaptureNotReadyError(receipt.frameId, receipt.presentation);
  }
  const observed = value(
    await renderer.observe(receipt, { include: ['linear-hdr', 'timings', 'draws'] }),
  );
  const attachment = observed.observations?.find((entry) => entry.domain === 'linear-hdr');
  if (attachment === undefined)
    throw new Error(`linear HDR observation missing for ${receipt.frameId}`);
  if (attachment.metadata.frameId !== receipt.frameId) {
    throw new Error(
      `linear HDR observation frame mismatch ${attachment.metadata.frameId} != ${receipt.frameId}`,
    );
  }
  if (attachment.metadata.deviceGeneration !== receipt.deviceGeneration) {
    throw new Error('linear HDR observation belongs to a different device generation');
  }
  if (
    receipt.graphGeneration !== undefined &&
    attachment.metadata.graphGeneration !== receipt.graphGeneration
  ) {
    throw new Error('linear HDR observation belongs to a different graph generation');
  }
  return {
    receipt: {
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      presentation: receipt.presentation,
      ...(receipt.graphGeneration === undefined
        ? {}
        : { graphGeneration: receipt.graphGeneration }),
      completion: 'completed',
    },
    frameId: receipt.frameId,
    deviceGeneration: receipt.deviceGeneration,
    graphGeneration: attachment.metadata.graphGeneration,
    textureIdentity: attachment.metadata.textureIdentity,
    readbackIdentity: attachment.metadata.readbackIdentity,
    ...(attachment.metadata.backendId === undefined
      ? {}
      : { backendId: attachment.metadata.backendId }),
    format: attachment.metadata.format,
    width: attachment.metadata.width,
    height: attachment.metadata.height,
    bytesPerRow: attachment.metadata.bytesPerRow,
    bytes: attachment.bytes.slice(),
    gpuTimings: observed.timings,
    draws: observed.draws,
  };
}

export function rgba16FloatRgb(capture: ForwardGtaoLinearCapture): Float32Array {
  if (capture.format !== 'rgba16float') {
    throw new Error(`expected rgba16float linear HDR, got ${capture.format}`);
  }
  const output = new Float32Array(capture.width * capture.height * 3);
  const view = new DataView(
    capture.bytes.buffer,
    capture.bytes.byteOffset,
    capture.bytes.byteLength,
  );
  for (let y = 0; y < capture.height; y += 1) {
    for (let x = 0; x < capture.width; x += 1) {
      const sourceOffset = y * capture.bytesPerRow + x * 8;
      const destinationOffset = (y * capture.width + x) * 3;
      output[destinationOffset] = halfToFloat(view.getUint16(sourceOffset, true));
      output[destinationOffset + 1] = halfToFloat(view.getUint16(sourceOffset + 2, true));
      output[destinationOffset + 2] = halfToFloat(view.getUint16(sourceOffset + 4, true));
    }
  }
  return output;
}

export function rgba16FloatPixel(
  capture: ForwardGtaoLinearCapture,
  x: number,
  y: number,
): readonly [number, number, number] {
  if (x < 0 || y < 0 || x >= capture.width || y >= capture.height) {
    throw new Error(`linear HDR pixel ${x},${y} is outside ${capture.width}x${capture.height}`);
  }
  const view = new DataView(
    capture.bytes.buffer,
    capture.bytes.byteOffset,
    capture.bytes.byteLength,
  );
  const offset = y * capture.bytesPerRow + x * 8;
  return [
    halfToFloat(view.getUint16(offset, true)),
    halfToFloat(view.getUint16(offset + 2, true)),
    halfToFloat(view.getUint16(offset + 4, true)),
  ];
}

export function linearErrorMetrics(actual: Float32Array, expected: Float32Array) {
  if (actual.length !== expected.length)
    throw new Error('linear HDR arrays must have equal lengths');
  let maxAbsolute = 0;
  let maxRelative = 0;
  let squareSum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = expected[index] ?? 0;
    const error = Math.abs(left - right);
    maxAbsolute = Math.max(maxAbsolute, error);
    maxRelative = Math.max(maxRelative, error / Math.max(Math.abs(right), 0.05));
    squareSum += error * error;
  }
  return {
    count: actual.length,
    maxAbsolute,
    maxRelative,
    rmsAbsolute: Math.sqrt(squareSum / Math.max(actual.length, 1)),
  };
}

export function byteErrorMetrics(
  actual: Uint8Array,
  expected: Uint8Array,
): ForwardGtaoByteErrorMetrics {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`byte arrays differ in size: ${actual.byteLength} != ${expected.byteLength}`);
  }
  let maxAbsolute = 0;
  let absoluteSum = 0;
  let squareSum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const error = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
    maxAbsolute = Math.max(maxAbsolute, error);
    absoluteSum += error;
    squareSum += error * error;
  }
  return {
    count: actual.length,
    maxAbsolute,
    meanAbsolute: absoluteSum / Math.max(actual.length, 1),
    rms: Math.sqrt(squareSum / Math.max(actual.length, 1)),
  };
}

export function byteChannel(bytes: Uint8Array, bytesPerTexel: number, channel: number): Uint8Array {
  if (bytesPerTexel < 1 || bytes.byteLength % bytesPerTexel !== 0) {
    throw new Error('byte capture has an invalid texel stride');
  }
  if (!Number.isInteger(channel) || channel < 0 || channel >= bytesPerTexel) {
    throw new Error(`channel ${channel} is outside texel stride ${bytesPerTexel}`);
  }
  const output = new Uint8Array(bytes.byteLength / bytesPerTexel);
  for (let pixel = 0; pixel < output.length; pixel += 1) {
    output[pixel] = bytes[pixel * bytesPerTexel + channel] ?? 0;
  }
  return output;
}

export function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)),
    );
  }
  return btoa(binary);
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}
