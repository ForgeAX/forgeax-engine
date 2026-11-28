// Per-frame preparation of the renderer-owned diffuse GI owners (probe
// placement, exact ray diffuse, irradiance field, baked field, screen probes)
// and their shared submission fence/track/commit lifecycle.

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { RhiError } from '@forgeax/engine-rhi';
import { isTimestampQueryAdmitted } from '../assembly/device-feature-admission';
import { DynamicResolutionController } from '../pipeline/dynamic-resolution';
import type { RenderExtent } from '../pipeline/render-extent';
import type { RenderResourceScope } from '../publication/resource-scope';
import { RendererBakedField } from '../raytracing/renderer-baked-field';
import { RendererRayDiffuse } from '../raytracing/renderer-diffuse';
import { RendererIrradianceField } from '../raytracing/renderer-irradiance-field';
import { RendererProbePlacement } from '../raytracing/renderer-probe-placement';
import { RendererScreenProbe } from '../raytracing/renderer-screen-probe';
import type { VisibleSurfaceProjection } from '../raytracing/visible-surface';
import type { CameraSnapshot } from '../render-contract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { TemporalView } from '../temporal/view';
import { requireGiSubmissions, viewDiffuseGiOf } from '../world/gi-systems';
import { type ViewLights, viewLightsOf } from '../world/render-lights';
import { renderWorldFor } from '../world/render-world';
import {
  type StagedViewInputs,
  stagedViewInputs,
  type ViewFrameState,
} from '../world/view-frame-systems';
import { recordContext } from '../world/view-record-context';
import type { ViewSettlementOwner } from '../world/view-settlement';
import { projectFrameVisibleSurface } from './frame-admission';
import { makeZeroCameraFallbackSnapshot, type RenderFrameState } from './frame-snapshot';
import type { PipelineState, RenderSystemInternals } from './render-context';

interface InternalRenderSize {
  readonly width: number;
  readonly height: number;
}

/** GI owners that this frame prepared and must fence, track and commit with its submission. */
export interface FrameDiffuseGi {
  readonly rayDiffuse: NonNullable<RenderFrameState['rayDiffuse']>['ready'];
  readonly irradianceField: NonNullable<RenderFrameState['irradianceField']>['ready'];
  readonly bakedField: NonNullable<RenderFrameState['bakedField']>['ready'];
  readonly screenProbe: NonNullable<RenderFrameState['screenProbe']>['ready'];
  readonly probePlacement: RenderFrameState['probePlacementFrame'];
}

function internalRenderSize(
  internals: RenderSystemInternals,
  renderExtent: RenderExtent | undefined,
): InternalRenderSize {
  return {
    width: renderExtent?.internalWidth ?? Math.max(1, recordContext(internals).canvas.width),
    height: renderExtent?.internalHeight ?? Math.max(1, recordContext(internals).canvas.height),
  };
}

function frameLightList(lights: ViewLights) {
  return [
    ...(lights.directional === undefined ? [] : [lights.directional]),
    ...lights.point,
    ...lights.spot,
    ...lights.rect,
  ];
}

function requireRetainedScene(
  scene: PersistentGpuDrivenState | undefined,
  expected: string,
): PersistentGpuDrivenState {
  if (scene === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected,
      hint: 'prepare the ordinary deferred scene before enabling diffuse GI',
    });
  return scene;
}

function prepareProbePlacement(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  sourceScope: RenderResourceScope,
  camera: CameraSnapshot,
  scene: PersistentGpuDrivenState | undefined,
  visibleSurface: VisibleSurfaceProjection | undefined,
  size: InternalRenderSize,
  renderReadLease: RenderReadLease | undefined,
): RenderFrameState['probePlacementFrame'] {
  const placement = internals.standardProfile?.probePlacement;
  if (placement === undefined) {
    frameState.probePlacement?.disable();
    return undefined;
  }
  if (visibleSurface === undefined || scene === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the actual visible-surface row projection for placement',
      hint: 'prepare the ordinary rigid deferred scene',
    });
  frameState.probePlacement ??= new RendererProbePlacement();
  frameState.probePlacement.admitMaterials(
    { internals, world, sourceScope, surfaces: visibleSurface.slotBases },
    scene,
  );
  return frameState.probePlacement.prepare({
    runtime: internals,
    seeds: placement.seeds,
    ...(placement.global === undefined
      ? {}
      : { globalSource: { scene, sourceScope, lease: renderReadLease } }),
    camera: camera.entityKey ?? 0,
    world: (sourceScope ?? world).identity,
    records: visibleSurface.records,
    width: size.width,
    height: size.height,
  });
}

function prepareRayDiffuse(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  scene: PersistentGpuDrivenState | undefined,
  visibleSurface: VisibleSurfaceProjection | undefined,
  sourceScope: RenderResourceScope,
  lights: ViewLights,
  pipelineState: PipelineState,
  size: InternalRenderSize,
): FrameDiffuseGi['rayDiffuse'] {
  const profile = internals.standardProfile?.diffuseGi;
  if (profile?.gather !== 'exact') {
    // Preserve the generation counter across toggles. A retained graph must
    // never confuse a new preparation with a retired allocation's generation.
    frameState.rayDiffuse?.disable();
    return frameState.rayDiffuse?.ready;
  }
  const retained = requireRetainedScene(scene, 'a retained scene for diffuse GI');
  if (visibleSurface === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the frame visible-surface projection for exact diffuse GI',
      hint: 'diffuse GI profiles enable visible surfaces; prepare the ordinary deferred scene',
    });
  frameState.rayDiffuse ??= new RendererRayDiffuse();
  frameState.rayDiffuse.prepare({
    runtime: internals,
    scene: retained,
    visibleSurface,
    sourceScope,
    lights: frameLightList(lights),
    sampler: pipelineState.defaultSampler,
    profile,
    width: size.width,
    height: size.height,
  });
  return frameState.rayDiffuse.ready;
}

/**
 * One persistent field serves both its own per-pixel gather and, as the world
 * fallback and Card-radiance producer, the Screen Probe gather.
 */
function prepareIrradianceField(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  scene: PersistentGpuDrivenState | undefined,
  visibleSurface: VisibleSurfaceProjection | undefined,
  sourceScope: RenderResourceScope,
  lights: ViewLights,
  camera: CameraSnapshot,
  size: InternalRenderSize,
  renderReadLease: RenderReadLease | undefined,
): FrameDiffuseGi['irradianceField'] {
  const fieldGi = internals.standardProfile?.diffuseGi;
  if (fieldGi?.gather !== 'irradiance-field' && fieldGi?.gather !== 'screen-probe') {
    frameState.irradianceField?.disable();
    return undefined;
  }
  const retained = requireRetainedScene(scene, `a retained scene for ${fieldGi.gather} diffuse GI`);
  frameState.irradianceField ??= new RendererIrradianceField();
  frameState.irradianceField.prepare({
    runtime: internals,
    scene: retained,
    sourceScope,
    lease: renderReadLease,
    lights: frameLightList(lights),
    profile: {
      gather: 'irradiance-field',
      maxDistance: fieldGi.maxDistance,
      environment: fieldGi.environment,
      field: fieldGi.field,
      ...(fieldGi.reflections === undefined ? {} : { reflections: fieldGi.reflections }),
    },
    width: size.width,
    height: size.height,
    // Screen Probes own the diffuse view gather; Lite reflections stay field-owned.
    gatherView: fieldGi.gather === 'irradiance-field',
    farRadiance:
      fieldGi.gather === 'screen-probe' &&
      fieldGi.probes.integration === 'screen-space' &&
      internals.device.caps.rayQuery.supported,
    visibleSurface,
    focus: [camera.position[0] ?? 0, camera.position[1] ?? 0, camera.position[2] ?? 0],
  });
  return fieldGi.gather === 'irradiance-field' ? frameState.irradianceField.ready : undefined;
}

/** Baked GI only gathers a Catalog volume: no scene, Cards or probe updates. */
function prepareBakedField(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  size: InternalRenderSize,
): FrameDiffuseGi['bakedField'] {
  const profile = internals.standardProfile?.diffuseGi;
  if (profile?.gather !== 'baked') {
    frameState.bakedField?.disable();
    return frameState.bakedField?.ready;
  }
  frameState.bakedField ??= new RendererBakedField();
  frameState.bakedField.prepare({
    runtime: internals,
    profile,
    width: size.width,
    height: size.height,
  });
  return frameState.bakedField.ready;
}

function prepareScreenProbe(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  size: InternalRenderSize,
): FrameDiffuseGi['screenProbe'] {
  const profile = internals.standardProfile?.diffuseGi;
  if (profile?.gather !== 'screen-probe') {
    frameState.screenProbe?.disable();
    return frameState.screenProbe?.ready;
  }
  frameState.screenProbe ??= new RendererScreenProbe();
  const field = frameState.irradianceField?.ready;
  const plannedTraversal = frameState.irradianceField?.plannedTraversal;
  const softwareTracing = profile.softwareTracing;
  frameState.screenProbe.prepare({
    reconstruction: 'current-support',
    runtime: internals,
    visibleSurface: internals.standardProfile?.visibleSurface === true,
    profile,
    field,
    plannedTraversal,
    plannedFarRadiance: frameState.irradianceField?.plannedFarRadiance,
    ...((field?.traversal ?? plannedTraversal) === 'global-sdf' && softwareTracing !== undefined
      ? { softwareWorld: { kind: 'mesh-df', policy: softwareTracing } as const }
      : {}),
    width: size.width,
    height: size.height,
  });
  return frameState.screenProbe.ready;
}

/**
 * Prepare the display view's GI owners. Capture-only frames keep every owner
 * untouched and record without GI. The `view-diffuse-gi` RenderPrepare system
 * calls it through {@link prepareViewDiffuseGi}; commit and retirement are the
 * `gi-submission-*` systems.
 */
export function prepareFrameDiffuseGi(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  sourceScope: RenderResourceScope,
  camera: CameraSnapshot,
  lights: ViewLights,
  pipelineState: PipelineState,
  scene: PersistentGpuDrivenState | undefined,
  visibleSurface: VisibleSurfaceProjection | undefined,
  renderExtent: RenderExtent | undefined,
  renderReadLease: RenderReadLease | undefined,
  captureOnly: boolean,
): FrameDiffuseGi {
  const size = internalRenderSize(internals, renderExtent);
  const probePlacement = prepareProbePlacement(
    internals,
    frameState,
    world,
    sourceScope,
    camera,
    scene,
    visibleSurface,
    size,
    renderReadLease,
  );
  // A capture view writes raw scene output and consumes no GI field.
  if (captureOnly || recordContext(internals).captureView !== undefined) {
    return enqueueFrameDiffuseGi(internals, {
      rayDiffuse: undefined,
      irradianceField: undefined,
      bakedField: undefined,
      screenProbe: undefined,
      probePlacement,
    });
  }
  let rayDiffuse: FrameDiffuseGi['rayDiffuse'];
  let irradianceField: FrameDiffuseGi['irradianceField'];
  let bakedField: FrameDiffuseGi['bakedField'];
  let screenProbe: FrameDiffuseGi['screenProbe'];
  try {
    rayDiffuse = prepareRayDiffuse(
      internals,
      frameState,
      scene,
      visibleSurface,
      sourceScope,
      lights,
      pipelineState,
      size,
    );
    irradianceField = prepareIrradianceField(
      internals,
      frameState,
      scene,
      visibleSurface,
      sourceScope,
      lights,
      camera,
      size,
      renderReadLease,
    );
    bakedField = prepareBakedField(internals, frameState, size);
    screenProbe = prepareScreenProbe(internals, frameState, size);
  } catch (cause) {
    // The placement frame never reaches the Render World queue.
    probePlacement?.abort();
    throw cause;
  }
  return enqueueFrameDiffuseGi(internals, {
    rayDiffuse,
    irradianceField,
    bakedField,
    screenProbe,
    probePlacement,
  });
}

const NO_DIFFUSE_GI: FrameDiffuseGi = Object.freeze({
  rayDiffuse: undefined,
  irradianceField: undefined,
  bakedField: undefined,
  screenProbe: undefined,
  probePlacement: undefined,
});

/** A view's RenderPrepare product: its dynamic-resolution extent and the GI owners it prepared. */
export interface PreparedViewDiffuseGi {
  readonly resolution: DynamicResolutionController;
  readonly renderExtent: RenderExtent | undefined;
  readonly gi: FrameDiffuseGi;
}

/**
 * Why `view-diffuse-gi` could not prepare a view: its frame inputs were
 * unreadable, its dynamic resolution failed to configure, its visible-surface
 * projection was unavailable, or a GI owner failed to prepare.
 */
export type ViewDiffuseGiFailureCode =
  | 'view-inputs-unavailable'
  | 'resolution-failed'
  | 'visible-surface-failed'
  | 'gi-prepare-failed';

/** The view's prepared GI, or the closed code and structured cause its recording rethrows. */
export type ViewDiffuseGiOutcome =
  | { readonly ok: true; readonly value: PreparedViewDiffuseGi }
  | { readonly ok: false; readonly code: ViewDiffuseGiFailureCode; readonly cause: unknown };

function configureViewResolution(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  sourceScope: RenderResourceScope,
  camera: CameraSnapshot,
): Omit<PreparedViewDiffuseGi, 'gi'> {
  frameState.dynamicResolution ??= new DynamicResolutionController();
  const resolution = frameState.dynamicResolution;
  const renderExtent = resolution.configure(
    camera.dynamicResolution,
    sourceScope ?? world,
    camera.entityKey ?? 0,
    Math.max(1, recordContext(internals).canvas.width),
    Math.max(1, recordContext(internals).canvas.height),
    recordContext(internals).deviceScope?.generation ?? 0,
    isTimestampQueryAdmitted(internals.device.caps),
  );
  return { resolution, renderExtent };
}

/**
 * Prepare one staged view's dynamic resolution and, when it renders its
 * picture, its GI owners. The inputs are RenderPrepare state: the view's
 * camera and hoisted canvas extent, its `render-cascade-fit` lights, its GPU
 * scene (read only when a GI profile records) and the `visible-surface-rows`
 * projection. A failure is returned with its closed code, never thrown; the
 * view's recording rethrows its cause inside its record recovery.
 */
export function prepareViewDiffuseGi(
  world: World,
  entity: EntityHandle,
  owner: ViewSettlementOwner,
  staged: ViewFrameState,
): ViewDiffuseGiOutcome {
  const { internals, frameState } = owner;
  let inputs: StagedViewInputs;
  try {
    inputs = stagedViewInputs(world, staged);
  } catch (cause) {
    return { ok: false, code: 'view-inputs-unavailable', cause };
  }
  const { frame, mode, cameras, source } = inputs;
  const resourceWorld = source;
  // No Camera records the internal fallback snapshot, which renders no GI.
  const camera = cameras[0] ?? makeZeroCameraFallbackSnapshot();
  let resolution: Omit<PreparedViewDiffuseGi, 'gi'>;
  try {
    resolution = configureViewResolution(
      internals,
      frameState,
      resourceWorld,
      source as RenderResourceScope,
      camera,
    );
  } catch (cause) {
    return { ok: false, code: 'resolution-failed', cause };
  }
  const lights = viewLightsOf(world, entity);
  const pipelineState = recordContext(internals).getPipelineState();
  // Held and capture-only recordings consume no GI; a view without lights or
  // pipeline state never reaches recording.
  if (mode !== true || cameras.length === 0 || lights === undefined || pipelineState === null)
    return { ok: true, value: { ...resolution, gi: NO_DIFFUSE_GI } };
  const scene = owner.scene.compositionGpuDrivenState();
  let visibleSurface: VisibleSurfaceProjection | undefined;
  try {
    visibleSurface = projectFrameVisibleSurface(internals, scene, frame.renderables);
  } catch (cause) {
    return { ok: false, code: 'visible-surface-failed', cause };
  }
  try {
    const gi = prepareFrameDiffuseGi(
      internals,
      frameState,
      resourceWorld,
      source as RenderResourceScope,
      camera,
      lights,
      pipelineState,
      scene,
      visibleSurface,
      resolution.renderExtent,
      inputs.lease,
      false,
    );
    return { ok: true, value: { ...resolution, gi } };
  } catch (cause) {
    return { ok: false, code: 'gi-prepare-failed', cause };
  }
}

/**
 * The recording's {@link ViewDiffuseGi} of this frame. A recording outside a
 * Render World frame (direct record helpers) configures its resolution and
 * records without GI; a GI profile there is a structured failure.
 */
export function consumeViewDiffuseGi(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  sourceScope: RenderResourceScope,
  camera: CameraSnapshot,
): PreparedViewDiffuseGi {
  const prepared = viewDiffuseGiOf(renderWorldFor(internals), internals.viewEntity);
  if (prepared !== undefined) {
    if (!prepared.ok) throw prepared.cause;
    const placement = prepared.value.gi.probePlacement;
    if (
      placement === undefined ||
      placement.fence.currentGeneration() === placement.fence.capturedGeneration
    )
      return prepared.value;
    // A Feature extract mutated the placement source after RenderPrepare: the
    // view records without it and the stale source rejects the submission.
    placement.abort();
    return { ...prepared.value, gi: { ...prepared.value.gi, probePlacement: undefined } };
  }
  const profile = internals.standardProfile;
  if (
    internals.viewEntity !== undefined ||
    profile?.diffuseGi !== undefined ||
    profile?.probePlacement !== undefined
  )
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the view GI the view-diffuse-gi RenderPrepare system prepared',
      hint: 'record diffuse GI inside a Render World frame of the composition owner',
    });
  return {
    ...configureViewResolution(internals, frameState, world, sourceScope, camera),
    gi: NO_DIFFUSE_GI,
  };
}

/** The Render World frame commits this view's GI once submitted and aborts it otherwise. */
function enqueueFrameDiffuseGi(internals: RenderSystemInternals, gi: FrameDiffuseGi) {
  if (hasDiffuseGiWork(gi)) requireGiSubmissions(internals).prepared.push(gi);
  return gi;
}

/** Continuous geometry reprojects screen probes and the ray-diffuse reconstructions. */
export function reprojectDiffuseGiHistory(
  gi: FrameDiffuseGi,
  camera: CameraSnapshot,
  temporalView: TemporalView,
  previousTemporalView: TemporalView | undefined,
  continuousGeometry: boolean,
): void {
  const previousViewProjection = previousTemporalView?.currentUnjitteredViewProjection;
  const previousCameraPosition = previousTemporalView?.currentCameraPosition;
  gi.screenProbe?.reproject(
    continuousGeometry &&
      previousTemporalView !== undefined &&
      previousViewProjection !== undefined &&
      previousCameraPosition !== undefined
      ? {
          viewProjection: previousViewProjection,
          cameraPosition: previousCameraPosition,
          jitterUv: previousTemporalView.currentJitterUv,
        }
      : undefined,
  );
  gi.rayDiffuse?.reconstruction?.prepare(temporalView, previousTemporalView, camera);
  gi.rayDiffuse?.reflections?.reconstruction?.prepare(temporalView, previousTemporalView, camera);
}

export function hasDiffuseGiWork(gi: FrameDiffuseGi): boolean {
  return (
    gi.rayDiffuse !== undefined ||
    gi.irradianceField !== undefined ||
    gi.bakedField !== undefined ||
    gi.screenProbe !== undefined ||
    gi.probePlacement !== undefined
  );
}

export function diffuseGiFencesCurrent(gi: FrameDiffuseGi): boolean {
  return [
    gi.rayDiffuse?.fence,
    gi.irradianceField?.fence,
    gi.bakedField?.fence,
    gi.screenProbe?.fence,
    gi.probePlacement?.fence,
  ].every((fence) => fence === undefined || fence.currentGeneration() === fence.capturedGeneration);
}

export function trackDiffuseGi(gi: FrameDiffuseGi, done: Promise<void>): void {
  gi.probePlacement?.track(done);
  gi.rayDiffuse?.track(done);
  gi.irradianceField?.track(done);
  gi.bakedField?.track(done);
  gi.screenProbe?.track(done);
}

export function commitDiffuseGi(gi: FrameDiffuseGi): void {
  gi.probePlacement?.commit();
  gi.rayDiffuse?.commit();
  gi.irradianceField?.commit();
  gi.bakedField?.commit();
  gi.screenProbe?.commit();
}
