// Per-frame preparation of the renderer-owned diffuse GI owners (probe
// placement, exact ray diffuse, irradiance field, baked field, screen probes)
// and their shared submission fence/track/commit lifecycle.

import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { RhiError } from '@forgeax/engine-rhi';
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
import type { ViewLights } from '../world/render-lights';
import type { RenderFrameState } from './frame-snapshot';
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
    width: renderExtent?.internalWidth ?? Math.max(1, internals.canvas.width),
    height: renderExtent?.internalHeight ?? Math.max(1, internals.canvas.height),
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
  worlds: readonly RenderResourceScope[],
  camera: CameraSnapshot,
  scene: PersistentGpuDrivenState | undefined,
  visibleSurface: VisibleSurfaceProjection | undefined,
  size: InternalRenderSize,
  renderReadLeases: readonly RenderReadLease[] | undefined,
): void {
  const placement = internals.standardProfile?.probePlacement;
  if (placement === undefined) {
    frameState.probePlacement?.disable();
    return;
  }
  if (visibleSurface === undefined || scene === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the actual visible-surface row projection for placement',
      hint: 'prepare the ordinary rigid deferred scene',
    });
  frameState.probePlacement ??= new RendererProbePlacement();
  frameState.probePlacement.admitMaterials(
    { internals, world, worlds, surfaces: visibleSurface.slotBases },
    scene,
  );
  frameState.probePlacementFrame = frameState.probePlacement.prepare({
    runtime: internals,
    seeds: placement.seeds,
    ...(placement.global === undefined
      ? {}
      : { globalSource: { scene, worlds, leases: renderReadLeases } }),
    camera: camera.entityKey ?? 0,
    world: (worlds[camera.worldId ?? 0] ?? world).identity,
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
  worlds: readonly RenderResourceScope[],
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
    worlds,
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
  worlds: readonly RenderResourceScope[],
  lights: ViewLights,
  camera: CameraSnapshot,
  size: InternalRenderSize,
  renderReadLeases: readonly RenderReadLease[] | undefined,
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
    worlds,
    leases: renderReadLeases,
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
  frameState.screenProbe.prepare({
    runtime: internals,
    profile,
    field: frameState.irradianceField?.ready,
    width: size.width,
    height: size.height,
  });
  return frameState.screenProbe.ready;
}

/**
 * Prepare the display view's GI owners. Capture-only frames keep every owner
 * untouched and record without GI.
 */
export function prepareFrameDiffuseGi(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  camera: CameraSnapshot,
  lights: ViewLights,
  pipelineState: PipelineState,
  scene: PersistentGpuDrivenState | undefined,
  visibleSurface: VisibleSurfaceProjection | undefined,
  renderExtent: RenderExtent | undefined,
  renderReadLeases: readonly RenderReadLease[] | undefined,
  captureOnly: boolean,
): FrameDiffuseGi {
  const size = internalRenderSize(internals, renderExtent);
  prepareProbePlacement(
    internals,
    frameState,
    world,
    worlds,
    camera,
    scene,
    visibleSurface,
    size,
    renderReadLeases,
  );
  const probePlacement = frameState.probePlacementFrame;
  // A capture view writes raw scene output and consumes no GI field.
  if (captureOnly || internals.captureView !== undefined) {
    return {
      rayDiffuse: undefined,
      irradianceField: undefined,
      bakedField: undefined,
      screenProbe: undefined,
      probePlacement,
    };
  }
  const rayDiffuse = prepareRayDiffuse(
    internals,
    frameState,
    scene,
    visibleSurface,
    worlds,
    lights,
    pipelineState,
    size,
  );
  const irradianceField = prepareIrradianceField(
    internals,
    frameState,
    scene,
    worlds,
    lights,
    camera,
    size,
    renderReadLeases,
  );
  const bakedField = prepareBakedField(internals, frameState, size);
  const screenProbe = prepareScreenProbe(internals, frameState, size);
  return { rayDiffuse, irradianceField, bakedField, screenProbe, probePlacement };
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
      previousViewProjection !== undefined &&
      previousCameraPosition !== undefined
      ? { viewProjection: previousViewProjection, cameraPosition: previousCameraPosition }
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
