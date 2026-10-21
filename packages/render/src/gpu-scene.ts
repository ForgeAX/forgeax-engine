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
import type { MaterialSnapshot } from './render-system-extract';
import { MaterialFrame } from './scene/material-dispatch';
import { MeshFrame, type MeshGeometry } from './scene/mesh-frame';
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
  seal(): Result<void, RhiError>;
  release(): void;
  submit(completed?: Promise<void>): void;
}

interface MeshVersion {
  readonly descriptor: number;
  geometry: MeshGeometry;
  references: number;
}

interface MeshAllocation {
  readonly logicalSlot: number;
  readonly key: string;
  version: MeshVersion;
  holders: number;
}

interface PrimitiveAllocation {
  readonly mesh: MeshAllocation | undefined;
  readonly recordIndex: number;
  readonly instanceStart: number;
  readonly instanceCount: number;
  readonly transformStart: number;
  readonly instanceTransformStart: number;
  readonly instanceTransformCount: number;
  readonly materialRanges: readonly MaterialAllocation[];
}

type GpuSceneTableName = keyof GpuSceneBuffers;

const TABLE_LAYOUTS = {
  primitive: PRIMITIVE,
  instance: INSTANCE,
  transform: TRANSFORM,
  material: MATERIAL,
} as const satisfies Readonly<Record<GpuSceneTableName, GpuSceneTableLayout>>;

const TABLE_NAMES = Object.keys(TABLE_LAYOUTS) as readonly GpuSceneTableName[];
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

function writeMat4(view: DataView, byteOffset: number, value: Float32Array): void {
  for (let lane = 0; lane < 16; lane += 1) {
    view.setFloat32(byteOffset + lane * 4, value[lane] ?? 0, true);
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
  private readonly allocations = new Map<number, PrimitiveAllocation>();
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
  /** Transform rows whose previous value advances only after submit. */
  private readonly pendingTemporalTransforms = new Set<number>();
  /** Previous rows whose post-submit upload must be retried before the next draw. */
  private readonly pendingTemporalUploads = new Set<number>();
  /**
   * Primitive rows carrying temporal flags. Flags are one-submit pulses: the
   * next committed temporal frame advances previous = current, so they clear.
   */
  private readonly temporalFlagSlots = new Set<number>();

  private constructor(
    private readonly device: RhiDevice,
    private capacity: number,
    buffers: GpuSceneBuffers,
    private readonly shaderRegistry?: ShaderRegistry,
  ) {
    this.inputs = new GpuSceneInputs(device, (slot) => this.primitiveIndexForSlot(slot));
    this.buffers = buffers;
    this.materialCapacity = INITIAL_MATERIAL_CAPACITY;
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
      scene: new GpuScene(device, capacity, buffers.value, shaderRegistry),
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
    observedSlots?: ReadonlyMap<number, unknown>,
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
    const allocation = this.allocations.get(slot);
    if (
      allocation === undefined ||
      !Number.isInteger(materialSlot) ||
      materialSlot < 0 ||
      materialSlot >= allocation.materialRanges.length
    ) {
      return undefined;
    }
    const version = allocation.materialRanges[materialSlot]?.version;
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
    return this.allocations.get(slot)?.recordIndex;
  }

  /** Resolve the scene instance row that GPU-driven visible items carry in `x`. */
  instanceIndexForSlot(slot: number, instanceOrdinal: number): number | undefined {
    const allocation = this.allocations.get(slot);
    if (
      allocation === undefined ||
      !Number.isInteger(instanceOrdinal) ||
      instanceOrdinal < 0 ||
      instanceOrdinal >= allocation.instanceCount
    ) {
      return undefined;
    }
    return allocation.instanceStart + instanceOrdinal;
  }

  /** Identity of the slot -> row allocation map; row-keyed caches compare it. */
  get allocationRevision(): number {
    return this.allocationRevisionValue;
  }

  /** Row capacity of the instance, transform and draw tables. */
  get rowCapacity(): number {
    return this.capacity;
  }

  get materialByteLength(): number {
    return this.tableBytes.material.byteLength;
  }

  sync(
    delta: RenderSceneApplyResult,
    temporalResolver?: GpuSceneTemporalResolver,
    boundsOf?: GpuSceneSlotBounds,
    rowBoxesOf?: GpuSceneSlotRowBoxes,
  ): Result<GpuSceneSyncResult, RhiError> {
    if (this.failure !== undefined) return err(this.failure);
    try {
      if (delta.materials !== undefined && delta.materials !== this.materialFrame) {
        const previous = this.materialFrame ?? new MaterialFrame(undefined);
        this.materialFrame = delta.materials;
        delta.materials.changesSince(previous, (before, after) => {
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
        });
      }
      if (delta.meshes !== undefined && delta.meshes !== this.meshes) {
        delta.meshes.changesSince(this.meshes, (_before, geometry) => {
          if (geometry === undefined) return;
          const range = this.sharedMeshes.get(`${geometry.worldId}:${geometry.handle}`);
          if (range !== undefined) {
            const previous = range.version;
            if (previous.references === 1) previous.geometry = geometry;
            else {
              range.version = {
                descriptor: this.inputs.allocateDescriptor(GPU_MESH_DESCRIPTOR.words),
                geometry,
                references: 1,
              };
              this.releaseMeshVersion(previous);
            }
            this.inputs.updateResource(range.logicalSlot, range.version.descriptor);
            this.pendingMeshes.add(range.version);
          }
        });
        this.meshes = delta.meshes;
      }
      if (delta.resynced > 0) {
        this.pendingTemporalTransforms.clear();
        this.pendingTemporalUploads.clear();
        this.temporalFlagSlots.clear();
      }
      for (const transformIndex of this.pendingTemporalUploads) {
        this.writesByTable.transform.push(transformIndex);
      }
      const pendingWrites = TABLE_NAMES.some((name) => this.writesByTable[name].length > 0);
      const contentUpdatedSlots = delta.contentUpdatedSlots;
      const instanceUpdatedSlots = delta.instanceUpdatedSlots;
      if (
        delta.createdSlots.length === 0 &&
        delta.updatedSlots.length === 0 &&
        delta.recreatedSlots.length === 0 &&
        delta.removedSlots.length === 0 &&
        delta.resynced === 0 &&
        contentUpdatedSlots.length === 0 &&
        (delta.materialUpdates?.length ?? 0) === 0 &&
        instanceUpdatedSlots.length === 0 &&
        !pendingWrites &&
        this.pendingMeshes.size === 0 &&
        this.pendingMaterialRoots.size === 0 &&
        this.identityUploaded
      ) {
        this.noChangeFrames += 1;
        return ok({ ranges: 0, bytes: 0, grew: false, cleared: 0 });
      }
      const writesByTable = this.writesByTable;
      if (!this.identityUploaded && !writesByTable.transform.includes(0)) {
        writesByTable.transform.push(0);
      }
      const contentUpdatedSlotIds = new Set(contentUpdatedSlots.map((record) => record.slot));
      const instanceUpdatedSlotIds = new Set(instanceUpdatedSlots.map((record) => record.slot));
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
        contentUpdatedSlots,
        instanceUpdatedSlots,
        delta.recreatedSlots,
      ]) {
        for (const record of records) {
          const previous = this.allocations.get(record.slot);
          this.ensureAllocation(record, writesByTable);
          if (previous !== this.allocations.get(record.slot)) allocationResets.add(record.slot);
        }
      }
      for (const resource of delta.materialUpdates ?? []) {
        const range = this.sharedMaterials.get(resource);
        if (range !== undefined) this.adoptMaterial(range, writesByTable);
      }
      const requiredCapacity = Math.max(
        this.records.requiredCapacity(),
        this.instances.requiredCapacity(),
        this.transforms.requiredCapacity(),
      );
      const requiredMaterialCapacity = this.materials.requiredCapacity();
      const grew =
        requiredCapacity > this.capacity || requiredMaterialCapacity > this.materialCapacity;
      if (grew) {
        const grown = this.grow(requiredCapacity, requiredMaterialCapacity);
        if (!grown.ok) return grown;
      }

      for (const range of this.pendingMeshes) {
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
        this.inputs.writeDescriptor(
          range.descriptor,
          this.rowScratchView,
          GPU_MESH_DESCRIPTOR.words,
        );
      }

      // A shared material has one packed value per publication, independent of
      // how many primitives reference it. Do not retain mutable caller snapshots.
      const materialRows = new Map<MaterialSnapshot, Uint8Array>();
      for (const allocation of this.pendingMaterialRoots)
        this.writeMaterial(allocation.version, writesByTable, materialRows, false);
      for (const resource of delta.materialUpdates ?? []) {
        const range = this.sharedMaterials.get(resource);
        if (range !== undefined)
          this.writeMaterial(range.version, writesByTable, materialRows, false);
      }
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
        this.writeTemporalFlags(
          record.slot,
          primitiveTemporalFlags(false, temporal),
          writesByTable,
        );
      }
      const uploaded = this.uploadRows(writesByTable);
      if (!uploaded.ok) return uploaded;
      this.pendingTemporalUploads.clear();
      for (const version of this.pendingMaterials) version.initialized = true;
      this.pendingMaterials.clear();
      this.pendingMaterialRoots.clear();
      this.pendingMeshes.clear();
      for (const name of TABLE_NAMES) writesByTable[name].length = 0;
      this.identityUploaded = true;
      this.clearedSlots += delta.removedSlots.length;
      if (delta.resynced > 0) this.fullRebuilds += 1;
      this.sceneContentRevision += 1;
      this.changeLog.record(this.sceneContentRevision, delta, boundsOf, rowBoxesOf);
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

  /** Publish current transforms as previous only after a successful submit. */
  commitTemporalFrame(enabled = true): Result<void, RhiError> {
    if (this.failure !== undefined) return err(this.failure);
    this.clearTemporalFlags();
    if (!enabled) {
      this.pendingTemporalTransforms.clear();
      this.pendingTemporalUploads.clear();
      return ok(undefined);
    }
    if (this.pendingTemporalTransforms.size === 0) return ok(undefined);
    const currentOffset = offset(TRANSFORM, 'currentWorld');
    const previousOffset = offset(TRANSFORM, 'previousWorld');
    const ranges = this.dirtyRanges.coalesce([...this.pendingTemporalTransforms]);
    for (const range of ranges) {
      for (let index = range.start; index < range.end; index += 1) {
        this.pendingTemporalUploads.add(index);
        this.transformBytes.copyWithin(
          index * TRANSFORM.stride + previousOffset,
          index * TRANSFORM.stride + currentOffset,
          index * TRANSFORM.stride + currentOffset + 64,
        );
      }
    }
    for (const range of ranges) {
      const firstOffset = range.start * TRANSFORM.stride;
      const lastOffset = range.end * TRANSFORM.stride;
      const uploaded = this.device.queue.writeBuffer(
        this.buffers.transform,
        firstOffset,
        this.transformBytes.subarray(firstOffset, lastOffset),
      );
      if (!uploaded.ok) return uploaded;
    }
    this.pendingTemporalTransforms.clear();
    this.pendingTemporalUploads.clear();
    const bytes = ranges.reduce(
      (total, range) => total + (range.end - range.start) * TRANSFORM.stride,
      0,
    );
    this.uploadRanges += ranges.length;
    this.uploadBytes += bytes;
    return ok(undefined);
  }

  private writeTemporalFlags(
    slot: number,
    temporalFlags: number,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const primitive = new DataView(this.tableBytes.primitive);
    const recordIndex = this.allocations.get(slot)?.recordIndex;
    if (recordIndex === undefined) return;
    const at = recordIndex * PRIMITIVE.stride + offset(PRIMITIVE, 'flags');
    const current = primitive.getUint32(at, true);
    const next =
      (current & ~(GPU_SCENE_PRIMITIVE_REACTIVE | GPU_SCENE_PRIMITIVE_MOTION_INVALID)) |
      temporalFlags;
    if (temporalFlags !== 0) this.temporalFlagSlots.add(slot);
    if (next === current) return;
    primitive.setUint32(at, next, true);
    writes.primitive.push(recordIndex);
  }

  /** CPU bytes change now; the upload rides the next `sync`. */
  private clearTemporalFlags(): void {
    if (this.temporalFlagSlots.size === 0) return;
    const primitive = new DataView(this.tableBytes.primitive);
    const flagsOffset = offset(PRIMITIVE, 'flags');
    const temporalFlags = GPU_SCENE_PRIMITIVE_REACTIVE | GPU_SCENE_PRIMITIVE_MOTION_INVALID;
    for (const slot of this.temporalFlagSlots) {
      const recordIndex = this.allocations.get(slot)?.recordIndex;
      if (recordIndex === undefined) continue;
      const at = recordIndex * PRIMITIVE.stride + flagsOffset;
      const current = primitive.getUint32(at, true);
      if ((current & temporalFlags) === 0) continue;
      primitive.setUint32(at, current & ~temporalFlags, true);
      this.writesByTable.primitive.push(recordIndex);
    }
    this.temporalFlagSlots.clear();
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
          capacity: this.capacity,
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
    this.inputs.dispose();
    this.sharedMeshes.clear();
    this.pendingMeshes.clear();
    this.meshes = new MeshFrame();
    this.materialFrame = undefined;
    this.sharedMaterials.clear();
    this.pendingMaterials.clear();
    this.pendingMaterialRoots.clear();
    this.records.reset();
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of this.retiredBuffers) this.device.destroyBuffer(buffer);
    this.retiredBuffers.clear();
    this.bufferHolders.clear();
    for (const buffer of Object.values(this.buffers)) this.device.destroyBuffer(buffer);
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
    if (temporalFlags !== 0) this.temporalFlagSlots.add(record.slot);
    primitive.setUint32(
      offset(PRIMITIVE, 'flags'),
      PRIMITIVE_ACTIVE |
        (bounds === undefined ? 0 : PRIMITIVE_HAS_BOUNDS) |
        (allocation.mesh === undefined ? 0 : PRIMITIVE_SHARED_GEOMETRY) |
        (record.snapshot.gpuDrivenDraws === undefined ? 0 : PRIMITIVE_GPU_DRIVEN) |
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
    const transform = this.transformView;
    const instances = record.snapshot.instances;
    const previousInstances = temporal?.previousInstances;
    const previousOrdinals = previousInstanceOrdinals(instances, temporal);
    const currentGenerations = instances?.generations;
    const residentGenerations = this.instanceGenerations.get(record.slot);
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
        writeChangedU32(
          instance,
          instanceOffset + offset(INSTANCE, 'customDataStart'),
          record.snapshot.skin?.customDataStart ?? 0,
        ) || metadataChanged;
      metadataChanged =
        writeChangedU32(instance, instanceOffset + offset(INSTANCE, 'flags'), PRIMITIVE_ACTIVE) ||
        metadataChanged;
      if (allocation.instanceTransformCount > 0) {
        const transforms = instances?.transforms;
        const hasLocal = transforms !== undefined && transforms.length >= (ordinal + 1) * 16;
        const local = hasLocal ? transforms : IDENTITY_MATRIX;
        const sourceOffset = hasLocal ? ordinal * 16 : 0;
        const localOffset = transformIndex * TRANSFORM.stride;
        const changed = writeChangedMat4(
          transform,
          localOffset + offset(TRANSFORM, 'currentWorld'),
          local,
          sourceOffset,
        );
        const identityChanged = instanceIdentityChanged(
          residentGenerations,
          currentGenerations,
          ordinal,
        );
        if (resetPrevious) {
          const previousOrdinal = previousOrdinals?.(ordinal);
          const previousSource =
            previousOrdinal === undefined || previousInstances === undefined
              ? undefined
              : previousInstances.transforms;
          if (previousSource === undefined || previousOrdinal === undefined) {
            writeChangedMat4(
              transform,
              localOffset + offset(TRANSFORM, 'previousWorld'),
              local,
              sourceOffset,
            );
          } else {
            writeChangedMat4(
              transform,
              localOffset + offset(TRANSFORM, 'previousWorld'),
              previousSource,
              previousOrdinal * 16,
            );
            this.pendingTemporalTransforms.add(transformIndex);
          }
        } else if (changed || identityChanged) {
          const previousOrdinal = previousOrdinals?.(ordinal);
          const previousSource =
            previousOrdinal === undefined || previousInstances === undefined
              ? undefined
              : previousInstances.transforms;
          if (previousSource === undefined || previousOrdinal === undefined) {
            // A changed row without an identity proof must not borrow the
            // compacted row's old velocity. Seed only this row and keep other
            // stable instances eligible for motion.
            writeChangedMat4(
              transform,
              localOffset + offset(TRANSFORM, 'previousWorld'),
              local,
              sourceOffset,
            );
          } else {
            writeChangedMat4(
              transform,
              localOffset + offset(TRANSFORM, 'previousWorld'),
              previousSource,
              previousOrdinal * 16,
            );
          }
          this.pendingTemporalTransforms.add(transformIndex);
        }
        if (changed || identityChanged || resetPrevious) writes.transform.push(transformIndex);
      }
      if (metadataChanged || resetPrevious) writes.instance.push(instanceIndex);
    }

    this.rememberInstanceGenerations(record.slot, currentGenerations, allocation.instanceCount);
    this.rememberInstanceResident(record);

    this.writeRootTransform(record, resetPrevious, writes);

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
    this.inputs.writeDescriptor(
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
        const transformIndex = allocation.instanceTransformStart + ordinal;
        const transformOffset = transformIndex * TRANSFORM.stride;
        const changed = writeChangedMat4(
          this.transformView,
          transformOffset + offset(TRANSFORM, 'currentWorld'),
          instances.transforms,
          ordinal * 16,
        );
        const identityChanged = instanceIdentityChanged(
          residentGenerations,
          currentGenerations,
          ordinal,
        );
        if (changed || identityChanged) {
          const previousOrdinal = previousOrdinals?.(ordinal);
          const previousSource =
            previousOrdinal === undefined || previousInstances === undefined
              ? undefined
              : previousInstances.transforms;
          if (previousSource === undefined || previousOrdinal === undefined) {
            writeChangedMat4(
              this.transformView,
              transformOffset + offset(TRANSFORM, 'previousWorld'),
              instances.transforms,
              ordinal * 16,
            );
          } else {
            writeChangedMat4(
              this.transformView,
              transformOffset + offset(TRANSFORM, 'previousWorld'),
              previousSource,
              previousOrdinal * 16,
            );
          }
          this.pendingTemporalTransforms.add(transformIndex);
          writes.transform.push(transformIndex);
        }
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

  private writeRootTransform(
    record: RenderSceneSlot,
    resetPrevious: boolean,
    writes: Record<GpuSceneTableName, number[]>,
  ): void {
    const allocation = this.allocations.get(record.slot);
    if (allocation === undefined) throw new RangeError('GPU Scene allocation unavailable');
    const transformOffset = allocation.transformStart * TRANSFORM.stride;
    const previousOffset = transformOffset + offset(TRANSFORM, 'previousWorld');
    if (resetPrevious) {
      writeMat4(this.transformView, previousOffset, record.snapshot.transform.world);
    }
    const changed = writeChangedMat4(
      this.transformView,
      transformOffset + offset(TRANSFORM, 'currentWorld'),
      record.snapshot.transform.world,
    );
    if (changed && !resetPrevious) this.pendingTemporalTransforms.add(allocation.transformStart);
    if (changed || resetPrevious) writes.transform.push(allocation.transformStart);
  }

  private clearSlot(slot: number, writes: Record<GpuSceneTableName, number[]>): void {
    const allocation = this.allocations.get(slot);
    if (allocation === undefined) return;
    this.instanceGenerations.delete(slot);
    this.instanceResidents.delete(slot);
    this.clearAllocation(allocation, writes);
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
      record.snapshot.skinPose !== undefined ||
      record.snapshot.skin !== undefined ||
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
    if (existing !== undefined) this.clearAllocationRanges(existing, writes);
    const materialRanges = materialUnits.map(
      (count, index) =>
        retainedMaterials[index] ??
        this.acquireMaterial(
          record.snapshot.materials[index] ?? record.snapshot.material,
          count,
          writes,
        ),
    );
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

  private acquireMesh(geometry: MeshGeometry): MeshAllocation {
    const key = `${geometry.worldId}:${geometry.handle}`;
    const existing = this.sharedMeshes.get(key);
    if (existing !== undefined) {
      existing.holders++;
      return existing;
    }
    const descriptor = this.inputs.allocateDescriptor(GPU_MESH_DESCRIPTOR.words);
    let logicalSlot: number;
    try {
      logicalSlot = this.inputs.allocateResource(descriptor);
    } catch (cause) {
      try {
        this.inputs.releaseDescriptor(descriptor, GPU_MESH_DESCRIPTOR.words);
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
      version: { descriptor, geometry, references: 1 },
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
    if (--version.references !== 0 || this.disposed) return;
    this.pendingMeshes.delete(version);
    this.inputs.releaseDescriptor(version.descriptor, GPU_MESH_DESCRIPTOR.words);
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
        descriptor: this.inputs.allocateDescriptor(GPU_MATERIAL_DESCRIPTOR.words),
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
    if (--version.references !== 0 || this.disposed) return;
    this.pendingMaterials.delete(version);
    this.inputs.releaseDescriptor(version.descriptor, GPU_MATERIAL_DESCRIPTOR.words);
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
    if (this.disposed) return;
    this.retiredBuffers.add(buffer);
    if (this.bufferHolders.has(buffer)) return;
    const release = () => {
      if (!this.retiredBuffers.delete(buffer)) return;
      this.device.destroyBuffer(buffer);
    };
    void this.device.queue.onSubmittedWorkDone().then(release, release);
  }

  private grow(requiredCapacity: number, requiredMaterialCapacity: number): Result<void, RhiError> {
    let nextCapacity = this.capacity;
    while (nextCapacity < requiredCapacity) nextCapacity *= 2;
    let nextMaterialCapacity = this.materialCapacity;
    while (nextMaterialCapacity < requiredMaterialCapacity) nextMaterialCapacity *= 2;
    const nextBuffers = { ...this.buffers };
    const nextTables = { ...this.tableBytes };
    const replacements: GpuSceneTableName[] = [];
    let uploadedBytes = 0;
    for (const name of TABLE_NAMES) {
      const oldCapacity = name === 'material' ? this.materialCapacity : this.capacity;
      const newCapacity = name === 'material' ? nextMaterialCapacity : nextCapacity;
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
    this.capacity = nextCapacity;
    this.materialCapacity = nextMaterialCapacity;
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
    writeMat4(this.transformView, offset(TRANSFORM, 'currentWorld'), IDENTITY_MATRIX);
    writeMat4(this.transformView, offset(TRANSFORM, 'previousWorld'), IDENTITY_MATRIX);
  }
}
