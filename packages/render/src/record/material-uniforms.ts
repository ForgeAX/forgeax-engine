import { type BindGroupEntry, type Buffer, RhiError } from '@forgeax/engine-rhi';
import type { AssetHandle } from '@forgeax/engine-types';
import {
  meshSsboBuffer,
  meshSsboByteOffset,
  writeMeshSsboBuffer,
} from '../assembly/mesh-ssbo-grow';
import type { TextureInjectionResource } from '../ibl/skylight-bind-group';
import { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import { recordContext } from '../world/view-record-context';
import {
  applyMaterialTextureUvScales,
  applyParamSnapshotToUbo,
  type PerSubmeshMaterialBgDeps,
  writePbrMaterialUboPayload,
} from './main-pass-material';
import { extractEntryResourceHandle } from './mesh-ssbo';
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
  resources: object;
  recordingReferences: number;
  provisional: boolean;
}

const unresolvedResources = {};
const missingResources = {};
let recordingSlots: Set<UniformSlot> | undefined;
let preparingUniforms = false;

/** One pending submission pins its numeric versions across preparation checkpoints. */
export class MaterialUniformRecording {
  private readonly used = new Set<UniformSlot>();

  /** Retain the actual completed version for native commands prepared across ordinary frames. */
  hold(runtime: RenderSystemRuntime, material: MaterialSnapshot): number {
    const entry = allocation(runtime).entry(material);
    if (!this.used.has(entry)) {
      this.used.add(entry);
      entry.recordingReferences++;
    }
    return entry.slot;
  }

  run<T>(record: () => T): T {
    const previous = recordingSlots;
    recordingSlots = this.used;
    try {
      return record();
    } finally {
      recordingSlots = previous;
    }
  }

  runPrepared<T>(record: () => T): T {
    const previous = preparingUniforms;
    preparingUniforms = true;
    try {
      return this.run(record);
    } finally {
      preparingUniforms = previous;
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
  private adopted = false;
  private readonly roots = new Map<MaterialResource, UniformSlot>();
  private readonly simultaneous = new WeakMap<MaterialSnapshot, Map<object, UniformSlot>>();
  private readonly current = new WeakMap<MaterialSnapshot, UniformSlot>();
  private readonly free = new Set<number>();
  count = 0;

  adopt(frame: MaterialFrame): void {
    this.adopted = true;
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
    for (const snapshot of changed) {
      const entry = this.entry(snapshot);
      const previous = this.roots.get(entry.resource);
      entry.provisional = false;
      this.roots.set(entry.resource, entry);
      if (previous !== undefined && previous !== entry) this.release(previous);
    }
    this.frame = frame;
  }

  release(entry: UniformSlot): void {
    if (entry.recordingReferences !== 0) return;
    if (this.roots.get(entry.resource) === entry) {
      if (
        (!this.adopted && !entry.provisional) ||
        this.frame.get(entry.resource)?.snapshot === entry.snapshot
      )
        return;
      this.roots.delete(entry.resource);
    }
    const current = this.current.get(entry.snapshot);
    if (current === entry) this.current.delete(entry.snapshot);
    const versions = this.simultaneous.get(entry.snapshot);
    if (versions !== undefined) {
      versions.delete(entry.resources);
      if (
        versions.size === 0 ||
        (versions.size === 1 && current !== entry && current !== undefined)
      )
        this.simultaneous.delete(entry.snapshot);
    }
    this.free.add(entry.slot);
    while (this.free.delete(this.count - 1)) this.count--;
  }

  entry(snapshot: MaterialSnapshot, resources?: object): UniformSlot {
    const current = this.current.get(snapshot);
    if (current !== undefined && (resources === undefined || current.resources === resources))
      return current;
    // Frame admission reserves the numeric address before texture preparation. Its
    // first physical binding completes that reservation in place. A held version
    // remains a separate address until the owning recording is submitted.
    if (
      current?.resources === unresolvedResources &&
      current.recordingReferences === 0 &&
      resources !== undefined &&
      !this.simultaneous.has(snapshot)
    ) {
      current.resources = resources;
      current.provisional = preparingUniforms;
      return current;
    }
    const existing =
      resources === undefined ? undefined : this.simultaneous.get(snapshot)?.get(resources);
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
      provisional: preparingUniforms,
    };
    this.roots.set(resource, entry);
    // Only overlapping recordings need an index beyond the current resource tuple.
    let versions = this.simultaneous.get(snapshot);
    const retained = this.current.get(snapshot);
    if (versions === undefined && retained !== undefined) {
      versions = new Map([[retained.resources, retained]]);
      this.simultaneous.set(snapshot, versions);
    }
    versions?.set(entry.resources, entry);
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
  const owner = recordContext(runtime).meshSsboState ?? runtime;
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

/** The record owner already has both regions. Walk their physical handles in ABI
 * order, excluding the UBO at index zero. No flattened identity array is needed. */
export function materialBindingUniformResources(
  entries: readonly BindGroupEntry[],
  physical: readonly TextureInjectionResource[],
): object {
  let node = resourceChains;
  for (let index = 1; index < entries.length; index++)
    node = resourceChild(node, extractEntryResourceHandle(entries[index] as BindGroupEntry));
  for (const pair of physical) node = resourceChild(resourceChild(node, pair.sampler), pair.view);
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
  readonly version: symbol;
  readonly bytes: Uint8Array;
}
const payloads = new WeakMap<MaterialSnapshot, WeakMap<object, Payload>>();
// Physical storage may outlive the material. Remember the writer identity without retaining its bytes.
const writers = new WeakMap<Buffer, Map<number, symbol>>();

type UploadProofOperation = 'check' | 'forget' | 'remember';

function uploadTargetProof(
  buffer: Buffer,
  offset: number,
  payload: Payload,
  operation: UploadProofOperation,
): boolean {
  let offsets = writers.get(buffer);
  if (operation === 'check') return offsets?.get(offset) === payload.version;
  if (operation === 'forget') offsets?.delete(offset);
  else {
    if (offsets === undefined) {
      offsets = new Map();
      writers.set(buffer, offsets);
    }
    offsets.set(offset, payload.version);
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

type MaterialUniformInputs = Pick<
  PerSubmeshMaterialBgDeps,
  'runtime' | 'pipelineState' | 'frameState'
>;
interface UniformOffsets {
  absolute: number;
  local: number;
}

/** Prepare the numeric version and return its logical slot or the actual physical write target. */
export function prepareMaterialUniform(
  deps: MaterialUniformInputs,
  material: MaterialSnapshot,
  world: RenderResourceScope,
  resources: object,
  missingBaseColor?: boolean,
): number;
export function prepareMaterialUniform(
  deps: MaterialUniformInputs,
  material: MaterialSnapshot,
  world: RenderResourceScope,
  resources: object,
  missingBaseColor: boolean,
  offsets: UniformOffsets,
): Buffer;
export function prepareMaterialUniform(
  deps: MaterialUniformInputs,
  material: MaterialSnapshot,
  world: RenderResourceScope,
  resources: object,
  missingBaseColor = false,
  offsets?: UniformOffsets,
): number | Buffer {
  const { runtime, pipelineState, frameState } = deps;
  const inspection = counters(frameState);
  const parameters = runtime.preparedMaterialParameters?.(material);
  if (parameters !== undefined) resources = extendedUniformResources(resources, parameters);
  if (missingBaseColor) resources = extendedUniformResources(resources, missingResources);
  const slots = allocation(runtime);
  const slot = slots.slot(material, resources);
  const capacity =
    (recordContext(runtime).meshSsboState?.materialSlotCount ?? 0) < slots.count
      ? recordContext(runtime).growMeshSsbo?.(0, slots.count)
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
    payload = { bytes, version: Symbol() };
    versions.set(resources, payload);
    inspection.packMisses++;
  } else inspection.packHits++;

  const storage = pipelineState.materialUniformBuffer;
  const byteOffset = slot * MATERIAL_PER_ENTITY_STRIDE;
  const page = offsets === undefined ? undefined : meshSsboBuffer(storage, byteOffset);
  const local = offsets === undefined ? 0 : meshSsboByteOffset(storage, byteOffset);
  uploadMaterialPayload(runtime, storage, byteOffset, payload, inspection);
  if (offsets === undefined || page === undefined) return slot;
  // A queue callback may have changed the arena or used this same scratch row.
  offsets.absolute = byteOffset;
  offsets.local = local;
  return page;
}

function uploadMaterialPayload(
  runtime: MaterialUniformInputs['runtime'],
  storage: MaterialUniformInputs['pipelineState']['materialUniformBuffer'],
  byteOffset: number,
  payload: Payload,
  inspection: ReturnType<typeof counters>,
): void {
  // The growth owner replaces a complete page roster. A nested write can publish a
  // newer roster while the outer queue call still owns these handles and offsets.
  const { buffer, pages } = storage;
  if (uploadTargetsProof(buffer, pages, byteOffset, payload, 'check')) {
    inspection.skippedUploads++;
    return;
  }
  uploadTargetsProof(buffer, pages, byteOffset, payload, 'forget');
  writeMeshSsboBuffer(runtime.device.queue, storage, byteOffset, payload.bytes);
  uploadTargetsProof(buffer, pages, byteOffset, payload, 'remember');
  inspection.uploadRanges++;
  inspection.uploadedLogicalBytes += payload.bytes.byteLength;
}
