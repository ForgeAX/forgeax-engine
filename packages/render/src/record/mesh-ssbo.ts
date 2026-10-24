import { type BindGroup, RhiError, type RhiQueue } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import {
  type MeshSsboBufferWrapper,
  type MeshSsboCapacity,
  type MeshSsboGrowController,
  type MeshSsboGrowResult,
  writeMeshSsboBuffer,
} from '../assembly/mesh-ssbo-grow';
import { LIGHTING_CHANNELS_DEFAULT } from '../components/lighting-channels';
import { type MaterialResource, materialUsesSpriteGeometry } from '../material-resource';
import type { DispatchEntry, DispatchList } from '../render-system-extract';
import {
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_Z,
  type TransparentSortConfig,
} from '../systems/transparent-sort-config';
import { type ValidatedRenderable, worldEntityKey } from './frame-snapshot';
import type { _InternalRenderPipelineContext } from './render-context';

/**
 * Stride between per-renderable `entity_world` mat4 slots inside the
 * shared `pipelineState.meshStorageBuffer`. The 256-byte alignment is
 * required because the storage buffer is bound with
 * `hasDynamicOffset: true` and WebGPU spec
 * `minStorageBufferOffsetAlignment` defaults to 256.
 */
export const MESH_PER_ENTITY_STRIDE = 256;

// Current/previous mat4, temporal, surface and draw-local Sprite region. See common.wgsl::Mesh.
export const MESH_SSBO_BYTES = 176;

/** `Mesh.temporal.y` bit set: 1 = previous transform valid, 2 = shadow sampling off. */
export function meshSurfaceFlags(source: {
  readonly temporal?: { readonly motionValid?: boolean };
  readonly shadowReceiver?: false;
}): number {
  return (
    (source.temporal?.motionValid === false ? 0 : 1) | (source.shadowReceiver === false ? 2 : 0)
  );
}
export const MESH_UBO_FULL_ARRAY_BYTES = 96 * 128;

// bug-20260723-webgl2-instancing-uniform-range: the WebGL2 fallback shader
// declares `array<InstanceData, 128>` in the instances bind group. Even when
// a draw carries fewer transforms, the buffer binding must expose the full
// array range or wgpu rejects the draw at submit time with a late
// min-binding-size mismatch.
export const INSTANCE_UBO_FULL_ARRAY_BYTES = 80 * 128;

export const MAX_UNIFORM_INSTANCES = 128;

/** The storage-backed InstanceData layout is current + previous mat4. */
export const INSTANCE_STORAGE_STRIDE_FLOATS = 32;

function hasStableGenerationColumn(generations: Uint32Array | undefined, count: number): boolean {
  if (generations === undefined || generations.length !== count) return false;
  const seen = new Set<number>();
  for (const generation of generations) {
    if (generation === 0 || seen.has(generation)) return false;
    seen.add(generation);
  }
  return true;
}

/**
 * Project the ECS transform snapshot into the storage-backed InstanceData
 * layout. Unique identity generations select the previous matrix only when
 * the producer proves that the instance survived. Replaced slots seed
 * previous=current; reordered slots map back to the real prior ordinal so a
 * compaction cannot exchange velocities. Uniform-backed variants keep the
 * compact 16-float payload and do not use this projection.
 */
export function packInstanceStorageBuffer(
  transforms: Float32Array,
  previousTransforms: Float32Array = transforms,
  generations?: Uint32Array,
  previousGenerations?: Uint32Array,
): Float32Array {
  const count = Math.floor(transforms.length / 16);
  const out = new Float32Array(count * INSTANCE_STORAGE_STRIDE_FLOATS);
  const previousCount = Math.floor(previousTransforms.length / 16);
  const generationInput = generations !== undefined || previousGenerations !== undefined;
  const identityProof =
    hasStableGenerationColumn(generations, count) &&
    hasStableGenerationColumn(previousGenerations, previousCount);
  const previousIndexByGeneration = identityProof
    ? new Map(
        Array.from(previousGenerations ?? [], (generation, index) => [generation, index] as const),
      )
    : undefined;
  for (let i = 0; i < count; i++) {
    const sourceBase = i * 16;
    const targetBase = i * INSTANCE_STORAGE_STRIDE_FLOATS;
    const previousIndex = identityProof
      ? previousIndexByGeneration?.get(generations?.[i] ?? 0)
      : !generationInput && previousCount === count
        ? i
        : undefined;
    const sameIdentity = previousIndex !== undefined && previousIndex < previousCount;
    const previousBase = (previousIndex ?? i) * 16;
    for (let k = 0; k < 16; k++) {
      const value = transforms[sourceBase + k] ?? 0;
      out[targetBase + k] = value;
      out[targetBase + 16 + k] = sameIdentity
        ? (previousTransforms[previousBase + k] ?? value)
        : value;
    }
  }
  return out;
}

/**
 * M3 / w12: extracts the underlying GPU resource object from a bind
 * group entry descriptor. Returns the raw object reference (Buffer,
 * TextureView, or Sampler) usable as a WeakMap chain key.
 */
export function extractEntryResourceHandle(entry: {
  resource: { kind: string; value: unknown };
}): object {
  const v = entry.resource.value;
  if (typeof v === 'object' && v !== null && 'buffer' in (v as Record<string, unknown>)) {
    return (v as { buffer: object }).buffer;
  }
  return v as object;
}

// Object-only terminal marker keeps a shorter resource chain from colliding
// with a longer chain that shares the same prefix.
const BIND_GROUP_CHAIN_LEAF_KEY: object = {};

function bindGroupChainLeaf(
  root: WeakMap<object, unknown>,
  handles: readonly object[],
): Map<string, BindGroup> {
  let node = root;
  for (const h of handles) {
    let next = node.get(h) as WeakMap<object, unknown> | undefined;
    if (next === undefined) {
      next = new WeakMap();
      node.set(h, next);
    }
    node = next;
  }
  let leaf = node.get(BIND_GROUP_CHAIN_LEAF_KEY) as Map<string, BindGroup> | undefined;
  if (leaf === undefined) {
    leaf = new Map();
    node.set(BIND_GROUP_CHAIN_LEAF_KEY, leaf);
  }
  return leaf;
}

/**
 * feat-20260622-handle-to-id-allocator-elimination M2 / w7: walks a nested
 * WeakMap chain to find or create a BindGroup leaf. Each handle in the
 * `handles` array is a chain node; a dedicated object terminal marker points
 * to the final Map<string, BindGroup> keyed by `variant` (D-2). The marker
 * prevents variable-depth chains with a shared prefix from treating a nested
 * WeakMap as a leaf. Chain keys are always object references, never numeric
 * ids — GC reclaims entries for dead handles automatically.
 *
 * On cache hit returns the cached BindGroup. On miss calls `factory`,
 * bumps `bindGroupCounts.createBindGroup`, stores the result at the leaf,
 * and returns it. Hit/miss accounting is observable via `bindGroupCounts`
 * (D-8: the skin probe reads `counts.createBindGroup` delta).
 */
export function getOrCreateFromChain(
  root: WeakMap<object, unknown>,
  handles: readonly object[],
  variant: string,
  factory: () => BindGroup,
  counts: { createBindGroup: number; keys: string[] },
): BindGroup {
  const leaf = bindGroupChainLeaf(root, handles);
  const hit = leaf.get(variant);
  if (hit !== undefined) return hit;
  const bg = factory();
  counts.createBindGroup += 1;
  counts.keys.push(variant);
  leaf.set(variant, bg);
  return bg;
}

/**
 * Result-preserving sibling of `getOrCreateFromChain`.  RHI creation can fail
 * transiently during recovery or capability probing; a failed attempt must
 * not enter the cache and must remain a structured Result for the caller.
 */
export function getOrCreateFromChainResult<E>(
  root: WeakMap<object, unknown>,
  handles: readonly object[],
  variant: string,
  factory: () => Result<BindGroup, E>,
  counts: { createBindGroup: number; keys: string[] },
): Result<BindGroup, E> {
  const leaf = bindGroupChainLeaf(root, handles);
  const hit = leaf.get(variant);
  if (hit !== undefined) return ok(hit);
  const created = factory();
  if (!created.ok) return created;
  counts.createBindGroup += 1;
  counts.keys.push(variant);
  leaf.set(variant, created.value);
  return created;
}

/**
 * Read a cached bind group using the same variable-depth chain contract as
 * `getOrCreateFromChain`. Readers must traverse the terminal marker instead
 * of assuming that the last handle directly stores the variant map.
 */
export function findFromChain(
  root: WeakMap<object, unknown>,
  handles: readonly object[],
  variant: string,
): BindGroup | undefined {
  let node = root;
  for (const handle of handles) {
    const next = node.get(handle);
    if (next === undefined) return undefined;
    node = next as WeakMap<object, unknown>;
  }
  const leaf = node.get(BIND_GROUP_CHAIN_LEAF_KEY) as Map<string, BindGroup> | undefined;
  return leaf?.get(variant);
}

/**
 * feat-20260622-handle-to-id-allocator-elimination M2 / w8: per-entity bind
 * group lookup-or-create helper (D-2). Two-step lookup: outer Map.get(outerKey)
 * finds or lazily creates an inner WeakMap chain, then delegates to
 * `getOrCreateFromChain` for the chain walk. outerKey is `string | number`
 * to cover both per-entity (number entityKey) and material-shared
 * (string shaderId) caches (D-1 / OQ-1).
 */
export function getOrCreatePerEntity(
  outerMap: Map<string | number, WeakMap<object, unknown>>,
  outerKey: string | number,
  handles: readonly object[],
  variant: string,
  factory: () => BindGroup,
  counts: { createBindGroup: number; keys: string[] },
): BindGroup {
  let inner = outerMap.get(outerKey) as WeakMap<object, unknown> | undefined;
  if (inner === undefined) {
    inner = new WeakMap();
    outerMap.set(outerKey, inner);
  }
  return getOrCreateFromChain(inner, handles, variant, factory, counts);
}

/**
 * feat-20260622-handle-to-id-allocator-elimination M2 / w8: evicts per-entity
 * cache entries whose entityKey is not in the validated set. Works on
 * Map<entityKey, WeakMap<handle, BindGroup>> by iterating the outer Map keys
 * and deleting entries for which validatedEntityKeys.has(ek) is false.
 * No string parsing, no Number / Number.isNaN — the entityKey is already a
 * number (D-1 / RD4).
 *
 * @internal — exported for unit test access (AC-08)
 */
export function cleanPerEntityCache(
  cache: Map<number, WeakMap<object, unknown>>,
  validatedEntityKeys: Set<number>,
): void {
  for (const ek of cache.keys()) {
    if (!validatedEntityKeys.has(ek)) {
      cache.delete(ek);
    }
  }
}

/** Ensure actual mesh and material demand before either upload. */
export function ensureMeshSsboCapacity(
  internals: {
    readonly growMeshSsbo?: MeshSsboGrowController['growMeshSsbo'] | undefined;
    readonly meshSsboState?: Readonly<MeshSsboCapacity> | undefined;
  },
  neededMeshSlots: number,
  neededMaterialSlots: number,
): MeshSsboGrowResult {
  const grow = internals.growMeshSsbo;
  if (grow === undefined || (neededMeshSlots <= 0 && neededMaterialSlots <= 0)) return { ok: true };
  const beforeMesh = internals.meshSsboState?.meshSlotCount ?? 0;
  const beforeMaterial = internals.meshSsboState?.materialSlotCount ?? 0;
  if (beforeMesh >= neededMeshSlots && beforeMaterial >= neededMaterialSlots) return { ok: true };
  const result = grow(neededMeshSlots, neededMaterialSlots);
  if (!result.ok) return result;
  const after = internals.meshSsboState;
  if (
    after !== undefined &&
    (after.meshSlotCount !== beforeMesh || after.materialSlotCount !== beforeMaterial) &&
    meshSsboDevModeProbe()
  ) {
    // biome-ignore lint/suspicious/noConsole: bounded dev-only capacity transition evidence
    console.info(
      '[mesh-ssbo] grew mesh slots: %d -> %d (requested=%d); material slots: %d -> %d (requested=%d)',
      beforeMesh,
      after.meshSlotCount,
      neededMeshSlots,
      beforeMaterial,
      after.materialSlotCount,
      neededMaterialSlots,
    );
  }
  return result;
}

/**
 * Test seam: a closure-local function pointer ensureMeshSsboCapacity reads
 * for the dev-mode gate. Defaults to `isMeshSsboDevMode`; tests swap it out
 * via `setMeshSsboDevModeProbeForTests` because vitest 4.x export bindings
 * are non-writable (ESM spec) and `import.meta.env.DEV` is build-time-frozen
 * by the vite transform — neither `vi.spyOn(recordModule, 'isMeshSsboDevMode')`
 * nor `vi.stubEnv('DEV', false)` toggles it at runtime.
 */
let meshSsboDevModeProbe: () => boolean = isMeshSsboDevMode;

/**
 * @internal — test-only injection seam for `ensureMeshSsboCapacity`'s
 * dev-mode gate. Pass `undefined` to restore the production probe
 * (`isMeshSsboDevMode`). Production code paths NEVER call this.
 */
export function setMeshSsboDevModeProbeForTests(probe: (() => boolean) | undefined): void {
  meshSsboDevModeProbe = probe ?? isMeshSsboDevMode;
}

/**
 * Dev-mode probe for `ensureMeshSsboCapacity`'s console.info gate
 * (plan-strategy §2.D-3 + AC-11). True when the build is in dev mode:
 *   - `import.meta.env?.DEV` is truthy (vite dev / vitest), OR
 *   - `process.env.NODE_ENV !== 'production'` (esbuild / tsup / dawn-node).
 * Optional-chain keeps it safe in non-vite ESM envs that never inject
 * `import.meta.env` (the chain short-circuits to undefined → falsy).
 *
 * Vite's `import.meta.env.DEV` is constant-folded at build time, so the
 * production bundle dead-code-strips the entire branch even though the
 * test fall-through reads `process.env.NODE_ENV`.
 *
 * @internal — exported as a function (not a const) so unit tests can
 * `vi.spyOn(...).mockReturnValue(false)` to exercise the dev=false path
 * (vitest 4.x cannot toggle `import.meta.env.DEV` at runtime — it is
 * compile-time-frozen by the vite transform).
 */
export function isMeshSsboDevMode(): boolean {
  const importMetaDev = (import.meta as { env?: { DEV?: unknown } }).env?.DEV;
  if (importMetaDev) return true;
  // Fallback for tsup / esbuild / dawn-node where import.meta.env is absent:
  // NODE_ENV !== 'production' counts as dev. NODE_ENV unset (undefined)
  // also counts as dev so test envs without explicit NODE_ENV log too —
  // production builds always set NODE_ENV='production'. We read process via
  // globalThis to keep this file @types/node-free (rest of the package is
  // browser-typed; engine-runtime ships ESM into both browser + dawn-node).
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  if (proc !== undefined && proc.env?.NODE_ENV === 'production') return false;
  if (proc === undefined) return false;
  return true;
}

// Transform, temporal, surface and Sprite region fit the aligned direct slot.
const MESH_SLOT_FLOATS = 44;
const MESH_STRIDE_FLOATS = MESH_PER_ENTITY_STRIDE / Float32Array.BYTES_PER_ELEMENT;
// Clean slots this close together are re-sent with their neighbours so a
// scattered change still flushes as a few contiguous writes.
const MESH_DIRTY_MERGE_GAP_SLOTS = 8;

type MeshUpload = Pick<ValidatedRenderable, 'source' | 'meshSlot' | 'foldedMeshSlot'>;

export function meshDrawSlot(
  entry: Pick<MeshUpload, 'meshSlot' | 'foldedMeshSlot'>,
  folded = false,
): number {
  const slot = folded ? entry.foldedMeshSlot : entry.meshSlot;
  if (slot === undefined || !Number.isSafeInteger(slot) || slot < 0)
    throw new Error('Draw recording requires a prepared physical mesh slot');
  return slot;
}

/**
 * CPU copy of what the GPU mesh storage buffer holds. The buffer is written
 * only by {@link flushMeshDrawUploads}, so its identity is the mirror key and a
 * replaced buffer starts with no known slots.
 */
interface MeshSsboMirror {
  bytes: Uint8Array;
  bits: Uint32Array;
  known: Uint8Array;
  readonly dirty: Set<number>;
  readonly sources: Map<
    number,
    {
      readonly source: MeshUpload['source'];
      readonly surfaceBase: number | undefined;
      readonly storageBuffer: boolean;
      readonly folded: boolean;
      readonly hasSurface: boolean;
    }
  >;
}

const mirrors = new WeakMap<object, MeshSsboMirror>();
const candidate = new Float32Array(MESH_SLOT_FLOATS);
const candidateBits = new Uint32Array(candidate.buffer);

function meshSsboMirror(buffer: object, slotCount: number): MeshSsboMirror {
  let mirror = mirrors.get(buffer);
  if (mirror === undefined) {
    mirror = {
      bytes: new Uint8Array(0),
      bits: new Uint32Array(0),
      known: new Uint8Array(0),
      dirty: new Set(),
      sources: new Map(),
    };
    mirrors.set(buffer, mirror);
  }
  if (mirror.known.length < slotCount) {
    const capacity = Math.max(slotCount, mirror.known.length * 2);
    const bytes = new Uint8Array(capacity * MESH_PER_ENTITY_STRIDE);
    bytes.set(mirror.bytes);
    const known = new Uint8Array(capacity);
    known.set(mirror.known);
    mirror.bytes = bytes;
    mirror.bits = new Uint32Array(bytes.buffer);
    mirror.known = known;
  }
  return mirror;
}

function writeMeshSlotCandidate(entry: MeshUpload, foldHead: boolean): void {
  candidate.fill(0);
  candidateBits[38] = entry.source.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT;
  if (foldHead) {
    candidate[0] = 1;
    candidate[5] = 1;
    candidate[10] = 1;
    candidate[15] = 1;
    // Fold heads use the instance storage path; keep the mesh temporal
    // fields deterministic for shader variants that still read the slot.
    candidate[16] = 1;
    candidate[21] = 1;
    candidate[26] = 1;
    candidate[31] = 1;
    candidate[32] = 1;
    candidate[33] = 1;
    return;
  }
  const worldFromLocal = entry.source.transform.world;
  for (let k = 0; k < 16; k++) candidate[k] = worldFromLocal[k] ?? 0;
  const previousWorld = entry.source.temporal?.previousTransform.world ?? worldFromLocal;
  for (let k = 0; k < 16; k++) candidate[16 + k] = previousWorld[k] ?? 0;
  candidate[32] = entry.source.temporal?.reactive === true ? 1 : 0;
  candidate[33] = meshSurfaceFlags(entry.source);
}

/** Returns whether the slot differed from the mirrored GPU contents. */
function stageMeshSlot(mirror: MeshSsboMirror, slot: number): boolean {
  const base = slot * MESH_STRIDE_FLOATS;
  let dirty = mirror.known[slot] !== 1;
  for (let k = 0; k < MESH_SLOT_FLOATS; k++) {
    const value = candidateBits[k] ?? 0;
    if (mirror.bits[base + k] !== value) {
      mirror.bits[base + k] = value;
      dirty = true;
    }
  }
  // Candidate bytes are not evidence of a successful physical write.
  if (dirty) mirror.known[slot] = 0;
  return dirty;
}

function flushMeshRun(
  queue: RhiQueue,
  storage: Pick<MeshSsboBufferWrapper, 'buffer' | 'pages'>,
  mirror: MeshSsboMirror,
  first: number,
  end: number,
): void {
  const offset = first * MESH_PER_ENTITY_STRIDE;
  writeMeshSsboBuffer(
    queue,
    storage,
    offset,
    mirror.bytes,
    offset,
    (end - first) * MESH_PER_ENTITY_STRIDE,
  );
  mirror.known.fill(1, first, end);
}

/**
 * Stage actual source/folded transforms at their physical addresses. Reordering
 * or shortening a pass list never moves another draw's bytes. Main, shadow and
 * capture can share a source address; folded identity occupies its own slot.
 *
 * Each aligned slot carries current/previous mat4 at bytes 0/64, followed
 * by temporal metadata at byte 128. Normals are derived in the shader.
 * Fold-bucket heads write identity into their slot; the fold path assembles
 * per-instance world matrices into the @group(3) instances buffer instead.
 *
 * @internal
 */
function stageMeshDraw(
  meshStorageBuffer: Pick<MeshSsboBufferWrapper, 'buffer' | 'pages'>,
  entry: MeshUpload,
  folded: boolean,
  visibleSurfaceBases: ReadonlyMap<number, number> | undefined,
  storageBuffer: boolean,
): void {
  const buffer =
    meshStorageBuffer.pages === undefined ? meshStorageBuffer.buffer : meshStorageBuffer;
  if (buffer === null) throw new Error('mesh draw storage is not allocated');
  const slot = meshDrawSlot(entry, folded);
  const mirror = meshSsboMirror(buffer, slot + 1);
  const surfaceBase = visibleSurfaceBases?.get(
    worldEntityKey(entry.source.worldId, entry.source.entityKey),
  );
  const previous = mirror.sources.get(slot);
  if (
    previous?.source === entry.source &&
    previous.surfaceBase === surfaceBase &&
    previous.storageBuffer === storageBuffer &&
    previous.folded === folded &&
    previous.hasSurface === (visibleSurfaceBases !== undefined)
  )
    return;
  writeMeshSlotCandidate(entry, folded);
  const surface = storageBuffer ? 36 : 16;
  candidateBits[surface] = visibleSurfaceBases === undefined ? 0 : (surfaceBase ?? 0);
  candidateBits[surface + 1] =
    visibleSurfaceBases === undefined ? 0 : (entry.source.instances?.instanceCount ?? 1);
  candidateBits[surface + 2] = entry.source.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT;
  candidateBits[surface + 3] = 0;
  const region = entry.source.spriteRegion;
  if (region !== undefined) {
    candidateBits[storageBuffer ? 39 : 19] = 1;
    for (let index = 0; index < 4; index++)
      candidate[(storageBuffer ? 40 : 20) + index] = region[index] ?? 0;
  }
  if (stageMeshSlot(mirror, slot)) mirror.dirty.add(slot);
  mirror.sources.set(slot, {
    source: entry.source,
    surfaceBase,
    storageBuffer,
    folded,
    hasSurface: visibleSurfaceBases !== undefined,
  });
}

/** Stage only the row selected by a real draw. Recording never sweeps rows for updates. */
export function prepareMeshDraw(
  c: _InternalRenderPipelineContext,
  entry: MeshUpload,
  folded = false,
): number {
  stageMeshDraw(
    c.pipelineState.meshStorageBuffer,
    entry,
    folded,
    c.visibleSurface?.entityBases,
    c.runtime.device.caps.storageBuffer,
  );
  return meshDrawSlot(entry, folded);
}

/** Flush the addresses explicitly staged by draws; failed ranges remain pending. */
export function flushMeshDrawUploads(
  queue: RhiQueue,
  meshStorageBuffer: Pick<MeshSsboBufferWrapper, 'buffer' | 'pages'>,
): number {
  const buffer =
    meshStorageBuffer.pages === undefined ? meshStorageBuffer.buffer : meshStorageBuffer;
  const mirror = buffer === null ? undefined : mirrors.get(buffer);
  if (mirror === undefined || mirror.dirty.size === 0) return 0;
  const slots = [...mirror.dirty].sort((a, b) => a - b);
  let first = -1,
    end = -1,
    runs = 0;
  const flush = () => {
    flushMeshRun(queue, meshStorageBuffer, mirror, first, end);
    for (let slot = first; slot < end; slot++) mirror.dirty.delete(slot);
    runs++;
  };
  for (const slot of slots) {
    if (first >= 0 && slot - end <= MESH_DIRTY_MERGE_GAP_SLOTS) {
      end = slot + 1;
      continue;
    }
    if (first >= 0) flush();
    first = slot;
    end = slot + 1;
  }
  if (first >= 0) flush();
  return runs;
}

/** Explicit batch preparation for standalone recorder callers. */
export function uploadMeshSsboBatch(
  queue: RhiQueue,
  meshStorageBuffer: Pick<MeshSsboBufferWrapper, 'buffer' | 'pages'>,
  main: readonly MeshUpload[],
  foldDispatchPlan: FoldDispatchPlan | null,
  shadow: readonly MeshUpload[] = [],
  visibleSurfaceBases?: ReadonlyMap<number, number>,
  storageBuffer = true,
): number {
  let nextIndex = 0;
  for (const entry of main) {
    const index = nextIndex++;
    stageMeshDraw(meshStorageBuffer, entry, false, visibleSurfaceBases, storageBuffer);
    if (foldDispatchPlan?.headBuckets.has(index))
      stageMeshDraw(meshStorageBuffer, entry, true, visibleSurfaceBases, storageBuffer);
  }
  for (const entry of shadow)
    stageMeshDraw(meshStorageBuffer, entry, false, visibleSurfaceBases, storageBuffer);
  return flushMeshDrawUploads(queue, meshStorageBuffer);
}

/**
 * Per-bucket descriptor produced by {@link foldDispatchBuckets}.
 *
 * One bucket = one fold-eligible run of consecutive DispatchEntry whose
 * `(layer, sortKey, materialHandle)` triple is equal. Singleton buckets
 * (bucketSize=1) appear when the mode bypasses fold (D-5 mode 2/3) or
 * when consecutive entries differ in one of the three keys.
 *
 * Fields:
 *   - `entries` — original DispatchEntry slice for this bucket (preserves
 *     the input ordering); the consumer uses these to look up per-entity
 *     material BG handles, mesh handles (which are bucket-uniform by
 *     construction since materialHandle key is included), etc.
 *   - `bucketSize` — `entries.length`. Surfaced as a top-level field so
 *     the consumer can pass it directly as `instanceCount` to
 *     `drawIndexed`.
 *   - `transforms` — assembled Float32Array of bucketSize world mat4s,
 *     stride=16 floats per instance, column-major. Suitable for direct
 *     `device.queue.writeBuffer` into an instance buffer used at @group(3).
 *   - `materialHandle` / `layer` / `sortKey` — the three-tuple key for this
 *     bucket. `sortKey` is mode-dependent: posZ (world[14]) for mode 0
 *     (LAYER_Z), posY (world[13]) for mode 1 (LAYER_Y). Consumed by the
 *     dispatch loop for bind-group selection / sort-stability invariants.
 */
export interface FoldBucket {
  readonly entries: DispatchList;
  readonly bucketSize: number;
  readonly transforms: Float32Array;
  readonly materialHandle: number;
  readonly layer: number;
  readonly sortKey: number;
}

/**
 * Minimal renderable shape consumed by the helper. The real
 * `RenderableSnapshot` carries many more fields; the helper only reads
 * `transform.world` (a Float32Array of 16 column-major floats) and
 * `material.transparent` (the LDR-split-sub-pass fold gate, see PR #502
 * fix + feat-20260625 R2 fix-up: geometry-pass entities — non-transparent
 * materials — MUST stay singleton because the sprite-pass dispatch path
 * that consumes `headBuckets` does not run for them; folding them would
 * overwrite their mesh-SSBO slot with identity and collapse 3D geometry
 * to origin).
 *
 * Production callers pass `RenderableSnapshot[]` straight through —
 * `RenderableSnapshot.material.transparent` is `boolean | undefined`
 * (derived by the extract stage from `passes[0].renderState.blend !==
 * undefined`, the post-feat-20260626-collapse SSOT; see
 * `MaterialSnapshot.transparent`), structurally compatible with this
 * minimal shape. The gate read inside the helper uses `=== true` /
 * `!== true` so both `false` and `undefined` enter the singleton branch.
 *
 * feat-20260625-refactor-sprite-as-transparent-mesh R2 fix-up: the
 * transparent flag identifies the LDR split sub-pass, while the shader id
 * identifies the sprite owner that is safe to fold. Standard PBR Alpha Blend
 * remains singleton so its geometry pass keeps one projection row per draw.
 */
export interface FoldRenderableLike {
  readonly transform: { readonly world: Float32Array };
  readonly material: import('../render-system-extract').MaterialSnapshot;
  readonly spriteRegion?: import('../sprite-region').SpriteRegion | undefined;
}

type ParamSnapshot = MaterialResource['snapshot']['paramSnapshot'];

function sameParamSnapshot(a: ParamSnapshot, b: ParamSnapshot): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    const va = a[key];
    const vb = b[key];
    if (va === vb) continue;
    if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  }
  return true;
}

function isFoldEligible(entry: DispatchEntry, renderables: readonly FoldRenderableLike[]): boolean {
  const material = renderables[entry.renderableIndex]?.material;
  return material?.transparent === true && materialUsesSpriteGeometry(material);
}

/**
 * Linear-scan fold operator (plan-strategy D-1).
 *
 * Walks `orderedEntries` (must be transparent-sort-ordered when mode=0;
 * the helper trusts the input ordering and only checks adjacent equality
 * — non-consecutive entries with equal keys are NOT merged, preserving
 * stable-sort semantics).
 *
 * @param orderedEntries — DispatchEntry[] in transparent-sort order. Empty
 *   array yields zero buckets (defensive empty-bucket suppression).
 * @param mode — current `TransparentSortConfig.mode`. Modes 0 (LAYER_Z)
 *   and 1 (LAYER_Y) enable fold using the appropriate sort-axis coordinate
 *   (posZ / posY respectively). Modes 2 and 3 produce singleton buckets
 *   per entry (D-5 bypass).
 * @param renderables — parallel snapshot array indexed by
 *   `DispatchEntry.renderableIndex`. The helper reads `transform.world`
 *   to (a) extract the sort-axis coordinate for the bucket key (posZ
 *   world[14] for mode 0, posY world[13] for mode 1), and (b) copy 16
 *   floats per entry into the assembled transforms buffer. Out-of-range /
 *   missing renderables defensively contribute a zero mat4 slot.
 * @returns Array of FoldBucket descriptors in input order.
 */
export function foldDispatchBuckets(
  orderedEntries: DispatchList,
  mode: TransparentSortConfig['mode'],
  renderables: readonly FoldRenderableLike[],
): readonly FoldBucket[] {
  if (orderedEntries.length === 0) return [];

  // Bypass branch (D-5): modes 2 (LAYER_YZ) and 3 (DISTANCE) cannot fold
  // — their sort keys are composite foot-Y formulas or per-entity camera
  // distances, not reducible to a single world-mat4 coordinate read.
  // Each entry produces its own singleton bucket; the dispatch consumer
  // treats bucketSize=1 identically to per-entity drawIndexed (charter P3
  // silent fallback — no error fired).
  //
  // Mode 1 (LAYER_Y) falls through to the fold branch below and uses posY
  // (world[13]) as the sort-axis bucket key.
  if (mode !== TRANSPARENT_SORT_MODE_LAYER_Z && mode !== TRANSPARENT_SORT_MODE_LAYER_Y) {
    const out: FoldBucket[] = [];
    for (let i = 0; i < orderedEntries.length; i++) {
      const e = orderedEntries.at(i);
      if (e === undefined) continue;
      out.push(makeSingletonBucket(e, renderables, mode));
    }
    return out;
  }

  // Fold branch (mode 0 = LAYER_Z, mode 1 = LAYER_Y): linear scan, collect
  // runs with equal (layer, sortKey, materialHandle). sortKey is posZ for
  // mode 0, posY for mode 1 — see readSortKey().
  //
  // Transparent-pass-only gate (PR #502 fix + feat-20260625 R2 fix-up):
  // the only dispatch site that consumes `headBuckets` to emit one
  // instanced drawIndexed per bucket is the transparent-pass loop in
  // `render-system-record.ts` (~line 5500; routed via `splitLdrSprite`
  // filter on `material.transparent === true`). The geometry-pass loop
  // (~line 4660) iterates `validatedOrdered` and emits per-entity
  // drawIndexed unchanged; it does NOT branch on `headBuckets`. So when
  // a non-transparent entry (geometry-pass: unlit / standard-PBR / skin)
  // is folded into a multi-entry bucket, the mesh-SSBO upload loop
  // (~line 2710) still overwrites its mesh slot with identity (because
  // `headBuckets.has(i)` is true), but the geometry-pass then reads
  // identity and renders the 3D geometry at the origin — collapsing the
  // frame to black (hello-room CI regression).
  //
  // Concept-count fix: encode "fold is transparent-sprite-sub-pass-only" at the
  // head selection point — the gate is the single bucket-key invariant
  // that makes both dispatch sites correct without coupling identity-
  // overwrite logic to a separate check (avoiding the D-9 shared-exit
  // violation that selecting fix-location B would produce).
  //
  // Non-transparent entries (`transparent !== true`) always produce
  // singleton buckets (bucketSize=1), which `buildFoldDispatchPlan`
  // filters out (`if (bucket.bucketSize <= 1) continue`), so they never
  // enter `headBuckets` / `skipIndices` — the mesh-SSBO upload,
  // transparent-pass, and geometry-pass loops all see them as byte-
  // identical to the pre-fold per-entity path.
  //
  // feat-20260625 R2 fix-up: pre-feat the gate was `shadingModel ===
  // 'sprite'`; M3 / w15 narrowed the shadingModel union to
  // `'unlit' | undefined`. The current gate retains the transparent SSOT
  // and adds the explicit sprite shader identity so Standard PBR Alpha Blend
  // cannot enter this fold path.
  const buckets: FoldBucket[] = [];
  let runStart = 0;
  while (runStart < orderedEntries.length) {
    const head = orderedEntries.at(runStart);
    if (head === undefined) {
      runStart += 1;
      continue;
    }
    // Transparent-pass-only gate (feat-20260625 R2 fix-up): non-transparent
    // heads emit a singleton bucket and advance the cursor by 1 — no run
    // extension. `RenderableSnapshot.material.transparent` is the SSOT
    // carrier (extract stage derives it from the first pass's
    // `renderState.blend !== undefined`, post-feat-20260626-collapse;
    // see `MaterialSnapshot.transparent`).
    if (!isFoldEligible(head, renderables)) {
      buckets.push(makeSingletonBucket(head, renderables, mode));
      runStart += 1;
      continue;
    }
    const headSortKey = readSortKey(mode, head.renderableIndex, renderables);
    let runEnd = runStart + 1;
    while (runEnd < orderedEntries.length) {
      const cand = orderedEntries.at(runEnd);
      if (cand === undefined) break;
      if (cand.layer !== head.layer) break;
      if (cand.materialHandle !== head.materialHandle) break;
      const headRegion = renderables[head.renderableIndex]?.spriteRegion;
      const candidateRegion = renderables[cand.renderableIndex]?.spriteRegion;
      if (
        headRegion !== candidateRegion &&
        (headRegion === undefined ||
          candidateRegion === undefined ||
          headRegion.some((value, index) => value !== candidateRegion[index]))
      )
        break;
      // A bucket draws with its head's material slot, so differing per-entity
      // values (SpriteRegionOverride regions) split the run. Each override owns
      // its snapshot object, so equal regions must compare by value to fold.
      if (
        !sameParamSnapshot(
          renderables[cand.renderableIndex]?.material.paramSnapshot,
          renderables[head.renderableIndex]?.material.paramSnapshot,
        )
      )
        break;
      // Defensive: cand transparent must also be true to join the run.
      // Same materialHandle implies same transparent flag in production
      // (material asset identity), but the check costs O(1) per cand and
      // makes the bucket invariant locally readable.
      if (!isFoldEligible(cand, renderables)) break;
      const candSortKey = readSortKey(mode, cand.renderableIndex, renderables);
      if (candSortKey !== headSortKey) break;
      runEnd += 1;
    }

    const run = orderedEntries.slice(runStart, runEnd);
    const transforms = assembleTransforms(run, renderables);
    buckets.push({
      entries: run,
      bucketSize: run.length,
      transforms,
      materialHandle: head.materialHandle,
      layer: head.layer,
      sortKey: headSortKey,
    });
    runStart = runEnd;
  }
  return buckets;
}

function makeSingletonBucket(
  entry: DispatchEntry,
  renderables: readonly FoldRenderableLike[],
  mode: TransparentSortConfig['mode'],
): FoldBucket {
  const transforms = new Float32Array(16);
  const w = renderables[entry.renderableIndex]?.transform.world;
  if (w !== undefined) transforms.set(w);
  const sortKey = readSortKey(mode, entry.renderableIndex, renderables);
  return {
    entries: [entry],
    bucketSize: 1,
    transforms,
    materialHandle: entry.materialHandle,
    layer: entry.layer,
    sortKey,
  };
}

function assembleTransforms(
  run: DispatchList,
  renderables: readonly FoldRenderableLike[],
): Float32Array {
  const out = new Float32Array(run.length * 16);
  for (let i = 0; i < run.length; i++) {
    const e = run.at(i);
    if (e === undefined) continue;
    const w = renderables[e.renderableIndex]?.transform.world;
    if (w !== undefined) out.set(w, i * 16);
  }
  return out;
}

function readSortKey(
  mode: TransparentSortConfig['mode'],
  renderableIndex: number,
  renderables: readonly FoldRenderableLike[],
): number {
  const w = renderables[renderableIndex]?.transform.world;
  if (w === undefined) return 0;
  // mode 0 (LAYER_Z): sort-axis is Z, column 3 row 2 = world[14].
  // mode 1 (LAYER_Y): sort-axis is Y, column 3 row 1 = world[13].
  return ((mode === TRANSPARENT_SORT_MODE_LAYER_Z ? w[14] : w[13]) ?? 0) as number;
}

/**
 * Per-validatedOrdered-index fold metadata consumed by the record-stage
 * dispatch loops. Built from {@link foldDispatchBuckets} output by
 * {@link buildFoldDispatchPlan}; see plan-strategy §3.2 sequence diagram.
 *
 * Field semantics (consumer contract, w4-record-swap):
 *   - `headBuckets[i]` is non-null when validatedOrdered index `i` is the
 *     **bucket head** of a non-singleton (bucketSize > 1) fold bucket. The
 *     dispatch loop overrides @group(3) instances BG to a transient buffer
 *     holding `bucket.transforms` and emits `drawIndexed(idxCount,
 *     bucket.bucketSize)` instead of per-entity drawIndexed.
 *   - `skipIndices.has(i)` is true when index `i` is a non-head member of
 *     a non-singleton fold bucket; the dispatch loop emits `continue`.
 *   - Singleton buckets (bucketSize === 1) leave both arrays empty for
 *     that index — dispatch falls through to the existing per-entity path
 *     byte-identically (mode-bypass / non-foldable head / fold-disabled).
 *
 * The maps use the current `validatedOrdered` row index. Physical source
 * and folded mesh addresses live on that row and survive independent capture
 * ordering; materialSlotIndices owns its separate material-table lookup.
 */
export interface FoldDispatchPlan {
  readonly headBuckets: ReadonlyMap<number, FoldBucket>;
  readonly skipIndices: ReadonlySet<number>;
  readonly foldedBucketCount: number;
}

/**
 * Build the per-validatedOrdered-index fold metadata from a
 * {@link foldDispatchBuckets} output.
 *
 * @param buckets — output of {@link foldDispatchBuckets}; ordered by
 *   transparent-sort scan order.
 * @param renderableIndexToValidatedIndex — map from `DispatchEntry.renderableIndex`
 *   to the validated-ordered index `i` (the loop counter the dispatch
 *   loops use). Caller builds this once per frame from `validatedOrdered`.
 * @returns FoldDispatchPlan keyed by validated-ordered index.
 *
 * Empty / all-singleton input yields empty maps + `foldedBucketCount=0`,
 * which the dispatch loops treat as "no fold this frame" — byte-identical
 * to pre-feat behavior.
 */
export function buildFoldDispatchPlan(
  buckets: readonly FoldBucket[],
  renderableIndexToValidatedIndex: ReadonlyMap<number, number>,
): FoldDispatchPlan {
  const headBuckets = new Map<number, FoldBucket>();
  const skipIndices = new Set<number>();
  let foldedBucketCount = 0;
  for (const bucket of buckets) {
    if (bucket.bucketSize <= 1) continue;
    const headEntry = bucket.entries.at(0);
    if (headEntry === undefined) continue;
    const headValidatedIdx = renderableIndexToValidatedIndex.get(headEntry.renderableIndex);
    if (headValidatedIdx === undefined) continue;
    headBuckets.set(headValidatedIdx, bucket);
    foldedBucketCount += 1;
    for (let i = 1; i < bucket.entries.length; i++) {
      const memberEntry = bucket.entries.at(i);
      if (memberEntry === undefined) continue;
      const memberValidatedIdx = renderableIndexToValidatedIndex.get(memberEntry.renderableIndex);
      if (memberValidatedIdx === undefined) continue;
      skipIndices.add(memberValidatedIdx);
    }
  }
  return { headBuckets, skipIndices, foldedBucketCount };
}

/**
 * WebGL2 uniform-fallback per-bucket instance-count ceiling
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / D-2 +
 * research N-1).
 *
 * 128 instances * 64 B/mat4 stride = 8192 B, comfortably below the WebGL2
 * minimum 16384 B UBO size, leaving headroom for the per-frame material
 * UBO slice. Locked at the type level via `RhiInstancingExceedsUniformCapDetail.limit`
 * (literal 128) — a future cap change would be a major evolution, not a
 * runtime knob.
 */
export const FOLD_UNIFORM_INSTANCE_CAP = 128;

/**
 * Minimal `RhiCapabilities` shape consumed by the cap-fallback helper.
 *
 * The real `RhiDevice.caps` carries many feature flags; the helper only
 * reads `storageBuffer` (the WebGL2 / WebGPU split signal — true on
 * WebGPU + dawn / wgpu native paths, false on the WebGL2 uniform-only
 * fallback path). Mirrors the field name on the production `RhiCaps`
 * type so the dispatch site can pass `runtime.device.caps` straight in.
 */
export interface FoldCapsLike {
  readonly storageBuffer: boolean;
}

/**
 * Decision POD returned by {@link evaluateFoldBucketUniformCap}.
 *
 * Fields:
 *   - `fallback` — `true` when the bucket must NOT fold and the dispatch
 *     site must route it through the per-entity drawIndexed exit (the
 *     same exit the mode-gate bypass uses, plan-strategy D-9 "shared
 *     fallback exit"). `false` when the bucket can fold normally.
 *   - `error` — the structured RhiError to fire alongside the fallback.
 *     Always populated when `fallback === true`; always `undefined` when
 *     `fallback === false` (charter proposition 4: explicit failure on
 *     the failure path; silent success on the success path).
 *
 * Caller contract: when `fallback === true`, fire the error via the
 * runtime error registry AND draw the bucket's entries individually
 * (each as a 1-instance drawIndexed). Skipping the fallback while still
 * firing the error would leave the frame visually wrong (uniform buffer
 * write would clip at 128 entries).
 */
export interface FoldBucketCapDecision {
  readonly fallback: boolean;
  readonly error: RhiError | undefined;
}

/**
 * Decide whether a fold bucket fits the WebGL2 uniform-fallback per-bucket
 * instance-count ceiling, returning the structured RhiError + fallback
 * intent the dispatch site needs to act on
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / w11 +
 * plan-strategy D-2 + D-9 + AC-05).
 *
 * Decision matrix:
 *
 * | caps.storageBuffer | bucketSize  | fallback | error |
 * |:--|:--|:--|:--|
 * | `true`             | every       | `false`  | `undefined` (WebGPU has no per-binding instance cap inside the storage buffer's `maxStorageBufferBindingSize`; the byte-cap path emits `'limit-exceeded'` separately) |
 * | `false`            | `<= 128`    | `false`  | `undefined` (fits inside the WebGL2 minimum 16384 B UBO with headroom) |
 * | `false`            | `> 128`     | `true`   | `RhiError({ code: 'instancing-exceeds-uniform-cap', detail: { requested, limit: 128, scope } })` |
 *
 * Singleton buckets (`bucketSize === 1`) always pass — they are the
 * mode-gate bypass output and never need the cap check (the cap is
 * about *folded* bucket arity, not about per-entity per-frame work).
 *
 * @param bucket — the FoldBucket whose `bucketSize` is the sole input
 *   (instance count = bucketSize); other fields are not consulted.
 * @param caps — the runtime's RHI capability flags
 *   (`runtime.device.caps`); only `storageBuffer` is read.
 * @param scope — closed `'sprite' | 'tilemap-chunk'` discriminator the
 *   dispatch site picks based on the call site (sprite-pass primary
 *   sprite entry vs tilemap-chunk-derived entry). Surfaced verbatim on
 *   the error's `.detail.scope` so AI users can branch their recovery
 *   on which dispatch site overflowed.
 * @returns a {@link FoldBucketCapDecision} POD; never throws.
 */
export function evaluateFoldBucketUniformCap(
  bucket: FoldBucket,
  caps: FoldCapsLike,
  scope: 'sprite' | 'tilemap-chunk',
): FoldBucketCapDecision {
  if (caps.storageBuffer) return { fallback: false, error: undefined };
  if (bucket.bucketSize <= FOLD_UNIFORM_INSTANCE_CAP) {
    return { fallback: false, error: undefined };
  }
  const error = new RhiError({
    code: 'instancing-exceeds-uniform-cap',
    expected: `bucket instance count <= ${FOLD_UNIFORM_INSTANCE_CAP} (uniform fallback cap)`,
    hint: `reduce the bucket size (smaller layer/material groupings), switch to a WebGPU-capable backend (storage buffers lift the cap), or accept the per-cell drawIndexed fallback for ${scope}`,
    detail: {
      requested: bucket.bucketSize,
      limit: FOLD_UNIFORM_INSTANCE_CAP,
      scope,
    },
  });
  return { fallback: true, error };
}

/**
 * Closed metric key for the AC-06 fold counter
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M3 / D-3).
 *
 * Semantics — count of instanced `drawIndexed` calls the fold operator
 * emits this frame; one increment per non-singleton head bucket retained
 * after the M2 / w11 cap-fallback filter. NOT entity count, NOT pre-
 * filter bucket count — cap-overrun buckets that the dispatch site
 * routed through the per-entity fallback exit do not count.
 *
 * Naming follows the EngineMetrics dot-namespace convention
 * (`<feature>.<event>`); `render.instancing.*` covers both sprite and
 * tilemap-chunk dispatch sites without scope ambiguity (research F-5,
 * plan-strategy §8.2). The owning host evidence reads
 * `ownerMetrics.snapshot()['render.instancing.foldedDraws']`.
 */
export const FOLDED_DRAWS_METRIC_KEY = 'render.instancing.foldedDraws';

/**
 * Minimal `EngineMetrics` shape consumed by {@link incrementFoldedDrawsMetric}.
 *
 * The real `EngineMetrics` carries `snapshot()` + `reset()` too; the
 * helper only writes, so the consumed surface narrows to a single
 * method. Lets the unit test inject a `vi.fn()` mock without faking the
 * read APIs.
 */
export interface FoldMetricsLike {
  increment(name: string): void;
}

/**
 * Bump the AC-06 `render.instancing.foldedDraws` counter once per fold-
 * eligible head bucket in `plan` (M3 / w13, plan-strategy D-3).
 *
 * Single counter-write site for the metric — the record-stage consumer
 * calls this once per `recordFrame` after the cap-fallback filter
 * (M2 / w11) so cap-overrun buckets do not contribute (their members
 * fall through to per-entity drawIndexed, which is not an instanced
 * draw). `plan.foldedBucketCount` is the SSOT for "how many instanced
 * drawIndexed will this frame emit"; passing the same plan to this
 * helper keeps the metric and the actual dispatch in lockstep.
 *
 * Mode-bypass plans (D-5: mode != 0 yields singleton-only buckets which
 * `buildFoldDispatchPlan` filters out) carry `foldedBucketCount === 0`
 * and produce no increments — per-entity drawIndexed is not folded so
 * the metric correctly stays at 0.
 *
 * @param plan — output of {@link buildFoldDispatchPlan} after possible
 *   cap-fallback filtering by the record-stage consumer.
 * @param metrics — the owner-provided EngineMetrics counter; only
 *   `increment(name)` is called. Empty `plan.foldedBucketCount === 0`
 *   produces zero calls (no metric churn for fold-disabled frames).
 */
export function incrementFoldedDrawsMetric(plan: FoldDispatchPlan, metrics: FoldMetricsLike): void {
  for (let i = 0; i < plan.foldedBucketCount; i++) {
    metrics.increment(FOLDED_DRAWS_METRIC_KEY);
  }
}
