import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetChange } from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { box3 } from '@forgeax/engine-math';
import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { projectGlyphView } from '../glyph-source';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import {
  type GpuDrivenMaterialProgramIndex,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import type { GpuScene } from '../gpu-scene';
import type {
  FrameCacheCounters,
  GpuDrivenStructureMetrics,
  PersistentRenderSceneInspection,
} from '../inspection-types';
import type { PointsLinesInspection } from '../points-lines/inspection';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { RenderPublicationIdentity } from '../publication/contract';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { RenderResourceScope } from '../publication/resource-scope';
import { worldEntityKey } from '../record/frame-snapshot';
import {
  type ReflectionProbeFact,
  ReflectionProbeProjection,
  type ReflectionProbeSelectionResult,
} from '../reflection/projection';
import type {
  DispatchList,
  ExtractedFrame,
  GpuOwnedFrame,
  MaterialSnapshotCachesByWorld,
  RenderableSnapshot,
} from '../render-system-extract';
import type { SubsurfaceDemand } from '../subsurface/selection';
import { standardSceneTemporalDemand } from '../temporal/standard-scene-data';
import { projectTerrainView, terrainSectionKey } from '../terrain/view.js';
import { projectTilemapView } from '../tilemap-source';
import type { TransmissionDemand } from '../transmission/projection';
import type { DrawEvidence } from './draw-evidence';
import { type FrameList, FrameProjection } from './frame-list';
import type { FrameSet } from './frame-set';
import type { MaterialFrame } from './material-dispatch';
import type { MeshFrame } from './mesh-frame';
import {
  cullPersistentFrame,
  cullResidualFrame,
  type PersistentCullMemo,
  type ResidualCullMemo,
} from './persistent-cull';
import { attachProbeRecord, attachProbeRecords, type ProbeAttachMemo } from './probe-attach';
import type { ProbeBlendBufferProjection } from './probe-blend';
import { type FrameCacheTally, worldBounds, writeBounds } from './render-scene-snapshots';
import type { RenderSceneBounds, RenderSceneSlot } from './render-scene-types';
import { RenderScene, type RenderSceneSubmissionCapture, sceneRow } from './render-scene-view';
import { ResidualRoster } from './residual-roster';
import {
  type CompositionEntry,
  type PersistentRenderCandidateRequest,
  type RetainedComposition,
  type SceneAdvance,
  SceneComposition,
  type SceneCompositionOptions,
} from './scene-composition';
import type { SceneSlotFrame } from './scene-slots';
import { SlotIdentityKeys } from './scene-slots';
import { SkinFrames, type SkinSceneFrame } from './skin-scene-inputs';

export type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneIdentity,
  RenderSceneInspection,
  RenderSceneOperation,
  RenderSceneRecord,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';
export { RenderScene, type RenderSceneSubmissionCapture } from './render-scene-view';
export {
  type PersistentRenderCandidateRequest,
  type SceneAdvance,
  SceneComposition,
  type SceneCompositionOptions,
} from './scene-composition';

/** Adopt accepted material classes before a retained view reads the shared batch plan. */
function sourcePlanOf(entry: CompositionEntry): SubmissionPlan {
  entry.topology.adoptMaterials(entry.materialDispatch.materials(), entry.projection.slotAt);
  return entry.topology.sourcePlan();
}

/**
 * Complete ShadowCaster producer projection retained beside the camera-cull
 * submission frame. The persistent scene owns this sequence; record consumes
 * it for the CPU residual lane without rebuilding a second scene projection.
 */
/** Receiver-local authority; never transported as an ECS lease or packet field. */
export interface ShadowPublicationSource {
  readonly resources: RenderResourceScope;
  readonly revision: number;
  readonly isCurrent: () => boolean;
}

export interface PersistentShadowCasterProjection {
  readonly meshDraws: Pick<RenderScene, 'meshDrawSlot' | 'beginMeshDrawFrame'>;
  /**
   * Caster content evidence: unchanged owner and revisions prove every
   * published renderable and its dispatch are unchanged, whatever else the
   * ECS mutated (a camera Transform, gameplay state).
   */
  readonly content: {
    readonly materials: import('./material-dispatch').MaterialFrame;
    readonly meshes: MeshFrame;
    readonly subsurface: {
      readonly source: SubsurfaceDemand;
      readonly authorVisible: SubsurfaceDemand;
      readonly admitted: SubsurfaceDemand;
    };
    readonly owner: object;
    readonly sceneRevision: number;
    readonly dispatchRevision: number;
    readonly publicationSource?: ShadowPublicationSource;
    /** Actual view-derived draws; root scene revisions do not encode their geometry. */
    readonly viewDraws?: FrameList<RenderableSnapshot>;
  };
  /**
   * Writes borrowed task scratch; false leaves out unchanged and means
   * uncullable. A draw selected from a Scene row passes that row, which
   * replaces the identity lookup.
   */
  readonly worldBoundsOf: (
    source: RenderableSnapshot,
    out: box3.Box3,
    slot?: RenderSceneSlot,
  ) => boolean;
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly dispatch: DispatchList;
  readonly materialPrograms?: GpuDrivenMaterialProgramIndex;
}

export interface PersistentRenderSceneOptions extends SceneCompositionOptions {
  /** Profile consumers that need the same submitted history as camera effects. */
  readonly getTemporalConsumerDemand?: (() => boolean) | undefined;
  /** View-private asset consumers (its GI field); each shared change reaches every view once. */
  readonly onViewAssetChange?:
    | ((scope: RenderResourceScope, change: AssetChange) => void)
    | undefined;
}

export interface PersistentGpuDrivenState {
  /** Fixed numeric roots borrowed through this physical recording. */
  readonly skin?: SkinSceneFrame | undefined;
  readonly meshes?: MeshFrame;
  readonly completeGeometry?: boolean;
  /** Geometry rows without native batch membership, maintained by Scene changes. */
  readonly unbatchedSlots?: ReadonlySet<number>;
  /** Explicit source requests, maintained independently of draw visibility. */
  readonly pipelinePreparationSlots?: ReadonlySet<number>;
  /** Present only for the complete retained composition, never a filtered view. */
  readonly retained?: RetainedComposition;
  readonly scene: GpuScene;
  readonly plan: SubmissionPlan;
  /** Native source plans expand only when a recording actually requests tasks. */
  readonly queryPlan?: () => SubmissionPlan;
  readonly slots: FrameList<RenderSceneSlot>;
  /**
   * Fixed-frame record by stable slot address, resolving one indexed page path.
   * Old frame callbacks keep their original records through later updates.
   */
  readonly slotAt: (slot: number) => RenderSceneSlot | undefined;
  /** Indexed temporal/probe projection for an actual draw, without materializing the scene. */
  readonly drawSnapshotAt?: (slot: number) => RenderableSnapshot | undefined;
  /** Roots `drawSnapshotAt` reads; retained consumers link two states through their diff. */
  readonly draws?: DrawEvidence;
  /** Native Scene's existing entity index; borrowed states can omit this projection. */
  readonly slotForEntity?: (worldId: number, entityKey: number) => RenderSceneSlot | undefined;
  /** Stable renderer-local World keys aligned with RenderSceneSlot.worldId. */
  readonly worldKeys?: readonly number[];
  /** Public World identities aligned with RenderSceneSlot.worldId. */
  readonly worldIdentities?: readonly string[];
  readonly structureMetrics?: GpuDrivenStructureMetrics;
  /** Stable retained ProbeBlend upload projection from the Scene owner. */
  readonly probeBlend?: ProbeBlendBufferProjection;
}

/**
 * The one renderer-owned submission projection for a display view.
 *
 * Record and prepare consume the same renderables, dispatch and stable active
 * identity, so CPU direct and GPU indirect lanes never rebuild a second
 * visibility map with different identity semantics.
 */
export interface PersistentVisibilityProjection {
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly dispatch: DispatchList;
  readonly activeEntityKeys: ReadonlySet<number>;
  /** Monotonic owner revision for exactly this active-key projection. */
  readonly activeEntityRevision: number;
}

/** Draw keys the GPU-driven raster owned last primary frame, in its world-key space. */
export interface GpuRasterOwnership {
  readonly selection: GpuDrawSelection;
}

/** One view's state over the shared composition. */
interface ViewEntry {
  readonly shared: CompositionEntry;
  /** This view's submitted history and draw addresses over the shared rows. */
  readonly projection: RenderScene;
  /** Residual rows of this view's submitted GPU selection, kept from topology and selection diffs. */
  readonly residual: ResidualRoster;
  temporalDemanded: boolean;
  /** The shared advance this view last observed. */
  seq: number;
  /** This view's Skin recordings over the shared Skin inputs. */
  skin: SkinFrames | undefined;
}

function sameWorldSequence(
  left: readonly RenderResourceScope[],
  right: readonly RenderResourceScope[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
/**
 * One view's scene state over the renderer's shared {@link SceneComposition}:
 * its own submitted history and draw addresses (a {@link RenderScene} over
 * the shared rows), camera admission and cull memos, residual roster, Skin
 * recordings, GPU raster ownership and shadow projection. Composition,
 * topology, material dispatch, Skin inputs and the GPU Scene are shared;
 * each frame the view only catches up with the latest shared advance.
 */
export class PersistentRenderScene {
  readonly shared: SceneComposition;
  private readonly ownsShared: boolean;
  private readonly stopAssetChanges: (() => void) | undefined;
  private view: ViewEntry | undefined;
  private shadowProjection: PersistentShadowCasterProjection | undefined;
  private readonly materialProgramProjection = new GpuDrivenMaterialProgramProjection();
  private gpuRasterOwned: GpuRasterOwnership | undefined;
  private terrainCandidate: FrameList<RenderableSnapshot> = [];
  private terrainAccepted = new Map<string, RenderableSnapshot>();
  private temporalCapture:
    | { readonly projection: RenderScene; readonly capture: RenderSceneSubmissionCapture }
    | undefined;
  private readonly probeAttachMemo: ProbeAttachMemo = {
    bySnapshot: new WeakMap(),
    previous: undefined,
  };
  private readonly cullMemo: { value: PersistentCullMemo | undefined } = { value: undefined };
  private readonly residualCullMemo: { value: ResidualCullMemo | undefined } = {
    value: undefined,
  };
  private readonly temporalCounters: FrameCacheTally = { hits: 0, misses: 0 };
  private visibilityProjectionHits = 0;
  private visibilityProjectionMisses = 0;
  private visibilityProjectionCache:
    | {
        readonly scene: RenderScene | undefined;
        readonly sceneRevision: number;
        readonly worlds: readonly RenderResourceScope[];
        readonly renderables: FrameList<RenderableSnapshot>;
        readonly dispatch: DispatchList;
        readonly projection: PersistentVisibilityProjection;
      }
    | undefined;
  private visibilityProjectionRevision = 0;
  /** The active set the revision stands for: an owned key copy, or a fixed slot roster. */
  private lastActiveEntityKeys: ReadonlySet<number> | undefined;
  private activeEntityEpoch = -1;
  private pointsLinesInspections: readonly PointsLinesInspection[] = [];
  private readonly reflectionProbes = new ReflectionProbeProjection();

  /** `shared` defaults to a private composition; `ownsShared` disposes it with this view. */
  constructor(
    private readonly options: PersistentRenderSceneOptions = {},
    shared?: SceneComposition,
    ownsShared = shared === undefined,
  ) {
    this.ownsShared = ownsShared;
    this.shared = shared ?? new SceneComposition(options);
    this.stopAssetChanges =
      options.onViewAssetChange === undefined
        ? undefined
        : this.shared.subscribeAssetChanges(options.onViewAssetChange);
  }

  /** Lifetime visibility-projection cache counters (camera-independent key). */
  visibilityProjectionCacheInspection(): FrameCacheCounters {
    return { hits: this.visibilityProjectionHits, misses: this.visibilityProjectionMisses };
  }

  /** Lifetime per-renderable temporal snapshot memo counters. */
  temporalSnapshotCacheInspection(): FrameCacheCounters {
    return { ...this.temporalCounters };
  }

  /** Current fixed pair for actual draw consumers; never copied into wire DTOs. */
  skinRecordingFrame(): SkinSceneFrame | undefined {
    return this.view?.skin?.recordingFrame();
  }

  /** Called at physical queue acceptance, before any post-submit observers. */
  trackSkinSubmittedWork(completed: Promise<void>): Promise<void> | undefined {
    const skin = this.view?.skin,
      frame = skin?.recordingFrame();
    return frame === undefined ? undefined : skin?.trackSubmittedWork(frame, completed);
  }

  discardSkinFrame(): void {
    this.view?.skin?.discardFrame();
  }

  /** Physical work pins both roots even if the Scene picture was not accepted. */
  submitSkinFrame(completed: Promise<void>, accepted: boolean): Promise<void> | undefined {
    const skin = this.view?.skin,
      frame = skin?.recordingFrame();
    return frame === undefined ? undefined : skin?.submitFrame(frame, completed, accepted);
  }

  /** Begin this view's Skin recording over the shared inputs. */
  private prepareSkinFrame(view: ViewEntry): SkinSceneFrame | undefined {
    const inputs = view.shared.skin;
    if (view.skin?.inputs !== inputs) {
      const retired = view.skin;
      view.skin = inputs === undefined ? undefined : new SkinFrames(inputs);
      this.resetSkinHistory(retired);
    }
    try {
      view.skin?.discardFrame();
      return view.skin?.prepareFrame(view.projection.slotsSnapshot());
    } catch (cause) {
      view.skin = undefined;
      this.retireView();
      return this.shared.failSkin(cause);
    }
  }

  /**
   * Catch this view up with `advance`: a view one step behind observes its
   * delta; a new or lapsed view re-pins the complete shared rows and starts
   * its submitted history cold. Asset consumers subscribe independently of drawing.
   */
  private follow(advance: SceneAdvance): ViewEntry {
    let view = this.view;
    if (view === undefined || view.shared !== advance.entry) {
      // A reconciled composition over the same rows keeps this view's
      // submitted history; every other per-view fact restarts with the entry.
      const kept =
        view?.projection.sceneRows === advance.entry.projection.sceneRows ? view : undefined;
      if (kept !== undefined) {
        this.view = undefined;
        this.resetSkinHistory(kept.skin);
      }
      this.retireView();
      view = {
        shared: advance.entry,
        projection: kept?.projection ?? new RenderScene(advance.entry.projection.sceneRows),
        residual: new ResidualRoster(),
        temporalDemanded: false,
        seq: advance.seq - 1,
        skin: undefined,
      };
      this.view = view;
    }
    const projection = view.projection;
    // Shared geometry adoption changes Mesh rows without a row delta.
    projection.observeMeshes();
    if (view.seq === advance.seq) return view;
    if (
      view.seq === advance.seq - 1 &&
      advance.delta !== undefined &&
      projection.observedRows === advance.before
    ) {
      if (advance.remapped) projection.observeRemap();
      projection.observe(advance.delta);
    }
    if (projection.observedRows !== projection.sceneRows.revision) projection.observeBaseline();
    view.seq = advance.seq;
    return view;
  }

  /** Release this view's state over a retired composition. */
  private retireView(): void {
    const view = this.view;
    this.view = undefined;
    this.probeAttachMemo.previous = undefined;
    this.cullMemo.value = undefined;
    this.residualCullMemo.value = undefined;
    this.shadowProjection = undefined;
    this.materialProgramProjection.clear();
    this.temporalCapture = undefined;
    this.terrainCandidate = [];
    this.terrainAccepted.clear();
    this.visibilityProjectionCache = undefined;
    this.invalidateActiveEntityRevision();
    if (view === undefined) return;
    view.projection.dispose();
    this.resetSkinHistory(view.skin);
  }

  /** History roots live in the shared arena: a failed release retires the shared composition. */
  private resetSkinHistory(skin: SkinFrames | undefined): void {
    try {
      skin?.resetHistory();
    } catch (cause) {
      this.shared.failSkin(cause);
    }
  }

  /** World identity is the author/runtime identity; array position is only a frame routing detail. */
  private projectSceneSources(frame: ExtractedFrame, view: ViewEntry) {
    const entry = view.shared;
    const shared = this.shared;
    entry.materialDispatch.prepare(view.projection.meshFrame());
    const terrainView = projectTerrainView(
      frame,
      this.terrainAccepted,
      entry.materialDispatch.materials(),
      entry.worlds,
      shared.terrainSources,
      (world, handle) =>
        shared.prepareMeshMaterial(world, handle, 'terrain', false, shared.sourceAssets),
      shared.terrainLayers,
      view.projection.hasSource('terrain'),
    );
    const glyphView = projectGlyphView(
      terrainView.frame,
      terrainView.materials,
      entry.worlds,
      shared.glyphSources,
      shared.sourceAssets,
      view.projection.hasSource('glyph'),
    );
    return projectTilemapView(
      glyphView.frame,
      glyphView.materials,
      entry.worlds,
      shared.tilemapSources,
      shared.sourceAssets,
      view.projection.hasSource('tilemap'),
    );
  }

  /** Cold initialization is derived from the shared composition, not a second watermark. */
  publicationBaselineRequired(
    resources: RenderResourceScope,
    scene?: PreparedRenderPublication['scene'],
  ): boolean {
    return this.shared.publicationBaselineRequired(resources, scene);
  }

  materialSnapshotCacheStore(context?: MaterialCookRasterContext): MaterialSnapshotCachesByWorld {
    return this.shared.materialSnapshotCacheStore(context);
  }

  visibilityWorldKeysFor(worlds: readonly RenderResourceScope[]): readonly number[] {
    return this.shared.visibilityWorldKeysFor(worlds);
  }

  compositionSlots(): SceneSlotFrame {
    return this.shared.compositionSlots();
  }

  compositionSlot(worldId: number, entityKey: number): RenderSceneSlot | undefined {
    return this.shared.compositionSlot(worldId, entityKey);
  }

  shadowCasterProjection(): PersistentShadowCasterProjection | undefined {
    return this.shadowProjection;
  }

  private stableEntityKey(
    worlds: readonly RenderResourceScope[],
    renderable: Pick<RenderableSnapshot, 'worldId' | 'entityKey'>,
  ): number {
    return worldEntityKey(
      this.shared.visibilityWorldKeysFor(worlds)[renderable.worldId] ?? renderable.worldId,
      renderable.entityKey,
    );
  }
  /**
   * Project extracted renderables into the final primary-raster submission.
   *
   * Occlusion belongs to the GPU two-phase HZB, so this projection passes every
   * renderable through and owns only the stable active-entity identity that
   * production-raster admission caches key on.
   */
  projectVisibility(
    worlds: readonly RenderResourceScope[],
    renderables: FrameList<RenderableSnapshot>,
    dispatch: DispatchList,
    roster?: SceneSlotFrame,
  ): PersistentVisibilityProjection {
    if (this.activeEntityEpoch !== this.shared.activeEntityEpoch) {
      this.activeEntityEpoch = this.shared.activeEntityEpoch;
      this.invalidateActiveEntityRevision();
    }
    const cached = this.visibilityProjectionCache;
    const scene = this.view?.projection;
    const sceneRevision = scene?.revisionValue() ?? 0;
    if (
      cached !== undefined &&
      cached.scene === scene &&
      cached.sceneRevision === sceneRevision &&
      sameWorldSequence(cached.worlds, worlds) &&
      cached.renderables === renderables &&
      cached.dispatch === dispatch
    ) {
      this.visibilityProjectionHits += 1;
      return cached.projection;
    }
    this.visibilityProjectionMisses += 1;
    let activeEntityKeys: ReadonlySet<number>;
    let activeEntityRevision: number;
    if (roster === undefined) {
      const keys = new Set<number>();
      for (const renderable of renderables) keys.add(this.stableEntityKey(worlds, renderable));
      activeEntityKeys = keys;
      activeEntityRevision = this.activeEntityRevision(keys);
    } else {
      const keys = new SlotIdentityKeys(roster, this.visibilityWorldKeysFor(worlds));
      activeEntityKeys = keys;
      activeEntityRevision = this.rosterEntityRevision(keys);
    }
    const projection = { renderables, dispatch, activeEntityKeys, activeEntityRevision };
    this.visibilityProjectionCache = {
      scene,
      sceneRevision,
      worlds: [...worlds],
      renderables,
      dispatch,
      projection,
    };
    return projection;
  }

  /**
   * Advance the projection revision only when the active stable-entity set
   * changes. Camera fingerprints and scene-plan identity cover view/topology
   * changes; keeping this token set-stable preserves the GPU filtered-plan
   * cache on ordinary no-change frames.
   */
  private activeEntityRevision(activeEntityKeys: ReadonlySet<number>): number {
    const previous = this.lastActiveEntityKeys;
    if (
      previous === undefined ||
      previous.size !== activeEntityKeys.size ||
      [...previous].some((key) => !activeEntityKeys.has(key))
    ) {
      this.lastActiveEntityKeys = new Set(activeEntityKeys);
      this.visibilityProjectionRevision += 1;
    }
    return this.visibilityProjectionRevision;
  }

  /** The same set-stable revision for a slot roster, read from its row-change log. */
  private rosterEntityRevision(keys: SlotIdentityKeys): number {
    const previous = this.lastActiveEntityKeys;
    let changed = !(previous instanceof SlotIdentityKeys);
    if (
      previous instanceof SlotIdentityKeys &&
      !keys.changesSince(previous, () => {
        changed = true;
      })
    )
      changed = true;
    this.lastActiveEntityKeys = keys;
    if (changed) this.visibilityProjectionRevision += 1;
    return this.visibilityProjectionRevision;
  }

  private invalidateActiveEntityRevision(): void {
    this.lastActiveEntityKeys = undefined;
    this.visibilityProjectionRevision += 1;
  }
  /** Project probe facts and per-row selection; only changed rows are re-selected. */
  projectReflectionProbes(probes: readonly ReflectionProbeFact[]): void {
    const view = this.view;
    if (view === undefined) return;
    const entry = view.shared;
    const projection = view.projection;
    this.reflectionProbes.update(
      probes,
      {
        identity: entry.token,
        revision: projection.contentRevision + entry.assetRevision,
        slots: projection.slotsSnapshot(),
        materials: entry.materialDispatch.materials(),
        meshes: projection.meshFrame(),
      },
      (slot) => {
        const resolved = projection.cullingWorldBoundsAt(slot);
        if (resolved === undefined || resolved === null) return undefined;
        return [
          (resolved.min[0] + resolved.max[0]) / 2,
          (resolved.min[1] + resolved.max[1]) / 2,
          (resolved.min[2] + resolved.max[2]) / 2,
        ];
      },
    );
  }

  reflectionProbeSelection(worldId: number, entityKey: number): ReflectionProbeSelectionResult {
    return this.reflectionProbes.selection(worldId, entityKey);
  }

  reflectionProbeProjection(): ReturnType<ReflectionProbeProjection['snapshot']> {
    return this.reflectionProbes.snapshot();
  }

  /** Apply a prepared publication to the shared composition, then derive this view's frame. */
  consumePublication(input: PreparedRenderPublication): ExtractedFrame {
    return this.deriveFramePlan(
      this.follow(this.sharedStep(() => this.shared.consume(input))),
      input.frame,
    );
  }

  /** A failed shared step that retired the composition retires this view with it. */
  private sharedStep<T>(step: () => T): T {
    try {
      return step();
    } catch (cause) {
      if (this.view !== undefined && this.view.shared !== this.shared.entry)
        retireInOrder(
          () => {
            throw cause;
          },
          () => this.retireView(),
        );
      throw cause;
    }
  }

  /** Observe the source Worlds into the shared composition, then derive this view's frame. */
  extractComposition(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    assets: AssetRegistry,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases?: readonly RenderReadLease[],
    frameKey?: number,
  ): ExtractedFrame {
    const { advance, resourceFrame } = this.sharedStep(() =>
      this.shared.extract(worlds, owner, assets, buildCandidateFrame, leases, frameKey),
    );
    return this.deriveFramePlan(this.follow(advance), resourceFrame);
  }

  /** Retire one view's derived state without invalidating shared source facts. */
  resetView(): void {
    this.retireView();
  }

  invalidate(): void {
    retireInOrder(
      () => this.retireView(),
      () => this.shared.invalidate(),
    );
  }

  /**
   * Record the draws the GPU-driven raster owned in the last primary frame.
   * Resident renderables whose every draw it owned bypass the CPU frustum cull:
   * the GPU view pass culls them against the same bounds, and a camera move
   * then leaves the admission set, filtered plan and material table unchanged.
   * A renderable with any CPU-drawn residual (blend, transmission, fallback)
   * keeps the CPU cull, since that draw has no GPU cull behind it.
   */
  setGpuDrivenRasterLane(owned: GpuRasterOwnership | undefined): void {
    this.gpuRasterOwned = owned;
  }

  private gpuCullBypass(owner: object): ((snapshot: RenderableSnapshot) => boolean) | undefined {
    const owned = this.gpuRasterOwned;
    if (owned === undefined || !this.shared.gpuResidentFor(owner)) return undefined;
    return (snapshot) => owned.selection.ownsAll(snapshot);
  }

  detach(world: World): void {
    this.shared.detach(world);
    if (this.view !== undefined && this.view.shared !== this.shared.entry) this.retireView();
  }

  /** Drop device-owned state; the shared CPU composition remains the recovery authority. */
  resetGpuForRecover(): void {
    // Device-derived projections restart cold; the next frame rebuilds them
    // from the retained rows through the ordinary path.
    this.shadowProjection = undefined;
    this.materialProgramProjection.clear();
    this.temporalCapture = undefined;
    this.visibilityProjectionCache = undefined;
    retireInOrder(
      () => this.resetSkinHistory(this.view?.skin),
      () => this.shared.resetGpuForRecover(),
    );
  }

  setPointsLinesInspections(inspections: readonly PointsLinesInspection[]): void {
    this.pointsLinesInspections = inspections.map((inspection) => ({
      ...inspection,
      cache: { ...inspection.cache },
      ...(inspection.refusal === undefined ? {} : { refusal: { ...inspection.refusal } }),
    }));
  }

  dispose(): void {
    this.stopAssetChanges?.();
    this.pointsLinesInspections = [];
    retireInOrder(
      () => this.retireView(),
      () => {
        if (this.ownsShared) this.shared.dispose();
      },
    );
  }

  /** Read existing culling bounds; never expose cached mutable arrays. */
  bounds(world: World | RenderPublicationIdentity, entity: number): RenderSceneBounds | undefined {
    return this.shared.bounds(world, entity);
  }

  reflectionCaptureRevision(): string {
    return this.shared.reflectionCaptureRevision();
  }

  topologyRevision(): number {
    return this.shared.topologyRevision();
  }

  materialFrame(): MaterialFrame | undefined {
    return this.shared.materialFrame();
  }

  inspect(): PersistentRenderSceneInspection {
    return { ...this.shared.inspect(), pointsLines: this.pointsLinesInspections };
  }

  /** Current CPU composition is the scene authority even before GPU tables exist. */
  compositionRetainedScene(): RetainedComposition | undefined {
    return this.shared.compositionRetainedScene();
  }

  compositionGpuDrivenState(): PersistentGpuDrivenState | undefined {
    const view = this.view;
    const scene = this.shared.gpuSceneResident;
    if (view === undefined || scene === undefined || view.shared !== this.shared.entry)
      return undefined;
    const entry = view.shared;
    const slots = view.projection.slotsSnapshot();
    const meshes = view.projection.meshFrame();
    const materials = entry.materialDispatch.materials();
    const retained = this.compositionRetainedScene();
    const unavailable = entry.unavailableSlots;
    const sourcePlan = sourcePlanOf(entry);
    const draws: DrawEvidence = {
      slots,
      meshes,
      unavailable,
      probe: entry.probeProjection.recordBufferProjection(),
      temporal: view.projection.temporalDrawInputs(),
    };
    return {
      draws,
      ...(retained === undefined ? {} : { retained }),
      skin: view.skin?.recordingFrame(),
      scene,
      meshes,
      plan: sourcePlan,
      queryPlan: () => entry.topology.query(sourcePlan, meshes, materials),
      completeGeometry: entry.topology.completeGeometry,
      unbatchedSlots: entry.topology.unbatchedSlots,
      pipelinePreparationSlots: view.projection.pipelinePreparationSlots,
      slots,
      slotAt: slots.slotAt,
      drawSnapshotAt: this.slotDraws(view),
      slotForEntity: slots.lookup,
      worldKeys: entry.worldKeys,
      worldIdentities: entry.worlds.map((world) => world.identity),
      structureMetrics: this.shared.structureMetrics,
      probeBlend: entry.probeProjection.recordBufferProjection(),
    };
  }

  /**
   * Draw snapshots by stable slot address: the current row with its Mesh,
   * temporal and probe facts, undefined for absent or unavailable rows.
   * Readers address rows by slot (entity) and never by frame rank.
   */
  private slotDraws(view: ViewEntry): (slot: number) => RenderableSnapshot | undefined {
    const entry = view.shared;
    const unavailable = entry.unavailableSlots;
    const drawAt = view.projection.drawFrame(
      entry.materialDispatch.materials(),
      this.temporalCounters,
      view.projection.meshFrame(),
    );
    const probeAt = entry.probeProjection.captureRecordLookup();
    const probeMemo = this.probeAttachMemo.bySnapshot;
    return (slot) => {
      if (unavailable.has(slot)) return undefined;
      const source = drawAt(slot);
      return source === undefined ? undefined : attachProbeRecord(source, probeAt(slot), probeMemo);
    };
  }

  /**
   * Receipt of a submitted frame. Previous poses were already written when
   * rows changed; the receipt starts the next frame's stamp once per renderer
   * submission and this view's history.
   */
  commitTemporalFrame(terrainReady = true, frameKey?: number): Result<void, RhiError> {
    const shared = this.shared.commitFrame(frameKey, this.temporalCapture !== undefined);
    if (!shared.ok) {
      this.temporalCapture = undefined;
      return shared;
    }

    const temporalCapture = this.temporalCapture;
    if (temporalCapture !== undefined) {
      try {
        temporalCapture.projection.commitSubmission(temporalCapture.capture);
      } catch (cause) {
        void cause;
        this.temporalCapture = undefined;
        return err(
          new RhiError({
            code: 'internal-error',
            expected: 'render scene remains unchanged while a submitted temporal frame commits',
            hint: 'retry the temporal frame after the renderer-owned scene snapshot is stable',
          }),
        );
      }
      this.temporalCapture = undefined;
    }
    if (terrainReady)
      this.terrainAccepted = new Map(
        this.terrainCandidate.flatMap((source) =>
          source.terrainSection === undefined
            ? []
            : [[terrainSectionKey(source, source.terrainSection.index), source] as const],
        ),
      );
    this.terrainCandidate = [];
    return ok(undefined);
  }

  /** Drop a staged temporal capture when the owning frame did not submit. */
  discardTemporalFrame(): void {
    this.terrainCandidate = [];
    this.temporalCapture = undefined;
  }

  /** Capture current CPU scene facts; commitTemporalFrame publishes them only after submit. */
  prepareTemporalFrame(
    visible: Iterable<Pick<RenderableSnapshot, 'worldId' | 'entityKey'>>,
    roster?: SceneSlotFrame,
  ): void {
    const view = this.view;
    this.temporalCapture =
      view === undefined || !view.temporalDemanded
        ? undefined
        : {
            projection: view.projection,
            capture: view.projection.captureSubmission(visible, roster),
          };
  }

  pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
    return this.view?.projection.pointsLinesSnapshots() ?? [];
  }

  /**
   * GPU-lane frames test only residual rows and stay uncompacted; the classic
   * lane, and frames with view-generated rows, compact the culled frame.
   */
  private cullFrame(
    entry: ViewEntry,
    ownedFrame: ExtractedFrame,
    materialFrame: MaterialFrame,
    meshFrame: MeshFrame,
    skinFrame: SkinSceneFrame | undefined,
    hasGeneratedDraws: boolean,
  ): ReturnType<typeof cullPersistentFrame> {
    // Frame rank is roster rank, so a ranked candidate verifies its row
    // instead of searching the identity tree.
    const roster = entry.projection.slotsSnapshot();
    const boundsOf = (
      snapshot: RenderableSnapshot,
      index: number,
      out: box3.Box3,
      row?: RenderSceneSlot,
    ): boolean => {
      const slot =
        sceneRow(row ?? (index >= 0 ? roster.at(index) : undefined), snapshot) ??
        entry.projection.slotOf(snapshot);
      if (snapshot.terrainSection !== undefined || snapshot.generatedMesh !== undefined)
        return writeBounds(worldBounds(snapshot), out);
      return slot === undefined
        ? writeBounds(entry.projection.cullingWorldBounds(snapshot), out)
        : entry.projection.writeCullingWorldBoundsAt(
            slot,
            out,
            meshFrame,
            materialFrame,
            skinFrame,
          );
    };
    const owned = this.gpuCullBypass(entry.shared.token);
    const selection = this.gpuRasterOwned?.selection;
    if (owned !== undefined && selection !== undefined && !hasGeneratedDraws) {
      this.cullMemo.value = undefined;
      return cullResidualFrame(
        ownedFrame,
        materialFrame,
        boundsOf,
        this.gpuOwnedFrame(entry),
        selection,
        this.residualCullMemo,
      );
    }
    this.residualCullMemo.value = undefined;
    return cullPersistentFrame(
      ownedFrame,
      materialFrame,
      boundsOf,
      this.cullMemo,
      owned,
      meshFrame,
      hasGeneratedDraws || entry.shared.unavailableSlots.size > 0
        ? ownedFrame.renderables
        : entry.shared.materialDispatch,
      entry.shared.materialDispatch.revisionValue(),
    );
  }

  /**
   * Residual rows are unbatched geometry and members of uncovered bindings,
   * retained by the view's roster from topology and selection diffs. Slot
   * roster and plan are fixed for this frame; rows resolve by slot address.
   */
  private gpuOwnedFrame(entry: ViewEntry): GpuOwnedFrame {
    const slots = entry.projection.slotsSnapshot();
    const plan = sourcePlanOf(entry.shared);
    const unbatched = entry.shared.topology.unbatchedSlots;
    const dispatch = entry.shared.materialDispatch;

    const rowAt = this.slotDraws(entry);
    // One fixed residual list per selection; frame rows resolve only when read.
    let memo:
      | {
          selection: GpuDrawSelection;
          set: FrameSet;
          records: readonly RenderSceneSlot[];
          rows?: readonly RenderableSnapshot[];
        }
      | undefined;
    const residualOf = (selection: GpuDrawSelection) => {
      if (memo?.selection === selection) return memo;
      const records: RenderSceneSlot[] = [];
      const set = entry.residual.sync(plan, unbatched, selection);
      const unavailable = entry.shared.unavailableSlots;
      for (const slot of set) {
        // An unpublished retained slot keeps its row for recovery but has no
        // dispatch binding or accepted material version; it draws nothing.
        if (unavailable.has(slot)) continue;
        const record = slots.slotAt(slot);
        if (record !== undefined) records.push(record);
      }
      memo = { selection, set, records };
      return memo;
    };
    return {
      residual(selection) {
        const residual = residualOf(selection);
        residual.rows ??= residual.records.flatMap((record) => rowAt(record.slot) ?? []);
        return residual.rows;
      },
      residualSet: (selection) => residualOf(selection).set,
      residualSlots: (selection) => residualOf(selection).records,
      displays(row) {
        const slot = slots.identitySlot(row.worldId, row.entityKey);
        return slot !== undefined && dispatch.displays(slot);
      },
      row(worldId, entity) {
        const slot = slots.identitySlot(worldId, entity);
        return slot === undefined ? undefined : rowAt(slot);
      },
      slots,
    };
  }

  /** Internal topology fact; the renderer does not expose demand as public API. */
  transmissionTopologyDemand(): TransmissionDemand {
    return this.shared.transmissionTopologyDemand();
  }

  /**
   * Derive an ephemeral frame plan from persistent scene facts. The scene
   * retains identity/topology/read versions; no prior frame object is an authority.
   */
  private deriveFramePlan(view: ViewEntry, resourceFrame: ExtractedFrame): ExtractedFrame {
    const entry = view.shared;
    const projection = view.projection;
    const dispatch = this.shared.materialPasses(entry);
    const candidateFrame: ExtractedFrame = {
      ...resourceFrame,
      hiddenEntityReports: entry.hiddenEntityReports,
      visibilityStats:
        entry.sourceStates.length === 0
          ? resourceFrame.visibilityStats
          : { explicitlyHidden: entry.hiddenEntityReports.length },
      dispatch,
    };
    view.temporalDemanded = standardSceneTemporalDemand(
      candidateFrame.cameras[0],
      this.options.getTemporalConsumerDemand?.(),
    );
    projection.setTemporalTracking(view.temporalDemanded);
    this.shared.projectProbes(entry, candidateFrame);
    this.projectReflectionProbes(candidateFrame.reflectionProbes ?? []);
    const materialized = projection.materialize();
    const candidates = view.temporalDemanded
      ? projection.materializeTemporal(
          this.temporalCounters,
          entry.materialDispatch.materials(),
          entry.unavailableSlots.size === 0 ? undefined : entry.unavailableSlots,
        )
      : materialized;
    const acceptedSlots = projection.slotsSnapshot();
    const unavailable = entry.unavailableSlots;
    const drawableCandidates =
      unavailable.size === 0 || view.temporalDemanded
        ? candidates
        : new FrameProjection(candidates, (snapshot) => {
            const slot = acceptedSlots.lookup(snapshot.worldId, snapshot.entityKey);
            return slot !== undefined && unavailable.has(slot.slot)
              ? { ...snapshot, authorVisible: false }
              : snapshot;
          });
    const frameWithProbes = attachProbeRecords(
      { ...candidateFrame, renderables: drawableCandidates },
      drawableCandidates,
      projection.slotsSnapshot(),
      entry.probeProjection,
      this.probeAttachMemo,
    );
    const { frame: ownedFrame, materials: materialFrame } = this.projectSceneSources(
      frameWithProbes,
      view,
    );
    const resource = entry.worlds[0];
    const publicationRevision = entry.publicationRevision;
    const sceneRevision = projection.revisionValue();
    const dispatchRevision = entry.materialDispatch.revisionValue();
    const publicationSource: ShadowPublicationSource | undefined =
      resourceFrame.lights.directionalCsmConfig?.staggerCascades !== true ||
      publicationRevision === undefined ||
      resource === undefined ||
      resource.world !== undefined
        ? undefined
        : {
            resources: resource,
            revision: publicationRevision,
            isCurrent: () =>
              this.shared.entry === entry &&
              entry.worlds.length === 1 &&
              entry.worlds[0] === resource &&
              entry.publicationRevision === publicationRevision &&
              resource.revision === publicationRevision &&
              projection.revisionValue() === sceneRevision &&
              entry.materialDispatch.revisionValue() === dispatchRevision,
          };
    const meshFrame = projection.meshFrame();
    const hasGeneratedDraws =
      projection.hasSource('terrain') ||
      projection.hasSource('glyph') ||
      projection.hasSource('tilemap');
    const skinFrame = this.prepareSkinFrame(view);
    const { frame: result, subsurface } = this.cullFrame(
      view,
      ownedFrame,
      materialFrame,
      meshFrame,
      skinFrame,
      hasGeneratedDraws,
    );
    const materialProgramProjection = this.materialProgramProjection;
    const shadowSlots = projection.slotsSnapshot();
    this.shadowProjection = {
      meshDraws: projection,
      content: {
        materials: materialFrame,
        meshes: meshFrame,
        subsurface,
        owner: view,
        sceneRevision: projection.revisionValue(),
        dispatchRevision: entry.materialDispatch.revisionValue(),
        ...(publicationSource === undefined ? {} : { publicationSource }),
        viewDraws: !hasGeneratedDraws
          ? []
          : ownedFrame.renderables.filter(
              (source) => source.terrainSection !== undefined || source.generatedMesh !== undefined,
            ),
      },
      renderables: ownedFrame.renderables,
      dispatch: ownedFrame.dispatch,
      get materialPrograms() {
        return materialProgramProjection.project(ownedFrame.dispatch, materialFrame);
      },
      worldBoundsOf: (source, out, row) => {
        const slot = sceneRow(row, source) ?? shadowSlots.lookup(source.worldId, source.entityKey);
        return source.terrainSection !== undefined || source.generatedMesh !== undefined
          ? writeBounds(worldBounds(source), out)
          : slot !== undefined &&
              projection.writeCullingWorldBoundsAt(slot, out, meshFrame, materialFrame, skinFrame);
      },
    };

    this.terrainCandidate = !hasGeneratedDraws
      ? []
      : result.renderables.filter(
          (source) => source.terrainSection !== undefined || source.generatedMesh !== undefined,
        );
    return result;
  }
}

/** Run every retirement step; later steps still run after an earlier failure. */
function retireInOrder(...steps: readonly (() => void)[]): void {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 1)
    throw new AggregateError(failures, 'Render Scene retirement failed', { cause: failures[0] });
  if (failures.length === 1) throw failures[0];
}
