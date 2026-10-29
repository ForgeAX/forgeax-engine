import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import type { AssetHandle } from '@forgeax/engine-types';
import { writeMeshSsboBuffer } from '../assembly/mesh-ssbo-grow';
import { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import {
  applyMaterialTextureUvScales,
  applyParamSnapshotToUbo,
  type PerSubmeshMaterialBgDeps,
  writePbrMaterialUboPayload,
} from './main-pass-material';
import {
  MATERIAL_PER_ENTITY_STRIDE,
  MATERIAL_UNIFORM_BYTES,
  type RenderSystemRuntime,
} from './render-context';

interface UniformSlot {
  readonly owner: MaterialUniformSlots;
  readonly resource: MaterialResource;
  readonly snapshot: MaterialSnapshot;
  readonly slot: number;
  readonly resources: object;
  recordingReferences: number;
}

const unresolvedResources = {};
const missingResources = {};
let recordingSlots: Set<UniformSlot> | undefined;

/** One pending submission pins its numeric versions across preparation checkpoints. */
export class MaterialUniformRecording {
  private readonly used = new Set<UniformSlot>();

  run<T>(record: () => T): T {
    const previous = recordingSlots;
    recordingSlots = this.used;
    try {
      return record();
    } finally {
      recordingSlots = previous;
    }
  }

  complete(): void {
    // Later queue writes are ordered after an accepted submission. Only unsubmitted
    // commands need copy-on-write; physical buffer retirement keeps its usual fence.
    for (const entry of this.used) {
      entry.recordingReferences--;
      entry.owner.release(entry);
    }
    this.used.clear();
  }
}

/** Keep numeric versions distinct until all commands in one submission have been recorded. */
export function recordMaterialUniforms<T>(recordAndSubmit: () => T): T {
  const recording = new MaterialUniformRecording();
  try {
    return recording.run(recordAndSubmit);
  } finally {
    recording.complete();
  }
}

/** Roots share one slot unless one recording actually uses multiple immutable versions. */
class MaterialUniformSlots {
  private frame = new MaterialFrame(undefined);
  private readonly roots = new Map<MaterialResource, UniformSlot>();
  private readonly versions = new WeakMap<MaterialSnapshot, Map<object, UniformSlot>>();
  private readonly current = new WeakMap<MaterialSnapshot, UniformSlot>();
  private readonly free = new Set<number>();
  count = 0;

  adopt(frame: MaterialFrame): void {
    if (frame === this.frame) return;
    const changed: MaterialSnapshot[] = [];
    frame.changesSince(this.frame, (previous, next) => {
      if (next !== undefined) changed.push(next.snapshot);
      else if (previous !== undefined) {
        const entry = this.roots.get(previous.resource);
        this.roots.delete(previous.resource);
        if (entry !== undefined) this.release(entry);
      }
    });
    for (const snapshot of changed) this.entry(snapshot);
    this.frame = frame;
  }

  release(entry: UniformSlot): void {
    if (entry.recordingReferences !== 0 || this.roots.get(entry.resource) === entry) return;
    const versions = this.versions.get(entry.snapshot);
    versions?.delete(entry.resources);
    if (versions?.size === 0) this.versions.delete(entry.snapshot);
    if (this.current.get(entry.snapshot) === entry) this.current.delete(entry.snapshot);
    this.free.add(entry.slot);
    while (this.free.delete(this.count - 1)) this.count--;
  }

  entry(snapshot: MaterialSnapshot, resources?: object): UniformSlot {
    const existing =
      resources === undefined
        ? this.current.get(snapshot)
        : this.versions.get(snapshot)?.get(resources);
    if (existing !== undefined) {
      this.current.set(snapshot, existing);
      return existing;
    }
    const resource = MaterialResource.from(snapshot);
    const previous = this.roots.get(resource);
    this.roots.delete(resource);
    if (previous !== undefined) this.release(previous);
    const available = this.free.values().next();
    const slot = available.done ? this.count++ : available.value;
    this.free.delete(slot);
    const entry = {
      owner: this,
      resource,
      snapshot,
      slot,
      resources: resources ?? unresolvedResources,
      recordingReferences: 0,
    };
    this.roots.set(resource, entry);
    let versions = this.versions.get(snapshot);
    if (versions === undefined) {
      versions = new Map();
      this.versions.set(snapshot, versions);
    }
    versions.set(entry.resources, entry);
    this.current.set(snapshot, entry);
    return entry;
  }

  slot(snapshot: MaterialSnapshot, resources?: object): number {
    const entry = this.entry(snapshot, resources);
    if (resources !== undefined && recordingSlots !== undefined && !recordingSlots.has(entry)) {
      recordingSlots.add(entry);
      entry.recordingReferences++;
    }
    return entry.slot;
  }
}

const allocations = new WeakMap<object, MaterialUniformSlots>();
function allocation(runtime: RenderSystemRuntime): MaterialUniformSlots {
  // Capture runtimes inherit the storage controller from their display view.
  // One physical buffer must have one address allocator across those runtimes.
  const owner = runtime.meshSsboState ?? runtime;
  let slots = allocations.get(owner);
  if (slots === undefined) {
    slots = new MaterialUniformSlots();
    allocations.set(owner, slots);
  }
  return slots;
}

/** Called once at frame admission; only changed roots allocate or release addresses. */
export function prepareMaterialUniformFrame(
  runtime: RenderSystemRuntime,
  frame: MaterialFrame,
): number {
  const slots = allocation(runtime);
  slots.adopt(frame);
  return slots.count;
}

export function materialUniformSlot(
  runtime: RenderSystemRuntime,
  material: MaterialSnapshot,
): number {
  return allocation(runtime).slot(material);
}

/**
 * Resource identity is collected by the actual binding assembly, not by another
 * scan of materials or their dependencies. Probe/view resources never enter it.
 */
const resourceChains = new WeakMap<object, unknown>();
const resourceLeaf = {};
export function materialUniformResources(handles: readonly object[]): object {
  let node = resourceChains;
  for (const handle of handles) node = resourceChild(node, handle);
  return resourceIdentity(node);
}

/** `materialUniformResources([resources, extra])` without the per-draw array. */
function extendedUniformResources(resources: object, extra: object): object {
  return resourceIdentity(resourceChild(resourceChild(resourceChains, resources), extra));
}

function resourceChild(node: WeakMap<object, unknown>, handle: object): WeakMap<object, unknown> {
  let next = node.get(handle) as WeakMap<object, unknown> | undefined;
  if (next === undefined) {
    next = new WeakMap();
    node.set(handle, next);
  }
  return next;
}

function resourceIdentity(node: WeakMap<object, unknown>): object {
  let identity = node.get(resourceLeaf) as object | undefined;
  if (identity === undefined) {
    identity = {};
    node.set(resourceLeaf, identity);
  }
  return identity;
}

interface Payload {
  readonly bytes: Uint8Array;
}
const payloads = new WeakMap<MaterialSnapshot, WeakMap<object, Payload>>();
const writers = new WeakMap<Buffer, Map<number, Payload>>();

type UploadProofOperation = 'check' | 'forget' | 'remember';

function uploadTargetProof(
  buffer: Buffer,
  offset: number,
  payload: Payload,
  operation: UploadProofOperation,
): boolean {
  let offsets = writers.get(buffer);
  if (operation === 'check') return offsets?.get(offset) === payload;
  if (operation === 'forget') offsets?.delete(offset);
  else {
    if (offsets === undefined) {
      offsets = new Map();
      writers.set(buffer, offsets);
    }
    offsets.set(offset, payload);
  }
  return true;
}

/** Walk physical targets directly: no per-draw arrays and no scratch spanning queue callbacks. */
function uploadTargetsProof(
  buffer: Buffer | null,
  pages: PerSubmeshMaterialBgDeps['pipelineState']['materialUniformBuffer']['pages'],
  byteOffset: number,
  payload: Payload,
  operation: UploadProofOperation,
): boolean {
  if (pages === undefined) {
    if (buffer === null) throw new Error('Material upload requires an allocated buffer');
    return uploadTargetProof(buffer, byteOffset, payload, operation);
  }
  const first = Math.max(0, Math.floor((byteOffset - pages.byteSize) / pages.byteStride) + 1);
  const last = Math.min(
    pages.buffers.length - 1,
    Math.floor((byteOffset + payload.bytes.byteLength - 1) / pages.byteStride),
  );
  for (let index = first; index <= last; index++) {
    const target = pages.buffers[index];
    if (target === undefined)
      throw new Error('Material upload requires an allocated physical page');
    const offset = Math.max(0, byteOffset - index * pages.byteStride);
    if (!uploadTargetProof(target, offset, payload, operation)) return false;
  }
  return first <= last;
}

function counters(frameState: PerSubmeshMaterialBgDeps['frameState']) {
  frameState.materialUboCounters ??= {
    packHits: 0,
    packMisses: 0,
    uploadRanges: 0,
    uploadedLogicalBytes: 0,
    skippedUploads: 0,
  };
  return frameState.materialUboCounters;
}

/**
 * Prepare one shared numeric root at the real draw binding site. Repeated draws
 * and resource classes read the same address; no consumer is visited on edits.
 */
export function prepareMaterialUniform(
  deps: Pick<PerSubmeshMaterialBgDeps, 'runtime' | 'pipelineState' | 'frameState'>,
  material: MaterialSnapshot,
  world: RenderResourceScope,
  resources: object,
  missingBaseColor = false,
): number {
  const { runtime, pipelineState, frameState } = deps;
  const inspection = counters(frameState);
  const parameters = runtime.preparedMaterialParameters?.(material);
  if (parameters !== undefined) resources = extendedUniformResources(resources, parameters);
  if (missingBaseColor) resources = extendedUniformResources(resources, missingResources);
  const slots = allocation(runtime);
  const slot = slots.slot(material, resources);
  const capacity =
    (runtime.meshSsboState?.materialSlotCount ?? 0) < slots.count
      ? runtime.growMeshSsbo?.(0, slots.count)
      : undefined;
  if (capacity?.ok === false)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'capacity for the material versions used by this submission',
      hint: 'release unused resources or reduce simultaneous material versions',
    });
  let versions = payloads.get(material);
  if (versions === undefined) {
    versions = new WeakMap();
    payloads.set(material, versions);
  }
  let payload = versions.get(resources);
  if (payload === undefined) {
    const bytes = new Uint8Array(MATERIAL_PER_ENTITY_STRIDE);
    const f32 = new Float32Array(bytes.buffer, 0, MATERIAL_UNIFORM_BYTES / 4);
    const view = new DataView(bytes.buffer, 0, MATERIAL_UNIFORM_BYTES);
    writePbrMaterialUboPayload(f32, material, view, parameters);
    if (material.materialParamSchema === undefined) {
      const schema =
        material.materialShaderId === undefined
          ? undefined
          : runtime.getParamSchema?.(material.materialShaderId);
      applyParamSnapshotToUbo(f32, schema, parameters ?? material.paramSnapshot, view);
    }
    applyMaterialTextureUvScales(f32, material, world);
    if (missingBaseColor) {
      f32[0] = 1;
      f32[1] = 0.4;
      f32[2] = 0.7;
      const handle = material.baseColorTexture as AssetHandle<'texture'> | undefined;
      if (handle !== undefined && !frameState.warnedMissingBaseColorTextureHandles.has(handle)) {
        frameState.warnedMissingBaseColorTextureHandles.add(handle);
        console.warn(
          `[forgeax] baseColor texture ${handle} missing GPU view, rendering debug pink`,
        );
      }
      runtime.errorRegistry.fire(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'material baseColor TextureAsset uploaded to GPU',
          hint: 'bind a live TextureAsset before drawing this material',
          detail: { assetHandle: handle ?? 0 },
        }),
      );
    }
    payload = { bytes };
    versions.set(resources, payload);
    inspection.packMisses++;
  } else inspection.packHits++;

  const queue = runtime.device.queue;
  const storage = pipelineState.materialUniformBuffer;
  // The growth owner publishes replacement buffers/pages atomically and never
  // edits an accepted page roster. Keep those physical identities across a
  // queue callback, which may prepare another material and grow this wrapper.
  const buffer = storage.buffer;
  const pages = storage.pages;
  const byteOffset = slot * MATERIAL_PER_ENTITY_STRIDE;
  if (uploadTargetsProof(buffer, pages, byteOffset, payload, 'check')) {
    inspection.skippedUploads++;
    return slot;
  }
  // Proof spans every intersecting page, and is published only after the full write succeeds.
  uploadTargetsProof(buffer, pages, byteOffset, payload, 'forget');
  writeMeshSsboBuffer(queue, storage, byteOffset, payload.bytes);
  uploadTargetsProof(buffer, pages, byteOffset, payload, 'remember');
  inspection.uploadRanges++;
  inspection.uploadedLogicalBytes += payload.bytes.byteLength;
  return slot;
}
