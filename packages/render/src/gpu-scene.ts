import type { Buffer, Result, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { createStandardPbrArtifactReceipt, type ShaderRegistry } from '@forgeax/engine-shader';
import {
  derive,
  MATERIAL_SCENE_ADDRESS_UNIT_BYTES,
  type ParamSchemaEntry,
} from '@forgeax/engine-types';
import { LIGHTING_CHANNELS_DEFAULT } from './components/lighting-channels';
import { GpuDirtyRanges } from './gpu-dirty-ranges';
import type { GpuInputArena } from './gpu-input-arena';
import {
  PrimitiveAllocations,
  type PrimitiveAllocation as SlotAllocation,
} from './gpu-scene-allocations';
import {
  type GpuSceneChangedBounds,
  GpuSceneChangeLog,
  type GpuSceneSlotBounds,
  type GpuSceneSlotRowBoxes,
} from './gpu-scene-change-log';
import {
  GPU_MATERIAL_DESCRIPTOR,
  GPU_MESH_DESCRIPTOR,
  type GpuInputReadFrame,
  GpuSceneInputs,
} from './gpu-scene-inputs';
import {
  GPU_SCENE_LAYOUTS,
  type GpuSceneTableLayout,
  gpuSceneFieldOffset,
} from './gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
} from './gpu-usage';
import type { GpuSceneInspection } from './inspection-types';
import { uniqueInstanceIdentities } from './instances';
import type { MaterialResource } from './material-resource';
import { packMaterialProgramRow, packStandardPbrMaterialRow } from './material-row';
import { isCanonicalStandardPbrMaterialShader } from './pbr-pipeline';
import { getOpaqueResourceIdentity } from './record/frame-snapshot';
import type { MaterialSnapshot } from './render-system-extract';
import { type AcceptedMaterial, MaterialFrame } from './scene/material-dispatch';
import { MeshFrame, type MeshGeometry, type MeshMorphDeltas } from './scene/mesh-frame';
import type { RenderSceneApplyResult, RenderSceneSlot } from './scene/render-scene-types';
import { StableRangeAllocator } from './stable-range-allocator';
import { materialDisplacementRadius } from './standard-displacement-bounds';

export type { GpuSceneInspection } from './inspection-types';

type GpuSceneTemporalSnapshot = NonNullable<RenderSceneSlot['snapshot']['temporal']>;
type GpuSceneTemporalResolver = (slot: RenderSceneSlot) => GpuSceneTemporalSnapshot | undefined;

const PRIMITIVE = GPU_SCENE_LAYOUTS.primitive;
const INSTANCE = GPU_SCENE_LAYOUTS.instance;
const TRANSFORM = GPU_SCENE_LAYOUTS.transform;
const MATERIAL = {
  name: 'GpuSceneMaterialAddress',
  stride: MATERIAL_SCENE_ADDRESS_UNIT_BYTES,
  fields: [],
} as const;
const STANDARD_PBR_RECEIPT = createStandardPbrArtifactReceipt();
const PRIMITIVE_ACTIVE = 1;
const PRIMITIVE_HAS_BOUNDS = 2;
const PRIMITIVE_GPU_DRIVEN = 4;
const PRIMITIVE_SHARED_GEOMETRY = 64;
/** Static author request; readiness stays in the fixed Skin source root. */
export const GPU_SCENE_PRIMITIVE_CAPSULE_SHADOW = 128;
/** Color history must not be trusted for this primitive in the current frame. */
export const GPU_SCENE_PRIMITIVE_REACTIVE = 8;
/** Previous transforms were seeded from current; no motion vector this frame. */
export const GPU_SCENE_PRIMITIVE_MOTION_INVALID = 16;
/** `ShadowParticipation.receive` is false: the surface skips shadow sampling. */
export const GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE = 32;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

interface GpuSceneBuffers {
  readonly primitive: Buffer;
  readonly instance: Buffer;
  readonly transform: Buffer;
  readonly material: Buffer;
}

interface MaterialVersion {
  readonly descriptor: number;
  start: number;
  count: number;
  snapshot: MaterialSnapshot;
  references: number;
  initialized: boolean;
}

interface MaterialAllocation {
  readonly logicalSlot: number;
  readonly resource: MaterialResource;
  holders: number;
  version: MaterialVersion;
}

/** A preparation owns shared resource addresses until abort or submitted completion. */
export interface GpuSceneResourceFrame {
  indexForResource(resource: MaterialResource, snapshot?: MaterialSnapshot): number | undefined;
  logicalForResource(resource: MaterialResource, snapshot?: MaterialSnapshot): number | undefined;
  logicalForGeometry(worldId: number, handle: number, geometry?: MeshGeometry): number | undefined;
  indexForGeometry(worldId: number, handle: number, geometry?: MeshGeometry): number | undefined;
  /** Close the actual read domain before exposing independently retained work. */
  inputReads(): GpuInputReadFrame;
  /** Versions this frame has resolved so far; a later frame may adopt the same set. */
  pins?(): GpuSceneResourcePins;
  /**
   * Pin every recorded version while each is still the current, initialized and
   * mapped version of its resource. Returns false (pinning nothing further)
   * once any recorded address would resolve differently in this frame.
   */
  adoptPins?(pins: GpuSceneResourcePins): boolean;
  seal(): Result<void, RhiError>;
  release(): void;
  submit(completed?: Promise<void>): void;
}

/** Opaque version roster captured from one resource frame. */
export interface GpuSceneResourcePins {
  readonly scene: object;
  readonly materials: readonly (readonly [MaterialResource, MaterialVersion, MaterialSnapshot])[];
  readonly meshes: readonly (readonly [string, MeshVersion, MeshGeometry])[];
}

interface MeshVersion {
  readonly descriptor: number;
  readonly words: number;
  geometry: MeshGeometry;
  references: number;
}

/** Header and shared envelope have one allocation and one frame lifetime. */
function meshInputWords(geometry: MeshGeometry): number {
  return GPU_MESH_DESCRIPTOR.words + (geometry.skinEnvelopes?.length ?? 0);
}

/** One Mesh version's target deltas in the shared input arena, held by its morphed rows. */
interface MorphDeltaAllocation {
  readonly descriptor: number;
  holders: number;
}

/** A morphed row: (vertexCount, targetCount, deltas address, weights...). */
interface MorphRowAllocation {
  readonly descriptor: number;
  readonly words: number;
  readonly worldId: number;
  readonly handle: number;
  deltas: MeshMorphDeltas;
}

const MORPH_ROW_HEADER_WORDS = 3;

interface MeshAllocation {
  readonly logicalSlot: number;
  readonly key: string;
  version: MeshVersion;
  holders: number;
}

type PrimitiveAllocation = SlotAllocation<MeshAllocation, readonly MaterialAllocation[]>;

type GpuSceneTableName = keyof GpuSceneBuffers;

const TABLE_LAYOUTS = {
  primitive: PRIMITIVE,
  instance: INSTANCE,
  transform: TRANSFORM,
  material: MATERIAL,
} as const satisfies Readonly<Record<GpuSceneTableName, GpuSceneTableLayout>>;

const TABLE_NAMES = Object.keys(TABLE_LAYOUTS) as readonly GpuSceneTableName[];
/** Primitive and instance tables share one row capacity; transform rows also hold previous poses. */
const GPU_SCENE_ROW_TABLE_STRIDE = Math.max(PRIMITIVE.stride, INSTANCE.stride);
const TRANSFORM_CURRENT = gpuSceneFieldOffset(TRANSFORM, 'currentWorld');
const TRANSFORM_PREVIOUS = gpuSceneFieldOffset(TRANSFORM, 'previousIndex');
const TRANSFORM_STAMP = gpuSceneFieldOffset(TRANSFORM, 'stamp');

/** Every table is bound whole as one storage binding. */
function gpuSceneTableByteLimit(device: RhiDevice): number {
  const storage = Number(device.limits.maxStorageBufferBindingSize);
  const buffer = Number(device.limits.maxBufferSize);
  return Math.min(
    Number.isFinite(storage) && storage > 0 ? storage : Number.MAX_SAFE_INTEGER,
    Number.isFinite(buffer) && buffer > 0 ? buffer : Number.MAX_SAFE_INTEGER,
  );
}

/**
 * Doubling growth keeps reallocation amortized O(1) per row; slack is clamped
 * to the rows the device can bind, and only a requirement beyond that fails.
 */
export function growGpuSceneTableCapacity(
  current: number,
  required: number,
  stride: number,
  limitBytes: number,
): Result<number, RhiError> {
  if (required <= current) return ok(current);
  const maxRows = Math.floor(limitBytes / stride);
  if (required > maxRows)
    return err(
      new RhiError({
        code: 'limit-exceeded',
        expected: `GPU Scene table (${required} rows x ${stride} B) fits device.limits.maxStorageBufferBindingSize/maxBufferSize (${limitBytes} B)`,
        hint: 'reduce resident GPU-driven rows or request a device with larger storage binding limits',
        detail: { maxStorageBufferBindingSize: limitBytes, requestedBytes: required * stride },
      }),
    );
  let next = Math.max(1, current);
  while (next < required) next *= 2;
  return ok(Math.min(next, maxRows));
}
// Material storage grows from distinct accepted ABIs, independently of entity reservations.
const INITIAL_MATERIAL_CAPACITY = 1;

interface GpuSceneSyncResult {
  readonly ranges: number;
  readonly bytes: number;
  readonly grew: boolean;
  readonly cleared: number;
}

type GpuSceneAvailability =
  | { readonly status: 'available'; readonly scene: GpuScene }
  | { readonly status: 'unavailable'; readonly reason: 'storage-buffer-unavailable' };

function createBuffers(
  device: RhiDevice,
  capacity: number,
  materialCapacity: number,
): Result<GpuSceneBuffers, RhiError> {
  const usage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC;
  const created: Partial<Record<GpuSceneTableName, Buffer>> = {};
  for (const name of TABLE_NAMES) {
    const result = device.createBuffer({
      label: `gpu-scene-${name}-table`,
      size: (name === 'material' ? materialCapacity : capacity) * TABLE_LAYOUTS[name].stride,
      usage,
      mappedAtCreation: false,
    });
    if (!result.ok) {
      for (const buffer of Object.values(created)) device.destroyBuffer(buffer);
      return result;
    }
    created[name] = result.value;
  }
  const { primitive, instance, transform, material } = created;
  if (
    primitive === undefined ||
    instance === undefined ||
    transform === undefined ||
    material === undefined
  ) {
    return err(
      new RhiError({
        code: 'internal-error',
        expected: 'GPU scene creates one buffer for every table',
        hint: 'rebuild the renderer after inspecting the device resource failure',
      }),
    );
  }
  return ok({ primitive, instance, transform, material });
}

function writeMat4(
  view: DataView,
  byteOffset: number,
  value: Float32Array,
  sourceOffset = 0,
): void {
  for (let lane = 0; lane < 16; lane += 1) {
    view.setFloat32(byteOffset + lane * 4, value[sourceOffset + lane] ?? 0, true);
  }
}

function writeChangedMat4(
  view: DataView,
  byteOffset: number,
  matrix: Float32Array,
  sourceOffset = 0,
): boolean {
  let changed = false;
  for (let lane = 0; lane < 16; lane += 1) {
    const at = byteOffset + lane * 4;
    const value = matrix[sourceOffset + lane] ?? 0;
    if (Object.is(view.getFloat32(at, true), value)) continue;
    view.setFloat32(at, value, true);
    changed = true;
  }
  return changed;
}

function writeChangedU32(view: DataView, byteOffset: number, value: number): boolean {
  if (view.getUint32(byteOffset, true) === value) return false;
  view.setUint32(byteOffset, value, true);
  return true;
}

function writeVec4(view: DataView, byteOffset: number, values: readonly number[]): void {
  for (let lane = 0; lane < 4; lane += 1) {
    view.setFloat32(byteOffset + lane * 4, values[lane] ?? 0, true);
  }
}

function offset(layout: GpuSceneTableLayout, field: string): number {
  return gpuSceneFieldOffset(layout, field);
}

/**
 * Build a lookup from the current instance identity to its submitted ordinal.
 * The GPU table is physically compacted by ordinal, so this small CPU lookup
 * is the seam that keeps a stable logical instance from inheriting another
 * row's previous transform after reorder. A missing or duplicate generation
 * deliberately returns no proof and makes the caller seed the current pose.
 */
function previousInstanceOrdinals(
  current: NonNullable<RenderSceneSlot['snapshot']['instances']> | undefined,
  temporal: GpuSceneTemporalSnapshot | undefined,
): ((ordinal: number) => number | undefined) | undefined {
  const previous = temporal?.previousInstances;
  const currentGenerations = current?.generations;
  const previousGenerations = previous?.generations;
  if (
    temporal?.motionValid !== true ||
    current === undefined ||
    previous === undefined ||
    currentGenerations === undefined ||
    previousGenerations === undefined ||
    currentGenerations.length !== current.instanceCount ||
    previousGenerations.length !== previous.instanceCount ||
    current.transforms.length < current.instanceCount * 16 ||
    previous.transforms.length < previous.instanceCount * 16
  ) {
    return undefined;
  }
  // A stable collection keeps one immutable generation column across row
  // moves: its ordinals pair with themselves after a memoized uniqueness proof.
  if (currentGenerations === previousGenerations) {
    return uniqueInstanceIdentities(currentGenerations) ? identityOrdinal : undefined;
  }
  const currentSet = new Set<number>();
  for (const generation of currentGenerations) {
    if (generation === 0 || currentSet.has(generation)) return undefined;
    currentSet.add(generation);
  }
  const ordinals = new Map<number, number>();
  for (let ordinal = 0; ordinal < previousGenerations.length; ordinal += 1) {
    const generation = previousGenerations[ordinal] ?? 0;
    if (generation === 0 || ordinals.has(generation)) return undefined;
    ordinals.set(generation, ordinal);
  }
  return (ordinal) => ordinals.get(currentGenerations[ordinal] ?? 0);
}

const identityOrdinal = (ordinal: number): number => ordinal;

/** Accepted instance collection revision mirrored by one slot's transform rows. */
interface InstanceResidentRevision {
  readonly collectionId: number;
  readonly revision: number;
}

function instanceIdentityChanged(
  resident: Uint32Array | undefined,
  current: Uint32Array | undefined,
  ordinal: number,
): boolean {
  if (resident === undefined || current === undefined) return resident !== current;
  return resident[ordinal] !== current[ordinal];
}

/**
 * Temporal flags of a (re)written primitive, mirroring the resolved CPU
 * temporal snapshot. A reset allocation seeds previous = current, so it never
 * carries valid motion. Without temporal tracking no flag is published.
 */
function primitiveTemporalFlags(
  resetPrevious: boolean,
  temporal: GpuSceneTemporalSnapshot | undefined,
): number {
  if (temporal === undefined) return 0;
  return (
    (temporal.reactive ? GPU_SCENE_PRIMITIVE_REACTIVE : 0) |
    (resetPrevious || !temporal.motionValid ? GPU_SCENE_PRIMITIVE_MOTION_INVALID : 0)
  );
}

/** Persistent GPU tables derived only from renderer projection slots. */
export class GpuScene {
  readonly inputs: GpuSceneInputs;
  private meshes = new MeshFrame();
  private materialFrame: MaterialFrame | undefined;
  private readonly sharedMeshes = new Map<string, MeshAllocation>();
  private readonly morphDeltas = new Map<MeshMorphDeltas, MorphDeltaAllocation>();
  private readonly morphRows = new Map<number, MorphRowAllocation>();
  private morphScratch = new DataView(new ArrayBuffer(64));
  private readonly pendingMeshes = new Set<MeshVersion>();

  private readonly dirtyRanges = new GpuDirtyRanges();
  private readonly rowScratch = new Uint8Array(PRIMITIVE.stride);
  private readonly rowScratchView = new DataView(this.rowScratch.buffer);
  private disposed = false;
  private failure: RhiError | undefined;
  private tableBytes: Record<GpuSceneTableName, ArrayBuffer>;
  private transformBytes: Uint8Array;
  private transformView: DataView;
  private buffers: GpuSceneBuffers;
  private readonly retiredBuffers = new Set<Buffer>();
  private readonly bufferHolders = new Map<Buffer, number>();
  private resourceFrames = 0;
  private readonly pendingMaterials = new Set<MaterialVersion>();
  private readonly pendingMaterialRoots = new Set<MaterialAllocation>();
  private uploadRanges = 0;
  private uploadBytes = 0;
  private capacityGrows = 0;
  private materialCapacity: number;
  private fullRebuilds = 0;
  private clearedSlots = 0;
  private noChangeFrames = 0;
  /** Monotonic content identity consumed by shadow-cache invalidation. */
  private sceneContentRevision = 0;
  private readonly changeLog = new GpuSceneChangeLog();
  private identityUploaded = false;
  private readonly allocations = new PrimitiveAllocations<
    MeshAllocation,
    readonly MaterialAllocation[]
  >();
  /** Equal material range lists are one shared interned array across rows. */
  private readonly rangeLists = new Map<
    string,
    { readonly ranges: readonly MaterialAllocation[]; holders: number }
  >();
  /** Advances whenever any slot's row allocation (instance start/count) changes. */
  private allocationRevisionValue = 0;
  /** Current stable instance identities retained beside compact GPU rows. */
  private readonly instanceGenerations = new Map<number, Uint32Array>();
  private readonly instanceResidents = new Map<number, InstanceResidentRevision>();
  /** Instance transform rows visited by instance-only updates (O(dirty) evidence). */
  private instanceRowsVisited = 0;
  private readonly records = new StableRangeAllocator();
  private readonly instances = new StableRangeAllocator();
  private readonly transforms = new StableRangeAllocator();
  private readonly materials = new StableRangeAllocator();
  private readonly sharedMaterials = new Map<MaterialResource, MaterialAllocation>();
  private readonly writesByTable: Record<GpuSceneTableName, number[]> = {
    primitive: [],
    instance: [],
    transform: [],
    material: [],
  };
  /**
   * Stamp of the frame being prepared; row 0 carries it to the GPU. It
   * advances only when a frame is submitted, so writes of skipped or failed
   * frames fold into the next attempt of the same frame.
   */
  private frameStamp = 1;
  /** Transform rows holding previous poses for rows stamped with `frameStamp`. */
  private readonly previousRows: number[] = [];
  private transformCapacity: number;

  private constructor(
    private readonly device: RhiDevice,
    private capacity: number,
    buffers: GpuSceneBuffers,
    private readonly shaderRegistry?: ShaderRegistry,
    arena?: GpuInputArena,
  ) {
    this.inputs = new GpuSceneInputs(device, (slot) => this.primitiveIndexForSlot(slot), arena);
    this.buffers = buffers;
    this.materialCapacity = INITIAL_MATERIAL_CAPACITY;
    this.transformCapacity = capacity;
    this.tableBytes = this.allocateCpuTables(capacity, this.materialCapacity);
    this.transformBytes = new Uint8Array(this.tableBytes.transform);
    this.transformView = new DataView(this.tableBytes.transform);
    this.transforms.reset(1);
    this.writeIdentityTransform();
  }

  static create(
    device: RhiDevice,
    initialCapacity = 256,
    shaderRegistry?: ShaderRegistry,
    arena?: GpuInputArena,
  ): Result<GpuSceneAvailability, RhiError> {
    if (!device.caps.storageBuffer) {
      return ok({ status: 'unavailable', reason: 'storage-buffer-unavailable' });
    }
    const requestedCapacity = Number.isFinite(initialCapacity)
      ? Math.max(1, Math.ceil(initialCapacity))
      : 256;
    const capacity = 2 ** Math.ceil(Math.log2(requestedCapacity));
    const buffers = createBuffers(device, capacity, INITIAL_MATERIAL_CAPACITY);
    if (!buffers.ok) return err(buffers.error);
    return ok({
      status: 'available',
      scene: new GpuScene(device, capacity, buffers.value, shaderRegistry, arena),
    });
  }

  get primitiveBuffer(): Buffer {
    return this.buffers.primitive;
  }

  get instanceBuffer(): Buffer {
    return this.buffers.instance;
  }

  get transformBuffer(): Buffer {
    return this.buffers.transform;
  }

  get materialBuffer(): Buffer {
    return this.buffers.material;
  }

  get contentRevision(): number {
    return this.sceneContentRevision;
  }

  /** World boxes changed after `revision`; see {@link GpuSceneChangeLog}. */
  changedBoundsSince(
    revision: number,
    ignoredSlots?: ReadonlySet<number>,
    observedSlots?: { has(slot: number): boolean },
  ): GpuSceneChangedBounds {
    return this.changeLog.changedSince(
      revision,
      this.sceneContentRevision,
      ignoredSlots,
      observedSlots,
    );
  }

  /** Slots created, changed or removed after `revision`; `undefined` when unproven. */
  changedSlotsSince(revision: number): readonly number[] | undefined {
    return this.changeLog.changedSlotsSince(revision, this.sceneContentRevision);
  }

  /** Every world box `slots` occupied after `revision`; see {@link GpuSceneChangeLog}. */
  slotBoundsSince(revision: number, slots: Iterable<number>): GpuSceneChangedBounds {
    return this.changeLog.slotBoundsSince(revision, this.sceneContentRevision, slots);
  }

  /**
   * Resolve the stable scene-material row for one retained render slot. The
   * GPU-driven shadow projection uses this producer-owned index instead of
   * reconstructing material identity from a batch position.
   */
  materialIndexForSlot(slot: number, materialSlot: number): number | undefined {
    const ranges = this.allocations.materialRanges(slot);
    if (
      ranges === undefined ||
      !Number.isInteger(materialSlot) ||
      materialSlot < 0 ||
      materialSlot >= ranges.length
    ) {
      return undefined;
    }
    const version = ranges[materialSlot]?.version;
    return version?.initialized === true ? version.descriptor : undefined;
  }

  /** Shared binding lookup for execution preparation; never follows a representative slot. */
  materialIndexForResource(resource: MaterialResource): number | undefined {
    const version = this.sharedMaterials.get(resource)?.version;
    return version?.initialized === true ? version.descriptor : undefined;
  }

  captureResources(): Result<GpuSceneResourceFrame, RhiError> {
    if (this.failure !== undefined) return err(this.failure);
    if (this.disposed || this.resourceFrames >= 128)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'a live GPU Scene with fewer than 128 retained resource frames',
          hint: 'release abandoned preparations and complete submitted frames before preparing more',
        }),
      );
    this.resourceFrames++;
    const buffers = new Set<Buffer>();
    let generation: GpuSceneBuffers | undefined;
    const pinBuffers = () => {
      if (generation === this.buffers) return;
      generation = this.buffers;
      for (const buffer of Object.values(generation)) {
        if (buffers.has(buffer)) continue;
        buffers.add(buffer);
        this.bufferHolders.set(buffer, (this.bufferHolders.get(buffer) ?? 0) + 1);
      }
    };
    const versions = new Map<MaterialResource, MaterialVersion>();
    const meshes = new Map<string, MeshVersion>();
    const inputs = this.inputs.capture();
    let state: 'prepared' | 'sealed' | 'submitted' | 'released' = 'prepared';
    const release = () => {
      if (state === 'released') return;
      state = 'released';
      this.resourceFrames--;
      inputs.release();
      for (const version of versions.values())
        this.releaseMaterialVersion(version, this.writesByTable);
      versions.clear();
      for (const version of meshes.values()) this.releaseMeshVersion(version);
      meshes.clear();
      for (const buffer of buffers) {
        const remaining = (this.bufferHolders.get(buffer) ?? 1) - 1;
        if (remaining > 0) this.bufferHolders.set(buffer, remaining);
        else {
          this.bufferHolders.delete(buffer);
          if (this.retiredBuffers.has(buffer)) this.retireBuffer(buffer);
        }
      }
      buffers.clear();
      generation = undefined;
    };
    const frame: GpuSceneResourceFrame = {
      indexForResource: (resource, snapshot) => {
        if (state !== 'prepared' || this.disposed || this.failure !== undefined) return undefined;
        let version = versions.get(resource);
        if (version === undefined) {
          version = this.sharedMaterials.get(resource)?.version;
          if (
            version?.initialized !== true ||
            (snapshot !== undefined && version.snapshot !== snapshot)
          )
            return undefined;
          const allocation = this.sharedMaterials.get(resource);
          if (
            allocation === undefined ||
            inputs.resource(allocation.logicalSlot) !== version.descriptor
          )
            return undefined;
          pinBuffers();
          version.references++;
          versions.set(resource, version);
        }
        return snapshot === undefined || version.snapshot === snapshot
          ? version.descriptor
          : undefined;
      },
      indexForGeometry: (worldId, handle, geometry) => {
        if (state !== 'prepared' || this.disposed || this.failure !== undefined) return undefined;
        const key = `${worldId}:${handle}`;
        let version = meshes.get(key);
        if (version === undefined) {
          version = this.sharedMeshes.get(key)?.version;
          if (version === undefined || (geometry !== undefined && version.geometry !== geometry))
            return undefined;
          const allocation = this.sharedMeshes.get(key);
          if (
            allocation === undefined ||
            inputs.resource(allocation.logicalSlot) !== version.descriptor
          )
            return undefined;
          pinBuffers();
          version.references++;
          meshes.set(key, version);
        }
        return geometry === undefined || version.geometry === geometry
          ? version.descriptor
          : undefined;
      },
      logicalForResource: (resource, snapshot) => {
        const descriptor = frame.indexForResource(resource, snapshot);
        const slot = this.sharedMaterials.get(resource)?.logicalSlot;
        return descriptor === undefined ||
          slot === undefined ||
          inputs.resource(slot) !== descriptor
          ? undefined
          : slot;
      },
      logicalForGeometry: (worldId, handle, geometry) => {
        const descriptor = frame.indexForGeometry(worldId, handle, geometry);
        const slot = this.sharedMeshes.get(`${worldId}:${handle}`)?.logicalSlot;
        return descriptor === undefined ||
          slot === undefined ||
          inputs.resource(slot) !== descriptor
          ? undefined
          : slot;
      },
      pins: () => ({
        scene: this,
        materials: Array.from(
          versions,
          ([resource, version]) => [resource, version, version.snapshot] as const,
        ),
        meshes: Array.from(meshes, ([key, version]) => [key, version, version.geometry] as const),
      }),
      adoptPins: (pins) => {
        if (
          pins.scene !== this ||
          state !== 'prepared' ||
          this.disposed ||
          this.failure !== undefined
        )
          return false;
        for (const [resource, version, snapshot] of pins.materials) {
          if (versions.get(resource) === version) continue;
          const allocation = this.sharedMaterials.get(resource);
          if (
            allocation === undefined ||
            allocation.version !== version ||
            !version.initialized ||
            version.snapshot !== snapshot ||
            versions.has(resource) ||
            inputs.resource(allocation.logicalSlot) !== version.descriptor
          )
            return false;
          pinBuffers();
          version.references++;
          versions.set(resource, version);
        }
        for (const [key, version, geometry] of pins.meshes) {
          if (meshes.get(key) === version) continue;
          const allocation = this.sharedMeshes.get(key);
          if (
            allocation === undefined ||
            allocation.version !== version ||
            version.geometry !== geometry ||
            meshes.has(key) ||
            inputs.resource(allocation.logicalSlot) !== version.descriptor
          )
            return false;
          pinBuffers();
          version.references++;
          meshes.set(key, version);
        }
        return true;
      },
      inputReads: () => {
        if (this.failure !== undefined) throw this.failure;
        if (state !== 'prepared' || this.disposed)
          throw new Error('GPU scene member reads require an open resource frame');
        return inputs;
      },
      release: () => {
        if (state === 'prepared' || state === 'sealed') release();
      },
      seal: () => {
        if (state === 'sealed') return ok(undefined);
        if (this.failure !== undefined) return err(this.failure);
        if (state !== 'prepared' || this.disposed)
          throw new Error('GPU scene resource reads must be live when sealed');
        const sealed = inputs.seal();
        if (!sealed.ok) return sealed;
        pinBuffers();
        state = 'sealed';
        return ok(undefined);
      },
      submit: (completed) => {
        if (state === 'released' || state === 'submitted') return;
        if (state !== 'sealed') throw new Error('Seal GPU scene resource reads before submission');
        state = 'submitted';
        void (completed ?? this.device.queue.onSubmittedWorkDone()).then(release, release);
      },
    };
    return ok(frame);
  }

  /** Scene slots and metadata rows have independent lifetime and allocation. */
  primitiveIndexForSlot(slot: number): number | undefined {
    return this.allocations.recordIndex(slot);
  }

  /** Resolve the scene instance row that GPU-driven visible items carry in `x`. */
  instanceIndexForSlot(slot: number, instanceOrdinal: number): number | undefined {
    const start = this.allocations.instanceStart(slot);
    if (
      start === undefined ||
      !Number.isInteger(instanceOrdinal) ||
      instanceOrdinal < 0 ||
      instanceOrdinal >= this.allocations.instanceCount(slot)
    ) {
      return undefined;
    }
    return start + instanceOrdinal;
  }

  /** Identity of the slot -> row allocation map; row-keyed caches compare it. */
  get allocationRevision(): number {
    return this.allocationRevisionValue;
  }

  /** Row capacity of the instance, transform and draw tables. */
  /** Whether any row reads morph inputs from the shared scene input arena. */
  get hasMorphRows(): boolean {
    return this.morphRows.size > 0;
  }

  get rowCapacity(): number {
    return this.capacity;
  }

  get materialByteLength(): number {
    return this.tableBytes.material.byteLength;
  }

  get transformByteLength(): number {
    return this.tableBytes.transform.byteLength;
  }

  sync(
    delta: RenderSceneApplyResult,
    temporalResolver?: GpuSceneTemporalResolver,
    boundsOf?: GpuSceneSlotBounds,
    rowBoxesOf?: GpuSceneSlotRowBoxes,
  ): Result<GpuSceneSyncResult, RhiError> {
    if (this.failure !== undefined) return err(this.failure);
    try {
      this.adoptMaterialFrame(delta);
      this.adoptMeshFrame(delta);
      if (this.isUnchangedDelta(delta)) {
        this.noChangeFrames += 1;
        return ok({ ranges: 0, bytes: 0, grew: false, cleared: 0 });
      }
      const writesByTable = this.writesByTable;
      if (!this.identityUploaded && !writesByTable.transform.includes(0)) {
        writesByTable.transform.push(0);
      }
      const allocationResets = this.allocateDeltaSlots(delta, writesByTable);
      const requiredCapacity = Math.max(
        this.records.requiredCapacity(),
        this.instances.requiredCapacity(),
      );
      const requiredTransformCapacity = this.transforms.requiredCapacity();
      const requiredMaterialCapacity = this.materials.requiredCapacity();
      const grew =
        requiredCapacity > this.capacity ||
        requiredTransformCapacity > this.transformCapacity ||
        requiredMaterialCapacity > this.materialCapacity;
      if (grew) {
        const grown = this.grow(
          requiredCapacity,
          requiredTransformCapacity,
          requiredMaterialCapacity,
        );
        if (!grown.ok) return grown;
      }
      for (const range of this.pendingMeshes) this.writeMeshDescriptor(range);
      const materialRows = this.writePendingMaterials(delta, writesByTable);
      this.writeSlotPublications(
        delta,
        allocationResets,
        writesByTable,
        materialRows,
        temporalResolver,
      );
      const uploaded = this.uploadRows(writesByTable);
      if (!uploaded.ok) return uploaded;
      this.completeSync(delta, boundsOf, rowBoxesOf);
      return ok({
        ranges: uploaded.value.ranges,
        bytes: uploaded.value.bytes,
        grew,
        cleared: delta.removedSlots.length,
      });
    } catch (cause) {
      // A failed numeric-map publication may follow CPU resource mutation.
      // Retire this owner through the existing Scene failGpu/cold-baseline path;
      // never consume another diff on a partially published map. Ordinary
      // queue Result.err still takes the existing retry path above.
      this.failure =
        cause instanceof RhiError
          ? cause
          : Object.assign(
              new RhiError({
                code: 'internal-error',
                expected: 'atomic GPU Scene resource publication',
                hint: 'retire this GPU Scene and rebuild from its accepted source baseline',
              }),
              { cause },
            );
      return err(this.failure);
    }
  }

  /** Adopt the accepted shared-material frame: release, acquire or re-pack changed roots. */
  private adoptMaterialFrame(delta: RenderSceneApplyResult): void {
    if (delta.materials === undefined || delta.materials === this.materialFrame) return;
    const previous = this.materialFrame ?? new MaterialFrame(undefined);
    this.materialFrame = delta.materials;
    delta.materials.changesSince(previous, (before, after) =>
      this.adoptMaterialChange(before, after),
    );
  }

  private adoptMaterialChange(
    before: AcceptedMaterial | undefined,
    after: AcceptedMaterial | undefined,
  ): void {
    if (after === undefined) {
      const allocation =
        before === undefined ? undefined : this.sharedMaterials.get(before.resource);
      if (allocation !== undefined) this.releaseMaterial(allocation, this.writesByTable);
      return;
    }
    if (before?.snapshot === after.snapshot) return;
    const allocation =
      before === undefined
        ? this.acquireMaterial(
            after.resource,
            this.materialUnits(after.snapshot),
            this.writesByTable,
          )
        : this.sharedMaterials.get(after.resource);
    if (allocation === undefined) throw new Error('Accepted GPU material root is missing');
    this.adoptMaterial(allocation, this.writesByTable);
    if (!allocation.version.initialized || before?.snapshot !== after.snapshot)
      this.pendingMaterialRoots.add(allocation);
  }

  /** Adopt the accepted mesh frame: changed geometry reuses or replaces its descriptor. */
  private adoptMeshFrame(delta: RenderSceneApplyResult): void {
    if (delta.meshes === undefined || delta.meshes === this.meshes) return;
    delta.meshes.changesSince(this.meshes, (_before, geometry) => {
      if (geometry === undefined) return;
      this.adoptMeshGeometry(geometry);
      if (this.morphRows.size > 0) this.adoptMorphDeltas(geometry);
    });
    this.meshes = delta.meshes;
  }

  private adoptMeshGeometry(geometry: MeshGeometry): void {
    const range = this.sharedMeshes.get(`${geometry.worldId}:${geometry.handle}`);
    if (range === undefined) return;
    const previous = range.version;
    const words = meshInputWords(geometry);
    if (previous.references === 1 && previous.words === words) previous.geometry = geometry;
    else {
      range.version = {
        descriptor: this.inputs.arena.allocateDescriptor(words),
        words,
        geometry,
        references: 1,
      };
      this.releaseMeshVersion(previous);
    }
    this.inputs.updateResource(range.logicalSlot, range.version.descriptor);
    this.pendingMeshes.add(range.version);
  }

  /** True when neither the delta nor retained pending work needs a publication. */
  private isUnchangedDelta(delta: RenderSceneApplyResult): boolean {
    return (
      delta.createdSlots.length === 0 &&
      delta.updatedSlots.length === 0 &&
      delta.recreatedSlots.length === 0 &&
      delta.removedSlots.length === 0 &&
      delta.resynced === 0 &&
      delta.contentUpdatedSlots.length === 0 &&
      (delta.materialUpdates?.length ?? 0) === 0 &&
      delta.instanceUpdatedSlots.length === 0 &&
      !TABLE_NAMES.some((name) => this.writesByTable[name].length > 0) &&
      this.pendingMeshes.size === 0 &&
      this.pendingMaterialRoots.size === 0 &&
      this.identityUploaded
    );
  }

  /** Clear removed rows, then ensure every published slot's allocation; returns reset slots. */
  private allocateDeltaSlots(
    delta: RenderSceneApplyResult,
    writesByTable: Record<GpuSceneTableName, number[]>,
  ): Set<number> {
    const allocationResets = new Set<number>();
    if (delta.resynced > 0) {
      for (const slot of [...this.allocations.keys()]) this.clearSlot(slot, writesByTable);
    }
    // RenderScene may recycle a released CPU slot for a different identity in
    // the same delta. Clear the old GPU allocation before ensuring the new
    // record; otherwise the later removal pass clears the newly allocated
    // record and the next transform-only update sees no allocation.
    for (const record of delta.removedSlots) {
      this.clearSlot(record.slot, writesByTable);
    }
    for (const records of [
      delta.createdSlots,
      delta.contentUpdatedSlots,
      delta.instanceUpdatedSlots,
      delta.recreatedSlots,
    ]) {
      for (const record of records) {
        const previous = this.allocations.stamp(record.slot);
        this.ensureAllocation(record, writesByTable);
        if (previous !== this.allocations.stamp(record.slot)) allocationResets.add(record.slot);
      }
    }
    for (const resource of delta.materialUpdates ?? []) {
      const range = this.sharedMaterials.get(resource);
      if (range !== undefined) this.adoptMaterial(range, writesByTable);
    }
    return allocationResets;
  }

  /** Write one shared mesh descriptor header and its Skin envelope into the input arena. */
  private writeMeshDescriptor(range: MeshVersion): void {
    const envelopes = range.geometry.skinEnvelopes;
    if ((envelopes?.length ?? 0) !== range.words - GPU_MESH_DESCRIPTOR.words)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'the complete admitted Skin Mesh envelope within its allocated extent',
        hint: 'retain immutable Mesh facts until every recorded frame has retired',
      });
    const bounds = range.geometry.bounds;
    this.rowScratchView.setUint32(
      GPU_MESH_DESCRIPTOR.flags * 4,
      bounds === undefined ? 0 : PRIMITIVE_HAS_BOUNDS,
      true,
    );
    for (let axis = 0; axis < 3; axis++) {
      this.rowScratchView.setFloat32(
        (GPU_MESH_DESCRIPTOR.min + axis) * 4,
        bounds?.[axis] ?? 0,
        true,
      );
      this.rowScratchView.setFloat32(
        (GPU_MESH_DESCRIPTOR.max + axis) * 4,
        bounds?.[axis + 3] ?? 0,
        true,
      );
    }
    const envelopeAddress =
      envelopes === undefined ? 0 : range.descriptor + GPU_MESH_DESCRIPTOR.words;
    this.rowScratchView.setUint32(GPU_MESH_DESCRIPTOR.skinEnvelopes * 4, envelopeAddress, true);
    for (let word = 0; word < GPU_MESH_DESCRIPTOR.words; word++)
      this.inputs.arena.writeDescriptorWord(
        range.descriptor,
        range.words,
        word,
        this.rowScratchView.getUint32(word * 4, true),
      );
    if (envelopes !== undefined)
      this.inputs.arena.writeDescriptor(
        range.descriptor,
        new DataView(envelopes.buffer, envelopes.byteOffset, envelopes.byteLength),
        range.words,
        GPU_MESH_DESCRIPTOR.words,
      );
  }

  /**
   * Pack pending shared-material roots and updated resources. A shared material
   * has one packed value per publication, independent of how many primitives
   * reference it. Do not retain mutable caller snapshots.
   */
  private writePendingMaterials(
    delta: RenderSceneApplyResult,
    writesByTable: Record<GpuSceneTableName, number[]>,
  ): Map<MaterialSnapshot, Uint8Array> {
    const materialRows = new Map<MaterialSnapshot, Uint8Array>();
    for (const allocation of this.pendingMaterialRoots)
      this.writeMaterial(allocation.version, writesByTable, materialRows, false);
    for (const resource of delta.materialUpdates ?? []) {
      const range = this.sharedMaterials.get(resource);
      if (range !== undefined)
        this.writeMaterial(range.version, writesByTable, materialRows, false);
    }
    return materialRows;
  }

  /** Full rows for new/reset/content slots; transform-only rows for the rest. */
  private writeSlotPublications(
    delta: RenderSceneApplyResult,
    allocationResets: ReadonlySet<number>,
    writesByTable: Record<GpuSceneTableName, number[]>,
    materialRows: Map<MaterialSnapshot, Uint8Array>,
    temporalResolver: GpuSceneTemporalResolver | undefined,
  ): void {
    const contentUpdatedSlotIds = new Set(delta.contentUpdatedSlots.map((record) => record.slot));
    const instanceUpdatedSlotIds = new Set(delta.instanceUpdatedSlots.map((record) => record.slot));
    const publications = [...delta.createdSlots, ...delta.updatedSlots, ...delta.recreatedSlots];
    const newSlots = new Set(
      [...delta.createdSlots, ...delta.recreatedSlots].map((record) => record.slot),
    );
    for (const record of publications) {
      const reset = newSlots.has(record.slot) || allocationResets.has(record.slot);
      if (reset || contentUpdatedSlotIds.has(record.slot)) {
        this.writeSlot(record, reset, writesByTable, materialRows, temporalResolver?.(record));
        continue;
      }
      const temporal = temporalResolver?.(record);
      if (instanceUpdatedSlotIds.has(record.slot))
        this.writeInstanceTransforms(record, writesByTable, temporal);
      this.writeRootTransform(record, false, writesByTable);
      this.writeTemporalFlags(record.slot, primitiveTemporalFlags(false, temporal), writesByTable);
    }
  }

  /** Retire pending upload state after a successful row upload and record the content change. */
  private completeSync(
    delta: RenderSceneApplyResult,
    boundsOf: GpuSceneSlotBounds | undefined,
    rowBoxesOf: GpuSceneSlotRowBoxes | undefined,
  ): void {
    for (const version of this.pendingMaterials) version.initialized = true;
    this.pendingMaterials.clear();
    this.pendingMaterialRoots.clear();
    this.pendingMeshes.clear();
    for (const name of TABLE_NAMES) this.writesByTable[name].length = 0;
    this.identityUploaded = true;
    this.clearedSlots += delta.removedSlots.length;
    if (delta.resynced > 0) this.fullRebuilds += 1;
    this.sceneContentRevision += 1;
    this.changeLog.record(this.sceneContentRevision, delta, boundsOf, rowBoxesOf);
  }

  /**
   * Receipt of a submitted frame: the next frame gets a fresh stamp, so every
   * row stamped by this one reads previous = current again without a write,
   * and its previous-pose rows return to the allocator. Queue order keeps the
   * stamp write behind the submitted work that still reads them.
   */
  commitFrame(): Result<void, RhiError> {
    if (this.failure !== undefined) return err(this.failure);
    this.frameStamp = this.frameStamp === 0xffffffff ? 1 : this.frameStamp + 1;
    for (const row of this.previousRows) this.transforms.release(row, 1);
    this.previousRows.length = 0;
    this.transformView.setUint32(TRANSFORM_STAMP, this.frameStamp, true);
    const written = this.device.queue.writeBuffer(
      this.buffers.transform,
      TRANSFORM_STAMP,
      this.transformBytes.subarray(TRANSFORM_STAMP, TRANSFORM_STAMP + 4),
    );
    if (!written.ok) {
      this.writesByTable.transform.push(0);
      return written;
    }
    this.uploadRanges += 1;
    this.uploadBytes += 4;
    return ok(undefined);
  }

  /** Previous pose = current pose for the frame being prepared. */
  private seedPrevious(index: number, writes: Record<GpuSceneTableName, number[]>): void {
    const at = index * TRANSFORM.stride;
    this.transformView.setUint32(at + TRANSFORM_PREVIOUS, index, true);
    this.transformView.setUint32(at + TRANSFORM_STAMP, this.frameStamp, true);
    writes.transform.push(index);
  }

  /** Stamp a row for this frame without moving it; an earlier change this frame stays. */
  private stampTransform(index: number, writes: Record<GpuSceneTableName, number[]>): void {
    const at = index * TRANSFORM.stride;
    if (this.transformView.getUint32(at + TRANSFORM_STAMP, true) !== this.frameStamp)
      this.seedPrevious(index, writes);
  }

  /** Whether `index` already names a previous-pose row in the frame being prepared. */
  private hasPreviousRow(index: number): boolean {
    const at = index * TRANSFORM.stride;
    return (
      this.transformView.getUint32(at + TRANSFORM_STAMP, true) === this.frameStamp &&
      this.transformView.getUint32(at + TRANSFORM_PREVIOUS, true) !== index
    );
  }

  /** The row holding `index`'s previous pose this frame, allocated on its first change. */
  private previousRow(index: number, writes: Record<GpuSceneTableName, number[]>): number {
    const at = index * TRANSFORM.stride;
    if (this.hasPreviousRow(index))
      return this.transformView.getUint32(at + TRANSFORM_PREVIOUS, true);
    const row = this.transforms.allocate(1);
    this.previousRows.push(row);
    if (row >= this.transformCapacity) {
      const grown = this.grow(this.capacity, row + 1, this.materialCapacity);
      if (!grown.ok) throw grown.error;
    }
    this.transformView.setUint32(at + TRANSFORM_PREVIOUS, row, true);
    this.transformView.setUint32(at + TRANSFORM_STAMP, this.frameStamp, true);
    writes.transform.push(index, row);
    return row;
  }

  /**
   * Write a current pose. Its first change in the frame being prepared copies
   * the old pose, which is the pose of the last submitted frame, into a
   * previous-pose row: previous poses cost O(changed rows), never a column.
   */
  private writeTransform(
    index: number,
    matrix: Float32Array,
    sourceOffset: number,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const at = index * TRANSFORM.stride + TRANSFORM_CURRENT;
    let differs = false;
    for (let lane = 0; lane < 16 && !differs; lane += 1)
      differs = !Object.is(
        this.transformView.getFloat32(at + lane * 4, true),
        matrix[sourceOffset + lane] ?? 0,
      );
    if (!differs) return;
    if (!this.hasPreviousRow(index)) {
      const row = this.previousRow(index, writes);
      this.transformBytes.copyWithin(row * TRANSFORM.stride + TRANSFORM_CURRENT, at, at + 64);
    }
    writeMat4(this.transformView, at, matrix, sourceOffset);
    writes.transform.push(index);
  }

  /** Write a known previous pose (a mapped submitted instance row) for `index`. */
  private writePrevious(
    index: number,
    previous: Float32Array,
    previousOffset: number,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const row = this.previousRow(index, writes);
    writeMat4(
      this.transformView,
      row * TRANSFORM.stride + TRANSFORM_CURRENT,
      previous,
      previousOffset,
    );
    writes.transform.push(index, row);
  }

  private writeTemporalFlags(
    slot: number,
    temporalFlags: number,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const primitive = new DataView(this.tableBytes.primitive);
    const recordIndex = this.allocations.recordIndex(slot);
    if (recordIndex === undefined) return;
    const at = recordIndex * PRIMITIVE.stride + offset(PRIMITIVE, 'flags');
    const current = primitive.getUint32(at, true);
    const next =
      (current & ~(GPU_SCENE_PRIMITIVE_REACTIVE | GPU_SCENE_PRIMITIVE_MOTION_INVALID)) |
      temporalFlags;
    // Pulses hold only while the root row carries this frame's stamp.
    if (temporalFlags !== 0) {
      const transformStart = this.allocations.get(slot)?.transformStart;
      if (transformStart !== undefined) this.stampTransform(transformStart, writes);
    }
    if (next === current) return;
    primitive.setUint32(at, next, true);
    writes.primitive.push(recordIndex);
  }

  inspect(): GpuSceneInspection {
    return {
      capacity: this.capacity,
      tables: {
        primitive: {
          capacity: this.capacity,
          bytes: this.tableBytes.primitive.byteLength,
        },
        instance: {
          capacity: this.capacity,
          bytes: this.tableBytes.instance.byteLength,
        },
        transform: {
          capacity: this.transformCapacity,
          bytes: this.tableBytes.transform.byteLength,
        },
        material: {
          capacity: this.materialCapacity,
          bytes: this.tableBytes.material.byteLength,
        },
      },
      uploadRanges: this.uploadRanges,
      uploadBytes: this.uploadBytes,
      capacityGrows: this.capacityGrows,
      fullRebuilds: this.fullRebuilds,
      clearedSlots: this.clearedSlots,
      noChangeFrames: this.noChangeFrames,
      instanceRowsVisited: this.instanceRowsVisited,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    let failure: AggregateError | undefined;
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (cause) {
        if (failure === undefined)
          failure = new AggregateError([cause], 'GPU Scene retirement failed', { cause });
        else failure.errors.push(cause);
      }
    };
    // Each allocation owns one Version independent of primitive holders. Held
    // read frames keep their Version/range and buffers through final retirement.
    for (const range of this.sharedMeshes.values())
      attempt(() => this.releaseMeshVersion(range.version));
    for (const [slot, row] of [...this.morphRows]) attempt(() => this.releaseMorphRow(slot, row));
    for (const range of this.sharedMaterials.values())
      attempt(() => this.releaseMaterialVersion(range.version, this.writesByTable));
    this.allocations.clear();
    this.rangeLists.clear();
    this.sharedMeshes.clear();
    this.sharedMaterials.clear();
    this.pendingMeshes.clear();
    this.pendingMaterials.clear();
    this.pendingMaterialRoots.clear();
    this.meshes = new MeshFrame();
    this.materialFrame = undefined;
    this.records.reset();
    attempt(() => this.inputs.dispose());
    for (const buffer of Object.values(this.buffers)) attempt(() => this.retireBuffer(buffer));
    if (failure !== undefined) throw failure;
  }

  private writeSlot(
    record: RenderSceneSlot,
    resetPrevious: boolean,
    writes: Record<GpuSceneTableName, number[]>,
    materialRows: Map<MaterialSnapshot, Uint8Array>,
    temporal?: GpuSceneTemporalSnapshot,
  ): void {
    const allocation = this.allocations.get(record.slot);
    if (allocation === undefined) throw new RangeError('GPU Scene allocation unavailable');
    this.rowScratch.fill(0);
    const primitive = this.rowScratchView;
    const bounds = record.snapshot.localAabb;
    primitive.setUint32(offset(PRIMITIVE, 'generation'), record.generation, true);
    const temporalFlags = primitiveTemporalFlags(resetPrevious, temporal);
    primitive.setUint32(
      offset(PRIMITIVE, 'flags'),
      PRIMITIVE_ACTIVE |
        (bounds === undefined ? 0 : PRIMITIVE_HAS_BOUNDS) |
        (allocation.mesh === undefined ? 0 : PRIMITIVE_SHARED_GEOMETRY) |
        (record.snapshot.gpuDrivenDraws === undefined ? 0 : PRIMITIVE_GPU_DRIVEN) |
        (record.snapshot.capsuleShadowRequested === true ? GPU_SCENE_PRIMITIVE_CAPSULE_SHADOW : 0) |
        (record.snapshot.shadowReceiver === false ? GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE : 0) |
        temporalFlags,
      true,
    );
    primitive.setUint32(offset(PRIMITIVE, 'transformIndex'), allocation.transformStart, true);
    primitive.setUint32(
      offset(PRIMITIVE, 'materialIndex'),
      allocation.materialRanges[0]?.version.descriptor ?? 0,
      true,
    );
    primitive.setUint32(offset(PRIMITIVE, 'instanceStart'), allocation.instanceStart, true);
    primitive.setUint32(offset(PRIMITIVE, 'instanceCount'), allocation.instanceCount, true);
    primitive.setUint32(offset(PRIMITIVE, 'sourceIndex'), record.slot, true);
    writeVec4(primitive, offset(PRIMITIVE, 'localBoundsMin'), [
      bounds?.[0] ?? 0,
      bounds?.[1] ?? 0,
      bounds?.[2] ?? 0,
      0,
    ]);
    primitive.setUint32(
      offset(PRIMITIVE, 'lightingChannels'),
      record.snapshot.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT,
      true,
    );
    writeVec4(primitive, offset(PRIMITIVE, 'localBoundsMax'), [
      bounds?.[3] ?? 0,
      bounds?.[4] ?? 0,
      bounds?.[5] ?? 0,
      0,
    ]);

    if (this.writeRow('primitive', allocation.recordIndex, this.rowScratch) || resetPrevious)
      writes.primitive.push(allocation.recordIndex);

    const instance = new DataView(this.tableBytes.instance);
    const instances = record.snapshot.instances;
    const previousInstances = temporal?.previousInstances;
    const previousOrdinals = previousInstanceOrdinals(instances, temporal);
    const currentGenerations = instances?.generations;
    const residentGenerations = this.instanceGenerations.get(record.slot);
    const morphRow = this.writeMorphRow(record);
    for (let ordinal = 0; ordinal < allocation.instanceCount; ordinal += 1) {
      const instanceIndex = allocation.instanceStart + ordinal;
      const instanceOffset = instanceIndex * INSTANCE.stride;
      const transformIndex =
        allocation.instanceTransformCount === 0 ? 0 : allocation.instanceTransformStart + ordinal;
      let metadataChanged = writeChangedU32(
        instance,
        instanceOffset + offset(INSTANCE, 'primitiveIndex'),
        allocation.recordIndex,
      );
      metadataChanged =
        writeChangedU32(
          instance,
          instanceOffset + offset(INSTANCE, 'transformIndex'),
          transformIndex,
        ) || metadataChanged;
      metadataChanged =
        writeChangedU32(instance, instanceOffset + offset(INSTANCE, 'customDataStart'), morphRow) ||
        metadataChanged;
      metadataChanged =
        writeChangedU32(instance, instanceOffset + offset(INSTANCE, 'flags'), PRIMITIVE_ACTIVE) ||
        metadataChanged;
      if (allocation.instanceTransformCount > 0) {
        const transforms = instances?.transforms;
        const hasLocal = transforms !== undefined && transforms.length >= (ordinal + 1) * 16;
        const local = hasLocal ? transforms : IDENTITY_MATRIX;
        const sourceOffset = hasLocal ? ordinal * 16 : 0;
        const identityChanged = instanceIdentityChanged(
          residentGenerations,
          currentGenerations,
          ordinal,
        );
        this.writeInstanceTransform(
          transformIndex,
          local,
          sourceOffset,
          resetPrevious || identityChanged,
          previousOrdinals?.(ordinal),
          previousInstances,
          writes,
        );
      }
      if (metadataChanged || resetPrevious) writes.instance.push(instanceIndex);
    }

    this.rememberInstanceGenerations(record.slot, currentGenerations, allocation.instanceCount);
    this.rememberInstanceResident(record);

    this.writeRootTransform(record, resetPrevious, writes);
    // Pulses hold only while the root row carries this frame's stamp.
    if (temporalFlags !== 0) this.stampTransform(allocation.transformStart, writes);

    this.writeMaterialSlot(record, writes, materialRows, resetPrevious);
  }

  /** Compare against the resident CPU bytes; pending upload rows survive failure. */
  private writeRow(table: GpuSceneTableName, index: number, row: Uint8Array): boolean {
    const stride = TABLE_LAYOUTS[table].stride;
    const destination = new Uint8Array(this.tableBytes[table], index * stride, stride);
    let changed = false;
    for (let byte = 0; byte < stride; byte += 1) {
      const value = row[byte] ?? 0;
      if (destination[byte] === value) continue;
      destination[byte] = value;
      changed = true;
    }
    return changed;
  }

  private materialProgramSchema(
    snapshot: MaterialSnapshot,
  ): readonly ParamSchemaEntry[] | undefined {
    const shaderId = snapshot.materialShaderId;
    if (shaderId === undefined || isCanonicalStandardPbrMaterialShader(shaderId)) return undefined;
    const shader = this.shaderRegistry?.findMaterialArtifact(shaderId);
    return shader?.ok === true && shader.value.paramSchema.length > 0
      ? shader.value.paramSchema
      : snapshot.materialParamSchema;
  }

  private writeMaterialSlot(
    record: RenderSceneSlot,
    writes: Record<GpuSceneTableName, number[]>,
    materialRows: Map<MaterialSnapshot, Uint8Array>,
    reset: boolean,
  ): void {
    const allocation = this.allocations.get(record.slot);
    if (allocation === undefined) throw new RangeError('GPU Scene allocation unavailable');
    for (let ordinal = 0; ordinal < allocation.materialRanges.length; ordinal += 1) {
      const range = allocation.materialRanges[ordinal];
      if (range === undefined) throw new RangeError('material range unavailable');
      this.writeMaterial(range.version, writes, materialRows, reset && !range.version.initialized);
    }
  }

  private writeMaterial(
    range: MaterialVersion,
    writes: Record<GpuSceneTableName, number[]>,
    materialRows: Map<MaterialSnapshot, Uint8Array>,
    reset: boolean,
  ): void {
    if (this.pendingMaterials.has(range)) return;
    // Shared descriptors never consume primitive/instance/transform rows.
    if (!Number.isSafeInteger(range.start) || range.start < 0 || range.start > 0xffffffff)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'material payload address fits u32',
        hint: 'retain a checked material range before encoding its shared descriptor',
      });
    this.rowScratchView.setUint32(GPU_MATERIAL_DESCRIPTOR.payload * 4, range.start, true);
    this.rowScratchView.setFloat32(
      GPU_MATERIAL_DESCRIPTOR.radius * 4,
      materialDisplacementRadius(range.snapshot),
      true,
    );
    this.rowScratchView.setUint32(
      GPU_MATERIAL_DESCRIPTOR.positionBounds * 4,
      range.snapshot.positionBounds === 'standard-input' ? 1 : 0,
      true,
    );
    this.inputs.arena.writeDescriptor(
      range.descriptor,
      this.rowScratchView,
      GPU_MATERIAL_DESCRIPTOR.words,
    );
    const snapshot = range.snapshot;
    let row = materialRows.get(snapshot);
    if (row === undefined) {
      const schema = this.materialProgramSchema(snapshot);
      row =
        schema === undefined
          ? packStandardPbrMaterialRow(STANDARD_PBR_RECEIPT, snapshot)
          : packMaterialProgramRow(schema, snapshot, Math.max(16, derive(schema).totalBytes));
      row ??= new Uint8Array(range.count * MATERIAL.stride);
      materialRows.set(snapshot, row);
    }
    if (row.byteLength !== range.count * MATERIAL.stride)
      throw new RangeError('material payload differs from its retained allocation');
    const destination = new Uint8Array(
      this.tableBytes.material,
      range.start * MATERIAL.stride,
      row.byteLength,
    );
    for (let unit = 0; unit < range.count; unit++) {
      let changed = reset || !range.initialized;
      for (let byte = unit * MATERIAL.stride; byte < (unit + 1) * MATERIAL.stride; byte++) {
        const value = row[byte] ?? 0;
        if (destination[byte] === value) continue;
        destination[byte] = value;
        changed = true;
      }
      if (changed) writes.material.push(range.start + unit);
    }
    range.initialized = false;
    this.pendingMaterials.add(range);
  }

  /** Consume changed instance fields independently of root or material changes. */
  private writeInstanceTransforms(
    record: RenderSceneSlot,
    writes: Record<GpuSceneTableName, number[]>,
    temporal?: GpuSceneTemporalSnapshot,
  ): void {
    const allocation = this.allocations.get(record.slot);
    const instances = record.snapshot.instances;
    if (allocation === undefined || instances === undefined) {
      throw new RangeError('GPU Scene instance update has no explicit allocation');
    }
    if (allocation.instanceTransformCount !== instances.instanceCount) {
      throw new RangeError('GPU Scene instance update changed instance count');
    }
    const previousOrdinals = previousInstanceOrdinals(instances, temporal);
    const previousInstances = temporal?.previousInstances;
    const currentGenerations = instances.generations;
    const residentGenerations = this.instanceGenerations.get(record.slot);
    // Rows outside the dirty ranges already mirror revision r - 1 == r and
    // keep their identity, so the full scan below would skip them anyway.
    const resident = this.instanceResidents.get(record.slot);
    const rowRanges =
      resident !== undefined &&
      instances.dirtyRanges !== undefined &&
      instances.collectionId === resident.collectionId &&
      instances.revision === resident.revision + 1 &&
      residentGenerations === currentGenerations
        ? instances.dirtyRanges
        : [{ start: 0, end: allocation.instanceTransformCount }];
    for (const range of rowRanges) {
      const end = Math.min(range.end, allocation.instanceTransformCount);
      this.instanceRowsVisited += Math.max(0, end - range.start);
      for (let ordinal = range.start; ordinal < end; ordinal += 1) {
        this.writeInstanceTransform(
          allocation.instanceTransformStart + ordinal,
          instances.transforms,
          ordinal * 16,
          instanceIdentityChanged(residentGenerations, currentGenerations, ordinal),
          previousOrdinals?.(ordinal),
          previousInstances,
          writes,
        );
      }
    }
    this.rememberInstanceGenerations(
      record.slot,
      currentGenerations,
      allocation.instanceTransformCount,
    );
    this.rememberInstanceResident(record);
  }

  private rememberInstanceResident(record: RenderSceneSlot): void {
    const instances = record.snapshot.instances;
    if (instances?.collectionId === undefined || instances.revision === undefined) {
      this.instanceResidents.delete(record.slot);
      return;
    }
    this.instanceResidents.set(record.slot, {
      collectionId: instances.collectionId,
      revision: instances.revision,
    });
  }

  private rememberInstanceGenerations(
    slot: number,
    generations: Uint32Array | undefined,
    instanceCount: number,
  ): void {
    if (generations === undefined || generations.length !== instanceCount) {
      this.instanceGenerations.delete(slot);
      return;
    }
    // Snapshot generation columns are immutable; retaining the reference lets
    // the next revision prove an unchanged identity set in O(1).
    this.instanceGenerations.set(slot, generations);
  }

  /**
   * One instance-local row. A row whose stable identity maps to a submitted
   * row borrows that row's pose as previous; a new, reset or unmapped row
   * seeds previous = current instead of inheriting another row's velocity.
   */
  private writeInstanceTransform(
    index: number,
    local: Float32Array,
    sourceOffset: number,
    reset: boolean,
    previousOrdinal: number | undefined,
    previousInstances: GpuSceneTemporalSnapshot['previousInstances'],
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const at = index * TRANSFORM.stride + TRANSFORM_CURRENT;
    if (reset) writeMat4(this.transformView, at, local, sourceOffset);
    else if (!writeChangedMat4(this.transformView, at, local, sourceOffset)) return;
    if (previousOrdinal !== undefined && previousInstances !== undefined)
      this.writePrevious(index, previousInstances.transforms, previousOrdinal * 16, writes);
    else this.seedPrevious(index, writes);
  }

  private writeRootTransform(
    record: RenderSceneSlot,
    resetPrevious: boolean,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const allocation = this.allocations.get(record.slot);
    if (allocation === undefined) throw new RangeError('GPU Scene allocation unavailable');
    const index = allocation.transformStart;
    const world = record.snapshot.transform.world;
    if (resetPrevious) {
      writeMat4(this.transformView, index * TRANSFORM.stride + TRANSFORM_CURRENT, world);
      this.seedPrevious(index, writes);
    } else this.writeTransform(index, world, 0, writes);
  }

  /**
   * Publish one row's morph weights beside its Mesh's shared target deltas and
   * return the descriptor its instance rows name; 0 is no morph. The arena
   * uploads only changed words, so a weight edit is one row-sized write.
   */
  private writeMorphRow(record: RenderSceneSlot): number {
    const morph = record.snapshot.morph;
    const deltas =
      morph === undefined
        ? undefined
        : this.meshes.get(record.worldId, record.snapshot.assetHandle)?.morph;
    let row = this.morphRows.get(record.slot);
    if (row !== undefined && (deltas === undefined || row.deltas !== deltas)) {
      this.releaseMorphRow(record.slot, row);
      row = undefined;
    }
    if (morph === undefined || deltas === undefined || morph.targetCount !== deltas.targetCount)
      return 0;
    const words = MORPH_ROW_HEADER_WORDS + deltas.targetCount;
    if (row === undefined) {
      row = {
        descriptor: this.inputs.arena.allocateDescriptor(words),
        words,
        worldId: record.worldId,
        handle: record.snapshot.assetHandle as number,
        deltas,
      };
      this.acquireMorphDeltas(deltas);
      this.morphRows.set(record.slot, row);
    }
    if (this.morphScratch.byteLength < words * 4)
      this.morphScratch = new DataView(new ArrayBuffer(words * 8));
    const scratch = this.morphScratch;
    this.writeMorphHeader(scratch, deltas);
    for (let target = 0; target < deltas.targetCount; target++)
      scratch.setFloat32((MORPH_ROW_HEADER_WORDS + target) * 4, morph.weights[target] ?? 0, true);
    this.inputs.arena.writeDescriptor(row.descriptor, scratch, words);
    return row.descriptor;
  }

  private writeMorphHeader(scratch: DataView, deltas: MeshMorphDeltas): void {
    scratch.setUint32(0, deltas.vertexCount, true);
    scratch.setUint32(4, deltas.targetCount, true);
    scratch.setUint32(8, (this.morphDeltas.get(deltas) as MorphDeltaAllocation).descriptor, true);
  }

  private acquireMorphDeltas(deltas: MeshMorphDeltas): void {
    let shared = this.morphDeltas.get(deltas);
    if (shared === undefined) {
      const descriptor = this.inputs.arena.allocateDescriptor(deltas.deltas.length);
      this.inputs.arena.writeDescriptor(
        descriptor,
        new DataView(deltas.deltas.buffer, deltas.deltas.byteOffset, deltas.deltas.byteLength),
        deltas.deltas.length,
      );
      shared = { descriptor, holders: 0 };
      this.morphDeltas.set(deltas, shared);
    }
    shared.holders++;
  }

  private releaseMorphDeltas(deltas: MeshMorphDeltas): void {
    const shared = this.morphDeltas.get(deltas);
    if (shared === undefined || --shared.holders > 0) return;
    this.morphDeltas.delete(deltas);
    this.inputs.arena.releaseDescriptor(shared.descriptor, deltas.deltas.length);
  }

  private releaseMorphRow(slot: number, row: MorphRowAllocation): void {
    this.morphRows.delete(slot);
    this.inputs.arena.releaseDescriptor(row.descriptor, row.words);
    this.releaseMorphDeltas(row.deltas);
  }

  /**
   * A replaced Mesh rebinds its morphed rows to the new deltas in place; rows
   * keep their addresses and weights. A changed target count disables the row
   * (vertexCount 0 keeps the shared positions) until its next extraction.
   */
  private adoptMorphDeltas(geometry: MeshGeometry): void {
    for (const row of this.morphRows.values()) {
      if (row.worldId !== geometry.worldId || row.handle !== geometry.handle) continue;
      const next = geometry.morph;
      if (next === row.deltas) continue;
      if (next === undefined || next.targetCount !== row.deltas.targetCount) {
        this.inputs.arena.writeDescriptorWord(row.descriptor, row.words, 0, 0);
        continue;
      }
      this.acquireMorphDeltas(next);
      this.releaseMorphDeltas(row.deltas);
      row.deltas = next;
      this.writeMorphHeader(this.morphScratch, next);
      for (let word = 0; word < MORPH_ROW_HEADER_WORDS; word++)
        this.inputs.arena.writeDescriptorWord(
          row.descriptor,
          row.words,
          word,
          this.morphScratch.getUint32(word * 4, true),
        );
    }
  }

  private clearSlot(slot: number, writes: Record<GpuSceneTableName, number[]>): void {
    const morphRow = this.morphRows.get(slot);
    if (morphRow !== undefined) this.releaseMorphRow(slot, morphRow);
    const allocation = this.allocations.get(slot);
    if (allocation === undefined) return;
    this.instanceGenerations.delete(slot);
    this.instanceResidents.delete(slot);
    this.clearAllocation(allocation, writes);
    this.releaseRanges(allocation.materialRanges);
    this.allocations.delete(slot);
    this.allocationRevisionValue += 1;
  }

  private uploadRows(
    rows: Readonly<Record<GpuSceneTableName, readonly number[]>>,
  ): Result<{ readonly ranges: number; readonly bytes: number }, RhiError> {
    let rangeCount = 0;
    let bytes = 0;
    for (const name of TABLE_NAMES) {
      const ranges = this.dirtyRanges.coalesce(rows[name]);
      rangeCount += ranges.length;
      for (const range of ranges) {
        const layout = TABLE_LAYOUTS[name];
        const tableOffset = range.start * layout.stride;
        const tableSize = (range.end - range.start) * layout.stride;
        const write = this.device.queue.writeBuffer(
          this.buffers[name],
          tableOffset,
          new Uint8Array(this.tableBytes[name], tableOffset, tableSize),
        );
        if (!write.ok) return write;
        bytes += tableSize;
      }
    }
    this.uploadRanges += rangeCount;
    this.uploadBytes += bytes;
    return ok({ ranges: rangeCount, bytes });
  }

  private ensureAllocation(
    record: RenderSceneSlot,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    // A present Instances component is authoritative even when its array is
    // empty: preserve zero so neither the GPU Scene nor the indirect topology
    // turns it into a synthetic identity instance. Entities without the
    // component retain the ordinary one-instance identity path.
    const explicitInstances = record.snapshot.instances;
    const instanceCount =
      explicitInstances === undefined
        ? 1
        : Math.max(0, Math.floor(explicitInstances.instanceCount));
    const instanceTransformCount = explicitInstances === undefined ? 0 : instanceCount;
    const materialUnits = Array.from(
      {
        length:
          this.materialFrame === undefined ? Math.max(1, record.snapshot.materials.length) : 0,
      },
      (_, ordinal) =>
        this.materialUnits(
          (record.snapshot.materials[ordinal] ?? record.snapshot.material).snapshot,
        ),
    );
    const geometry =
      record.snapshot.morph !== undefined ||
      record.snapshot.terrainSection !== undefined ||
      record.snapshot.pointsLines !== undefined
        ? undefined
        : this.meshes.get(record.worldId, record.snapshot.assetHandle);
    const geometryKey =
      geometry === undefined ? undefined : `${geometry.worldId}:${geometry.handle}`;
    const existing = this.allocations.get(record.slot);
    if (
      existing?.mesh?.key === geometryKey &&
      existing?.instanceCount === instanceCount &&
      existing.instanceTransformCount === instanceTransformCount &&
      existing.materialRanges.length === materialUnits.length &&
      existing.materialRanges.every(
        (range, index) =>
          range.resource === (record.snapshot.materials[index] ?? record.snapshot.material),
      )
    ) {
      for (const range of existing.materialRanges) this.adoptMaterial(range, writes);
      return;
    }
    const mesh = geometry === undefined ? undefined : this.acquireMesh(geometry);
    const recordIndex = existing?.recordIndex ?? this.records.allocate(1);
    // Hold reused identities before releasing this binding, but let retired
    // versions free their ranges before a genuinely new material allocates.
    // Prepared/submitted frame holders independently keep their versions live.
    const retainedMaterials = materialUnits.map((count, index) => {
      const resource = record.snapshot.materials[index] ?? record.snapshot.material;
      return this.sharedMaterials.has(resource)
        ? this.acquireMaterial(resource, count, writes)
        : undefined;
    });
    if (existing !== undefined) {
      this.clearAllocationRanges(existing, writes);
      this.releaseRanges(existing.materialRanges);
    }
    const ranges = materialUnits.map(
      (count, index) =>
        retainedMaterials[index] ??
        this.acquireMaterial(
          record.snapshot.materials[index] ?? record.snapshot.material,
          count,
          writes,
        ),
    );
    const materialRanges = this.internRanges(ranges);
    const allocation = {
      mesh,
      // Member nodes name this live slot's physical record. Resizing its
      // variable inputs must not invalidate every retained member root.
      recordIndex,
      instanceStart: this.instances.allocate(instanceCount),
      instanceCount,
      transformStart: this.transforms.allocate(1),
      instanceTransformStart:
        instanceTransformCount === 0 ? 0 : this.transforms.allocate(instanceTransformCount),
      instanceTransformCount,
      materialRanges,
    };
    this.allocations.set(record.slot, allocation);
    this.allocationRevisionValue += 1;
  }

  private internRanges(ranges: readonly MaterialAllocation[]): readonly MaterialAllocation[] {
    let key = '';
    for (const range of ranges) key += `${getOpaqueResourceIdentity(range)},`;
    let shared = this.rangeLists.get(key);
    if (shared === undefined) {
      shared = { ranges: Object.freeze([...ranges]), holders: 0 };
      this.rangeLists.set(key, shared);
    }
    shared.holders++;
    return shared.ranges;
  }

  private releaseRanges(ranges: readonly MaterialAllocation[]): void {
    let key = '';
    for (const range of ranges) key += `${getOpaqueResourceIdentity(range)},`;
    const shared = this.rangeLists.get(key);
    if (shared?.ranges === ranges && --shared.holders === 0) this.rangeLists.delete(key);
  }

  private acquireMesh(geometry: MeshGeometry): MeshAllocation {
    const key = `${geometry.worldId}:${geometry.handle}`;
    const existing = this.sharedMeshes.get(key);
    if (existing !== undefined) {
      existing.holders++;
      return existing;
    }
    const words = meshInputWords(geometry);
    const descriptor = this.inputs.arena.allocateDescriptor(words);
    let logicalSlot: number;
    try {
      logicalSlot = this.inputs.allocateResource(descriptor);
    } catch (cause) {
      try {
        this.inputs.arena.releaseDescriptor(descriptor, words);
      } catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], 'Unpublished Mesh cleanup failed', {
          cause,
        });
      }
      throw cause;
    }
    const range: MeshAllocation = {
      logicalSlot,
      key,
      version: { descriptor, words, geometry, references: 1 },
      holders: 1,
    };
    this.sharedMeshes.set(key, range);
    this.pendingMeshes.add(range.version);
    return range;
  }

  private releaseMaterial(
    range: MaterialAllocation,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    if (--range.holders !== 0) return;
    this.pendingMaterialRoots.delete(range);
    this.sharedMaterials.delete(range.resource);
    this.inputs.releaseResource(range.logicalSlot);
    this.releaseMaterialVersion(range.version, writes);
  }

  geometryIndexForResource(worldId: number, handle: number): number | undefined {
    return this.sharedMeshes.get(`${worldId}:${handle}`)?.version.descriptor;
  }

  private releaseMeshVersion(version: MeshVersion): void {
    if (--version.references !== 0) return;
    this.pendingMeshes.delete(version);
    this.inputs.arena.releaseDescriptor(version.descriptor, version.words);
  }

  private acquireMaterial(
    resource: MaterialResource,
    count: number,
    writes: Record<GpuSceneTableName, number[]>,
  ): MaterialAllocation {
    const existing = this.sharedMaterials.get(resource);
    if (existing !== undefined) {
      this.adoptMaterial(existing, writes);
      existing.holders++;
      return existing;
    }
    const version = this.allocateMaterialVersion(
      this.materialFrame?.get(resource)?.snapshot ?? resource.snapshot,
      count,
    );
    let logicalSlot: number;
    try {
      logicalSlot = this.inputs.allocateResource(version.descriptor);
    } catch (cause) {
      try {
        this.releaseMaterialVersion(version, writes);
      } catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], 'Unpublished Material cleanup failed', {
          cause,
        });
      }
      throw cause;
    }
    const range: MaterialAllocation = {
      logicalSlot,
      resource,
      holders: 1,
      version,
    };
    this.sharedMaterials.set(resource, range);
    return range;
  }

  private allocateMaterialVersion(snapshot: MaterialSnapshot, count: number): MaterialVersion {
    const start = this.materials.allocate(count, count);
    try {
      return {
        descriptor: this.inputs.arena.allocateDescriptor(GPU_MATERIAL_DESCRIPTOR.words),
        start,
        count,
        snapshot,
        references: 1,
        initialized: false,
      };
    } catch (cause) {
      this.materials.release(start, count);
      throw cause;
    }
  }

  private adoptMaterial(
    allocation: MaterialAllocation,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const previous = allocation.version;
    const snapshot =
      this.materialFrame?.get(allocation.resource)?.snapshot ?? allocation.resource.snapshot;
    if (previous.snapshot === snapshot) return;
    this.pendingMaterials.delete(previous);
    const count = this.materialUnits(snapshot);
    if (previous.references === 1) {
      this.resizeMaterial(previous, count, writes);
      previous.snapshot = snapshot;
    } else {
      allocation.version = this.allocateMaterialVersion(snapshot, count);
      this.releaseMaterialVersion(previous, writes);
    }
    this.inputs.updateResource(allocation.logicalSlot, allocation.version.descriptor);
  }

  private releaseMaterialVersion(
    version: MaterialVersion,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    if (--version.references !== 0) return;
    this.pendingMaterials.delete(version);
    this.inputs.arena.releaseDescriptor(version.descriptor, GPU_MATERIAL_DESCRIPTOR.words);
    this.clearMaterialRows(version, writes);
  }

  private clearMaterialRows(
    version: MaterialVersion,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const start = Math.min(version.start * MATERIAL.stride, this.tableBytes.material.byteLength);
    const end = Math.min(
      (version.start + version.count) * MATERIAL.stride,
      this.tableBytes.material.byteLength,
    );
    new Uint8Array(this.tableBytes.material, start, end - start).fill(0);
    for (let unit = start / MATERIAL.stride; unit < end / MATERIAL.stride; unit++)
      writes.material.push(unit);
    this.materials.release(version.start, version.count);
  }

  private materialUnits(snapshot: MaterialSnapshot): number {
    const schema = this.materialProgramSchema(snapshot);
    return (
      (schema === undefined
        ? GPU_SCENE_LAYOUTS.material.stride
        : Math.max(16, derive(schema).totalBytes)) / MATERIAL.stride
    );
  }

  private resizeMaterial(
    range: MaterialVersion,
    count: number,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    if (range.count === count) return;
    this.clearMaterialRows(range, writes);
    const start = this.materials.allocate(count, count);
    range.start = start;
    range.count = count;
    range.initialized = false;
  }

  private clearRecord(index: number, writes: Record<GpuSceneTableName, number[]>): void {
    if (index < this.capacity) {
      new Uint8Array(this.tableBytes.primitive, index * PRIMITIVE.stride, PRIMITIVE.stride).fill(0);
      writes.primitive.push(index);
    }
    this.records.release(index, 1);
  }

  private clearAllocation(
    allocation: PrimitiveAllocation,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    this.clearRecord(allocation.recordIndex, writes);
    this.clearAllocationRanges(allocation, writes);
  }

  private clearAllocationRanges(
    allocation: PrimitiveAllocation,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const mesh = allocation.mesh;
    if (mesh !== undefined && --mesh.holders === 0) {
      this.sharedMeshes.delete(mesh.key);
      this.inputs.releaseResource(mesh.logicalSlot);
      this.releaseMeshVersion(mesh.version);
    }
    for (let ordinal = 0; ordinal < allocation.instanceCount; ordinal += 1) {
      const instanceIndex = allocation.instanceStart + ordinal;
      new Uint8Array(
        this.tableBytes.instance,
        instanceIndex * INSTANCE.stride,
        INSTANCE.stride,
      ).fill(0);
      writes.instance.push(instanceIndex);
    }
    new Uint8Array(
      this.tableBytes.transform,
      allocation.transformStart * TRANSFORM.stride,
      TRANSFORM.stride,
    ).fill(0);
    writes.transform.push(allocation.transformStart);
    for (let ordinal = 0; ordinal < allocation.instanceTransformCount; ordinal += 1) {
      const transformIndex = allocation.instanceTransformStart + ordinal;
      new Uint8Array(
        this.tableBytes.transform,
        transformIndex * TRANSFORM.stride,
        TRANSFORM.stride,
      ).fill(0);
      writes.transform.push(transformIndex);
    }
    for (const range of allocation.materialRanges) this.releaseMaterial(range, writes);
    this.instances.release(allocation.instanceStart, allocation.instanceCount);
    this.transforms.release(allocation.transformStart, 1);
    this.transforms.release(allocation.instanceTransformStart, allocation.instanceTransformCount);
  }

  private retireBuffer(buffer: Buffer): void {
    this.retiredBuffers.add(buffer);
    if (this.bufferHolders.has(buffer)) return;
    // Submitted frames hold their buffers through completion, so a disposed
    // scene's unheld table has no pending work and retires with its owner.
    if (this.disposed) {
      this.retiredBuffers.delete(buffer);
      this.device.destroyBuffer(buffer);
      return;
    }
    const release = () => {
      if (!this.retiredBuffers.delete(buffer)) return;
      this.device.destroyBuffer(buffer);
    };
    void this.device.queue.onSubmittedWorkDone().then(release, release);
  }

  private grow(
    requiredCapacity: number,
    requiredTransformCapacity: number,
    requiredMaterialCapacity: number,
  ): Result<void, RhiError> {
    const limit = gpuSceneTableByteLimit(this.device);
    const rows = growGpuSceneTableCapacity(
      this.capacity,
      requiredCapacity,
      GPU_SCENE_ROW_TABLE_STRIDE,
      limit,
    );
    if (!rows.ok) return rows;
    const transforms = growGpuSceneTableCapacity(
      this.transformCapacity,
      requiredTransformCapacity,
      TRANSFORM.stride,
      limit,
    );
    if (!transforms.ok) return transforms;
    const materials = growGpuSceneTableCapacity(
      this.materialCapacity,
      requiredMaterialCapacity,
      MATERIAL.stride,
      limit,
    );
    if (!materials.ok) return materials;
    const next: Record<GpuSceneTableName, number> = {
      primitive: rows.value,
      instance: rows.value,
      transform: transforms.value,
      material: materials.value,
    };
    const nextBuffers = { ...this.buffers };
    const nextTables = { ...this.tableBytes };
    const replacements: GpuSceneTableName[] = [];
    let uploadedBytes = 0;
    for (const name of TABLE_NAMES) {
      const oldCapacity = this.tableBytes[name].byteLength / TABLE_LAYOUTS[name].stride;
      const newCapacity = next[name];
      if (oldCapacity === newCapacity) continue;
      const result = this.device.createBuffer({
        label: `gpu-scene-${name}-table`,
        size: newCapacity * TABLE_LAYOUTS[name].stride,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
        mappedAtCreation: false,
      });
      if (!result.ok) {
        for (const replaced of replacements) this.device.destroyBuffer(nextBuffers[replaced]);
        return result;
      }
      nextBuffers[name] = result.value;
      replacements.push(name);
      const bytes = new ArrayBuffer(newCapacity * TABLE_LAYOUTS[name].stride);
      new Uint8Array(bytes).set(new Uint8Array(this.tableBytes[name]));
      nextTables[name] = bytes;
      const write = this.device.queue.writeBuffer(result.value, 0, new Uint8Array(bytes));
      if (!write.ok) {
        for (const replaced of replacements) this.device.destroyBuffer(nextBuffers[replaced]);
        return write;
      }
      uploadedBytes += bytes.byteLength;
    }
    for (const name of replacements) this.retireBuffer(this.buffers[name]);
    this.buffers = nextBuffers;
    this.tableBytes = nextTables;
    this.refreshTransformViews();
    this.capacity = next.primitive;
    this.transformCapacity = next.transform;
    this.materialCapacity = next.material;
    this.capacityGrows += 1;
    this.uploadRanges += replacements.length;
    this.uploadBytes += uploadedBytes;
    return ok(undefined);
  }

  private allocateCpuTables(
    capacity: number,
    materialCapacity: number,
  ): Record<GpuSceneTableName, ArrayBuffer> {
    return {
      primitive: new ArrayBuffer(capacity * PRIMITIVE.stride),
      instance: new ArrayBuffer(capacity * INSTANCE.stride),
      transform: new ArrayBuffer(capacity * TRANSFORM.stride),
      material: new ArrayBuffer(materialCapacity * MATERIAL.stride),
    };
  }

  private refreshTransformViews(): void {
    this.transformBytes = new Uint8Array(this.tableBytes.transform);
    this.transformView = new DataView(this.tableBytes.transform);
  }

  private writeIdentityTransform(): void {
    writeMat4(this.transformView, TRANSFORM_CURRENT, IDENTITY_MATRIX);
    // Row 0 also carries the frame stamp every stamped row is compared with.
    this.transformView.setUint32(TRANSFORM_STAMP, this.frameStamp, true);
  }
}
