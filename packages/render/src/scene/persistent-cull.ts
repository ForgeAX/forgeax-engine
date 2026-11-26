import { box3, frustum } from '@forgeax/engine-math';
import { buildCameraFrusta } from '../camera-frusta';
import {
  assertRenderResidencySelection,
  type RenderResidencySelection,
  residencySelected,
} from '../gpu-driven/batch-residency';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type {
  CameraAdmission,
  DispatchEntry,
  DispatchList,
  ExtractedFrame,
  GpuOwnedFrame,
  RenderableSnapshot,
  ResidualCameraAdmission,
} from '../render-system-extract';
import { sameMaterialCullingBounds } from '../standard-displacement-bounds';
import { SubsurfaceSelection } from '../subsurface/selection';
import { CullProjection } from './cull-projection';
import { withRenderableIndex } from './dispatch-entry';
import type { FrameList } from './frame-list';
import { FrameSet } from './frame-set';
import {
  capturedDispatchAddresses,
  MaterialFrame,
  projectCapturedViewDispatch,
  writeCapturedCasterRanks,
} from './material-dispatch';
import { slotContent } from './mesh-draw';
import type { MeshFrame } from './mesh-frame';
import type { PersistentShadowCasterProjection } from './render-scene';
import { writeTransformedWorldBounds } from './render-scene-snapshots';
import type { RenderSceneSlot } from './render-scene-types';
import { sceneDrawContentOf } from './render-scene-view';
import { ResidualBoundsProof } from './residual-bounds-proof';
import type { RowContent } from './row-contents';
import type { SceneSlotFrame } from './scene-slots';
import { SelectedSceneDrawRows } from './selected-draw-rows';
import { buildShadowFrusta } from './shadow-visibility';
import type { SkinSceneFrame } from './skin-scene-inputs';

export interface ViewCullStorage {
  value: PersistentCullMemo | undefined;
  scratch?: CullProjection | undefined;
  casterWords?: Uint32Array | undefined;
  shadowFrusta?: frustum.Frustum[] | undefined;
  active?: boolean;
}

/** Last published row addresses and dispatch for this view. */
export interface PersistentCullMemo {
  readonly residencySelection: RenderResidencySelection | undefined;
  readonly meshes: MeshFrame | undefined;
  readonly sourceSubsurface: SubsurfaceSelection;
  readonly authorSubsurface: SubsurfaceSelection;
  readonly admittedSubsurface: SubsurfaceSelection;
  readonly sourceRenderables: FrameList<RenderableSnapshot>;
  readonly sourceOwner: object;
  readonly sourceRevision: number;
  readonly sourceDispatch: DispatchList;
  /** Source of each remapped output address, bounded by this view's emitted work. */
  readonly remappedSources?: DispatchEntry[];
  readonly projection: CullProjection;
  readonly rowCount: number;
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly dispatch: DispatchList;
  readonly nativeSlots?: SceneSlotFrame['identities'] | undefined;
  readonly members?: FrameSet | undefined;
}

interface PersistentCullResult {
  frame: ExtractedFrame;
  subsurface: PersistentShadowCasterProjection['content']['subsurface'];
}

function assertResidencyCurrent(selection: RenderResidencySelection | undefined): void {
  if (selection !== undefined) assertRenderResidencySelection(selection);
}

function activeResidencyRecord(
  record: RenderSceneSlot | undefined,
  selection: RenderResidencySelection | undefined,
): RenderSceneSlot | undefined {
  return record !== undefined && residencySelected(selection, slotContent(record).residencyGroup)
    ? record
    : undefined;
}

function snapshotWorldBounds(
  snapshot: RenderableSnapshot,
  _index: number,
  out: box3.Box3,
): boolean {
  return (
    snapshot.frustumCulled !== false &&
    writeTransformedWorldBounds(out, snapshot.localAabb, snapshot.transform.world)
  );
}

type SlotBoundsWriter = (row: RenderSceneSlot, out: box3.Box3) => boolean;

export function cullPersistentFrame(
  frame: ExtractedFrame,
  materials: MaterialFrame,
  boundsOf: (
    snapshot: RenderableSnapshot,
    index: number,
    out: box3.Box3,
  ) => boolean = snapshotWorldBounds,
  memo?: ViewCullStorage,
  gpuCulled?: (snapshot: RenderableSnapshot) => boolean,
  meshes?: MeshFrame,
  sourceOwner: object = frame.renderables,
  sourceRevision = 0,
  residencySelection?: RenderResidencySelection,
  boundsOfSlot?: SlotBoundsWriter,
): PersistentCullResult {
  assertResidencyCurrent(residencySelection);
  const rows = frame.renderables.length;
  const owner = memo?.active ? undefined : memo;
  const previous = owner?.value;
  let scratch = owner?.scratch;

  if (
    scratch === undefined ||
    scratch.capacity < rows ||
    (scratch.capacity > 16384 && scratch.capacity > rows * 4)
  )
    scratch = new CullProjection(Math.max(rows, Math.min(rows * 2, (scratch?.capacity ?? 0) * 2)));
  if (owner !== undefined) owner.active = true;
  try {
    return new PersistentFrameCull(
      frame,
      materials,
      boundsOf,
      owner,
      gpuCulled,
      meshes,
      sourceOwner,
      sourceRevision,
      residencySelection,
      scratch,
      boundsOfSlot,
    ).run();
  } finally {
    if (owner !== undefined) {
      owner.active = false;
      if ((owner.casterWords?.length ?? 0) > Math.max(512, Math.ceil(rows / 32) * 4))
        owner.casterWords = undefined;
      // The emitted frame owns renderables and dispatch. Only the cull owner reads addresses.
      const available = owner.value?.projection === scratch ? previous?.projection : scratch;
      owner.scratch =
        (available?.capacity ?? 0) > Math.max(16384, rows * 4) ? undefined : available;
    }
  }
}

/** One cull of a persistent frame: camera/shadow admission, then memoized projection. */
class PersistentFrameCull {
  private readonly previous: PersistentCullMemo | undefined;
  private readonly newSources: boolean;
  private readonly sourceSubsurface: SubsurfaceSelection;
  private authorSubsurface: SubsurfaceSelection;
  private clippedAuthorRow = false;
  // Shadow casters are not constrained by the display camera. Keep the
  // primary camera cull intact, but admit a caster that is outside every
  // camera frustum when its bounds intersect one of the active light-space
  // frusta. This is especially important for point-light cube faces: the
  // caster can be behind the camera while still occluding the receiver.
  private casterWords: Uint32Array | undefined;
  private shadowFrusta: ReturnType<typeof buildShadowFrusta> | undefined;
  private readonly visibility: FrameCameraVisibility;
  private readonly cameraPlanes: readonly Float32Array[];
  private readonly worldAabb = box3.create();
  private total = 0;
  private culled = 0;
  private visibleCount = 0;
  private hasHiddenSlots = false;
  private columns: ReturnType<typeof sceneDrawContentOf>;
  private shadowOnlyRows = false;
  private visible: RenderableSnapshot[] | undefined;

  constructor(
    private readonly frame: ExtractedFrame,
    private readonly materials: MaterialFrame,
    private readonly boundsOf: (
      snapshot: RenderableSnapshot,
      index: number,
      out: box3.Box3,
    ) => boolean,
    private readonly memo: ViewCullStorage | undefined,
    private readonly gpuCulled: ((snapshot: RenderableSnapshot) => boolean) | undefined,
    private readonly meshes: MeshFrame | undefined,
    private readonly sourceOwner: object,
    private readonly sourceRevision: number,
    private readonly residencySelection: RenderResidencySelection | undefined,
    private readonly projection: CullProjection,
    private readonly boundsOfSlot: SlotBoundsWriter | undefined,
  ) {
    const previous = memo?.value;
    this.previous = previous;
    this.newSources =
      previous?.sourceOwner !== sourceOwner ||
      previous?.sourceRevision !== sourceRevision ||
      previous?.residencySelection !== residencySelection ||
      previous?.meshes !== meshes;
    this.sourceSubsurface =
      this.newSources || previous === undefined
        ? new SubsurfaceSelection()
        : previous.sourceSubsurface;
    this.authorSubsurface =
      this.newSources || previous === undefined ? this.sourceSubsurface : previous.authorSubsurface;
    this.cameraPlanes = buildCameraFrusta(frame.cameras);
    this.visibility = new FrameCameraVisibility(residencySelection);
    this.projection.reset(frame.renderables.length);
  }

  run(): PersistentCullResult {
    const sequence = this.frame.renderables;
    const writeBounds = this.boundsOfSlot;
    const rows =
      writeBounds !== undefined && this.gpuCulled === undefined
        ? sceneDrawContentOf(sequence)
        : undefined;
    let index = 0;
    let admission: CameraAdmission | undefined;
    if (rows?.permitsSlotCull(this.residencySelection) && writeBounds !== undefined) {
      this.columns = rows;
      const slotAdmission = rows.source.length === rows.source.identities.size;
      for (const row of rows.source)
        this.projectSlot(rows, row, index++, writeBounds, slotAdmission);
      if (slotAdmission) {
        const hidden = this.hasHiddenSlots
          ? this.projection.slots(rows.source, true)
          : new FrameSet();
        if (this.visibility.acceptSlots(rows.source.identities, hidden))
          admission = { sceneOwner: this.sourceOwner, residency: this.residencySelection, hidden };
      }
    } else {
      for (const candidate of sequence) {
        if (candidate !== undefined) this.projectCandidate(candidate, index);
        index++;
      }
    }
    // Scratch belongs to this cull owner and never escapes into a published frame.
    if (this.memo !== undefined) this.memo.shadowFrusta = this.shadowFrusta;
    const frustumStats = this.visibility.frustumStats(this.culled, this.total);
    const materials = this.materials;
    this.sourceSubsurface.adopt(materials);
    this.authorSubsurface.adopt(materials);
    const previous = this.previous;
    // Dispatch addresses depend only on the projection, not on row snapshots.
    const equalRanks = this.projection.finish(
      sequence.length,
      previous?.rowCount === sequence.length ? previous.projection : undefined,
    );
    const sameAddresses =
      previous !== undefined && equalRanks && previous.renderables.length === this.visibleCount;
    const columns = this.columns;
    const sameVisibility =
      sameAddresses &&
      (columns === undefined
        ? this.visible === undefined && previous.nativeSlots === undefined
        : previous.nativeSlots === columns.source.identities &&
          previous.sourceRenderables === sequence);
    let members: FrameSet | undefined;
    let selected: FrameList<RenderableSnapshot>;
    if (columns === undefined) {
      selected = sameVisibility
        ? previous.renderables
        : (this.visible ?? previous?.renderables.slice(0, this.visibleCount) ?? []);
    } else if (this.visibleCount === sequence.length) {
      selected = sequence;
    } else {
      members =
        sameAddresses && previous.nativeSlots === columns.source.identities
          ? previous.members
          : undefined;
      members ??= this.projection.slots(columns.source, false);
      selected = sameVisibility
        ? previous.renderables
        : new SelectedSceneDrawRows(
            columns,
            members,
            sameAddresses &&
              previous.sourceDispatch === this.frame.dispatch &&
              previous.members === members &&
              previous.renderables instanceof SelectedSceneDrawRows
              ? previous.renderables.dispatchDomain
              : undefined,
          );
    }
    // A subset of an authored set with zero profiles and no errors has zero demand.
    // If a material later activates scattering, intersect the current visibility even
    // when the addresses are identical to the last frame that had no demand.
    let admittedSubsurface = this.authorSubsurface;
    if (this.clippedAuthorRow && this.authorSubsurface.demand !== 0) {
      if (
        sameVisibility &&
        !this.newSources &&
        previous.admittedSubsurface !== previous.authorSubsurface
      ) {
        admittedSubsurface = previous.admittedSubsurface;
      } else {
        admittedSubsurface = new SubsurfaceSelection();
        if (columns !== undefined)
          columns.findDrawContent(
            true,
            (_entity, content) => {
              admittedSubsurface.add(content, materials, this.meshes);
              return undefined;
            },
            members,
          );
        else for (const source of selected) admittedSubsurface.add(source, materials, this.meshes);
      }
      admittedSubsurface.adopt(materials);
    }
    const sourceDispatch = this.frame.dispatch;
    const passProjection =
      columns !== undefined &&
      selected === sequence &&
      !this.shadowOnlyRows &&
      capturedDispatchAddresses(sourceDispatch, columns.source)
        ? { dispatch: sourceDispatch, remappedSources: undefined }
        : sameAddresses && previous.sourceDispatch === sourceDispatch
          ? previous
          : this.remapDispatch(
              selected instanceof SelectedSceneDrawRows &&
                columns !== undefined &&
                capturedDispatchAddresses(sourceDispatch, columns.source)
                ? selected.dispatchDomain
                : undefined,
            );
    if (this.memo !== undefined) {
      this.memo.value = {
        meshes: this.meshes,
        sourceSubsurface: this.sourceSubsurface,
        authorSubsurface: this.authorSubsurface,
        admittedSubsurface,
        sourceRenderables: sequence,
        sourceOwner: this.sourceOwner,
        sourceRevision: this.sourceRevision,
        residencySelection: this.residencySelection,
        sourceDispatch,
        ...(passProjection.remappedSources === undefined
          ? {}
          : { remappedSources: passProjection.remappedSources }),
        projection: sameAddresses ? previous.projection : this.projection,
        rowCount: sequence.length,
        renderables: selected,
        dispatch: passProjection.dispatch,
        nativeSlots: columns?.source.identities,
        members,
      };
    }
    return this.result(
      {
        ...this.frame,
        renderables: selected,
        dispatch: passProjection.dispatch,
        frustumStats,
        cameraVisible: this.visibility.cameraVisible,
        cameraAdmission: admission,
      },
      admittedSubsurface,
    );
  }

  private projectSlot(
    rows: NonNullable<ReturnType<typeof sceneDrawContentOf>>,
    row: RenderSceneSlot,
    index: number,
    writeBounds: SlotBoundsWriter,
    slotAdmission: boolean,
  ): void {
    const content = slotContent(row);
    if (content.terrainSection !== undefined || content.generatedMesh !== undefined) {
      this.projectCandidate(rows.project(row), index);
      return;
    }
    if (!this.authorAdmits(content, rows)) return;
    const shadowOnly = this.cameraAdmission(
      content,
      row.entityKey,
      index,
      content.frustumCulled !== false && writeBounds(row, this.worldAabb),
      slotAdmission,
    );
    rows.validateCullContent(content);
    if (shadowOnly !== undefined) this.admitAddress(index, shadowOnly);
  }

  private projectCandidate(candidate: RenderableSnapshot, index: number): void {
    if (!this.authorAdmits(candidate)) return;
    if (this.gpuCulled?.(candidate) === true) {
      // The GPU owns this cull; its camera statistic is available on demand.
      this.visibility.defer(candidate, index, this.boundsOf, this.cameraPlanes);
      this.admit(candidate, index, false);
      return;
    }
    const shadowOnly = this.cameraAdmission(
      candidate,
      candidate.entityKey,
      index,
      this.boundsOf(candidate, index, this.worldAabb),
    );
    if (shadowOnly !== undefined) this.admit(candidate, index, shadowOnly);
  }

  private authorAdmits(
    candidate: RowContent,
    rows?: NonNullable<ReturnType<typeof sceneDrawContentOf>>,
  ): boolean {
    if (!residencySelected(this.residencySelection, candidate.residencyGroup)) {
      return false;
    }
    if (this.newSources) {
      const source = rows?.cullContent(candidate) ?? candidate;
      if (candidate.authorVisible === false && this.authorSubsurface === this.sourceSubsurface)
        this.authorSubsurface = this.sourceSubsurface.fork();
      this.sourceSubsurface.add(source, this.materials, this.meshes);
      if (candidate.authorVisible !== false && this.authorSubsurface !== this.sourceSubsurface)
        this.authorSubsurface.add(source, this.materials, this.meshes);
    }
    if (candidate.authorVisible === false) {
      this.culled += 1;
      return false;
    }
    return true;
  }

  /** A bounded row outside display frusta may still cast into a visible light. */
  private cameraAdmission(
    candidate: RowContent,
    entity: number,
    index: number,
    bounded: boolean,
    slotAdmission = false,
  ): boolean | undefined {
    if (!bounded) return false;
    this.total++;
    if (cameraBoundsVisible(this.cameraPlanes, this.worldAabb)) return false;
    this.culled++;
    if (slotAdmission && candidate.nativeDraw === undefined) {
      this.projection.hide(index);
      this.hasHiddenSlots = true;
    } else this.visibility.hide(entity, candidate);
    if (this.shadowCasterVisible(index)) return true;
    this.clippedAuthorRow = true;
    return undefined;
  }

  /** Is this camera-culled row a shadow caster inside an active light frustum? */
  private shadowCasterVisible(index: number): boolean {
    if (this.casterWords === undefined) {
      const count = this.frame.renderables.length;
      const words = Math.ceil(count / 32);
      const resident = this.memo?.casterWords;
      const flags =
        resident !== undefined &&
        resident.length >= words &&
        resident.length <= Math.max(512, words * 4)
          ? resident
          : new Uint32Array(words);
      flags.fill(0, 0, words);
      if (!writeCapturedCasterRanks(this.frame.dispatch, flags, count)) {
        for (const draw of this.frame.dispatch) {
          const row = draw.renderableIndex;
          if (draw.tags.LightMode === 'ShadowCaster' && row >= 0 && row < count) {
            const word = row >>> 5;
            flags[word] = (flags[word] ?? 0) | (1 << (row & 31));
          }
        }
      }
      this.casterWords = flags;
      if (this.memo !== undefined) this.memo.casterWords = flags;
    }
    if (((this.casterWords[index >>> 5] ?? 0) & (1 << (index & 31))) === 0) return false;
    this.shadowFrusta ??= buildShadowFrusta(
      this.frame.lights,
      this.frame.cameras[0],
      this.memo?.shadowFrusta,
    );
    for (const planes of this.shadowFrusta)
      if (frustum.intersectsBox(planes, this.worldAabb as box3.Box3Like)) return true;
    return false;
  }

  private admit(source: RenderableSnapshot, index: number, shadowOnly: boolean): void {
    const previous = this.previous;
    const visibleCount = this.admitAddress(index, shadowOnly);
    if (this.columns !== undefined) return;
    if (
      this.visible === undefined &&
      (previous?.nativeSlots !== undefined || previous?.renderables.at(visibleCount) !== source)
    )
      this.visible = previous?.renderables.slice(0, visibleCount) ?? [];
    this.visible?.push(source);
  }

  private admitAddress(index: number, shadowOnly: boolean): number {
    const visibleCount = this.visibleCount++;
    if (shadowOnly) this.shadowOnlyRows = true;
    this.projection.admit(index, shadowOnly);
    return visibleCount;
  }

  private result(
    frame: ExtractedFrame,
    admittedSubsurface: SubsurfaceSelection,
  ): PersistentCullResult {
    assertResidencyCurrent(this.residencySelection);
    return {
      frame,
      subsurface: {
        source: this.sourceSubsurface.demand,
        authorVisible: this.authorSubsurface.demand,
        admitted: admittedSubsurface.demand,
      },
    };
  }

  private remapDispatch(domain: symbol | undefined) {
    const frame = this.frame;
    const projectAddress = (index: number, shadow: boolean) =>
      index >= frame.renderables.length ? -1 : this.projection.address(index, shadow);
    const native = projectCapturedViewDispatch(
      frame.dispatch,
      projectAddress,
      this.previous,
      domain,
    );
    if (native !== undefined)
      return { dispatch: Object.freeze(native), remappedSources: undefined };
    const dispatch: DispatchEntry[] = [];
    let remappedSources: DispatchEntry[] | undefined;
    // A stable input sequence can also keep addresses when visibility changes.
    const prior = this.previous?.sourceDispatch === frame.dispatch ? this.previous : undefined;
    let priorOutput = 0;
    let previousEntry: DispatchEntry | undefined;
    const projectRank = (candidateIndex: number, shadow: boolean): number => {
      const oldAddress =
        prior !== undefined && candidateIndex < prior.rowCount
          ? prior.projection.address(candidateIndex, shadow)
          : -1;
      previousEntry = oldAddress >= 0 ? prior?.dispatch.at(priorOutput++) : undefined;
      return projectAddress(candidateIndex, shadow);
    };
    const append = (entry: DispatchEntry, rank: number): void => {
      if (rank === entry.renderableIndex) {
        dispatch.push(entry);
        return;
      }
      const oldEntry =
        previousEntry ??
        (this.previous?.remappedSources?.[dispatch.length] === entry
          ? this.previous.dispatch.at(dispatch.length)
          : undefined);
      if (this.memo !== undefined) {
        remappedSources ??= [];
        remappedSources[dispatch.length] = entry;
      }
      dispatch.push(
        oldEntry?.renderableIndex === rank ? oldEntry : withRenderableIndex(entry, rank),
      );
    };
    for (const entry of frame.dispatch) {
      const rank = projectRank(entry.renderableIndex, entry.tags.LightMode === 'ShadowCaster');
      if (rank >= 0) append(entry, rank);
    }
    // Published once; readers may key derived classifications on its identity.
    Object.freeze(dispatch);
    return { dispatch, remappedSources };
  }
}

/** An issued camera test can also read the same authored fields at a known Scene address. */
export interface SlotCameraVisibility {
  readonly addresses: SceneSlotFrame['identities'] | undefined;
  readonly cameraVisible: (source: RenderableSnapshot) => boolean;
  admitsSlot(content: RowContent, row: RenderSceneSlot): boolean;
}
export type CameraVisibility = ((source: RenderableSnapshot) => boolean) & {
  slots?: SlotCameraVisibility;
};

/** Only these facts escape culling through the frame's camera visibility and statistics readers. */
class FrameCameraVisibility {
  private hidden?: Set<number>;
  addresses: SceneSlotFrame['identities'] | undefined;
  private hiddenSlots: FrameSet | undefined;

  /** Keyed siblings and generated rows keep their individual visibility answers. */
  acceptSlots(identities: SceneSlotFrame['identities'], hidden: FrameSet): boolean {
    this.addresses = identities;
    if (this.deferred === undefined) this.cameraVisible.slots = this;
    this.hiddenSlots = hidden;
    return !this.hidden && !this.hiddenSections && !this.hiddenNativeDraws;
  }
  private hiddenSections?: Map<number, Set<number>>;
  private hiddenNativeDraws?: Map<number, Set<string>>;
  private deferred?: DeferredCameraRows;

  constructor(private readonly residencySelection: RenderResidencySelection | undefined) {}

  defer(
    source: RenderableSnapshot,
    index: number,
    bounds: typeof snapshotWorldBounds,
    planes: readonly Float32Array[],
  ): void {
    this.deferred ??= new DeferredCameraRows(bounds, planes, this.residencySelection);
    this.deferred.sources.push(source);
    this.deferred.indices.push(index);
  }

  hide(key: number, candidate: Pick<RowContent, 'nativeDraw' | 'terrainSection'>): void {
    if (candidate.nativeDraw !== undefined) {
      this.hiddenNativeDraws ??= new Map();
      let draws = this.hiddenNativeDraws.get(key);
      if (draws === undefined) {
        draws = new Set<string>();
        this.hiddenNativeDraws.set(key, draws);
      }
      draws.add(candidate.nativeDraw.key);
      return;
    }
    if (candidate.terrainSection === undefined) {
      this.hidden ??= new Set();
      this.hidden.add(key);
      return;
    }
    this.hiddenSections ??= new Map();
    let sections = this.hiddenSections.get(key);
    if (sections === undefined) {
      sections = new Set();
      this.hiddenSections.set(key, sections);
    }
    sections.add(candidate.terrainSection.index);
  }

  readonly cameraVisible: CameraVisibility = (source) => {
    if (!residencySelected(this.residencySelection, source.residencyGroup)) return false;
    const deferred = this.deferred;
    if (deferred !== undefined) {
      const at = deferred.find(source);
      if (at !== undefined) return deferred.visible(at) !== false;
    }
    return this.visibleAddress(source, source.entityKey);
  };

  admitsSlot(content: RowContent, row: RenderSceneSlot): boolean {
    return (
      residencySelected(this.residencySelection, content.residencyGroup) &&
      this.visibleAddress(content, row.entityKey, row.slot)
    );
  }

  private visibleAddress(source: RowContent, key: number, address?: number): boolean {
    if (source.nativeDraw !== undefined)
      return this.hiddenNativeDraws?.get(key)?.has(source.nativeDraw.key) !== true;
    if (source.terrainSection !== undefined)
      return this.hiddenSections?.get(key)?.has(source.terrainSection.index) !== true;
    if (this.hidden?.has(key)) return false;
    if (this.hiddenSlots === undefined || this.hiddenSlots.size === 0) return true;
    const slot = address ?? this.addresses?.get(key);
    return slot === undefined || !this.hiddenSlots.has(slot);
  }

  frustumStats(cpuCulled: number, cpuTotal: number): ExtractedFrame['frustumStats'] {
    const deferred = this.deferred;
    if (deferred === undefined) return { culled: cpuCulled, total: cpuTotal };
    return {
      get culled() {
        return cpuCulled + deferred.statistics().culled;
      },
      get total() {
        return cpuTotal + deferred.statistics().total;
      },
    };
  }
}

// Only a frame with GPU-deferred CPU queries retains source rows and camera planes.
class DeferredCameraRows {
  readonly sources: RenderableSnapshot[] = [];
  readonly indices: number[] = [];
  private deferredByEntity?: Map<number, number>;
  private deferredBySection?: Map<number, Map<number, number>>;
  private readonly deferredVisible: (boolean | null | undefined)[] = [];
  private readonly deferredAabb = box3.create();
  private deferredStats?: { readonly culled: number; readonly total: number };
  constructor(
    private readonly bounds: typeof snapshotWorldBounds,
    private readonly planes: readonly Float32Array[],
    private readonly residencySelection: RenderResidencySelection | undefined,
  ) {}

  find(source: RenderableSnapshot): number | undefined {
    if (this.deferredByEntity === undefined || this.deferredBySection === undefined)
      this.indexDeferred();
    const key = source.entityKey;
    return source.terrainSection === undefined
      ? this.deferredByEntity?.get(key)
      : this.deferredBySection?.get(key)?.get(source.terrainSection.index);
  }

  private indexDeferred(): void {
    const byEntity = new Map<number, number>();
    const bySection = new Map<number, Map<number, number>>();
    this.deferredByEntity = byEntity;
    this.deferredBySection = bySection;
    for (let i = 0; i < this.sources.length; i++) {
      const deferred = this.sources[i] as RenderableSnapshot;
      const key = deferred.entityKey;
      if (deferred.terrainSection === undefined) {
        byEntity.set(key, i);
        continue;
      }
      let sections = bySection.get(key);
      if (sections === undefined) {
        sections = new Map();
        bySection.set(key, sections);
      }
      sections.set(deferred.terrainSection.index, i);
    }
  }

  visible(position: number): boolean | undefined {
    assertResidencyCurrent(this.residencySelection);
    const result = this.deferredVisible[position];
    if (result !== undefined) return result ?? undefined;
    const source = this.sources[position] as RenderableSnapshot;
    const visible = this.bounds(source, this.indices[position] as number, this.deferredAabb)
      ? cameraBoundsVisible(this.planes, this.deferredAabb)
      : undefined;
    this.deferredVisible[position] = visible ?? null;
    return visible;
  }

  statistics(): { readonly culled: number; readonly total: number } {
    assertResidencyCurrent(this.residencySelection);
    if (this.deferredStats === undefined) {
      let deferredCulled = 0;
      let deferredTotal = 0;
      for (let i = 0; i < this.sources.length; i++) {
        const visible = this.visible(i);
        if (visible === undefined) continue;
        deferredTotal++;
        if (!visible) deferredCulled++;
      }
      this.deferredStats = { culled: deferredCulled, total: deferredTotal };
    }
    return this.deferredStats;
  }
}

/** Fixed camera admission over native Scene slots; shared by display and capture views. */
export interface SlotCullState {
  readonly residencySelection: RenderResidencySelection | undefined;
  readonly admission: ResidualCameraAdmission;
  readonly planes: readonly Float32Array[];
  readonly slots: SceneSlotFrame;
  readonly materials: MaterialFrame;
  readonly meshes: MeshFrame;
  readonly unavailable: FrameSet;
  readonly skinRoot: object | undefined;
  readonly skinRevision: number | undefined;
  readonly skinSlots: SceneSlotFrame | undefined;
  readonly skinReadable: boolean | undefined;
  readonly facts: ResidualCullFacts;
}

/** The display cull additionally tracks its subsurface demand. */
export interface ResidualCullMemo extends SlotCullState {
  readonly subsurface: SubsurfaceSelection;
}

interface ResidualCullBounds {
  readonly residencySelection?: RenderResidencySelection;
  readonly meshes: MeshFrame;
  readonly skin: SkinSceneFrame | undefined;
  readonly unavailable: FrameSet;
  readonly boundsOfSlot?: SlotBoundsWriter;
}

function sameResidualSkin(before: SlotCullState, bounds: ResidualCullBounds): boolean {
  return (
    before.skinRoot === bounds.skin?.current.inputRoot() &&
    before.skinRevision === bounds.skin?.current.inputRevision &&
    before.skinSlots === bounds.skin?.slots &&
    before.skinReadable === bounds.skin?.current.readable
  );
}

/** Culling reads the accepted displacement interval and Skin position proof, not color values. */
function sameResidualMaterials(before: MaterialFrame, current: MaterialFrame): boolean {
  if (before.hasBorrowedValues || current.hasBorrowedValues) return false;
  if (before === current) return true;
  const revision = MaterialFrame.cullingRevision(before);
  if (revision !== 0 && revision === MaterialFrame.cullingRevision(current)) return true;
  let same = true;
  current.changesSince(before, (left, right) => {
    if (!sameMaterialCullingBounds(left?.snapshot, right?.snapshot)) same = false;
  });
  return same;
}

function samePlanes(left: readonly Float32Array[], right: readonly Float32Array[]): boolean {
  return (
    left.length === right.length &&
    left.every((planes, index) => {
      const other = right[index] as Float32Array;
      return planes.length === other.length && planes.every((value, at) => value === other[at]);
    })
  );
}

/**
 * GPU-lane cull. Owned rows are admitted without a CPU visit: their view pass
 * culls them. Only residual rows, which keep a CPU-recorded draw under
 * `selection`, are tested. The frame stays slot-ordered and uncompacted;
 * `cameraVisible` carries the camera admission, so no dispatch address depends
 * on another row's visibility.
 */
interface ResidualCullFacts {
  readonly bounds: ResidualBoundsProof;
  readonly hiddenSlots: FrameSet;
  readonly boundedSlots: FrameSet;
  readonly skinSlots: FrameSet;
}

/** Only changed residual rows are tested while the view and bound resources are fixed. */
function residualChanges(
  before: SlotCullState,
  slots: SceneSlotFrame,
  residual: FrameSet,
  bounds: ResidualCullBounds,
): Set<number> | undefined {
  const dirty = new Set<number>();
  if (
    before.slots !== slots &&
    !slots.visitChangedVersions(before.slots, (slot) => dirty.add(slot))
  )
    return undefined;
  residual.changesSince(before.admission.residual, (slot) => dirty.add(slot));
  bounds.unavailable.changesSince(before.unavailable, (slot) => dirty.add(slot));
  if (!sameResidualSkin(before, bounds)) for (const slot of before.facts.skinSlots) dirty.add(slot);
  return dirty;
}

function testResidualRows(
  slots: SceneSlotFrame,
  records: () => Iterable<RenderSceneSlot>,
  residual: FrameSet,
  unavailable: FrameSet,
  before: ResidualCullFacts | undefined,
  dirty: ReadonlySet<number> | undefined,
  boundsOf: SlotCullInput['boundsOf'],
  boundsOfSlot: SlotBoundsWriter | undefined,
  intersects: (aabb: box3.Box3) => boolean,
  meshes: MeshFrame,
  residencySelection: RenderResidencySelection | undefined,
): ResidualCullFacts {
  if (dirty?.size === 0 && before !== undefined) return before;
  const aabb = box3.create();
  const proof = new ResidualBoundsProof(dirty === undefined ? undefined : before?.bounds);
  const test = (record: RenderSceneSlot): boolean => {
    const content = slotContent(record);
    const known =
      content.frustumCulled !== false &&
      content.authorVisible !== false &&
      (boundsOfSlot !== undefined &&
      content.terrainSection === undefined &&
      content.generatedMesh === undefined
        ? boundsOfSlot(record, aabb)
        : boundsOf(record.snapshot, -1, aabb, record));
    proof.record(content, meshes, known ? aabb : undefined);
    return known;
  };
  if (dirty === undefined) {
    const hidden: number[] = [];
    const bounded: number[] = [];
    const skin: number[] = [];
    for (const record of records()) {
      if (!residencySelected(residencySelection, slotContent(record).residencyGroup)) continue;
      if (slotContent(record).skinBinding !== undefined) skin.push(record.slot);
      if (!test(record)) continue;
      bounded.push(record.slot);
      if (!intersects(aabb)) hidden.push(record.slot);
    }
    return {
      bounds: proof,
      hiddenSlots: FrameSet.from(hidden),
      boundedSlots: FrameSet.from(bounded),
      skinSlots: FrameSet.from(skin),
    };
  }
  const hidden = new Map<number, boolean>();
  const bounded = new Map<number, boolean>();
  const skin = new Map<number, boolean>();
  for (const slot of dirty) {
    const candidate = residual.has(slot) && !unavailable.has(slot) ? slots.slotAt(slot) : undefined;
    const record = activeResidencyRecord(candidate, residencySelection);
    const known = record !== undefined && test(record);
    skin.set(slot, record !== undefined && slotContent(record).skinBinding !== undefined);
    bounded.set(slot, known);
    hidden.set(slot, known && !intersects(aabb));
  }
  return {
    bounds: proof,
    hiddenSlots: (before?.hiddenSlots ?? new FrameSet()).edit(hidden),
    boundedSlots: (before?.boundedSlots ?? new FrameSet()).edit(bounded),
    skinSlots: (before?.skinSlots ?? new FrameSet()).edit(skin),
  };
}

/** All bound inputs are from the same accepted Scene frame. Unknown bounds stay visible. */
export interface SlotCullInput extends ResidualCullBounds {
  readonly planes: readonly Float32Array[];
  readonly slots: SceneSlotFrame;
  readonly candidates: FrameSet;
  readonly records: () => Iterable<RenderSceneSlot>;
  readonly materials: MaterialFrame;
  readonly boundsOf: (
    source: RenderableSnapshot,
    index: number,
    out: box3.Box3,
    row?: RenderSceneSlot,
  ) => boolean;
}

export function cameraBoundsVisible(planes: readonly Float32Array[], aabb: box3.Box3): boolean {
  for (const camera of planes)
    if (
      camera.length === 0 ||
      frustum.intersectsBox(camera as frustum.Frustum, aabb as box3.Box3Like)
    )
      return true;
  return planes.length === 0;
}

/** Reuse the native row journal, resource proofs and persistent visibility sets for every view. */
export function cullSceneSlots(input: SlotCullInput, before?: SlotCullState): SlotCullState {
  const { planes, materials, slots, candidates: residual, boundsOf } = input;
  const bounds = input;
  assertResidencyCurrent(bounds.residencySelection);
  const sameFrusta = before !== undefined && samePlanes(before.planes, planes);
  const fixedBounds = !materials.hasBorrowedValues && before?.materials.hasBorrowedValues === false;
  let dirty =
    before !== undefined &&
    before.residencySelection === bounds.residencySelection &&
    sameResidualMaterials(before.materials, materials) &&
    (before.meshes === bounds.meshes ||
      (fixedBounds && before.facts.bounds.meshesUnchanged(before.meshes, bounds.meshes)))
      ? residualChanges(before, slots, residual, bounds)
      : undefined;
  let previousFacts = before?.facts;
  if (!sameFrusta) {
    if (fixedBounds && dirty !== undefined && previousFacts?.bounds.enclosed(planes) === true) {
      if (previousFacts.hiddenSlots.size > 0)
        previousFacts = { ...previousFacts, hiddenSlots: new FrameSet() };
    } else dirty = undefined;
  }
  const previous = before?.admission;
  const facts = testResidualRows(
    slots,
    input.records,
    residual,
    bounds.unavailable,
    previousFacts,
    dirty,
    boundsOf,
    input.boundsOfSlot,
    (aabb) => cameraBoundsVisible(planes, aabb),
    bounds.meshes,
    bounds.residencySelection,
  );
  const hiddenSlots = facts.hiddenSlots;
  const admission: ResidualCameraAdmission =
    previous !== undefined &&
    sameFrusta &&
    previous.hidden === hiddenSlots &&
    previous.residual === residual
      ? previous
      : {
          hidden: hiddenSlots,
          residual,
          frusta: sameFrusta && previous !== undefined ? previous.frusta : {},
        };
  assertResidencyCurrent(bounds.residencySelection);
  return {
    residencySelection: bounds.residencySelection,
    admission,
    planes,
    slots,
    materials,
    meshes: bounds.meshes,
    unavailable: bounds.unavailable,
    skinRoot: bounds.skin?.current.inputRoot(),
    skinRevision: bounds.skin?.current.inputRevision,
    skinSlots: bounds.skin?.slots,
    skinReadable: bounds.skin?.current.readable,
    facts,
  };
}

export function cullResidualFrame(
  frame: ExtractedFrame,
  materials: MaterialFrame,
  boundsOf: (
    snapshot: RenderableSnapshot,
    index: number,
    out: box3.Box3,
    row?: RenderSceneSlot,
  ) => boolean,
  gpuOwned: GpuOwnedFrame,
  selection: GpuDrawSelection,
  memo: { value: ResidualCullMemo | undefined },
  bounds: ResidualCullBounds,
): PersistentCullResult {
  assertResidencyCurrent(bounds.residencySelection);
  const planes = buildCameraFrusta(frame.cameras);
  const state = cullSceneSlots(
    {
      ...bounds,
      planes,
      slots: gpuOwned.slots,
      materials,
      boundsOf,
      candidates: gpuOwned.residualSet(selection),
      records: () => gpuOwned.residualSlots(selection),
    },
    memo.value,
  );
  const {
    admission,
    facts: { hiddenSlots, boundedSlots },
  } = state;
  const residual = admission.residual;
  const isResidualSlot = (slot: number | undefined): boolean =>
    slot !== undefined && residual.has(slot) && !bounds.unavailable.has(slot);
  const subsurface = memo.value?.subsurface ?? new SubsurfaceSelection();
  subsurface.trackAll(materials);
  // Owned rows are tested only when a reader asks; the answer is fixed per frame.
  const ownedVisible = new Map<number, boolean | undefined>();
  const ownedAabb = box3.create();
  const ownedVisibility = (source: RenderableSnapshot, key: number): boolean | undefined => {
    if (!residencySelected(bounds.residencySelection, source.residencyGroup)) return false;
    if (ownedVisible.has(key)) return ownedVisible.get(key);
    const visible = boundsOf(source, -1, ownedAabb)
      ? cameraBoundsVisible(planes, ownedAabb)
      : undefined;
    ownedVisible.set(key, visible);
    return visible;
  };
  const cameraVisible = (source: RenderableSnapshot): boolean => {
    if (!residencySelected(bounds.residencySelection, source.residencyGroup)) return false;
    const slot = gpuOwned.slots.identitySlot(source.entityKey);
    if (slot !== undefined && hiddenSlots.has(slot)) return false;
    return isResidualSlot(slot) || ownedVisibility(source, source.entityKey) !== false;
  };
  let ownedStats: { readonly culled: number; readonly total: number } | undefined;
  const ownedStatistics = () => {
    assertResidencyCurrent(bounds.residencySelection);
    if (ownedStats !== undefined) return ownedStats;
    let ownedCulled = 0;
    let ownedTotal = 0;
    for (const source of frame.renderables) {
      const key = source.entityKey;
      if (
        !residencySelected(bounds.residencySelection, source.residencyGroup) ||
        source.authorVisible === false ||
        isResidualSlot(gpuOwned.slots.identitySlot(source.entityKey))
      )
        continue;
      const visible = ownedVisibility(source, key);
      if (visible === undefined) continue;
      ownedTotal += 1;
      if (!visible) ownedCulled += 1;
    }
    ownedStats = { culled: ownedCulled, total: ownedTotal };
    return ownedStats;
  };
  const demand = subsurface.demand;
  const result: PersistentCullResult = {
    frame: {
      ...frame,
      frustumStats: {
        get culled() {
          return hiddenSlots.size + ownedStatistics().culled;
        },
        get total() {
          return boundedSlots.size + ownedStatistics().total;
        },
      },
      cameraVisible,
      cameraAdmission: admission,
      gpuOwned,
    },
    subsurface: { source: demand, authorVisible: demand, admitted: demand },
  };
  assertResidencyCurrent(bounds.residencySelection);
  memo.value = { ...state, subsurface };
  return result;
}
