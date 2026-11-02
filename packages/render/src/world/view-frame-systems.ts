import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { selectCaptureViewCamera } from '../capture/capture-view';
import { renderMaterialContext } from '../extract/material-context';
import type { PreparedRenderPublication } from '../publication/receiver';
import { type RenderResourceScope, worldRenderResources } from '../publication/resource-scope';
import { type RenderSystemInternals, runProfiledRenderPhase } from '../record/render-context';
import { resetRenderFeatureGraphState } from '../record/typed-frame-graph';
import type { CameraSnapshot, DrawOwnerOptions } from '../render-contract';
import type { ExtractedFrame } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import { canonicalizeWorldComposition, captureOnlyCameras } from '../render-system-projections';
import type {
  PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';
import {
  composedViewCamera,
  type RenderViewFrameSource,
  RenderViewInput,
  ViewRecorder,
} from './render-views';
import { RenderPrepare, renderSubmission } from './render-world';
import {
  RENDER_SCENE_PUBLISH_SYSTEM,
  type RenderSceneAdoption,
  RenderSceneDelta,
  RenderSceneInput,
  type RenderSceneSource,
} from './scene-systems';
import { requireViewField } from './view-field';
import { recordContext } from './view-record-context';
import { adoptViewRecordAttempt } from './view-record-systems';
import { ownerOf, type ViewSettlementOwner } from './view-settlement';
import { adoptViewWorldSource, attachViewWorldSource } from './view-world-routing';

/** System names other Render World systems order against. */
export const RENDER_VIEW_RECORDERS_SYSTEM = 'render-view-recorders';
export const RENDER_VIEW_FRAME_SYSTEM = 'render-view-frame';

/** A view's followed and culled frame, or the structured cause its recording recovers from. */
export type ViewFrameResult =
  | { readonly ok: true; readonly value: ExtractedFrame }
  | { readonly ok: false; readonly cause: unknown };

/**
 * Payload of a view's {@link ViewFrame}. `render-view-recorders` stages the
 * views that record this frame (`frame`, `opts`); `render-view-frame` then
 * resolves the publication the view consumes and its frame: the shared scene
 * adoption followed by this view's camera, culled for this view. The culled
 * frame's renderables are the rows the CPU records; `gpuOwned` names the
 * GPU-driven residual rows. Recording consumes it, never re-extracts.
 */
export interface ViewFrameState {
  frame: number;
  opts: DrawOwnerOptions;
  /**
   * How the view records, decided in RenderExtract: `true` renders its
   * picture, `false` holds it (scene follow only), `'capture'` records only
   * the shared capture view's scene captures.
   */
  mode: ViewRecordMode;
  publication: PreparedRenderPublication | undefined;
  result: ViewFrameResult | undefined;
}

/** Every recording view's frame; staged by `render-view-recorders`, written by `render-view-frame`. */
export const ViewFrame = defineComponent('ViewFrame', { state: 'unique<ViewFrame>' });

/** How a staged view records this frame; see {@link ViewFrameState.mode}. */
export type ViewRecordMode = boolean | 'capture';

/** Private frame adoption; persistent source routing lives in ViewWorldSource. */
class ViewFrameRecord implements ViewFrameState {
  publication: PreparedRenderPublication | undefined;
  result: ViewFrameResult | undefined;
  scopes: ReturnType<typeof ordinaryViewFrameScopes> | undefined;
  inputs: StagedViewInputs | undefined;
  private scopedPublication: PreparedRenderPublication | undefined;
  readonly #world: World;
  readonly #entity: EntityHandle;

  constructor(
    world: World,
    entity: EntityHandle,
    public frame: number,
    public opts: DrawOwnerOptions,
    public mode: ViewRecordMode,
  ) {
    this.#world = world;
    this.#entity = entity;
  }
  static owned(world: World, state: ViewFrameState): ViewFrameRecord | undefined {
    return #world in state && state.#world === world ? state : undefined;
  }
  reset(): void {
    this.scopes = undefined;
    this.inputs = undefined;
  }
  scope(world: World): ReturnType<typeof ordinaryViewFrameScopes> {
    if (this.scopes !== undefined && this.scopedPublication === this.publication)
      return this.scopes;
    const { worlds, leases } = world.getResource<RenderViewFrameSource>(RenderViewInput);
    const routing = adoptViewWorldSource(world, this.#entity, worlds, this.opts);
    this.scopedPublication = this.publication;
    this.inputs = undefined;
    this.scopes = Object.freeze({
      composition: routing.project(leases),
      scopes:
        this.publication === undefined
          ? routing.resources
          : Object.freeze([this.publication.resources]),
    });
    return this.scopes;
  }
}

/** Stage `entity` to record this frame with `opts`; its frame resolves in RenderPrepare. */
export function stageViewFrame(
  world: World,
  entity: EntityHandle,
  opts: DrawOwnerOptions,
  mode: ViewRecordMode = true,
): void {
  adoptViewRecordAttempt(world, entity);
  attachViewWorldSource(world, entity);
  const frame = renderSubmission(world).frame;
  if (world.hasComponent(entity, ViewFrame)) {
    const state = world
      .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
      .unwrap();
    state.frame = frame;
    state.opts = opts;
    state.mode = mode;
    state.publication = state.result = undefined;
    ViewFrameRecord.owned(world, state)?.reset();
    return;
  }
  const state = world.allocUniqueRef(
    'ViewFrame',
    new ViewFrameRecord(world, entity, frame, opts, mode),
  );
  world.addComponent(entity, { component: ViewFrame, data: { state } }).unwrap();
}

/** The view's frame staged for the current renderer frame; undefined when it does not record. */
export function viewFrameOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewFrameState | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewFrame)) return undefined;
  const state = world
    .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
    .unwrap();
  return state.frame === renderSubmission(world).frame ? state : undefined;
}

/** The staged view's canonical composition and the resource scopes it records against. */
export function viewFrameScopes(world: World, staged: ViewFrameState) {
  return (
    ViewFrameRecord.owned(world, staged)?.scope(world) ?? ordinaryViewFrameScopes(world, staged)
  );
}

function ordinaryViewFrameScopes(world: World, staged: ViewFrameState) {
  const { worlds, leases } = world.getResource<RenderViewFrameSource>(RenderViewInput);
  const composition = canonicalizeWorldComposition(worlds, staged.opts, leases);
  const scopes: readonly RenderResourceScope[] =
    staged.publication === undefined
      ? composition.worlds.map(worldRenderResources)
      : [staged.publication.resources];
  return { composition, scopes };
}

/** A staged view's resolved RenderPrepare inputs: its frame, cameras and resource scopes. */
export interface StagedViewInputs extends ReturnType<typeof viewFrameScopes> {
  readonly frame: ExtractedFrame;
  readonly mode: ViewRecordMode;
  /** The view's cameras; a capture-only recording selects its capture camera, as recording does. */
  readonly cameras: CameraSnapshot[];
  /** The scope that owns the frame's resources. */
  readonly resourceWorld: RenderResourceScope;
}

/** The inputs of a staged view whose frame `render-view-frame` resolved this frame. */
export function stagedViewInputs(world: World, staged: ViewFrameState): StagedViewInputs {
  if (staged.result?.ok !== true)
    throw new Error('A view prepares only the frame render-view-frame resolved this frame');
  const frame = staged.result.value;
  const owned = ViewFrameRecord.owned(world, staged);
  const { composition, scopes } = viewFrameScopes(world, staged);
  if (owned?.inputs?.frame === frame) return owned.inputs;
  const result = Object.freeze({
    frame,
    mode: staged.mode,
    cameras:
      staged.mode === 'capture'
        ? captureOnlyCameras(frame.cameras, composition.owners.cameraEntityKey)
        : frame.cameras,
    composition,
    scopes,
    resourceWorld: scopes[composition.owners.resourceOwner] as RenderResourceScope,
  });
  if (owned !== undefined) owned.inputs = result;
  return result;
}

/**
 * The publication a view consumes. Every view reads the Renderer's one scene
 * composition, so only a view that cannot apply the accepted delta (cold,
 * retired or lapsed) receives the full scene snapshot.
 */
export function viewPublication(
  source: RenderViewFrameSource,
  scene: Pick<PersistentRenderScene, 'publicationBaselineRequired'>,
): PreparedRenderPublication | undefined {
  const { publication, receiver } = source;
  if (publication === undefined || receiver === undefined) return publication;
  return scene.publicationBaselineRequired(publication.resources, publication.scene)
    ? receiver.snapshot(publication)
    : publication;
}

/**
 * Keep the compiled graph as last-known-good until the candidate topology
 * compiles. The failed candidate frame does not execute it; successful
 * replacement retires it atomically in ensureCompiledFrameGraph. Feature
 * contributions describe the active pipeline graph, so a hot-swap drops the
 * old graph before the next frame re-runs feature contribution.
 */
function retireSwappedPipelineGraph(
  { frameState, internals, scene }: ViewSettlementOwner,
  publication: PreparedRenderPublication | undefined,
): void {
  const install = frameState.standardInstall;
  if (frameState.installedPipelineHandle === install.built) return;
  resetRenderFeatureGraphState(internals);
  install.built = frameState.installedPipelineHandle;
  if (publication === undefined) scene.resetView();
}

/**
 * A capture view records only its own auxiliary Camera. The rewrite runs
 * before scene consumption so culling, lights and history follow it.
 */
function captureViewFrame<
  F extends Pick<ExtractedFrame, 'cameras' | 'auxiliaryCameras' | 'cubeCameras'>,
>(internals: RenderSystemInternals, frame: F): F {
  const capture = recordContext(internals).captureView;
  if (capture === undefined) return frame;
  const camera = selectCaptureViewCamera(frame.auxiliaryCameras, capture.camera);
  return {
    ...frame,
    cameras: camera === undefined ? [] : [camera],
    auxiliaryCameras: [],
    cubeCameras: [],
  };
}

/**
 * Stage this frame's scene source (the `RenderSceneInput` resource) for the
 * `render-scene` system; the frame entry calls it before `beginRenderFrame`.
 * Only a Render World whose composition owner registered the scene system has one.
 */
export function stageRenderScene(
  world: World,
  owner: ViewSettlementOwner,
  worlds: readonly World[],
  opts: DrawOwnerOptions,
  leases: readonly RenderReadLease[] | undefined,
  publication: PreparedRenderPublication | undefined,
): void {
  if (!world.hasResource(RenderSceneInput))
    throw new Error('Only the scene composition owner stages the frame scene');
  const source = world.getResource<RenderSceneSource>(RenderSceneInput);
  source.staged = true;
  source.publication = publication;
  if (publication !== undefined) return;
  const composition = canonicalizeWorldComposition(worlds, opts, leases);
  source.worlds = composition.worlds;
  source.owner.cameraOwner = composition.owners.cameraOwner;
  source.owner.resourceOwner = composition.owners.resourceOwner;
  source.leases = composition.leases;
  source.buildCandidateFrame = candidateFrameBuilder(
    world,
    owner,
    owner.internals.viewEntity,
    composition,
  );
}

/**
 * Candidate frames of `entity`'s view over the canonical source composition:
 * renderables (`cull: 'none'`) plus the view's cameras and environment.
 */
export function candidateFrameBuilder(
  world: World,
  { internals, scene, frameState }: ViewSettlementOwner,
  entity: EntityHandle | undefined,
  composition: ReturnType<typeof canonicalizeWorldComposition>,
): (renderables: PersistentRenderCandidateRequest) => ExtractedFrame {
  const { worlds: sourceWorlds, owners } = composition;
  const { cameraOwner, resourceOwner, cameraEntityKey } = owners;
  const view = composedViewCamera(world, entity);
  const materialContext = renderMaterialContext(
    internals.device.caps,
    internals.device.limits,
    internals.standardProfile?.visibleSurface === true,
  );
  const materialCaches = scene.materialSnapshotCacheStore(materialContext.materialContext);
  return (renderables) =>
    captureViewFrame(
      internals,
      extractFrames(
        sourceWorlds,
        {
          cameraOwner,
          resourceOwner,
          ...(cameraEntityKey === undefined ? {} : { cameraEntityKey }),
        },
        internals.assets,
        materialCaches,
        {
          ...materialContext,
          cull: 'none',
          ...(view === undefined ? {} : { view }),
          retainHidden: true,
          renderables,
          ...(frameState.instanceCollections === undefined
            ? {}
            : { instanceCollections: frameState.instanceCollections }),
          ...(!internals.device.caps.storageBuffer ||
          internals.getMaterialShaderArtifact === undefined
            ? {}
            : { getMaterialShaderArtifact: internals.getMaterialShaderArtifact }),
        },
      ),
    );
}

/** A view-output receiver keeps only the published camera it presents. */
function followRecordPublication(
  world: World,
  owner: ViewSettlementOwner,
  entity: EntityHandle,
  adoption: RenderSceneAdoption,
  publication: PreparedRenderPublication,
): ExtractedFrame {
  const { internals, scene } = owner;
  if (recordContext(internals).captureView !== undefined)
    return scene.followPublication(adoption, captureViewFrame(internals, publication.frame));
  const view = composedViewCamera(world, entity);
  if (view === undefined) return scene.followPublication(adoption, publication.frame);
  return scene.followPublication(adoption, {
    ...publication.frame,
    cameras: view.camera === undefined ? [] : [view.camera],
  });
}

/**
 * Resolve a staged view's publication and frame: the frame's scene adoption
 * followed with the view's camera and culled for it. The view's frame opens
 * its recording's Skin frame; a pipeline swap retires the old graph's view
 * state before the follow. Never throws: a failure is the view's result.
 */
function prepareViewFrame(
  world: World,
  owner: ViewSettlementOwner,
  entity: EntityHandle,
  source: RenderViewFrameSource,
  state: ViewFrameState,
): ViewFrameResult {
  try {
    const publication = viewPublication(source, owner.scene);
    state.publication = publication;
    ViewFrameRecord.owned(world, state)?.reset();
    owner.skin.beginRecording();
    retireSwappedPipelineGraph(owner, publication);
    const adoption = world.getResource<RenderSceneAdoption>(RenderSceneDelta);
    const session = owner.internals.profiler?.activeSession();
    const value = runProfiledRenderPhase(session, 'extract', () => {
      if (publication !== undefined)
        return followRecordPublication(world, owner, entity, adoption, publication);
      const { composition } = viewFrameScopes(world, state);
      return owner.scene.followAdoption(
        adoption,
        candidateFrameBuilder(world, owner, entity, composition),
        composition.worlds[composition.owners.resourceOwner],
      );
    });
    return { ok: true, value };
  } catch (cause) {
    return { ok: false, cause };
  }
}

/**
 * Register `render-view-frame` (RenderPrepare, after the scene publishes):
 * each staged view follows the frame's scene adoption and culls it for its
 * camera. The system never throws; a failure is the view's result, which its
 * recording recovers from (preparation barrier) or reports.
 */
export function registerViewFrameSystem(world: World): void {
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_VIEW_FRAME_SYSTEM,
      after: [RENDER_SCENE_PUBLISH_SYSTEM],
      queries: [{ read: [ViewRecorder, ViewFrame] }],
      fn: (world, [rows]) => {
        if (!world.hasResource(RenderViewInput)) return;
        const source = world.getResource<RenderViewFrameSource>(RenderViewInput);
        const frame = renderSubmission(world).frame;

        rows.forEach((row) => {
          const entity = row.entity;

          const state = world
            .resolveUniqueRef<ViewFrameState>(requireViewField(world, entity, ViewFrame, 'state'))
            .unwrap();
          if (state.frame !== frame) return;
          const owner = ownerOf(world, requireViewField(world, entity, ViewRecorder, 'state'));
          state.result = prepareViewFrame(world, owner, entity, source, state);
        });
      },
    })
    .unwrap();
}
