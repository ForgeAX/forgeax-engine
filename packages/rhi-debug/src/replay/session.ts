import type { MappedBuffer, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, type Result, textureCompressionFeature } from '@forgeax/engine-types';
import { RECORDED_CAPABILITY_KEYS } from '../capabilities';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import { buildFrameModel, type WorkBinding, type WorkPipeline } from '../frame-model';
import { buildTapeIndex } from '../protocol/tape-index';
import type { BootstrapResource, RhiCallEvent, Tape } from '../protocol/types';
import type { CreateShaderModuleFn } from '../recorder';
import { computeTextureLayout, projectTextureExtent } from '../texel-layout';
import { type BatchReadRequest, type BatchReadResults, readAtWorks } from './batch';
import {
  RECORDED_CAPABILITY_FEATURES,
  requiredReplayDescriptorFeatures,
  usesAccelerationStructures,
} from './device-request';
import {
  encodeAccelerationStructureBuild,
  eventFailure,
  executeEvent,
  type ReplayExecutionContext,
} from './execute';
import { bootstrapBlob } from './execute-support';
import { type WorkOutput, workOutputs } from './outputs';
import { replayThroughWork } from './prefix';
import {
  type ReadbackSubresource,
  type ReplayReadbackResult,
  readReplayResource,
} from './readback';
import { ResourceTable } from './resources';
import { retainedReplayHandles } from './retention';
import { seedDepthInitialData } from './seed-depth';
import { type FrameTiming, timeReplayPasses } from './timing';

export interface ReplayBackend {
  readonly device: RhiDevice;
  readonly createShaderModule: CreateShaderModuleFn;
}

/**
 * `pixels` reads the work's first color output, else its depth attachment,
 * else its first writable storage texture. `outputs` reads every output.
 */
export type InspectField = 'bindings' | 'pipeline' | 'pixels' | 'outputs';

/** One `workOutputs` entry read from the post-work state; failures stay per slot. */
export interface WorkOutputRead extends Omit<WorkOutput, 'request'> {
  readonly result: Result<ReplayReadbackResult, RhiDebugError>;
}

export interface WorkInspection {
  readonly workIndex: number;
  readonly eventIndex: number;
  readonly passIndex: number;
  readonly attachment: ReplayReadbackResult | undefined;
  readonly outputs?: readonly WorkOutputRead[];
  readonly pipeline?: WorkPipeline;
  readonly bindings?: readonly WorkBinding[];
  readonly vertexBuffers?: readonly {
    readonly slot: number;
    readonly bufferHandleId: string;
    readonly offset: number;
    readonly size: number | null;
  }[];
  readonly indexBuffer?: {
    readonly bufferHandleId: string;
    readonly format: string;
    readonly offset: number;
    readonly size: number | null;
  } | null;
  readonly shaders?: WorkPipeline['shaders'];
  readonly resourceIds?: readonly string[];
}

export interface ReplaySession {
  readonly generation: number;
  inspectWork(
    workIndex: number,
    fields?: readonly InspectField[],
    signal?: AbortSignal,
  ): Promise<Result<WorkInspection, RhiDebugError>>;
  readResource(
    resourceId: string,
    subresource?: ReadbackSubresource,
    signal?: AbortSignal,
  ): Promise<Result<ReplayReadbackResult, RhiDebugError>>;
  /**
   * Replay the captured stream through one indexed work item, then read the
   * resource from that exact post-work state.  Unlike readResource(), this is
   * not a bootstrap-only read and therefore can inspect compute/storage
   * outputs produced by the selected work without creating a second tape.
   */
  readResourceAtWork(
    resourceId: string,
    workIndex: number,
    subresource?: ReadbackSubresource,
    signal?: AbortSignal,
  ): Promise<Result<ReplayReadbackResult, RhiDebugError>>;
  /**
   * Read several resources at several works in one call. Reads at the same
   * work share one replay; ascending works share one forward replay split at
   * each requested work. A request without `workIndex` reads bootstrap state.
   * Per-request failures stay in their slot; the outer Result fails only when
   * the replay itself cannot advance.
   */
  readAtWorks(
    requests: readonly BatchReadRequest[],
    signal?: AbortSignal,
  ): Promise<Result<BatchReadResults, RhiDebugError>>;
  /**
   * Replay the whole frame once with replay-owned timestamps around every pass.
   * Needs a replay device with `timestamp-query`; times rank passes on the
   * replay device and do not restate the capture device's frame time.
   */
  timePasses(signal?: AbortSignal): Promise<Result<FrameTiming, RhiDebugError>>;
  dispose(): Promise<Result<void, RhiDebugError>>;
}

export async function openReplay(
  tape: Tape,
  backend: ReplayBackend,
): Promise<Result<ReplaySession, RhiDebugError>> {
  if (tape.header.formatVersion !== 7) {
    return err(
      createRhiDebugError('tape-version-unsupported', {
        foundVersion: tape.header.formatVersion,
        expectedVersion: 7,
      }),
    );
  }
  const capabilityFailure = checkCapabilities(tape, backend.device);
  if (capabilityFailure !== undefined) return err(capabilityFailure);

  const index = buildTapeIndex(tape);
  const model = buildFrameModel(tape);
  const retained = retainedReplayHandles(tape);
  const table = new ResourceTable(backend.device, 0);
  let disposed = false;
  let prepared = false;

  const context: ReplayExecutionContext = {
    device: backend.device,
    queue: backend.device.queue,
    tape,
    table,
    createShaderModule: backend.createShaderModule,
  };

  const reset = async (): Promise<Result<void, RhiDebugError>> => {
    const cleared = table.reset(retained);
    if (!cleared.ok) return cleared;
    prepared = false;
    return ok(undefined);
  };

  const prepare = async (): Promise<Result<void, RhiDebugError>> => {
    if (prepared) return ok(undefined);
    for (let index = 0; index < tape.bootstrap.length; index++) {
      const resource = tape.bootstrap[index];
      if (resource === undefined) continue;
      if (retained.has(resource.handleId) && table.get(resource.handleId) !== undefined) continue;
      const created = await executeBootstrapResource(context, resource, index);
      if (!created.ok) return created;
      const seeded = await seedBootstrapResource(context, resource, index);
      if (!seeded.ok) return seeded;
    }
    prepared = true;
    return ok(undefined);
  };

  const host = {
    context,
    index,
    retained,
    reset: async (): Promise<Result<void, RhiDebugError>> => {
      const cleared = await reset();
      return cleared.ok ? prepare() : cleared;
    },
  };

  const session: ReplaySession = {
    get generation() {
      return table.generation;
    },
    async inspectWork(workIndex, fields, signal) {
      if (disposed) return positionError(workIndex, index.works.length);
      if (signal?.aborted) return positionError(workIndex, index.works.length);
      const work = index.works[workIndex];
      const modelWork = model.works[workIndex];
      if (work === undefined) return positionError(workIndex, index.works.length);
      if (modelWork === undefined) return positionError(workIndex, index.works.length);
      const cleared = await reset();
      if (!cleared.ok) return cleared;
      const bootstrapped = await prepare();
      if (!bootstrapped.ok) return bootstrapped;
      const replayed = await replayThroughWork(context, index, work, retained, signal);
      if (!replayed.ok) return replayed;
      const outputs = workOutputs(modelWork);
      const attachment = fields?.includes('pixels')
        ? await readWorkAttachment(context, outputs)
        : undefined;
      if (attachment !== undefined && !attachment.ok) return attachment;
      const selectedAttachment =
        attachment?.ok === true
          ? {
              ...attachment.value,
              provenance: {
                ...attachment.value.provenance,
                selectedWorkIndex: work.workIndex,
              },
            }
          : undefined;
      const baseInspection = {
        workIndex: work.workIndex,
        eventIndex: work.eventIndex,
        passIndex: work.passIndex,
        attachment: selectedAttachment,
      };
      const outputReads: WorkOutputRead[] = [];
      if (fields?.includes('outputs'))
        for (const { request, ...output } of outputs)
          outputReads.push({
            ...output,
            result: withWork(await readOutput(context, request), work.workIndex),
          });
      return ok({
        ...baseInspection,
        ...(fields?.includes('outputs') ? { outputs: outputReads } : {}),
        ...(fields?.includes('pipeline') ? { pipeline: modelWork.pipeline } : {}),
        ...(fields?.includes('bindings')
          ? {
              bindings: modelWork.bindings,
              vertexBuffers: modelWork.vertexBuffers,
              indexBuffer: modelWork.indexBuffer,
              shaders: modelWork.pipeline.shaders,
              resourceIds: modelWork.bindings
                .map((binding) => binding.resourceId)
                .filter((resourceId): resourceId is string => resourceId !== null),
            }
          : {}),
      });
    },
    async readResource(resourceId, subresource, signal) {
      if (disposed) {
        return err(
          createRhiDebugError('replay-position-invalid', {
            requested: -1,
            available: 0,
          }),
        );
      }
      if (signal?.aborted) {
        return err(
          createRhiDebugError('readback-failed', {
            stage: 'readback',
            cause: 'readback was aborted',
          }),
        );
      }
      const cleared = await reset();
      if (!cleared.ok) return cleared;
      const bootstrapped = await prepare();
      if (!bootstrapped.ok) return bootstrapped;
      return readReplayResource(
        backend.device,
        table,
        resourceId,
        subresource,
        backend.createShaderModule,
      );
    },
    async readResourceAtWork(resourceId, workIndex, subresource, signal) {
      if (disposed) return positionError(workIndex, index.works.length);
      if (signal?.aborted) {
        return err(
          createRhiDebugError('readback-failed', {
            stage: 'readback',
            cause: 'readback was aborted',
          }),
        );
      }
      const work = index.works[workIndex];
      if (work === undefined || model.works[workIndex] === undefined) {
        return positionError(workIndex, index.works.length);
      }
      const cleared = await reset();
      if (!cleared.ok) return cleared;
      const bootstrapped = await prepare();
      if (!bootstrapped.ok) return bootstrapped;
      const replayed = await replayThroughWork(context, index, work, retained, signal);
      if (!replayed.ok) return replayed;
      const read = await readReplayResource(
        backend.device,
        table,
        resourceId,
        subresource,
        backend.createShaderModule,
      );
      if (!read.ok) return read;
      return ok({
        ...read.value,
        provenance: {
          ...read.value.provenance,
          selectedWorkIndex: work.workIndex,
        },
      });
    },
    async readAtWorks(requests, signal) {
      if (disposed) return positionError(-1, index.works.length);
      return readAtWorks(host, requests, signal);
    },
    async timePasses(signal) {
      if (disposed) return positionError(-1, index.works.length);
      return timeReplayPasses(host, signal);
    },
    async dispose() {
      if (disposed) return ok(undefined);
      const result = table.dispose();
      disposed = true;
      prepared = false;
      return result;
    },
  };

  return ok(session);
}

function checkCapabilities(tape: Tape, device: RhiDevice): RhiDebugError | undefined {
  const rayQuery = device.caps.rayQuery;
  if (!rayQuery.supported && usesAccelerationStructures(tape)) {
    return createRhiDebugError('replay-capability-mismatch', {
      stage: 'replay',
      cause: `tape builds acceleration structures; replay device caps.rayQuery is unsupported (${rayQuery.reason})`,
    });
  }
  const missingFeatures = [...requiredReplayDescriptorFeatures(tape)].filter(
    (feature) => !device.features.has(feature),
  );
  if (missingFeatures.length > 0) {
    return createRhiDebugError('replay-capability-mismatch', {
      stage: 'replay',
      cause: `missing device features: ${missingFeatures.join(', ')}`,
    });
  }
  const recorded = tape.header.rhiCaps;
  const required = requiredReplayCapabilities(tape);
  const missing = Object.entries(recorded).filter(([key, value]) => {
    // A recorder snapshots the device's available capabilities, but replay
    // only needs to require a capability when the captured workload can use
    // it. Otherwise a device-wide optional feature (for example ASTC support)
    // makes an unrelated RGBA tape non-portable.
    if (value !== true || (!required.has(key) && RECORDED_CAPABILITY_KEYS.has(key))) return false;
    const target = device.caps[key as keyof typeof device.caps];
    return target !== true;
  });
  if (missing.length === 0) return undefined;
  return createRhiDebugError('replay-capability-mismatch', {
    stage: 'replay',
    cause: `missing capabilities: ${missing.map(([key]) => key).join(', ')}`,
  });
}

function requiredReplayCapabilities(tape: Tape): ReadonlySet<string> {
  const required = new Set<string>();
  const events = [
    ...tape.bootstrap.map((resource) => resource.create as unknown as RhiCallEvent),
    ...tape.events,
  ];
  for (const event of events) {
    switch (event.kind) {
      case 'createTexture': {
        const formats = [event.desc.format, ...(event.desc.viewFormats ?? [])];
        for (const format of formats) {
          const compression = textureCompressionFeature(format);
          const capability = RECORDED_CAPABILITY_FEATURES.find(
            ([, feature]) => feature === compression,
          )?.[0];
          if (capability !== undefined) required.add(capability);
          if (format === 'rgba16float') required.add('rgba16floatRenderable');
          if (format === 'rg11b10ufloat' && (event.desc.usage & 0x10) !== 0) {
            required.add('rg11b10ufloatRenderable');
          }
          if (format === 'r32float' || format === 'rg32float' || format === 'rgba32float') {
            required.add('float32Filterable');
          }
        }
        break;
      }
      case 'createBindGroupLayout':
        if (
          Array.from(event.desc.entries).some(
            (entry) =>
              entry.buffer?.type === 'storage' || entry.buffer?.type === 'read-only-storage',
          )
        ) {
          required.add('storageBuffer');
        }
        break;
      case 'createBuffer':
        // GPUBufferUsage.STORAGE is 0x80 in the WebGPU enum. Keep the replay
        // package independent of the browser-only global constant.
        if ((event.desc.usage & 0x80) !== 0) required.add('storageBuffer');
        break;
      case 'drawIndirect':
      case 'drawIndexedIndirect':
        // GPU-written argument buffers can select a nonzero firstInstance.
        // Preserve the capture device's semantics without inspecting stale seeds.
        required.add('firstInstanceIndirect');
        break;
      default:
        break;
    }
  }
  return required;
}

async function executeBootstrapResource(
  context: ReplayExecutionContext,
  resource: BootstrapResource,
  bootstrapIndex: number,
): Promise<Result<void, RhiDebugError>> {
  const event = resource.create as unknown as RhiCallEvent;
  // Captured GPU-written buffers need not allow COPY_DST. Restore their
  // initial bytes through creation mapping, which is legal for every usage
  // (including MAP_WRITE, where adding COPY_DST would itself be invalid).
  const replayEvent =
    event.kind === 'createBuffer' && resource.initialData.length > 0
      ? { ...event, desc: { ...event.desc, mappedAtCreation: true } }
      : event;
  const result = await executeEvent(context, replayEvent, -bootstrapIndex - 1);
  return result;
}

async function seedBootstrapResource(
  context: ReplayExecutionContext,
  resource: BootstrapResource,
  bootstrapIndex: number,
): Promise<Result<void, RhiDebugError>> {
  const create = resource.create as unknown as RhiCallEvent;
  if (
    (create.kind === 'createBlas' || create.kind === 'createTlas') &&
    create.build !== undefined &&
    create.build !== null
  ) {
    const rebuilt = rebuildBootstrapAccelerationStructure(context, create, bootstrapIndex);
    if (!rebuilt.ok) return rebuilt;
    await context.queue.onSubmittedWorkDone();
    return rebuilt;
  }
  if (resource.initialData.length === 0) return ok(undefined);
  const entry = context.table.get(resource.handleId);
  const event = resource.create as unknown as RhiCallEvent;
  if (entry?.resource.kind === 'texture' && event.kind === 'createTexture') {
    return seedTextureInitialData(context, entry.resource.value, event, resource, bootstrapIndex);
  }
  if (entry?.resource.kind !== 'buffer') {
    return eventFailure(
      -bootstrapIndex - 1,
      event,
      'lookup',
      'bootstrap initialData requires a buffer or supported texture resource',
    );
  }
  // executeBootstrapResource created this buffer mapped specifically for
  // restoration. It must be unmapped before any recorded work can consume it.
  const mapped = entry.resource.value as MappedBuffer;
  // RhiNull deliberately exposes opaque structural handles rather than a
  // CPU-visible mapping implementation. Its replay bytes have no observable
  // storage, so there is nothing to seed; real backends always provide the
  // MappedBuffer methods below and still take the strict mapping path.
  if (
    typeof (mapped as Partial<MappedBuffer>).getMappedRange !== 'function' ||
    typeof (mapped as Partial<MappedBuffer>).unmap !== 'function'
  ) {
    if (context.device.caps.backendKind === 'null') return ok(undefined);
    return eventFailure(
      -bootstrapIndex - 1,
      event,
      'write',
      'bootstrap buffer mapping is unavailable on the replay backend',
    );
  }
  try {
    const range = mapped.getMappedRange();
    if (!range.ok) return eventFailure(-bootstrapIndex - 1, event, 'write', range.error);
    const target = new Uint8Array(range.value);
    for (const slice of resource.initialData) {
      const bytes = bootstrapBlob(context.tape, slice, event, -bootstrapIndex - 1);
      if (!bytes.ok) return bytes;
      if (slice.byteLength > target.byteLength) {
        return eventFailure(-bootstrapIndex - 1, event, 'write', 'initialData exceeds buffer size');
      }
      target.set(bytes.value);
    }
  } finally {
    mapped.unmap();
  }
  return ok(undefined);
}

/**
 * Restore an acceleration structure's capture-start build. Topological
 * bootstrap order has already created and seeded its geometry buffers and BLAS.
 */
function rebuildBootstrapAccelerationStructure(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createBlas' | 'createTlas' }>,
  bootstrapIndex: number,
): Result<void, RhiDebugError> {
  const eventIndex = -bootstrapIndex - 1;
  const encoder = context.device.createCommandEncoder({ label: 'rhi-debug:bootstrap-as-build' });
  if (!encoder.ok) return eventFailure(eventIndex, event, 'encode', encoder.error);
  const encoded =
    event.kind === 'createBlas'
      ? encodeAccelerationStructureBuild(
          context,
          encoder.value,
          event.build === undefined ? [] : [{ blasHandleId: event.handleId, ...event.build }],
          [],
          event,
          eventIndex,
        )
      : encodeAccelerationStructureBuild(
          context,
          encoder.value,
          [],
          event.build === undefined ? [] : [{ tlasHandleId: event.handleId, ...event.build }],
          event,
          eventIndex,
        );
  if (!encoded.ok) return encoded;
  const finished = encoder.value.finish();
  if (!finished.ok) return eventFailure(eventIndex, event, 'finish', finished.error);
  const submitted = context.queue.submit([finished.value]);
  return submitted.ok ? ok(undefined) : eventFailure(eventIndex, event, 'submit', submitted.error);
}

async function seedTextureInitialData(
  context: ReplayExecutionContext,
  texture: import('@forgeax/engine-rhi').Texture,
  event: Extract<RhiCallEvent, { kind: 'createTexture' }>,
  resource: BootstrapResource,
  bootstrapIndex: number,
): Promise<Result<void, RhiDebugError>> {
  const extent = projectTextureExtent(event.desc.size);
  if (extent === undefined)
    return eventFailure(
      -bootstrapIndex - 1,
      event,
      'lookup',
      'the texture descriptor has invalid dimensions',
    );
  const layout = computeTextureLayout(
    event.desc.format,
    extent.width,
    extent.height,
    extent.layerCount,
    event.desc.mipLevelCount ?? 1,
  );
  if (layout === undefined) {
    return eventFailure(
      -bootstrapIndex - 1,
      event,
      'lookup',
      `texture format '${event.desc.format}' has no known bootstrap byte layout`,
    );
  }
  for (const slice of resource.initialData) {
    const initial = bootstrapBlob(context.tape, slice, event, -bootstrapIndex - 1);
    if (!initial.ok) return initial;
    const bytes = initial.value;
    if (bytes.byteLength !== layout.totalBytes) {
      return eventFailure(
        -bootstrapIndex - 1,
        event,
        'lookup',
        `texture initialData has ${bytes.byteLength} bytes; expected ${layout.totalBytes}`,
      );
    }
    if (event.desc.format === 'depth32float') {
      const restored = await seedDepthInitialData(
        context,
        texture,
        event,
        bytes,
        layout,
        bootstrapIndex,
      );
      if (!restored.ok) return restored;
      continue;
    }
    for (const subresource of layout.slices) {
      const rowBytes = Math.ceil(subresource.width / layout.blockWidth) * layout.bytesPerBlock;
      const rowCount = Math.ceil(subresource.height / layout.blockHeight);
      const subresourceBytes = bytes.subarray(
        subresource.byteOffset,
        subresource.byteOffset + subresource.byteLength,
      );
      const written = context.queue.writeTexture(
        {
          texture,
          mipLevel: subresource.mip,
          origin: { x: 0, y: 0, z: subresource.layer },
          aspect: 'all',
        } as never,
        subresourceBytes,
        { offset: 0, bytesPerRow: rowBytes, rowsPerImage: rowCount },
        {
          width: Math.ceil(subresource.width / layout.blockWidth) * layout.blockWidth,
          height: Math.ceil(subresource.height / layout.blockHeight) * layout.blockHeight,
          depthOrArrayLayers: 1,
        },
      );
      if (!written.ok) {
        return eventFailure(-bootstrapIndex - 1, event, 'write', written.error);
      }
    }
  }
  return ok(undefined);
}

function positionError(requested: number, available: number): Result<never, RhiDebugError> {
  return err(
    createRhiDebugError('replay-position-invalid', {
      requested,
      available,
    }),
  );
}

async function readWorkAttachment(
  context: ReplayExecutionContext,
  outputs: readonly WorkOutput[],
): Promise<Result<ReplayReadbackResult, RhiDebugError>> {
  const selected =
    outputs.find((output) => output.role === 'color') ??
    outputs.find((output) => output.role === 'depth') ??
    outputs.find((output) => output.role === 'storage-texture');
  if (selected === undefined) {
    return err(
      createRhiDebugError('readback-unsupported', {
        stage: 'readback',
        reason: 'work has no color, depth or storage texture output',
      }),
    );
  }
  return readOutput(context, selected.request);
}

function readOutput(
  context: ReplayExecutionContext,
  request: WorkOutput['request'],
): Promise<Result<ReplayReadbackResult, RhiDebugError>> {
  return readReplayResource(
    context.device,
    context.table,
    request.resourceId,
    request.subresource,
    context.createShaderModule,
  );
}

function withWork(
  read: Result<ReplayReadbackResult, RhiDebugError>,
  workIndex: number,
): Result<ReplayReadbackResult, RhiDebugError> {
  if (!read.ok) return read;
  return ok({
    ...read.value,
    provenance: { ...read.value.provenance, selectedWorkIndex: workIndex },
  });
}

export { type BatchReadRequest, type BatchReadResults, bindingReadRequest } from './batch';
export { type WorkOutput, workOutputs } from './outputs';
export type {
  BufferReadbackRange,
  ReadbackSubresource,
  ReplayReadbackResult,
  TextureSubresource,
} from './readback';
export type { FrameTiming, PassTiming } from './timing';
