import type { Buffer, Result, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { createStandardPbrArtifactReceipt, type ShaderRegistry } from '@forgeax/engine-shader';
import { derive, type ParamSchemaEntry } from '@forgeax/engine-types';
import { dynamicCapacity, shouldShrinkCapacity } from './dynamic-capacity';
import { FrameKeyRoster } from './frame-key-roster';
import type { GpuInputArena } from './gpu-input-arena';
import {
  type PrimitiveAllocationResidency,
  PrimitiveAllocations,
  type PrimitiveAllocation as SlotAllocation,
  SlotWrite,
} from './gpu-scene-allocations';
import { type CapacityTableDemand, GpuSceneCapacityPreparation } from './gpu-scene-capacity';
import {
  type GpuSceneChangedBounds,
  GpuSceneContentBoxes,
  type GpuSceneSlotBounds,
  type SceneContentCursor,
} from './gpu-scene-content-boxes';
import {
  GPU_MATERIAL_DESCRIPTOR,
  GPU_MESH_DESCRIPTOR,
  type GpuInputReadFrame,
  type GpuSceneInputPreparation,
  GpuSceneInputs,
} from './gpu-scene-inputs';
import {
  GpuScenePreviousRows,
  type GpuSceneTemporalSnapshot,
  instanceIdentityChanged,
  previousInstanceOrdinals,
  primitiveTemporalFlags,
} from './gpu-scene-previous-rows';
import { GpuResourcePinWorkspace } from './gpu-scene-resource-roster';
import {
  clearRows,
  encodeMaterialSceneDescriptor,
  encodeMeshSceneDescriptor,
  encodeResetSceneTransform,
  encodeSceneInstance,
  encodeScenePrimitive,
  GPU_SCENE_PRIMITIVE_FLAGS,
  writeChangedMat4,
  writeMat4,
} from './gpu-scene-row-encoding';
import {
  GPU_SCENE_LAYOUTS,
  type GpuSceneTableLayout,
  gpuSceneFieldOffset,
} from './gpu-scene-schema';
import {
  releaseSourceParts,
  resourceHoldInvalid,
  sourceResource,
} from './gpu-scene-source-custody';
import {
  type GpuSceneSourceMaterial,
  type GpuSceneSourceMesh,
  type GpuSceneSourceMeshInput,
  type GpuSceneSourceRow,
  GpuSceneSourceRows,
  SOURCE_ROWS_PER_RETIREMENT_STEP,
} from './gpu-scene-source-rows';
import {
  createTables,
  type GpuSceneTableName,
  type GpuSceneTables,
  type GpuSceneTableTextures,
  growGpuSceneTableCapacity,
  MATERIAL,
  TABLE_LAYOUTS,
  TABLE_NAMES,
  tableBuffer,
  textureTableViews,
} from './gpu-scene-table-set';
import {
  createGpuSceneTable,
  destroyGpuSceneTable,
  type GpuSceneTableBackend,
  type GpuSceneTableStorage,
  gpuSceneTableByteLimit,
  writeGpuSceneTable,
} from './gpu-scene-tables';
import { GpuTableWrites } from './gpu-table-writes';
import type { GpuSceneInspection } from './inspection-types';
import { previousInstanceOrdinal } from './instance-generations';

import { MaterialResource } from './material-resource';
import { packMaterialProgramRow, packStandardPbrMaterialRow } from './material-row';
import { isCanonicalStandardPbrMaterialShader } from './pbr-pipeline';
import { getOpaqueResourceIdentity } from './record/frame-snapshot';
import type { MaterialSnapshot, RenderableSnapshot } from './render-system-extract';
import { type AcceptedMaterial, MaterialFrame } from './scene/material-dispatch';
import { slotContent, slotPoseColumn, slotPoseOffset } from './scene/mesh-draw';
import { MeshFrame, type MeshGeometry, type MeshMorphDeltas } from './scene/mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from './scene/mesh-materials';
import type {
  RenderSceneApplyResult,
  RenderSceneSlot,
  ReservedSceneRow,
} from './scene/render-scene-types';
import { RowChangeLog } from './scene/row-change-log';
import { sceneRowPublicationMatches } from './scene/scene-rows';
import { PublishedPoseRows } from './scene/scene-slots';
import { StableRangeAllocator } from './stable-range-allocator';

export type { GpuSceneInspection } from './inspection-types';

type GpuSceneTemporalResolver = {
  (slot: RenderSceneSlot): GpuSceneTemporalSnapshot | undefined;
  readonly bySlot?: (slot: number) => GpuSceneTemporalSnapshot | undefined;
};

const PRIMITIVE = GPU_SCENE_LAYOUTS.primitive;
const INSTANCE = GPU_SCENE_LAYOUTS.instance;
const TRANSFORM = GPU_SCENE_LAYOUTS.transform;
const STANDARD_PBR_RECEIPT = createStandardPbrArtifactReceipt();
const PRIMITIVE_ACTIVE = GPU_SCENE_PRIMITIVE_FLAGS.active;
/** Static author request; readiness stays in the fixed Skin source root. */
export const GPU_SCENE_PRIMITIVE_CAPSULE_SHADOW = GPU_SCENE_PRIMITIVE_FLAGS.capsuleShadow;
/** Color history must not be trusted for this primitive in the current frame. */
export const GPU_SCENE_PRIMITIVE_REACTIVE = GPU_SCENE_PRIMITIVE_FLAGS.reactive;
/** Previous transforms were seeded from current; no motion vector this frame. */
export const GPU_SCENE_PRIMITIVE_MOTION_INVALID = GPU_SCENE_PRIMITIVE_FLAGS.motionInvalid;
/** `ShadowParticipation.receive` is false: the surface skips shadow sampling. */
export const GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE = GPU_SCENE_PRIMITIVE_FLAGS.noShadowReceive;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** One exact Scene-issued native target; it does not authorize execution or Source Rows. */
export interface GpuSceneTableBindingTarget {
  readonly owner: GpuScene;
  readonly preparation: GpuSceneCapacityPreparation;
  readonly identity: object;
  readonly primitiveBuffer: Buffer;
  readonly instanceBuffer: Buffer;
  readonly transformBuffer: Buffer;
  readonly materialBuffer: Buffer;
  readonly rowCapacity: number;
  readonly transformBytes: number;
  readonly materialBytes: number;
}
interface CapacityScope {
  limits: Record<GpuSceneTableName, number>;
  readonly current: () => boolean;
  parent: GpuSceneTables | undefined;
  target?: GpuSceneTableBindingTarget;
  tables?: GpuSceneTables;
  bytes?: Readonly<Record<GpuSceneTableName, Uint8Array<ArrayBuffer>>>;
  published: boolean;
  readonly sourceRows?: GpuSceneSourceRows;
  sourceEncoded?: true;
  sourceInput?: GpuSceneInputPreparation;
  sourceData?: {
    readonly residency: PrimitiveAllocationResidency;
    readonly rows: {
      readonly source: GpuSceneSourceRow;
      readonly allocation: PrimitiveAllocation;
      stamp: number;
    }[];
  };
  publicationFailure?: { readonly cause: unknown };
  detachmentPending?: boolean;
  detachmentCursor?: number;
  /** Exact range already cleared on CPU whose native uploads still require confirmation. */
  detachmentBatchEnd?: number;
}

interface TableGeneration {
  readonly tables: GpuSceneTables;
  readers: number;
}

interface MaterialVersion {
  readonly descriptor: number;
  start: number;
  count: number;
  readonly snapshot: MaterialSnapshot;
  references: number;
  initialized: boolean;
  /** Schema actually used by the last payload pack; identity is producer-owned. */
  schema: readonly ParamSchemaEntry[] | undefined;
}

export interface MaterialAllocation {
  readonly logicalSlot: number;
  readonly resource: MaterialResource;
  holders: number;
  version: MaterialVersion;
}

const NO_INSTANCE_UPLOAD = Object.freeze({ ranges: Object.freeze([]), bytes: 0 });

const NO_MATERIAL_RANGES: readonly MaterialAllocation[] = Object.freeze([]);

/** A preparation owns the resolved row versions and their physical table generations. */
export interface GpuSceneResourceFrame {
  indexForResource(resource: MaterialResource, snapshot?: MaterialSnapshot): number | undefined;
  logicalForResource(resource: MaterialResource, snapshot?: MaterialSnapshot): number | undefined;
  logicalForGeometry(handle: number, geometry?: MeshGeometry): number | undefined;
  indexForGeometry(handle: number, geometry?: MeshGeometry): number | undefined;
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
  /** Direct draws can reuse row addresses after queue submission. Physical tables survive completion. */
  submit(completed?: Promise<void>, rowLifetime?: 'completion' | 'queue-order'): void;
}

/** Real Scene version references, with the sealed read domain already closed. */
export interface GpuSceneResourceHold {
  release(): void;
}

/** Current logical material roots plus fixed version custody; no execution permission. */
export interface GpuSceneMaterialRootHold extends GpuSceneResourceHold {
  isCurrent(): boolean;
}

declare const sceneResourcePinsBrand: unique symbol;

/** Opaque version roster captured from one resource frame. */
export interface GpuSceneResourcePins {
  readonly [sceneResourcePinsBrand]: void;
}

type MaterialPins = FrameKeyRoster<MaterialResource, MaterialVersion>;
type MeshPins = FrameKeyRoster<number, MeshVersion>;
const meshPinAddress = (handle: number): number => handle;

/** Published rosters are shared until a recording resolves another resource. */
class ResourcePins implements GpuSceneResourcePins {
  declare readonly [sceneResourcePinsBrand]: void;
  constructor(
    readonly scene: GpuScene,
    readonly materials: MaterialPins,
    readonly meshes: MeshPins,
  ) {}
}
const EMPTY_MATERIAL_PINS = new FrameKeyRoster<MaterialResource, MaterialVersion>(
  MaterialResource._frameAddress,
);
const EMPTY_MESH_PINS = new FrameKeyRoster<number, MeshVersion>(meshPinAddress);

interface MeshVersion {
  readonly descriptor: number;
  readonly words: number;
  readonly geometry: MeshGeometry;
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
  readonly handle: number;
  deltas: MeshMorphDeltas;
}

const MORPH_ROW_HEADER_WORDS = 4;

export interface MeshAllocation {
  readonly logicalSlot: number;
  readonly key: number;
  version: MeshVersion;
  holders: number;
}

type PrimitiveAllocation = SlotAllocation<MeshAllocation, readonly MaterialAllocation[]>;
const EMPTY_CPU_BYTES = new Uint8Array(0);
const EMPTY_CPU_VIEW = new DataView(EMPTY_CPU_BYTES.buffer);
const EMPTY_CPU_TABLES = Object.freeze({
  primitive: EMPTY_CPU_BYTES,
  instance: EMPTY_CPU_BYTES,
  transform: EMPTY_CPU_BYTES,
  material: EMPTY_CPU_BYTES,
});
/** Primitive and instance tables share one row capacity; transform rows also hold previous poses. */
const GPU_SCENE_ROW_TABLE_STRIDE = Math.max(PRIMITIVE.stride, INSTANCE.stride);
const TRANSFORM_CURRENT = gpuSceneFieldOffset(TRANSFORM, 'currentWorld');
const TRANSFORM_PREVIOUS = gpuSceneFieldOffset(TRANSFORM, 'previousIndex');
const TRANSFORM_STAMP = gpuSceneFieldOffset(TRANSFORM, 'stamp');
// Material storage grows from distinct accepted ABIs, independently of entity reservations.
const INITIAL_MATERIAL_CAPACITY = 1;

interface GpuSceneSyncResult {
  readonly ranges: number;
  readonly bytes: number;
  readonly grew: boolean;
  readonly cleared: number;
}

type GpuSceneAvailability = { readonly status: 'available'; readonly scene: GpuScene };

type GpuSceneWrites = Readonly<Record<GpuSceneTableName, GpuTableWrites>>;

interface TableReduction {
  readonly baseline: GpuSceneTables;
  readonly rows: number;
  readonly transforms: number;
  readonly materials: number;
  readonly task: GpuSceneCapacityPreparation;
}

function offset(layout: GpuSceneTableLayout, field: string): number {
  return gpuSceneFieldOffset(layout, field);
}

/** Identity and revision mirrored by one live instance allocation. */
interface InstanceResident {
  collectionId: number | undefined;
  revision: number | undefined;
  generations: Uint32Array | undefined;
  observedSync: number;
}

/** Persistent GPU tables derived only from renderer projection slots. */
export class GpuScene {
  readonly inputs: GpuSceneInputs;
  private meshes = new MeshFrame();
  private materialFrame: MaterialFrame | undefined;
  private readonly inputTableRoots = new WeakMap<
    GpuInputReadFrame,
    TableGeneration | Map<object, TableGeneration>
  >();
  private readonly capacityPreparations = new Map<GpuSceneCapacityPreparation, CapacityScope>();
  private readonly sharedMeshes = new Map<number, MeshAllocation>();
  private readonly morphDeltas = new Map<MeshMorphDeltas, MorphDeltaAllocation>();
  private readonly morphRows = new Map<number, MorphRowAllocation>();
  private morphScratch = new DataView(new ArrayBuffer(64));
  private readonly pendingMeshes = new Set<MeshVersion>();

  private readonly rowScratch = new Uint8Array(PRIMITIVE.stride);
  private readonly rowScratchView = new DataView(this.rowScratch.buffer);
  private disposed = false;
  /** The CPU table reader closes independently of submitted GPU resource frames. */
  private cpuBusy = false;
  private failure: RhiError | undefined;
  private tableBytes: Readonly<Record<GpuSceneTableName, Uint8Array<ArrayBuffer>>>;
  private primitiveView: DataView;
  private instanceView: DataView;
  private transformBytes: Uint8Array<ArrayBuffer>;
  private transformView: DataView;
  private tableGeneration: TableGeneration;
  private textureViews: GpuSceneTableTextures | undefined;
  private readonly retiredTables = new Set<GpuSceneTableStorage>();
  private readonly retiredTableStates = new WeakMap<
    GpuSceneTableStorage,
    'waiting' | 'fencing' | 'destroying' | 'released' | 'failed'
  >();
  private tableRetirementFailure: AggregateError | undefined;
  /** Physical storage referenced by replaced generations that still have readers. */
  private readonly oldTableOwners = new WeakMap<GpuSceneTableStorage, number>();
  private resourceFrames = 0;
  private readonly materialPinWorkspace = new GpuResourcePinWorkspace<
    MaterialResource,
    MaterialVersion
  >(MaterialResource._frameAddress);
  private readonly meshPinWorkspace = new GpuResourcePinWorkspace<number, MeshVersion>(
    meshPinAddress,
  );
  private readonly resourceFrameTransfers = new WeakMap<
    GpuSceneResourceFrame,
    {
      versions(): Result<GpuSceneResourceHold, RhiError>;
      materialRoots(): Result<GpuSceneMaterialRootHold, RhiError>;
    }
  >();
  /** Failed retirement remains this Scene's responsibility until receiver recovery. */
  private readonly failedResourceFrames = new Map<
    GpuSceneResourceFrame,
    { readonly failure: AggregateError; readonly releaseInputs: () => void }
  >();
  private disposalFailure: AggregateError | undefined;
  /** Shared packing within one sync. Released on success, failure or device disposal. */
  private packedMaterialRows: Map<MaterialSnapshot, Uint8Array> | undefined;
  private readonly pendingMaterials = new Set<MaterialVersion>();
  private readonly pendingMaterialRoots = new Set<MaterialAllocation>();
  private uploadRanges = 0;
  private uploadBytes = 0;
  private capacityGrows = 0;
  private materialCapacity: number;
  private fullRebuilds = 0;
  private clearedSlots = 0;
  private noChangeFrames = 0;
  /**
   * The row journal this scene's content entries join: the synced rows' own
   * {@link RowChangeLog} once a delta names it.
   */
  private journal = new RowChangeLog();
  /** Content identity consumed by shadow-cache invalidation; replaced by every completed sync. */
  private syncRevisionValue = 0;
  private contentAt: SceneContentCursor = { journal: this.journal, position: 0 };
  private readonly contentBoxes = new GpuSceneContentBoxes();
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
  private readonly instanceResidents = new Map<number, InstanceResident>();
  /** Instance transform rows visited by instance-only updates (O(dirty) evidence). */
  private instanceRowsVisited = 0;
  /** Physical instance transform addresses written since the last accepted sync. */
  private readonly instanceUploads = new GpuTableWrites();
  private instanceUploadsReadable = false;
  private readonly records = new StableRangeAllocator();
  private readonly instances = new StableRangeAllocator();
  private readonly transforms = new StableRangeAllocator();
  private readonly materials = new StableRangeAllocator();
  private readonly sharedMaterials = new Map<MaterialResource, MaterialAllocation>();
  private tableRowsReleased = false;
  private retiredTransformRows = 0;
  private reviewCapacity = false;
  private smallSubmissions = 0;
  private reductions = 0;
  private reductionFailures = 0;
  private reduction: TableReduction | undefined;
  private readonly writesByTable: GpuSceneWrites = {
    primitive: new GpuTableWrites(),
    instance: new GpuTableWrites(),
    transform: new GpuTableWrites(),
    material: new GpuTableWrites(),
  };
  /**
   * Stamp of the frame being prepared; row 0 carries it to the GPU. It
   * advances only when a frame is submitted, so writes of skipped or failed
   * frames fold into the next attempt of the same frame.
   */
  private frameStamp = 1;
  /** Scene-owned previous-pose scratch rows, reused after each submitted stamp. */
  private readonly previousRows = new GpuScenePreviousRows(this.transforms);
  private transformCapacity: number;

  private constructor(
    private readonly device: RhiDevice,
    private capacity: number,
    readonly backend: GpuSceneTableBackend,
    tables: GpuSceneTables,
    private readonly shaderRegistry?: ShaderRegistry,
    arena?: GpuInputArena,
  ) {
    this.inputs = new GpuSceneInputs(device, (slot) => this.primitiveIndexForSlot(slot), arena);
    this.tableGeneration = { tables, readers: 0 };
    this.textureViews = textureTableViews(tables);
    this.materialCapacity = INITIAL_MATERIAL_CAPACITY;
    this.transformCapacity = capacity;
    this.tableBytes = this.allocateCpuTables(capacity, this.materialCapacity);
    this.transformBytes = this.tableBytes.transform;
    this.transformView = new DataView(this.transformBytes.buffer);
    this.primitiveView = new DataView(this.tableBytes.primitive.buffer);
    this.instanceView = new DataView(this.tableBytes.instance.buffer);
    this.transforms.reset(1);
    this.writeIdentityTransform();
  }

  static create(
    device: RhiDevice,
    initialCapacity = 256,
    shaderRegistry?: ShaderRegistry,
    arena?: GpuInputArena,
  ): Result<GpuSceneAvailability, RhiError> {
    const backend = device.caps.storageBuffer ? 'buffer' : 'texture';
    const requestedCapacity = Number.isFinite(initialCapacity)
      ? Math.max(1, Math.ceil(initialCapacity))
      : 256;
    const capacity = 2 ** Math.ceil(Math.log2(requestedCapacity));
    const tables = createTables(device, backend, capacity, INITIAL_MATERIAL_CAPACITY);
    if (!tables.ok) return err(tables.error);
    return ok({
      status: 'available',
      scene: new GpuScene(device, capacity, backend, tables.value, shaderRegistry, arena),
    });
  }

  get primitiveBuffer(): Buffer {
    return tableBuffer(this.tables.primitive);
  }

  /** Current owner lifetime only; it does not qualify resource readiness. */
  get live(): boolean {
    return !this.disposed && this.failure === undefined && this.inputs.isLiveOn(this.device);
  }

  get instanceBuffer(): Buffer {
    return tableBuffer(this.tables.instance);
  }

  get transformBuffer(): Buffer {
    return tableBuffer(this.tables.transform);
  }

  get materialBuffer(): Buffer {
    return tableBuffer(this.tables.material);
  }

  /** Row tables of a texture-backed scene; undefined for storage-buffer tables. */
  get tableTextures(): GpuSceneTableTextures | undefined {
    return this.textureViews;
  }

  /** Advances on every completed sync, including resource-only publications. */
  get syncRevision(): number {
    return this.syncRevisionValue;
  }

  /** Spatial row journal position, shared until the journal or its position advances. */
  get contentCursor(): SceneContentCursor {
    return this.contentAt;
  }

  /** World boxes changed after `since`; see {@link GpuSceneContentBoxes}. */
  changedBoundsSince(
    since: SceneContentCursor,
    ignoredSlots?: ReadonlySet<number>,
    observedSlots?: { has(slot: number): boolean },
    maxBoxes?: number,
  ): GpuSceneChangedBounds {
    return this.contentBoxes.changedSince(
      since,
      this.contentAt,
      ignoredSlots,
      observedSlots,
      maxBoxes,
    );
  }

  /** Whether every box changed after `since` misses; see {@link GpuSceneContentBoxes.changedBoundsMiss}. */
  changedBoundsMiss(
    since: SceneContentCursor,
    misses: (boxes: Float32Array, offset: number) => boolean,
    ignoredSlots?: ReadonlySet<number>,
    observedSlots?: { has(slot: number): boolean },
  ): boolean {
    return this.contentBoxes.changedBoundsMiss(
      since,
      this.contentAt,
      misses,
      ignoredSlots,
      observedSlots,
    );
  }

  /** Slots created, changed or removed after `since`; `undefined` when unproven. */
  changedSlotsSince(since: SceneContentCursor): readonly number[] | undefined {
    return this.contentBoxes.changedSlotsSince(since, this.contentAt);
  }

  /** Whether {@link changedSlotsSince} would be non-empty or unproven. */
  hasChangedSlotsSince(since: SceneContentCursor): boolean {
    return this.contentBoxes.hasChangedSlotsSince(since, this.contentAt);
  }

  /** Every world box `slots` occupied after `since`; see {@link GpuSceneContentBoxes}. */
  slotBoundsSince(
    since: SceneContentCursor,
    slots: Iterable<number>,
    maxBoxes?: number,
  ): GpuSceneChangedBounds {
    return this.contentBoxes.slotBoundsSince(since, this.contentAt, slots, maxBoxes);
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

  /** A failed adoption acquires no references and leaves ordinary reads available. */
  private pinsMatchInputs(
    pins: ResourcePins,
    versions: MaterialPins,
    meshes: MeshPins,
    inputs: GpuInputReadFrame,
  ): boolean {
    for (let row = 0; row < pins.materials.size; row++) {
      const resource = pins.materials.keyAt(row);
      const version = pins.materials.versionAt(row);
      const held = versions.get(resource);
      if (held === version) continue;
      const allocation = this.sharedMaterials.get(resource);
      if (
        allocation === undefined ||
        allocation.version !== version ||
        !version.initialized ||
        held !== undefined ||
        inputs.resource(allocation.logicalSlot) !== version.descriptor
      )
        return false;
    }
    for (let row = 0; row < pins.meshes.size; row++) {
      const key = pins.meshes.keyAt(row);
      const version = pins.meshes.versionAt(row);
      const held = meshes.get(key);
      if (held === version) continue;
      const allocation = this.sharedMeshes.get(key);
      if (
        allocation === undefined ||
        allocation.version !== version ||
        held !== undefined ||
        inputs.resource(allocation.logicalSlot) !== version.descriptor
      )
        return false;
    }
    return true;
  }

  /** Transfer actual sealed references; this does not revalidate their source/currentness. */
  holdResources(frame: GpuSceneResourceFrame): Result<GpuSceneResourceHold, RhiError> {
    const transfer = this.resourceFrameTransfers.get(frame);
    if (transfer !== undefined) return transfer.versions();
    return err(resourceHoldInvalid());
  }

  /** Retain initialized allocations. Input-buffer upload and native bindings stay separate. */
  holdMaterialRoots(frame: GpuSceneResourceFrame): Result<GpuSceneMaterialRootHold, RhiError> {
    const transfer = this.resourceFrameTransfers.get(frame);
    return transfer === undefined ? err(resourceHoldInvalid()) : transfer.materialRoots();
  }

  private retainPinnedMaterialRoots(versions: MaterialPins): MaterialAllocation[] | undefined {
    const roots: MaterialAllocation[] = [];
    for (let row = 0; row < versions.size; row++) {
      const pin = versions.versionAt(row);
      const allocation = this.sharedMaterials.get(versions.keyAt(row));
      if (allocation === undefined || allocation.version !== pin || !allocation.version.initialized)
        return undefined;
      roots.push(allocation);
    }
    for (const allocation of roots) allocation.holders++;
    return roots;
  }

  private releasePinnedMaterialRoots(
    roots: MaterialAllocation[],
    record: (cause: unknown) => void,
  ): void {
    let remaining = 0;
    for (const allocation of roots) {
      try {
        // Scene disposal settles the one allocation owner before clearing its map.
        if (!this.disposed && this.sharedMaterials.get(allocation.resource) === allocation)
          this.releaseMaterial(allocation, this.writesByTable);
      } catch (cause) {
        roots[remaining++] = allocation;
        record(cause);
      }
    }
    roots.length = remaining;
  }

  private materialRootsCurrent(
    roots: readonly MaterialAllocation[],
    versions: MaterialPins,
  ): boolean {
    if (!this.live || this.cpuBusy) return false;
    const unchanged = this.inputs.captureGuard();
    for (const allocation of roots) {
      const resource = allocation.resource;
      const pin = versions.get(resource);
      if (
        pin === undefined ||
        !this.inputs.resourceIsCurrent(allocation.logicalSlot, pin.descriptor) ||
        this.sharedMaterials.get(resource) !== allocation ||
        allocation.version !== pin ||
        !allocation.version.initialized
      )
        return false;
    }
    return unchanged() && this.live && !this.cpuBusy;
  }

  private get tables(): GpuSceneTables {
    return this.tableGeneration.tables;
  }

  private publishTables(tables: GpuSceneTables): void {
    const previous = this.tableGeneration;
    if (previous.tables === tables) return;
    if (previous.readers !== 0) {
      for (const name of TABLE_NAMES) {
        const table = previous.tables[name];
        this.oldTableOwners.set(table, (this.oldTableOwners.get(table) ?? 0) + 1);
      }
    }
    this.tableGeneration = { tables, readers: 0 };
  }

  private releaseTableRoot(root: TableGeneration, record: (cause: unknown) => void): void {
    if (--root.readers !== 0) return;
    const replaced = root !== this.tableGeneration;
    if (!replaced && this.retiredTables.size === 0) return;
    for (const name of TABLE_NAMES) {
      const table = root.tables[name];
      try {
        if (replaced) {
          const owners = this.oldTableOwners.get(table) as number;
          if (owners === 1) this.oldTableOwners.delete(table);
          else this.oldTableOwners.set(table, owners - 1);
        }
        if (this.retiredTables.has(table)) this.retireTable(table);
      } catch (cause) {
        record(cause);
      }
    }
  }

  private tableIsHeld(table: GpuSceneTableStorage): boolean {
    if (this.oldTableOwners.has(table)) return true;
    const { readers, tables } = this.tableGeneration;
    return readers !== 0 && TABLE_NAMES.some((name) => tables[name] === table);
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
    const inputs = this.inputs.capture();
    let generation: TableGeneration | undefined;
    let generations: Map<object, TableGeneration> | undefined;
    const pinTables = () => {
      const next = this.tableGeneration;
      if (generation === next) return;
      if (generation === undefined) this.inputTableRoots.set(inputs, next);
      else {
        if (generations === undefined) {
          generations = new Map([[generation.tables, generation]]);
          this.inputTableRoots.set(inputs, generations);
        }
        const held = generations.get(next.tables);
        if (held !== undefined) {
          generation = held;
          return;
        }
        generations.set(next.tables, next);
      }
      generation = next;
      next.readers++;
    };
    let versions = EMPTY_MATERIAL_PINS;
    let meshes = EMPTY_MESH_PINS;
    let materialsShared = true;
    let meshesShared = true;
    const addMaterial = (resource: MaterialResource, pin: MaterialVersion) => {
      if (materialsShared) {
        versions = this.materialPinWorkspace.borrow(versions);
        materialsShared = false;
      }
      this.materialPinWorkspace.add(versions, resource, pin);
    };
    const addMesh = (key: number, pin: MeshVersion) => {
      if (meshesShared) {
        meshes = this.meshPinWorkspace.borrow(meshes);
        meshesShared = false;
      }
      this.meshPinWorkspace.add(meshes, key, pin);
    };
    let state:
      | 'prepared'
      | 'sealed'
      | 'transferring'
      | 'held'
      | 'submitted'
      | 'released'
      | 'failed' = 'prepared';
    let retirementFailure: AggregateError | undefined;
    let materialRoots: MaterialAllocation[] | undefined;
    let readsClosed = false;
    const closeReads = (record: (cause: unknown) => void) => {
      if (readsClosed) return;
      readsClosed = true;
      this.resourceFrames--;
      try {
        inputs.release();
      } catch (cause) {
        record(cause);
      }
      if (generations !== undefined) {
        for (const root of generations.values()) this.releaseTableRoot(root, record);
        generations = undefined;
      } else if (generation !== undefined) this.releaseTableRoot(generation, record);
      generation = undefined;
      this.inputTableRoots.delete(inputs);
    };
    const failRetirement = (failure: AggregateError): never => {
      state = 'failed';
      retirementFailure = failure;
      this.failedResourceFrames.set(frame, { failure, releaseInputs: () => inputs.release() });
      this.failure ??= Object.assign(
        new RhiError({
          code: 'internal-error',
          expected: 'confirmed retirement of every GPU resource-frame reference',
          hint: 'retire this receiver and rebuild from its accepted source baseline',
        }),
        { cause: failure },
      );
      throw failure;
    };
    const release = (initialFailure?: AggregateError, physicalCompletion?: Promise<void>) => {
      if (retirementFailure !== undefined) throw retirementFailure;
      if (state === 'released') return;
      state = 'released';
      this.resourceFrameTransfers.delete(frame);
      let failure = initialFailure;
      const record = (cause: unknown) => {
        if (failure === undefined)
          failure = new AggregateError([cause], 'GPU resource frame retirement failed', { cause });
        else failure.errors.push(cause);
      };
      if (physicalCompletion === undefined) closeReads(record);
      else {
        // Queue writes to reused rows follow the submitted commands. Destruction
        // and the captured input/table handles still belong to the physical fence.
        const finish = () => {
          closeReads(record);
          if (failure !== undefined && retirementFailure === undefined) failRetirement(failure);
        };
        void physicalCompletion.then(finish, finish);
      }
      if (materialRoots !== undefined) this.releasePinnedMaterialRoots(materialRoots, record);
      for (let row = 0; row < versions.size; row++)
        try {
          this.releaseMaterialVersion(versions.versionAt(row), this.writesByTable);
        } catch (cause) {
          record(cause);
        }
      for (let row = 0; row < meshes.size; row++)
        try {
          this.releaseMeshVersion(meshes.versionAt(row));
        } catch (cause) {
          record(cause);
        }
      if (failure !== undefined) failRetirement(failure);
      if (!materialsShared)
        this.materialPinWorkspace.release(versions, this.disposed ? 0 : this.sharedMaterials.size);
      if (!meshesShared)
        this.meshPinWorkspace.release(meshes, this.disposed ? 0 : this.sharedMeshes.size);
      versions = EMPTY_MATERIAL_PINS;
      meshes = EMPTY_MESH_PINS;
    };
    // A logical read proves the captured mapping; a physical read may still
    // use a pinned descriptor after the live owner has released its slot.
    const materialAddress = (
      resource: MaterialResource,
      snapshot: MaterialSnapshot | undefined,
      logical: boolean,
    ): number | undefined => {
      if (state !== 'prepared' || this.disposed || this.failure !== undefined) return undefined;
      const held = versions.get(resource);
      if (held !== undefined && !logical)
        return snapshot === undefined || held.snapshot === snapshot ? held.descriptor : undefined;
      const allocation = this.sharedMaterials.get(resource);
      if (allocation === undefined) return undefined;
      const version = held ?? allocation.version;
      if (
        (held === undefined && !version.initialized) ||
        (snapshot !== undefined && version.snapshot !== snapshot) ||
        inputs.resource(allocation.logicalSlot) !== version.descriptor
      )
        return undefined;
      if (held === undefined) {
        pinTables();
        version.references++;
        addMaterial(resource, version);
      }
      return logical ? allocation.logicalSlot : version.descriptor;
    };
    const meshAddress = (
      handle: number,
      geometry: MeshGeometry | undefined,
      logical: boolean,
    ): number | undefined => {
      if (state !== 'prepared' || this.disposed || this.failure !== undefined) return undefined;
      const held = meshes.get(handle);
      if (held !== undefined && !logical)
        return geometry === undefined || held.geometry === geometry ? held.descriptor : undefined;
      const allocation = this.sharedMeshes.get(handle);
      if (allocation === undefined) return undefined;
      const version = held ?? allocation.version;
      if (
        (geometry !== undefined && version.geometry !== geometry) ||
        inputs.resource(allocation.logicalSlot) !== version.descriptor
      )
        return undefined;
      if (held === undefined) {
        pinTables();
        version.references++;
        addMesh(handle, version);
      }
      return logical ? allocation.logicalSlot : version.descriptor;
    };
    const frame: GpuSceneResourceFrame = {
      indexForResource: (resource, snapshot) => materialAddress(resource, snapshot, false),
      logicalForResource: (resource, snapshot) => materialAddress(resource, snapshot, true),
      indexForGeometry: (handle, geometry) => meshAddress(handle, geometry, false),
      logicalForGeometry: (handle, geometry) => meshAddress(handle, geometry, true),
      pins: () => {
        materialsShared = true;
        meshesShared = true;
        return new ResourcePins(this, versions, meshes);
      },
      adoptPins: (pins) => {
        if (
          !(pins instanceof ResourcePins) ||
          pins.scene !== this ||
          state !== 'prepared' ||
          this.disposed ||
          this.failure !== undefined
        )
          return false;
        // Validate the whole roster before acquiring its version references.
        if (!this.pinsMatchInputs(pins, versions, meshes, inputs)) return false;
        if (versions.size === 0) {
          for (let row = 0; row < pins.materials.size; row++) {
            pinTables();
            pins.materials.versionAt(row).references++;
          }
          versions = pins.materials;
          materialsShared = true;
        } else
          for (let row = 0; row < pins.materials.size; row++) {
            const resource = pins.materials.keyAt(row);
            const pin = pins.materials.versionAt(row);
            if (versions.get(resource) === pin) continue;
            pinTables();
            pin.references++;
            addMaterial(resource, pin);
          }
        if (meshes.size === 0) {
          for (let row = 0; row < pins.meshes.size; row++) {
            pinTables();
            pins.meshes.versionAt(row).references++;
          }
          meshes = pins.meshes;
          meshesShared = true;
        } else
          for (let row = 0; row < pins.meshes.size; row++) {
            const key = pins.meshes.keyAt(row);
            const pin = pins.meshes.versionAt(row);
            if (meshes.get(key) === pin) continue;
            pinTables();
            pin.references++;
            addMesh(key, pin);
          }
        return true;
      },
      inputReads: () => {
        if (this.failure !== undefined) throw this.failure;
        if (state !== 'prepared' || this.disposed)
          throw new Error('GPU scene member reads require an open resource frame');
        pinTables();
        return inputs;
      },
      release: () => {
        if (state === 'prepared' || state === 'sealed' || state === 'failed') release();
      },
      seal: () => {
        if (this.failure !== undefined) return err(this.failure);
        if (state === 'sealed') return ok(undefined);
        if (state !== 'prepared' || this.disposed)
          throw new Error('GPU scene resource reads must be live when sealed');
        const sealed = inputs.seal();
        if (!sealed.ok) return sealed;
        pinTables();
        state = 'sealed';
        return ok(undefined);
      },
      submit: (completed, rowLifetime) => {
        if (state === 'released' || state === 'submitted') return;
        if (state !== 'sealed') throw new Error('Seal GPU scene resource reads before submission');
        state = 'submitted';
        const fence = completed ?? this.device.queue.onSubmittedWorkDone();
        if (rowLifetime === 'queue-order') {
          release(undefined, fence);
          return;
        }
        void fence.then(
          () => release(),
          () => release(),
        );
      },
    };
    const transfer = (retainRoots: boolean): Result<GpuSceneMaterialRootHold, RhiError> => {
      if (state !== 'sealed' || this.disposed || this.failure !== undefined)
        return err(resourceHoldInvalid());
      if (retainRoots) {
        if (this.cpuBusy) return err(resourceHoldInvalid());
        const roots = this.retainPinnedMaterialRoots(versions);
        if (roots === undefined) return err(resourceHoldInvalid());
        materialRoots = roots;
      }
      state = 'transferring';
      try {
        let failure: AggregateError | undefined;
        closeReads((cause) => {
          if (failure === undefined)
            failure = new AggregateError([cause], 'Resident read-domain retirement failed', {
              cause,
            });
          else failure.errors.push(cause);
        });
        if (failure !== undefined) release(failure);
        if (this.disposed || this.failure !== undefined) {
          release();
          return err(resourceHoldInvalid());
        }
        if (materialRoots !== undefined && !this.materialRootsCurrent(materialRoots, versions)) {
          release();
          return err(resourceHoldInvalid());
        }
        state = 'held';
        this.resourceFrameTransfers.delete(frame);
        return ok(
          Object.freeze({
            release: () => release(),
            isCurrent: () =>
              state === 'held' &&
              materialRoots !== undefined &&
              this.materialRootsCurrent(materialRoots, versions) &&
              state === 'held',
          }),
        );
      } catch (cause) {
        if (retirementFailure !== undefined) throw retirementFailure;
        release(new AggregateError([cause], 'Material-root custody transfer failed', { cause }));
        throw cause;
      }
    };
    this.resourceFrameTransfers.set(frame, {
      versions: () => {
        const moved = transfer(false);
        return moved.ok ? ok(Object.freeze({ release: moved.value.release })) : moved;
      },
      materialRoots: () => transfer(true),
    });
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

  /**
   * Instance transform ordinals the latest sync wrote for a slot, handed out
   * once so a slot drawn by several passes reports its upload one time.
   */
  takeInstanceUpload(slot: number): {
    readonly ranges: readonly { readonly start: number; readonly end: number }[];
    readonly bytes: number;
  } {
    const resident = this.instanceResidents.get(slot);
    if (
      !this.instanceUploadsReadable ||
      resident === undefined ||
      resident.observedSync === this.syncRevisionValue
    )
      return NO_INSTANCE_UPLOAD;
    const start = this.allocations.instanceTransformStart(slot);
    const count = this.allocations.instanceTransformCount(slot);
    if (start === undefined || count === undefined || count === 0) return NO_INSTANCE_UPLOAD;
    const writes = this.instanceUploads;
    const limit = start + count;
    let first = writes.next(start);
    if (first < 0 || first >= limit) return NO_INSTANCE_UPLOAD;
    resident.observedSync = this.syncRevisionValue;
    const ranges: { start: number; end: number }[] = [];
    let rows = 0;
    do {
      const end = Math.min(limit, writes.end(first));
      ranges.push({ start: first - start, end: end - start });
      rows += end - first;
      first = writes.next(end);
    } while (first >= 0 && first < limit);
    return { ranges, bytes: rows * TRANSFORM.stride };
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

  /** Bitmap address high-water mark, including primitive/instance holes, without native slack. */
  get rowAddressExtent(): number {
    return Math.max(this.records.requiredCapacity(), this.instances.requiredCapacity());
  }

  /** A prepared Level also owns View capacity until its native Source retires. */
  get viewStorageReduction(): number {
    return this.capacityPreparations.size === 0 ? this.reductions : 0;
  }

  get materialByteLength(): number {
    return this.tableBytes.material.byteLength;
  }

  get transformByteLength(): number {
    return this.tableBytes.transform.byteLength;
  }

  /** Prepare private native table capacity for the actual inactive Source; never swaps active tables. */
  *prepareSourceCapacity(
    rows: readonly RenderableSnapshot[],
    capture: (task: GpuSceneCapacityPreparation) => void,
    current: () => boolean,
  ): Generator<void, GpuSceneCapacityPreparation> {
    return yield* this.prepareSourceStorage(rows, capture, current);
  }

  /** Reserve actual target addresses and encode static numeric rows into private storage. */
  *prepareSourceRows(
    rows: readonly ReservedSceneRow[],
    capture: (task: GpuSceneCapacityPreparation) => void,
    current: () => boolean,
    meshes: readonly GpuSceneSourceMeshInput[],
  ): Generator<void, GpuSceneCapacityPreparation> {
    const sourceRows = new GpuSceneSourceRows(
      rows,
      {
        primitive: this.records,
        instance: this.instances,
        transform: this.transforms,
      },
      {
        material: (resource, capture) => this.prepareSourceMaterial(resource, capture),
        mesh: (geometry, capture) => this.prepareSourceMesh(geometry, capture),
      },
      this.materialFrame === undefined,
    );
    const geometries = new Map<number, MeshGeometry>();
    for (const input of meshes) {
      if (!current() || !this.live || this.cpuBusy) throw resourceHoldInvalid();
      const accepted = this.meshes.get(input.handle);
      const geometry =
        accepted?.source?.identity === input.identity && accepted.source.revision === input.revision
          ? accepted
          : new MeshFrame()
              .with(input.handle, input.asset, [], {
                identity: input.identity,
                revision: input.revision,
              })
              .get(input.handle);
      if (geometry === undefined || geometries.has(input.handle)) throw resourceHoldInvalid();
      geometries.set(input.handle, geometry);
      yield;
    }
    yield* sourceRows.prepareBindings((handle) => {
      const geometry = geometries.get(handle);
      if (geometry === undefined) throw resourceHoldInvalid();
      return geometry;
    }, current);
    return yield* this.prepareSourceStorage(sourceRows.snapshots, capture, current, sourceRows);
  }

  /** Source-issued table address envelope; private reservations do not advance the live domain. */
  preparedAddressExtent(task: GpuSceneCapacityPreparation): number | undefined {
    const scope = this.capacityPreparations.get(task);
    if (scope === undefined || !task.isValid()) return undefined;
    const source = scope.sourceRows;
    if (source !== undefined && scope.sourceEncoded !== true) return undefined;
    return source === undefined
      ? this.rowAddressExtent
      : Math.max(this.rowAddressExtent, scope.limits.primitive, scope.limits.instance);
  }

  /** Exact private row addresses of this task; no active allocation lookup is changed. */
  sourceRowAllocations(task: GpuSceneCapacityPreparation): readonly GpuSceneSourceRow[] {
    return Object.freeze([...(this.capacityPreparations.get(task)?.sourceRows?.rows ?? [])]);
  }

  /** One captured row without cloning the complete roster for each publication. */
  sourceRowAt(task: GpuSceneCapacityPreparation, index: number): GpuSceneSourceRow | undefined {
    return this.capacityPreparations.get(task)?.sourceRows?.rows[index];
  }

  /** Accepted row/resource custody survives another task's coherent table replacement. */
  sourceDataCurrent(task: GpuSceneCapacityPreparation): boolean {
    const scope = this.capacityPreparations.get(task);
    const data = scope?.sourceData;
    if (
      !this.live ||
      this.cpuBusy ||
      scope === undefined ||
      data === undefined ||
      scope.publicationFailure !== undefined ||
      scope.detachmentPending
    )
      return false;
    if (
      !scope.published &&
      (data.rows.length !== 0 ||
        scope.sourceRows?.rows.length !== 0 ||
        task.inspect().phase !== 'current')
    )
      return false;
    if (scope.sourceRows?.resourcesCurrent() !== true) return false;
    return this.live && !this.cpuBusy && !data.residency.invalidated;
  }

  sourceResourceAllocations(task: GpuSceneCapacityPreparation): {
    readonly materials: readonly GpuSceneSourceMaterial[];
    readonly meshes: readonly GpuSceneSourceMesh[];
  } {
    const source = this.capacityPreparations.get(task)?.sourceRows;
    return Object.freeze({
      materials: Object.freeze([...(source?.materials.values() ?? [])]),
      meshes: Object.freeze([...(source?.meshes.values() ?? [])]),
    });
  }

  /** Actual Source descriptors and mappings enter one private Inputs successor. */
  *prepareSourceInputs(
    task: GpuSceneCapacityPreparation,
    capture: (preparation: GpuSceneInputPreparation) => void,
    current: () => boolean,
    retired?: GpuSceneInputPreparation,
  ): Generator<void, GpuSceneInputPreparation> {
    const scope = this.capacityPreparations.get(task);
    const source = scope?.sourceRows;
    if (
      scope === undefined ||
      source === undefined ||
      scope.sourceEncoded !== true ||
      scope.sourceInput !== retired ||
      !task.isValid()
    )
      throw resourceHoldInvalid();
    if (
      retired !== undefined &&
      (retired.inspect().phase !== 'released' || !retired.retirement().unwrap().done)
    )
      throw resourceHoldInvalid();
    delete scope.sourceInput;
    const reservations = [];
    for (const resource of [...source.materials.values(), ...source.meshes.values()])
      if (resource.mapping !== undefined) reservations.push(resource.mapping);
    return yield* this.inputs.prepareResourceBuffer(
      reservations,
      () => current() && task.isValid() && source.resourcesCurrent(),
      (input) => {
        if (scope === undefined) throw resourceHoldInvalid();
        scope.sourceInput = input;
        capture(input);
      },
    );
  }

  /**
   * Prebuild shapes without reading pending baseline bytes. Ordinary frames may
   * dirty numeric copies while Source/address custody remains valid; the final
   * table/Inputs handoff still requires both uploads current in one boundary.
   */
  *prepareSourceData(task: GpuSceneCapacityPreparation): Generator<void> {
    const scope = this.capacityPreparations.get(task);
    const source = scope?.sourceRows;
    if (
      scope === undefined ||
      source === undefined ||
      scope.sourceEncoded !== true ||
      scope.published ||
      scope.sourceData !== undefined ||
      !task.isValid()
    )
      throw resourceHoldInvalid();
    const data = {
      residency: { invalidated: false },
      rows: [] as NonNullable<CapacityScope['sourceData']>['rows'],
    };
    scope.sourceData = data;
    for (const row of source.rows) {
      if (
        !task.isValid() ||
        source.rowMaterialRanges !== (this.materialFrame === undefined) ||
        this.allocations.has(row.source.slot)
      )
        throw resourceHoldInvalid();
      this.allocations.prepareSlot(row.source.slot);
      data.rows.push({
        source: row,
        stamp: 0,
        allocation: this.sourceRowAllocation(row, source),
      });
      yield;
    }
  }

  private sourceRowAllocation(
    row: GpuSceneSourceRow,
    source: GpuSceneSourceRows,
  ): PrimitiveAllocation {
    if (
      row.snapshot.skinBinding !== undefined ||
      row.snapshot.morph !== undefined ||
      row.snapshot.terrainSection !== undefined ||
      row.snapshot.pointsLines !== undefined
    )
      throw resourceHoldInvalid();
    const mesh = source.meshes.get(row.geometry)?.allocation;
    if (mesh === undefined) throw resourceHoldInvalid();
    const materialRanges = source.rowMaterialRanges
      ? this.internRanges(
          (row.source.snapshot.materials.length === 0
            ? [row.source.snapshot.material]
            : row.source.snapshot.materials
          ).map((resource) => {
            const allocation = source.materials.get(resource)?.allocation;
            if (allocation === undefined) throw resourceHoldInvalid();
            return allocation;
          }),
        )
      : NO_MATERIAL_RANGES;
    return {
      mesh,
      recordIndex: row.recordIndex,
      instanceStart: row.instanceStart,
      instanceCount: row.instanceCount,
      transformStart: row.transformStart,
      instanceTransformStart: row.instanceTransformStart,
      instanceTransformCount: row.snapshot.instances === undefined ? 0 : row.instanceCount,
      instanceCapacity: row.instanceCount,
      materialRanges,
    };
  }

  /** Connect the real CPU publication to numeric rows already accepted by this owner. */
  acceptSourceRow(
    task: GpuSceneCapacityPreparation,
    index: number,
    record: RenderSceneSlot,
  ): Result<void, RhiError> {
    const scope = this.capacityPreparations.get(task);
    const prepared = scope?.sourceData?.rows[index];
    if (
      !this.live ||
      this.cpuBusy ||
      scope?.published !== true ||
      prepared === undefined ||
      prepared.stamp === 0 ||
      this.allocations.stamp(record.slot) !== prepared.stamp
    )
      return err(resourceHoldInvalid());
    const expected = prepared.source.source;
    if (!sceneRowPublicationMatches(expected, record)) return err(resourceHoldInvalid());
    this.allocations.acceptPublication(record.slot, record.version);
    // Source preparation uploads separately and owns its own completion evidence.
    this.rememberInstanceResident(record.slot, slotContent(record).instances, true);
    return ok(undefined);
  }

  /** Caller has stopped/removes CPU membership before this native Data detachment. */
  detachSourceData(
    task: GpuSceneCapacityPreparation,
  ): Result<{ readonly done: boolean }, RhiError> {
    const scope = this.capacityPreparations.get(task);
    if (scope !== undefined && this.sourceDataTerminated(scope)) {
      scope.detachmentPending = false;
      delete scope.detachmentBatchEnd;
      return ok({ done: true });
    }
    if (!this.live || this.cpuBusy || scope?.published !== true || scope.sourceData === undefined)
      return err(resourceHoldInvalid());
    this.cpuBusy = true;
    scope.detachmentPending = true;
    try {
      const end =
        scope.detachmentBatchEnd ??
        this.clearSourceRowBatch(scope.sourceData.rows, scope.detachmentCursor ?? 0);
      scope.detachmentBatchEnd = end;
      this.markPendingCapacityDirty(this.writesByTable);
      const uploaded = this.uploadRows(this.writesByTable);
      if (!uploaded.ok) return uploaded;
      this.clearTableWrites();
      scope.detachmentCursor = end;
      delete scope.detachmentBatchEnd;
      const done = end >= scope.sourceData.rows.length;
      scope.detachmentPending = !done;
      return ok({ done });
    } catch (cause) {
      scope.publicationFailure = { cause };
      return this.failBindingPublication(cause);
    } finally {
      this.cpuBusy = false;
      if (this.disposed) this.releaseCpuTables();
    }
  }

  private clearSourceRowBatch(
    rows: NonNullable<CapacityScope['sourceData']>['rows'],
    start: number,
  ): number {
    let cursor = start;
    let units = 0;
    while (units < SOURCE_ROWS_PER_RETIREMENT_STEP) {
      const row = rows[cursor];
      if (row === undefined) break;
      const slot = row.source.source.slot;
      const allocation =
        row.stamp !== 0 && this.allocations.stamp(slot) === row.stamp
          ? this.allocations.get(slot)
          : undefined;
      const cost = Math.max(
        1,
        allocation?.instanceCapacity ?? 0,
        allocation?.materialRanges.length ?? 0,
      );
      // Preserve the existing indivisible clear for a large instance group.
      // Such a group takes its own turn instead of accumulating with other rows.
      if (cursor > start && units + cost > SOURCE_ROWS_PER_RETIREMENT_STEP) break;
      if (allocation !== undefined) this.clearSlot(slot, this.writesByTable);
      units += cost;
      cursor++;
    }
    return cursor;
  }

  private retireSourceData(task: GpuSceneCapacityPreparation, source: GpuSceneSourceRows): boolean {
    const scope = this.capacityPreparations.get(task);
    if (scope?.publicationFailure !== undefined) throw scope.publicationFailure.cause;
    if (this.disposed && scope?.published && !this.sourceDataTerminated(scope))
      throw resourceHoldInvalid();
    if (scope?.detachmentPending) return false;
    if (scope?.sourceInput?.inspect().phase === 'committed' && !scope.published)
      throw resourceHoldInvalid();
    const rows = scope?.sourceData?.rows;
    if (rows === undefined || rows.length === 0) return source.retireStep();
    for (let units = 0; units < SOURCE_ROWS_PER_RETIREMENT_STEP; ) {
      const row = rows.at(-1);
      if (row === undefined) break;
      if (scope?.published === true) {
        if (row.stamp !== 0 && this.allocations.stamp(row.source.source.slot) === row.stamp)
          return false;
        units++;
      } else {
        const cost = Math.max(1, row.allocation.materialRanges.length);
        if (units > 0 && units + cost > SOURCE_ROWS_PER_RETIREMENT_STEP) break;
        this.releaseRanges(row.allocation.materialRanges);
        units += cost;
      }
      rows.pop();
    }
    return false;
  }

  private sourceDataTerminated(scope: CapacityScope): boolean {
    return (
      this.disposed &&
      !this.cpuBusy &&
      this.failure === undefined &&
      this.disposalFailure === undefined &&
      this.tableRetirementFailure === undefined &&
      this.inputs.lifetimeFailure === undefined &&
      this.failedResourceFrames.size === 0 &&
      scope.published &&
      scope.publicationFailure === undefined &&
      scope.sourceData !== undefined &&
      this.allocations.size === 0
    );
  }

  private prepareSourceMaterial(
    resource: MaterialResource,
    capture: (claim: GpuSceneSourceMaterial) => void,
  ): GpuSceneSourceMaterial {
    const snapshot = resource.snapshot;
    const schema = this.materialProgramSchema(snapshot);
    if (
      snapshot.materialShaderId !== undefined &&
      !isCanonicalStandardPbrMaterialShader(snapshot.materialShaderId) &&
      schema === undefined
    )
      throw resourceHoldInvalid();
    const existing = this.sharedMaterials.get(resource);
    if (existing !== undefined) {
      const version = existing.version;
      let retained = false;
      const valid = () =>
        this.live &&
        !this.cpuBusy &&
        this.sharedMaterials.get(resource) === existing &&
        existing.version === version &&
        version.snapshot === snapshot &&
        resource.snapshot === snapshot &&
        version.schema === schema &&
        this.materialProgramSchema(snapshot) === schema &&
        version.initialized &&
        this.inputs.resourceIsCurrent(existing.logicalSlot, version.descriptor);
      if (!valid()) throw resourceHoldInvalid();
      const claim = sourceResource(
        {
          resource,
          snapshot,
          allocation: existing,
          logicalSlot: existing.logicalSlot,
          descriptor: version.descriptor,
        },
        () => retained && valid(),
        () => {
          if (!retained) return;
          this.releaseSourceResources([
            () => {
              if (!this.disposed && this.sharedMaterials.get(resource) === existing)
                this.releaseMaterial(existing, this.writesByTable);
            },
            () => this.releaseMaterialVersion(version, this.writesByTable),
          ]);
          retained = false;
        },
        () => {
          if (
            !retained ||
            this.sharedMaterials.get(resource) !== existing ||
            existing.version !== version ||
            resource.snapshot !== snapshot ||
            !this.inputs.resourceIsCurrent(existing.logicalSlot, version.descriptor)
          )
            throw resourceHoldInvalid();
        },
      );
      capture(claim);
      if (!valid()) throw resourceHoldInvalid();
      existing.holders++;
      version.references++;
      retained = true;
      return claim;
    }
    const count = this.materialUnits(snapshot);
    const bytes =
      schema === undefined
        ? packStandardPbrMaterialRow(STANDARD_PBR_RECEIPT, snapshot)
        : packMaterialProgramRow(schema, snapshot, Math.max(16, derive(schema).totalBytes));
    if (bytes === undefined || bytes.byteLength !== count * MATERIAL.stride)
      throw resourceHoldInvalid();
    let payload: ReturnType<StableRangeAllocator['reserve']> | undefined;
    let body: GpuSceneSourceMaterial['payload'];
    let descriptor: ReturnType<GpuSceneInputs['arena']['reserveDescriptor']> | undefined;
    let mapping: ReturnType<GpuSceneInputs['reserveResource']> | undefined;
    let allocation: MaterialAllocation | undefined;
    let complete = false;
    const claim: GpuSceneSourceMaterial = sourceResource(
      {
        resource,
        snapshot,
        get allocation() {
          if (allocation === undefined) throw resourceHoldInvalid();
          return allocation;
        },
        get logicalSlot() {
          if (mapping === undefined) throw resourceHoldInvalid();
          return mapping.logicalSlot;
        },
        get descriptor() {
          if (descriptor === undefined) throw resourceHoldInvalid();
          return descriptor.address;
        },
        get privateDescriptor() {
          return descriptor;
        },
        get mapping() {
          return mapping;
        },
        get payload() {
          return body;
        },
      },
      () =>
        complete &&
        this.live &&
        !this.cpuBusy &&
        resource.snapshot === snapshot &&
        this.materialProgramSchema(snapshot) === schema &&
        (allocation !== undefined && this.sharedMaterials.get(resource) === allocation
          ? allocation.version.snapshot === snapshot &&
            allocation.version.initialized &&
            this.inputs.resourceIsCurrent(allocation.logicalSlot, allocation.version.descriptor)
          : this.sharedMaterials.get(resource) === undefined &&
            payload?.isCurrent() === true &&
            descriptor?.isCurrent() === true &&
            mapping?.isCurrent() === true),
      () => {
        if (allocation !== undefined && this.sharedMaterials.get(resource) === allocation) {
          const held = allocation;
          this.releaseSourceResources([() => this.releaseMaterial(held, this.writesByTable)]);
          return;
        }
        this.releaseSourceResources([
          () => mapping?.release(),
          () => descriptor?.release(),
          () => payload?.release(),
        ]);
      },
      () => {
        if (
          allocation === undefined ||
          mapping === undefined ||
          descriptor === undefined ||
          payload === undefined
        )
          throw resourceHoldInvalid();
        if (this.sharedMaterials.get(resource) === allocation) return;
        if (
          this.sharedMaterials.has(resource) ||
          descriptor.isCurrent() ||
          mapping.isCurrent() ||
          !this.inputs.resourceIsCurrent(mapping.logicalSlot, descriptor.address)
        )
          throw resourceHoldInvalid();
        payload.accept();
        this.sharedMaterials.set(resource, allocation);
      },
    );
    capture(claim);
    try {
      payload = this.materials.reserve(count, count);
      body = { start: payload.start, bytes };
      const start = payload.start;
      descriptor = this.inputs.arena.reserveDescriptor(
        GPU_MATERIAL_DESCRIPTOR.words,
        (_address, target) => encodeMaterialSceneDescriptor(target, start, snapshot),
        (value) => {
          descriptor = value;
        },
      );
      mapping = this.inputs.reserveResource(descriptor, (value) => {
        mapping = value;
      });
      allocation = {
        resource,
        logicalSlot: mapping.logicalSlot,
        holders: 1,
        version: {
          descriptor: descriptor.address,
          start,
          count,
          snapshot,
          references: 1,
          initialized: true,
          schema,
        },
      };
      complete = true;
      if (!claim.isCurrent()) throw resourceHoldInvalid();
      return claim;
    } catch (cause) {
      try {
        claim.release();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Private material capture and rollback failed', {
          cause,
        });
      }
      throw cause;
    }
  }

  private prepareSourceMesh(
    geometry: MeshGeometry,
    capture: (claim: GpuSceneSourceMesh) => void,
  ): GpuSceneSourceMesh {
    const key = geometry.handle;
    const existing = this.sharedMeshes.get(key);
    if (existing !== undefined) {
      const version = existing.version;
      let retained = false;
      const valid = () =>
        this.live &&
        !this.cpuBusy &&
        this.sharedMeshes.get(key) === existing &&
        existing.version === version &&
        version.geometry === geometry &&
        !this.pendingMeshes.has(version) &&
        this.inputs.resourceIsCurrent(existing.logicalSlot, version.descriptor);
      if (!valid()) throw resourceHoldInvalid();
      const claim = sourceResource(
        {
          geometry,
          allocation: existing,
          logicalSlot: existing.logicalSlot,
          descriptor: version.descriptor,
        },
        () => retained && valid(),
        () => {
          if (!retained) return;
          this.releaseSourceResources([
            () => {
              if (!this.disposed && this.sharedMeshes.get(key) === existing)
                this.releaseMeshAllocation(existing);
            },
            () => this.releaseMeshVersion(version),
          ]);
          retained = false;
        },
        () => {
          if (
            !retained ||
            this.sharedMeshes.get(key) !== existing ||
            existing.version !== version ||
            version.geometry !== geometry ||
            !this.inputs.resourceIsCurrent(existing.logicalSlot, version.descriptor)
          )
            throw resourceHoldInvalid();
        },
      );
      capture(claim);
      if (!valid()) throw resourceHoldInvalid();
      existing.holders++;
      version.references++;
      retained = true;
      return claim;
    }
    let descriptor: ReturnType<GpuSceneInputs['arena']['reserveDescriptor']> | undefined;
    let mapping: ReturnType<GpuSceneInputs['reserveResource']> | undefined;
    let allocation: MeshAllocation | undefined;
    let complete = false;
    const claim: GpuSceneSourceMesh = sourceResource(
      {
        geometry,
        get allocation() {
          if (allocation === undefined) throw resourceHoldInvalid();
          return allocation;
        },
        get logicalSlot() {
          if (mapping === undefined) throw resourceHoldInvalid();
          return mapping.logicalSlot;
        },
        get descriptor() {
          if (descriptor === undefined) throw resourceHoldInvalid();
          return descriptor.address;
        },
        get privateDescriptor() {
          return descriptor;
        },
        get mapping() {
          return mapping;
        },
      },
      () =>
        complete &&
        this.live &&
        !this.cpuBusy &&
        (allocation !== undefined && this.sharedMeshes.get(key) === allocation
          ? allocation.version.geometry === geometry &&
            this.inputs.resourceIsCurrent(allocation.logicalSlot, allocation.version.descriptor)
          : this.sharedMeshes.get(key) === undefined &&
            descriptor?.isCurrent() === true &&
            mapping?.isCurrent() === true),
      () => {
        if (allocation !== undefined && this.sharedMeshes.get(key) === allocation) {
          const held = allocation;
          this.releaseSourceResources([() => this.releaseMeshAllocation(held)]);
        } else this.releaseSourceResources([() => mapping?.release(), () => descriptor?.release()]);
      },
      () => {
        if (allocation === undefined || mapping === undefined || descriptor === undefined)
          throw resourceHoldInvalid();
        if (this.sharedMeshes.get(key) === allocation) return;
        if (
          this.sharedMeshes.has(key) ||
          descriptor.isCurrent() ||
          mapping.isCurrent() ||
          !this.inputs.resourceIsCurrent(mapping.logicalSlot, descriptor.address)
        )
          throw resourceHoldInvalid();
        this.sharedMeshes.set(key, allocation);
      },
    );
    capture(claim);
    try {
      descriptor = this.inputs.arena.reserveDescriptor(
        meshInputWords(geometry),
        (address, target) => {
          encodeMeshSceneDescriptor(target, address, geometry);
          const envelopes = geometry.skinEnvelopes;
          if (envelopes !== undefined)
            for (let index = 0; index < envelopes.length; index++)
              target.setFloat32(
                (GPU_MESH_DESCRIPTOR.words + index) * 4,
                envelopes[index] ?? 0,
                true,
              );
        },
        (value) => {
          descriptor = value;
        },
      );
      mapping = this.inputs.reserveResource(descriptor, (value) => {
        mapping = value;
      });
      allocation = {
        key,
        logicalSlot: mapping.logicalSlot,
        holders: 1,
        version: {
          descriptor: descriptor.address,
          words: descriptor.wordCount,
          geometry,
          references: 1,
        },
      };
      complete = true;
      if (!claim.isCurrent()) throw resourceHoldInvalid();
      return claim;
    } catch (cause) {
      try {
        claim.release();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Private Mesh capture and rollback failed', {
          cause,
        });
      }
      throw cause;
    }
  }

  private releaseSourceResources(parts: readonly (() => void)[]): void {
    try {
      releaseSourceParts(parts);
    } catch (cause) {
      this.failure ??= Object.assign(
        new RhiError({
          code: 'internal-error',
          expected: 'confirmed release of every Source-owned resource',
          hint: 'retain the failed custody and retire this GPU Scene before rebuilding',
        }),
        { cause },
      );
      throw this.failure;
    }
  }

  private *sourceStorageSizes(
    rows: readonly RenderableSnapshot[],
    current: () => boolean,
  ): Generator<void, { instances: number; transforms: number; materials: number }> {
    let instances = 0,
      transforms = rows.length,
      materials = 0;
    const resources = new Set<MaterialResource>();
    for (const row of rows) {
      if (!current()) throw resourceHoldInvalid();
      const count = row.instances === undefined ? 1 : row.instances.instanceCount;
      if (!Number.isSafeInteger(count) || count < 0) throw resourceHoldInvalid();
      instances += count;
      if (row.instances !== undefined) transforms += count;
      const required = row.materials.length === 0 ? [row.material] : row.materials;
      for (const material of required) {
        if (resources.has(material) || this.sharedMaterials.has(material)) continue;
        resources.add(material);
        materials += this.materialUnits(material.snapshot);
      }
      yield;
    }
    return { instances, transforms, materials };
  }

  private sourceTableDemands(
    required: Record<GpuSceneTableName, number>,
    writesRows: boolean,
  ): {
    demands: CapacityTableDemand[];
    limits: Record<GpuSceneTableName, number>;
  } {
    const rowLimit = growGpuSceneTableCapacity(
      this.capacity,
      required.primitive,
      GPU_SCENE_ROW_TABLE_STRIDE,
      gpuSceneTableByteLimit(this.device, this.backend),
    ).unwrap();
    const demands: CapacityTableDemand[] = [];
    const limits = { primitive: 0, instance: 0, transform: 0, material: 0 };
    for (const name of TABLE_NAMES) {
      const stride = TABLE_LAYOUTS[name].stride;
      const before = this.tableBytes[name].byteLength / stride;
      if (!Number.isSafeInteger(required[name])) throw resourceHoldInvalid();
      const next =
        name === 'primitive' || name === 'instance'
          ? rowLimit
          : growGpuSceneTableCapacity(
              before,
              required[name],
              stride,
              gpuSceneTableByteLimit(this.device, this.backend),
            ).unwrap();
      limits[name] = next;
      if (next !== before || writesRows) demands.push({ name, stride, bytes: next * stride });
    }
    return { demands, limits };
  }

  private *prepareSourceStorage(
    rows: readonly RenderableSnapshot[],
    capture: (task: GpuSceneCapacityPreparation) => void,
    current: () => boolean,
    sourceRows?: GpuSceneSourceRows,
  ): Generator<void, GpuSceneCapacityPreparation> {
    const resourcesLive = () =>
      current() &&
      !this.disposed &&
      !this.cpuBusy &&
      this.failure === undefined &&
      (sourceRows?.resourcesCurrent() ?? true);
    const addition =
      sourceRows === undefined
        ? yield* this.sourceStorageSizes(rows, resourcesLive)
        : { instances: 0, transforms: 0, materials: 0 };
    const primitives = sourceRows === undefined ? rows.length : 0;
    const activeDemand = (name: GpuSceneTableName): number => {
      switch (name) {
        case 'primitive':
          return this.records.requiredCapacity() + primitives;
        case 'instance':
          return this.instances.requiredCapacity() + addition.instances;
        case 'transform':
          return this.transforms.requiredCapacity() + addition.transforms;
        case 'material':
          return this.materials.requiredCapacity() + addition.materials;
      }
    };
    const scope: CapacityScope = {
      limits: { primitive: 0, instance: 0, transform: 0, material: 0 },
      current,
      parent: undefined,
      published: false,
      ...(sourceRows === undefined ? {} : { sourceRows }),
    };
    let copyCurrent: (() => boolean) | undefined;
    const task: GpuSceneCapacityPreparation = new GpuSceneCapacityPreparation(
      this.device,
      this.backend,
      undefined,
      (name) => this.tableBytes[name],
      () => resourcesLive() && copyCurrent?.() === true,
      () => this.capacityPreparations.delete(task),
      sourceRows === undefined ? undefined : () => this.retireSourceData(task, sourceRows),
      sourceRows === undefined ? undefined : () => sourceRows.privateDescriptorBytes,
    );
    if (!resourcesLive()) throw resourceHoldInvalid();
    this.capacityPreparations.set(task, scope);
    capture(task);
    if (sourceRows !== undefined)
      yield* sourceRows.reserve(resourcesLive, (slot) => !this.allocations.has(slot));
    if (!resourcesLive()) throw resourceHoldInvalid();

    // Address reservations do not read the baseline. Only the copy depends on
    // its exact table root, and its demand includes the actual reserved addresses.
    const baseline = this.tables;
    const baselineBytes = this.tableBytes;
    const demand = (name: GpuSceneTableName) =>
      Math.max(activeDemand(name), sourceRows?.extent[name] ?? 0);
    const rowExtent = Math.max(demand('primitive'), demand('instance'));
    const { demands, limits } = this.sourceTableDemands(
      {
        primitive: rowExtent,
        instance: rowExtent,
        transform: demand('transform'),
        material: demand('material'),
      },
      sourceRows !== undefined && rows.length > 0,
    );
    scope.parent = baseline;
    scope.limits = limits;
    copyCurrent = () =>
      this.tables === baseline &&
      this.tableBytes === baselineBytes &&
      (sourceRows !== undefined || TABLE_NAMES.every((name) => activeDemand(name) <= limits[name]));
    task.planTables(demands);
    for (;;) {
      const state = task.step().unwrap();
      // Do not yield after the final catch-up: an old-world stamp can dirty it again.
      if (state.phase === 'current' && task.isCurrent()) break;
      yield;
    }
    if (sourceRows !== undefined) {
      yield* sourceRows.encode(task, resourcesLive, () => this.frameStamp);
      if (!task.isValid()) throw resourceHoldInvalid();
      scope.sourceEncoded = true;
    }
    for (;;) {
      if (task.isCurrent()) return task;
      task.step().unwrap();
      if (task.isCurrent()) return task;
      yield;
    }
  }

  failBindingPublication(cause: unknown): Result<never, RhiError> {
    this.failure ??= Object.assign(
      new RhiError({
        code: 'internal-error',
        expected: 'complete accepted Scene and consumer binding publication',
        hint: 'stop execution and rebuild this owner while retaining accepted cleanup responsibility',
      }),
      { cause },
    );
    return err(this.failure);
  }

  readHoldsTableRoot(reads: GpuInputReadFrame, identity: object): boolean {
    if (!this.inputs.ownsRead(reads)) return false;
    const roots = this.inputTableRoots.get(reads);
    return roots instanceof Map ? roots.has(identity) : roots?.tables === identity;
  }

  get tableBindingIdentity(): object {
    return this.tables;
  }

  prepareCapacityBindingTarget(
    task: GpuSceneCapacityPreparation,
  ): Result<GpuSceneTableBindingTarget, RhiError> {
    const scope = this.capacityPreparations.get(task);
    if (scope === undefined || scope.published || !task.isCurrent() || this.backend !== 'buffer')
      return err(resourceHoldInvalid());
    if (scope.target !== undefined) return ok(scope.target);
    const prepared = task.preparedTables();
    if (prepared === undefined) return err(resourceHoldInvalid());
    const tables = { ...this.tables },
      bytes = { ...this.tableBytes };
    for (const value of prepared) {
      tables[value.name] = value.resource;
      bytes[value.name] = value.bytes;
    }
    const target = Object.freeze({
      owner: this,
      preparation: task,
      identity: tables,
      primitiveBuffer: tableBuffer(tables.primitive),
      instanceBuffer: tableBuffer(tables.instance),
      transformBuffer: tableBuffer(tables.transform),
      materialBuffer: tableBuffer(tables.material),
      rowCapacity: scope.limits.primitive,
      transformBytes: bytes.transform.byteLength,
      materialBytes: bytes.material.byteLength,
    });
    scope.tables = tables;
    scope.bytes = bytes;
    scope.target = target;
    return ok(target);
  }

  /** Pure ownership bookend for consumers; never refreshes Source or compiler facts. */
  capacityTargetMatches(target: GpuSceneTableBindingTarget): boolean {
    const scope = this.capacityPreparations.get(target.preparation);
    return (
      scope?.target === target &&
      this.live &&
      !this.cpuBusy &&
      (scope.published
        ? this.tables === scope.tables
        : this.tables === scope.parent && target.preparation.preparedTables() !== undefined)
    );
  }
  capacityTargetCurrent(target: GpuSceneTableBindingTarget): boolean {
    const scope = this.capacityPreparations.get(target.preparation);
    return (
      this.capacityTargetMatches(target) &&
      scope?.current() === true &&
      this.capacityTargetMatches(target)
    );
  }

  /** Consumes only preflighted private state. Retirement starts in a later microtask. */
  canPublishCapacityTarget(
    target: GpuSceneTableBindingTarget,
    input?: GpuSceneInputPreparation,
  ): boolean {
    const scope = this.capacityPreparations.get(target.preparation);
    if (scope?.sourceRows !== undefined && scope.sourceInput !== input) return false;
    return this.capacityPublicationCurrent(scope, target);
  }

  private capacityPublicationCurrent(
    scope: CapacityScope | undefined,
    target: GpuSceneTableBindingTarget,
  ): scope is CapacityScope & Required<Pick<CapacityScope, 'tables' | 'bytes'>> {
    return (
      scope !== undefined &&
      (scope.sourceRows === undefined || this.sourceDataReady(scope)) &&
      !scope.published &&
      scope.tables !== undefined &&
      scope.bytes !== undefined &&
      this.capacityTargetMatches(target)
    );
  }

  private sourceDataReady(scope: CapacityScope): boolean {
    const data = scope.sourceData;
    return (
      scope.publicationFailure === undefined &&
      scope.sourceEncoded === true &&
      data !== undefined &&
      scope.sourceRows?.rowMaterialRanges === (this.materialFrame === undefined) &&
      data.rows.length === scope.sourceRows?.rows.length &&
      data.rows.every((row) => !this.allocations.has(row.source.source.slot))
    );
  }

  private consumeSourceData(scope: CapacityScope): void {
    const source = scope.sourceRows,
      data = scope.sourceData;
    if (source === undefined || data === undefined) return;
    for (const material of source.materials.values()) material.adopt();
    // Each held mesh validates its own exact version. Merge those claims into the
    // current mesh frame so unrelated changes made while preparing stay published.
    for (const mesh of source.meshes.values()) {
      mesh.adopt();
      if (this.meshes.get(mesh.geometry.handle) !== mesh.geometry)
        this.meshes = this.meshes.withGeometry(mesh.geometry);
    }
    source.acceptRanges();
    for (const row of data.rows) {
      if (row.allocation.mesh !== undefined) row.allocation.mesh.holders++;
      for (const material of row.allocation.materialRanges) material.holders++;
      this.allocations.set(row.source.source.slot, row.allocation, data.residency);
      row.stamp = this.allocations.stamp(row.source.source.slot);
      this.allocationRevisionValue++;
    }
    for (const { contexts, geometry, value } of source.bindings) contexts[geometry] = value;
  }

  /** Capacity-only transfer. Source row custody requires its complete owning handoff. */
  publishCapacityTarget(target: GpuSceneTableBindingTarget): Result<void, RhiError> {
    const scope = this.capacityPreparations.get(target.preparation);
    if (!this.capacityPublicationCurrent(scope, target)) return err(resourceHoldInvalid());
    if (scope.sourceRows !== undefined && scope.sourceInput?.inspect().phase !== 'committed')
      return err(resourceHoldInvalid());
    const previous = this.tables;
    const taken = target.preparation.transfer(() => this.capacityTargetMatches(target));
    if (!taken.ok) return taken;
    this.cpuBusy = true;
    try {
      this.publishTables(scope.tables);
      this.textureViews = textureTableViews(scope.tables);
      this.tableBytes = scope.bytes;
      this.capacity = scope.limits.primitive;
      this.transformCapacity = scope.limits.transform;
      this.materialCapacity = scope.limits.material;
      this.refreshCpuViews();
      this.consumeSourceData(scope);
      scope.published = true;
      scope.parent = undefined;
      this.capacityGrows++;
      queueMicrotask(() => {
        for (const name of TABLE_NAMES)
          if (previous[name] !== this.tables[name]) this.retireTable(previous[name]);
      });
      return ok(undefined);
    } catch (cause) {
      scope.publicationFailure = { cause };
      return this.failBindingPublication(cause);
    } finally {
      this.cpuBusy = false;
    }
  }

  private markPendingCapacityDirty(rows: GpuSceneWrites): void {
    if (this.capacityPreparations.size === 0) return;
    for (const name of TABLE_NAMES) {
      const changes = rows[name];
      const stride = TABLE_LAYOUTS[name].stride;
      let first = changes.next(0);
      while (first >= 0) {
        const end = changes.end(first);
        this.markCapacityDirty(name, first * stride, (end - first) * stride);
        first = changes.next(end);
      }
    }
  }

  private clearTableWrites(): void {
    for (const name of TABLE_NAMES) {
      const writes = this.writesByTable[name];
      writes.clear();
      if (!this.tableRowsReleased || writes.storageBytes <= 256) continue;
      const allocator =
        name === 'primitive'
          ? this.records
          : name === 'instance'
            ? this.instances
            : name === 'transform'
              ? this.transforms
              : this.materials;
      writes.trim(allocator.allocatedEnd());
    }
    this.reviewCapacity ||= this.tableRowsReleased;
    this.tableRowsReleased = false;
  }

  private markCapacityDirty(name: GpuSceneTableName, offset: number, size: number): void {
    for (const task of this.capacityPreparations.keys()) task.dirty(name, offset, size);
  }

  sync(
    delta: RenderSceneApplyResult,
    temporalResolver?: GpuSceneTemporalResolver,
    boundsOf?: GpuSceneSlotBounds,
  ): Result<GpuSceneSyncResult, RhiError> {
    if (this.failure !== undefined) return err(this.failure);
    if (this.disposed || this.cpuBusy) return this.cpuUpdateUnavailable();
    this.cpuBusy = true;
    let notified = false;
    try {
      this.adoptMaterialFrame(delta);
      this.adoptMeshFrame(delta);
      if (this.instanceUploadsReadable) {
        this.instanceUploads.clear();
        this.instanceUploads.trim(this.transforms.allocatedEnd());
        this.instanceUploadsReadable = false;
      }
      if (this.isUnchangedDelta(delta)) this.noChangeFrames++;
      const writesByTable = this.writesByTable;
      if (!this.identityUploaded) writesByTable.transform.add(0);
      this.allocateDeltaSlots(delta, writesByTable);
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
      for (const allocation of this.pendingMaterialRoots)
        this.writeMaterial(allocation.version, writesByTable, false);
      this.writeSlotPublications(delta, writesByTable, temporalResolver);
      if (this.disposed) return this.cpuUpdateUnavailable();
      this.markPendingCapacityDirty(writesByTable);
      notified = true;
      const uploaded = this.uploadRows(writesByTable);
      if (!uploaded.ok) return uploaded;
      this.completeSync(delta, boundsOf);
      if (this.disposed) return this.cpuUpdateUnavailable();
      this.syncRevisionValue++;
      this.instanceUploadsReadable = true;
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
    } finally {
      this.packedMaterialRows = undefined;
      if (!notified) this.markPendingCapacityDirty(this.writesByTable);
      this.cpuBusy = false;
      if (this.disposed) this.releaseCpuTables();
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
    const packed = this.sharedMaterials.get(after.resource)?.version;
    const alreadyPacked = packed?.initialized === true && packed.snapshot === after.snapshot;
    const allocation =
      before === undefined
        ? this.acquireMaterial(after.resource, this.writesByTable)
        : this.sharedMaterials.get(after.resource);
    if (allocation === undefined) throw new Error('Accepted GPU material root is missing');
    this.adoptMaterial(allocation, this.writesByTable);
    if (!allocation.version.initialized || !alreadyPacked)
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
    const range = this.sharedMeshes.get(geometry.handle);
    if (range === undefined) return;
    const previous = range.version;
    if (previous.geometry === geometry) return;
    const words = meshInputWords(geometry);
    if (previous.references === 1 && previous.words === words) {
      this.pendingMeshes.delete(previous);
      range.version = { descriptor: previous.descriptor, words, geometry, references: 1 };
      previous.references = 0;
    } else {
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
      !TABLE_NAMES.some((name) => !this.writesByTable[name].empty) &&
      this.pendingMeshes.size === 0 &&
      this.pendingMaterialRoots.size === 0 &&
      this.identityUploaded
    );
  }

  /** Classify each allocated slot once for the following numeric write stage. */
  private allocateDeltaSlots(delta: RenderSceneApplyResult, writesByTable: GpuSceneWrites): void {
    this.allocations.beginWrites();
    if (delta.resynced > 0) {
      for (const slot of this.allocations.keys()) this.clearSlot(slot, writesByTable);
    }
    // RenderScene may recycle a released CPU slot for a different identity in
    // the same delta. Clear the old GPU allocation before ensuring the new
    // record; otherwise the later removal pass clears the newly allocated
    // record and the next transform-only update sees no allocation.
    for (const record of delta.removedSlots) {
      this.clearSlot(record.slot, writesByTable);
    }
    this.allocateSlotLane(delta.createdSlots, SlotWrite.reset, writesByTable);
    this.allocateSlotLane(delta.contentUpdatedSlots, SlotWrite.full, writesByTable);
    this.allocateSlotLane(delta.instanceUpdatedSlots, SlotWrite.instances, writesByTable);
    this.allocateSlotLane(delta.recreatedSlots, SlotWrite.reset, writesByTable);
    for (const resource of delta.materialUpdates ?? []) {
      const range = this.sharedMaterials.get(resource);
      if (range !== undefined) {
        this.adoptMaterial(range, writesByTable);
        this.pendingMaterialRoots.add(range);
      }
    }
  }

  private allocateSlotLane(
    records: readonly RenderSceneSlot[],
    required: typeof SlotWrite.reset | typeof SlotWrite.full | typeof SlotWrite.instances,
    writes: GpuSceneWrites,
  ): void {
    for (const record of records) {
      const previous = this.allocations.stamp(record.slot);
      const resized = this.ensureAllocation(record, writes);
      const reset = previous !== this.allocations.stamp(record.slot);
      this.allocations.requireWrite(
        record.slot,
        reset
          ? SlotWrite.reset
          : resized && required === SlotWrite.instances
            ? SlotWrite.full
            : required,
      );
    }
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
    encodeMeshSceneDescriptor(this.rowScratchView, range.descriptor, range.geometry);
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
   * Full rows for new/reset/content/resized slots; transform-only rows for the
   * rest. A resized slot kept its rows, so it compares against them (no reset).
   */
  private writeSlotPublications(
    delta: RenderSceneApplyResult,
    writesByTable: GpuSceneWrites,
    temporalResolver: GpuSceneTemporalResolver | undefined,
  ): void {
    const write = (record: RenderSceneSlot) => {
      if (this.allocations.publicationVersion(record.slot) === record.version) {
        const temporal = temporalResolver?.(record);
        if (temporal !== undefined) {
          if (slotContent(record).instances !== undefined)
            this.writeInstanceTransforms(record, writesByTable, temporal);
          this.writeRootTransform(record, false, writesByTable);
          this.writeTemporalFlags(
            record.slot,
            primitiveTemporalFlags(false, temporal),
            writesByTable,
          );
        }
        return;
      }
      const kind = this.allocations.writeClass(record.slot);
      const reset = kind === SlotWrite.reset;
      if (kind >= SlotWrite.full) {
        this.writeSlot(record, reset, writesByTable, temporalResolver?.(record));
        return;
      }
      const temporal = temporalResolver?.(record);
      if (kind === SlotWrite.instances)
        this.writeInstanceTransforms(record, writesByTable, temporal);
      this.writeRootTransform(record, false, writesByTable);
      this.writeTemporalFlags(record.slot, primitiveTemporalFlags(false, temporal), writesByTable);
    };
    // Read the fixed write order without assembling a second record list.
    delta.createdSlots.forEach(write);
    const updated = delta.updatedSlots;
    const bySlot = temporalResolver?.bySlot;
    if (
      updated instanceof PublishedPoseRows &&
      (temporalResolver === undefined || bySlot !== undefined)
    )
      updated.visitWrites(write, (slot, version, content, column, offset, ordinal) => {
        if (
          content.instances !== undefined ||
          this.allocations.writeClass(slot) !== SlotWrite.pose
        ) {
          write(updated.at(ordinal) as RenderSceneSlot);
          return;
        }
        const temporal = bySlot?.(slot);
        if (temporal === undefined && this.allocations.publicationVersion(slot) === version) return;
        this.writeRootPose(slot, column, offset, false, writesByTable);
        this.writeTemporalFlags(slot, primitiveTemporalFlags(false, temporal), writesByTable);
      });
    else updated.forEach(write);
    delta.recreatedSlots.forEach(write);
  }

  /** Retire pending upload state after a successful row upload and record the content change. */
  private completeSync(
    delta: RenderSceneApplyResult,
    boundsOf: GpuSceneSlotBounds | undefined,
  ): void {
    for (const version of this.pendingMaterials) version.initialized = true;
    this.pendingMaterials.clear();
    this.pendingMaterialRoots.clear();
    this.pendingMeshes.clear();
    this.clearTableWrites();
    this.identityUploaded = true;
    this.clearedSlots += delta.removedSlots.length;
    if (delta.resynced > 0) this.fullRebuilds += 1;
    if (delta.journal !== undefined) this.journal = delta.journal;
    this.contentBoxes.record(this.journal, delta, boundsOf);
    if (
      this.contentAt.journal !== this.journal ||
      this.contentAt.position !== this.journal.position
    )
      this.contentAt = { journal: this.journal, position: this.journal.position };
  }

  /**
   * Receipt of a submitted frame: the next frame gets a fresh stamp, so every
   * row stamped by this one reads previous = current again without a write,
   * and its previous-pose rows are available for the next frame. Queue order
   * keeps the stamp and later scratch writes behind work that still reads them.
   */
  commitFrame(): Result<void, RhiError> {
    if (this.failure !== undefined) return err(this.failure);
    if (this.disposed || this.cpuBusy) return this.cpuUpdateUnavailable();
    this.cpuBusy = true;
    try {
      this.frameStamp = this.frameStamp === 0xffffffff ? 1 : this.frameStamp + 1;
      this.transformView.setUint32(TRANSFORM_STAMP, this.frameStamp, true);
      this.markCapacityDirty('transform', TRANSFORM_STAMP, 4);
      const written = writeGpuSceneTable(
        this.device,
        this.tables.transform,
        this.transformBytes.buffer,
        TRANSFORM_STAMP,
        4,
      );
      if (!written.ok) {
        this.writesByTable.transform.add(0);
        return written;
      }
      if (this.disposed) return this.cpuUpdateUnavailable();
      this.uploadRanges += 1;
      this.uploadBytes += written.value;
      this.followTableReduction('transform', TRANSFORM_STAMP, 4);
      if (this.previousRows.submitted()) this.reviewCapacity = true;
      this.reduceSubmittedTables();
      this.inputs.reclaimSubmittedCapacity();
      if (this.disposed) return this.cpuUpdateUnavailable();
      return ok(undefined);
    } finally {
      this.cpuBusy = false;
      if (this.disposed) this.releaseCpuTables();
    }
  }

  /** Previous pose = current pose for the frame being prepared. */
  private seedPrevious(index: number, writes: GpuSceneWrites): void {
    const at = index * TRANSFORM.stride;
    this.transformView.setUint32(at + TRANSFORM_PREVIOUS, index, true);
    this.transformView.setUint32(at + TRANSFORM_STAMP, this.frameStamp, true);
    writes.transform.add(index);
  }

  /** Stamp a row for this frame without moving it; an earlier change this frame stays. */
  private stampTransform(index: number, writes: GpuSceneWrites): void {
    const at = index * TRANSFORM.stride;
    if (this.transformView.getUint32(at + TRANSFORM_STAMP, true) !== this.frameStamp)
      this.seedPrevious(index, writes);
  }

  /** The submitted pose is resident only under this frame's stamp. A self link seeds current. */
  private retainedPrevious(index: number): number {
    const at = index * TRANSFORM.stride;
    return this.transformView.getUint32(at + TRANSFORM_STAMP, true) === this.frameStamp
      ? this.transformView.getUint32(at + TRANSFORM_PREVIOUS, true)
      : index;
  }

  private allocatePrevious(index: number): number {
    const at = index * TRANSFORM.stride;
    const row = this.previousRows.take();
    if (row >= this.transformCapacity) {
      const grown = this.grow(this.capacity, row + 1, this.materialCapacity);
      if (!grown.ok) throw grown.error;
    }
    this.transformView.setUint32(at + TRANSFORM_PREVIOUS, row, true);
    this.transformView.setUint32(at + TRANSFORM_STAMP, this.frameStamp, true);
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
    writes: GpuSceneWrites,
  ): void {
    const at = index * TRANSFORM.stride + TRANSFORM_CURRENT;
    let lane = 0;
    while (
      lane < 16 &&
      Object.is(
        this.transformView.getFloat32(at + lane * 4, true),
        matrix[sourceOffset + lane] ?? 0,
      )
    )
      lane++;
    if (lane === 16) return;
    if (this.retainedPrevious(index) === index) {
      const row = this.allocatePrevious(index);
      this.transformBytes.copyWithin(row * TRANSFORM.stride + TRANSFORM_CURRENT, at, at + 64);
      writes.transform.add(row);
    }
    for (; lane < 16; lane++)
      this.transformView.setFloat32(at + lane * 4, matrix[sourceOffset + lane] ?? 0, true);
    writes.transform.add(index);
  }

  /** Write a known previous pose (a mapped submitted instance row) for `index`. */
  private writePrevious(
    index: number,
    previous: Float32Array,
    previousOffset: number,
    writes: GpuSceneWrites,
  ): void {
    const previousIndex = this.retainedPrevious(index);
    const row = previousIndex === index ? this.allocatePrevious(index) : previousIndex;
    writeMat4(
      this.transformView,
      row * TRANSFORM.stride + TRANSFORM_CURRENT,
      previous,
      previousOffset,
    );
    writes.transform.add(index);
    writes.transform.add(row);
  }

  private writeTemporalFlags(slot: number, temporalFlags: number, writes: GpuSceneWrites): void {
    const primitive = this.primitiveView;
    const recordIndex = this.allocations.recordIndex(slot);
    if (recordIndex === undefined) return;
    const at = recordIndex * PRIMITIVE.stride + offset(PRIMITIVE, 'flags');
    const current = primitive.getUint32(at, true);
    const next =
      (current & ~(GPU_SCENE_PRIMITIVE_REACTIVE | GPU_SCENE_PRIMITIVE_MOTION_INVALID)) |
      temporalFlags;
    // Pulses hold only while the root row carries this frame's stamp.
    if (temporalFlags !== 0) {
      const transformStart = this.allocations.transformStart(slot);
      if (transformStart !== undefined) this.stampTransform(transformStart, writes);
    }
    if (next === current) return;
    primitive.setUint32(at, next, true);
    writes.primitive.add(recordIndex);
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
      pinWorkspaces: {
        materials: this.materialPinWorkspace.inspect(),
        meshes: this.meshPinWorkspace.inspect(),
      },
      tableReclamation: {
        reductions: this.reductions,
        failures: this.reductionFailures,
        privateBytes: this.reduction?.task.inspect().cpuBytes ?? 0,
      },
      fullRebuilds: this.fullRebuilds,
      clearedSlots: this.clearedSlots,
      noChangeFrames: this.noChangeFrames,
      instanceRowsVisited: this.instanceRowsVisited,
      instanceUploadBackingBytes: this.instanceUploads.storageBytes,
    };
  }

  dispose(): void {
    if (this.disposed) {
      if (this.disposalFailure !== undefined) throw this.disposalFailure;
      if (this.tableRetirementFailure !== undefined) throw this.tableRetirementFailure;
      if (this.inputs.lifetimeFailure !== undefined) throw this.inputs.lifetimeFailure;
      if (this.failedResourceFrames.size > 0)
        throw new AggregateError(
          [...this.failedResourceFrames.values()].map((record) => record.failure),
          'GPU resource retirement remains unconfirmed',
        );
      return;
    }
    this.disposed = true;
    for (const task of this.capacityPreparations.keys()) task.invalidate();
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
    for (const record of this.failedResourceFrames.values()) {
      // Input read leases are idempotent. Failed numeric version releases cannot
      // safely be replayed; preserve those facts for receiver-scope recovery.
      attempt(record.releaseInputs);
      attempt(() => {
        throw record.failure;
      });
    }
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
    this.materialPinWorkspace.trim(0);
    this.meshPinWorkspace.trim(0);
    this.pendingMeshes.clear();
    this.pendingMaterials.clear();
    this.pendingMaterialRoots.clear();
    this.meshes = new MeshFrame();
    this.materialFrame = undefined;
    this.records.reset();
    attempt(() => this.inputs.dispose());
    for (const table of Object.values(this.tables)) attempt(() => this.retireTable(table));
    if (!this.cpuBusy) this.releaseCpuTables();
    if (this.tableRetirementFailure !== undefined) {
      if (failure === undefined) failure = this.tableRetirementFailure;
      else failure.errors.push(this.tableRetirementFailure);
    }
    if (failure !== undefined) {
      this.disposalFailure = failure;
      throw failure;
    }
    if (this.inputs.lifetimeFailure !== undefined) throw this.inputs.lifetimeFailure;
  }

  private writeSlot(
    record: RenderSceneSlot,
    resetPrevious: boolean,
    writes: GpuSceneWrites,
    temporal?: GpuSceneTemporalSnapshot,
  ): void {
    const allocation = this.allocations.get(record.slot);
    if (allocation === undefined) throw new RangeError('GPU Scene allocation unavailable');
    this.rowScratch.fill(0);
    const temporalFlags = primitiveTemporalFlags(resetPrevious, temporal);
    encodeScenePrimitive(
      this.rowScratchView,
      record,
      slotContent(record),
      {
        transformStart: allocation.transformStart,
        instanceStart: allocation.instanceStart,
        instanceCount: allocation.instanceCount,
        materialSlot: this.rowMaterialSlot(record, allocation.materialRanges[0]),
        sharedGeometry: allocation.mesh !== undefined,
      },
      temporalFlags,
    );

    if (this.writeRow('primitive', allocation.recordIndex, this.rowScratch) || resetPrevious)
      writes.primitive.add(allocation.recordIndex);

    const instance = this.instanceView;
    const instances = slotContent(record).instances;
    const previousInstances = temporal?.previousInstances;
    const previousOrdinals = previousInstanceOrdinals(instances, temporal);
    const currentGenerations = instances?.generations;
    const residentGenerations = this.instanceResidents.get(record.slot)?.generations;
    const morphRow = this.writeMorphRow(record);
    for (let ordinal = 0; ordinal < allocation.instanceCount; ordinal += 1) {
      const instanceIndex = allocation.instanceStart + ordinal;
      const instanceOffset = instanceIndex * INSTANCE.stride;
      const transformIndex =
        allocation.instanceTransformCount === 0 ? 0 : allocation.instanceTransformStart + ordinal;
      const metadataChanged = encodeSceneInstance(
        instance,
        instanceOffset,
        allocation.recordIndex,
        transformIndex,
        morphRow,
        PRIMITIVE_ACTIVE,
      );
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
          previousInstanceOrdinal(previousOrdinals, currentGenerations?.[ordinal], ordinal),
          previousInstances,
          writes,
        );
      }
      if (metadataChanged || resetPrevious) writes.instance.add(instanceIndex);
    }

    this.rememberInstanceResident(record.slot, instances);

    this.writeRootTransform(record, resetPrevious, writes);
    // Pulses hold only while the root row carries this frame's stamp.
    if (temporalFlags !== 0) this.stampTransform(allocation.transformStart, writes);

    this.writeMaterialSlot(record, writes, resetPrevious);
  }

  /**
   * The logical material slot of the row's first effective material. Shared
   * frame materials are acquired before slots are written, so the slot is
   * resident whenever the row's binding is.
   */
  private rowMaterialSlot(record: RenderSceneSlot, range: MaterialAllocation | undefined): number {
    if (range !== undefined) return range.logicalSlot;
    const source = slotContent(record);
    const mesh = source.assetHandle === undefined ? undefined : this.meshes.get(source.assetHandle);
    const material =
      mesh === undefined
        ? source.material
        : effectiveMeshMaterials(source, mesh, meshMaterialGeometry(source)).material;
    return this.sharedMaterials.get(material)?.logicalSlot ?? 0xffffffff;
  }

  /** Compare against the resident CPU bytes; pending upload rows survive failure. */
  private writeRow(table: GpuSceneTableName, index: number, row: Uint8Array): boolean {
    const stride = TABLE_LAYOUTS[table].stride;
    const destination = this.tableBytes[table];
    const start = index * stride;
    if (start < 0 || start + stride > destination.byteLength)
      throw new RangeError('GPU Scene row lies outside its CPU table');
    let changed = false;
    for (let byte = 0; byte < stride; byte += 1) {
      const value = row[byte] ?? 0;
      if (destination[start + byte] === value) continue;
      destination[start + byte] = value;
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

  private writeMaterialSlot(record: RenderSceneSlot, writes: GpuSceneWrites, reset: boolean): void {
    const ranges = this.allocations.materialRanges(record.slot);
    if (ranges === undefined) throw new RangeError('GPU Scene allocation unavailable');
    for (let ordinal = 0; ordinal < ranges.length; ordinal += 1) {
      const range = ranges[ordinal];
      if (range === undefined) throw new RangeError('material range unavailable');
      this.writeMaterial(range.version, writes, reset && !range.version.initialized);
    }
  }

  private writeMaterial(range: MaterialVersion, writes: GpuSceneWrites, reset: boolean): void {
    if (this.pendingMaterials.has(range)) return;
    // Shared descriptors never consume primitive/instance/transform rows.
    if (!Number.isSafeInteger(range.start) || range.start < 0 || range.start > 0xffffffff)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'material payload address fits u32',
        hint: 'retain a checked material range before encoding its shared descriptor',
      });
    const snapshot = range.snapshot;
    const schema = this.materialProgramSchema(snapshot);
    encodeMaterialSceneDescriptor(this.rowScratchView, range.start, snapshot);
    this.inputs.arena.writeDescriptor(
      range.descriptor,
      this.rowScratchView,
      GPU_MATERIAL_DESCRIPTOR.words,
    );
    this.packedMaterialRows ??= new Map();
    const materialRows = this.packedMaterialRows;
    let row = materialRows.get(snapshot);
    if (row === undefined) {
      row =
        schema === undefined
          ? packStandardPbrMaterialRow(STANDARD_PBR_RECEIPT, snapshot)
          : packMaterialProgramRow(schema, snapshot, Math.max(16, derive(schema).totalBytes));
      row ??= new Uint8Array(range.count * MATERIAL.stride);
      materialRows.set(snapshot, row);
    }
    if (row.byteLength !== range.count * MATERIAL.stride)
      throw new RangeError('material payload differs from its retained allocation');
    if (this.materialProgramSchema(snapshot) !== schema)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'the same material program schema through payload encoding',
        hint: 'retain fixed compiler and material inputs until encoding completes',
      });
    range.schema = schema;
    const destination = this.tableBytes.material;
    const start = range.start * MATERIAL.stride;
    if (start < 0 || start + row.byteLength > destination.byteLength)
      throw new RangeError('GPU Scene material lies outside its CPU table');
    if (reset || !range.initialized) {
      destination.set(row, start);
      writes.material.addRange(range.start, range.start + range.count);
    } else {
      for (let unit = 0; unit < range.count; unit++) {
        const end = (unit + 1) * MATERIAL.stride;
        for (let byte = end - MATERIAL.stride; byte < end; byte++) {
          if (destination[start + byte] !== row[byte]) {
            writes.material.add(range.start + unit);
            break;
          }
        }
      }
      destination.set(row, start);
    }
    range.initialized = false;
    this.pendingMaterials.add(range);
  }

  /** Consume changed instance fields independently of root or material changes. */
  private writeInstanceTransforms(
    record: RenderSceneSlot,
    writes: GpuSceneWrites,
    temporal?: GpuSceneTemporalSnapshot,
  ): void {
    const count = this.allocations.instanceTransformCount(record.slot);
    const start = this.allocations.instanceTransformStart(record.slot);
    const instances = slotContent(record).instances;
    if (count === undefined || start === undefined || instances === undefined) {
      throw new RangeError('GPU Scene instance update has no explicit allocation');
    }
    if (count !== instances.instanceCount) {
      throw new RangeError('GPU Scene instance update changed instance count');
    }
    const previousOrdinals = previousInstanceOrdinals(instances, temporal);
    const previousInstances = temporal?.previousInstances;
    const currentGenerations = instances.generations;
    // Rows outside the dirty ranges already mirror revision r - 1 == r and
    // keep their identity, so the full scan below would skip them anyway.
    const resident = this.instanceResidents.get(record.slot);
    const residentGenerations = resident?.generations;
    const rowRanges =
      resident !== undefined &&
      instances.dirtyRanges !== undefined &&
      instances.collectionId !== undefined &&
      instances.collectionId === resident.collectionId &&
      resident.revision !== undefined &&
      instances.revision === resident.revision + 1 &&
      residentGenerations === currentGenerations
        ? instances.dirtyRanges
        : undefined;
    for (let range = 0; range < (rowRanges?.length ?? 1); range++) {
      const rows = rowRanges?.[range];
      const first = rows?.start ?? 0;
      const end = Math.min(rows?.end ?? count, count);
      this.instanceRowsVisited += Math.max(0, end - first);
      for (let ordinal = first; ordinal < end; ordinal += 1) {
        this.writeInstanceTransform(
          start + ordinal,
          instances.transforms,
          ordinal * 16,
          instanceIdentityChanged(residentGenerations, currentGenerations, ordinal),
          previousInstanceOrdinal(previousOrdinals, currentGenerations?.[ordinal], ordinal),
          previousInstances,
          writes,
        );
      }
    }
    this.rememberInstanceResident(record.slot, instances);
  }

  private rememberInstanceResident(
    slot: number,
    instances: RenderableSnapshot['instances'],
    prepared = false,
  ): void {
    if (instances === undefined || instances.instanceCount === 0) {
      this.instanceResidents.delete(slot);
      return;
    }
    let resident = this.instanceResidents.get(slot);
    if (resident === undefined) {
      resident = {
        collectionId: undefined,
        revision: undefined,
        generations: undefined,
        observedSync: 0,
      };
      this.instanceResidents.set(slot, resident);
    }
    // Snapshot generation columns are immutable; retaining the reference lets
    // the next revision prove an unchanged identity set in O(1).
    resident.collectionId = instances.collectionId;
    resident.revision = instances.revision;
    if (prepared) resident.observedSync = this.syncRevisionValue;
    resident.generations =
      instances.generations?.length === instances.instanceCount ? instances.generations : undefined;
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
    writes: GpuSceneWrites,
  ): void {
    const at = index * TRANSFORM.stride + TRANSFORM_CURRENT;
    if (reset) writeMat4(this.transformView, at, local, sourceOffset);
    else if (!writeChangedMat4(this.transformView, at, local, sourceOffset)) return;
    if (previousOrdinal !== undefined && previousInstances !== undefined)
      this.writePrevious(index, previousInstances.transforms, previousOrdinal * 16, writes);
    else this.seedPrevious(index, writes);
    this.instanceUploads.add(index);
  }

  private writeRootTransform(
    record: RenderSceneSlot,
    resetPrevious: boolean,
    writes: GpuSceneWrites,
  ): void {
    this.writeRootPose(
      record.slot,
      slotPoseColumn(record),
      slotPoseOffset(record),
      resetPrevious,
      writes,
    );
  }

  private writeRootPose(
    slot: number,
    world: Float32Array,
    offset: number,
    resetPrevious: boolean,
    writes: GpuSceneWrites,
  ): void {
    const index = this.allocations.transformStart(slot);
    if (index === undefined) throw new RangeError('GPU Scene allocation unavailable');
    if (resetPrevious) {
      encodeResetSceneTransform(
        this.transformView,
        index * TRANSFORM.stride,
        index,
        world,
        offset,
        this.frameStamp,
      );
      writes.transform.add(index);
    } else this.writeTransform(index, world, offset, writes);
  }

  /**
   * Publish one row's morph weights beside its Mesh's shared target deltas and
   * return the descriptor its instance rows name; 0 is no morph. The arena
   * uploads only changed words, so a weight edit is one row-sized write.
   */
  private writeMorphRow(record: RenderSceneSlot): number {
    const content = slotContent(record);
    const morph = content.morph;
    const deltas = morph === undefined ? undefined : this.meshes.get(content.assetHandle)?.morph;
    let row = this.morphRows.get(record.slot);
    if (row !== undefined && (deltas === undefined || row.deltas !== deltas)) {
      this.releaseMorphRow(record.slot, row);
      row = undefined;
    }
    if (morph === undefined || deltas === undefined || morph.targetCount !== deltas.targetCount)
      return 0;
    const words = MORPH_ROW_HEADER_WORDS + deltas.targetCount;
    const initial = row === undefined;
    if (row === undefined) {
      row = {
        descriptor: this.inputs.arena.allocateDescriptor(words),
        words,
        handle: content.assetHandle as number,
        deltas,
      };
      this.acquireMorphDeltas(deltas);
      this.morphRows.set(record.slot, row);
    }
    if (this.morphScratch.byteLength < words * 4)
      this.morphScratch = new DataView(new ArrayBuffer(words * 8));
    const scratch = this.morphScratch;
    // Existing rows retain their immutable Mesh header; only weights change.
    if (initial) this.writeMorphHeader(scratch, deltas);
    const firstWeight = initial ? MORPH_ROW_HEADER_WORDS : 0;
    for (let target = 0; target < deltas.targetCount; target++)
      scratch.setFloat32((firstWeight + target) * 4, morph.weights[target] ?? 0, true);
    this.inputs.arena.writeDescriptor(
      row.descriptor,
      scratch,
      words,
      initial ? 0 : MORPH_ROW_HEADER_WORDS,
    );
    return row.descriptor;
  }

  private writeMorphHeader(scratch: DataView, deltas: MeshMorphDeltas): void {
    scratch.setUint32(0, deltas.vertexCount, true);
    scratch.setUint32(4, deltas.targetCount, true);
    scratch.setUint32(8, (this.morphDeltas.get(deltas) as MorphDeltaAllocation).descriptor, true);
    scratch.setUint32(12, deltas.channels, true);
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
      if (row.handle !== geometry.handle) continue;
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

  private clearSlot(slot: number, writes: GpuSceneWrites): void {
    const morphRow = this.morphRows.get(slot);
    if (morphRow !== undefined) this.releaseMorphRow(slot, morphRow);
    const allocation = this.allocations.get(slot);
    if (allocation === undefined) return;
    this.instanceResidents.delete(slot);
    this.clearAllocation(allocation, writes);
    this.releaseRanges(allocation.materialRanges);
    this.allocations.delete(slot);
    this.allocationRevisionValue += 1;
  }

  private uploadRows(
    rows: GpuSceneWrites,
  ): Result<{ readonly ranges: number; readonly bytes: number }, RhiError> {
    let rangeCount = 0;
    let bytes = 0;
    for (const name of TABLE_NAMES) {
      const changes = rows[name];
      const stride = TABLE_LAYOUTS[name].stride;
      let first = changes.next(0);
      while (first >= 0) {
        const end = changes.end(first);
        const write = writeGpuSceneTable(
          this.device,
          this.tables[name],
          this.tableBytes[name].buffer,
          first * stride,
          (end - first) * stride,
        );
        if (!write.ok) return write;
        if (this.disposed) return this.cpuUpdateUnavailable();
        this.followTableReduction(name, first * stride, (end - first) * stride);
        if (this.disposed) return this.cpuUpdateUnavailable();
        rangeCount++;
        bytes += write.value;
        first = changes.next(end);
      }
    }
    this.uploadRanges += rangeCount;
    this.uploadBytes += bytes;
    return ok({ ranges: rangeCount, bytes });
  }

  /**
   * Bind `record` to rows; returns true when only its instance count changed
   * and the rows were resized in place (same addresses, same stamp).
   */
  private ensureAllocation(record: RenderSceneSlot, writes: GpuSceneWrites): boolean {
    // A present Instances component is authoritative even when its array is
    // empty: preserve zero so neither the GPU Scene nor the indirect topology
    // turns it into a synthetic identity instance. Entities without the
    // component retain the ordinary one-instance identity path.
    const content = slotContent(record);
    const explicitInstances = content.instances;
    const instanceCount =
      explicitInstances === undefined
        ? 1
        : Math.max(0, Math.floor(explicitInstances.instanceCount));
    const instanceTransformCount = explicitInstances === undefined ? 0 : instanceCount;
    const materialCount =
      this.materialFrame === undefined ? Math.max(1, content.materials.length) : 0;
    const geometry =
      content.morph !== undefined ||
      content.terrainSection !== undefined ||
      content.pointsLines !== undefined
        ? undefined
        : this.meshes.get(content.assetHandle);
    const geometryKey = geometry?.handle;
    const existing = this.allocations.get(record.slot);
    const reuse =
      existing === undefined
        ? undefined
        : this.reuseAllocation(
            record,
            existing,
            geometryKey,
            materialCount,
            instanceCount,
            instanceTransformCount,
            writes,
          );
    if (reuse !== undefined) return reuse;
    // A slot whose count changed is a dynamic collection: reserve headroom so
    // its next changes resize in place. First allocations stay exact.
    const instanceCapacity =
      existing !== undefined &&
      explicitInstances !== undefined &&
      existing.instanceCount !== instanceCount
        ? dynamicCapacity(instanceCount)
        : instanceCount;
    const mesh = geometry === undefined ? undefined : this.acquireMesh(geometry);
    const recordIndex = existing?.recordIndex ?? this.records.allocate(1);
    // Hold reused identities before releasing this binding, but let retired
    // versions free their ranges before a genuinely new material allocates.
    // Prepared/submitted frame holders independently keep their versions live.
    const ranges = materialCount === 0 ? undefined : new Array<MaterialAllocation>(materialCount);
    if (existing !== undefined) {
      if (ranges !== undefined) {
        for (let index = 0; index < materialCount; index++) {
          const resource = content.materials[index] ?? content.material;
          if (this.sharedMaterials.has(resource))
            ranges[index] = this.acquireMaterial(resource, writes);
        }
      }
      this.clearAllocationRanges(existing, writes);
      this.releaseRanges(existing.materialRanges);
    }
    if (ranges !== undefined) {
      for (let index = 0; index < materialCount; index++)
        ranges[index] ??= this.acquireMaterial(
          content.materials[index] ?? content.material,
          writes,
        );
    }
    const materialRanges = ranges === undefined ? NO_MATERIAL_RANGES : this.internRanges(ranges);
    const allocation = {
      mesh,
      // Member nodes name this live slot's physical record. Resizing its
      // variable inputs must not invalidate every retained member root.
      recordIndex,
      instanceStart: this.instances.allocate(instanceCapacity),
      instanceCount,
      transformStart: this.transforms.allocate(1),
      instanceTransformStart:
        explicitInstances === undefined || instanceCapacity === 0
          ? 0
          : this.transforms.allocate(instanceCapacity),
      instanceTransformCount,
      instanceCapacity,
      materialRanges,
    };
    this.allocations.set(record.slot, allocation);
    this.allocationRevisionValue += 1;
    return false;
  }

  /**
   * Keep `existing` when `record` still binds the same mesh and materials:
   * false when nothing changed, true when only an explicit instance count
   * changed within the reservation (rows resized in place), undefined when
   * the slot needs new rows.
   */
  private reuseAllocation(
    record: RenderSceneSlot,
    existing: PrimitiveAllocation,
    geometryKey: number | undefined,
    materialCount: number,
    instanceCount: number,
    instanceTransformCount: number,
    writes: GpuSceneWrites,
  ): boolean | undefined {
    const { materials, material, instances } = slotContent(record);
    if (existing.mesh?.key !== geometryKey || existing.materialRanges.length !== materialCount)
      return undefined;
    for (let index = 0; index < materialCount; index++)
      if (existing.materialRanges[index]?.resource !== (materials[index] ?? material))
        return undefined;
    const unchanged =
      existing.instanceCount === instanceCount &&
      existing.instanceTransformCount === instanceTransformCount;
    // An explicit collection that only changed its count keeps its rows when
    // the new count fits the reserved capacity: no clear, no new addresses, no
    // full reset. Rows past the count become unreferenced and keep their bytes.
    const resizable =
      instances !== undefined &&
      existing.instanceTransformCount === existing.instanceCount &&
      instanceCount <= existing.instanceCapacity &&
      !shouldShrinkCapacity(instanceCount, existing.instanceCapacity);
    if (!unchanged && !resizable) return undefined;
    for (const range of existing.materialRanges) this.adoptMaterial(range, writes);
    if (unchanged) return false;
    this.allocations.resizeInstances(record.slot, instanceCount, instanceTransformCount);
    this.allocationRevisionValue += 1;
    return true;
  }

  private internRanges(ranges: MaterialAllocation[]): readonly MaterialAllocation[] {
    let key = '';
    for (const range of ranges) key += `${getOpaqueResourceIdentity(range)},`;
    let shared = this.rangeLists.get(key);
    if (shared === undefined) {
      shared = { ranges: Object.freeze(ranges), holders: 0 };
      this.rangeLists.set(key, shared);
    }
    shared.holders++;
    return shared.ranges;
  }

  private releaseRanges(ranges: readonly MaterialAllocation[]): void {
    if (ranges === NO_MATERIAL_RANGES) return;
    let key = '';
    for (const range of ranges) key += `${getOpaqueResourceIdentity(range)},`;
    const shared = this.rangeLists.get(key);
    if (shared?.ranges === ranges && --shared.holders === 0) this.rangeLists.delete(key);
  }

  private acquireMesh(geometry: MeshGeometry): MeshAllocation {
    const key = geometry.handle;
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

  private releaseMaterial(range: MaterialAllocation, writes: GpuSceneWrites): void {
    if (--range.holders !== 0) return;
    this.pendingMaterialRoots.delete(range);
    this.sharedMaterials.delete(range.resource);
    this.materialPinWorkspace.trim(this.sharedMaterials.size);
    this.inputs.releaseResource(range.logicalSlot);
    this.releaseMaterialVersion(range.version, writes);
  }

  geometryIndexForResource(handle: number): number | undefined {
    return this.sharedMeshes.get(handle)?.version.descriptor;
  }

  private releaseMeshVersion(version: MeshVersion): void {
    if (--version.references !== 0) return;
    this.pendingMeshes.delete(version);
    this.inputs.arena.releaseDescriptor(version.descriptor, version.words);
  }

  private releaseMeshAllocation(mesh: MeshAllocation): void {
    if (--mesh.holders !== 0) return;
    this.sharedMeshes.delete(mesh.key);
    this.meshPinWorkspace.trim(this.sharedMeshes.size);
    this.inputs.releaseResource(mesh.logicalSlot);
    this.releaseMeshVersion(mesh.version);
  }

  private acquireMaterial(resource: MaterialResource, writes: GpuSceneWrites): MaterialAllocation {
    const existing = this.sharedMaterials.get(resource);
    if (existing !== undefined) {
      this.adoptMaterial(existing, writes);
      existing.holders++;
      return existing;
    }
    const snapshot = this.materialFrame?.get(resource)?.snapshot ?? resource.snapshot;
    const version = this.allocateMaterialVersion(snapshot, this.materialUnits(snapshot));
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
        schema: undefined,
      };
    } catch (cause) {
      this.materials.release(start, count);
      throw cause;
    }
  }

  private adoptMaterial(allocation: MaterialAllocation, writes: GpuSceneWrites): void {
    const previous = allocation.version;
    const snapshot =
      this.materialFrame?.get(allocation.resource)?.snapshot ?? allocation.resource.snapshot;
    if (previous.snapshot === snapshot) return;
    this.pendingMaterials.delete(previous);
    const count = this.materialUnits(snapshot);
    if (previous.references === 1) {
      this.resizeMaterial(previous, count, writes);
      allocation.version = { ...previous, snapshot };
      previous.references = 0;
    } else {
      allocation.version = this.allocateMaterialVersion(snapshot, count);
      this.releaseMaterialVersion(previous, writes);
    }
    this.inputs.updateResource(allocation.logicalSlot, allocation.version.descriptor);
  }

  private releaseMaterialVersion(version: MaterialVersion, writes: GpuSceneWrites): void {
    if (--version.references !== 0) return;
    this.pendingMaterials.delete(version);
    this.inputs.arena.releaseDescriptor(version.descriptor, GPU_MATERIAL_DESCRIPTOR.words);
    this.clearMaterialRows(version, writes);
  }

  private clearMaterialRows(version: MaterialVersion, writes: GpuSceneWrites): void {
    const start = Math.min(version.start * MATERIAL.stride, this.tableBytes.material.byteLength);
    const end = Math.min(
      (version.start + version.count) * MATERIAL.stride,
      this.tableBytes.material.byteLength,
    );
    this.tableBytes.material.fill(0, start, end);
    writes.material.addRange(start / MATERIAL.stride, end / MATERIAL.stride);
    this.tableRowsReleased = true;
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

  private resizeMaterial(range: MaterialVersion, count: number, writes: GpuSceneWrites): void {
    if (range.count === count) return;
    this.clearMaterialRows(range, writes);
    const start = this.materials.allocate(count, count);
    range.start = start;
    range.count = count;
    range.initialized = false;
  }

  private clearRecord(index: number, writes: GpuSceneWrites): void {
    if (index < this.capacity) {
      this.tableBytes.primitive.fill(0, index * PRIMITIVE.stride, (index + 1) * PRIMITIVE.stride);
      writes.primitive.add(index);
    }
    this.records.release(index, 1);
  }

  private clearAllocation(allocation: PrimitiveAllocation, writes: GpuSceneWrites): void {
    this.clearRecord(allocation.recordIndex, writes);
    this.clearAllocationRanges(allocation, writes);
  }

  private clearAllocationRanges(allocation: PrimitiveAllocation, writes: GpuSceneWrites): void {
    const mesh = allocation.mesh;
    if (mesh !== undefined) this.releaseMeshAllocation(mesh);
    // Clear every reserved row, including unreferenced capacity past the count:
    // a later owner of these addresses must start from zeroed rows.
    const instanceRows = allocation.instanceCapacity;
    // Explicit collections own one transform row per reserved instance row.
    const transformRows =
      allocation.instanceTransformCount === allocation.instanceCount
        ? allocation.instanceCapacity
        : 0;
    clearRows(
      this.tableBytes.instance,
      INSTANCE.stride,
      allocation.instanceStart,
      instanceRows,
      writes.instance,
    );
    clearRows(
      this.transformBytes,
      TRANSFORM.stride,
      allocation.transformStart,
      1,
      writes.transform,
    );
    clearRows(
      this.transformBytes,
      TRANSFORM.stride,
      allocation.instanceTransformStart,
      transformRows,
      writes.transform,
    );
    for (const range of allocation.materialRanges) this.releaseMaterial(range, writes);
    this.tableRowsReleased = true;
    this.retiredTransformRows += transformRows + 1;
    if (this.retiredTransformRows >= Math.max(512, this.transformCapacity / 4)) {
      this.previousRows.sourceReleased();
      this.retiredTransformRows = 0;
    }
    this.instances.release(allocation.instanceStart, instanceRows);
    this.transforms.release(allocation.transformStart, 1);
    this.transforms.release(allocation.instanceTransformStart, transformRows);
  }

  private tableRetirementFailed(table: GpuSceneTableStorage, cause: unknown): void {
    this.retiredTableStates.set(table, 'failed');
    this.retiredTables.add(table);
    if (this.tableRetirementFailure === undefined)
      this.tableRetirementFailure = new AggregateError(
        [{ table, cause }],
        'GPU table retirement remains unconfirmed',
      );
    else this.tableRetirementFailure.errors.push({ table, cause });
    this.failure ??= Object.assign(
      new RhiError({
        code: 'internal-error',
        expected: 'confirmed GPU table retirement',
        hint: 'retain the exact failed allocation and rebuild this owner',
      }),
      { cause: this.tableRetirementFailure },
    );
  }

  private destroyRetiredTable(table: GpuSceneTableStorage): void {
    const state = this.retiredTableStates.get(table);
    if (state === 'destroying' || state === 'released' || state === 'failed') return;
    if (this.tableIsHeld(table)) {
      this.retiredTableStates.set(table, 'waiting');
      return;
    }
    this.retiredTableStates.set(table, 'destroying');
    try {
      destroyGpuSceneTable(this.device, table);
    } catch (cause) {
      this.tableRetirementFailed(table, cause);
      return;
    }
    this.retiredTableStates.set(table, 'released');
    this.retiredTables.delete(table);
  }

  private retireTable(table: GpuSceneTableStorage): void {
    const state = this.retiredTableStates.get(table);
    if (state !== undefined && state !== 'waiting') return;
    this.retiredTables.add(table);
    this.retiredTableStates.set(table, 'waiting');
    if (this.tableIsHeld(table)) return;
    if (this.disposed) {
      this.destroyRetiredTable(table);
      return;
    }
    this.retiredTableStates.set(table, 'fencing');
    try {
      void this.device.queue.onSubmittedWorkDone().then(
        () => this.destroyRetiredTable(table),
        (cause) => this.tableRetirementFailed(table, cause),
      );
    } catch (cause) {
      this.tableRetirementFailed(table, cause);
    }
  }

  private discardPrivateTables(tables: Iterable<GpuSceneTableStorage>): void {
    for (const table of tables) {
      this.retiredTables.add(table);
      this.destroyRetiredTable(table);
    }
    if (this.tableRetirementFailure !== undefined) throw this.tableRetirementFailure;
  }

  private abandonTableReduction(): void {
    const pending = this.reduction;
    if (pending === undefined) return;
    this.reduction = undefined;
    pending.task.abandon((table) => this.retireTable(table));
  }

  private failedTableReduction(): void {
    this.reductionFailures++;
    this.abandonTableReduction();
    this.reviewCapacity = true;
    this.smallSubmissions = -48;
  }

  private followTableReduction(name: GpuSceneTableName, offset: number, bytes: number): void {
    const pending = this.reduction;
    if (pending === undefined || pending.baseline !== this.tables || this.disposed) return;
    try {
      if (pending.task.followSubmitted(name, offset, bytes).ok) return;
    } catch {
      // The live write already succeeded. Its private copy can be retired and retried.
    }
    this.failedTableReduction();
  }

  /** Give private Source publication priority. Held submitted draws keep their original tables. */
  private reduceSubmittedTables(): void {
    if (!this.reviewCapacity && this.reduction === undefined) return;
    if (this.disposed || TABLE_NAMES.some((name) => !this.writesByTable[name].empty)) return;
    for (const scope of this.capacityPreparations.values()) {
      if (!scope.published) {
        this.abandonTableReduction();
        return;
      }
    }
    let pending = this.reduction;
    if (
      pending !== undefined &&
      (pending.baseline !== this.tables ||
        Math.max(this.records.requiredCapacity(), this.instances.requiredCapacity()) >
          pending.rows ||
        this.transforms.requiredCapacity() > pending.transforms ||
        this.materials.requiredCapacity() > pending.materials)
    ) {
      this.abandonTableReduction();
      this.smallSubmissions = 0;
      pending = undefined;
    }
    if (pending === undefined) {
      this.reduction = pending = this.planTableReduction();
      if (pending === undefined) return;
    }
    // One allocation or 64 KiB of copy per successful submission. Concurrent writes
    // follow the copied prefix directly, so even a wholly moving view can finish.
    let state: ReturnType<GpuSceneCapacityPreparation['step']>;
    try {
      state = pending.task.step();
    } catch {
      this.failedTableReduction();
      return;
    }
    if (!state.ok) {
      this.failedTableReduction();
      return;
    }
    if (
      state.value.phase !== 'current' ||
      this.disposed ||
      TABLE_NAMES.some((name) => !this.writesByTable[name].empty)
    )
      return;
    this.publishTableReduction(pending);
  }

  private planTableReduction(): TableReduction | undefined {
    const rows = Math.max(this.records.allocatedEnd(), this.instances.allocatedEnd());
    const transforms = this.transforms.allocatedEnd();
    const materials = this.materials.allocatedEnd();
    if (
      !shouldShrinkCapacity(rows, this.capacity) &&
      !shouldShrinkCapacity(transforms, this.transformCapacity) &&
      !shouldShrinkCapacity(materials, this.materialCapacity)
    ) {
      this.reviewCapacity = false;
      this.smallSubmissions = 0;
      return undefined;
    }
    if (++this.smallSubmissions < 16) return undefined;
    this.smallSubmissions = 0;
    this.records.releaseTail();
    this.instances.releaseTail();
    this.transforms.releaseTail();
    this.materials.releaseTail();
    const reduced = (extent: number, capacity: number) =>
      shouldShrinkCapacity(extent, capacity) ? Math.max(1, dynamicCapacity(extent)) : capacity;
    const rowLimit = reduced(rows, this.capacity);
    const transformLimit = reduced(transforms, this.transformCapacity);
    const materialLimit = reduced(materials, this.materialCapacity);
    const demands: CapacityTableDemand[] = [];
    for (const name of TABLE_NAMES) {
      const limit =
        name === 'transform' ? transformLimit : name === 'material' ? materialLimit : rowLimit;
      const stride = TABLE_LAYOUTS[name].stride;
      if (limit * stride < this.tableBytes[name].byteLength)
        demands.push({ name, stride, bytes: limit * stride });
    }
    const baseline = this.tables;
    const task = new GpuSceneCapacityPreparation(
      this.device,
      this.backend,
      demands,
      (name) => this.tableBytes[name],
      () => !this.disposed && this.tables === baseline,
      undefined,
    );
    return {
      baseline,
      rows: rowLimit,
      transforms: transformLimit,
      materials: materialLimit,
      task,
    };
  }

  private publishTableReduction(pending: TableReduction): void {
    const completed = pending.task.preparedTables();
    if (completed === undefined) return;
    const tables = { ...this.tables };
    const bytes = { ...this.tableBytes };
    for (const result of completed) {
      tables[result.name] = result.resource;
      bytes[result.name] = result.bytes;
    }
    if (!pending.task.transfer(() => this.tables === tables).ok) {
      this.failedTableReduction();
      return;
    }
    this.reduction = undefined;
    this.publishTables(tables);
    this.tableBytes = bytes;
    this.textureViews = textureTableViews(tables);
    this.capacity = pending.rows;
    this.transformCapacity = pending.transforms;
    this.materialCapacity = pending.materials;
    this.refreshCpuViews();
    this.reductions++;
    // Another table may have lost its tail since this copy started.
    this.reviewCapacity = true;
    for (const result of completed) this.retireTable(pending.baseline[result.name]);
  }

  private grow(
    requiredCapacity: number,
    requiredTransformCapacity: number,
    requiredMaterialCapacity: number,
  ): Result<void, RhiError> {
    const limit = gpuSceneTableByteLimit(this.device, this.backend);
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
    const nextResources = { ...this.tables };
    const nextTables = { ...this.tableBytes };
    const replacements: GpuSceneTableName[] = [];
    const privateTables: GpuSceneTableStorage[] = [];
    let uploadedBytes = 0;
    let published = false;
    try {
      for (const name of TABLE_NAMES) {
        const oldCapacity = this.tableBytes[name].byteLength / TABLE_LAYOUTS[name].stride;
        const newCapacity = next[name];
        if (oldCapacity === newCapacity) continue;
        const resource = createGpuSceneTable(
          this.device,
          this.backend,
          `gpu-scene-${name}-table`,
          newCapacity * TABLE_LAYOUTS[name].stride,
          (table) => privateTables.push(table),
        ).unwrap();
        nextResources[name] = resource;
        replacements.push(name);
        if (this.disposed) this.cpuUpdateUnavailable().unwrap();
        const bytes = new Uint8Array(newCapacity * TABLE_LAYOUTS[name].stride);
        bytes.set(this.tableBytes[name]);
        nextTables[name] = bytes;
        uploadedBytes += writeGpuSceneTable(
          this.device,
          resource,
          bytes.buffer,
          0,
          bytes.byteLength,
        ).unwrap();
        if (this.disposed) this.cpuUpdateUnavailable().unwrap();
      }
      for (const name of replacements) {
        if (this.disposed) break;
        this.retireTable(this.tables[name]);
      }
      if (this.disposed) this.cpuUpdateUnavailable().unwrap();
      if (this.failure !== undefined) throw this.failure;
      this.publishTables(nextResources);
      this.textureViews = textureTableViews(nextResources);
      published = true;
      this.tableBytes = nextTables;
      this.refreshCpuViews();
      this.capacity = next.primitive;
      this.transformCapacity = next.transform;
      this.materialCapacity = next.material;
      this.capacityGrows += 1;
      this.uploadRanges += replacements.length;
      this.uploadBytes += uploadedBytes;
      return ok(undefined);
    } catch (cause) {
      if (!published) {
        try {
          this.discardPrivateTables(privateTables);
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'GPU table growth and cleanup failed');
        }
      }
      if (cause instanceof RhiError) return err(cause);
      throw cause;
    }
  }

  private cpuUpdateUnavailable(): Result<never, RhiError> {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'a live GPU Scene with no synchronous CPU update in progress',
        hint: 'finish the current sync or frame commit before another CPU update; recreate a disposed Scene',
      }),
    );
  }

  /** No CPU table reader remains; GPU frames retain only their actual GPU resources. */
  private releaseCpuTables(): void {
    this.abandonTableReduction();
    this.previousRows.clear();
    for (const name of TABLE_NAMES) this.writesByTable[name].release();
    this.instanceUploads.release();
    this.instanceResidents.clear();
    this.contentBoxes.clear();
    this.tableBytes = EMPTY_CPU_TABLES;
    this.transformBytes = EMPTY_CPU_BYTES;
    this.transformView = this.primitiveView = this.instanceView = EMPTY_CPU_VIEW;
  }

  private allocateCpuTables(
    capacity: number,
    materialCapacity: number,
  ): Record<GpuSceneTableName, Uint8Array<ArrayBuffer>> {
    return {
      primitive: new Uint8Array(capacity * PRIMITIVE.stride),
      instance: new Uint8Array(capacity * INSTANCE.stride),
      transform: new Uint8Array(capacity * TRANSFORM.stride),
      material: new Uint8Array(materialCapacity * MATERIAL.stride),
    };
  }

  private refreshCpuViews(): void {
    if (this.transformView.buffer !== this.tableBytes.transform.buffer) {
      this.transformBytes = this.tableBytes.transform;
      this.transformView = new DataView(this.transformBytes.buffer);
    }
    if (this.primitiveView.buffer !== this.tableBytes.primitive.buffer)
      this.primitiveView = new DataView(this.tableBytes.primitive.buffer);
    if (this.instanceView.buffer !== this.tableBytes.instance.buffer)
      this.instanceView = new DataView(this.tableBytes.instance.buffer);
  }

  private writeIdentityTransform(): void {
    writeMat4(this.transformView, TRANSFORM_CURRENT, IDENTITY_MATRIX);
    // Row 0 also carries the frame stamp every stamped row is compared with.
    this.transformView.setUint32(TRANSFORM_STAMP, this.frameStamp, true);
  }
}

export { type GpuSceneTableTextures, growGpuSceneTableCapacity } from './gpu-scene-table-set';
