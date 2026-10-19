// Dynamic mesh/material SSBO growth owner.
// Keeps the stable wrapper identity and capacity policy together with the
// device allocation producer; renderer lifetime only consumes this contract.

import { MeshSsboCeilingReachedError } from '@forgeax/engine-assets-runtime';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import type { DeviceScope } from '../lifecycle';

// Storage-capable devices retain a growing shared arena. Uniform-only devices
// start with one bounded page and grow the same logical slot owner on demand.
export const INITIAL_MESH_SSBO_SLOT_COUNT = 1024;

/** Pow2 round-up — smallest power of 2 >= n (n>=1). */
function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let v = 1;
  while (v < n) v <<= 1;
  return v;
}

/**
 * WebGPU spec floor for `maxStorageBufferBindingSize` (128 MiB).
 * @see {@link https://www.w3.org/TR/webgpu/#dom-supported-limits-maxstoragebufferbindingsize}
 */
const WEBGPU_SPEC_FLOOR_MAX_STORAGE_BUFFER_BINDING_SIZE = 134217728;

/** Derive the allocation ceiling from available device limits, then the spec floor. */
export function deriveStorageBufferCeiling(
  limits: Readonly<{
    maxStorageBufferBindingSize?: number;
    maxBufferSize?: number;
    maxUniformBufferBindingSize?: number;
  }>,
): number {
  // Preferred: the device-reported storage-buffer binding size (when > 0).
  if (
    typeof limits.maxStorageBufferBindingSize === 'number' &&
    limits.maxStorageBufferBindingSize > 0
  ) {
    return limits.maxStorageBufferBindingSize;
  }
  // Fallback 1: maxBufferSize (device-level buffer allocation limit).
  if (typeof limits.maxBufferSize === 'number' && limits.maxBufferSize > 0) {
    return limits.maxBufferSize;
  }
  // Fallback 2: maxUniformBufferBindingSize (uniform binding limit, lower
  // but still a real device capacity signal).
  if (
    typeof limits.maxUniformBufferBindingSize === 'number' &&
    limits.maxUniformBufferBindingSize > 0
  ) {
    return limits.maxUniformBufferBindingSize;
  }
  // Fallback 3: WebGPU spec floor — always non-zero, safe as last resort.
  return WEBGPU_SPEC_FLOOR_MAX_STORAGE_BUFFER_BINDING_SIZE;
}

/**
 * One logical draw-buffer allocation. Shared storage owns `buffer`; paged
 * uniform storage owns `pages` and leaves `buffer` null. The wrapper remains
 * stable as capacity grows; bind-group caches use resolved physical handles.
 */
export interface MeshSsboBufferWrapper {
  buffer: Buffer | null;
  sizeInBytes: number;
  /** Uniform-only physical pages. Logical byte windows overlap at page tails. */
  pages?: {
    readonly byteStride: number;
    readonly byteSize: number;
    readonly buffers: readonly Buffer[];
  };
}

/** Resolve only the physical resource when a binding consumes no dynamic offset. */
export function meshSsboBuffer(
  storage: Pick<MeshSsboBufferWrapper, 'buffer' | 'pages'>,
  byteOffset: number,
): Buffer {
  const pages = storage.pages;
  if (pages === undefined) {
    if (storage.buffer === null) throw new Error('draw buffer is not allocated');
    return storage.buffer;
  }
  const buffer = pages.buffers[Math.floor(byteOffset / pages.byteStride)];
  if (buffer === undefined) throw new Error('draw buffer address exceeds allocated pages');
  return buffer;
}

/** Resolve the physical resource and dynamic offset from the same logical address. */
export function meshSsboBufferBinding(
  storage: Pick<MeshSsboBufferWrapper, 'buffer' | 'pages'>,
  byteOffset: number,
): { readonly buffer: Buffer; readonly byteOffset: number } {
  const buffer = meshSsboBuffer(storage, byteOffset);
  const pages = storage.pages;
  return {
    buffer,
    byteOffset:
      pages === undefined
        ? byteOffset
        : byteOffset - Math.floor(byteOffset / pages.byteStride) * pages.byteStride,
  };
}

/**
 * Keep the logical upload owner unchanged while writing every intersecting
 * physical page. Mesh binding windows exceed a slot, so their overlapping
 * tails must receive the same bytes as the following page, even for a sparse write.
 */
export function writeMeshSsboBuffer(
  queue: RhiQueue,
  storage: Pick<MeshSsboBufferWrapper, 'buffer' | 'pages'>,
  byteOffset: number,
  data: Uint8Array,
  dataOffset = 0,
  size = data.byteLength - dataOffset,
): void {
  if (size === 0) return;
  const pages = storage.pages;
  if (pages === undefined) {
    const binding = meshSsboBufferBinding(storage, byteOffset);
    const result = queue.writeBuffer(binding.buffer, binding.byteOffset, data, dataOffset, size);
    if (!result.ok) throw result.error;
    return;
  }
  const first = Math.max(0, Math.floor((byteOffset - pages.byteSize) / pages.byteStride) + 1);
  const last = Math.min(
    pages.buffers.length - 1,
    Math.floor((byteOffset + size - 1) / pages.byteStride),
  );
  for (let index = first; index <= last; index += 1) {
    const buffer = pages.buffers[index];
    if (buffer === undefined) throw new Error('draw buffer upload has an unallocated page');
    const pageStart = index * pages.byteStride;
    const start = Math.max(byteOffset, pageStart);
    const end = Math.min(byteOffset + size, pageStart + pages.byteSize);
    if (start >= end) continue;
    const result = queue.writeBuffer(
      buffer,
      start - pageStart,
      data,
      dataOffset + start - byteOffset,
      end - start,
    );
    if (!result.ok) throw result.error;
  }
}

export function requireMeshSsboBuffer(wrapper: MeshSsboBufferWrapper): void {
  if (wrapper.buffer === null && wrapper.pages?.buffers[0] === undefined)
    throw new Error('mesh SSBO initial allocation was not completed');
}

/** Independent capacities: mesh rows and interned material records have different consumers. */
export interface MeshSsboCapacity {
  meshSlotCount: number;
  materialSlotCount: number;
}

export interface MeshSsboState extends MeshSsboCapacity {
  mesh: MeshSsboBufferWrapper;
  material: MeshSsboBufferWrapper;
}

/** `growMeshSsbo` return shape (D-5: Result-like, never throws). */
export type MeshSsboGrowResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'mesh-ssbo-ceiling-reached';
      /** Capacities retained when the candidate could not be published. */
      readonly degradedTo: Readonly<MeshSsboCapacity>;
    };

/** Minimal device surface the grow controller needs (mocked in unit tests). */
export interface MeshSsboGrowDevice {
  readonly limits: {
    readonly maxStorageBufferBindingSize: number;
    readonly maxUniformBufferBindingSize?: number;
  };
  readonly destroyBuffer?: (buffer: Buffer) => void;
  readonly createBuffer: (descriptor: {
    readonly label?: string;
    readonly size: number;
    readonly usage: number;
    readonly mappedAtCreation?: boolean;
  }) => Buffer;
}

/** Minimal error-registry surface (just `fire` — `RhiErrorListenerRegistry` matches). */
export interface MeshSsboGrowErrorRegistry {
  fire: (e: MeshSsboCeilingReachedError) => void;
}

export interface MeshSsboGrowControllerInit {
  readonly device: MeshSsboGrowDevice;
  readonly errorRegistry: MeshSsboGrowErrorRegistry;
  readonly initialSlotCount: number;
  readonly materialStride: number;
  readonly meshStride?: number;
  readonly meshBindingSize?: number;
  readonly materialBindingSize?: number;
  /** A binding-capability policy; absent means one shared arena. */
  readonly uniformPages?: boolean;
  readonly scope?: DeviceScope;
  readonly meshUsage: number;
  readonly materialUsage: number;
}

export interface MeshSsboGrowController {
  readonly state: MeshSsboState;
  /** Allocate shared initial capacity, or one page per uniform stream. */
  readonly initialBuild: () => void;
  /** Grow only streams whose actual demand exceeds their own capacity. */
  readonly growMeshSsbo: (
    neededMeshSlots: number,
    neededMaterialSlots: number,
  ) => MeshSsboGrowResult;
}

/**
 * Own mesh/material capacity together, with independent strides and fixed
 * binding windows. Allocation candidates publish atomically; DeviceScope
 * abandons failed candidates and retains successful buffers for their generation.
 */
export function createMeshSsboGrowController(
  init: MeshSsboGrowControllerInit,
): MeshSsboGrowController {
  const { device, errorRegistry, initialSlotCount, materialStride, meshUsage, materialUsage } =
    init;
  // Wrapper-object identity is set once and shared with PipelineState.
  // Inner buffer + sizeInBytes are mutated in place during grow.
  const meshWrapper: MeshSsboBufferWrapper = {
    buffer: null,
    sizeInBytes: 0,
  };
  const materialWrapper: MeshSsboBufferWrapper = {
    buffer: null,
    sizeInBytes: 0,
  };
  const state: MeshSsboState = {
    meshSlotCount: 0,
    materialSlotCount: 0,
    mesh: meshWrapper,
    material: materialWrapper,
  };
  let initialised = false;

  const meshStride = init.meshStride ?? materialStride;
  const meshWindow = init.meshBindingSize ?? meshStride;
  const materialWindow = init.materialBindingSize ?? materialStride;
  // WebGL2 guarantees 16 KiB uniform blocks. Keep page sizing beside the
  // allocator so initial and per-view storage also handle unreported limits.
  const uniformLimit = device.limits.maxUniformBufferBindingSize;
  const pageBytes = init.uniformPages
    ? Math.min(16384, uniformLimit !== undefined && uniformLimit > 0 ? uniformLimit : 16384)
    : undefined;
  const pageSlots = (stride: number, window: number): number => {
    if (pageBytes === undefined) return Number.POSITIVE_INFINITY;
    const count = Math.floor((pageBytes - Math.max(window, stride)) / stride) + 1;
    if (count < 1) throw new Error('draw buffer binding window exceeds uniform page capacity');
    return count;
  };
  const meshPageSlots = pageSlots(meshStride, meshWindow);
  const materialPageSlots = pageSlots(materialStride, materialWindow);

  const allocBufferPair = (meshSlots: number, materialSlots: number): void => {
    const candidate = init.scope?.createChild('draw-buffer-growth');
    const created: Buffer[] = [];
    const create = (label: string, size: number, usage: number): Buffer => {
      const buffer = device.createBuffer({ label, size, usage, mappedAtCreation: false });
      created.push(buffer);
      if (candidate !== undefined) {
        if (device.destroyBuffer === undefined)
          throw new Error('scoped draw buffers require destruction');
        candidate._adopt('buffer', buffer, device.destroyBuffer);
      }
      return buffer;
    };
    const allocate = (
      previous: MeshSsboBufferWrapper,
      slots: number,
      currentSlots: number,
      label: string,
      stride: number,
      window: number,
      slotsPerPage: number,
      usage: number,
    ): MeshSsboBufferWrapper => {
      if (slots === currentSlots && slots > 0) return previous;
      const sizeInBytes = slots * stride + Math.max(0, window - stride);
      if (pageBytes === undefined)
        return { buffer: create(label, sizeInBytes, usage), sizeInBytes };
      const byteStride = slotsPerPage * stride;
      const byteSize = byteStride + Math.max(0, window - stride);
      const buffers = [...(previous.pages?.buffers ?? [])];
      const needed = Math.ceil(slots / slotsPerPage);
      while (buffers.length < needed)
        buffers.push(create(`${label}:page-${buffers.length}`, byteSize, usage));
      return { buffer: null, sizeInBytes, pages: { byteStride, byteSize, buffers } };
    };
    try {
      const mesh = allocate(
        meshWrapper,
        meshSlots,
        state.meshSlotCount,
        'pbr-mesh-ssbo',
        meshStride,
        meshWindow,
        meshPageSlots,
        meshUsage,
      );
      const material = allocate(
        materialWrapper,
        materialSlots,
        state.materialSlotCount,
        'pbr-material-ubo',
        materialStride,
        materialWindow,
        materialPageSlots,
        materialUsage,
      );
      // Publish only after both allocations succeed; existing page identities
      // remain stable across growth and retained submissions keep their resources.
      Object.assign(meshWrapper, mesh);
      Object.assign(materialWrapper, material);
      state.meshSlotCount = meshSlots;
      state.materialSlotCount = materialSlots;
    } catch (error) {
      if (candidate !== undefined) candidate.abandon();
      else for (const buffer of created) device.destroyBuffer?.(buffer);
      throw error;
    }
  };

  const initialBuild = (): void => {
    if (initialised) return;
    allocBufferPair(
      Math.min(initialSlotCount, meshPageSlots),
      Math.min(initialSlotCount, materialPageSlots),
    );
    initialised = true;
  };

  const growthTarget = (
    needed: number,
    current: number,
    stride: number,
    window: number,
  ): number => {
    if (needed <= current) return current;
    const tail = pageBytes === undefined ? Math.max(0, window - stride) : 0;
    const ceiling = Math.floor((deriveStorageBufferCeiling(device.limits) - tail) / stride);
    return Math.min(nextPow2(needed), ceiling);
  };

  const growMeshSsbo = (
    neededMeshSlots: number,
    neededMaterialSlots: number,
  ): MeshSsboGrowResult => {
    if (state.meshSlotCount >= neededMeshSlots && state.materialSlotCount >= neededMaterialSlots)
      return { ok: true };
    const meshSlots = growthTarget(neededMeshSlots, state.meshSlotCount, meshStride, meshWindow);
    const materialSlots = growthTarget(
      neededMaterialSlots,
      state.materialSlotCount,
      materialStride,
      materialWindow,
    );
    const ceilingBytes = deriveStorageBufferCeiling(device.limits);
    if (meshSlots < neededMeshSlots || materialSlots < neededMaterialSlots) {
      const meshExceeded = meshSlots < neededMeshSlots;
      errorRegistry.fire(
        new MeshSsboCeilingReachedError(
          meshExceeded ? neededMeshSlots : neededMaterialSlots,
          meshExceeded ? state.meshSlotCount : state.materialSlotCount,
          ceilingBytes,
        ),
      );
      return {
        ok: false,
        code: 'mesh-ssbo-ceiling-reached',
        degradedTo: {
          meshSlotCount: state.meshSlotCount,
          materialSlotCount: state.materialSlotCount,
        },
      };
    }
    // Publish both demands atomically, but keep every unchanged physical resource.
    allocBufferPair(meshSlots, materialSlots);
    return { ok: true };
  };

  return { state, initialBuild, growMeshSsbo };
}
