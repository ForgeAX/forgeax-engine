import { type BindGroupEntry, type Buffer, RhiError } from '@forgeax/engine-rhi';
import { type AssetHandle, derive } from '@forgeax/engine-types';
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
  type PerSubmeshMaterialBgDeps,
  writeMaterialUniformValues,
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
  payload?: Payload;
  readers: MaterialUniformRecording | Set<MaterialUniformRecording> | undefined;
  provisional: boolean;
}

const unresolvedResources = {};
const missingResources = {};
let activeRecording: MaterialUniformRecording | undefined;
let preparingUniforms = false;

/** One pending submission pins its numeric versions across preparation checkpoints. */
export class MaterialUniformRecording {
  private readonly used: UniformSlot[] = [];

  /** The ordinary recording is the slot's sole reader across every pass and draw. */
  retain(entry: UniformSlot): void {
    const readers = entry.readers;
    if (readers === this) return;
    if (readers === undefined) entry.readers = this;
    else if (readers instanceof Set) {
      if (readers.has(this)) return;
      readers.add(this);
    } else entry.readers = new Set([readers, this]);
    this.used.push(entry);
  }

  /** Retain the actual completed version for native commands prepared across ordinary frames. */
  hold(runtime: RenderSystemRuntime, material: MaterialSnapshot): number {
    const entry = allocation(runtime).entry(material);
    this.retain(entry);
    return entry.slot;
  }

  run<T>(record: () => T): T {
    const previous = activeRecording;
    activeRecording = this;
    try {
      return record();
    } finally {
      activeRecording = previous;
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
      const readers = entry.readers;
      if (readers instanceof Set) {
        readers.delete(this);
        if (readers.size === 1) entry.readers = readers.values().next().value;
      } else {
        entry.readers = undefined;
        entry.owner.release(entry);
      }
    }
    this.used.length = 0;
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
  // A caller holding an older snapshot can draw it again after its address was recycled.
  // Only retired rows enter this index. Both the snapshot and the binding tuple are weak keys.
  private retiredPayloads?: WeakMap<object, WeakMap<MaterialSnapshot, Payload>>;
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
    if (entry.readers !== undefined) return;
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
    if (entry.payload !== undefined) {
      this.retiredPayloads ??= new WeakMap();
      let versions = this.retiredPayloads.get(entry.resources);
      if (versions === undefined) {
        versions = new WeakMap();
        this.retiredPayloads.set(entry.resources, versions);
      }
      versions.set(entry.snapshot, entry.payload);
      delete entry.payload;
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
      current.readers === undefined &&
      resources !== undefined &&
      !this.simultaneous.has(snapshot)
    ) {
      current.resources = resources;
      current.provisional = preparingUniforms;
      this.restorePayload(current);
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
    const entry: UniformSlot = {
      owner: this,
      resource,
      snapshot,
      slot,
      resources: resources ?? unresolvedResources,
      readers: undefined,
      provisional: preparingUniforms,
    };
    this.roots.set(resource, entry);
    // Reacquiring a previously packed version transfers its bytes to this live address.
    if (resources !== undefined) this.restorePayload(entry);
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

  private restorePayload(entry: UniformSlot): void {
    const versions = this.retiredPayloads?.get(entry.resources);
    const payload = versions?.get(entry.snapshot);
    if (payload !== undefined) {
      entry.payload = payload;
      versions?.delete(entry.snapshot);
    }
  }

  recordingEntry(snapshot: MaterialSnapshot, resources: object): UniformSlot {
    const entry = this.entry(snapshot, resources);
    activeRecording?.retain(entry);
    return entry;
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
  return allocation(runtime).entry(material).slot;
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
// Physical storage may outlive the material. Remember the writer identity without retaining its bytes.
interface PhysicalUniformRow {
  version: symbol | undefined;
  writes: number;
}
const writers = new WeakMap<Buffer, Map<number, PhysicalUniformRow>>();

function physicalRow(buffer: Buffer, offset: number): PhysicalUniformRow {
  let offsets = writers.get(buffer);
  if (offsets === undefined) {
    offsets = new Map();
    writers.set(buffer, offsets);
  }
  let row = offsets.get(offset);
  if (row === undefined) {
    row = { writes: 0, version: undefined };
    offsets.set(offset, row);
  }
  return row;
}

/** A callback can encode another write before the first call returns.
 * Neither writer can attest the order of two overlapping native calls. */
function beginWrite(row: PhysicalUniformRow, payload: Payload): void {
  row.version = row.writes === 0 ? payload.version : undefined;
  row.writes++;
}

type UniformStorage = PerSubmeshMaterialBgDeps['pipelineState']['materialUniformBuffer'];

function pageRow(
  pages: NonNullable<UniformStorage['pages']>,
  page: number,
  offset: number,
): PhysicalUniformRow {
  const buffer = pages.buffers[page];
  if (buffer === undefined) throw new Error('Material upload requires an allocated physical page');
  return physicalRow(buffer, Math.max(0, offset - page * pages.byteStride));
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
  const values = parameters ?? material.paramSnapshot;
  const fallbackSchema =
    values !== undefined &&
    material.materialParamSchema === undefined &&
    material.materialShaderId !== undefined
      ? runtime.getParamSchema?.(material.materialShaderId)
      : undefined;
  const fallbackLayout =
    fallbackSchema === undefined ? undefined : derive(fallbackSchema).uboLayout;
  if (fallbackLayout !== undefined) resources = extendedUniformResources(resources, fallbackLayout);
  const slots = allocation(runtime);
  const entry = slots.recordingEntry(material, resources);
  const slot = entry.slot;
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
  let payload = entry.payload;
  if (payload === undefined) {
    const bytes = new Uint8Array(MATERIAL_PER_ENTITY_STRIDE);
    const f32 = new Float32Array(bytes.buffer, 0, MATERIAL_UNIFORM_BYTES / 4);
    const view = new DataView(bytes.buffer, 0, MATERIAL_UNIFORM_BYTES);
    writePbrMaterialUboPayload(f32, material, view, parameters);
    if (fallbackLayout !== undefined && values !== undefined)
      writeMaterialUniformValues(view, fallbackLayout, values);
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
    entry.payload = payload;
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
  const first =
    pages === undefined
      ? 0
      : Math.max(0, Math.floor((byteOffset - pages.byteSize) / pages.byteStride) + 1);
  const last =
    pages === undefined
      ? 0
      : Math.min(
          pages.buffers.length - 1,
          Math.floor((byteOffset + payload.bytes.byteLength - 1) / pages.byteStride),
        );
  if (last < first || (pages === undefined && buffer === null))
    throw new Error('Material upload requires an allocated physical row');
  const row =
    pages === undefined
      ? physicalRow(buffer as Buffer, byteOffset)
      : pageRow(pages, first, byteOffset);
  let current = row.version === payload.version && row.writes === 0;
  // Check every intersecting page before changing any proof. Most rows have a single target.
  if (pages !== undefined)
    for (let page = first + 1; page <= last; page++) {
      const other = pageRow(pages, page, byteOffset);
      if (other.version !== payload.version || other.writes !== 0) current = false;
    }
  if (current) {
    inspection.skippedUploads++;
    return;
  }
  beginWrite(row, payload);
  if (pages !== undefined)
    for (let page = first + 1; page <= last; page++)
      beginWrite(pageRow(pages, page, byteOffset), payload);
  let completed = false;
  try {
    writeMeshSsboBuffer(runtime.device.queue, storage, byteOffset, payload.bytes);
    completed = true;
  } finally {
    row.writes--;
    if (!completed) row.version = undefined;
    if (pages !== undefined)
      for (let page = first + 1; page <= last; page++) {
        const other = pageRow(pages, page, byteOffset);
        other.writes--;
        if (!completed) other.version = undefined;
      }
  }
  inspection.uploadRanges++;
  inspection.uploadedLogicalBytes += payload.bytes.byteLength;
}
