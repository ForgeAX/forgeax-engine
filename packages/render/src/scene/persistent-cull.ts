import { box3, frustum } from '@forgeax/engine-math';
import { buildCameraFrusta } from '../camera-frusta';
import { worldEntityKey } from '../record/frame-snapshot';
import type {
  DispatchEntry,
  DispatchList,
  ExtractedFrame,
  RenderableSnapshot,
} from '../render-system-extract';
import { SubsurfaceSelection } from '../subsurface/selection';
import type { FrameList } from './frame-list';
import type { MaterialFrame } from './material-dispatch';
import type { MeshFrame } from './mesh-frame';
import type { PersistentShadowCasterProjection } from './render-scene';
import { worldBounds, writeBounds } from './render-scene-snapshots';
import { buildShadowFrusta } from './shadow-visibility';

let cullProjectedIndexScratch = new Int32Array(0);

/**
 * Previous cull output keyed by its exact inputs. Camera motion changes the
 * frustum every frame, but the admitted set is usually unchanged; reusing the
 * output arrays keeps every identity-keyed consumer downstream (visibility
 * projection, residency validation, render bundles) on its cached path.
 */
export interface PersistentCullMemo {
  readonly meshes: MeshFrame | undefined;
  readonly sourceSubsurface: SubsurfaceSelection;
  readonly authorSubsurface: SubsurfaceSelection;
  readonly admittedSubsurface: SubsurfaceSelection;
  readonly sourceRenderables: FrameList<RenderableSnapshot>;
  readonly sourceOwner: object;
  readonly sourceRevision: number;
  readonly sourceDispatch: DispatchList;
  readonly projectedIndex: Int32Array;
  readonly shadowOnly: ReadonlySet<number>;
  readonly renderables: RenderableSnapshot[];
  readonly dispatch: DispatchEntry[];
  /** Private address scratch; published entries themselves stay immutable. */
  readonly dispatchRemapping: ReadonlyMap<DispatchEntry, DispatchEntry>;
}

interface PersistentCullResult {
  frame: ExtractedFrame;
  subsurface: PersistentShadowCasterProjection['content']['subsurface'];
}

const casterIndexCache = new WeakMap<DispatchList, ReadonlySet<number>>();

/** Fixed dispatch lists are retained across pose frames; scan their casters once. */
function shadowCasterIndices(dispatch: DispatchList): ReadonlySet<number> {
  let indices = casterIndexCache.get(dispatch);
  if (indices === undefined) {
    const collected = new Set<number>();
    for (const draw of dispatch)
      if (draw.tags.LightMode === 'ShadowCaster') collected.add(draw.renderableIndex);
    indices = collected;
    casterIndexCache.set(dispatch, indices);
  }
  return indices;
}

function snapshotWorldBounds(
  snapshot: RenderableSnapshot,
  _index: number,
  out: box3.Box3,
): boolean {
  return writeBounds(worldBounds(snapshot), out);
}

export function cullPersistentFrame(
  frame: ExtractedFrame,
  materials: MaterialFrame,
  boundsOf: (
    snapshot: RenderableSnapshot,
    index: number,
    out: box3.Box3,
  ) => boolean = snapshotWorldBounds,
  memo?: { value: PersistentCullMemo | undefined },
  gpuCulled?: (snapshot: RenderableSnapshot) => boolean,
  meshes?: MeshFrame,
  sourceOwner: object = frame.renderables,
  sourceRevision = 0,
): PersistentCullResult {
  return new PersistentFrameCull(
    frame,
    materials,
    boundsOf,
    memo,
    gpuCulled,
    meshes,
    sourceOwner,
    sourceRevision,
  ).run();
}

/** One cull of a persistent frame: camera/shadow admission, then memoized projection. */
class PersistentFrameCull {
  private readonly previous: PersistentCullMemo | undefined;
  private readonly newSources: boolean;
  private readonly sourceSubsurface: SubsurfaceSelection;
  private readonly authorSubsurface: SubsurfaceSelection;
  private readonly planes: ReturnType<typeof buildCameraFrusta>;
  // Shadow casters are not constrained by the display camera. Keep the
  // primary camera cull intact, but admit a caster that is outside every
  // camera frustum when its bounds intersect one of the active light-space
  // frusta. This is especially important for point-light cube faces: the
  // caster can be behind the camera while still occluding the receiver.
  private casterIndices: ReadonlySet<number> | undefined;
  private shadowFrusta: ReturnType<typeof buildShadowFrusta> | undefined;
  private readonly shadowOnly = new Set<number>();
  private readonly hidden = new Set<number>();
  private readonly hiddenSections = new Map<number, Set<number>>();
  // GPU-owned candidates are culled by their view pass. Their CPU test is
  // deferred: only camera-visibility readers and frustum statistics pay it.
  private readonly deferredSources: RenderableSnapshot[] = [];
  private readonly deferredIndices: number[] = [];
  // Readers pass their own snapshot of the same row (for example a scene
  // slot), so look candidates up by entity identity, not object identity.
  private deferredByEntity: Map<number, number> | undefined;
  private deferredBySection: Map<number, Map<number, number>> | undefined;
  private readonly deferredVisible = new Map<number, boolean | undefined>();
  private readonly deferredAabb = box3.create();
  private deferredStats: { readonly culled: number; readonly total: number } | undefined;
  private readonly projectedIndex: Int32Array;
  private readonly worldAabb = box3.create();
  private total = 0;
  private culled = 0;
  private visibleCount = 0;
  private sameProjection: boolean;
  private visible: RenderableSnapshot[] | undefined;

  constructor(
    private readonly frame: ExtractedFrame,
    private readonly materials: MaterialFrame,
    private readonly boundsOf: (
      snapshot: RenderableSnapshot,
      index: number,
      out: box3.Box3,
    ) => boolean,
    private readonly memo: { value: PersistentCullMemo | undefined } | undefined,
    private readonly gpuCulled: ((snapshot: RenderableSnapshot) => boolean) | undefined,
    private readonly meshes: MeshFrame | undefined,
    private readonly sourceOwner: object,
    private readonly sourceRevision: number,
  ) {
    const previous = memo?.value;
    this.previous = previous;
    this.newSources =
      previous?.sourceOwner !== sourceOwner ||
      previous?.sourceRevision !== sourceRevision ||
      previous?.meshes !== meshes;
    this.sourceSubsurface =
      this.newSources || previous === undefined
        ? new SubsurfaceSelection()
        : previous.sourceSubsurface;
    this.authorSubsurface =
      this.newSources || previous === undefined
        ? new SubsurfaceSelection()
        : previous.authorSubsurface;
    this.planes = buildCameraFrusta(frame.cameras);
    const candidates = frame.renderables;
    if (cullProjectedIndexScratch.length < candidates.length) {
      cullProjectedIndexScratch = new Int32Array(candidates.length);
    }
    this.projectedIndex = cullProjectedIndexScratch;
    this.projectedIndex.fill(-1, 0, candidates.length);
    this.sameProjection =
      previous !== undefined && previous.projectedIndex.length === candidates.length;
  }

  run(): PersistentCullResult {
    let index = -1;
    for (const candidate of this.frame.renderables) {
      index++;
      if (candidate !== undefined) this.projectCandidate(candidate, index);
    }
    const frustumStats = this.frustumStats();
    const materials = this.materials;
    this.sourceSubsurface.adopt(materials);
    this.authorSubsurface.adopt(materials);
    const previous = this.previous;
    // Dispatch addresses depend only on the projection, not on row snapshots.
    const sameAddresses =
      previous !== undefined &&
      this.sameProjection &&
      previous.shadowOnly.size === this.shadowOnly.size &&
      previous.renderables.length === this.visibleCount;
    const sameVisibility = sameAddresses && this.visible === undefined;
    const admittedSubsurface = sameVisibility
      ? previous.admittedSubsurface
      : new SubsurfaceSelection();
    if (sameVisibility) admittedSubsurface.adopt(materials);
    if (sameVisibility && previous.sourceDispatch === this.frame.dispatch)
      return this.reuseVisibility(previous, admittedSubsurface, frustumStats);

    const selected = sameVisibility
      ? previous.renderables
      : (this.visible ?? previous?.renderables.slice(0, this.visibleCount) ?? []);
    if (!sameVisibility) for (const source of selected) admittedSubsurface.add(source, materials);

    admittedSubsurface.adopt(materials);
    if (sameAddresses && previous.sourceDispatch === this.frame.dispatch)
      return this.reuseAddresses(previous, selected, admittedSubsurface, frustumStats);
    return this.remapDispatch(selected, admittedSubsurface, frustumStats);
  }

  private projectCandidate(candidate: RenderableSnapshot, index: number): void {
    if (this.newSources) {
      this.sourceSubsurface.add(candidate, this.materials);
      if (candidate.authorVisible !== false) this.authorSubsurface.add(candidate, this.materials);
    }
    if (candidate.authorVisible === false) {
      this.culled += 1;
      this.noteDropped(index);
      return;
    }
    let isVisible = true;
    let isShadowVisible = false;
    // A GPU-owned candidate stays in the plan (its view pass culls it against
    // the same bounds), but the CPU test still feeds `frustumStats` so the
    // statistic does not depend on which lane executed the cull.
    const gpuOwned = this.gpuCulled?.(candidate) === true;
    if (gpuOwned) {
      // Always admitted; its view pass owns the frustum test.
      this.deferredSources.push(candidate);
      this.deferredIndices.push(index);
    } else if (this.boundsOf(candidate, index, this.worldAabb)) {
      this.total += 1;
      isVisible = this.cameraIntersects(this.worldAabb);
      if (!isVisible) isShadowVisible = this.shadowCasterVisible(index);
    }
    if (!isVisible) {
      this.culled += 1;
      this.hide(candidate);
      if (!gpuOwned) {
        if (!isShadowVisible) {
          this.noteDropped(index);
          return;
        }
        this.shadowOnly.add(index);
      }
    }
    this.admit(candidate, index);
  }

  /** Does the box intersect any camera frustum (an empty roster admits everything)? */
  private cameraIntersects(aabb: box3.Box3): boolean {
    if (this.planes.length === 0) return true;
    for (const cameraPlanes of this.planes) {
      if (
        cameraPlanes.length === 0 ||
        frustum.intersectsBox(cameraPlanes as frustum.Frustum, aabb as box3.Box3Like)
      )
        return true;
    }
    return false;
  }

  /** Is this camera-culled row a shadow caster inside an active light frustum? */
  private shadowCasterVisible(index: number): boolean {
    this.casterIndices ??= shadowCasterIndices(this.frame.dispatch);
    if (!this.casterIndices.has(index)) return false;
    this.shadowFrusta ??= buildShadowFrusta(this.frame.lights);
    return this.shadowFrusta.some((lightPlanes) =>
      frustum.intersectsBox(lightPlanes, this.worldAabb as box3.Box3Like),
    );
  }

  private hide(candidate: RenderableSnapshot): void {
    const key = worldEntityKey(candidate.worldId, candidate.entityKey);
    if (candidate.terrainSection === undefined) {
      this.hidden.add(key);
      return;
    }
    let sections = this.hiddenSections.get(key);
    if (sections === undefined) {
      sections = new Set();
      this.hiddenSections.set(key, sections);
    }
    sections.add(candidate.terrainSection.index);
  }

  /** A dropped row breaks projection reuse only if the previous cull admitted it. */
  private noteDropped(index: number): void {
    if ((this.previous?.projectedIndex[index] ?? -1) !== -1) this.sameProjection = false;
  }

  private admit(source: RenderableSnapshot, index: number): void {
    const previous = this.previous;
    const visibleCount = this.visibleCount;
    this.projectedIndex[index] = visibleCount;
    if (
      previous?.projectedIndex[index] !== visibleCount ||
      previous.shadowOnly.has(index) !== this.shadowOnly.has(index)
    )
      this.sameProjection = false;
    if (this.visible === undefined && previous?.renderables[visibleCount] !== source)
      this.visible = previous?.renderables.slice(0, visibleCount) ?? [];
    this.visible?.push(source);
    this.visibleCount += 1;
  }

  readonly cameraVisible = (source: RenderableSnapshot): boolean => {
    const deferred = this.deferredAt(source);
    if (deferred !== undefined) return this.testDeferred(deferred) !== false;
    const key = worldEntityKey(source.worldId, source.entityKey);
    return source.terrainSection === undefined
      ? !this.hidden.has(key)
      : this.hiddenSections.get(key)?.has(source.terrainSection.index) !== true;
  };

  private deferredAt(source: RenderableSnapshot): number | undefined {
    if (this.deferredSources.length === 0) return undefined;
    if (this.deferredByEntity === undefined || this.deferredBySection === undefined)
      this.indexDeferred();
    const key = worldEntityKey(source.worldId, source.entityKey);
    return source.terrainSection === undefined
      ? this.deferredByEntity?.get(key)
      : this.deferredBySection?.get(key)?.get(source.terrainSection.index);
  }

  private indexDeferred(): void {
    const byEntity = new Map<number, number>();
    const bySection = new Map<number, Map<number, number>>();
    this.deferredByEntity = byEntity;
    this.deferredBySection = bySection;
    for (let i = 0; i < this.deferredSources.length; i++) {
      const deferred = this.deferredSources[i] as RenderableSnapshot;
      const key = worldEntityKey(deferred.worldId, deferred.entityKey);
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

  private testDeferred(position: number): boolean | undefined {
    if (this.deferredVisible.has(position)) return this.deferredVisible.get(position);
    const source = this.deferredSources[position] as RenderableSnapshot;
    const visible = this.boundsOf(
      source,
      this.deferredIndices[position] as number,
      this.deferredAabb,
    )
      ? this.cameraIntersects(this.deferredAabb)
      : undefined;
    this.deferredVisible.set(position, visible);
    return visible;
  }

  private deferredStatistics(): { readonly culled: number; readonly total: number } {
    if (this.deferredStats === undefined) {
      let deferredCulled = 0;
      let deferredTotal = 0;
      for (let i = 0; i < this.deferredSources.length; i++) {
        const visible = this.testDeferred(i);
        if (visible === undefined) continue;
        deferredTotal++;
        if (!visible) deferredCulled++;
      }
      this.deferredStats = { culled: deferredCulled, total: deferredTotal };
    }
    return this.deferredStats;
  }

  private frustumStats(): ExtractedFrame['frustumStats'] {
    const cull = this;
    const cpuCulled = this.culled;
    const cpuTotal = this.total;
    return {
      get culled() {
        return (
          cpuCulled + (cull.deferredSources.length === 0 ? 0 : cull.deferredStatistics().culled)
        );
      },
      get total() {
        return cpuTotal + (cull.deferredSources.length === 0 ? 0 : cull.deferredStatistics().total);
      },
    };
  }

  private result(
    frame: ExtractedFrame,
    admittedSubsurface: SubsurfaceSelection,
  ): PersistentCullResult {
    return {
      frame,
      subsurface: {
        source: this.sourceSubsurface.demand,
        authorVisible: this.authorSubsurface.demand,
        admitted: admittedSubsurface.demand,
      },
    };
  }

  private reuseVisibility(
    previous: PersistentCullMemo,
    admittedSubsurface: SubsurfaceSelection,
    frustumStats: ExtractedFrame['frustumStats'],
  ): PersistentCullResult {
    const frame = this.frame;
    if (this.memo !== undefined)
      this.memo.value = {
        ...previous,
        sourceRenderables: frame.renderables,
        meshes: this.meshes,
        sourceOwner: this.sourceOwner,
        sourceRevision: this.sourceRevision,
        sourceSubsurface: this.sourceSubsurface,
        authorSubsurface: this.authorSubsurface,
      };
    return this.result(
      {
        ...frame,
        renderables: previous.renderables,
        dispatch: previous.dispatch,
        frustumStats,
        cameraVisible: this.cameraVisible,
      },
      admittedSubsurface,
    );
  }

  private reuseAddresses(
    previous: PersistentCullMemo,
    selected: RenderableSnapshot[],
    admittedSubsurface: SubsurfaceSelection,
    frustumStats: ExtractedFrame['frustumStats'],
  ): PersistentCullResult {
    const frame = this.frame;
    if (this.memo !== undefined)
      this.memo.value = {
        ...previous,
        meshes: this.meshes,
        sourceSubsurface: this.sourceSubsurface,
        authorSubsurface: this.authorSubsurface,
        admittedSubsurface,
        sourceRenderables: frame.renderables,
        sourceOwner: this.sourceOwner,
        sourceRevision: this.sourceRevision,
        shadowOnly: this.shadowOnly,
        renderables: selected,
      };
    return this.result(
      {
        ...frame,
        renderables: selected,
        dispatch: previous.dispatch,
        frustumStats,
        cameraVisible: this.cameraVisible,
      },
      admittedSubsurface,
    );
  }

  private remapDispatch(
    selected: RenderableSnapshot[],
    admittedSubsurface: SubsurfaceSelection,
    frustumStats: ExtractedFrame['frustumStats'],
  ): PersistentCullResult {
    const frame = this.frame;
    const dispatch: DispatchEntry[] = [];
    // Strong per-run table: only the entries this cull remapped stay reachable,
    // with no ephemeron churn when a scene edit shifts every later address.
    const previousRemapping = this.previous?.dispatchRemapping;
    const dispatchRemapping = new Map<DispatchEntry, DispatchEntry>();
    for (const entry of frame.dispatch) {
      const candidateIndex = entry.renderableIndex;
      // Shadow-only candidates must never enter the main forward/transparent
      // dispatch. Their ShadowCaster entries remain available to the depth
      // passes, which consume the same validated ordered list.
      if (this.shadowOnly.has(candidateIndex) && entry.tags.LightMode !== 'ShadowCaster') {
        continue;
      }
      const renderableIndex = this.projectedIndex[candidateIndex];
      if (renderableIndex === undefined || renderableIndex < 0) {
        continue;
      }
      if (renderableIndex === entry.renderableIndex) {
        dispatch.push(entry);
      } else {
        let mapped = previousRemapping?.get(entry);
        if (mapped?.renderableIndex !== renderableIndex) mapped = { ...entry, renderableIndex };
        dispatchRemapping.set(entry, mapped);
        dispatch.push(mapped);
      }
    }
    // Published once; readers may key derived classifications on its identity.
    Object.freeze(dispatch);
    if (this.memo !== undefined) {
      this.memo.value = {
        meshes: this.meshes,
        sourceSubsurface: this.sourceSubsurface,
        authorSubsurface: this.authorSubsurface,
        admittedSubsurface,
        sourceRenderables: frame.renderables,
        sourceOwner: this.sourceOwner,
        sourceRevision: this.sourceRevision,
        sourceDispatch: frame.dispatch,
        projectedIndex: this.projectedIndex.slice(0, frame.renderables.length),
        shadowOnly: this.shadowOnly,
        renderables: selected,
        dispatch,
        dispatchRemapping,
      };
    }
    return this.result(
      {
        ...frame,
        renderables: selected,
        dispatch,
        frustumStats,
        cameraVisible: this.cameraVisible,
      },
      admittedSubsurface,
    );
  }
}
