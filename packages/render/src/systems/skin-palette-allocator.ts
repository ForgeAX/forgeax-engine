// @forgeax/engine-runtime - Skin palette buffer allocator (M2 / T-24).
//
// Per-renderer mutable state: vertex-stage palette buffer(s) holding
// pre-multiplied joint matrices (M_i = joint_world * IBM_i) for every
// skinned entity in a frame. Two backends (split at construction by
// `useStorageBuffer`):
//
//   STORAGE PATH  (`useStorageBuffer = true`, `maxStorageBuffersPerShaderStage
//                  >= 8` — i.e. WebGPU spec default device).
//     One shared GPU buffer grows at 1.5x (Bevy skin.rs alignment,
//     plan-strategy D-4). Every entity's slice is `{ buffer: shared,
//     byteOffset: cursor }`. The direct CPU caster keeps the fixed
//     `bindingWindowBytes` view and dynamic offset; the scene-index GPU
//     projection binds the complete arena and addresses this slice through
//     `InstanceData.customDataStart`. WebGPU's dynamic-offset bound remains
//     satisfied for the direct path because the allocator extends
//     `buffer.size` to `cursor + bindingWindowBytes` after every slice.
//
//   UNIFORM PATH  (`useStorageBuffer = false`, browser uniform fallback —
//                  `maxStorageBuffersPerShaderStage = 0`).
//     `maxUniformBufferBindingSize` floor is 16 KiB; the static binding
//     window alone is 16320 B, leaving room for ZERO additional
//     entities behind a shared dynOffset. The shared-BG model collapses,
//     so each entity gets its OWN small UBO of size = `bindingWindowBytes`
//     (= MAX_JOINTS * 64 = 16320, which is `<= maxUniformBufferBindingSize`).
//     Slice returns `{ buffer: per-entity, byteOffset: 0 }`. Record-stage
//     BG cache key includes `slice.buffer` so each entity gets its own
//     BG (cached per-buffer pointer; pool reuse keeps createBuffer
//     amortized across frames).
//
//   Concept that does NOT branch by allocator path: `bindingWindowBytes`.
//   It is the static direct/residual `pbr-skin-mesh-array-bgl @binding(1)`
//   entry size, identical for the fixed-window WGSL layout. dynOffset[1]
//   on the uniform path is always 0; on the storage direct path it walks
//   aligned slices. The scene-index GPU path intentionally binds the whole
//   storage arena and uses `customDataStart` rather than this fixed window.
//
// CPU pre-multiply (path-agnostic): writeJointPalette(slice, ibm, jointWorld)
//   -> mat4 per joint: M_i = joint_world_i * IBM_i
//   -> queue.writeBuffer(slice.buffer, slice.byteOffset, payload).
//
// feat-20260523-skin-skeleton-animation M2 / T-24;
// feat-20260612-skin-palette-per-frame-upload M6 (uniform fallback split).

import type { Mat4 } from '@forgeax/engine-math';
import { mat4 } from '@forgeax/engine-math';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { SkinPaletteOverflowError } from '../errors/render';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type {
  SkinPaletteDirtyRange,
  SkinPaletteReceipt,
  SkinPaletteSlice,
  SkinPose,
} from './skin-palette-types';

const MAT4_BYTES = 64; // 16 f32 * 4 bytes
// MAX_JOINTS = 255 matches `pbr-skin-mesh-array-bgl @binding(1)` static BG
// entry size: 255 * 64 = 16320 B. The number is the MAX joints a single
// skinned entity may have. On the storage path the shared buffer holds
// many entities back-to-back; on the uniform path each entity owns one
// 16320 B buffer.
const MAX_JOINTS = 255;
const BINDING_WINDOW_BYTES = MAX_JOINTS * MAT4_BYTES; // 16320
// WebGPU `minStorageBufferOffsetAlignment` default (spec floor) — every
// dynamic offset passed to setBindGroup must be a multiple of this. The shared
// storage path packs many entities back-to-back, so each slice's start must be
// rounded up to this boundary; otherwise a slice whose predecessor's joint
// footprint (jointCount * 64) is not a multiple of 256 (e.g. 33 joints -> 2112)
// lands on an unaligned offset and trips `Dynamic Offset[1] is not 256 byte
// aligned` at draw time.
const PALETTE_OFFSET_ALIGN = 256;

function alignedPaletteBytes(jointCount: number): number {
  return (jointCount * MAT4_BYTES + (PALETTE_OFFSET_ALIGN - 1)) & ~(PALETTE_OFFSET_ALIGN - 1);
}

export interface SkinPaletteAllocator {
  /** Monotonic successful GPU content writes, independent of allocation identity. */
  readonly contentRevision: number;
  /**
   * Static BG entry size for the direct/residual
   * `pbr-skin-mesh-array-bgl @binding(1)` path. Always `MAX_JOINTS * 64 =
   * 16320`; the scene-index GPU path binds the complete storage arena
   * instead. Path-independent for the fixed-window consumer.
   */
  readonly bindingWindowBytes: number;
  /**
   * True when this allocator is in storage-path mode (single shared
   * buffer + dynOffset). False on the uniform fallback (per-entity
   * buffer + dynOffset always 0). Record-stage reads this only for
   * shape assertions in tests; production code branches via
   * `slice.buffer` identity (shared vs per-entity), not this flag.
   */
  readonly useStorageBuffer: boolean;
  /** Allocate or reuse a persistent identity/generation-scoped palette range. */
  allocatePersistentSlice(input: {
    readonly identity: string;
    readonly generation: number;
    readonly jointCount: number;
    readonly bounds?: Float32Array;
  }): SkinPaletteReceipt;
  /**
   * Compare the producer's current joint matrices with the last observed
   * pose and mark only changed joints dirty.  The allocator owns this small
   * pose observation cache so extract does not grow a second palette registry.
   */
  observePersistentJoints(
    identity: string,
    ibms: readonly Float32Array[],
    jointWorlds: readonly Mat4[],
  ): readonly number[];
  /** Mark producer-owned joints dirty; adjacent joints are merged on receipt. */
  markDirtyJoints(identity: string, joints: readonly number[]): void;
  /** Start a frame without discarding persistent ranges or their fences. */
  beginFrame(): void;
  /** Reconcile persistent identities after the frame's extract pass. */
  endFrame(): void;
  /** Retire one producer identity after its owning scene is detached. */
  releasePersistentSlice(identity: string): void;
  /**
   * Allocate a slice for `jointCount` joints. Returns the buffer + byte
   * offset the record stage should bind. Storage path returns the same
   * shared buffer for every call; uniform path mints (or pool-reuses) a
   * per-entity buffer and returns it with `byteOffset: 0`. Both paths
   * guarantee BG validation: storage extends the shared buffer's size,
   * uniform sizes the per-entity buffer to exactly `bindingWindowBytes`.
   *
   * @throws if storage path buffer would exceed
   *         `device.limits.maxStorageBufferBindingSize`
   */
  allocateSlice(jointCount: number): SkinPaletteSlice;
  /**
   * Write joint matrices into the slice's buffer at the slice's offset.
   * Computes M_i = jointWorldTransforms[i] * ibm[i] per joint.
   *
   * `jointWorlds[i]` is taken straight from `Skin.joints[i]` entity's
   * `GlobalTransform.world` view (a 16-float column-major Float32Array
   * written by propagateTransforms); zero recompose, premultiplies
   * directly against the IBM.
   */
  writeJointPalette(
    slice: SkinPaletteSlice,
    ibms: readonly Float32Array[],
    jointWorlds: readonly Mat4[],
  ): void;
  /** Write only the dirty ranges carried by a persistent receipt. */
  writePersistentJointPalette(
    receipt: SkinPaletteReceipt,
    ibms: readonly Float32Array[],
    jointWorlds: readonly Mat4[],
  ): void;
  /**
   * Reset for next frame. Storage path: cursor rewinds, shared buffer
   * stays. Uniform path: per-entity buffer cursor rewinds (pool entries
   * stay allocated and round-robin to the next frame's first entity).
   */
  resetForFrame(): void;
  /** Release all allocator-owned GPU buffers during renderer teardown. */
  dispose(): void;
}

/** Assign device-local palette storage to retained CPU pose facts. */
export function prepareSkinPalette(
  pose: SkinPose,
  allocator: SkinPaletteAllocator,
): SkinPaletteReceipt {
  allocator.observePersistentJoints(pose.identity, pose.inverseBindMatrices, pose.jointWorlds);
  const receipt = allocator.allocatePersistentSlice(pose);
  allocator.writePersistentJointPalette(receipt, pose.inverseBindMatrices, pose.jointWorlds);
  return receipt;
}

export function createSkinPaletteAllocator(
  device: RhiDevice,
  maxBindingSize: number,
  useStorageBuffer = true,
): SkinPaletteAllocator {
  // Storage path: shared buffer state.
  let storageBuffer: Buffer | null = null;
  let storageCapacity = 0;
  let storageCursor = 0;
  let contentRevision = 0;

  // Uniform path: per-entity buffer pool. `pool` is the pre-allocated
  // 16320 B UBO ring; `poolCursor` advances per allocateSlice within a
  // frame and rewinds in resetForFrame, so a 3-entity scene reuses 3
  // entries across frames (createBuffer fires only when the per-frame
  // entity count grows past the historical max). 16320 B / entry
  // bounded by maxUniformBufferBindingSize (>= 16384 by spec floor).
  const pool: Buffer[] = [];
  let poolCursor = 0;
  const persistentUniformBuffers = new Map<string, Buffer>();

  interface PersistentAllocation {
    readonly identity: string;
    readonly generation: number;
    readonly jointCount: number;
    readonly byteSize: number;
    slice: SkinPaletteSlice;
    readonly fence: number;
    bounds?: Float32Array;
    dirtyJoints: Set<number>;
  }

  /**
   * Receipts retain the allocation owner rather than copying its buffer
   * handle. A same-frame arena grow rebases every active allocation; the
   * getter keeps receipts already handed to extract/record on that one
   * current buffer instead of leaving an earlier draw bound to a retired
   * generation.
   */
  function persistentReceipt(
    allocation: PersistentAllocation,
    dirtyRanges: readonly SkinPaletteDirtyRange[],
    uploadBytes: number,
    retiredByteOffset?: number,
  ): SkinPaletteReceipt {
    return {
      get buffer() {
        return allocation.slice.buffer;
      },
      get byteOffset() {
        return allocation.slice.byteOffset;
      },
      jointCount: allocation.slice.jointCount,
      identity: allocation.identity,
      generation: allocation.generation,
      fence: allocation.fence,
      customDataStart: useStorageBuffer ? allocation.slice.byteOffset / MAT4_BYTES : 0,
      storageOrUniform: useStorageBuffer ? 'storage' : 'uniform',
      ...(allocation.bounds === undefined ? {} : { bounds: new Float32Array(allocation.bounds) }),
      dirtyRanges,
      uploadBytes,
      ...(retiredByteOffset === undefined ? {} : { retiredByteOffset }),
    };
  }
  const persistent = new Map<string, PersistentAllocation>();
  interface StorageRange {
    buffer: Buffer;
    offset: number;
    byteSize: number;
  }
  const freeStorageRanges: StorageRange[] = [];
  const pendingStorageRetirements = new Set<StorageRange>();
  const destroyedBuffers = new Set<Buffer>();
  let allocatorDisposed = false;
  const pendingDirty = new Map<string, Set<number>>();
  const observedPose = new Map<string, readonly Float32Array[]>();
  const frameSeenPersistent = new Set<string>();
  let persistentCursor = 0;
  let persistentFence = 0;

  const queueWriteBuffer = (buffer: Buffer, byteOffset: number, payload: Float32Array): void => {
    const result = device.queue.writeBuffer(buffer, byteOffset, payload);
    if (!result.ok) throw result.error;
    contentRevision += 1;
  };

  function normalizedDirtyRanges(
    allocation: PersistentAllocation,
  ): readonly SkinPaletteDirtyRange[] {
    const joints = [...allocation.dirtyJoints]
      .filter((joint) => joint >= 0 && joint < allocation.jointCount)
      .sort((left, right) => left - right);
    const ranges: SkinPaletteDirtyRange[] = [];
    for (const joint of joints) {
      const previous = ranges[ranges.length - 1];
      if (previous !== undefined && previous.startJoint + previous.jointCount === joint) {
        ranges[ranges.length - 1] = {
          startJoint: previous.startJoint,
          jointCount: previous.jointCount + 1,
        };
      } else {
        ranges.push({ startJoint: joint, jointCount: 1 });
      }
    }
    return Object.freeze(ranges);
  }

  function mergeFreeStorageRange(range: StorageRange): void {
    if (allocatorDisposed || storageBuffer !== range.buffer || range.byteSize <= 0) return;
    freeStorageRanges.push({ ...range });
    freeStorageRanges.sort((left, right) => left.offset - right.offset);
    for (let index = freeStorageRanges.length - 1; index > 0; index -= 1) {
      const current = freeStorageRanges[index];
      const previous = freeStorageRanges[index - 1];
      if (current === undefined || previous === undefined) continue;
      if (previous.offset + previous.byteSize !== current.offset) continue;
      previous.byteSize += current.byteSize;
      freeStorageRanges.splice(index, 1);
    }
  }

  function retireStorageRange(range: StorageRange): void {
    if (allocatorDisposed) return;
    pendingStorageRetirements.add(range);
    void device.queue.onSubmittedWorkDone().then(
      () => {
        pendingStorageRetirements.delete(range);
        mergeFreeStorageRange(range);
      },
      () => {
        pendingStorageRetirements.delete(range);
        mergeFreeStorageRange(range);
      },
    );
  }

  function takeFreeStorageRange(byteSize: number): StorageRange | undefined {
    if (!useStorageBuffer || storageBuffer === null) return undefined;
    let candidateIndex = -1;
    for (let index = 0; index < freeStorageRanges.length; index += 1) {
      const candidate = freeStorageRanges[index];
      if (
        candidate !== undefined &&
        candidate.buffer === storageBuffer &&
        candidate.byteSize >= byteSize &&
        // Direct/residual draws bind a full palette window even for one joint.
        // A split free range can fit the payload but overrun that binding.
        candidate.offset + BINDING_WINDOW_BYTES <= storageCapacity
      ) {
        candidateIndex = index;
        break;
      }
    }
    if (candidateIndex < 0) return undefined;
    const candidate = freeStorageRanges[candidateIndex];
    if (candidate === undefined) return undefined;
    freeStorageRanges.splice(candidateIndex, 1);
    if (candidate.byteSize > byteSize) {
      freeStorageRanges.push({
        buffer: candidate.buffer,
        offset: candidate.offset + byteSize,
        byteSize: candidate.byteSize - byteSize,
      });
    }
    return { buffer: candidate.buffer, offset: candidate.offset, byteSize };
  }

  function destroyBufferOnce(buffer: Buffer): void {
    if (destroyedBuffers.has(buffer)) return;
    destroyedBuffers.add(buffer);
    device.destroyBuffer(buffer);
  }

  function allocatePersistentSlice(input: {
    readonly identity: string;
    readonly generation: number;
    readonly jointCount: number;
    readonly bounds?: Float32Array;
  }): SkinPaletteReceipt {
    frameSeenPersistent.add(input.identity);
    if (
      !Number.isInteger(input.jointCount) ||
      input.jointCount <= 0 ||
      input.jointCount > MAX_JOINTS
    ) {
      throw new RangeError(`skin joint count must be between 1 and ${MAX_JOINTS}`);
    }
    const prior = persistent.get(input.identity);
    if (
      prior !== undefined &&
      prior.generation === input.generation &&
      prior.jointCount === input.jointCount
    ) {
      // Bounds are frame facts even when palette storage and joint count stay
      // unchanged. Each receipt takes its own copy below.
      if (input.bounds === undefined) delete prior.bounds;
      else prior.bounds = new Float32Array(input.bounds);
      const dirtyRanges = normalizedDirtyRanges(prior);
      const uploadBytes = dirtyRanges.reduce(
        (total, range) => total + range.jointCount * MAT4_BYTES,
        0,
      );
      // Observation happens before allocation during extract. Consume the
      // producer-owned dirty set exactly once; the receipt carries the write
      // ranges to the palette writer below.
      prior.dirtyJoints.clear();
      return persistentReceipt(prior, dirtyRanges, uploadBytes);
    }
    const retiredByteOffset = prior?.slice.byteOffset;
    if (prior !== undefined) {
      persistent.delete(input.identity);
      if (useStorageBuffer) {
        retireStorageRange({
          buffer: prior.slice.buffer,
          offset: prior.slice.byteOffset,
          byteSize: prior.byteSize,
        });
      }
    }
    let slice: SkinPaletteSlice;
    if (useStorageBuffer) {
      const byteSize = alignedPaletteBytes(input.jointCount);
      const recycled = takeFreeStorageRange(byteSize);
      if (recycled !== undefined) {
        slice = {
          jointCount: input.jointCount,
          byteOffset: recycled.offset,
          buffer: recycled.buffer,
        };
      } else {
        const offset = persistentCursor;
        const needed = offset + BINDING_WINDOW_BYTES;
        ensureStorageCapacity(needed);
        // biome-ignore lint/style/noNonNullAssertion: ensureStorageCapacity creates the buffer
        const buffer = storageBuffer!;
        persistentCursor = offset + byteSize;
        slice = { jointCount: input.jointCount, byteOffset: offset, buffer };
      }
    } else {
      let buffer = persistentUniformBuffers.get(input.identity);
      if (buffer === undefined) {
        if (BINDING_WINDOW_BYTES > maxBindingSize) {
          throw new SkinPaletteOverflowError(BINDING_WINDOW_BYTES, maxBindingSize);
        }
        const created = device.createBuffer({
          label: 'skin-palette-persistent',
          size: BINDING_WINDOW_BYTES,
          usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
          mappedAtCreation: false,
        });
        if (!created.ok) throw created.error;
        buffer = created.value;
        persistentUniformBuffers.set(input.identity, buffer);
      }
      slice = { jointCount: input.jointCount, byteOffset: 0, buffer };
    }
    // A replacement generation owns a fresh slice.  Even when the producer
    // pose is unchanged, the new address has no committed GPU contents, so it
    // must receive a complete upload before the receipt is published.
    const carriedDirty =
      prior !== undefined
        ? new Set(Array.from({ length: input.jointCount }, (_, index) => index))
        : (pendingDirty.get(input.identity) ??
          new Set(Array.from({ length: input.jointCount }, (_, index) => index)));
    const allocation: PersistentAllocation = {
      identity: input.identity,
      generation: input.generation,
      jointCount: input.jointCount,
      byteSize: alignedPaletteBytes(input.jointCount),
      slice,
      fence: ++persistentFence,
      ...(input.bounds === undefined ? {} : { bounds: new Float32Array(input.bounds) }),
      dirtyJoints: new Set(carriedDirty),
    };
    pendingDirty.delete(input.identity);
    persistent.set(input.identity, allocation);
    const dirtyRanges = normalizedDirtyRanges(allocation);
    const uploadBytes = dirtyRanges.reduce(
      (total, range) => total + range.jointCount * MAT4_BYTES,
      0,
    );
    allocation.dirtyJoints.clear();
    return persistentReceipt(allocation, dirtyRanges, uploadBytes, retiredByteOffset);
  }

  function markDirtyJoints(identity: string, joints: readonly number[]): void {
    const allocation = persistent.get(identity);
    const dirty = allocation?.dirtyJoints ?? pendingDirty.get(identity) ?? new Set<number>();
    for (const joint of joints) {
      if (
        Number.isInteger(joint) &&
        joint >= 0 &&
        (allocation === undefined || joint < allocation.jointCount)
      ) {
        dirty.add(joint);
      }
    }
    if (allocation === undefined) pendingDirty.set(identity, dirty);
  }

  function releasePersistentSlice(identity: string): void {
    frameSeenPersistent.delete(identity);
    const allocation = persistent.get(identity);
    persistent.delete(identity);
    pendingDirty.delete(identity);
    observedPose.delete(identity);
    if (allocation === undefined) return;
    if (useStorageBuffer) {
      retireStorageRange({
        buffer: allocation.slice.buffer,
        offset: allocation.slice.byteOffset,
        byteSize: allocation.byteSize,
      });
      return;
    }
    const buffer = persistentUniformBuffers.get(identity);
    if (buffer === undefined) return;
    persistentUniformBuffers.delete(identity);
    void device.queue.onSubmittedWorkDone().then(
      () => destroyBufferOnce(buffer),
      () => destroyBufferOnce(buffer),
    );
  }

  function observePersistentJoints(
    identity: string,
    ibms: readonly Float32Array[],
    jointWorlds: readonly Mat4[],
  ): readonly number[] {
    const count = Math.min(ibms.length, jointWorlds.length);
    const previous = observedPose.get(identity);
    const next: Float32Array[] = new Array(count);
    const changed: number[] = [];
    const temp = mat4.create();
    const ibm = mat4.create();
    for (let index = 0; index < count; index += 1) {
      const ibmFlat = ibms[index];
      const jointWorld = jointWorlds[index];
      if (ibmFlat === undefined || jointWorld === undefined) continue;
      for (let lane = 0; lane < 16; lane += 1) ibm[lane] = ibmFlat[lane] ?? 0;
      mat4.multiply(temp, jointWorld, ibm);
      const copy = new Float32Array(temp);
      next[index] = copy;
      const prior = previous?.[index];
      if (
        prior === undefined ||
        prior.length !== copy.length ||
        prior.some((v, lane) => v !== copy[lane])
      ) {
        changed.push(index);
      }
    }
    observedPose.set(identity, Object.freeze(next));
    if (changed.length > 0) markDirtyJoints(identity, changed);
    return Object.freeze(changed);
  }

  function beginFrame(): void {
    frameSeenPersistent.clear();
    persistentCursor = Math.max(persistentCursor, storageCursor);
  }

  function endFrame(): void {
    for (const identity of [...persistent.keys()]) {
      if (!frameSeenPersistent.has(identity)) releasePersistentSlice(identity);
    }
    frameSeenPersistent.clear();
  }

  function ensureStorageCapacity(needed: number): void {
    if (storageBuffer !== null && needed <= storageCapacity) return;
    let newCapacity = storageCapacity === 0 ? BINDING_WINDOW_BYTES : storageCapacity;
    while (newCapacity < needed) {
      // 1.5x grow, then next multiple of 256 for alignment (plan-strategy D-4).
      newCapacity = (newCapacity + (newCapacity >> 1) + 255) & ~255;
    }
    if (newCapacity > maxBindingSize) {
      throw new SkinPaletteOverflowError(newCapacity, maxBindingSize);
    }
    const bufRes = device.createBuffer({
      label: 'skin-palette',
      size: newCapacity,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!bufRes.ok) throw bufRes.error;
    const previous = storageBuffer;
    storageBuffer = bufRes.value;
    storageCapacity = newCapacity;
    for (const range of freeStorageRanges) {
      if (range.buffer === previous) range.buffer = storageBuffer;
    }
    for (const range of pendingStorageRetirements) {
      if (range.buffer === previous) range.buffer = storageBuffer;
    }
    // A persistent arena can grow after earlier identities have already been
    // published. Rebase those slices into the new arena and restore their
    // last producer-observed matrices before the next frame can bind it;
    // otherwise one frame would bind two palette buffers through one BG.
    for (const allocation of persistent.values()) {
      const pose = observedPose.get(allocation.identity);
      if (pose !== undefined) {
        const payload = new Float32Array(allocation.jointCount * 16);
        for (let joint = 0; joint < allocation.jointCount; joint += 1) {
          const matrix = pose[joint];
          if (matrix !== undefined) payload.set(matrix, joint * 16);
        }
        queueWriteBuffer(storageBuffer, allocation.slice.byteOffset, payload);
      }
      allocation.slice = { ...allocation.slice, buffer: storageBuffer };
    }
    if (previous !== null) {
      void device.queue.onSubmittedWorkDone().then(
        () => destroyBufferOnce(previous),
        () => destroyBufferOnce(previous),
      );
    }
  }

  function acquirePoolBuffer(): Buffer {
    if (poolCursor < pool.length) {
      const reused = pool[poolCursor];
      // biome-ignore lint/style/noNonNullAssertion: poolCursor < pool.length guarantees the slot is set
      return reused!;
    }
    if (BINDING_WINDOW_BYTES > maxBindingSize) {
      throw new SkinPaletteOverflowError(BINDING_WINDOW_BYTES, maxBindingSize);
    }
    const bufRes = device.createBuffer({
      label: 'skin-palette',
      size: BINDING_WINDOW_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!bufRes.ok) throw bufRes.error;
    pool.push(bufRes.value);
    return bufRes.value;
  }

  function allocateSlice(jointCount: number): SkinPaletteSlice {
    if (useStorageBuffer) {
      // Storage path: shared buffer + dynOffset window.
      // WebGPU validates `dynOffset + entry.size <= buffer.size` per
      // setBindGroup, so the buffer must extend a full BINDING_WINDOW_BYTES
      // past `byteOffset` -- not just `jointCount * 64`. Pre-M6 used the
      // latter and tripped `Dynamic Offset[1] out of bounds` on entity 2+.
      const offset = storageCursor;
      const needed = offset + BINDING_WINDOW_BYTES;
      ensureStorageCapacity(needed);
      // biome-ignore lint/style/noNonNullAssertion: ensureStorageCapacity throws if buffer cannot be created
      const buffer = storageBuffer!;
      // Cursor advances by the actual joint footprint, then rounds up to
      // PALETTE_OFFSET_ALIGN so the NEXT slice's byteOffset stays a valid
      // dynamic offset (WebGPU requires 256-byte alignment). Slices still pack
      // near-tightly (at most 255 B slack between them). Only the last slice's
      // window may overhang into uninitialized buffer space, which is benign
      // (shader reads only `jointCount` matrices).
      storageCursor =
        (offset + jointCount * MAT4_BYTES + (PALETTE_OFFSET_ALIGN - 1)) &
        ~(PALETTE_OFFSET_ALIGN - 1);
      return { jointCount, byteOffset: offset, buffer };
    }
    // Uniform fallback: each slice gets its own 16320 B UBO.
    const buffer = acquirePoolBuffer();
    poolCursor += 1;
    return { jointCount, byteOffset: 0, buffer };
  }

  function writeJointPalette(
    slice: SkinPaletteSlice,
    ibms: readonly Float32Array[],
    jointWorlds: readonly Mat4[],
  ): void {
    const count = Math.min(slice.jointCount, ibms.length, jointWorlds.length);
    if (count === 0) return;
    const payload = new Float32Array(count * 16);
    const temp = mat4.create();
    const ibm = mat4.create();
    for (let i = 0; i < count; i++) {
      const ibmFlat = ibms[i];
      const jw = jointWorlds[i];
      if (ibmFlat === undefined || jw === undefined) continue;
      for (let k = 0; k < 16; k++) {
        ibm[k] = ibmFlat[k] ?? 0;
      }
      mat4.multiply(temp, jw, ibm);
      const base = i * 16;
      for (let j = 0; j < 16; j++) {
        payload[base + j] = temp[j] ?? 0;
      }
    }
    queueWriteBuffer(slice.buffer, slice.byteOffset, payload);
  }

  function writePersistentJointPalette(
    receipt: SkinPaletteReceipt,
    ibms: readonly Float32Array[],
    jointWorlds: readonly Mat4[],
  ): void {
    if (receipt.uploadBytes === 0 || receipt.dirtyRanges.length === 0) return;
    const temp = mat4.create();
    const ibm = mat4.create();
    for (const range of receipt.dirtyRanges) {
      const count = Math.min(
        range.jointCount,
        ibms.length - range.startJoint,
        jointWorlds.length - range.startJoint,
      );
      if (count <= 0) continue;
      const payload = new Float32Array(count * 16);
      for (let local = 0; local < count; local += 1) {
        const index = range.startJoint + local;
        const ibmFlat = ibms[index];
        const jointWorld = jointWorlds[index];
        if (ibmFlat === undefined || jointWorld === undefined) continue;
        for (let lane = 0; lane < 16; lane += 1) ibm[lane] = ibmFlat[lane] ?? 0;
        mat4.multiply(temp, jointWorld, ibm);
        payload.set(temp, local * 16);
      }
      queueWriteBuffer(receipt.buffer, receipt.byteOffset + range.startJoint * MAT4_BYTES, payload);
    }
  }

  function resetForFrame(): void {
    storageCursor = 0;
    poolCursor = 0;
  }

  function dispose(): void {
    if (allocatorDisposed) return;
    allocatorDisposed = true;
    if (storageBuffer !== null) destroyBufferOnce(storageBuffer);
    for (const buffer of pool) destroyBufferOnce(buffer);
    for (const buffer of persistentUniformBuffers.values()) destroyBufferOnce(buffer);
    storageBuffer = null;
    persistent.clear();
    pendingDirty.clear();
    observedPose.clear();
    persistentUniformBuffers.clear();
    freeStorageRanges.length = 0;
    pendingStorageRetirements.clear();
    pool.length = 0;
  }

  return {
    get contentRevision() {
      return contentRevision;
    },
    bindingWindowBytes: BINDING_WINDOW_BYTES,
    useStorageBuffer,
    allocatePersistentSlice,
    observePersistentJoints,
    markDirtyJoints,
    releasePersistentSlice,
    beginFrame,
    endFrame,
    allocateSlice,
    writeJointPalette,
    writePersistentJointPalette,
    resetForFrame,
    dispose,
  };
}
