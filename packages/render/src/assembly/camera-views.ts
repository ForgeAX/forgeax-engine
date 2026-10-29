import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import {
  type RhiCommandEncoder,
  type RhiDevice,
  RhiError,
  type Texture,
} from '@forgeax/engine-rhi';
import { type AssetHandle, ok } from '@forgeax/engine-types';
import { createCaptureViewPipeline } from '../capture/capture-view';
import { createRendererCaptureOwner } from '../capture/renderer-captures';
import { Camera } from '../components/camera';
import { CameraView, cameraViewExtent } from '../components/camera-view';
import { CubeCamera } from '../components/cube-camera';
import { StereoCamera, type StereoEye } from '../components/stereo-camera';
import { CameraViewInvalidError } from '../errors/render';
import type { CameraViewInspection } from '../inspection-types';
import type { DeviceScope } from '../lifecycle';
import { createOutputColorSpaceState } from '../output-color-space';
import type { PreparedRenderPublication, RenderPublicationReceiver } from '../publication/receiver';
import { DiffuseGiBudget } from '../raytracing/diffuse-gi-budget';
import type { GpuTimingCapture } from '../record/gpu-timing';
import type { RenderSystemInternals } from '../record/render-context';
import type { CubeCaptureGraphState } from '../record/target-capture-graph';
import type {
  CameraSnapshot,
  DrawOwnerOptions,
  FramePresentation,
  FramePresentationPendingReason,
} from '../render-contract';
import { createRenderSystem, type RenderSystem } from '../render-system';
import { selectCameraRoles } from '../render-system-extract';
import type { RenderTarget } from '../targets/contracts';
import type { FramebufferSnapshotSource } from '../targets/framebuffer-snapshot';
import { RenderView, RenderViews, ViewRecorder } from '../world/render-views';
import { createRenderWorld } from '../world/render-world';
import {
  drainFramePreparation,
  type FramePreparation,
  type FrameRecording,
  prepareFrameSubmission,
} from './frame-recording';
import type { LodObservationCapture, LodObservationViewCapture } from './lod-observation';
import { type CompositeChannels, createViewCompositor } from './view-compositor';
import { createViewPipelineState } from './view-pipeline-state';

/**
 * Payload of a view entity's {@link ViewRecorder}: the private RenderSystem
 * and device scope recording that view, its output and its cadence history.
 * A capture view has no output: its capture graph writes `capture.work`.
 */
interface ViewRecorderState {
  readonly entity: EntityHandle;
  readonly capture: CubeCaptureGraphState | undefined;
  /** A capture view's current target extent, its recording canvas. */
  captureSize: { width: number; height: number };
  readonly key: string;
  readonly camera: number;
  readonly eye: StereoEye | undefined;
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly system: RenderSystem;
  readonly composite: ReturnType<typeof createViewCompositor>;
  readonly target: RenderTarget | undefined;
  output: { texture: Texture; width: number; height: number; eye?: StereoEye } | undefined;
  viewport: ReturnType<typeof cameraViewExtent>;
  /** This view's composite input; rewritten in place when output, viewport or channels change. */
  readonly picture: {
    texture: Texture;
    viewport: ReturnType<typeof cameraViewExtent>;
    channels: CompositeChannels;
  };
  renderedFrames: number;
  lastFrame: number;
  /** Whether this frame records a new picture (false: held). */
  rendered: boolean;
  retired: boolean;
}

const VIEW_EYES: readonly (StereoEye | undefined)[] = [undefined, 'left', 'right'];
const VIEW_CHANNELS: readonly CompositeChannels[] = ['all', 'red', 'cyan'];

function viewChannels(channels: number): CompositeChannels {
  return VIEW_CHANNELS[channels] ?? 'all';
}

type ViewSource =
  | {
      readonly publication: PreparedRenderPublication;
      readonly receiver: RenderPublicationReceiver;
    }
  | undefined;

/**
 * The publication a system records. Every system reads the Renderer's one
 * scene composition, so only a composition that cannot apply the accepted
 * delta (cold, retired or lapsed) receives the full scene snapshot.
 */
function publicationFor(
  source: ViewSource,
  system: RenderSystem,
): PreparedRenderPublication | undefined {
  if (source === undefined) return undefined;
  return system.publicationBaselineRequired(source.publication)
    ? source.receiver.snapshot(source.publication)
    : source.publication;
}

/** Open this frame's GPU timing capture, recording why it could not begin. */
function beginGpuTimingFrame(internals: RenderSystemInternals, graphGeneration: number): void {
  internals.gpuPassTimingCapture = undefined;
  internals.gpuPassTimingSubmittedWork = undefined;
  internals.gpuPassTimingBeginReason = undefined;
  const timingIdentity = internals.gpuPassTimingFrameIdentity;
  if (timingIdentity === undefined) return;
  const started = internals.gpuPassTimingSession?.beginFrame({
    ...timingIdentity,
    graphGeneration,
  });
  if (started?.ok === true) internals.gpuPassTimingCapture = started.value;
  else if (started?.ok === false) internals.gpuPassTimingBeginReason = started.error;
}

/** Every view consumes the same precise accepted asset changes. */
function adoptPublicationAssets(
  internals: RenderSystemInternals,
  publication: PreparedRenderPublication,
): void {
  const store = internals.gpuStore;
  const resources = publication.resources;
  for (const change of publication.assetChanges) {
    const payload = resources.resolveAsset(change.handle).unwrap();
    store
      .adoptMeshChange(change, payload.kind === 'mesh' ? payload : undefined, resources)
      .unwrap();
    store
      .adoptTextureChange(change, payload.kind === 'texture' ? payload : undefined, resources)
      .unwrap();
    store.invalidateSampler(change.handle, resources);
    store.adoptCubemapChange(change, resources);
  }
  for (const handle of publication.packet.retiredAssets) {
    store.invalidateMesh(handle, resources);
    store.invalidateSampler(handle, resources);
    store.evictCubemap(handle, resources);
    store.invalidateTexture(handle as AssetHandle<'texture'>, resources);
  }
}

/** Membership-only probe: does any camera declare a composed CameraView or StereoCamera? */
function declaresComposedViews(world: World): boolean {
  for (const composed of [CameraView, StereoCamera]) {
    const query = world.query({ with: [Camera, composed] }).unwrap();
    for (const span of query.spans().unwrap()) if (span.length > 0) return true;
  }
  return false;
}

function hasCubeCamera(world: World): boolean {
  const query = world.query({ with: [CubeCamera] }).unwrap();
  for (const span of query.spans().unwrap()) if (span.length > 0) return true;
  return false;
}

function cameraAttachmentId(
  camera: CameraSnapshot,
  world: World | undefined,
  worlds: readonly World[],
): string | undefined {
  return camera.worldId === undefined ? world?.identity : worlds[camera.worldId]?.identity;
}

/** Probe placement admits exactly one active display view and no capture views. */
function assertProbePlacementViews(
  publication: PreparedRenderPublication | undefined,
  world: World | undefined,
  enabledViews: number,
): void {
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

/** Does any CubeCamera need the shared capture recording beside composed views? */
function sharedCaptureDemand(
  publication: PreparedRenderPublication | undefined,
  world: World | undefined,
): boolean {
  if (publication !== undefined) return publication.frame.cubeCameras.length > 0;
  return world !== undefined && hasCubeCamera(world);
}

/** Membership-only probe: does any non-composed Camera name a RenderTarget? */
function declaresTargetCamera(world: World): boolean {
  const query = world.query({ with: [Camera], without: [CameraView, StereoCamera] }).unwrap();
  const reader = world[worldRead];
  for (const span of query.spans().unwrap()) {
    const entities = span.entities;
    for (let index = 0; index < span.length; index++)
      if (reader.getFieldValue(entities[index] as EntityHandle, Camera, 'target') !== 0)
        return true;
  }
  return false;
}

/** Selected auxiliary RenderTarget cameras; planar mirrors stay with their display view. */
function captureCameras(
  publication: PreparedRenderPublication | undefined,
  world: World | undefined,
  cameraEntityKey: number | undefined,
): readonly CameraSnapshot[] {
  let auxiliary = publication?.frame.auxiliaryCameras;
  if (auxiliary === undefined) {
    if (world === undefined || !declaresTargetCamera(world)) return [];
    try {
      auxiliary = selectCameraRoles(world, cameraEntityKey).auxiliary;
    } catch {
      // Invalid camera facts belong to the primary extraction, which reports
      // the same structured failure for this frame.
      return [];
    }
  }
  return auxiliary.filter(
    (camera) => camera.planarReflection === undefined && camera.target !== undefined,
  );
}

function captureLeases(
  leases: readonly RenderReadLease[] | undefined,
): LodObservationCapture['leases'] {
  return Object.freeze(
    (leases ?? []).map((lease) =>
      Object.freeze({ lease, worldIdentity: lease.worldIdentity, generation: lease.generation }),
    ),
  );
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

/** The barrier recording that submits the shared encoder after every view has recorded. */
function* submitSharedEncoder(
  internals: RenderSystemInternals,
  device: RhiDevice,
  encoder: RhiCommandEncoder,
): FrameRecording {
  const submitted = yield {
    encoder,
    device,
    beforeSubmit: internals.beforeSubmit,
    reportError: (error: RhiError) => internals.errorRegistry.fire(error),
  };
  return submitted.ok;
}

/** Retired or rolled-back view outputs are destroyed after queued work completes. */
function releaseReplacedOutputs(
  device: RhiDevice,
  replaced: readonly {
    view: ViewRecorderState;
    old: ViewRecorderState['output'];
    texture: Texture;
  }[],
  submitted: boolean,
): void {
  for (const replacement of replaced) {
    const texture = submitted ? replacement.old?.texture : replacement.texture;
    if (!submitted) {
      replacement.view.output = replacement.old;
      if (replacement.old !== undefined) replacement.view.picture.texture = replacement.old.texture;
    }
    if (texture !== undefined) {
      const dispose = () => {
        device.destroyTexture(texture);
      };
      void device.queue.onSubmittedWorkDone().then(dispose, dispose);
    }
  }
}

function viewObservation(
  view: ViewRecorderState,
  facts: { readonly attachment: string; readonly viewGeneration: number },
): LodObservationViewCapture {
  const rendered = view.rendered;
  const inspection = rendered ? view.system.lodOcclusion : undefined;
  return Object.freeze({
    viewKey: view.key,
    entityKey: view.camera,
    eye: view.eye,
    attachmentId: inspection?.view.attachmentId ?? (facts.attachment || 'none'),
    viewGeneration: facts.viewGeneration,
    graphGeneration: view.system.perFrameGraphInfo?.generation ?? 0,
    graphIncarnation: view.system.perFrameGraphIncarnation,
    state: rendered ? ('rendered' as const) : ('held' as const),
    system: view.system,
    viewRef: view,
    primary: false,
    inspection,
  });
}

/** The primary system's single rendered view, matched to its inspected camera. */
function primaryObservationViews(
  primary: RenderSystem,
  cameras: readonly CameraSnapshot[],
  world: World | undefined,
  worlds: readonly World[],
): readonly LodObservationViewCapture[] {
  const primaryInspection = primary.lodOcclusion;
  const camera =
    cameras.find((candidate) => candidate.entityKey === primaryInspection?.view.cameraEntity) ??
    cameras[0];
  const entityKey = camera?.entityKey ?? primaryInspection?.view.cameraEntity;
  if (entityKey === undefined) return [];
  const attachmentId =
    primaryInspection?.view.attachmentId ??
    (camera === undefined ? world?.identity : cameraAttachmentId(camera, world, worlds)) ??
    'none';
  return [
    Object.freeze({
      viewKey: 'primary',
      entityKey,
      eye: undefined,
      attachmentId,
      viewGeneration: camera?.historyVersion ?? primaryInspection?.view.viewGeneration ?? 0,
      graphGeneration: primary.perFrameGraphInfo?.generation ?? 0,
      graphIncarnation: primary.perFrameGraphIncarnation,
      state: 'rendered',
      system: primary,
      viewRef: undefined,
      primary: true,
      inspection: primaryInspection,
    }),
  ];
}

/**
 * Renderer-owned views share one device, asset cache, frame encoder and
 * submission. Each view is a Render World entity ({@link RenderView}); its
 * private recording state is the entity's {@link ViewRecorder}.
 */
export function createCameraViews(
  internals: RenderSystemInternals,
  primary: RenderSystem,
  maxRenderShortSide = 0,
) {
  const renderWorld = internals.renderWorld ?? createRenderWorld();
  const views = new RenderViews(renderWorld);
  // Every view's field splits the per-frame GI budgets through this one owner.
  internals.giBudget ??= new DiffuseGiBudget();
  internals.rendererCaptureOwner ??= createRendererCaptureOwner((target) =>
    internals.getRenderTargetPhysical?.(target),
  );
  let generation = internals.deviceScope.generation;
  let ownerIdentity: string | undefined;
  let frame = 0;
  let lastLodObservationCapture: LodObservationCapture | undefined;
  let captureRecorded = false;
  let surfaceDynamicInput: Parameters<RenderSystem['setSurfaceDynamicInput']>[0];
  let composite = createViewCompositor(internals);
  /** Views recorded by the current frame, in composition order; retained storage. */
  const recorded: ViewRecorderState[] = [];
  const pictures: ViewRecorderState['picture'][] = [];
  const retire = (view: ViewRecorderState) => {
    view.retired = true;
    const dispose = () => {
      if (view.output !== undefined) view.device.destroyTexture(view.output.texture);
      view.composite.dispose();
      view.system.disposeFrameState();
      view.scope.dispose();
    };
    void view.device.queue.onSubmittedWorkDone().then(dispose, dispose);
  };
  const clear = () => {
    captureRecorded = false;
    views.clear();
  };
  const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw r.error;
    return r.value;
  };
  const recorderOf = (entity: EntityHandle): ViewRecorderState | undefined =>
    renderWorld.hasComponent(entity, ViewRecorder)
      ? renderWorld
          .resolveUniqueRef<ViewRecorderState>(renderWorld.get(entity, ViewRecorder).unwrap().state)
          .unwrap()
      : undefined;
  /** The first live recorder in composition order that satisfies `match`. */
  const findRecorder = (
    match: (view: ViewRecorderState) => boolean = () => true,
  ): ViewRecorderState | undefined => {
    for (const entity of views.ordered) {
      const recorder = recorderOf(entity);
      if (recorder !== undefined && match(recorder)) return recorder;
    }
    return undefined;
  };
  /** The first live display (composed) recorder that satisfies `match`. */
  const findDisplayRecorder = (
    match: (view: ViewRecorderState) => boolean = () => true,
  ): ViewRecorderState | undefined =>
    findRecorder((view) => view.capture === undefined && match(view));
  /** Live recorders in composition order, capture views first. */
  const recorders = (): ViewRecorderState[] => {
    const live: ViewRecorderState[] = [];
    findRecorder((view) => {
      live.push(view);
      return false;
    });
    return live;
  };
  const displayRecorders = (): ViewRecorderState[] =>
    recorders().filter((view) => view.capture === undefined);
  const captureRecorders = (): ViewRecorderState[] =>
    recorders().filter((view) => view.capture !== undefined);
  /** Composed display views replace the primary display recording. */
  const active = (): boolean => views.displayCount > 0;
  const systems = (): readonly RenderSystem[] =>
    active()
      ? recorders().map((view) => view.system)
      : [primary, ...captureRecorders().map((view) => view.system)];
  const allSystems = (): readonly RenderSystem[] => [
    primary,
    ...recorders().map((view) => view.system),
  ];
  const isLodObservationViewCurrent = (
    capture: LodObservationCapture,
    row: LodObservationViewCapture,
  ): boolean => {
    if (lastLodObservationCapture !== capture) return false;
    if (row.primary) return !active() && row.system === primary;
    const view = row.viewRef as ViewRecorderState | undefined;
    return view !== undefined && !view.retired && view.system === row.system;
  };
  /** Attach a view's private record internals over the shared Renderer internals. */
  const createRecorder = (
    entity: EntityHandle,
    facts: {
      readonly capture: boolean;
      readonly camera: number;
      readonly eye: number;
      readonly channels: number;
    },
    target: RenderTarget | undefined,
    viewport: ViewRecorderState['viewport'],
    base: NonNullable<ReturnType<RenderSystemInternals['getPipelineState']>>,
  ): ViewRecorderState => {
    const camera = facts.camera;
    const eye = VIEW_EYES[facts.eye];
    const key = facts.capture
      ? `capture:${camera}`
      : eye === undefined
        ? String(camera)
        : `${camera}:${eye}`;
    const scope = internals.deviceScope.createChild(`camera:${key}`);
    const capture: CubeCaptureGraphState | undefined = facts.capture ? { work: [] } : undefined;
    try {
      let view: ViewRecorderState | undefined;
      const local = createViewPipelineState(base, internals, scope);
      const property = (value: unknown) => ({
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
      const recordInternals = Object.defineProperties({} as RenderSystemInternals, {
        ...Object.getOwnPropertyDescriptors(internals),
        canvas: {
          configurable: true,
          enumerable: true,
          get: () =>
            capture !== undefined
              ? (view?.captureSize ?? { width: 1, height: 1 })
              : (view?.output ?? {
                  width: viewport.renderWidth,
                  height: viewport.renderHeight,
                }),
        },
        viewOutput: {
          configurable: true,
          enumerable: true,
          get: () => view?.output,
        },
        // A capture view records its own target through the capture graph;
        // it carries no Features and composes nothing.
        ...(capture === undefined
          ? {}
          : {
              captureView: property({ camera, state: capture }),
              standardPipeline: property(createCaptureViewPipeline(capture)),
              featureHost: property(undefined),
              featureSceneInputs: property(undefined),
            }),
        deviceGeneration: {
          configurable: true,
          enumerable: true,
          get: () => scope.generation,
        },
        getPipelineState: property(() => local.state),
        deviceScope: property(scope),
        sharedFeatureGpuWork: property(primary.featureGpuWork),
        rendererFrameNumber: {
          configurable: true,
          get: () => internals.rendererFrameNumber,
        },
        growMeshSsbo: property(local.mesh.growMeshSsbo),
        meshSsboState: property(local.mesh.state),
        observationCaptureOwner: property(undefined),
        observationCaptureDomains: property(undefined),
        observationFrameId: {
          configurable: true,
          get: () => internals.observationFrameId,
        },
        observationGraphGeneration: property(undefined),
        gpuPassTimingSession: {
          configurable: true,
          get: () => internals.gpuPassTimingSession,
        },
        gpuPassTimingFrameIdentity: {
          configurable: true,
          get: () => internals.gpuPassTimingFrameIdentity,
        },
        gpuPassTimingCapture: {
          configurable: true,
          get: () => internals.gpuPassTimingCapture,
        },
        gpuPassTimingSubmittedWork: {
          configurable: true,
          get: () => internals.gpuPassTimingSubmittedWork,
          set: (completion: Promise<void> | undefined) => {
            internals.gpuPassTimingSubmittedWork = completion;
          },
        },
        gpuPassTimingViewId: property(camera),
        invalidateShaderModule: property(() => undefined),
        encodeRenderTargetReadbacks: property(() => undefined),
        encodeFramebufferSnapshots: property(
          (encoder: RhiCommandEncoder, source: FramebufferSnapshotSource) =>
            internals.encodeFramebufferSnapshots?.(encoder, {
              ...source,
              camera,
              role: 'view',
            }),
        ),
        // A RenderTarget is sampled back as sRGB-encoded rgba8 by the compositor
        // and by material consumers, so it always encodes Rec.709; only display
        // views follow the negotiated surface color space.
        ...(target === undefined
          ? {}
          : { outputColorSpace: property(createOutputColorSpaceState('srgb')) }),
      });
      const system = createRenderSystem(recordInternals);
      primary.copyConfigurationTo(system);
      system.setSurfaceDynamicInput(surfaceDynamicInput);
      view = {
        entity,
        capture,
        captureSize: { width: 1, height: 1 },
        key,
        camera,
        eye,
        device: internals.device,
        scope,
        system,
        composite: createViewCompositor(internals),
        viewport,
        target,
        output: undefined,
        picture: {
          texture: undefined as unknown as Texture,
          viewport,
          channels: viewChannels(facts.channels),
        },
        renderedFrames: 0,
        lastFrame: -Infinity,
        rendered: false,
        retired: false,
      };
      const state = renderWorld.allocUniqueRef('ViewRecorder', view, retire);
      renderWorld.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
      return view;
    } catch (cause) {
      scope.dispose();
      throw cause;
    }
  };
  /**
   * (Re)allocate the view's output when its size changes; the previous output
   * is retained until submission decides which one to release.
   */
  const ensureViewOutput = (
    view: ViewRecorderState,
    width: number,
    height: number,
    base: NonNullable<ReturnType<RenderSystemInternals['getPipelineState']>>,
    replaced: { view: ViewRecorderState; old: ViewRecorderState['output']; texture: Texture }[],
  ): boolean => {
    if (view.output?.width === width && view.output?.height === height) return false;
    const texture = value(
      internals.device.createTexture({
        label: `camera:${view.key}:output`,
        size: { width, height, depthOrArrayLayers: 1 },
        format: base.format,
        usage: 0x10 | 0x04 | 0x01,
        textureBindingViewDimension: '2d',
        viewFormats: base.format === base.colorAttachmentFormat ? [] : [base.colorAttachmentFormat],
      }),
    );
    replaced.push({ view, old: view.output, texture });
    view.output = { texture, width, height, ...(view.eye === undefined ? {} : { eye: view.eye }) };
    view.picture.texture = texture;
    return true;
  };
  /** Decode each completed RenderTarget picture, then composite display views to the surface. */
  const encodeComposite = (encoder: RhiCommandEncoder): boolean => {
    // Material sources consume linear values; decode each completed picture
    // into its logical target through the same graph/encoder owner.
    for (const view of recorded) {
      if (view.target === undefined || view.output === undefined) continue;
      const target = internals.getRenderTargetPhysical?.(view.target);
      if (target === undefined) return false;
      const { width, height } = view.output;
      const picture = {
        texture: view.output.texture,
        viewport: { x: 0, y: 0, width, height, renderWidth: width, renderHeight: height },
      };
      if (!view.composite.encode(encoder, [picture], target.texture, target.descriptor))
        return false;
    }
    if (internals.context === null) return false;
    const output = internals.presentationOutput ?? value(internals.context.getCurrentTexture());
    if (!composite.encode(encoder, pictures, output)) return false;
    internals.encodeRenderTargetReadbacks?.(encoder);
    return true;
  };
  const markViewTargetsSubmitted = (): void => {
    for (const view of recorded) {
      if (view.target === undefined || view.output === undefined) continue;
      const target = internals.getRenderTargetPhysical?.(view.target);
      if (target !== undefined) internals.markRenderTargetSubmitted?.(view.target, target);
    }
  };
  /** Record the frame through the primary system alone (no composed view is declared). */
  function* preparePrimarySubmission(
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    leases: readonly RenderReadLease[] | undefined,
    timing: GpuTimingCapture | undefined,
    source: ViewSource,
    isCurrent: (() => boolean) | undefined,
    wasActive: boolean,
  ): FramePreparation {
    const publication = source?.publication;
    const world = worlds[opts.cameraOwner];
    if (wasActive) {
      captureRecorded = false;
      composite.dispose();
    }
    const frameSubmitted = yield* primary.prepareSubmission(
      worlds,
      opts,
      leases,
      timing,
      publicationFor(source, primary),
      isCurrent,
    );
    if (!frameSubmitted) return frameSubmitted;
    const primaryCameras =
      publication?.frame.cameras ??
      (world === undefined ? [] : selectCameraRoles(world, opts.cameraEntityKey).display);
    lastLodObservationCapture = Object.freeze({
      frameId: internals.observationFrameId ?? 0,
      deviceGeneration: internals.deviceScope.generation,
      views: Object.freeze([...primaryObservationViews(primary, primaryCameras, world, worlds)]),
      leases: captureLeases(leases),
    });
    return frameSubmitted;
  }
  /**
   * Record one capture view into the shared encoder. A capture view always
   * renders; while its target is not resident it records nothing and drops
   * its recorder, so it seeds again from the current scene.
   */
  const appendCaptureView = (
    recordings: FrameRecording[],
    entity: EntityHandle,
    facts: Parameters<typeof createRecorder>[1] &
      Parameters<typeof cameraViewExtent>[0] & { readonly target: number },
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    leases: readonly RenderReadLease[] | undefined,
    source: ViewSource,
    encoder: RhiCommandEncoder,
  ): void => {
    const retained = recorderOf(entity);
    const target = retained?.target ?? views.target(facts);
    const physical = target === undefined ? undefined : internals.getRenderTargetPhysical?.(target);
    const base = internals.getPipelineState();
    if (physical === undefined || base === null) {
      if (retained !== undefined) renderWorld.removeComponent(entity, ViewRecorder).unwrap();
      return;
    }
    const extent = cameraViewExtent(facts, physical.descriptor.width, physical.descriptor.height);
    const view = retained ?? createRecorder(entity, facts, target, extent, base);
    view.captureSize.width = physical.descriptor.width;
    view.captureSize.height = physical.descriptor.height;
    view.rendered = true;
    recorded.push(view);
    recordings.push(
      view.system.record(
        worlds,
        { ...opts, cameraEntityKey: view.camera },
        leases,
        undefined,
        publicationFor(source, view.system),
        encoder,
        true,
      ),
    );
  };
  /**
   * The primary display recording with capture views and no composed view:
   * capture views record first (displays sample their targets), then the
   * primary display, into one encoder and one submission.
   */
  function* prepareCaptureSubmission(
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    leases: readonly RenderReadLease[] | undefined,
    timing: GpuTimingCapture | undefined,
    source: ViewSource,
    isCurrent: (() => boolean) | undefined,
    wasActive: boolean,
  ): FramePreparation {
    const publication = source?.publication;
    const world = worlds[opts.cameraOwner];
    if (wasActive) {
      captureRecorded = false;
      composite.dispose();
    }
    const encoder = value(
      internals.device.createCommandEncoder({
        label: `capture-frame:${internals.observationFrameId ?? frame}`,
      }),
    );
    recorded.length = 0;
    pictures.length = 0;
    const recordings: FrameRecording[] = [];
    for (const entity of views.ordered) {
      const facts = renderWorld.get(entity, RenderView).unwrap();
      if (!facts.capture) continue;
      appendCaptureView(recordings, entity, facts, worlds, opts, leases, source, encoder);
    }
    recordings.push(
      primary.record(worlds, opts, leases, timing, publicationFor(source, primary), encoder),
      submitSharedEncoder(internals, internals.device, encoder),
    );
    const frameSubmitted = yield* prepareFrameSubmission(
      recordings,
      undefined,
      internals,
      isCurrent,
    );
    if (!frameSubmitted) return frameSubmitted;
    for (const view of recorded) {
      view.lastFrame = frame;
      view.renderedFrames += 1;
    }
    const primaryCameras =
      publication?.frame.cameras ??
      (world === undefined ? [] : selectCameraRoles(world, opts.cameraEntityKey).display);
    lastLodObservationCapture = Object.freeze({
      frameId: internals.observationFrameId ?? 0,
      deviceGeneration: internals.deviceScope.generation,
      views: Object.freeze([...primaryObservationViews(primary, primaryCameras, world, worlds)]),
      leases: captureLeases(leases),
    });
    return frameSubmitted;
  }
  /** The view's RenderTarget physical texture; `null` when a declared target is not resident. */
  const viewTargetPhysical = (target: RenderTarget | undefined) => {
    if (target === undefined) return undefined;
    const physical = internals.getRenderTargetPhysical?.(target);
    if (physical === undefined) return null;
    assertViewTargetShape(physical);
    return physical;
  };
  /** Retire views from another device generation or source World. */
  const adoptOwner = (identity: string | undefined): void => {
    if (generation === internals.deviceScope.generation && ownerIdentity === identity) return;
    clear();
    ownerIdentity = identity;
    generation = internals.deviceScope.generation;
    composite.dispose();
    composite = createViewCompositor(internals);
  };
  const appendViewPicture = (view: ViewRecorderState, target: RenderTarget | undefined): void => {
    if (target === undefined && view.output !== undefined) pictures.push(view.picture);
  };
  /** Record every enabled view, the shared capture view and the composite into one encoder. */
  function* prepareViewSubmission(
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    leases: readonly RenderReadLease[] | undefined,
    source: ViewSource,
    isCurrent: (() => boolean) | undefined,
  ): FramePreparation {
    const publication = source?.publication;
    const world = worlds[opts.cameraOwner];
    const base = internals.getPipelineState();
    if (base === null) return false;
    const encoder = value(
      internals.device.createCommandEncoder({
        label: `multi-camera-frame:${internals.observationFrameId ?? frame}`,
      }),
    );
    const recordings: FrameRecording[] = [];
    recorded.length = 0;
    pictures.length = 0;
    const replaced: {
      view: ViewRecorderState;
      old: ViewRecorderState['output'];
      texture: Texture;
    }[] = [];
    const device = internals.device;
    let submitted = false;
    let captureDemand = false;
    let captureCamera: number | undefined;
    try {
      for (const entity of views.ordered) {
        const facts = renderWorld.get(entity, RenderView).unwrap();
        if (facts.capture) {
          appendCaptureView(recordings, entity, facts, worlds, opts, leases, source, encoder);
          continue;
        }
        captureCamera ??= facts.camera;
        if (!facts.enabled) continue;
        const viewport = cameraViewExtent(facts, internals.canvas.width, internals.canvas.height);
        const retained = recorderOf(entity);
        const target = retained?.target ?? views.target(facts);
        const view = retained ?? createRecorder(entity, facts, target, viewport, base);
        view.viewport = viewport;
        view.picture.viewport = viewport;
        // A retained recorder follows layout changes (e.g. side-by-side -> anaglyph).
        view.picture.channels = viewChannels(facts.channels);
        const physical = viewTargetPhysical(target);
        if (physical === null) return false;
        const resized = ensureViewOutput(
          view,
          physical?.descriptor.width ?? viewport.renderWidth,
          physical?.descriptor.height ?? viewport.renderHeight,
          base,
          replaced,
        );
        // A held view re-renders on temporal reset or once its update interval elapses.
        view.rendered =
          resized || opts.temporalReset === true || frame - view.lastFrame >= facts.updateInterval;
        // Views share the Renderer's scene composition; each catches up its own
        // camera state from the latest shared advance, even when its picture is held.
        recordings.push(
          view.system.record(
            worlds,
            { ...opts, cameraEntityKey: view.camera },
            leases,
            undefined,
            publicationFor(source, view.system),
            encoder,
            view.rendered,
          ),
        );
        recorded.push(view);
        appendViewPicture(view, target);
      }
      const firstEnabled =
        recorded.find((view) => view.capture === undefined)?.camera ?? captureCamera;
      captureDemand = sharedCaptureDemand(publication, world);
      if (firstEnabled !== undefined && (captureDemand || captureRecorded)) {
        recordings.push(
          primary.record(
            worlds,
            { ...opts, cameraEntityKey: firstEnabled },
            leases,
            undefined,
            publicationFor(source, primary),
            encoder,
            'capture',
          ),
        );
      }
      // The composite is also a recorded view so an all-disabled frame still clears and submits.
      recordings.push(submitSharedEncoder(internals, device, encoder));
      submitted = yield* prepareFrameSubmission(
        recordings,
        () => encodeComposite(encoder),
        internals,
        isCurrent,
      );
      if (submitted) markViewTargetsSubmitted();
      captureRecorded = captureDemand && submitted;
    } finally {
      releaseReplacedOutputs(device, replaced, submitted);
    }
    if (submitted) commitSubmittedViews(leases);
    return submitted;
  }
  /** Advance held/rendered view history and publish this frame's LOD observation. */
  const commitSubmittedViews = (leases: readonly RenderReadLease[] | undefined): void => {
    const observed: LodObservationViewCapture[] = [];
    for (const view of recorded) {
      if (view.rendered) {
        view.lastFrame = frame;
        view.renderedFrames += 1;
      }
      if (view.capture !== undefined) continue;
      observed.push(viewObservation(view, renderWorld.get(view.entity, RenderView).unwrap()));
    }
    lastLodObservationCapture = Object.freeze({
      frameId: internals.observationFrameId ?? 0,
      deviceGeneration: internals.deviceScope.generation,
      views: Object.freeze(observed),
      leases: captureLeases(leases),
    });
  };
  return {
    async prepareCandidatePipelines(
      ...args: Parameters<RenderSystem['prepareCandidatePipelines']>
    ) {
      const captured = systems();
      const results = await Promise.all(
        captured.map((system) => system.prepareCandidatePipelines(...args)),
      );
      const failed = results.find((result) => !result.ok);
      const release = () => {
        for (const result of results) if (result.ok) result.value.release();
      };
      if (failed !== undefined && !failed.ok) {
        release();
        return failed;
      }
      return ok({
        isCurrent: () => results.every((result) => result.ok && result.value.isCurrent()),
        release,
      });
    },
    terrainSections() {
      return active()
        ? displayRecorders().map((view) => ({
            view: view.key,
            sections: view.system.submittedTerrain,
          }))
        : [{ view: 'primary', sections: primary.submittedTerrain }];
    },
    get currentSystem(): RenderSystem {
      return active() ? (findDisplayRecorder()?.system ?? primary) : primary;
    },
    get lastLodObservationCapture(): LodObservationCapture | undefined {
      return lastLodObservationCapture;
    },
    isLodObservationCaptureCurrent(capture: LodObservationCapture): boolean {
      return (
        lastLodObservationCapture === capture &&
        capture.views.every((row) => isLodObservationViewCurrent(capture, row))
      );
    },
    isLodObservationViewCurrent(
      capture: LodObservationCapture,
      row: LodObservationViewCapture,
    ): boolean {
      return isLodObservationViewCurrent(capture, row);
    },
    get perFramePassNames(): readonly string[] {
      return internals.submittedPassNames ?? [];
    },
    bounds(...args: Parameters<RenderSystem['bounds']>) {
      for (const system of systems()) {
        const bounds = system.bounds(...args);
        if (bounds !== undefined) return bounds;
      }
      return undefined;
    },
    configureStandard(...args: Parameters<RenderSystem['configureStandard']>) {
      for (const system of allSystems()) system.configureStandard(...args);
    },
    setSurfaceDynamicInput(...args: Parameters<RenderSystem['setSurfaceDynamicInput']>) {
      surfaceDynamicInput = args[0];
      for (const system of allSystems()) system.setSurfaceDynamicInput(...args);
    },
    isDynamicGeometryConsumed(...args: Parameters<RenderSystem['isDynamicGeometryConsumed']>) {
      if (!active()) return primary.isDynamicGeometryConsumed(...args);
      return findRecorder((view) => view.system.isDynamicGeometryConsumed(...args)) !== undefined;
    },
    isCubeCapturePending(target: RenderTarget): boolean {
      if (!active()) return primary.isCubeCapturePending(target);
      return findRecorder((view) => view.system.isCubeCapturePending(target)) !== undefined;
    },
    dynamicGeometryRecordStageLane(
      ...args: Parameters<RenderSystem['dynamicGeometryRecordStageLane']>
    ) {
      if (!active()) return primary.dynamicGeometryRecordStageLane(...args);
      for (const view of recorders()) {
        const lane = view.system.dynamicGeometryRecordStageLane(...args);
        if (lane !== undefined) return lane;
      }
      return undefined;
    },
    get active() {
      return active();
    },
    get presentation(): FramePresentation | undefined {
      const pending = findRecorder((view) => view.system.presentation !== 'ready') !== undefined;
      // Without composed views the primary presents; a pending capture still holds the frame.
      if (!active()) return pending ? 'pending' : undefined;
      return pending ? 'pending' : 'ready';
    },
    get presentationPendingReason(): FramePresentationPendingReason | undefined {
      const view = findRecorder((candidate) => candidate.system.presentation === 'pending');
      return view === undefined
        ? undefined
        : Object.freeze({
            ...(view.system.presentationPendingReason ?? { code: 'camera-view-pending' as const }),
            view: view.key.slice(0, 256),
          });
    },
    inspect(): readonly CameraViewInspection[] {
      return displayRecorders().map((v) => ({
        entityKey: v.camera,
        ...(v.eye === undefined ? {} : { eye: v.eye }),
        viewport: [v.viewport.x, v.viewport.y, v.viewport.width, v.viewport.height],
        width: v.output?.width ?? 0,
        height: v.output?.height ?? 0,
        renderedFrames: v.renderedFrames,
        output: v.target === undefined ? 'screen' : 'texture',
        passes: [...v.system.perFramePassNames],
        bloom: v.system.bloom,
        ssr: v.system.ssr,
        dynamicResolution: v.system.dynamicResolution,
        temporal: v.system.temporal,
        frustum: { ...v.system.frustumStats },
        visibility: { ...v.system.visibilityStats },
        ...(v.system.diffuseGi === undefined ? {} : { diffuseGi: v.system.diffuseGi }),
      }));
    },
    dispose() {
      clear();
      composite.dispose();
    },
    reset() {
      clear();
    },
    detach(world: World) {
      if (ownerIdentity === world.identity) clear();
    },
    draw(...args: Parameters<typeof this.prepareSubmission>): boolean {
      return drainFramePreparation(this.prepareSubmission(...args));
    },
    *prepareSubmission(
      worlds: readonly World[],
      opts: DrawOwnerOptions,
      leases?: readonly RenderReadLease[],
      timing?: GpuTimingCapture,
      source?: {
        readonly publication: PreparedRenderPublication;
        readonly receiver: RenderPublicationReceiver;
      },
      isCurrent?: () => boolean,
    ): FramePreparation {
      frame += 1;
      internals.rendererFrameNumber = frame;
      let frameSubmitted = false;
      beginGpuTimingFrame(
        internals,
        active() ? composite.generation : (primary.perFrameGraphInfo?.generation ?? 0),
      );
      try {
        const publication = source?.publication;
        if (publication !== undefined) adoptPublicationAssets(internals, publication);
        const world = worlds[opts.cameraOwner];
        // The primary system owns extraction and diagnostic publication when no
        // composed view is declared. This admission probe reads membership only.
        const declaresViews =
          publication === undefined && world !== undefined && declaresComposedViews(world);
        const cap =
          Math.min(internals.canvas.width, internals.canvas.height) > maxRenderShortSide
            ? maxRenderShortSide
            : 0;
        const cameras =
          publication?.frame.cameras ??
          ((!declaresViews && cap === 0) || world === undefined
            ? []
            : selectCameraRoles(world, opts.cameraEntityKey).display);
        const wasActive = active();
        const captures = captureCameras(publication, world, opts.cameraEntityKey);
        if (captures.length > 0 || cap > 0 || cameras.some((camera) => camera.view !== undefined))
          adoptOwner(publication?.resources.identity ?? world?.identity);
        views.sync({
          cameras,
          maxRenderShortSide: cap,
          captures,
          attachment: (camera) => cameraAttachmentId(camera, world, worlds),
        });
        if (internals.standardProfile?.probePlacement !== undefined)
          assertProbePlacementViews(publication, world, views.enabledCount);
        frameSubmitted = active()
          ? yield* prepareViewSubmission(worlds, opts, leases, source, isCurrent)
          : views.captureCount > 0
            ? yield* prepareCaptureSubmission(
                worlds,
                opts,
                leases,
                timing,
                source,
                isCurrent,
                wasActive,
              )
            : yield* preparePrimarySubmission(
                worlds,
                opts,
                leases,
                timing,
                source,
                isCurrent,
                wasActive,
              );
        return frameSubmitted;
      } finally {
        if (!frameSubmitted) internals.gpuPassTimingCapture?.abort({ code: 'frame-aborted' });
      }
    },
  };
}
