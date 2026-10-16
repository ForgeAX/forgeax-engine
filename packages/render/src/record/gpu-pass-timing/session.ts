import type {
  BindGroup,
  Buffer,
  ComputePassDescriptor,
  ComputePipeline,
  MappedBuffer,
  QuerySet,
  RhiCommandEncoder,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { PipelineBuilderShaderModuleFactory } from '../../pipeline-builder.js';
import {
  createGpuPassTimingFrame,
  freezeGpuPassTimingFrame,
  type GpuPassTimingEntry,
  type GpuPassTimingFrame,
  type GpuPassTimingObservation,
  type GpuPassTimingOptions,
  type GpuPassTimingPassIdentity,
  type NormalizedGpuPassTimingOptions,
  normalizeGpuPassTimingOptions,
} from './contract.js';
import type { GpuPassTimingReason } from './errors.js';
import { parseGpuPassTimingTicks } from './parser.js';

const GPU_BUFFER_USAGE_MAP_READ = 0x01;
const GPU_BUFFER_USAGE_COPY_SRC = 0x04;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200;
const GPU_MAP_MODE_READ = 0x01;
const QUERY_RESOLVE_ALIGNMENT = 256;
const QUERY_RESULT_BYTES = 8;

export function prepareGpuPassTimingSession(
  device: RhiDevice,
  options: GpuPassTimingOptions | undefined,
  shaderModuleFactory: PipelineBuilderShaderModuleFactory | undefined,
): {
  readonly gpuPassTimingSession?: GpuPassTimingSession | undefined;
  readonly gpuPassTimingUnavailable?: GpuPassTimingObservation | undefined;
} {
  if (options === undefined) return {};
  const created = createGpuPassTimingSession(device, options, { shaderModuleFactory });
  if (created.ok) return { gpuPassTimingSession: created.value };
  return {
    gpuPassTimingUnavailable: {
      status: 'unavailable',
      reason: created.error,
      capability: {
        timestampQuery: device.caps.timestampQuery,
        timestampPeriodNanoseconds: device.caps.timestampPeriodNanoseconds,
      },
    },
  };
}

export interface GpuPassTimingFrameIdentity {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
}

export interface GpuPassTimingSessionOptions {
  readonly shaderModuleFactory?: PipelineBuilderShaderModuleFactory | undefined;
  readonly mapReadback?: ((buffer: Buffer) => Promise<Result<MappedBuffer, unknown>>) | undefined;
}

export interface GpuPassTimingCapture {
  readonly frameId: number;
  readonly nextExecutionIndex: number;
  recordPass(identity: GpuPassTimingPassIdentity):
    | {
        readonly querySet: QuerySet;
        readonly beginningOfPassWriteIndex: number;
        readonly endOfPassWriteIndex: number;
      }
    | undefined;
  markOwnerConflict(identity: GpuPassTimingPassIdentity): void;
  markTimestampWriteFailure(
    identity: GpuPassTimingPassIdentity,
    phase: 'begin' | 'end',
    cause: unknown,
  ): void;
  copyBoundaryBefore(identity: GpuPassTimingPassIdentity, encoder: RhiCommandEncoder): void;
  copyBoundaryAfter(identity: GpuPassTimingPassIdentity, encoder: RhiCommandEncoder): void;
  timestampWrites(identity: GpuPassTimingPassIdentity):
    | {
        readonly querySet: QuerySet;
        readonly beginningOfPassWriteIndex: number;
        readonly endOfPassWriteIndex: number;
      }
    | undefined;
  encodeTail(
    encoder: RhiCommandEncoder,
    graphGeneration?: number,
  ): Result<void, GpuPassTimingReason>;
  markSubmitted(completion?: Promise<void>): void;
  snapshot(): GpuPassTimingFrame;
  observe(): Promise<Result<GpuPassTimingFrame, GpuPassTimingReason>>;
  abort(cause?: { readonly code?: string | undefined }): void;
}

export interface GpuPassTimingSession {
  readonly options: NormalizedGpuPassTimingOptions;
  beginFrame(
    identity: GpuPassTimingFrameIdentity,
  ): Result<GpuPassTimingCapture, GpuPassTimingReason>;
  dispose(): void;
}

interface Slot {
  readonly queryCount: number;
  readonly querySet: QuerySet;
  readonly markerQuerySet: QuerySet;
  readonly lastMarkerTicks: Array<string | undefined>;
  readonly resolveBuffer: Buffer;
  readonly readbackBuffer: Buffer;
  readonly storage: CaptureStorage;
  state: 'idle' | 'encoding' | 'submitted' | 'terminal';
  capture?: CaptureState | undefined;
}

interface CaptureStorage {
  readonly entries: CaptureEntry[];
  readonly queryPairs: CaptureQueryPair[];
  readonly entryIndexesByExecutionIndex: Array<number | undefined>;
  readonly timestampWrites: CaptureTimestampWrites[];
  readonly copyBeginningMarkerWrites: CaptureMarkerWrites;
  readonly copyEndMarkerWrites: CaptureMarkerWrites;
  readonly copyBeginningMarkerDescriptor: ComputePassDescriptor;
  readonly copyEndMarkerDescriptor: ComputePassDescriptor;
}

interface CaptureState {
  readonly identity: GpuPassTimingFrameIdentity;
  graphGeneration: number;
  readonly backendKind: RhiDevice['caps']['backendKind'];
  readonly timestampPeriodNanoseconds: number;
  readonly slot: Slot;
  readonly entries: CaptureEntry[];
  readonly queryPairs: CaptureQueryPair[];
  readonly entryIndexesByExecutionIndex: Array<number | undefined>;
  readonly layout: CaptureLayout | undefined;
  layoutCandidateValid: boolean;
  nextQueryIndex: number;
  droppedPassCount: number;
  timedPassCount: number;
  terminal: Result<GpuPassTimingFrame, GpuPassTimingReason> | undefined;
  submitted: Promise<void> | undefined;
}

type CaptureEntry = GpuPassTimingPassIdentity | GpuPassTimingEntry;

interface CaptureQueryPair {
  beginningQueryIndex: number;
  endQueryIndex: number;
  requiresBeginningMarker: boolean;
  requiresEndMarker: boolean;
  needsBeginningMarker: boolean;
  needsEndMarker: boolean;
}

interface CaptureTimestampWrites {
  querySet: QuerySet;
  beginningOfPassWriteIndex: number;
  endOfPassWriteIndex: number;
}

interface CaptureMarkerWrites {
  readonly querySet: QuerySet;
  beginningOfPassWriteIndex?: number | undefined;
  endOfPassWriteIndex?: number | undefined;
}

interface CaptureLayoutEntry {
  readonly identity: GpuPassTimingPassIdentity;
  readonly beginningQueryIndex: number;
  readonly endQueryIndex: number;
  readonly requiresBeginningMarker: boolean;
  readonly requiresEndMarker: boolean;
}

interface CaptureLayout {
  readonly graphGeneration: number;
  readonly queryCount: number;
  readonly entries: readonly CaptureLayoutEntry[];
}

function isTimingEntry(entry: CaptureEntry): entry is GpuPassTimingEntry {
  return 'status' in entry;
}

function isGenericEntry(entry: CaptureEntry | undefined): entry is GpuPassTimingPassIdentity {
  return entry !== undefined && !isTimingEntry(entry);
}

function reason(
  code: GpuPassTimingReason['code'],
  expected: string,
  hint: string,
  detail: { readonly [key: string]: null | boolean | number | string },
): GpuPassTimingReason {
  return { code, expected, hint, detail };
}

function causeDetail(value: unknown): { readonly [key: string]: null | boolean | number | string } {
  if (typeof value === 'object' && value !== null) {
    const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined;
    const message = value instanceof Error ? value.message : undefined;
    return {
      type: 'rhi-failure',
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
    };
  }
  return { type: typeof value };
}

function alignedReadbackSize(queryCount: number): number {
  return (
    Math.ceil((queryCount * QUERY_RESULT_BYTES) / QUERY_RESOLVE_ALIGNMENT) * QUERY_RESOLVE_ALIGNMENT
  );
}

function readTick(bytes: ArrayBuffer, index: number): string {
  const view = new DataView(bytes, index * QUERY_RESULT_BYTES, QUERY_RESULT_BYTES);
  return view.getBigUint64(0, true).toString(10);
}

function createResourceFailure(error: unknown, operation: string): GpuPassTimingReason {
  return reason(
    'timestamp-readback-failed',
    `${operation} succeeds for the timing slot resource`,
    'wait for a later receipt and inspect the structured timing failure',
    { operation, cause: JSON.stringify(causeDetail(error)) },
  );
}

function createSlot(
  device: RhiDevice,
  options: NormalizedGpuPassTimingOptions,
): Result<Slot, GpuPassTimingReason> {
  const queryCount = options.maxPassesPerFrame * 2;
  const querySet = device.createQuerySet({ type: 'timestamp', count: queryCount });
  if (!querySet.ok) {
    return err(
      reason(
        'timestamp-query-unsupported',
        'the active device creates a timestamp query set',
        'use a backend with timestamp-query support or keep timing disabled',
        { cause: querySet.error.code },
      ),
    );
  }
  const markerQuerySet = device.createQuerySet({ type: 'timestamp', count: queryCount });
  if (!markerQuerySet.ok) {
    device.destroyQuerySet(querySet.value);
    return err(createResourceFailure(markerQuerySet.error, 'copy marker query set creation'));
  }
  const resolveBuffer = device.createBuffer({
    size: alignedReadbackSize(queryCount) * 2,
    usage: GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC,
  });
  if (!resolveBuffer.ok) {
    device.destroyQuerySet(querySet.value);
    device.destroyQuerySet(markerQuerySet.value);
    return err(createResourceFailure(resolveBuffer.error, 'resolve buffer creation'));
  }
  const readbackBuffer = device.createBuffer({
    size: alignedReadbackSize(queryCount) * 2,
    usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
  });
  if (!readbackBuffer.ok) {
    device.destroyBuffer(resolveBuffer.value);
    device.destroyQuerySet(querySet.value);
    device.destroyQuerySet(markerQuerySet.value);
    return err(createResourceFailure(readbackBuffer.error, 'readback buffer creation'));
  }
  const copyBeginningMarkerWrites: CaptureMarkerWrites = {
    querySet: markerQuerySet.value,
    beginningOfPassWriteIndex: 0,
  };
  const copyEndMarkerWrites: CaptureMarkerWrites = {
    querySet: markerQuerySet.value,
    endOfPassWriteIndex: 0,
  };
  return ok({
    queryCount,
    querySet: querySet.value,
    markerQuerySet: markerQuerySet.value,
    lastMarkerTicks: new Array(queryCount),
    resolveBuffer: resolveBuffer.value,
    readbackBuffer: readbackBuffer.value,
    storage: {
      entries: [],
      queryPairs: Array.from({ length: options.maxPassesPerFrame }, () => ({
        beginningQueryIndex: 0,
        endQueryIndex: 0,
        requiresBeginningMarker: false,
        requiresEndMarker: false,
        needsBeginningMarker: false,
        needsEndMarker: false,
      })),
      entryIndexesByExecutionIndex: Array.from(
        { length: options.maxPassesPerFrame },
        () => undefined,
      ),
      timestampWrites: Array.from({ length: options.maxPassesPerFrame }, () => ({
        querySet: querySet.value,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      })),
      copyBeginningMarkerWrites,
      copyEndMarkerWrites,
      copyBeginningMarkerDescriptor: { timestampWrites: copyBeginningMarkerWrites },
      copyEndMarkerDescriptor: { timestampWrites: copyEndMarkerWrites },
    },
    state: 'idle',
  });
}

function makeUnmeasured(identity: GpuPassTimingPassIdentity): GpuPassTimingEntry {
  return {
    ...identity,
    status: 'unmeasured',
    reason: reason(
      'timestamp-write-unavailable',
      'the pass has a reserved timestamp pair',
      'inspect the terminal observation for the readback result',
      { passName: identity.passName },
    ),
  };
}

function makeOwnerConflict(identity: GpuPassTimingPassIdentity): GpuPassTimingEntry {
  return {
    ...identity,
    status: 'unmeasured',
    reason: reason(
      'timestamp-owner-conflict',
      'the pass already has producer-owned timestamp writes',
      'keep the producer timestamps and report this pass without generic timing',
      { passName: identity.passName },
    ),
  };
}

function makeWriteUnavailable(
  identity: GpuPassTimingPassIdentity,
  phase: 'begin' | 'end',
  cause: unknown,
): GpuPassTimingEntry {
  return {
    ...identity,
    status: 'unmeasured',
    reason: {
      ...reason(
        'timestamp-write-unavailable',
        `the ${phase} timestamp write succeeds for the copy pass`,
        'keep this pass unmeasured and inspect a later receipt for timing recovery',
        { passName: identity.passName, phase },
      ),
      cause: causeDetail(cause),
    },
  };
}

function freezeSnapshot(state: CaptureState): GpuPassTimingFrame {
  const passes = state.entries.map((entry) =>
    isTimingEntry(entry) ? { ...entry } : makeUnmeasured(entry),
  );
  return freezeGpuPassTimingFrame(
    createGpuPassTimingFrame({
      ...state.identity,
      graphGeneration: state.graphGeneration,
      backendKind: state.backendKind,
      timestampPeriodNanoseconds: state.timestampPeriodNanoseconds,
      passCapacity: state.slot.queryCount / 2,
      passes,
      droppedPassCount: state.droppedPassCount,
    }),
  );
}

function makeCapture(
  state: CaptureState,
  device: RhiDevice,
  period: number,
  mapReadback: GpuPassTimingSessionOptions['mapReadback'],
  layout: CaptureLayout | undefined,
  publishLayout: (layout: CaptureLayout) => void,
  copyMarker: () => { readonly pipeline: ComputePipeline; readonly bindGroup: BindGroup },
): GpuPassTimingCapture {
  const entryAt = (index: number): CaptureEntry | undefined => state.entries[index];
  const queryPairAt = (index: number): CaptureQueryPair | undefined => state.queryPairs[index];
  const allocateQueryIndex = (): number => {
    const queryIndex = state.nextQueryIndex;
    state.nextQueryIndex += 1;
    return queryIndex;
  };
  const syncTimestampWrites = (index: number): void => {
    const pair = queryPairAt(index);
    const writes = state.slot.storage.timestampWrites[index];
    if (pair === undefined || writes === undefined) return;
    writes.querySet =
      entryAt(index)?.passKind === 'copy' ? state.slot.markerQuerySet : state.slot.querySet;
    writes.beginningOfPassWriteIndex = pair.beginningQueryIndex;
    writes.endOfPassWriteIndex = pair.endQueryIndex;
  };
  const configureDynamicPair = (index: number): void => {
    const entry = entryAt(index);
    const pair = queryPairAt(index);
    if (entry === undefined || pair === undefined) return;
    const beginningQueryIndex = allocateQueryIndex();
    const requiresEndMarker = entry.passKind === 'copy';
    pair.beginningQueryIndex = beginningQueryIndex;
    pair.endQueryIndex = allocateQueryIndex();
    pair.requiresBeginningMarker = entry.passKind === 'copy';
    pair.requiresEndMarker = requiresEndMarker;
    pair.needsBeginningMarker = pair.requiresBeginningMarker;
    pair.needsEndMarker = requiresEndMarker;
    syncTimestampWrites(index);
  };
  const rebuildDynamicLayout = (): void => {
    state.nextQueryIndex = 0;
    for (let index = 0; index < state.entries.length; index += 1) {
      configureDynamicPair(index);
    }
  };
  const markEntry = (index: number, replacement: GpuPassTimingEntry): void => {
    const entry = entryAt(index);
    if (!isGenericEntry(entry)) return;
    state.timedPassCount -= 1;
    state.entries[index] = replacement;
  };
  const recordPass = (
    identity: GpuPassTimingPassIdentity,
  ): ReturnType<GpuPassTimingCapture['recordPass']> => {
    if (state.terminal !== undefined) return;
    if (state.entries.length >= state.slot.queryCount / 2) {
      state.droppedPassCount += 1;
      return;
    }
    const index = state.entries.length;
    const layoutEntry = state.layoutCandidateValid ? layout?.entries[index] : undefined;
    const reusableLayoutEntry =
      layoutEntry !== undefined &&
      layoutEntry.identity.passName === identity.passName &&
      layoutEntry.identity.passKind === identity.passKind &&
      layoutEntry.identity.executionIndex === identity.executionIndex &&
      layoutEntry.identity.viewId === identity.viewId;
    const layoutMismatch =
      layout !== undefined && state.layoutCandidateValid && !reusableLayoutEntry;
    if (layoutMismatch) state.layoutCandidateValid = false;
    state.entries.push(
      reusableLayoutEntry
        ? layoutEntry.identity
        : {
            ...identity,
          },
    );
    state.entryIndexesByExecutionIndex[identity.executionIndex] = index;
    const queryPair = queryPairAt(index);
    if (queryPair === undefined) {
      state.entries.pop();
      state.entryIndexesByExecutionIndex[identity.executionIndex] = undefined;
      state.droppedPassCount += 1;
      return;
    }
    if (reusableLayoutEntry) {
      queryPair.beginningQueryIndex = layoutEntry.beginningQueryIndex;
      queryPair.endQueryIndex = layoutEntry.endQueryIndex;
      queryPair.requiresBeginningMarker = layoutEntry.requiresBeginningMarker;
      queryPair.requiresEndMarker = layoutEntry.requiresEndMarker;
      queryPair.needsBeginningMarker = layoutEntry.requiresBeginningMarker;
      queryPair.needsEndMarker = layoutEntry.requiresEndMarker;
      syncTimestampWrites(index);
    } else if (layoutMismatch) {
      rebuildDynamicLayout();
    } else {
      configureDynamicPair(index);
    }
    state.timedPassCount += 1;
    const writes = state.slot.storage.timestampWrites[index];
    if (writes === undefined) {
      state.entries.pop();
      state.entryIndexesByExecutionIndex[identity.executionIndex] = undefined;
      state.timedPassCount -= 1;
      state.droppedPassCount += 1;
      return undefined;
    }
    return writes;
  };
  const timestampWrites = (identity: GpuPassTimingPassIdentity) => {
    const index = state.entryIndexesByExecutionIndex[identity.executionIndex];
    const entry = index === undefined ? undefined : state.entries[index];
    if (
      index === undefined ||
      entry === undefined ||
      entry.passName !== identity.passName ||
      entry.passKind !== identity.passKind ||
      isTimingEntry(entry) ||
      state.terminal !== undefined
    )
      return undefined;
    const pair = queryPairAt(index);
    const writes = state.slot.storage.timestampWrites[index];
    if (pair === undefined || writes === undefined) return undefined;
    writes.beginningOfPassWriteIndex = pair.beginningQueryIndex;
    writes.endOfPassWriteIndex = pair.endQueryIndex;
    return writes;
  };
  const markOwnerConflict = (identity: GpuPassTimingPassIdentity): void => {
    if (state.terminal !== undefined) return;
    const index = state.entryIndexesByExecutionIndex[identity.executionIndex];
    const entry = index === undefined ? undefined : state.entries[index];
    if (
      index === undefined ||
      entry === undefined ||
      entry.passName !== identity.passName ||
      entry.passKind !== identity.passKind ||
      isTimingEntry(entry)
    )
      return;
    markEntry(index, makeOwnerConflict(identity));
  };
  const markTimestampWriteFailure = (
    identity: GpuPassTimingPassIdentity,
    phase: 'begin' | 'end',
    cause: unknown,
  ): void => {
    if (state.terminal !== undefined) return;
    const index = state.entryIndexesByExecutionIndex[identity.executionIndex];
    const entry = index === undefined ? undefined : state.entries[index];
    if (
      index === undefined ||
      entry === undefined ||
      entry.passName !== identity.passName ||
      entry.passKind !== identity.passKind
    )
      return;
    if (entry !== undefined && isTimingEntry(entry)) {
      if (entry.status === 'unmeasured' && entry.reason.code === 'timestamp-owner-conflict') return;
      return;
    }
    if (entry === undefined) return;
    markEntry(index, makeWriteUnavailable(identity, phase, cause));
  };
  const encodeCopyMarker = (
    encoder: RhiCommandEncoder,
    descriptor: ComputePassDescriptor,
  ): void => {
    const resources = copyMarker();
    const marker = encoder.beginComputePass(descriptor);
    try {
      marker.setPipeline(resources.pipeline);
      marker.setBindGroup(0, resources.bindGroup);
      marker.dispatchWorkgroups(1);
    } finally {
      marker.end();
    }
  };
  const copyBoundaryBefore = (
    identity: GpuPassTimingPassIdentity,
    encoder: RhiCommandEncoder,
  ): void => {
    const index = state.entryIndexesByExecutionIndex[identity.executionIndex];
    const entry = index === undefined ? undefined : entryAt(index);
    const pair = index === undefined ? undefined : queryPairAt(index);
    if (
      index === undefined ||
      !isGenericEntry(entry) ||
      entry.passName !== identity.passName ||
      entry.passKind !== identity.passKind ||
      pair === undefined ||
      !pair.needsBeginningMarker ||
      state.terminal !== undefined
    ) {
      return;
    }
    try {
      const writes = state.slot.storage.copyBeginningMarkerWrites;
      writes.beginningOfPassWriteIndex = pair.beginningQueryIndex;
      encodeCopyMarker(encoder, state.slot.storage.copyBeginningMarkerDescriptor);
      pair.needsBeginningMarker = false;
    } catch (cause) {
      markTimestampWriteFailure(identity, 'begin', cause);
    }
  };
  const copyBoundaryAfter = (
    identity: GpuPassTimingPassIdentity,
    encoder: RhiCommandEncoder,
  ): void => {
    const index = state.entryIndexesByExecutionIndex[identity.executionIndex];
    if (index === undefined) return;
    const entry = entryAt(index);
    const pair = queryPairAt(index);
    if (
      !isGenericEntry(entry) ||
      entry.passKind !== 'copy' ||
      pair === undefined ||
      entry.passName !== identity.passName ||
      !pair.needsEndMarker ||
      state.terminal !== undefined
    ) {
      return;
    }
    try {
      const writes = state.slot.storage.copyEndMarkerWrites;
      writes.endOfPassWriteIndex = pair.endQueryIndex;
      encodeCopyMarker(encoder, state.slot.storage.copyEndMarkerDescriptor);
      pair.needsEndMarker = false;
    } catch (cause) {
      markTimestampWriteFailure(entry, 'end', cause);
    }
  };
  const maybePublishLayout = (): void => {
    if (
      (layout !== undefined &&
        layout.graphGeneration === state.graphGeneration &&
        state.layoutCandidateValid &&
        state.entries.length === layout.entries.length) ||
      state.droppedPassCount > 0 ||
      state.entries.length === 0 ||
      state.entries.some((entry) => !isGenericEntry(entry))
    ) {
      return;
    }
    const entries: CaptureLayoutEntry[] = [];
    for (let index = 0; index < state.entries.length; index += 1) {
      const identity = state.entries[index];
      const queryPair = queryPairAt(index);
      if (!isGenericEntry(identity) || queryPair === undefined) return;
      entries.push(
        Object.freeze({
          identity: Object.freeze({ ...identity }),
          beginningQueryIndex: queryPair.beginningQueryIndex,
          endQueryIndex: queryPair.endQueryIndex,
          requiresBeginningMarker: queryPair.requiresBeginningMarker,
          requiresEndMarker: queryPair.requiresEndMarker,
        }),
      );
    }
    publishLayout(
      Object.freeze({
        graphGeneration: state.graphGeneration,
        queryCount: state.nextQueryIndex,
        entries: Object.freeze(entries),
      }),
    );
  };
  const hasGenericTiming = (): boolean => state.timedPassCount > 0;
  const hasCopyTiming = (): boolean =>
    state.entries.some((entry) => isGenericEntry(entry) && entry.passKind === 'copy');
  const readbackSize = (): number =>
    (hasCopyTiming() ? alignedReadbackSize(state.slot.queryCount) : 0) +
    state.nextQueryIndex * QUERY_RESULT_BYTES;
  const encodeTail = (
    encoder: RhiCommandEncoder,
    graphGeneration?: number,
  ): Result<void, GpuPassTimingReason> => {
    if (
      graphGeneration !== undefined &&
      state.submitted === undefined &&
      state.terminal === undefined
    )
      state.graphGeneration = graphGeneration;
    if (state.terminal !== undefined) {
      return state.terminal.ok
        ? err(
            reason(
              'timing-session-disposed',
              'the timing capture is still encoding',
              'encode timing before terminalizing the capture',
              { frameId: state.identity.frameId },
            ),
          )
        : err(state.terminal.error);
    }
    if (
      layout !== undefined &&
      state.layoutCandidateValid &&
      state.entries.length !== layout.entries.length
    ) {
      state.layoutCandidateValid = false;
      rebuildDynamicLayout();
    }
    maybePublishLayout();
    if (!hasGenericTiming()) return ok(undefined);
    const queryCount = state.nextQueryIndex;
    try {
      const resolved = encoder.resolveQuerySet(
        state.slot.querySet,
        0,
        queryCount,
        state.slot.resolveBuffer,
        0,
      );
      if (!resolved.ok) {
        return err(
          reason(
            'timestamp-resolve-failed',
            'the used timestamp range resolves into the resolve buffer',
            'inspect the RHI cause and wait for a later receipt',
            { cause: resolved.error.code },
          ),
        );
      }
      const hasCopy = hasCopyTiming();
      const markerOffset = alignedReadbackSize(state.slot.queryCount);
      if (hasCopy) {
        const markerResolved = encoder.resolveQuerySet(
          state.slot.markerQuerySet,
          0,
          queryCount,
          state.slot.resolveBuffer,
          markerOffset,
        );
        if (!markerResolved.ok)
          return err(createResourceFailure(markerResolved.error, 'copy marker resolve'));
      }
      encoder.copyBufferToBuffer(
        state.slot.resolveBuffer,
        0,
        state.slot.readbackBuffer,
        0,
        readbackSize(),
      );
      return ok(undefined);
    } catch (error) {
      return err(createResourceFailure(error, 'timing resolve/copy'));
    }
  };
  const terminalize = (result: Result<GpuPassTimingFrame, GpuPassTimingReason>): void => {
    if (state.terminal !== undefined) return;
    state.terminal = result;
    state.slot.state = 'terminal';
  };
  const readback = async (): Promise<void> => {
    if (state.terminal !== undefined) return;
    const mapped = await sessionMapReadback(state.slot.readbackBuffer, period, mapReadback);
    if (!mapped.ok) {
      if (state.terminal !== undefined) return;
      terminalize(err(mapped.error));
      state.slot.state = 'idle';
      return;
    }
    if (state.terminal !== undefined) {
      mapped.value.unmap();
      return;
    }
    const range = mapped.value.getMappedRange(0, readbackSize());
    if (!range.ok) {
      mapped.value.unmap();
      terminalize(err(createResourceFailure(range.error, 'mapped timing range')));
      state.slot.state = 'idle';
      return;
    }
    const measured: GpuPassTimingEntry[] = [];
    for (let index = 0; index < state.entries.length; index += 1) {
      const identity = state.entries[index];
      if (identity === undefined) continue;
      if (isTimingEntry(identity)) {
        measured.push(identity);
        continue;
      }
      const queryPair = state.queryPairs[index];
      if (queryPair === undefined) {
        mapped.value.unmap();
        terminalize(
          err(
            reason(
              'timestamp-readback-failed',
              'every measured pass has a reserved query pair',
              'inspect the capture query allocator before consuming timing facts',
              { frameId: state.identity.frameId, passIndex: index },
            ),
          ),
        );
        state.slot.state = 'idle';
        return;
      }
      // Empty compute markers are not written on every adapter. Keep their
      // slots separate from real work so layout changes cannot turn old raster
      // values into copy timing. Reject zero and unchanged marker writes.
      const marker = identity.passKind === 'copy';
      const readOffset = marker
        ? alignedReadbackSize(state.slot.queryCount) / QUERY_RESULT_BYTES
        : 0;
      const beginningTick = readTick(range.value, readOffset + queryPair.beginningQueryIndex);
      const endTick = readTick(range.value, readOffset + queryPair.endQueryIndex);
      if (marker) {
        const previousBeginning = state.slot.lastMarkerTicks[queryPair.beginningQueryIndex];
        const previousEnd = state.slot.lastMarkerTicks[queryPair.endQueryIndex];
        state.slot.lastMarkerTicks[queryPair.beginningQueryIndex] = beginningTick;
        state.slot.lastMarkerTicks[queryPair.endQueryIndex] = endTick;
        if (
          beginningTick === '0' ||
          endTick === '0' ||
          beginningTick === previousBeginning ||
          endTick === previousEnd
        ) {
          measured.push({
            ...identity,
            status: 'unmeasured',
            reason: reason(
              'timestamp-write-unavailable',
              'both copy markers contain fresh nonzero timestamp writes',
              'use measured raster/compute pass facts; this adapter did not produce reliable copy markers',
              {
                frameId: state.identity.frameId,
                beginningTick,
                endTick,
                passName: identity.passName,
              },
            ),
          });
          continue;
        }
      }
      const parsed = parseGpuPassTimingTicks({
        beginningTick,
        endTick,
        timestampPeriodNanoseconds: period,
      });
      if (!parsed.ok) {
        if (identity.passKind === 'copy') {
          measured.push({
            ...identity,
            status: 'unmeasured',
            reason: {
              ...parsed.error,
              detail: {
                ...parsed.error.detail,
                passName: identity.passName,
                passKind: identity.passKind,
                executionIndex: identity.executionIndex,
                beginningQueryIndex: queryPair.beginningQueryIndex,
                endQueryIndex: queryPair.endQueryIndex,
              },
            },
          });
          continue;
        }
        mapped.value.unmap();
        terminalize(
          err({
            ...parsed.error,
            detail: {
              ...parsed.error.detail,
              passName: identity.passName,
              passKind: identity.passKind,
              executionIndex: identity.executionIndex,
              beginningQueryIndex: queryPair.beginningQueryIndex,
              endQueryIndex: queryPair.endQueryIndex,
            },
          }),
        );
        state.slot.state = 'idle';
        return;
      }
      measured.push({
        ...identity,
        measurementSource:
          identity.passKind === 'copy' ? 'copy-boundary-envelope' : 'pass-boundary',
        ...parsed.value,
      });
    }
    mapped.value.unmap();
    state.entries.splice(0, state.entries.length, ...measured);
    terminalize(ok(freezeSnapshot(state)));
    state.slot.state = 'idle';
  };
  return {
    frameId: state.identity.frameId,
    get nextExecutionIndex() {
      return state.entries.length + state.droppedPassCount;
    },
    recordPass,
    markOwnerConflict,
    markTimestampWriteFailure,
    copyBoundaryBefore,
    copyBoundaryAfter,
    timestampWrites,
    encodeTail,
    markSubmitted: (completion) => {
      if (state.terminal !== undefined || state.submitted !== undefined) return;
      if (!hasGenericTiming()) {
        terminalize(ok(freezeSnapshot(state)));
        state.slot.state = 'idle';
        return;
      }
      state.slot.state = 'submitted';
      state.submitted = (completion ?? device.queue.onSubmittedWorkDone())
        .then(readback)
        .catch((error) => {
          terminalize(err(createResourceFailure(error, 'queue completion')));
          state.slot.state = 'idle';
        });
    },
    snapshot: () => (state.terminal?.ok === true ? state.terminal.value : freezeSnapshot(state)),
    observe: async () => {
      if (state.submitted !== undefined) await state.submitted;
      if (state.terminal !== undefined) return state.terminal;
      return err(
        reason(
          'timing-session-disposed',
          'the timing capture reaches a terminal state before observation',
          'submit the frame or abort the capture before observing it',
          { frameId: state.identity.frameId },
        ),
      );
    },
    abort: (cause) => {
      terminalize(
        err(
          reason(
            'timestamp-readback-failed',
            'an aborted timing capture is terminal without GPU readback',
            'ignore the failed timing receipt and continue rendering',
            { frameId: state.identity.frameId, cause: cause?.code ?? 'aborted' },
          ),
        ),
      );
      state.slot.state = 'idle';
    },
  };
}

async function sessionMapReadback(
  buffer: Buffer,
  period: number,
  override: GpuPassTimingSessionOptions['mapReadback'],
): Promise<Result<MappedBuffer, GpuPassTimingReason>> {
  try {
    const mapped = await (override === undefined
      ? buffer.mapAsync(GPU_MAP_MODE_READ)
      : override(buffer));
    if (!mapped.ok) {
      return err(
        reason(
          'timestamp-readback-failed',
          'the resolved timing buffer maps for read access',
          'inspect the RHI map error and wait for a later receipt',
          { ...causeDetail(mapped.error), timestampPeriodNanoseconds: period },
        ),
      );
    }
    return ok(mapped.value);
  } catch (error) {
    return err(createResourceFailure(error, 'timing readback map'));
  }
}

export function createGpuPassTimingSession(
  device: RhiDevice,
  options: GpuPassTimingOptions = {},
  sessionOptions: GpuPassTimingSessionOptions = {},
): Result<GpuPassTimingSession, GpuPassTimingReason> {
  const normalized = normalizeGpuPassTimingOptions(options);
  if (!normalized.ok) return normalized;
  const period = device.caps.timestampPeriodNanoseconds;
  if (!device.caps.timestampQuery || period === null || !Number.isFinite(period) || period <= 0) {
    return err(
      reason(
        'timestamp-period-unavailable',
        'timestamp-query capability and a positive finite timestamp period are available',
        'use a backend with timestamp-query support and a trustworthy period',
        { timestampQuery: device.caps.timestampQuery, timestampPeriodNanoseconds: period },
      ),
    );
  }
  const slots: Slot[] = [];
  for (let index = 0; index < normalized.value.maxFramesInFlight; index += 1) {
    const slot = createSlot(device, normalized.value);
    if (!slot.ok) {
      for (const created of slots) {
        device.destroyBuffer(created.resolveBuffer);
        device.destroyBuffer(created.readbackBuffer);
        device.destroyQuerySet(created.querySet);
        device.destroyQuerySet(created.markerQuerySet);
      }
      return slot;
    }
    slots.push(slot.value);
  }
  let disposed = false;
  let markerResources:
    | { readonly pipeline: ComputePipeline; readonly bindGroup: BindGroup; readonly buffer: Buffer }
    | undefined;
  const copyMarker = () => {
    if (markerResources !== undefined) return markerResources;
    const factory = sessionOptions.shaderModuleFactory;
    if (factory === undefined) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'a shader module factory for copy timing markers',
        hint: 'assemble the timing session with the active device shader module factory',
      });
    }
    // Empty passes can lose timestamp writes; independent no-op dispatches can
    // overlap. A private storage write orders both markers on the same resource.
    const module = factory.createShaderModule({
      code: `@group(0) @binding(0) var<storage, read_write> serial: atomic<u32>;
@compute @workgroup_size(1) fn copy_timing_marker() { atomicAdd(&serial, 1u); }`,
      label: 'gpu-pass-timing-copy-marker',
    });
    if (!module.ok) throw module.error;
    const bindings = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage', minBindingSize: 4 } }],
    });
    if (!bindings.ok) throw bindings.error;
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindings.value] });
    if (!layout.ok) throw layout.error;
    const pipeline = device.createComputePipeline({
      label: 'gpu-pass-timing-copy-marker',
      layout: layout.value,
      compute: { module: module.value, entryPoint: 'copy_timing_marker' },
    });
    if (!pipeline.ok) throw pipeline.error;
    const buffer = device.createBuffer({ size: 4, usage: 0x80 });
    if (!buffer.ok) throw buffer.error;
    const bindGroup = device.createBindGroup({
      layout: bindings.value,
      entries: [
        {
          binding: 0,
          resource: { kind: 'buffer', value: { buffer: buffer.value, offset: 0, size: 4 } },
        },
      ],
    });
    if (!bindGroup.ok) {
      device.destroyBuffer(buffer.value);
      throw bindGroup.error;
    }
    markerResources = {
      pipeline: pipeline.value,
      bindGroup: bindGroup.value,
      buffer: buffer.value,
    };
    return markerResources;
  };
  const mapReadback = sessionOptions.mapReadback;
  let cachedLayout: CaptureLayout | undefined;
  const publishLayout = (layout: CaptureLayout): void => {
    cachedLayout = layout;
  };
  return ok({
    options: normalized.value,
    beginFrame: (identity) => {
      if (disposed) {
        return err(
          reason(
            'timing-session-disposed',
            'the timing session is active',
            'create a new session after renderer recovery or disposal',
            { frameId: identity.frameId },
          ),
        );
      }
      const slot = slots.find((candidate) => candidate.state === 'idle');
      if (slot === undefined) {
        return err(
          reason(
            'timing-in-flight-exhausted',
            'a bounded timing slot is idle',
            'increase maxFramesInFlight or reduce the capture rate',
            { maxFramesInFlight: normalized.value.maxFramesInFlight },
          ),
        );
      }
      slot.state = 'encoding';
      slot.storage.entries.length = 0;
      slot.storage.entryIndexesByExecutionIndex.fill(undefined);
      const layout =
        cachedLayout?.graphGeneration === identity.graphGeneration ? cachedLayout : undefined;
      const state: CaptureState = {
        identity,
        graphGeneration: identity.graphGeneration,
        backendKind: device.caps.backendKind,
        timestampPeriodNanoseconds: period,
        slot,
        entries: slot.storage.entries,
        queryPairs: slot.storage.queryPairs,
        entryIndexesByExecutionIndex: slot.storage.entryIndexesByExecutionIndex,
        layout,
        layoutCandidateValid: true,
        nextQueryIndex: layout?.queryCount ?? 0,
        droppedPassCount: 0,
        timedPassCount: 0,
        terminal: undefined,
        submitted: undefined,
      };
      slot.capture = state;
      const capture = makeCapture(
        state,
        device,
        period,
        mapReadback,
        layout,
        publishLayout,
        copyMarker,
      );
      return ok(capture);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (markerResources !== undefined) device.destroyBuffer(markerResources.buffer);
      markerResources = undefined;
      for (const slot of slots) {
        if (slot.capture !== undefined && slot.capture.terminal === undefined) {
          slot.capture.terminal = err(
            reason(
              'timing-session-disposed',
              'the timing session is active while resources are disposed',
              'create a new session after renderer recovery or disposal',
              { frameId: slot.capture.identity.frameId },
            ),
          );
        }
        device.destroyBuffer(slot.resolveBuffer);
        device.destroyBuffer(slot.readbackBuffer);
        device.destroyQuerySet(slot.querySet);
        device.destroyQuerySet(slot.markerQuerySet);
        slot.state = 'terminal';
      }
    },
  });
}
