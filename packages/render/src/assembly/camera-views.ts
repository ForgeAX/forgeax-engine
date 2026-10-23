import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  type RhiCommandEncoder,
  type RhiDevice,
  RhiError,
  type Texture,
} from '@forgeax/engine-rhi';
import { type AssetHandle, ok } from '@forgeax/engine-types';
import { createRendererCaptureOwner } from '../capture/renderer-captures';
import { Camera } from '../components/camera';
import { CameraView, type CameraViewData, cameraViewExtent } from '../components/camera-view';
import { CubeCamera } from '../components/cube-camera';
import {
  STEREO_EYES,
  StereoCamera,
  type StereoEye,
  stereoEyeViewport,
} from '../components/stereo-camera';
import { CameraViewInvalidError } from '../errors/render';
import type { CameraViewInspection } from '../inspection-types';
import type { DeviceScope } from '../lifecycle';
import { createOutputColorSpaceState } from '../output-color-space';
import type { PreparedRenderPublication, RenderPublicationReceiver } from '../publication/receiver';
import { DiffuseGiBudget } from '../raytracing/diffuse-gi-budget';
import type { GpuTimingCapture } from '../record/gpu-timing';
import type { RenderSystemInternals } from '../record/render-context';
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
import {
  drainFramePreparation,
  type FramePreparation,
  type FrameRecording,
  prepareFrameSubmission,
} from './frame-recording';
import type { LodObservationCapture, LodObservationViewCapture } from './lod-observation';
import { type CompositeChannels, createViewCompositor } from './view-compositor';
import { createViewPipelineState } from './view-pipeline-state';

interface View {
  readonly key: string;
  readonly entity: number;
  readonly eye: StereoEye | undefined;
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly system: RenderSystem;
  readonly composite: ReturnType<typeof createViewCompositor>;
  output: { texture: Texture; width: number; height: number; eye?: StereoEye } | undefined;
  viewport: ReturnType<typeof cameraViewExtent>;
  target: RenderTarget | undefined;
  renderedFrames: number;
  lastFrame: number;
}

/** One enabled-or-disabled composed view: a CameraView or one stereo eye of it. */
interface CameraViewRow {
  readonly key: string;
  readonly entity: number;
  readonly eye: StereoEye | undefined;
  readonly eyeIndex: number;
  readonly channels: CompositeChannels;
  readonly config: CameraViewData;
  readonly target: RenderTarget | undefined;
  readonly viewGeneration: number;
  readonly attachmentId: string | undefined;
}

type ViewSource =
  | {
      readonly publication: PreparedRenderPublication;
      readonly receiver: RenderPublicationReceiver;
    }
  | undefined;

/**
 * The publication a system records: a system not yet seeded from this source,
 * or one that requires a baseline, receives the full scene snapshot; others
 * consume only the accepted delta.
 */
function publicationFor(
  source: ViewSource,
  system: RenderSystem,
  seeded: boolean,
): PreparedRenderPublication | undefined {
  if (source === undefined) return undefined;
  return !seeded || system.publicationBaselineRequired(source.publication)
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
  return [CameraView, StereoCamera].some(
    (composed) =>
      world
        .query({ with: [Camera, composed] })
        .unwrap()
        [Symbol.iterator]()
        .next().done === false,
  );
}

function hasCubeCamera(world: World): boolean {
  return (
    world
      .query({ with: [CubeCamera] })
      .unwrap()
      [Symbol.iterator]()
      .next().done === false
  );
}

function cameraAttachmentId(
  camera: CameraSnapshot,
  world: World | undefined,
  worlds: readonly World[],
): string | undefined {
  return camera.worldId === undefined ? world?.identity : worlds[camera.worldId]?.identity;
}

/** A camera's composed views: itself, or one ordinary CameraView per stereo eye. */
function cameraViewRows(camera: CameraSnapshot, attachmentId: string | undefined): CameraViewRow[] {
  if (camera.view === undefined) return [];
  if (camera.entityKey === undefined)
    throw new CameraViewInvalidError('entityKey', camera.entityKey, 'a camera entity identity');
  const entity = camera.entityKey;
  const config = camera.view;
  const stereo = camera.stereo;
  const viewGeneration = camera.historyVersion ?? 0;
  if (stereo === undefined)
    return [
      {
        key: String(entity),
        entity,
        eye: undefined,
        eyeIndex: 0,
        channels: 'all',
        config,
        target: camera.target,
        viewGeneration,
        attachmentId,
      },
    ];
  // Each eye is an ordinary CameraView over its half of the authored rectangle.
  return STEREO_EYES.map((eye, eyeIndex) => ({
    key: `${entity}:${eye}`,
    entity,
    eye,
    eyeIndex,
    channels: stereoEyeChannels(stereo, eye),
    config: { ...config, viewport: stereoEyeViewport(config.viewport, stereo, eye) },
    target: camera.target,
    viewGeneration,
    attachmentId,
  }));
}

function stereoEyeChannels(
  stereo: NonNullable<CameraSnapshot['stereo']>,
  eye: StereoEye,
): CompositeChannels {
  if (stereo.layout !== 'anaglyph') return 'all';
  return (eye === 'left') !== stereo.swapEyes ? 'red' : 'cyan';
}

/** Probe placement admits exactly one active display view and no capture views. */
function assertProbePlacementViews(
  publication: PreparedRenderPublication | undefined,
  world: World | undefined,
  rows: readonly CameraViewRow[],
): void {
  const captures =
    publication === undefined
      ? world !== undefined &&
        (hasCubeCamera(world) || selectCameraRoles(world).auxiliary.length > 0)
      : publication.frame.cubeCameras.length > 0 || publication.frame.auxiliaryCameras.length > 0;
  if (captures || rows.filter((row) => row.config.enabled).length > 1)
    throw new RhiError({
      code: 'rhi-not-available',
      expected:
        'one active perspective display view without auxiliary, Cube or reflection views for probe placement',
      hint: 'disable placement or remove the additional views',
    });
}

/** Does any Cube or non-planar auxiliary camera need the shared capture recording? */
function sharedCaptureDemand(
  publication: PreparedRenderPublication | undefined,
  world: World | undefined,
): boolean {
  if (publication !== undefined)
    return (
      publication.frame.cubeCameras.length > 0 ||
      publication.frame.auxiliaryCameras.some((camera) => camera.planarReflection === undefined)
    );
  return (
    world !== undefined &&
    (hasCubeCamera(world) ||
      selectCameraRoles(world).auxiliary.some((camera) => camera.planarReflection === undefined))
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
  replaced: readonly { view: View; old: View['output']; texture: Texture }[],
  submitted: boolean,
): void {
  for (const replacement of replaced) {
    const texture = submitted ? replacement.old?.texture : replacement.texture;
    if (!submitted) replacement.view.output = replacement.old;
    if (texture !== undefined) {
      const dispose = () => {
        device.destroyTexture(texture);
      };
      void device.queue.onSubmittedWorkDone().then(dispose, dispose);
    }
  }
}

function viewObservation(
  row: CameraViewRow,
  view: View,
  rendered: boolean,
): LodObservationViewCapture {
  const inspection = rendered ? view.system.lodOcclusionInspection : undefined;
  return Object.freeze({
    viewKey: row.key,
    entityKey: Number(row.entity),
    eye: row.eye,
    attachmentId: inspection?.view.attachmentId ?? row.attachmentId ?? 'none',
    viewGeneration: row.viewGeneration,
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
  const primaryInspection = primary.lodOcclusionInspection;
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

/** Renderer-owned views share one device, asset cache, frame encoder and submission. */
export function createCameraViews(internals: RenderSystemInternals, primary: RenderSystem) {
  const views = new Map<string, View>();
  // Every view's field splits the per-frame GI budgets through this one owner.
  internals.giBudget ??= new DiffuseGiBudget();
  internals.rendererCaptureOwner ??= createRendererCaptureOwner((target) =>
    internals.getRenderTargetPhysical?.(target),
  );
  let generation = internals.deviceScope.generation;
  let ownerIdentity: string | undefined;
  let frame = 0;
  let active = false;
  let lastLodObservationCapture: LodObservationCapture | undefined;
  let capturePublicationSeeded = false;
  let surfaceDynamicInput: Parameters<RenderSystem['setSurfaceDynamicInput']>[0];
  let composite = createViewCompositor(internals);
  const retire = (view: View) => {
    const dispose = () => {
      if (view.output !== undefined) view.device.destroyTexture(view.output.texture);
      view.composite.dispose();
      view.system.disposeFrameState();
      view.scope.dispose();
    };
    void view.device.queue.onSubmittedWorkDone().then(dispose, dispose);
  };
  const clear = () => {
    capturePublicationSeeded = false;
    for (const view of views.values()) retire(view);
    views.clear();
  };
  const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw r.error;
    return r.value;
  };
  const systems = (): readonly RenderSystem[] =>
    active ? [...views.values()].map((view) => view.system) : [primary];
  const allSystems = (): readonly RenderSystem[] => [
    primary,
    ...[...views.values()].map((view) => view.system),
  ];
  const isLodObservationViewCurrent = (
    capture: LodObservationCapture,
    row: LodObservationViewCapture,
  ): boolean => {
    if (lastLodObservationCapture !== capture) return false;
    if (row.primary) return !active && row.system === primary;
    const view = views.get(row.viewKey);
    return view !== undefined && view === row.viewRef && view.system === row.system;
  };
  /** A view's private record internals over the shared Renderer internals. */
  const createView = (
    row: CameraViewRow,
    viewport: View['viewport'],
    base: NonNullable<ReturnType<RenderSystemInternals['getPipelineState']>>,
  ): View => {
    const { key, entity, eye, target } = row;
    const scope = internals.deviceScope.createChild(`camera:${key}`);
    try {
      let view: View | undefined;
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
            view?.output ?? {
              width: viewport.renderWidth,
              height: viewport.renderHeight,
            },
        },
        viewOutput: {
          configurable: true,
          enumerable: true,
          get: () => view?.output,
        },
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
        gpuPassTimingViewId: property(entity),
        invalidateShaderModule: property(() => undefined),
        encodeRenderTargetReadbacks: property(() => undefined),
        encodeFramebufferSnapshots: property(
          (encoder: RhiCommandEncoder, source: FramebufferSnapshotSource) =>
            internals.encodeFramebufferSnapshots?.(encoder, {
              ...source,
              camera: entity,
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
        key,
        entity,
        eye,
        device: internals.device,
        scope,
        system,
        composite: createViewCompositor(internals),
        viewport,
        target,
        output: undefined,
        renderedFrames: 0,
        lastFrame: -Infinity,
      };
      views.set(key, view);
      return view;
    } catch (cause) {
      scope.dispose();
      throw cause;
    }
  };
  /** Reuse the row's view unless its target changed; returns undefined when one must be created. */
  const retainedView = (row: CameraViewRow): View | undefined => {
    const view = views.get(row.key);
    if (view === undefined || view.target === row.target) return view;
    retire(view);
    views.delete(row.key);
    return undefined;
  };
  /**
   * (Re)allocate the view's output when its size changes; the previous output
   * is retained until submission decides which one to release.
   */
  const ensureViewOutput = (
    view: View,
    key: string,
    width: number,
    height: number,
    base: NonNullable<ReturnType<RenderSystemInternals['getPipelineState']>>,
    replaced: { view: View; old: View['output']; texture: Texture }[],
  ): boolean => {
    if (view.output?.width === width && view.output?.height === height) return false;
    const texture = value(
      internals.device.createTexture({
        label: `camera:${key}:output`,
        size: { width, height, depthOrArrayLayers: 1 },
        format: base.format,
        usage: 0x10 | 0x04 | 0x01,
        textureBindingViewDimension: '2d',
        viewFormats: base.format === base.colorAttachmentFormat ? [] : [base.colorAttachmentFormat],
      }),
    );
    replaced.push({ view, old: view.output, texture });
    view.output = { texture, width, height, ...(view.eye === undefined ? {} : { eye: view.eye }) };
    return true;
  };
  /** Decode each completed RenderTarget picture, then composite display views to the surface. */
  const encodeComposite = (
    encoder: RhiCommandEncoder,
    pictures: readonly {
      texture: Texture;
      viewport: ReturnType<typeof cameraViewExtent>;
      channels: CompositeChannels;
    }[],
  ): boolean => {
    // Material sources consume linear values; decode each completed picture
    // into its logical target through the same graph/encoder owner.
    for (const view of views.values()) {
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
    for (const view of views.values()) {
      if (view.target === undefined || view.output === undefined) continue;
      const target = internals.getRenderTargetPhysical?.(view.target);
      if (target !== undefined) internals.markRenderTargetSubmitted?.(view.target, target);
    }
  };
  /** Leave composed mode and record the frame through the primary system alone. */
  function* preparePrimarySubmission(
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    leases: readonly RenderReadLease[] | undefined,
    timing: GpuTimingCapture | undefined,
    source: ViewSource,
    isCurrent: (() => boolean) | undefined,
  ): FramePreparation {
    const publication = source?.publication;
    const world = worlds[opts.cameraOwner];
    const wasActive = active;
    if (active) {
      clear();
      composite.dispose();
    }
    active = false;
    const frameSubmitted = yield* primary.prepareSubmission(
      worlds,
      opts,
      leases,
      timing,
      publicationFor(source, primary, !wasActive),
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
  /** The view's RenderTarget physical texture; `null` when a declared target is not resident. */
  const viewTargetPhysical = (row: CameraViewRow) => {
    if (row.target === undefined) return undefined;
    const physical = internals.getRenderTargetPhysical?.(row.target);
    if (physical === undefined) return null;
    assertViewTargetShape(physical);
    return physical;
  };
  /** A held view re-renders on temporal reset or once its update interval elapses. */
  const viewRendersThisFrame = (view: View, row: CameraViewRow, opts: DrawOwnerOptions): boolean =>
    opts.temporalReset === true || frame - view.lastFrame >= row.config.updateInterval;
  /** Retire views from another device generation or source World. */
  const adoptOwner = (identity: string | undefined): void => {
    if (generation === internals.deviceScope.generation && ownerIdentity === identity) return;
    clear();
    ownerIdentity = identity;
    generation = internals.deviceScope.generation;
    composite.dispose();
    composite = createViewCompositor(internals);
  };
  /** Enabled rows in composition order; views no longer selected retire. */
  const selectViews = (rows: readonly CameraViewRow[]): CameraViewRow[] => {
    const selected = rows
      .filter((row) => row.config.enabled)
      .sort(
        (a, b) =>
          a.config.order - b.config.order ||
          Number(a.entity) - Number(b.entity) ||
          a.eyeIndex - b.eyeIndex,
      );
    const keys = new Set(selected.map((row) => row.key));
    for (const [key, view] of views)
      if (!keys.has(key)) {
        retire(view);
        views.delete(key);
      }
    return selected;
  };
  /** Record every selected view, the shared capture view and the composite into one encoder. */
  function* prepareViewSubmission(
    rows: readonly CameraViewRow[],
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    leases: readonly RenderReadLease[] | undefined,
    source: ViewSource,
    isCurrent: (() => boolean) | undefined,
  ): FramePreparation {
    const publication = source?.publication;
    const world = worlds[opts.cameraOwner];
    active = true;
    adoptOwner(publication?.resources.identity ?? world?.identity);
    const base = internals.getPipelineState();
    if (base === null) return false;
    const selected = selectViews(rows);
    const encoder = value(
      internals.device.createCommandEncoder({
        label: `multi-camera-frame:${internals.observationFrameId ?? frame}`,
      }),
    );
    const recordings: FrameRecording[] = [];
    const pictures: {
      texture: Texture;
      viewport: ReturnType<typeof cameraViewExtent>;
      channels: CompositeChannels;
    }[] = [];
    const submittedViews: {
      readonly row: CameraViewRow;
      readonly view: View;
      readonly rendered: boolean;
    }[] = [];
    const replaced: { view: View; old: View['output']; texture: Texture }[] = [];
    const device = internals.device;
    let submitted = false;
    let captureDemand = false;
    try {
      for (const row of selected) {
        const viewport = cameraViewExtent(
          row.config,
          internals.canvas.width,
          internals.canvas.height,
        );
        const retained = retainedView(row);
        const view = retained ?? createView(row, viewport, base);
        view.viewport = viewport;
        const physical = viewTargetPhysical(row);
        if (physical === null) return false;
        const resized = ensureViewOutput(
          view,
          row.key,
          physical?.descriptor.width ?? viewport.renderWidth,
          physical?.descriptor.height ?? viewport.renderHeight,
          base,
          replaced,
        );
        const render = resized || viewRendersThisFrame(view, row, opts);
        // Every accepted source delta reaches every retained view, even when its
        // picture is held. New/re-enabled views seed from the current scene.
        recordings.push(
          view.system.record(
            worlds,
            { ...opts, cameraEntityKey: row.entity },
            leases,
            undefined,
            publicationFor(source, view.system, retained !== undefined),
            encoder,
            render,
          ),
        );
        submittedViews.push({ row, view, rendered: render });
        if (row.target === undefined && view.output !== undefined)
          pictures.push({ texture: view.output.texture, viewport, channels: row.channels });
      }
      captureDemand = sharedCaptureDemand(publication, world);
      const captureCamera = selected[0] ?? rows[0];
      if (captureCamera !== undefined && (captureDemand || capturePublicationSeeded)) {
        recordings.push(
          primary.record(
            worlds,
            { ...opts, cameraEntityKey: captureCamera.entity },
            leases,
            undefined,
            publicationFor(source, primary, capturePublicationSeeded),
            encoder,
            'capture',
          ),
        );
      }
      // The composite is also a recorded view so an all-disabled frame still clears and submits.
      recordings.push(submitSharedEncoder(internals, device, encoder));
      submitted = yield* prepareFrameSubmission(
        recordings,
        () => encodeComposite(encoder, pictures),
        internals,
        isCurrent,
      );
      if (submitted) markViewTargetsSubmitted();
      capturePublicationSeeded = captureDemand && submitted;
    } finally {
      releaseReplacedOutputs(device, replaced, submitted);
    }
    if (submitted) commitSubmittedViews(submittedViews, leases);
    return submitted;
  }
  /** Advance held/rendered view history and publish this frame's LOD observation. */
  const commitSubmittedViews = (
    submittedViews: readonly {
      readonly row: CameraViewRow;
      readonly view: View;
      readonly rendered: boolean;
    }[],
    leases: readonly RenderReadLease[] | undefined,
  ): void => {
    for (const { view, rendered } of submittedViews) {
      if (!rendered) continue;
      view.lastFrame = frame;
      view.renderedFrames += 1;
    }
    lastLodObservationCapture = Object.freeze({
      frameId: internals.observationFrameId ?? 0,
      deviceGeneration: internals.deviceScope.generation,
      views: Object.freeze(
        submittedViews.map(({ row, view, rendered }) => viewObservation(row, view, rendered)),
      ),
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
      return active
        ? [...views.values()].map((view) => ({
            view: view.key,
            sections: view.system.submittedTerrain,
          }))
        : [{ view: 'primary', sections: primary.submittedTerrain }];
    },
    get currentSystem(): RenderSystem {
      return active ? (views.values().next().value?.system ?? primary) : primary;
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
      if (!active) return primary.isDynamicGeometryConsumed(...args);
      for (const view of views.values())
        if (view.system.isDynamicGeometryConsumed(...args)) return true;
      return false;
    },
    isCubeCapturePending(target: RenderTarget): boolean {
      if (!active) return primary.isCubeCapturePending(target);
      for (const view of views.values()) if (view.system.isCubeCapturePending(target)) return true;
      return false;
    },
    dynamicGeometryRecordStageLane(
      ...args: Parameters<RenderSystem['dynamicGeometryRecordStageLane']>
    ) {
      if (!active) return primary.dynamicGeometryRecordStageLane(...args);
      for (const view of views.values()) {
        const lane = view.system.dynamicGeometryRecordStageLane(...args);
        if (lane !== undefined) return lane;
      }
      return undefined;
    },
    get active() {
      return active;
    },
    get presentation(): FramePresentation | undefined {
      return active
        ? [...views.values()].every((v) => v.system.presentation === 'ready')
          ? 'ready'
          : 'pending'
        : undefined;
    },
    get presentationPendingReason(): FramePresentationPendingReason | undefined {
      if (!active) return undefined;
      for (const view of views.values())
        if (view.system.presentation === 'pending')
          return Object.freeze({
            ...(view.system.presentationPendingReason ?? { code: 'camera-view-pending' as const }),
            view: view.key.slice(0, 256),
          });
      return undefined;
    },
    inspect(): readonly CameraViewInspection[] {
      return [...views.values()].map((v) => ({
        entityKey: v.entity,
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
      active = false;
      clear();
      composite.dispose();
    },
    reset() {
      clear();
    },
    detach(world: World) {
      if (ownerIdentity === world.identity) {
        active = false;
        clear();
      }
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
        active ? composite.generation : (primary.perFrameGraphInfo?.generation ?? 0),
      );
      try {
        const publication = source?.publication;
        if (publication !== undefined) adoptPublicationAssets(internals, publication);
        const world = worlds[opts.cameraOwner];
        // The primary system owns extraction and diagnostic publication when no
        // composed view is declared. This admission probe reads membership only.
        const declaresViews =
          publication === undefined && world !== undefined && declaresComposedViews(world);
        const cameras =
          publication?.frame.cameras ??
          (!declaresViews || world === undefined
            ? []
            : selectCameraRoles(world, opts.cameraEntityKey).display);
        const rows = cameras.flatMap((camera) =>
          cameraViewRows(camera, cameraAttachmentId(camera, world, worlds)),
        );
        if (internals.standardProfile?.probePlacement !== undefined)
          assertProbePlacementViews(publication, world, rows);
        frameSubmitted =
          rows.length === 0
            ? yield* preparePrimarySubmission(worlds, opts, leases, timing, source, isCurrent)
            : yield* prepareViewSubmission(rows, worlds, opts, leases, source, isCurrent);
        return frameSubmitted;
      } finally {
        if (!frameSubmitted) internals.gpuPassTimingCapture?.abort({ code: 'frame-aborted' });
      }
    },
  };
}
