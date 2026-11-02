import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { type RhiDevice, RhiError, type Texture } from '@forgeax/engine-rhi';
import type { CompositeChannels, createViewCompositor } from '../assembly/view-compositor';
import { CubeCamera } from '../components/cube-camera';
import type { StereoEye } from '../components/stereo-camera';
import { CameraViewInvalidError } from '../errors/render';
import type { DeviceScope } from '../lifecycle';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { RenderSystemInternals } from '../record/render-context';
import type { CubeCaptureGraphState } from '../record/target-capture-graph';
import type { DrawOwnerOptions } from '../render-contract';
import { selectCameraRoles } from '../render-system-extract';
import type { RenderTarget } from '../targets/contracts';
import { adoptViewRecordHistory } from './record-history';
import {
  RENDER_VIEW_CAMERAS_SYSTEM,
  RENDER_VIEWS_SYSTEM,
  RenderView,
  type RenderViewFrameSource,
  RenderViewInput,
  type RenderViews,
  ViewCamera,
  type ViewCameraState,
  ViewRecorder,
  type ViewViewport,
  viewCameraOf,
} from './render-views';
import { RenderCommit, RenderExtract, RenderPrepare, renderSubmission } from './render-world';
import { retireAfterSubmission } from './submission-systems';
import { adoptViewDraws } from './view-draw-receipt';
import { requireViewField } from './view-field';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
  viewFrameOf,
} from './view-frame-systems';
import { adoptViewPointsLines } from './view-points-lines';
import { recordContext } from './view-record-context';
import type { ViewSettlementOwner } from './view-settlement';

/**
 * Payload of a view entity's {@link ViewRecorder}: the owner bag and device
 * scope recording that view, its output and its cadence history.
 * A capture view has no output: its capture graph writes `capture.work`.
 */
export interface ViewRecorderState {
  readonly entity: EntityHandle;
  readonly capture: CubeCaptureGraphState | undefined;
  /** A capture view's current target extent, its recording canvas. */
  captureSize: { width: number; height: number };
  readonly key: string;
  readonly camera: number;
  readonly eye: StereoEye | undefined;
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  /** The view's owner bag; Render World per-view prepare and settle systems read it. */
  readonly owner: ViewSettlementOwner;
  readonly composite: ReturnType<typeof createViewCompositor>;
  readonly target: RenderTarget | undefined;
  output: { texture: Texture; width: number; height: number; eye?: StereoEye } | undefined;
  viewport: ViewViewport;
  /** This view's composite input; rewritten in place when output, viewport or channels change. */
  readonly picture: {
    texture: Texture;
    viewport: ViewViewport;
    channels: CompositeChannels;
  };
  renderedFrames: number;
  lastFrame: number;
  /** Whether this frame records a new picture (false: held). */
  rendered: boolean;
  retired: boolean;
}

const VIEW_CHANNELS: readonly CompositeChannels[] = ['all', 'red', 'cyan'];

export function viewChannels(channels: number): CompositeChannels {
  return VIEW_CHANNELS[channels] ?? 'all';
}

/** One view output reallocated this frame; the previous output stays until the frame settles. */
interface OutputReplacement {
  readonly view: ViewRecorderState;
  readonly old: ViewRecorderState['output'];
  readonly texture: Texture;
}

/**
 * The Renderer's view composition for the current frame: which recorders
 * record, in composition order, and the picture each contributes. Written by
 * `render-view-recorders` and `render-view-outputs`, read by the frame entry
 * and settled by `render-view-output-settle`.
 */
export interface ViewComposition {
  /** Composed display views replace the primary display recording. */
  active: boolean;
  /** Does a CubeCamera need the shared capture recording beside composed views? */
  captureDemand: boolean;
  /** The last submitted frame recorded the shared capture view. */
  captureRecorded: boolean;
  /** Recorders that record this frame, capture views first. */
  readonly recorded: ViewRecorderState[];
  readonly pictures: ViewRecorderState['picture'][];
  /** Outputs reallocated this frame, awaiting the submission outcome. */
  readonly replaced: OutputReplacement[];
  /** A view prerequisite is missing: the frame records nothing and is not submitted. */
  blocked: boolean;
  /** A view system's failure in renderer frame `frame`; the frame entry rethrows it once. */
  failure: { readonly cause: unknown; readonly frame: number } | undefined;
}

/** World resource key of the frame's {@link ViewComposition}. */
export const ViewCompositionKey = Object.freeze({ name: 'ViewComposition' });

export function viewComposition(world: World): ViewComposition {
  if (!world.hasResource(ViewCompositionKey))
    world.insertResource<ViewComposition>(ViewCompositionKey, {
      active: false,
      captureDemand: false,
      captureRecorded: false,
      recorded: [],
      pictures: [],
      replaced: [],
      blocked: false,
      failure: undefined,
    });
  return world.getResource<ViewComposition>(ViewCompositionKey);
}

/** RenderExtract: retire every view whose device generation or source World changed. */
export const RENDER_VIEW_OWNER_SYSTEM = 'render-view-owner';
/** RenderPrepare: size every recording view's output and fix the frame's composition. */
export const RENDER_VIEW_OUTPUTS_SYSTEM = 'render-view-outputs';
/** RenderCommit: keep or roll back replaced outputs, mark targets submitted, remember shared capture. */
export const RENDER_VIEW_OUTPUT_SETTLE_SYSTEM = 'render-view-output-settle';

/** Record a view system's failure; the frame entry rethrows it after RenderPrepare. */
function recordViewFailure(world: World, cause: unknown): void {
  const composition = viewComposition(world);
  const frame = renderSubmission(world).frame;
  if (composition.failure?.frame !== frame) composition.failure = { cause, frame };
}

/** Throw the failure a view system recorded in the open frame, once. */
export function throwViewFailure(world: World): void {
  const composition = viewComposition(world);
  const failure = composition.failure;
  composition.failure = undefined;
  if (failure !== undefined && failure.frame === renderSubmission(world).frame) throw failure.cause;
}

type ViewCompositor = ReturnType<typeof createViewCompositor>;

/**
 * The owner every view recorder and output belongs to: its device generation
 * and source World identity, and the display compositor drawing the views.
 * `render-view-owner` retires every view and replaces the compositor when
 * either identity changes.
 */
export interface ViewOutputOwner {
  compositor: ViewCompositor;
  generation: number;
  identity: string | undefined;
}

/** World resource key of the Renderer's {@link ViewOutputOwner}. */
export const ViewOutputOwnerKey = Object.freeze({ name: 'ViewOutputOwner' });

type OutputHost = Pick<
  RenderSystemInternals,
  | 'device'
  | 'deviceScope'
  | 'getPipelineState'
  | 'getRenderTargetPhysical'
  | 'markRenderTargetSubmitted'
>;

function recorderOf(world: World, entity: EntityHandle): ViewRecorderState | undefined {
  return world.hasComponent(entity, ViewRecorder)
    ? world
        .resolveUniqueRef<ViewRecorderState>(requireViewField(world, entity, ViewRecorder, 'state'))
        .unwrap()
    : undefined;
}

/** A view's output target must be a single-sample, single-mip 2D RenderTarget. */
function assertViewTargetShape(
  physical: NonNullable<ReturnType<NonNullable<RenderSystemInternals['getRenderTargetPhysical']>>>,
): void {
  const descriptor = physical.descriptor;
  if (descriptor.shape !== '2d' || descriptor.sampleCount !== 1 || descriptor.mipLevels !== 1) {
    throw new CameraViewInvalidError(
      'target',
      descriptor,
      'a 2d RenderTarget with sampleCount 1 and mipLevels 1',
    );
  }
}

/** (Re)allocate the view's output when its size changes; the previous output waits for the outcome. */
function ensureViewOutput(
  host: OutputHost,
  composition: ViewComposition,
  view: ViewRecorderState,
  width: number,
  height: number,
  base: NonNullable<ReturnType<RenderSystemInternals['getPipelineState']>>,
): void {
  if (view.output?.width === width && view.output?.height === height) return;
  const created = host.device.createTexture({
    label: `camera:${view.key}:output`,
    size: { width, height, depthOrArrayLayers: 1 },
    format: base.format,
    usage: 0x10 | 0x04 | 0x01,
    textureBindingViewDimension: '2d',
    viewFormats: base.format === base.colorAttachmentFormat ? [] : [base.colorAttachmentFormat],
  });
  if (!created.ok) throw created.error;
  const texture = created.value;
  composition.replaced.push({ view, old: view.output, texture });
  view.output = { texture, width, height, ...(view.eye === undefined ? {} : { eye: view.eye }) };
  view.picture.texture = texture;
}

/**
 * Settle every staged replacement: a submitted frame retires the previous
 * output, any other outcome restores it and retires the new one. A retired
 * view's dispose owns its current output, so only the previous one is retired.
 */
export function settleViewOutputs(world: World, host: OutputHost, submitted: boolean): void {
  const composition = viewComposition(world);
  for (const replacement of composition.replaced.splice(0)) {
    const { view } = replacement;
    let texture = submitted ? replacement.old?.texture : replacement.texture;
    if (view.retired) texture = replacement.old?.texture;
    else if (!submitted) {
      view.output = replacement.old;
      if (replacement.old !== undefined) view.picture.texture = replacement.old.texture;
    }
    if (texture !== undefined) {
      const released = texture;
      retireAfterSubmission(world, {
        generation: host.deviceScope.generation,
        queue: host.device.queue,
        release: () => host.device.destroyTexture(released),
      });
    }
  }
}

/** Despawn every view; staged output replacements roll back and the shared capture is forgotten. */
export function retireViews(world: World, views: RenderViews, host: OutputHost): void {
  viewComposition(world).captureRecorded = false;
  views.clear();
  settleViewOutputs(world, host, false);
}

function resolveRecordingViews(
  world: World,
  host: OutputHost,
  views: RenderViews,
  composition: ViewComposition,
): void {
  const base = host.getPipelineState();
  if (composition.active && base === null) {
    composition.blocked = true;
    return;
  }
  for (const entity of views.ordered) {
    const facts = world.get(entity, RenderView).unwrap();
    if (!facts.capture && !facts.enabled) continue;
    const view = recorderOf(world, entity);
    if (view === undefined || viewFrameOf(world, entity) === undefined) continue;
    if (!facts.capture) {
      const resolved = viewCameraOf(world, entity);
      if (resolved === undefined || base === null) continue;
      view.viewport = resolved.viewport;
      view.picture.viewport = resolved.viewport;
      // A retained recorder follows layout changes (e.g. side-by-side -> anaglyph).
      view.picture.channels = viewChannels(facts.channels);
      if (view.target !== undefined) {
        const physical = host.getRenderTargetPhysical?.(view.target);
        if (physical === undefined) {
          composition.blocked = true;
          return;
        }
        assertViewTargetShape(physical);
      }
      ensureViewOutput(
        host,
        composition,
        view,
        resolved.extent.width,
        resolved.extent.height,
        base,
      );
      if (view.target === undefined) composition.pictures.push(view.picture);
    }
    composition.recorded.push(view);
  }
}

/**
 * Register the view output lifecycle on the Render World: Prepare sizes each
 * recording view's output and lists the frame's recorders and pictures;
 * Commit keeps replaced outputs only for a submitted frame.
 */
export function registerViewOutputSystems(
  world: World,
  views: RenderViews,
  host: OutputHost,
  createCompositor: () => ViewCompositor,
): ViewOutputOwner {
  const composition = viewComposition(world);
  const owner: ViewOutputOwner = {
    compositor: createCompositor(),
    generation: host.deviceScope.generation,
    identity: undefined,
  };
  world.insertResource<ViewOutputOwner>(ViewOutputOwnerKey, owner);
  world
    .addSystem(RenderExtract, {
      commands: 'none',
      name: RENDER_VIEW_OWNER_SYSTEM,
      before: [RENDER_VIEWS_SYSTEM],
      queries: [],
      fn: (_world) => {
        if (!_world.hasResource(RenderViewInput)) return;
        const source = _world.getResource<RenderViewFrameSource>(RenderViewInput);
        // Only a frame that declares composed or capture views adopts their owner.
        if (source.primary && source.captures.length === 0) return;
        const identity = source.publication?.resources.identity ?? source.world?.identity;
        if (owner.generation === host.deviceScope.generation && owner.identity === identity) return;
        owner.identity = identity;
        owner.generation = host.deviceScope.generation;
        try {
          retireViews(_world, views, host);
          owner.compositor.dispose();
          owner.compositor = createCompositor();
        } catch (cause) {
          recordViewFailure(_world, cause);
        }
      },
    })
    .unwrap();
  world
    .addSystem(RenderPrepare, {
      commands: 'none',
      name: RENDER_VIEW_OUTPUTS_SYSTEM,
      after: [RENDER_VIEW_FRAME_SYSTEM],
      queries: [],
      fn: (world) => {
        // An earlier frame that failed before its Commit left replacements staged.
        settleViewOutputs(world, host, false);
        composition.recorded.length = 0;
        composition.pictures.length = 0;
        composition.blocked = false;
        if (!composition.active && views.captureCount === 0) return;
        try {
          resolveRecordingViews(world, host, views, composition);
        } catch (cause) {
          recordViewFailure(world, cause);
          composition.blocked = true;
        }
      },
    })
    .unwrap();
  world
    .addSystem(RenderCommit, {
      commands: 'none',
      name: RENDER_VIEW_OUTPUT_SETTLE_SYSTEM,
      queries: [],
      fn: (world) => {
        const submitted = renderSubmission(world).accepted;
        settleViewOutputs(world, host, submitted);
        composition.captureRecorded = composition.active && composition.captureDemand && submitted;
        if (!submitted) return;
        for (const view of composition.recorded) {
          if (view.target === undefined || view.output === undefined) continue;
          const physical = host.getRenderTargetPhysical?.(view.target);
          if (physical !== undefined) host.markRenderTargetSubmitted?.(view.target, physical);
        }
      },
    })
    .unwrap();
  return owner;
}

/** A view's declared facts a recorder is created from. */
export interface ViewRecorderFacts {
  readonly capture: boolean;
  readonly camera: number;
  readonly eye: number;
  readonly channels: number;
}

/** Create a composed or capture view's recorder and attach it to the view entity. */
export type ViewRecorderFactory = (
  entity: EntityHandle,
  facts: ViewRecorderFacts,
  target: RenderTarget | undefined,
  viewport: ViewViewport,
  base: NonNullable<ReturnType<RenderSystemInternals['getPipelineState']>>,
) => ViewRecorderState;

/**
 * What `render-view-recorders` adopts recorders from: the primary view's
 * internals (whose published owner bag records it) and, for a Renderer, the
 * factory of its composed and capture view recorders. A RenderSystem's private frame has only a primary view.
 */
export interface ViewRecorderHost {
  readonly internals: RenderSystemInternals;
  readonly createRecorder?: ViewRecorderFactory | undefined;
}

type ViewFacts = ViewRecorderFacts & {
  readonly target: number;
  readonly enabled: boolean;
  readonly updateInterval: number;
};

function hasCubeCamera(world: World): boolean {
  const query = world.query({ with: [CubeCamera] }).unwrap();
  for (const span of query.spans().unwrap()) if (span.length > 0) return true;
  return false;
}

/** Does any CubeCamera need the shared capture recording beside composed views? */
function sharedCaptureDemand(
  publication: PreparedRenderPublication | undefined,
  world: World | undefined,
): boolean {
  if (publication !== undefined) return publication.frame.cubeCameras.length > 0;
  return world !== undefined && hasCubeCamera(world);
}

/** Probe placement admits exactly one active display view and no capture views. */
function assertProbePlacementViews(source: RenderViewFrameSource, enabledViews: number): void {
  const { publication, world } = source;
  const captures =
    publication === undefined
      ? world !== undefined &&
        (hasCubeCamera(world) || selectCameraRoles(world).auxiliary.length > 0)
      : publication.frame.cubeCameras.length > 0 || publication.frame.auxiliaryCameras.length > 0;
  if (captures || enabledViews > 1)
    throw new RhiError({
      code: 'rhi-not-available',
      expected:
        'one active perspective display view without auxiliary, Cube or reflection views for probe placement',
      hint: 'disable placement or remove the additional views',
    });
}

/** The primary recorder records the primary view entity: the display or the shared capture view. */
function adoptPrimaryView(world: World, views: RenderViews, host: ViewRecorderHost): void {
  const entity = views.primary;
  host.internals.viewEntity = entity;
  if (entity === undefined) return;
  // A Renderer's view-draw systems settle its views' draw receipts.
  if (host.createRecorder !== undefined) adoptViewDraws(world, entity);
  adoptViewRecordHistory(world, entity);
  adoptViewPointsLines(world, entity, host.internals);
  if (world.hasComponent(entity, ViewRecorder)) return;
  const owner = host.internals.viewOwner;
  if (owner === undefined) return;
  const state = world.allocUniqueRef('ViewRecorder', { owner });
  world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
}

/**
 * Adopt a capture view's recorder for this frame. A capture view always
 * renders; while its target is not resident it drops its recorder, so it
 * seeds again from the current scene.
 */
function adoptCaptureRecorder(
  world: World,
  views: RenderViews,
  host: ViewRecorderHost,
  create: ViewRecorderFactory,
  entity: EntityHandle,
  facts: ViewFacts,
  opts: DrawOwnerOptions,
): void {
  const retained = recorderOf(world, entity);
  const target = retained?.target ?? views.target(facts);
  const internals = host.internals;
  const physical = target === undefined ? undefined : internals.getRenderTargetPhysical?.(target);
  const base = recordContext(internals).getPipelineState();
  if (physical === undefined || base === null) {
    if (retained !== undefined) world.removeComponent(entity, ViewRecorder).unwrap();
    return;
  }
  const resolved = viewCameraOf(world, entity) as ViewCameraState;
  const view = retained ?? create(entity, facts, target, resolved.viewport, base);
  view.captureSize.width = resolved.extent.width;
  view.captureSize.height = resolved.extent.height;
  view.rendered = true;
  stageViewFrame(world, entity, { ...opts, cameraEntityKey: view.camera });
}

/**
 * Adopt a composed display view's recorder and decide whether its picture
 * renders this frame; a held view still follows the shared scene.
 */
function adoptDisplayRecorder(
  world: World,
  views: RenderViews,
  create: ViewRecorderFactory,
  entity: EntityHandle,
  facts: ViewFacts,
  opts: DrawOwnerOptions,
  base: NonNullable<ReturnType<RenderSystemInternals['getPipelineState']>>,
): void {
  const resolved = viewCameraOf(world, entity) as ViewCameraState;
  const view =
    recorderOf(world, entity) ??
    create(entity, facts, views.target(facts), resolved.viewport, base);
  const resized =
    view.output?.width !== resolved.extent.width || view.output?.height !== resolved.extent.height;
  // A held view re-renders on temporal reset or once its update interval elapses.
  view.rendered =
    resized ||
    opts.temporalReset === true ||
    renderSubmission(world).frame - view.lastFrame >= facts.updateInterval;
  stageViewFrame(world, entity, { ...opts, cameraEntityKey: view.camera }, view.rendered);
}

/** Adopt every recording view's recorder and stage its ViewFrame. */
function stageRecordingViews(world: World, views: RenderViews, host: ViewRecorderHost): void {
  const source = world.getResource<RenderViewFrameSource>(RenderViewInput);
  const opts = source.opts;
  const composition = viewComposition(world);
  const create = host.createRecorder;
  adoptPrimaryView(world, views, host);
  composition.active = views.displayCount > 0;
  composition.captureDemand =
    composition.active && sharedCaptureDemand(source.publication, source.world);
  if (!composition.active) {
    // Leaving the composed mode releases the compositor and the shared capture memory.
    composition.captureRecorded = false;
    if (world.hasResource(ViewOutputOwnerKey))
      world.getResource<ViewOutputOwner>(ViewOutputOwnerKey).compositor.dispose();
    if (create !== undefined)
      for (const entity of views.ordered) {
        const facts = world.get(entity, RenderView).unwrap();
        if (facts.capture) adoptCaptureRecorder(world, views, host, create, entity, facts, opts);
      }
    if (views.primary !== undefined) stageViewFrame(world, views.primary, opts);
    return;
  }
  const base = recordContext(host.internals).getPipelineState();
  if (create === undefined || base === null) return;
  for (const entity of views.ordered) {
    const facts = world.get(entity, RenderView).unwrap();
    if (facts.capture) adoptCaptureRecorder(world, views, host, create, entity, facts, opts);
    else if (facts.enabled) adoptDisplayRecorder(world, views, create, entity, facts, opts, base);
  }
  // The primary recorder records the shared capture view's scene captures.
  const shared = views.primary;
  if (shared !== undefined && (composition.captureDemand || composition.captureRecorded))
    stageViewFrame(
      world,
      shared,
      { ...opts, cameraEntityKey: world.get(shared, RenderView).unwrap().camera },
      'capture',
    );
}

/**
 * Register `render-view-recorders` (RenderExtract, after the view cameras
 * resolve): adopt every recording view's recorder and stage its ViewFrame, so
 * `render-view-frame` follows and culls exactly the views this frame records.
 * The system never throws; a failure is rethrown by the frame entry
 * ({@link throwViewFailure}).
 */
export function registerViewRecorderSystem(
  world: World,
  views: RenderViews,
  host: ViewRecorderHost,
): void {
  world
    .addSystem(RenderExtract, {
      commands: 'none',
      name: RENDER_VIEW_RECORDERS_SYSTEM,
      after: [RENDER_VIEW_CAMERAS_SYSTEM],
      // Views are adopted in composition order (`views.ordered`), not query order.
      queries: [{ read: [RenderView, ViewCamera] }],
      fn: (world) => {
        if (!world.hasResource(RenderViewInput)) return;
        try {
          stageRecordingViews(world, views, host);
          if (
            host.createRecorder !== undefined &&
            host.internals.standardProfile?.probePlacement !== undefined
          )
            assertProbePlacementViews(
              world.getResource<RenderViewFrameSource>(RenderViewInput),
              views.enabledCount,
            );
        } catch (cause) {
          recordViewFailure(world, cause);
        }
      },
    })
    .unwrap();
}
