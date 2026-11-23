import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  type AssetChange,
  type AssetContentLease,
  runtimeAssetRegistry,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RenderReadLease, RenderReadVersion } from '@forgeax/engine-ecs/projection';
import { readMutationEpoch } from '@forgeax/engine-ecs/projection';
import { box3 } from '@forgeax/engine-math';
import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import type { RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { GlobalTransform, MorphWeights } from '@forgeax/engine-scene';
import {
  assertSceneRosterObservation,
  isSceneRosterObservation,
  type SceneRosterObservation,
} from '@forgeax/engine-scene/internal';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { err, type MeshAsset, ok, type Result, type SkeletonAsset } from '@forgeax/engine-types';
import { planarCaptureDemanded } from '../capture/planar-material';
import { Instances, Lines, Points, SpriteInstances } from '../components';
import type { ResidencyLease } from '../device/residency-lifetime';
import { EnvironmentFrameGate } from '../extract/environment-frame-gate';
import { renderMaterialContextKey } from '../extract/material-context';
import {
  captureHiddenEntityReports,
  isOwnedHiddenEntityReports,
} from '../features/hidden-entity-reports';
import { GlyphSources } from '../glyph-source';
import {
  assertRenderResidencySelection,
  type RenderResidencySelection,
} from '../gpu-driven/batch-residency';
import {
  BatchTopology,
  type BatchTopologyInspection,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { GpuInputArena } from '../gpu-input-arena';
import { GpuScene } from '../gpu-scene';
import type { PersistentRenderSceneInspection } from '../inspection-types';
import type { InstanceProjectionStore } from '../instances';
import { MaterialResource, materialResource } from '../material-resource';
import type { MaterialSourceSnapshot } from '../material-source';
import { RenderPublicationError, type RenderPublicationIdentity } from '../publication/contract';
import { publicationFrameDependencies, renderableAssetRoots } from '../publication/dependencies';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { RenderResourceScope } from '../publication/resource-scope';
import { worldRenderResources } from '../publication/resource-scope';
import type {
  DispatchList,
  ExtractedFrame,
  MaterialSnapshotContexts,
  RenderableSnapshot,
} from '../render-system-extract';
import {
  materialSnapshotContext,
  prepareExtractContext,
  resolveMaterialSnapshot,
} from '../render-system-extract';
import type { TerrainLayers } from '../terrain/layers';
import { TerrainSourceCache } from '../terrain/source';
import { TilemapSources } from '../tilemap-source';
import type { TransmissionDemand } from '../transmission/projection';
import {
  type BoundRenderable,
  publishedRows,
  retiredSlots,
  type SceneMaterialChange,
} from '../world/material-systems';
import { SceneAssetClosure } from './asset-closure';
import { CompositionAdoptionWork } from './composition-adoption';
import { CompositionSkinAdoption } from './composition-skin';
import type { FrameList } from './frame-list';
import { FrameSet } from './frame-set';
import { LocalMeshSource, LocalMeshSourceStage } from './local-mesh-source';
import { MaterialDispatch, type MaterialFrame } from './material-dispatch';
import type { MeshMaterialGeometry } from './mesh-materials';
import type {
  MeshSourceContent,
  MeshSourceResourceInputs,
  MeshSourceResources,
} from './mesh-source-resources';
import { ProbeBlendSceneProjection } from './probe-blend';
import { type PublishedLevelMeshInput, PublishedMeshSource } from './published-mesh-source';
import { boundsFromArray } from './render-scene-snapshots';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneOperation,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';
import { EMPTY_SLOT_FRAME, RenderScene, sceneSnapshotDelta } from './render-scene-view';
import {
  createGlobalTransformChangeQuery,
  createRenderSourceState,
  type GlobalTransformChangeQuery,
  isRenderableMember,
  type RenderSourceChanges,
  readRenderSourceChanges,
} from './render-source';
import type { SceneSlotFrame } from './scene-slots';
import type { SkinSceneInputs } from './skin-scene-inputs';
import {
  MeshSourceStage,
  type MeshSourceStageHost,
  type MeshSourceStageInput,
  publishStagedMeshRows,
  type StagedMeshSource,
  StagedMeshSourceError,
} from './staged-mesh-source';

type WorldTransformSpan = import('./scene-rows').WorldTransformSpan;

/** The normal extract request used by the persistent scene owner. */
export type PersistentRenderCandidateRequest =
  | 'full'
  | 'none'
  | {
      readonly kind: 'partial';
      /** Full entity keys belong to the single source World. */
      readonly entities: ReadonlySet<number>;
    };

/** Renderer-level facts every view of one Renderer shares. */
export interface SceneCompositionOptions {
  readonly terrainLayers?: TerrainLayers;
  readonly assets?: AssetRegistry | undefined;
  readonly shaderRegistry?: ShaderRegistry | undefined;
  readonly getDevice?: (() => RhiDevice) | undefined;
  readonly prepareSourceResources?:
    | ((input: MeshSourceResourceInputs) => MeshSourceResources)
    | undefined;
  readonly onGpuError?: ((error: RhiError) => void) | undefined;
  /** Renderer-owned asset consumer (GPU residency); view consumers subscribe for their lifetime. */
  readonly onAssetChange?: ((scope: RenderResourceScope, change: AssetChange) => void) | undefined;
  readonly retainMaterialSource?:
    | ((scope: RenderResourceScope, source: MaterialSourceSnapshot) => ResidencyLease)
    | undefined;
  /** Instance projection accepted by the same World source update flow. */
  readonly instanceCollections?: InstanceProjectionStore | undefined;
}

/**
 * The renderer's one retained composition: shared rows with a canonical
 * view, batch topology, material dispatch, Skin inputs, probe objects and
 * the request/availability bookkeeping. Every view reads it; none copies it.
 */
export interface CompositionEntry {
  readonly token: object;
  readonly source: RenderResourceScope;
  /** Canonical view over the shared rows; carries the renderer-level submitted history. */
  readonly projection: RenderScene;
  readonly assetClosure: SceneAssetClosure | undefined;
  assetRevision: number;
  readonly topology: BatchTopology;
  hiddenEntityReports: ExtractedFrame['hiddenEntityReports'];
  readVersion: RenderReadVersion | undefined;
  readLease: RenderReadLease | undefined;
  publicationRevision: number | undefined;
  readonly transformQuery: GlobalTransformChangeQuery | undefined;
  readonly sourceState: ReturnType<typeof createRenderSourceState> | undefined;
  readonly materialDispatch: MaterialDispatch;
  skin: SkinSceneInputs | undefined;
  /** Renderable identities whose partial producer still needs a successful publish. */
  readonly pendingRenderableEntities: Set<number>;
  /** Slots retained for recovery but excluded from direct and indirect submission. */
  unavailableSlots: FrameSet;
  readonly probeProjection: ProbeBlendSceneProjection;
}

/**
 * One applied step of the shared composition. A view at `seq - 1` whose rows
 * pin `before` observes `delta`; a view at `seq` is current; any other view
 * re-observes the complete rows.
 */
export interface SceneAdvance {
  readonly entry: CompositionEntry;
  readonly seq: number;
  readonly before: number;
  readonly delta: RenderSceneApplyResult | undefined;
  /** The step remapped World indices of the rows at `before` ahead of `delta`. */
  readonly remapped: boolean;
  readonly materialUpdates: readonly MaterialResource[];
}

/** What a staged step accepts once its material and GPU steps succeeded. */
type SceneAcceptance =
  | {
      readonly kind: 'sources';
      readonly changes: CompositionChanges;
      readonly lease: RenderReadLease;
    }
  | {
      readonly kind: 'recompose';
      readonly sourceState: NonNullable<CompositionEntry['sourceState']>;
      readonly attached: boolean;
    }
  | { readonly kind: 'publication'; readonly revision: number };

/**
 * One composition step's applied rows, appended to the Render World's
 * `RenderSceneRows` journal for its RenderPrepare systems, each consuming it
 * once through its own cursor: material adoption reads `change`, the GPU-owner sync
 * reads `delta`/`materialUpdates`, and the source observation is accepted only
 * after both succeeded, so a failed step re-observes the same changes.
 */
export interface SceneStage {
  readonly entry: CompositionEntry;
  readonly change: SceneMaterialChange;
  readonly delta: RenderSceneApplyResult | undefined;
  readonly materialUpdates: readonly MaterialResource[] | undefined;
  readonly acceptance: SceneAcceptance;
}

/** A local source step: its advance, the resource frame it built, and its staged rows. */
export interface SceneObservation {
  readonly advance: SceneAdvance;
  readonly resourceFrame: ExtractedFrame;
  readonly stage: SceneStage;
}

type PersistentGpuSceneInspection = PersistentRenderSceneInspection['gpu'];

/** The complete retained composition a frame reads, with its source currency checks. */
export interface RetainedComposition {
  readonly identity: object;
  readonly revision: number;
  readonly source: RenderResourceScope;
  readonly slots: FrameList<RenderSceneSlot>;
  readonly materials: MaterialFrame;
  readonly meshes: import('./mesh-frame').MeshFrame;
  isCurrent(): boolean;
  /** The current source still matches the versions consumed by extraction. */
  isSourceCurrent(): boolean;
}

/** The rows' journal a content-only GPU sync still appends to. */
function sceneJournal(projection: RenderScene): Pick<RenderSceneApplyResult, 'journal'> {
  const journal = projection.slotsSnapshot().journal;
  return journal === undefined ? {} : { journal };
}

function sourceMembershipChanged(world: World, slot: RenderSceneSlot): boolean {
  const entity = slot.entityKey as EntityHandle;
  const snapshot = slot.snapshot;
  const skin = (world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
  return (
    !world.hasComponent(entity, GlobalTransform) ||
    (snapshot.instances !== undefined) !== world.hasComponent(entity, Instances) ||
    (snapshot.spriteInstances !== undefined) !== world.hasComponent(entity, SpriteInstances) ||
    (snapshot.skinBinding !== undefined) !== world.hasComponent(entity, skin) ||
    (snapshot.morph !== undefined) !== world.hasComponent(entity, MorphWeights) ||
    (snapshot.pointsLines?.component === 'Points') !== world.hasComponent(entity, Points) ||
    (snapshot.pointsLines?.component === 'Lines') !== world.hasComponent(entity, Lines)
  );
}

/** Every renderable of a frame that has a retained slot, as a bound row. */
function* boundRenderables(
  frame: ExtractedFrame,
  projection: RenderScene,
): Iterable<BoundRenderable> {
  for (const snapshot of frame.renderables) {
    const slot = projection.slot(snapshot.entityKey);
    if (slot !== undefined) yield { slot: slot.slot, snapshot };
  }
}

/** Consume the committed change lanes in their source order. Identity journals already contain
 * one final record per slot. Only allocate a different lane when masking or appending a row. */
function availableSlotLane(
  rows: readonly RenderSceneSlot[],
  unavailable: ReadonlySet<number>,
  replacements?: readonly RenderSceneSlot[],
): readonly RenderSceneSlot[] {
  let result: RenderSceneSlot[] | undefined;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as RenderSceneSlot;
    if (unavailable.has(row.slot)) result ??= rows.slice(0, i);
    else result?.push(row);
  }
  if (replacements !== undefined && replacements.length > 0) {
    result ??= rows.slice();
    for (const row of replacements) result.push(row);
  }
  return result ?? rows;
}

function topologyDeltaForAvailable(
  delta: RenderSceneApplyResult,
  unavailableSlots: ReadonlySet<number>,
  newlyUnavailable: FrameList<RenderSceneSlot>,
): RenderSceneApplyResult {
  let replacements: RenderSceneSlot[] | undefined;
  for (const slot of newlyUnavailable) {
    replacements ??= [];
    replacements.push({ ...slot, snapshot: { ...slot.snapshot, gpuDrivenDraws: [] } });
  }
  const updatedSlots = availableSlotLane(delta.updatedSlots, unavailableSlots, replacements);
  const contentUpdatedSlots = availableSlotLane(
    delta.contentUpdatedSlots,
    unavailableSlots,
    replacements,
  );
  const instanceUpdatedSlots = availableSlotLane(delta.instanceUpdatedSlots, unavailableSlots);
  return updatedSlots === delta.updatedSlots &&
    contentUpdatedSlots === delta.contentUpdatedSlots &&
    instanceUpdatedSlots === delta.instanceUpdatedSlots
    ? delta
    : { ...delta, updatedSlots, contentUpdatedSlots, instanceUpdatedSlots };
}

/** One frame's observed World change evidence, before any producer runs. */
interface CompositionChanges {
  readonly changedEntities: Set<number>;
  readonly contentChanged: Set<number>;
  nextReadVersion: RenderReadVersion | undefined;
  sourceChange: RenderSourceChanges | undefined;
  readonly removedSlots: RenderSceneSlot[];
  readonly transformSpans: WorldTransformSpan[];
}
/** Incremental source observation requires the same lease and resource scope. */
function sameCompositionInputs(
  entry: CompositionEntry,
  world: World,
  lease: RenderReadLease,
): boolean {
  return entry.source.world === world && entry.readLease === lease;
}

/**
 * Change queries have been observed, but this publication never ran.
 * Retain every consumed transform identity for the producer retry.
 */
function retainObservedTransforms(
  entry: CompositionEntry,
  transformSpans: readonly WorldTransformSpan[],
): void {
  for (const span of transformSpans) {
    const pending = entry.pendingRenderableEntities;
    for (const entity of span.entities) {
      if (entry.projection.has(entity)) pending?.add(entity);
    }
  }
}

/** New or content-changed rows replace their snapshot; others update only their instances. */
function partialUpdateOperation(
  entry: CompositionEntry,
  changes: CompositionChanges,
  snapshot: RenderableSnapshot,
): RenderSceneOperation {
  const existing = entry.projection.slot(snapshot.entityKey);
  const contentChanged = existing === undefined || changes.contentChanged?.has(snapshot.entityKey);
  return {
    kind: 'update',
    entityKey: snapshot.entityKey,
    ...(contentChanged || snapshot.instances === undefined
      ? { snapshot }
      : { instances: snapshot.instances }),
  };
}

/** Drop reports for re-requested or departed entities, then append the producer's new ones. */
function refreshHiddenEntityReports(
  entry: CompositionEntry,
  world: World,
  changedEntities: ReadonlySet<number>,
  partial: ExtractedFrame | undefined,
): void {
  const owned =
    isOwnedHiddenEntityReports(entry.hiddenEntityReports) &&
    (partial === undefined || isOwnedHiddenEntityReports(partial.hiddenEntityReports));
  const reports = [
    ...entry.hiddenEntityReports.filter(
      (report) => !changedEntities.has(report.entity) && isRenderableMember(world, report.entity),
    ),
    ...(partial?.hiddenEntityReports ?? []),
  ];
  entry.hiddenEntityReports = owned ? captureHiddenEntityReports(reports) : reports;
}

/** Clear published or departed requests; keep unpublished ones pending and out of dispatch. */
function settleRequestedIdentities(
  entry: CompositionEntry,
  world: World,
  requested: ReadonlySet<number>,
  published: ReadonlySet<number>,
): RenderSceneSlot[] {
  const unpublished: RenderSceneSlot[] = [];
  const pending = entry.pendingRenderableEntities;
  for (const entityKey of requested) {
    const slot = entry.projection.slot(entityKey);
    if (published.has(entityKey)) {
      pending.delete(entityKey);
      continue;
    }
    if (slot === undefined) {
      if (!isRenderableMember(world, entityKey)) pending.delete(entityKey);
      continue;
    }
    pending.add(entityKey);
    unpublished.push(slot);
  }
  return unpublished;
}

/** Mark unpublished retained slots unavailable; return those that just became so. */
function updateUnavailableSlots(
  entry: CompositionEntry,
  requested: ReadonlySet<number>,
  published: ReadonlySet<number>,
  delta: RenderSceneApplyResult,
): RenderSceneSlot[] {
  const newlyUnavailable: RenderSceneSlot[] = [];
  for (const entityKey of requested) {
    const slot = entry.projection.slot(entityKey);
    if (slot === undefined || published.has(entityKey)) {
      if (slot !== undefined) entry.unavailableSlots = entry.unavailableSlots.without(slot.slot);
      continue;
    }
    if (!entry.unavailableSlots.has(slot.slot)) newlyUnavailable.push(slot);
    entry.unavailableSlots = entry.unavailableSlots.with(slot.slot);
  }
  for (const removed of delta.removedSlots)
    entry.unavailableSlots = entry.unavailableSlots.without(removed.slot);
  for (const recreated of delta.recreatedSlots)
    entry.unavailableSlots = entry.unavailableSlots.without(recreated.slot);
  return newlyUnavailable;
}

/** Each removed or (re)published slot replaces its retained asset roots. */
function replaceSlotAssetClosures(entry: CompositionEntry, delta: RenderSceneApplyResult): void {
  const closure = entry.assetClosure;
  if (closure === undefined) return;
  for (const removed of delta.removedSlots) closure.replace(removed.entityKey, []);
  for (const lane of [delta.createdSlots, delta.contentUpdatedSlots, delta.recreatedSlots]) {
    for (const slot of lane) closure.replace(slot.entityKey, renderableAssetRoots(slot.snapshot));
  }
}

/** Accept every validated source batch and adopt its captured membership rows. */
function acceptObservedSources(changes: CompositionChanges): void {
  changes.sourceChange?.accept();
}

const EMPTY_MATERIAL_UPDATES: readonly MaterialResource[] = Object.freeze([]);

/**
 * The renderer's shared scene preparation. It consumes each publication or
 * World change set once, owns the composition, its Skin inputs and the one
 * GPU Scene, and records each applied step as a {@link SceneAdvance}. Views
 * (one {@link PersistentRenderScene} each) hold only camera-dependent state
 * and catch up from the latest advance.
 */
export class SceneComposition {
  private readonly localEnvironment = new EnvironmentFrameGate();

  /** Local views share source light preparation; each still resolves its own cameras. */
  localLightingGate(world: World, assets: AssetRegistry): EnvironmentFrameGate {
    this.localEnvironment.useLocalLightAssets(world, assets);
    return this.localEnvironment;
  }

  private readonly skinAdoption = new CompositionSkinAdoption({
    inputArena: () => this.inputArena(),
    abandon: () => {
      this.composition?.projection.dispose();
      this.composition = undefined;
      this.invalidate();
    },
  });

  /** Skin and Instances adoption this composition's steps leave for their systems. */
  private readonly adoptionWork = new CompositionAdoptionWork<CompositionEntry>();
  private readonly stagedSources = new Set<MeshSourceStage>();
  private sourceCleanupCursor: Iterator<MeshSourceStage> | undefined;
  private sourceEditing = false;
  private pendingStage: SceneStage | undefined;

  /** Internal C0 source records. Native admission remains closed until its real bridge exists. */
  beginStagedGroup(
    observation: SceneRosterObservation,
    content: AssetContentLease,
    lease: RenderReadLease,
  ): Result<StagedMeshSource, StagedMeshSourceError> {
    try {
      return this.editSourceTask(() => {
        if (!isSceneRosterObservation(observation))
          throw new StagedMeshSourceError({ reason: 'source' });
        const entry = this.composition;
        if (entry === undefined || !sameCompositionInputs(entry, observation.world, lease))
          throw new StagedMeshSourceError({ reason: 'session' });
        assertSceneRosterObservation(observation);
        const contextKey = this.materialContextKey;
        const assets = this.sourceAssets,
          materialContext = this.materialContext;
        const context = () =>
          prepareExtractContext(observation.world, {
            ...(assets === undefined ? {} : { assets }),
            ...(materialContext === undefined ? {} : { materialContext }),
            cull: 'none',
            retainHidden: true,
          });
        const source = new LocalMeshSource(observation, context);
        const host = this.sourceStageHost(entry, source, content, {
          validateSession: () => {
            lease.captureVersion();
          },
          current: () =>
            entry.readLease === lease &&
            this.materialContextKey === contextKey &&
            this.sourceAssets === assets &&
            (this.materialContext === undefined
              ? contextKey === undefined
              : renderMaterialContextKey(this.materialContext) === contextKey),
          referenced: (handle) => entry.assetClosure?.assets.has(handle) === true,
          released: () => {
            if (this.composition?.source.world === observation.world)
              for (const entity of observation.members)
                this.composition.pendingRenderableEntities.delete(entity);
          },
        });
        const task = new LocalMeshSourceStage(host, source);
        this.stagedSources.add(task);
        return ok(task);
      });
    } catch (cause) {
      return err(
        cause instanceof StagedMeshSourceError
          ? cause
          : new StagedMeshSourceError({ reason: 'source' }, cause),
      );
    }
  }

  beginPublishedStagedGroup(
    input: PublishedLevelMeshInput,
    referenced: (handle: number) => boolean,
  ): MeshSourceStage {
    return this.editSourceTask(() => {
      const entry = this.composition;
      if (
        entry === undefined ||
        entry.readLease !== undefined ||
        entry.source.revision === undefined
      )
        throw new StagedMeshSourceError({ reason: 'session' });
      const source = new PublishedMeshSource(entry.source, input);
      const host = this.sourceStageHost(entry, source, input.content, {
        validateSession: () => {
          if ((entry.source.revision ?? -1) < 1)
            throw new StagedMeshSourceError({ reason: 'session' });
        },
        current: () => (entry.source.revision ?? -1) >= 1,
        referenced,
      });
      const task = new MeshSourceStage(host, source);
      this.stagedSources.add(task);
      return task;
    });
  }

  private sourceStageHost(
    entry: CompositionEntry,
    input: MeshSourceStageInput,
    content: MeshSourceContent,
    session: {
      validateSession(): void;
      current(): boolean;
      referenced(handle: number): boolean;
      released?(): void;
    },
  ): MeshSourceStageHost {
    const prepareResources = this.options.prepareSourceResources;
    if (this.options.getDevice !== undefined && prepareResources === undefined)
      throw new StagedMeshSourceError({ reason: 'native-bridge-unavailable' });
    for (const task of this.stagedSources)
      for (const entity of input.members)
        if (task.ownsIn(input.namespace, entity))
          throw new StagedMeshSourceError({ reason: 'collision' });
    const materials = this.materialSnapshotCaches;
    return {
      entry,
      validateSession: session.validateSession,
      content,
      materials,
      instances: this.options.instanceCollections,
      prepareResources:
        prepareResources === undefined
          ? undefined
          : (renderables, current, rows) =>
              prepareResources({
                renderables,
                rows,
                content,
                source: entry.source,
                current,
                referenced: (handle) =>
                  this.composition?.source === entry.source && session.referenced(handle),
              }),
      current: () =>
        this.composition === entry &&
        this.materialSnapshotCaches === materials &&
        session.current(),
      edit: (run) => this.editSourceTask(run),
      publish: (delta, before) => this.publishSourceRows(entry, delta, before),
      release: (stage) => {
        this.stagedSources.delete(stage);
        session.released?.();
      },
    };
  }

  private editSourceTask<T>(run: () => T): T {
    if (this.sourceEditing || this.pendingStage !== undefined)
      throw new StagedMeshSourceError({ reason: 'busy' });
    this.sourceEditing = true;
    try {
      return run();
    } finally {
      this.sourceEditing = false;
    }
  }
  private observeSource<T>(run: () => T): T {
    if (this.sourceEditing) throw new StagedMeshSourceError({ reason: 'busy' });
    this.sourceEditing = true;
    try {
      return run();
    } finally {
      this.sourceEditing = false;
    }
  }
  private publishSourceRows(
    entry: CompositionEntry,
    delta: RenderSceneApplyResult,
    before: number,
  ): void {
    replaceSlotAssetClosures(entry, delta);
    publishStagedMeshRows(entry, delta);
    if (this.composition === entry) {
      // Consume the same admitted Data/removals without another render frame.
      this.syncGpuOwner(entry.token, entry.projection, entry.materialDispatch.materials(), delta);
      this.passes = undefined;
      this.plan = undefined;
      this.record(entry, before, delta, []);
    }
  }

  private retireSourceScope(entry: CompositionEntry | undefined): void {
    if (entry !== undefined && [...this.stagedSources].some((task) => task.belongsTo(entry)))
      entry.topology.rebuild(entry.projection.slotsSnapshot());
    this.pendingStage = undefined;
  }

  /** Real owner cleanup quanta; no render frame, source cursor acceptance or whole-store disposal. */
  maintainStagedSources(
    maxSteps: number,
  ): Result<{ readonly remaining: number }, StagedMeshSourceError> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
      return err(new StagedMeshSourceError({ reason: 'source' }));
    const failures: StagedMeshSourceError[] = [];
    for (let step = 0; step < Math.min(maxSteps, this.stagedSources.size); step++) {
      const task = this.nextRetiringSource();
      if (task === undefined) break;
      const result = task.retireStep();
      if (!result.ok) failures.push(result.error);
    }
    const firstFailure = failures[0];
    if (failures.length === 1 && firstFailure !== undefined) return err(firstFailure);
    if (failures.length > 1)
      return err(new StagedMeshSourceError({ reason: 'source' }, new AggregateError(failures)));
    return ok({
      remaining: [...this.stagedSources].filter((task) => task.needsRetirement(this.composition))
        .length,
    });
  }

  private nextRetiringSource(): MeshSourceStage | undefined {
    // The Set remains the owner ledger. The cursor carries scheduling position only.
    for (let scanned = 0; scanned < this.stagedSources.size; scanned++) {
      this.sourceCleanupCursor ??= this.stagedSources.values();
      let next = this.sourceCleanupCursor.next();
      if (next.done) {
        this.sourceCleanupCursor = this.stagedSources.values();
        next = this.sourceCleanupCursor.next();
      }
      if (!next.done && next.value.needsRetirement(this.composition)) return next.value;
    }
    return undefined;
  }

  private drainStagedSources(): unknown {
    const failures: unknown[] = [];
    for (const task of this.stagedSources) {
      const state = task.inspect();
      const limit = state.members * 2 + state.admitted * 3 + 8;
      for (let step = 0; step < limit; step++) {
        const result = task.retireStep();
        if (!result.ok) {
          failures.push(result.error);
          break;
        }
        if (result.value.phase === 'retired') break;
        if (result.value.pending !== undefined) {
          failures.push(new StagedMeshSourceError({ reason: 'busy' }));
          break;
        }
        if (step === limit - 1) failures.push(new StagedMeshSourceError({ reason: 'busy' }));
      }
    }
    return failures.length === 0
      ? undefined
      : new AggregateError(failures, 'Staged source retirement remains owned by this composition');
  }
  private materialSnapshotCaches: MaterialSnapshotContexts = new Map();
  private readonly changedMaterialHandles = new Set<number>();
  private materialContextKey: string | undefined;
  private materialSourceFrame: MaterialFrame | undefined;
  private materialSourceWorlds: RenderResourceScope | undefined;
  private materialSourceLeases = new Map<
    RenderResourceScope,
    Map<MaterialSourceSnapshot, ResidencyLease>
  >();
  private readonly assetConsumers = new Set<
    (scope: RenderResourceScope, change: AssetChange) => void
  >();
  private assetObserver:
    | {
        readonly world: World;
        readonly observer: ReturnType<AssetRegistry['observe']> extends Result<infer T, unknown>
          ? T
          : never;
      }
    | undefined;
  private materialContext: MaterialCookRasterContext | undefined;
  /** Planar capture demand admitted by this source's retained materials. */
  private planarDemand: boolean | undefined;
  private terrainAssets: AssetRegistry | undefined;

  /** The renderer asset service for source projections: the latest observed registry, else the construction option. */
  get sourceAssets(): AssetRegistry | undefined {
    return this.terrainAssets ?? this.options.assets;
  }

  readonly terrainSources = new TerrainSourceCache();
  readonly glyphSources = new GlyphSources();
  readonly tilemapSources = new TilemapSources();
  private composition: CompositionEntry | undefined;
  private latest: SceneAdvance | undefined;
  private advances = 0;
  private passes:
    | {
        readonly entry: CompositionEntry;
        readonly list: DispatchList;
        readonly selection: RenderResidencySelection;
      }
    | undefined;
  private plan:
    | {
        readonly entry: CompositionEntry;
        readonly plan: SubmissionPlan;
        readonly selection: RenderResidencySelection;
      }
    | undefined;
  /** Publication revision and World read epoch the latest advance consumed. */
  private consumedRevision: number | undefined;
  /** Resource-frame roots each World closure fences in the current renderer frame. */
  private resourceFrameRoots: Set<number> | undefined;
  private fullRebuilds = 0;
  private worldEntitiesScanned = 0;
  private sceneTableUploadBytes = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private transformUpdates = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;
  private gpuScene: GpuScene | undefined;
  private readonly retiredGpuScenes = new Set<GpuScene>();
  private gpuOwner: object | undefined;
  private gpuDevice: RhiDevice | undefined;
  private gpuStatus: 'inactive' | 'resident' | 'rebuild-pending' | 'error' = 'inactive';
  private numericArena: GpuInputArena | undefined;
  /** Advances when every view's active-entity revision must restart. */
  activeEntityEpoch = 0;

  constructor(private readonly options: SceneCompositionOptions = {}) {
    if (options.onAssetChange !== undefined) this.assetConsumers.add(options.onAssetChange);
  }

  /** Live private consumers observe shared adoption even while their view does not draw. */
  subscribeAssetChanges(
    listener: (scope: RenderResourceScope, change: AssetChange) => void,
  ): () => void {
    this.assetConsumers.add(listener);
    return () => {
      this.assetConsumers.delete(listener);
    };
  }

  private notifyAssetChange(scope: RenderResourceScope, change: AssetChange): void {
    const failures: unknown[] = [];
    for (const consumer of this.assetConsumers) {
      try {
        consumer(scope, change);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(failures, 'Render asset consumers failed', { cause: failures[0] });
    if (failures.length === 1) throw failures[0];
  }

  get terrainLayers(): TerrainLayers | undefined {
    return this.options.terrainLayers;
  }

  get instanceCollections(): InstanceProjectionStore | undefined {
    return this.options.instanceCollections;
  }

  get entry(): CompositionEntry | undefined {
    return this.composition;
  }

  /** The latest applied step of the current composition. */
  get advance(): SceneAdvance | undefined {
    return this.latest?.entry === this.composition ? this.latest : undefined;
  }

  /** The resident storage-buffer scene the GPU-driven lane culls and draws from. */
  get gpuSceneResident(): GpuScene | undefined {
    const scene = this.residentScene();
    return scene?.backend === 'buffer' ? scene : undefined;
  }

  /** The resident texture-backed scene; direct draws read its rows by `textureLoad`. */
  get gpuSceneTextureResident(): GpuScene | undefined {
    const scene = this.residentScene();
    return scene?.backend === 'texture' ? scene : undefined;
  }

  private residentScene(): GpuScene | undefined {
    const entry = this.composition;
    return entry !== undefined && this.gpuOwner === entry.token && this.gpuStatus === 'resident'
      ? this.gpuScene
      : undefined;
  }

  get structureMetrics() {
    return {
      worldEntitiesScanned: this.worldEntitiesScanned,
      sceneTableUploadBytes: this.sceneTableUploadBytes,
    };
  }

  /** Stage one applied step; its Pass query and batch plan are this step's products. */
  private stage(entry: CompositionEntry, stage: Omit<SceneStage, 'entry'>): SceneStage {
    this.passes = undefined;
    this.plan = undefined;
    this.pendingStage = { entry, ...stage };
    return this.pendingStage;
  }

  /**
   * `render-scene-publish`: sync the GPU Scene owner from the adopted
   * materials, then accept the staged source observation.
   */
  publishStage(stage: SceneStage): void {
    if (this.pendingStage !== stage) throw new StagedMeshSourceError({ reason: 'session' });
    const { entry, acceptance } = stage;
    this.syncGpuOwner(
      entry.token,
      entry.projection,
      entry.materialDispatch.materials(),
      stage.delta,
      stage.materialUpdates,
    );
    this.adoptMaterialSources(entry);
    switch (acceptance.kind) {
      case 'sources': {
        const { changes, lease } = acceptance;
        acceptObservedSources(changes);
        entry.readLease = lease;
        entry.readVersion = changes.nextReadVersion;
        this.pendingStage = undefined;
        return;
      }
      case 'recompose':
        if (acceptance.attached) this.fullRebuilds += 1;
        this.lastResyncReason = 'attach';
        acceptance.sourceState.batch.accept();
        this.pendingStage = undefined;
        return;
      case 'publication':
        this.consumedRevision = acceptance.revision;
        this.pendingStage = undefined;
        return;
    }
  }

  private adoptMaterialSources(entry: CompositionEntry): void {
    const retain = this.options.retainMaterialSource;
    if (retain === undefined) return;
    const materials = entry.materialDispatch.materials();
    if (this.materialSourceFrame === materials && this.materialSourceWorlds === entry.source)
      return;
    const next = new Map<RenderResourceScope, Map<MaterialSourceSnapshot, ResidencyLease>>();
    for (const { source } of entry.materialDispatch.materialSources()) {
      const scope = entry.source;
      if (scope === undefined) continue;
      let sources = next.get(scope);
      if (sources === undefined) {
        sources = new Map();
        next.set(scope, sources);
      }
      if (sources.has(source)) continue;
      sources.set(
        source,
        this.materialSourceLeases.get(scope)?.get(source) ?? retain(scope, source),
      );
    }
    const previous = this.materialSourceLeases;
    this.materialSourceLeases = next;
    this.materialSourceFrame = materials;
    this.materialSourceWorlds = entry.source;
    for (const [scope, sources] of previous)
      for (const [source, lease] of sources)
        if (!next.get(scope)?.has(source)) void lease.release(true);
  }

  private releaseMaterialSources(): void {
    for (const sources of this.materialSourceLeases.values())
      for (const lease of sources.values()) void lease.release(true);
    this.materialSourceLeases.clear();
    this.materialSourceFrame = undefined;
    this.materialSourceWorlds = undefined;
  }

  private record(
    entry: CompositionEntry,
    before: number,
    delta: RenderSceneApplyResult | undefined,
    materialUpdates: readonly MaterialResource[],
    remapped = false,
  ): SceneAdvance {
    if (delta !== undefined) this.glyphSources.adoptRows(delta);
    this.advances += 1;
    this.latest = Object.freeze({
      entry,
      seq: this.advances,
      before,
      delta,
      remapped,
      materialUpdates,
    });
    return this.latest;
  }

  prepareMeshMaterial(
    world: RenderResourceScope | undefined,
    handle: number,
    geometry: MeshMaterialGeometry,
    vertexColor: boolean,
    assets = this.options.assets,
  ): MaterialResource {
    if (assets === undefined && world?.world?.assets !== undefined)
      assets = runtimeAssetRegistry(world.world.assets);
    if (world === undefined || assets === undefined)
      throw new Error(
        'Mesh material preparation requires an accepted resource scope and asset service',
      );
    const contexts = this.materialSnapshotCaches;
    const revision = world.assetRevision(handle);
    const publication = world.revision;
    const context = this.materialContextKey;
    const snapshot = resolveMaterialSnapshot(
      handle,
      world,
      assets,
      undefined,
      materialSnapshotContext(contexts, geometry, vertexColor),
      this.materialContext === undefined ? undefined : { ...this.materialContext, geometry },
      undefined,
      vertexColor,
      geometry,
    );
    if (
      world.assetRevision(handle) !== revision ||
      world.revision !== publication ||
      this.materialContextKey !== context
    )
      throw new Error('Material source changed during Pass preparation');
    return MaterialResource.from(snapshot);
  }
  private adoptAssetChanges(
    world: World,
    assets: AssetRegistry,
  ): { readonly materialUpdates: readonly MaterialResource[]; readonly changed: boolean } {
    let updates: MaterialResource[] | undefined;
    let changed = false;
    if (world.assets !== undefined) {
      const records = runtimeAssets(world.assets);
      if (this.assetObserver?.world !== world) {
        this.assetObserver?.observer.dispose();
        this.assetObserver = { world, observer: records.observe().unwrap() };
        for (const { cache } of this.materialSnapshotCaches.values()) cache.resetSourceObserver();
      }
      const observer = this.assetObserver.observer;
      const batch = observer.read().unwrap();
      const observedRevision = records.currentRevision;
      this.terrainSources.adopt(worldRenderResources(world), batch.changes);
      this.glyphSources.adopt(worldRenderResources(world), batch.changes);
      this.tilemapSources.adopt(worldRenderResources(world), batch.changes);
      this.options.terrainLayers?.adopt(worldRenderResources(world), batch.changes);
      changed ||= batch.changes.length > 0;
      const closure = this.composition?.assetClosure;
      if (closure !== undefined) {
        const previous = closure.revision;
        closure.adopt(batch.changes);
        if (closure.revision !== previous && this.composition !== undefined)
          this.composition.assetRevision++;
      }
      const contexts = this.materialSnapshotCaches;
      for (const change of batch.changes) {
        this.adoptLocalAsset(world, change);
      }
      const sourceChanges =
        observedRevision === records.currentRevision
          ? batch.changes
          : observer.read().unwrap().changes;
      const resources = worldRenderResources(world);
      const handles = this.changedMaterialHandles;
      for (const { cache, geometry, vertexColor } of contexts.values()) {
        handles.clear();
        for (const change of batch.changes) {
          if (change.removed) cache.delete(change.handle);
          else if (cache.has(change.handle)) handles.add(change.handle);
        }
        cache.collectSourceChanges(resources, sourceChanges, handles, 'all');
        for (const handle of handles) {
          const previous = cache.get(handle)?.snapshot;
          const snapshot = resolveMaterialSnapshot(
            handle,
            resources,
            assets,
            undefined,
            cache,
            this.materialContext === undefined ? undefined : { ...this.materialContext, geometry },
            undefined,
            vertexColor,
          );
          const resource = materialResource(snapshot);
          if (resource !== undefined && snapshot !== previous) {
            updates ??= [];
            updates.push(resource);
            changed = true;
          }
        }
      }
      handles.clear();
      batch.accept();
    }
    return { materialUpdates: updates ?? EMPTY_MATERIAL_UPDATES, changed };
  }
  /** A capture demand flip re-routes this source's cached planar receivers. */
  private adoptPlanarRouting(world: World, assets: AssetRegistry): MaterialResource[] | undefined {
    const demanded = planarCaptureDemanded(world);
    if (this.planarDemand === demanded) return undefined;
    this.planarDemand = demanded;
    const resources = worldRenderResources(world);
    let updates: MaterialResource[] | undefined;
    const handles = this.changedMaterialHandles;
    for (const { cache, geometry, vertexColor } of this.materialSnapshotCaches.values()) {
      handles.clear();
      cache.collectPlanarChanges(demanded, handles);
      for (const handle of handles) {
        const snapshot = resolveMaterialSnapshot(
          handle,
          resources,
          assets,
          undefined,
          cache,
          this.materialContext === undefined ? undefined : { ...this.materialContext, geometry },
          undefined,
          vertexColor,
        );
        const resource = materialResource(snapshot);
        if (resource === undefined) continue;
        updates ??= [];
        updates.push(resource);
      }
    }
    handles.clear();
    return updates;
  }

  private adoptLocalAsset(world: World, change: AssetChange): void {
    if (world.assets === undefined) return;
    this.notifyAssetChange(worldRenderResources(world), change);
    const mesh = change.removed
      ? undefined
      : runtimeAssets(world.assets).borrow<MeshAsset>(change.handle);
    if (
      (change.removed || (mesh?.ok && mesh.value.kind === 'mesh')) &&
      this.composition?.projection.adoptMesh(change.handle, mesh?.ok ? mesh.value : undefined) ===
        true &&
      isMeshContentPatch(change)
    )
      this.composition?.topology.recordContentPatch();
    const skeleton = this.composition?.skin;
    if (skeleton !== undefined) {
      const definition = change.removed
        ? undefined
        : runtimeAssets(world.assets).borrow<SkeletonAsset>(change.handle);
      this.skinAdoption.skeleton(
        this.composition as CompositionEntry,
        change.handle,
        definition?.ok && definition.value.kind === 'skeleton' ? definition.value : undefined,
      );
    }
  }
  private inputArena(): GpuInputArena {
    this.numericArena ??= new GpuInputArena();
    this.numericArena.assertLive();
    return this.numericArena;
  }
  /** Check before capturing/adopting a composition, never midway through an edit. */
  private retireFailedInputArena(): void {
    const arena = this.numericArena;
    if (arena === undefined) return;
    try {
      arena.assertLive();
      return;
    } catch (cause) {
      const scene = this.gpuScene,
        device = this.gpuDevice;
      this.numericArena = undefined;
      this.gpuScene = undefined;
      this.gpuDevice = undefined;
      this.gpuOwner = undefined;
      this.gpuStatus = this.options.getDevice === undefined ? 'inactive' : 'rebuild-pending';
      const failures: unknown[] = [];
      // Abandon the failed address space before Skin/GPU owners release ranges.
      // Their physical buffers retain their existing submission completion owner.
      try {
        arena.dispose();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      try {
        this.invalidate();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      try {
        this.retireGpuScene(scene, device);
      } catch (cleanup) {
        failures.push(cleanup);
      }
      if (failures.length > 0)
        throw new AggregateError([cause, ...failures], 'Failed numeric arena retirement', {
          cause,
        });
    }
  }
  /** Cold initialization is derived from the retained source, not a second watermark. */
  publicationBaselineRequired(
    resources: RenderResourceScope,
    scene?: PreparedRenderPublication['scene'],
  ): boolean {
    this.retireFailedInputArena();
    const entry = this.composition;
    if (entry === undefined || entry.source !== resources) return true;
    // Another view of this frame already applied this publication.
    if (this.latest?.entry === entry && this.consumedRevision === resources.revision) return false;
    return (
      scene !== undefined &&
      (entry.projection.sceneRows !== scene.rows || scene.before !== entry.projection.observedRows)
    );
  }

  /** RenderScene owns the per-World material fact cache used during extraction. */
  materialSnapshotCacheStore(context?: MaterialCookRasterContext): MaterialSnapshotContexts {
    this.materialContext = context;
    if (context !== undefined) {
      const key = renderMaterialContextKey(context);
      if (key !== this.materialContextKey) {
        if (this.materialContextKey !== undefined) {
          this.materialSnapshotCaches = new Map();
          this.invalidate();
        }
        this.materialContextKey = key;
      }
    }
    return this.materialSnapshotCaches;
  }

  /** Current retained slots, available to CPU query transport as well as GPU. */
  compositionSlots(): SceneSlotFrame {
    return this.composition?.projection.slotsSnapshot() ?? EMPTY_SLOT_FRAME;
  }

  compositionSlot(entityKey: number): RenderSceneSlot | undefined {
    return this.composition?.projection.slot(entityKey);
  }
  /**
   * Apply one prepared publication to the shared composition. Every view of
   * a frame passes the same publication revision; only the first applies it.
   */
  consume(input: PreparedRenderPublication): {
    readonly advance: SceneAdvance;
    readonly stage: SceneStage | undefined;
  } {
    return this.observeSource(() => this.consumePublication(input));
  }
  private consumePublication(input: PreparedRenderPublication): {
    readonly advance: SceneAdvance;
    readonly stage: SceneStage | undefined;
  } {
    const { resources, packet } = input;
    const current = this.composition;
    if (
      current !== undefined &&
      this.latest?.entry === current &&
      this.consumedRevision === packet.revision &&
      current.source === resources
    )
      return { advance: this.latest, stage: undefined };
    this.adoptionWork.clear();
    this.validatePublication(input);
    const fresh = current === undefined || packet.baseline;
    const entry = fresh ? this.initializePublication(input) : current;
    if (entry === undefined) throw new Error('publication admission requires a composition');
    entry.projection.setSource(resources);
    this.worldEntitiesScanned = 0;
    this.sceneTableUploadBytes = 0;
    this.terrainSources.adopt(resources, input.assetChanges);
    this.glyphSources.adopt(resources, input.assetChanges);
    this.tilemapSources.adopt(resources, input.assetChanges);
    this.options.terrainLayers?.adopt(resources, input.assetChanges);
    this.seedPublishedMaterials(input);
    const before = fresh ? -1 : entry.projection.observedRows;
    for (const change of input.assetChanges) this.adoptPublishedAsset(entry, resources, change);
    const delta = this.applyPublicationRows(entry, input, fresh);
    this.advancePublicationRevision(entry, packet);
    // Every published row (complete snapshot) replaces its slot's dispatch binding.
    const stage = this.stage(entry, {
      change: {
        retired: retiredSlots(delta),
        bound: publishedRows(delta),
        topology: delta,
        materialUpdates: input.materialUpdates,
      },
      delta,
      materialUpdates: input.materialUpdates,
      acceptance: { kind: 'publication', revision: packet.revision },
    });
    return { advance: this.record(entry, before, delta, input.materialUpdates), stage };
  }

  private validatePublication(input: PreparedRenderPublication): void {
    const { resources, packet } = input;
    if (resources.revision !== packet.revision)
      throw new RenderPublicationError({
        reason: 'revision',
        subject: 'stale prepared scene input',
      });
    if (this.publicationBaselineRequired(resources, input.scene) && !packet.baseline)
      throw new RenderPublicationError({
        reason: 'base',
        subject: 'complete source baseline for cold scene admission',
      });
  }

  private initializePublication(input: PreparedRenderPublication): CompositionEntry {
    const { resources, packet } = input;
    this.invalidate();
    // Every view reads the receiver's shared rows; it owns only derived state.
    const projection = new RenderScene(input.scene.rows, input.scene.stageRows);
    const entry: CompositionEntry = {
      token: {},
      source: resources,
      projection,
      assetClosure: undefined,
      assetRevision: 0,
      topology: new BatchTopology(),
      hiddenEntityReports: [],
      readVersion: undefined,
      readLease: undefined,
      publicationRevision: packet.revision,
      transformQuery: undefined,
      sourceState: undefined,
      materialDispatch: new MaterialDispatch((handle, geometry, vertexColor) =>
        this.prepareMeshMaterial(resources, handle, geometry, vertexColor),
      ),
      skin: undefined,
      pendingRenderableEntities: new Set(),
      unavailableSlots: new FrameSet(),
      probeProjection: new ProbeBlendSceneProjection(),
    };
    this.composition = entry;
    this.fullRebuilds++;
    this.lastResyncReason = 'attach';
    return entry;
  }

  private seedPublishedMaterials(input: PreparedRenderPublication): void {
    const { resources } = input;
    // A publication already owns these exact prepared resources. Seed the same
    // context cache used by local preparation, so actual Mesh selection reuses
    // its identity instead of creating a second projection and GPU upload.
    const contexts = this.materialSnapshotCaches;
    for (const material of input.materialUpdates) {
      const snapshot = material.snapshot;
      const context = snapshot.materialContext;
      const handle = snapshot.materialHandle;
      if (context === undefined || handle === undefined) continue;
      materialSnapshotContext(contexts, context.geometry, context.vertexColor).set(handle, {
        snapshot,
        assetRevision: resources.assetRevision(handle) ?? 0,
      });
    }
  }

  private adoptPublishedAsset(
    entry: CompositionEntry,
    resources: RenderResourceScope,
    change: AssetChange,
  ): void {
    this.notifyAssetChange(resources, change);
    const mesh = change.removed ? undefined : resources.resolveAsset<MeshAsset>(change.handle);
    if (
      (change.removed || (mesh?.ok && mesh.value.kind === 'mesh')) &&
      entry.projection.adoptMesh(change.handle, mesh?.ok ? mesh.value : undefined) &&
      isMeshContentPatch(change)
    )
      entry.topology.recordContentPatch();
    const definition = change.removed
      ? undefined
      : resources.resolveAsset<SkeletonAsset>(change.handle);
    this.skinAdoption.skeleton(
      entry,
      change.handle,
      definition?.ok && definition.value.kind === 'skeleton' ? definition.value : undefined,
    );
    this.adoptPublishedMaterial(entry, resources, change);
  }

  private adoptPublishedMaterial(
    entry: CompositionEntry,
    resources: RenderResourceScope,
    change: AssetChange,
  ): void {
    const materialDispatch = entry.materialDispatch;
    for (const { cache, geometry, vertexColor } of this.materialSnapshotCaches.values()) {
      const cached = cache.get(change.handle);
      if (cached === undefined) continue;
      if (change.removed) {
        cache.delete(change.handle);
        continue;
      }
      if (cached.assetRevision === change.revision) continue;
      const assets = this.options.assets;
      if (assets === undefined)
        throw new Error('Published material adoption requires the renderer asset service');
      const snapshot = resolveMaterialSnapshot(
        change.handle,
        resources,
        assets,
        undefined,
        cache,
        this.materialContext === undefined ? undefined : { ...this.materialContext, geometry },
        undefined,
        vertexColor,
      );
      materialDispatch.adopt(MaterialResource.from(snapshot));
    }
  }

  private applyPublicationRows(
    entry: CompositionEntry,
    input: PreparedRenderPublication,
    fresh: boolean,
  ): RenderSceneApplyResult {
    const { packet } = input;
    let delta: RenderSceneApplyResult;
    // A new view starts at the complete current rows; later deltas apply only
    // on top of the rows revision the view observed.
    if (fresh) delta = entry.projection.observeBaseline();
    else if (
      input.scene.delta === undefined ||
      input.scene.before !== entry.projection.observedRows
    )
      throw new RenderPublicationError({
        reason: 'base',
        subject: 'complete source baseline for an unobserved row delta',
      });
    else {
      delta = input.scene.delta;
      entry.projection.observe(
        delta,
        input.operations.length + delta.updatedSlots.length - delta.contentUpdatedSlots.length,
      );
    }
    this.adoptionWork.skin.push(
      { kind: 'rows', entry, delta },
      {
        kind: 'published',
        entry,
        baseline: packet.baseline,
        retired: input.skinJoints?.retired ?? [],
        rows: input.skinJoints?.rows ?? [],
        entities: packet.transformEntities,
        transforms: packet.transforms,
      },
    );
    if (
      delta.created + delta.recreated + delta.contentUpdatedSlots.length > 0 ||
      packet.removed.length
    ) {
      this.activeEntityEpoch += 1;
    }
    if (input.operations.length || delta.created > 0 || delta.updated > 0) this.deltaFrames++;
    else this.noChangeFrames++;
    this.transformUpdates += delta.updated;
    return delta;
  }

  private advancePublicationRevision(
    entry: CompositionEntry,
    packet: PreparedRenderPublication['packet'],
  ): void {
    if (
      packet.assets.length > 0 ||
      packet.assetPatches.length > 0 ||
      packet.materials.length > 0 ||
      packet.retiredAssets.length > 0
    )
      entry.assetRevision++;
    entry.publicationRevision = packet.revision;
  }
  /**
   * Observe the source Worlds into the shared composition. The Render World
   * `render-scene` system calls it once per renderer frame; every view then
   * follows the returned advance with its own resource frame.
   */
  extract(
    world: World,
    assets: AssetRegistry,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    lease: RenderReadLease,
  ): SceneObservation {
    return this.observeSource(() => this.extractSources(world, assets, buildCandidateFrame, lease));
  }
  private extractSources(
    world: World,
    assets: AssetRegistry,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    lease: RenderReadLease,
  ): SceneObservation {
    this.adoptionWork.clear();
    this.retireFailedInputArena();
    this.worldEntitiesScanned = 0;
    this.sceneTableUploadBytes = 0;
    this.terrainAssets = assets;
    const adopted = this.adoptAssetChanges(world, assets);
    let materialUpdates = adopted.materialUpdates;
    const assetsChanged = adopted.changed;
    const entry = this.composition;
    if (entry === undefined || !sameCompositionInputs(entry, world, lease))
      return this.reconcileComposition(world, buildCandidateFrame, lease);
    const before = entry.projection.observedRows;
    const changes = this.observeCompositionChanges(entry, world, lease);
    for (const entityKey of changes.changedEntities) entry.pendingRenderableEntities.add(entityKey);
    const resourceFrame = buildCandidateFrame('none');
    const planarUpdates = this.adoptPlanarRouting(world, assets);
    if (planarUpdates !== undefined) materialUpdates = [...materialUpdates, ...planarUpdates];
    changes.sourceChange?.validate();
    const applied = this.applyCompositionChanges(entry, world, changes, buildCandidateFrame);
    const changedDelta = applied?.delta;
    if (changedDelta === undefined) this.noChangeFrames += 1;
    else replaceSlotAssetClosures(entry, changedDelta);
    this.resourceFrameRoots = undefined;
    this.fenceResourceFrame(entry.assetClosure, resourceFrame);
    this.adoptionWork.skin.push({ kind: 'initialize', entry });
    const stage = this.stage(entry, {
      change: {
        retired: applied?.retired ?? [],
        bound: applied?.bound ?? [],
        topology: applied?.topology,
        materialUpdates,
      },
      delta: changedDelta,
      materialUpdates,
      acceptance: { kind: 'sources', changes, lease },
    });
    const advance =
      changedDelta === undefined &&
      materialUpdates.length === 0 &&
      !assetsChanged &&
      this.latest?.entry === entry
        ? this.latest
        : this.record(entry, before, changedDelta, materialUpdates);
    return { advance, resourceFrame, stage };
  }

  /** Read each World's change evidence into one frame's requested identities and spans. */
  private observeCompositionChanges(
    entry: CompositionEntry,
    world: World,
    lease: RenderReadLease,
  ): CompositionChanges {
    const changes: CompositionChanges = {
      changedEntities: new Set(entry.pendingRenderableEntities),
      contentChanged: new Set(entry.pendingRenderableEntities),
      nextReadVersion: entry.readVersion,
      sourceChange: undefined,
      removedSlots: [],
      transformSpans: [],
    };
    this.observeWorldChanges(entry, world, lease, changes);
    return changes;
  }

  private observeWorldChanges(
    entry: CompositionEntry,
    world: World,
    lease: RenderReadLease,
    changes: CompositionChanges,
  ): void {
    const source = entry.sourceState;
    const version = entry.readVersion;
    if (source === undefined || version === undefined) return;
    const read = lease.readChanges(version);
    changes.nextReadVersion = read.version;
    const changed = changes.changedEntities;
    const content = changes.contentChanged;
    if (changed === undefined || content === undefined) return;
    if (version.structureEpoch !== read.version.structureEpoch) {
      this.activeEntityEpoch += 1;
    }
    const observed = readRenderSourceChanges(
      world,
      source,
      {
        has: (entity) => entry.projection.has(entity),
        changed: (entity) => {
          const slot = entry.projection.slot(entity);
          return slot !== undefined && sourceMembershipChanged(world, slot);
        },
      },
      false,
      { changed, content, removed: new Set() },
    );
    changes.sourceChange = observed;
    this.worldEntitiesScanned += observed.batch.scannedRows;
    this.reconcileSourceIdentities(entry, observed, changes);
    for (const entity of content) changed.add(entity);
    const query = entry.transformQuery;
    if (query === undefined) return;
    for (const span of query.spans().unwrap()) {
      const matrices = span.get(GlobalTransform).world;
      if (!(matrices instanceof Float32Array))
        throw new Error('GlobalTransform projection must expose a numeric column.');
      changes.transformSpans.push({ entities: span.entities, worlds: matrices });
      if (entry.skin !== undefined)
        this.adoptionWork.skin.push({ kind: 'joints', entry, entities: span.entities });
    }
  }
  /** Both local admission and Worker publication consume the same source change facts. */
  private reconcileSourceIdentities(
    entry: CompositionEntry,
    source: RenderSourceChanges,
    changes: CompositionChanges,
  ): void {
    const changed = changes.changedEntities;
    const content = changes.contentChanged;
    if (changed === undefined || content === undefined) return;
    const observed = source.changes;
    for (const entity of observed.removed) {
      const slot = entry.projection.slot(entity);
      if (slot !== undefined) changes.removedSlots.push(slot);
      changed.add(entity);
    }
    if (entry.skin !== undefined && observed.retiredTransforms.size > 0)
      this.adoptionWork.skin.push({
        kind: 'joints',
        entry,
        entities: [...observed.retiredTransforms],
      });
  }
  /** Publish requested identities through the partial producer and apply the resulting delta. */
  private applyCompositionChanges(
    entry: CompositionEntry,
    world: World,
    changes: CompositionChanges,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
  ):
    | (Omit<SceneMaterialChange, 'materialUpdates'> & {
        readonly delta: RenderSceneApplyResult;
      })
    | undefined {
    const { changedEntities, removedSlots, transformSpans } = changes;
    const hasChangedEntities = changedEntities.size > 0;
    if (!hasChangedEntities && removedSlots.length === 0 && transformSpans.length === 0)
      return undefined;
    const operations: RenderSceneOperation[] = [];
    for (const slot of removedSlots) {
      operations.push({ kind: 'remove', entityKey: slot.entityKey });
    }
    let partial: ExtractedFrame | undefined;
    const managed = this.managedSourceRequests(world, changedEntities);
    const publishedEntities = managed.fulfilled;
    let changedDelta: RenderSceneApplyResult;
    try {
      partial =
        managed.ordinary.size > 0
          ? buildCandidateFrame({ kind: 'partial', entities: managed.ordinary })
          : undefined;
      this.validateOrdinarySourceRows(world, partial);
      for (const snapshot of partial?.renderables ?? []) {
        operations.push(partialUpdateOperation(entry, changes, snapshot));
        publishedEntities.add(snapshot.entityKey);
      }
      changes.sourceChange?.validate();
      // This synchronous query owns the source World's borrowed numeric columns.
      changedDelta = entry.projection.apply(operations, transformSpans, world);
    } catch (cause) {
      retainObservedTransforms(entry, transformSpans);
      throw cause;
    }
    this.adoptionWork.skin.push({ kind: 'rows', entry, delta: changedDelta });
    this.queueInstanceSettlement(world, changedDelta, partial);
    if (partial !== undefined || removedSlots.length > 0)
      refreshHiddenEntityReports(entry, world, changedEntities, partial);
    const unpublished = settleRequestedIdentities(entry, world, changedEntities, publishedEntities);
    const newlyUnavailable = updateUnavailableSlots(
      entry,
      changedEntities,
      publishedEntities,
      changedDelta,
    );
    this.deltaFrames +=
      changedDelta.created + changedDelta.updated + changedDelta.removed + changedDelta.recreated >
      0
        ? 1
        : 0;
    this.transformUpdates += changedDelta.updated;
    // An unpublished requested identity keeps its CPU slot but stops
    // submitting stale dispatch. Every published renderable replaces its slot
    // list, including an empty list after failed producer validation.
    return {
      delta: changedDelta,
      retired: [...retiredSlots(changedDelta), ...unpublished],
      bound: partial === undefined ? [] : boundRenderables(partial, entry.projection),
      topology: topologyDeltaForAvailable(changedDelta, entry.unavailableSlots, newlyUnavailable),
    };
  }

  private managedSourceRequests(
    world: World,
    requested: ReadonlySet<number>,
  ): {
    readonly ordinary: ReadonlySet<number>;
    readonly fulfilled: Set<number>;
  } {
    const fulfilled = new Set<number>();
    if (this.stagedSources.size === 0) return { ordinary: requested, fulfilled };
    let ordinary: Set<number> | undefined;
    for (const task of this.stagedSources) {
      // Active gates still need regular currentness checks. A closed gate can
      // affect this update only when the Source asks for one of its members.
      let current = task.isActive() ? task.reuseCurrent() : undefined;
      for (const entity of requested) {
        if (!task.ownsIn(world, entity)) continue;
        ordinary ??= new Set(requested);
        ordinary.delete(entity);
        current ??= task.reuseCurrent();
        if (current && task.fulfills(entity)) fulfilled.add(entity);
      }
    }
    return { ordinary: ordinary ?? requested, fulfilled };
  }

  private validateOrdinarySourceRows(world: World, partial: ExtractedFrame | undefined): void {
    for (const row of partial?.renderables ?? [])
      for (const task of this.stagedSources)
        if (task.ownsIn(world, row.entityKey))
          throw new StagedMeshSourceError({ reason: 'collision' });
  }

  /** Removed slots and published rows release or accept their Instances collections. */
  private queueInstanceSettlement(
    world: World,
    delta: RenderSceneApplyResult,
    partial: ExtractedFrame | undefined,
  ): void {
    if (this.options.instanceCollections === undefined) return;
    const work = this.adoptionWork.instances;
    for (const slot of delta.removedSlots) {
      if (world !== undefined) work.push({ kind: 'release', world, entityKey: slot.entityKey });
    }
    for (const snapshot of partial?.renderables ?? []) {
      if (world === undefined) continue;
      if (snapshot.instances === undefined)
        work.push({ kind: 'release', world, entityKey: snapshot.entityKey });
      else
        work.push({
          kind: 'accept',
          world,
          entityKey: snapshot.entityKey,
          instances: snapshot.instances,
        });
    }
  }
  private reconcileComposition(
    world: World,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    lease: RenderReadLease,
  ): SceneObservation {
    const previous = this.composition;
    const sourceState = createRenderSourceState(world);
    const candidateFrame = buildCandidateFrame({
      kind: 'partial',
      entities: new Set(
        [...sourceState.entities.values()]
          .map((row) => row.entity)
          .filter((entity) => ![...this.stagedSources].some((task) => task.ownsIn(world, entity))),
      ),
    });
    sourceState.batch.validate();
    this.worldEntitiesScanned = candidateFrame.renderables.length;
    this.invalidate();
    const source = worldRenderResources(world);
    const projection = new RenderScene(source);
    const materialDispatch = new MaterialDispatch((handle, geometry, vertexColor) =>
      this.prepareMeshMaterial(source, handle, geometry, vertexColor, this.sourceAssets),
    );
    const delta = this.reconcileRows(projection, candidateFrame.renderables, world);
    const assetClosure = this.reconcileAssetClosure(world, candidateFrame);
    const entry: CompositionEntry = {
      token: {},
      source,
      projection,
      assetClosure,
      assetRevision: 0,
      topology: new BatchTopology(),
      hiddenEntityReports: candidateFrame.hiddenEntityReports,
      readLease: lease,
      publicationRevision: undefined,
      readVersion: lease.captureVersion(),
      transformQuery: createGlobalTransformChangeQuery(world),
      sourceState,
      materialDispatch,
      skin: undefined,
      pendingRenderableEntities: new Set(),
      unavailableSlots: new FrameSet(),
      probeProjection: new ProbeBlendSceneProjection(),
    };
    this.composition = entry;
    if (candidateFrame.renderables.some((snapshot) => snapshot.skinBinding !== undefined))
      this.adoptionWork.skin.push({ kind: 'baseline', entry });
    this.adoptionWork.skin.push({ kind: 'initialize', entry });
    const stage = this.stage(entry, {
      change: {
        retired: [],
        bound: boundRenderables(candidateFrame, projection),
        topology: delta,
        materialUpdates: EMPTY_MATERIAL_UPDATES,
      },
      delta,
      materialUpdates: undefined,
      acceptance: {
        kind: 'recompose',
        sourceState,
        attached: previous === undefined,
      },
    });
    return {
      advance: this.record(entry, -1, delta, EMPTY_MATERIAL_UPDATES),
      resourceFrame: candidateFrame,
      stage,
    };
  }

  private reconcileRows(
    projection: RenderScene,
    renderables: ExtractedFrame['renderables'],
    world: World,
  ): RenderSceneApplyResult {
    const desired = new Set(renderables.map((snapshot) => snapshot.entityKey));
    const operations: RenderSceneOperation[] = [];
    for (const slot of projection.slotsSnapshot()) {
      if (!desired.has(slot.entityKey)) {
        operations.push({ kind: 'remove', entityKey: slot.entityKey });
      }
    }
    for (const snapshot of renderables) {
      operations.push({
        kind: 'update',
        entityKey: snapshot.entityKey,
        snapshot,
      });
    }
    const delta = projection.apply(operations);
    if (this.options.instanceCollections !== undefined) {
      const work = this.adoptionWork.instances;
      for (const snapshot of renderables) {
        if (world !== undefined && snapshot.instances !== undefined)
          work.push({
            kind: 'accept',
            world,
            entityKey: snapshot.entityKey,
            instances: snapshot.instances,
          });
      }
      const collections = new Set<import('../instances').InstanceCollectionId>();
      for (const slot of projection.slotsSnapshot()) {
        const id = slot.snapshot.instances?.collectionId;
        if (id !== undefined) collections.add(id);
      }
      work.push({ kind: 'retain', ids: collections });
    }
    return delta;
  }

  private reconcileAssetClosure(
    world: World,
    candidateFrame: ExtractedFrame,
  ): SceneAssetClosure | undefined {
    const closure = world.assets === undefined ? undefined : new SceneAssetClosure(world.assets);
    for (const row of candidateFrame.renderables)
      closure?.replace(row.entityKey, renderableAssetRoots(row));
    this.resourceFrameRoots = undefined;
    this.fenceResourceFrame(closure, candidateFrame);
    return closure;
  }
  /** Each view adds its resource roots to this frame's accepted source closure. */
  private fenceResourceFrame(closure: SceneAssetClosure | undefined, frame: ExtractedFrame): void {
    if (closure === undefined) return;
    const handles = publicationFrameDependencies(frame);
    const roots = this.resourceFrameRoots ?? new Set<number>();
    const before = roots.size;
    for (const handle of handles) roots.add(handle);
    if (this.resourceFrameRoots === undefined || roots.size !== before)
      closure.replace(-1, [...roots]);
    this.resourceFrameRoots = roots;
  }
  fenceViewResourceFrame(frame: ExtractedFrame): void {
    this.fenceResourceFrame(this.composition?.assetClosure, frame);
  }

  /** Drop the composition; every view re-derives its state from the next advance. */
  invalidate(): void {
    const previous = this.composition;
    this.releaseMaterialSources();
    const skin = this.composition?.skin;
    if (this.composition !== undefined) this.composition.skin = undefined;
    // Owned rows leave with their composition.
    this.composition?.projection.dispose();
    this.retireSourceScope(previous);
    this.composition = undefined;
    this.latest = undefined;
    this.passes = undefined;
    this.consumedRevision = undefined;
    this.materialSnapshotCaches.clear();
    this.planarDemand = undefined;
    this.terrainSources.clear();
    this.glyphSources.clear();
    this.tilemapSources.clear();
    this.activeEntityEpoch += 1;
    this.lastResyncReason = 'explicit-invalidate';
    skin?.dispose();
  }

  /** Whether the GPU Scene is resident for `owner`; GPU-owned rows then skip the CPU cull. */
  gpuResidentFor(owner: object): boolean {
    return (
      this.gpuStatus === 'resident' &&
      this.gpuOwner === owner &&
      this.gpuScene?.backend === 'buffer'
    );
  }

  detach(world: World): void {
    if (this.assetObserver?.world === world) {
      this.assetObserver.observer.dispose();
      this.assetObserver = undefined;
    }
    this.materialSnapshotCaches.clear();
    this.planarDemand = undefined;
    this.terrainSources.detach(worldRenderResources(world));
    this.glyphSources.detach(worldRenderResources(world));
    this.tilemapSources.detach(worldRenderResources(world));
    this.options.terrainLayers?.detach(worldRenderResources(world));
    const detachedComposition =
      this.composition?.source === worldRenderResources(world) ? this.composition : undefined;
    const skin = detachedComposition?.skin;
    if (detachedComposition !== undefined) {
      this.releaseMaterialSources();
      detachedComposition.skin = undefined;
      detachedComposition.projection.dispose();
      this.retireSourceScope(detachedComposition);
      this.composition = undefined;
      this.latest = undefined;
      this.passes = undefined;
      this.activeEntityEpoch += 1;
    }
    if (this.gpuOwner === world || this.gpuOwner === detachedComposition?.token) {
      // The GPU Scene is renderer-owned. A frame graph recorded for the current
      // device may retain its table bindings after a World detaches, while the
      // next attached composition can rebuild the same tables in place. Keep
      // that single scene resident until device replacement or renderer
      // disposal; retiring it here lets a reused graph submit destroyed buffers.
      this.gpuOwner = undefined;
      this.gpuStatus = this.gpuScene === undefined ? 'inactive' : 'resident';
    }
    skin?.dispose();
  }

  /** Drop only device-owned tables; the CPU projection remains the recovery authority. */
  resetGpuForRecover(): void {
    this.releaseMaterialSources();
    const scene = this.gpuScene,
      device = this.gpuDevice;
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = this.options.getDevice === undefined ? 'inactive' : 'rebuild-pending';
    this.retireGpuScene(scene, device);
  }

  /**
   * Apply this frame's observed Skin input changes (the `skin-inputs` system).
   * A failure retires the whole composition and rethrows its cause.
   */
  adoptSkinInputs(): void {
    const work = this.adoptionWork.skin;
    this.adoptionWork.skin = [];
    for (const op of work) {
      const entry = op.entry;
      if (entry !== this.composition) continue;
      switch (op.kind) {
        case 'rows':
          this.skinAdoption.apply(entry, op.delta);
          break;
        case 'baseline':
          this.skinAdoption.apply(entry, sceneSnapshotDelta(entry.projection.slotsSnapshot()));
          break;
        case 'joints':
          for (let index = 0; index < op.entities.length; index++)
            this.skinAdoption.joint(entry, op.entities[index] as number);
          break;
        case 'initialize':
          this.skinAdoption.initializeJoints(entry);
          break;
        case 'published':
          this.skinAdoption.published(
            entry,
            op.baseline,
            op.retired,
            op.rows,
            op.entities,
            op.transforms,
          );
          break;
      }
    }
  }

  /** Settle this frame's accepted Instances collections (the `instance-collections` system). */
  adoptInstanceCollections(): void {
    const work = this.adoptionWork.instances;
    this.adoptionWork.instances = [];
    const collections = this.options.instanceCollections;
    if (collections === undefined) return;
    for (const op of work) {
      switch (op.kind) {
        case 'release':
          collections.release(op.world, op.entityKey);
          break;
        case 'accept':
          collections.accept(op.world, op.entityKey, op.instances);
          break;
        case 'retain':
          collections.retain(op.ids);
          break;
      }
    }
  }

  /** Drop adoption a failed or skipped scene step queued. */
  discardAdoption(): void {
    this.adoptionWork.clear();
  }

  /** Record that a Skin adoption failure retires the composition. */
  failSkin(cause: unknown): never {
    const entry = this.composition;
    if (entry === undefined) throw cause;
    return this.skinAdoption.fail(entry, cause);
  }

  dispose(): void {
    const previous = this.composition;
    this.releaseMaterialSources();
    this.assetConsumers.clear();
    const skin = this.composition?.skin;
    if (this.composition !== undefined) this.composition.skin = undefined;
    this.composition?.projection.dispose();
    this.retireSourceScope(previous);
    this.composition = undefined;
    this.latest = undefined;
    this.passes = undefined;
    this.assetObserver?.observer.dispose();
    this.assetObserver = undefined;
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = 'inactive';
    this.materialSnapshotCaches.clear();
    this.planarDemand = undefined;
    this.terrainSources.clear();
    this.glyphSources.clear();
    this.tilemapSources.clear();
    this.activeEntityEpoch += 1;
    const arena = this.numericArena;
    this.numericArena = undefined;
    let failure: unknown = this.drainStagedSources();
    try {
      skin?.dispose();
    } catch (cause) {
      failure =
        failure === undefined
          ? cause
          : new AggregateError([failure, cause], 'Staged source and Skin retirement failed', {
              cause: failure,
            });
    }
    try {
      arena?.dispose();
    } catch (cause) {
      if (failure !== undefined)
        throw new AggregateError([failure, cause], 'Skin and numeric arena retirement failed', {
          cause: failure,
        });
      throw cause;
    }
    if (failure !== undefined) throw failure;
  }

  private retireGpuScene(scene: GpuScene | undefined, device = this.gpuDevice): void {
    if (scene === undefined) return;
    if (device === undefined) {
      scene.dispose();
      return;
    }
    this.retiredGpuScenes.add(scene);
    const release = (): void => {
      if (!this.retiredGpuScenes.delete(scene)) return;
      scene.dispose();
    };
    // Retirement can happen while the current frame is still being encoded
    // (for example when a new composition token is published).  Calling
    // onSubmittedWorkDone() synchronously at that point observes only work
    // already queued and may resolve before the frame that still references
    // this scene is submitted.  Defer fence acquisition to the next
    // microtask, after the synchronous record/submit transaction has had a
    // chance to enqueue its command buffer.
    void Promise.resolve()
      .then(() => {
        try {
          return device.queue.onSubmittedWorkDone();
        } catch {
          return undefined;
        }
      })
      .then(release, release);
  }

  /** Read existing culling bounds; never expose cached mutable arrays. */
  bounds(world: World | RenderPublicationIdentity, entity: number): RenderSceneBounds | undefined {
    const entry = this.composition;
    const identity = 'source' in world ? `${world.source}:${world.epoch}` : world.identity;
    if (entry === undefined || entry.source.identity !== identity) return undefined;
    const slot = entry.projection.slot(entity);
    if (slot === undefined) return undefined;
    const group = slot.snapshot.residencyGroup;
    if (group !== undefined && !entry.topology.captureResidencySelection().includes(group))
      return undefined;
    const bounds =
      slot.snapshot.skinBinding === undefined
        ? entry.projection.cullingWorldBoundsAt(slot)
        : this.skinQueryBounds(entry, slot);
    if (bounds === undefined) return undefined;
    for (const axis of [0, 1, 2] as const) {
      if (
        !Number.isFinite(bounds.min[axis]) ||
        !Number.isFinite(bounds.max[axis]) ||
        bounds.min[axis] > bounds.max[axis]
      )
        return undefined;
    }
    return { min: [...bounds.min], max: [...bounds.max] };
  }

  /** Out-of-frame queries read the latest adopted pose through the same proof
   * and envelope rules as culling; recording state and history never change. */
  private skinQueryBounds(
    entry: CompositionEntry,
    slot: RenderSceneSlot,
  ): RenderSceneBounds | undefined {
    const current = entry.skin?.capture();
    if (current === undefined) return undefined;
    try {
      const out = box3.create();
      const frame = { slots: entry.projection.slotsSnapshot(), current, previous: undefined };
      return entry.projection.writeCullingWorldBoundsAt(slot, out, undefined, undefined, frame)
        ? boundsFromArray(out)
        : undefined;
    } finally {
      current.release();
    }
  }

  reflectionCaptureRevision(): string {
    return `${this.fullRebuilds}:${this.composition?.projection.contentRevision ?? 0}`;
  }

  topologyRevision(): number {
    return this.composition?.topology.revisionValue() ?? 0;
  }
  materialFrame(): MaterialFrame | undefined {
    return this.composition?.materialDispatch.materials();
  }

  inspect(): Omit<PersistentRenderSceneInspection, 'pointsLines'> {
    const entry = this.composition;
    return {
      worldEntitiesScanned: this.worldEntitiesScanned,
      fullRebuilds: this.fullRebuilds,
      noChangeFrames: this.noChangeFrames,
      deltaFrames: this.deltaFrames,
      transformUpdates: this.transformUpdates,
      lastResyncReason: this.lastResyncReason,
      projectionRecords: entry?.projection.recordCount ?? 0,
      cullingBoundsBackingBytes: entry?.projection.cullingBoundsBackingBytes ?? 0,
      ...(entry === undefined
        ? {}
        : { instanceBoundsCache: entry.projection.instanceBoundsStatistics() }),
      ...(entry === undefined ? {} : { probeBlend: entry.probeProjection.inspect() }),
      topology:
        entry?.topology.inspect() ??
        ({
          revision: 0,
          batchCount: 0,
          candidateCount: 0,
          rebuilds: 0,
          patches: 0,
          ineligible: 0,
        } satisfies BatchTopologyInspection),
      gpu: this.inspectGpu(),
    };
  }

  /** Current CPU composition is the scene authority even before GPU tables exist. */
  compositionRetainedScene(): RetainedComposition | undefined {
    const entry = this.composition;
    if (entry === undefined) return undefined;
    const revision = entry.projection.contentRevision + entry.assetRevision;
    const closure = entry.assetClosure;
    const closureRevision = closure?.revision;
    const current = () => {
      if (
        this.composition !== entry ||
        entry.projection.contentRevision + entry.assetRevision !== revision ||
        closure?.revision !== closureRevision
      )
        return false;
      const world = entry.source.world;
      if (closure !== undefined && world !== undefined) {
        const changes =
          this.assetObserver?.world === world ? this.assetObserver.observer.read() : undefined;
        if (changes === undefined || !changes.ok || closure.pending(changes.value.changes))
          return false;
      }
      return true;
    };
    const slots = entry.projection.slotsSnapshot();
    const sourceVersion = entry.readVersion === undefined ? undefined : { ...entry.readVersion };
    const sourceLease = entry.readLease;
    const publicationRevision = entry.publicationRevision;
    return {
      identity: entry.token,
      revision,
      source: entry.source,
      slots,
      materials: entry.materialDispatch.materials(),
      meshes: entry.projection.meshFrame(),
      isCurrent: current,
      isSourceCurrent: () => {
        if (!current()) return false;
        try {
          const source = entry.source;
          if (source.world === undefined) return source.revision === publicationRevision;
          if (
            sourceLease === undefined ||
            sourceVersion === undefined ||
            sourceLease.worldIdentity !== source.identity
          )
            return false;
          const current = sourceLease.captureVersion();
          return (
            current.mutationEpoch === sourceVersion.mutationEpoch &&
            current.structureEpoch === sourceVersion.structureEpoch
          );
        } catch {
          return false;
        }
      },
    };
  }

  /**
   * Publish one accepted Renderer submission: the GPU Scene frame stamp and,
   * when a view staged temporal history, the canonical submitted history. The
   * Render World `render-scene-commit` system runs it once per submission.
   */
  commitFrame(temporal: boolean): Result<void, RhiError> {
    const committed = this.gpuScene?.commitFrame();
    if (committed !== undefined && !committed.ok) return committed;
    const projection = this.composition?.projection;
    if (temporal && projection !== undefined)
      projection.commitSubmission(projection.captureSubmission([], projection.slotsSnapshot()));
    return ok(undefined);
  }

  private inspectGpu(): PersistentGpuSceneInspection {
    if (this.gpuStatus === 'resident' && this.gpuScene !== undefined) {
      return { status: 'resident', ...this.gpuScene.inspect() };
    }
    if (this.gpuStatus === 'rebuild-pending') return { status: 'rebuild-pending' };
    if (this.gpuStatus === 'error') return { status: 'error' };
    return { status: 'inactive' };
  }

  /** Internal topology fact; the renderer does not expose demand as public API. */
  transmissionTopologyDemand(): TransmissionDemand {
    return (
      this.composition?.materialDispatch.materials().transmissionDemand ?? {
        activeCount: 0,
        needsRoughMips: false,
      }
    );
  }

  /** Validate the whole source domain before publishing an actual Pass query. */
  /**
   * The Pass query of the latest step. Each query is one dispatch-entry
   * generation, so every view of a frame reads this one list instead of
   * re-querying.
   */
  materialPasses(entry: CompositionEntry): DispatchList {
    const passes = this.passes;
    if (passes === undefined || passes.entry !== entry)
      throw new Error('Material Passes are read from the composition step that queried them');
    assertRenderResidencySelection(passes.selection);
    return passes.list;
  }

  /** `render-material-passes`: the step's one Pass query; the GPU Scene sync uploads its rows. */
  queryMaterialPasses(entry: CompositionEntry): void {
    this.passes = undefined;
    const selection = entry.topology.captureResidencySelection();
    this.passes = { entry, list: this.queryMaterialPassList(entry, selection), selection };
  }

  /** `render-batch-plan` publishes the step's batch plan. */
  acceptBatchPlan(entry: CompositionEntry, plan: SubmissionPlan): void {
    this.plan = { entry, plan, selection: entry.topology.captureResidencySelection() };
  }

  /** The batch plan of the latest step; every view of a frame reads this one plan. */
  batchPlan(entry: CompositionEntry): SubmissionPlan {
    const plan = this.plan;
    if (plan === undefined || plan.entry !== entry)
      throw new Error('The batch plan is read from the composition step that planned it');
    assertRenderResidencySelection(plan.selection);
    return plan.plan;
  }

  private queryMaterialPassList(
    entry: CompositionEntry,
    selection: RenderResidencySelection,
  ): DispatchList {
    const scope = entry.source;
    const context = this.materialContextKey;
    const revision = entry.projection.revisionValue();
    const records =
      scope.world?.assets === undefined ? undefined : runtimeAssets(scope.world.assets);
    const publication = scope.revision;
    const epoch = scope.world === undefined ? undefined : readMutationEpoch(scope.world);
    const assets = records?.currentRevision;
    let entered = false;
    const validate = () => {
      if (
        this.composition !== entry ||
        entry.source !== scope ||
        this.materialContextKey !== context ||
        entry.projection.revisionValue() !== revision
      )
        throw new Error('Scene source changed during Pass query');
      if (records?.currentRevision !== assets)
        throw new Error('Scene assets changed during Pass query');
      if (
        scope.revision !== publication ||
        (scope.world === undefined && scope.revision !== entry.publicationRevision) ||
        (scope.world !== undefined && readMutationEpoch(scope.world) !== epoch)
      )
        throw new Error('Scene source changed during Pass query');
      const world = scope.world;
      if (world !== undefined && !entered) {
        const pending = (
          this.assetObserver?.world === world ? this.assetObserver.observer.read() : undefined
        )?.unwrap();
        if (pending !== undefined && entry.assetClosure?.pending(pending.changes))
          throw new Error('Scene assets changed during Pass query');
      }
      entered = true;
    };
    return entry.materialDispatch.query(
      entry.projection.slotsSnapshot(),
      entry.projection.meshFrame(),
      validate,
      selection,
    );
  }

  projectProbes(entry: CompositionEntry, frame: ExtractedFrame): void {
    const probes = frame.lightProbes;
    if (!probes?.length && !entry.probeProjection.hasLocalInputs()) return;
    const sky =
      frame.skylight === undefined
        ? {
            available: false,
            irradiance: [0, 0, 0] as const,
            fallbackReason: 'no-skylight',
          }
        : {
            available: true,
            identity: `skylight:${frame.skylight.entityHandle}`,
            sourceKey:
              frame.skylight.equirectHandle > 0
                ? `equirect:${frame.skylight.equirectHandle}`
                : `skylight:${frame.skylight.entityHandle}`,
            irradiance: [
              frame.skylight.color[0] * frame.skylight.intensity,
              frame.skylight.color[1] * frame.skylight.intensity,
              frame.skylight.color[2] * frame.skylight.intensity,
            ] as [number, number, number],
          };
    entry.probeProjection.apply({
      objects: entry.projection.slotsSnapshot(),
      probes: probes ?? [],
      sky,
    });
  }

  private syncGpuOwner(
    owner: object,
    projection: RenderScene,
    materials: MaterialFrame,
    delta?: RenderSceneApplyResult,
    materialUpdates?: readonly MaterialResource[],
  ): void {
    const acquired = this.acquireGpuScene(owner, projection, materials);
    if (acquired === undefined) {
      this.sceneTableUploadBytes = 0;
      return;
    }
    if (acquired.rebuilt) {
      this.sceneTableUploadBytes = acquired.uploadBytes;
      return;
    }
    const result = acquired.scene.sync(
      {
        ...(delta ?? {
          created: 0,
          updated: 0,
          removed: 0,
          recreated: 0,
          ignoredLateUpdates: 0,
          createdSlots: [],
          updatedSlots: [],
          contentUpdatedSlots: [],
          instanceUpdatedSlots: [],
          removedSlots: [],
          recreatedSlots: [],
          previous: new Map(),
          resynced: 0,
          ...sceneJournal(projection),
        }),
        ...(materialUpdates === undefined ? {} : { materialUpdates }),
        meshes: projection.meshFrame(),
        materials,
      },
      projection.gpuMotionReader(),
      projection,
    );
    if (!result.ok) {
      this.sceneTableUploadBytes = 0;
      this.failGpu(result.error);
      return;
    }
    this.sceneTableUploadBytes = result.value.bytes;
  }

  private acquireGpuScene(
    owner: object,
    projection: RenderScene,
    materials: MaterialFrame,
  ):
    | { readonly scene: GpuScene; readonly rebuilt: boolean; readonly uploadBytes: number }
    | undefined {
    const getDevice = this.options.getDevice;
    if (getDevice === undefined) return undefined;
    const device = getDevice();
    if (this.gpuDevice !== undefined && this.gpuDevice !== device) {
      this.retireGpuScene(this.gpuScene, this.gpuDevice);
      this.gpuScene = undefined;
      this.gpuOwner = undefined;
      this.gpuStatus = 'rebuild-pending';
    }
    if (this.gpuStatus === 'error' && this.gpuDevice === device) return undefined;
    if (this.gpuScene !== undefined && this.gpuOwner === owner) {
      return { scene: this.gpuScene, rebuilt: false, uploadBytes: 0 };
    }
    // A new device has no accepted temporal history. Cold flags come from
    // the same current rows as initial extraction, independently of each view.
    const temporal = projection.gpuMotionReader(true);
    if (this.gpuScene !== undefined && this.gpuDevice === device) {
      // Composition rebuilds replace the CPU projection token, but the GPU
      // table resource can be rebuilt in place. Keeping one scene identity
      // avoids destroying buffers that cached frame graphs still reference
      // and lets queue ordering preserve writes across the next submission.
      const slots = projection.slotsSnapshot();
      const rebuilt = this.gpuScene.sync(
        { ...sceneSnapshotDelta(slots), meshes: projection.meshFrame(), materials },
        temporal,
        projection,
      );
      if (!rebuilt.ok) {
        this.failGpu(rebuilt.error);
        return undefined;
      }
      this.gpuOwner = owner;
      this.gpuStatus = 'resident';
      return { scene: this.gpuScene, rebuilt: true, uploadBytes: rebuilt.value.bytes };
    }
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = device;
    const created = GpuScene.create(
      device,
      Math.max(256, projection.slotCapacity),
      this.options.shaderRegistry,
      this.inputArena(),
    );
    if (!created.ok) {
      this.failGpu(created.error);
      return undefined;
    }
    const scene = created.value.scene;
    const slots = projection.slotsSnapshot();
    const rebuilt = scene.sync(
      { ...sceneSnapshotDelta(slots), meshes: projection.meshFrame(), materials },
      temporal,
      projection,
    );
    if (!rebuilt.ok) {
      scene.dispose();
      this.failGpu(rebuilt.error);
      return undefined;
    }
    scene.inputs.activate();
    this.gpuScene = scene;
    this.gpuOwner = owner;
    this.gpuStatus = 'resident';
    return { scene, rebuilt: true, uploadBytes: rebuilt.value.bytes };
  }

  private failGpu(error: RhiError): void {
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuStatus = 'error';
    this.options.onGpuError?.(error);
  }
}

/** Range-only evidence cannot change submeshes, so batch keys and membership stay intact. */
function isMeshContentPatch(change: AssetChange): boolean {
  return (
    !change.removed &&
    change.ranges.length > 0 &&
    change.fields.every(
      (field) =>
        field === 'aabb' ||
        field === 'collision' ||
        field === 'distanceField' ||
        field === 'cardLayout',
    )
  );
}
