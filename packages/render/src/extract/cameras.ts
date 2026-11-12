import {
  type EntityHandle,
  FixedTime,
  type SchemaOf,
  type ShapeOf,
  Time,
  type World,
} from '@forgeax/engine-ecs';
import { readMutationEpoch, readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { mat4, vec3 } from '@forgeax/engine-math';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import {
  AmbientOcclusion,
  antialiasFromF32,
  BarrelDistortion,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  CameraView,
  cameraExposureFromColumns,
  cameraProjectionFromF32,
  DynamicResolution,
  MotionBlur,
  ScreenSpaceReflection,
  tonemapFromF32,
  transparencyFromF32,
  validateCameraBloom,
  validateCameraProjectionOffset,
  validateDynamicResolutionCamera,
} from '../components';
import { validateBarrelDistortionParameters } from '../components/barrel-distortion';
import { CAMERA_VIEW_DEFAULTS } from '../components/camera-view';
import { ClippingPlanes, extractClippingPlanes } from '../components/clipping-planes';
import { DepthOfField } from '../components/depth-of-field';
import { LensEffects, resolveLensEffects } from '../components/lens-effects';
import { LensFlare, resolveLensFlare } from '../components/lens-flare';
import { Outline, resolveOutline } from '../components/outline';
import { PlanarReflection, PlanarReflectionInvalidError } from '../components/planar-reflection';
import { resolveStereoCamera, StereoCamera } from '../components/stereo-camera';
import { renderAblation } from '../diagnostics/render-ablation';
import { createEnvironmentQuery, readEnvironmentPose } from '../extract/environment-gate';
import {
  depthOfFieldRequestFailure,
  resolveDepthOfFieldParams,
} from '../features/depth-of-field/depth-of-field-params';
import { resolveMotionBlurParams } from '../features/motion-blur/motion-blur-params';
import type { CameraSnapshot } from '../render-contract';
import { collectCubeCameraSnapshots, resolveCameraTarget } from '../render-system-extract';
import type { RenderTarget } from '../targets/contracts';

const collectCameraSnapshotsQuery = createEnvironmentQuery({
  read: [Camera],
  optional: [
    CameraView,
    MotionBlur,
    DynamicResolution,
    ScreenSpaceReflection,
    AmbientOcclusion,
    DepthOfField,
    BarrelDistortion,
    LensEffects,
    LensFlare,
    ClippingPlanes,
    Outline,
    PlanarReflection,
    StereoCamera,
  ],
  with: [Transform, GlobalTransform],
});

/**
 * The capture camera of a PlanarReflection: the display camera's view without
 * its display target. Target 0 leaves the target unset; the Renderer leases the
 * capture target when it prepares the view.
 */
function planarCaptureSnapshot(
  world: World,
  snapshot: CameraSnapshot,
  planar: { readonly target: number; readonly normal: Float32Array } & Record<string, unknown>,
): CameraSnapshot {
  const reflectionTarget =
    planar.target === 0 ? undefined : resolveCameraTarget(world, planar.target);
  if (planar.target !== 0 && reflectionTarget === undefined)
    throw new PlanarReflectionInvalidError('target');
  const { view: _view, target: _displayTarget, ...capture } = snapshot;
  const { target: _target, ...reflection } = planar;
  return {
    ...capture,
    ...(reflectionTarget === undefined ? {} : { target: reflectionTarget }),
    planarReflection: { ...reflection, normal: new Float32Array(planar.normal) },
  } as CameraSnapshot;
}

/**
 * PlanarReflection admission: a render-target camera needs an explicit view,
 * the mirror needs a positive update interval, the normal distortion radius is
 * finite and non-negative, and the engine-owned target scale is finite and
 * positive. A zero target asks the Renderer to own the capture target.
 */
function validatePlanarReflection(
  planar: {
    readonly target: number;
    readonly updateIntervalFrames: number;
    readonly distortion: number;
    readonly resolutionScale: number;
  },
  camTarget: number,
  cameraView: unknown,
): void {
  if (camTarget !== 0 && cameraView === undefined) throw new PlanarReflectionInvalidError('camera');
  if (!(Number.isFinite(planar.resolutionScale) && planar.resolutionScale > 0))
    throw new PlanarReflectionInvalidError('resolutionScale');
  if (planar.updateIntervalFrames < 1)
    throw new PlanarReflectionInvalidError('updateIntervalFrames');
  if (!(Number.isFinite(planar.distortion) && planar.distortion >= 0))
    throw new PlanarReflectionInvalidError('distortion');
}

/** Only an explicit 0 is stored on the snapshot; the default stays implicit. */
function taaFlickeringField(value: number): { taaFlickering?: false } {
  return value === 0 ? { taaFlickering: false } : {};
}

interface CameraMemo {
  readonly epoch: number;
  readonly structure: number;
  readonly elapsed: number;
  readonly tick: number;
  readonly overstep: number;
  readonly cameras: CameraSnapshot[];
}
const cameraMemos = new WeakMap<World, CameraMemo>();

/**
 * Camera snapshots are a pure function of World state, Time and the fixed-step
 * phase (interpolated poses). Several roles select cameras within one frame
 * with no World write between them, so the same inputs reuse the same result.
 * Callers treat the returned list as read-only.
 */
export function collectCameraSnapshots(world: World): CameraSnapshot[] {
  const epoch = readMutationEpoch(world);
  const structure = world.getStructureEpoch();
  const elapsed = world.getResource(Time).elapsed;
  const fixed = world.getResource(FixedTime);
  const memo = cameraMemos.get(world);
  if (
    memo !== undefined &&
    memo.epoch === epoch &&
    memo.structure === structure &&
    memo.elapsed === elapsed &&
    memo.tick === fixed.tick &&
    memo.overstep === fixed.overstep
  )
    return memo.cameras;
  const cameras = buildCameraSnapshots(world);
  cameraMemos.set(world, {
    epoch: readMutationEpoch(world),
    structure,
    elapsed,
    tick: fixed.tick,
    overstep: fixed.overstep,
    cameras,
  });
  return cameras;
}

/** Diagnostic ablation: `fxaa: false` turns authored FXAA off. */
function ablatedAntialias<T>(authored: T): T | 'none' {
  return renderAblation()?.fxaa === false && authored === 'fxaa' ? 'none' : authored;
}

/** Diagnostic ablation: `bloom: false` turns camera bloom off. */
function ablatedBloom<T>(authored: () => T): T | 'off' {
  return renderAblation()?.bloom === false ? 'off' : authored();
}

function buildCameraSnapshots(world: World): CameraSnapshot[] {
  const cameras: CameraSnapshot[] = [];
  const cameraQuery = collectCameraSnapshotsQuery(world).unwrap();
  for (const batch of cameraQuery.batches().unwrap()) {
    const entities = batch.entities;
    const effectColumns: CameraEffectColumns = {};
    const cameraProjectionColumn = batch.read(Camera, 'projection');
    const cameraFovColumn = batch.read(Camera, 'fov');
    const cameraNearColumn = batch.read(Camera, 'near');
    const cameraFarColumn = batch.read(Camera, 'far');
    const cameraExposureModeColumn = batch.read(Camera, 'exposureMode');
    const cameraExposureColumn = batch.read(Camera, 'exposure');
    const cameraTemperatureColumn = batch.read(Camera, 'temperature');
    const cameraTintColumn = batch.read(Camera, 'tint');
    const cameraColorLutStrengthColumn = batch.read(Camera, 'colorLutStrength');
    const cameraAntialiasColumn = batch.read(Camera, 'antialias');
    const cameraTaaFlickeringColumn = batch.read(Camera, 'taaFlickering');
    const cameraTargetLayerColumn = batch.read(Camera, 'targetLayer');
    const cameraHistoryVersionColumn = batch.read(Camera, 'historyVersion');
    const cameraAspectColumn = batch.read(Camera, 'aspect');
    const cameraAutoAspectColumn = batch.read(Camera, 'autoAspect');
    const cameraLeftColumn = batch.read(Camera, 'left');
    const cameraRightColumn = batch.read(Camera, 'right');
    const cameraBottomColumn = batch.read(Camera, 'bottom');
    const cameraTopColumn = batch.read(Camera, 'top');
    const cameraTonemapColumn = batch.read(Camera, 'tonemap');
    const cameraWhitePointColumn = batch.read(Camera, 'whitePoint');
    const cameraTransparencyColumn = batch.read(Camera, 'transparency');
    const cameraBloomColumn = batch.read(Camera, 'bloom');
    const cameraBloomThresholdColumn = batch.read(Camera, 'bloomThreshold');
    const cameraBloomIntensityColumn = batch.read(Camera, 'bloomIntensity');
    const cameraBloomSmoothWidthColumn = batch.read(Camera, 'bloomSmoothWidth');
    const cameraBloomRadiusColumn = batch.read(Camera, 'bloomRadius');
    const cameraCompensationEvColumn = batch.read(Camera, 'compensationEv');

    const selection = batch.kind === 'indexed' ? batch.rows : undefined;
    const first = batch.kind === 'range' ? batch.start : 0;

    for (let ordinal = 0; ordinal < batch.count; ordinal++) {
      const physicalRow =
        selection === undefined ? first + ordinal : (selection[ordinal] as number);
      const entity = entities[physicalRow] as EntityHandle;
      const effectInputs = readCameraEffectInputs(world, batch, effectColumns, entity, physicalRow);
      const camTarget = world[worldRead].getFieldValue(entity, Camera, 'target') as ShapeOf<
        SchemaOf<typeof Camera>
      >['target'];
      const camColorLut = world[worldRead].getFieldValue(entity, Camera, 'colorLut') as ShapeOf<
        SchemaOf<typeof Camera>
      >['colorLut'];
      const camProjectionOffset = readRenderArrayView(
        world,
        entity,
        Camera,
        'projectionOffset',
      ) as Float32Array;

      const cameraView = effectInputs.CameraView;
      const clipping = extractClippingPlanes(effectInputs.ClippingPlanes);
      const planar = effectInputs.PlanarReflection;
      if (planar !== undefined) validatePlanarReflection(planar, camTarget, cameraView);
      const barrelDistortion = effectInputs.BarrelDistortion;
      const { lensEffects, lensFlare, outline, motionBlurParams } =
        resolveCameraLensInputs(effectInputs);
      const depthOfField = effectInputs.DepthOfField;
      const dynamicResolution = effectInputs.DynamicResolution;
      const screenSpaceReflection = effectInputs.ScreenSpaceReflection;
      const ambientOcclusion = effectInputs.AmbientOcclusion;
      const projection = cameraProjectionFromF32(cameraProjectionColumn[physicalRow] as number);
      const depthOfFieldResult =
        depthOfField === undefined
          ? NO_CAMERA_EFFECT
          : resolveDepthOfFieldParams(depthOfField, {
              projection,
              fov: cameraFovColumn[physicalRow] as number,
              near: cameraNearColumn[physicalRow] as number,
              far: cameraFarColumn[physicalRow] as number,
            });
      const depthOfFieldError = depthOfFieldResult.ok
        ? undefined
        : depthOfFieldRequestFailure(depthOfFieldResult.error);
      const view = readEnvironmentPose(world, entity);
      if (view === undefined) continue;
      const worldMat = new Float32Array(view);
      const target = resolveCameraTarget(world, camTarget);
      const hasNonDefaultOutput =
        (cameraExposureModeColumn[physicalRow] as number) !== CAMERA_EXPOSURE_MODE_MANUAL ||
        (cameraExposureColumn[physicalRow] as number) !== 1 ||
        (cameraTemperatureColumn[physicalRow] as number) !== 6504 ||
        (cameraTintColumn[physicalRow] as number) !== 0 ||
        camColorLut !== 0 ||
        (cameraColorLutStrengthColumn[physicalRow] as number) !==
          Camera.fields.colorLutStrength.default;
      const output = hasNonDefaultOutput
        ? {
            exposure: cameraExposureFromColumns({
              exposureMode: cameraExposureModeColumn[physicalRow] as number,
              exposure: cameraExposureColumn[physicalRow] as number,
              compensationEv: cameraCompensationEvColumn[physicalRow] as number,
              rangeEv: readRenderArrayView(world, entity, Camera, 'rangeEv') as Float32Array,
              rates: readRenderArrayView(world, entity, Camera, 'rates') as Float32Array,
            }),
            temperature: cameraTemperatureColumn[physicalRow] as number,
            tint: cameraTintColumn[physicalRow] as number,
            colorLut: camColorLut,
            colorLutStrength: cameraColorLutStrengthColumn[physicalRow] as number,
          }
        : undefined;
      const antialias = ablatedAntialias(
        antialiasFromF32(cameraAntialiasColumn[physicalRow] as number),
      );
      const dynamicResolutionResult =
        dynamicResolution === undefined
          ? NO_CAMERA_EFFECT
          : validateDynamicResolutionCamera(dynamicResolution, antialias);
      if (!dynamicResolutionResult.ok) throw dynamicResolutionResult.error;
      const barrelDistortionResult =
        barrelDistortion === undefined
          ? NO_CAMERA_EFFECT
          : validateBarrelDistortionParameters(barrelDistortion);
      if (!barrelDistortionResult.ok) throw barrelDistortionResult.error;
      const stereoData = effectInputs.StereoCamera;
      const stereo =
        stereoData === undefined
          ? undefined
          : resolveStereoCamera(stereoData, {
              projection,
              near: cameraNearColumn[physicalRow] as number,
              target: target !== undefined,
              planarReflection: planar !== undefined,
            });
      // A stereo camera always composes as a view; without CameraView it covers the screen.
      const composedView = cameraView ?? (stereo === undefined ? undefined : CAMERA_VIEW_DEFAULTS);
      const snapshot: CameraSnapshot = {
        entityKey: entity as number,
        ...(composedView === undefined
          ? {}
          : {
              view: {
                viewport: new Float32Array(composedView.viewport),
                order: composedView.order,
                resolutionScale: composedView.resolutionScale,
                maxRenderShortSide: composedView.maxRenderShortSide,
                updateInterval: composedView.updateInterval,
                enabled: composedView.enabled,
              },
            }),
        ...(stereo === undefined ? {} : { stereo }),
        ...(target === undefined ? {} : { target }),
        ...(target === undefined || (cameraTargetLayerColumn[physicalRow] as number) === 0
          ? {}
          : { targetLayer: cameraTargetLayerColumn[physicalRow] as number }),
        historyVersion: cameraHistoryVersionColumn[physicalRow] as number,
        position: mat4.getTranslation(vec3.create(), worldMat),
        world: worldMat,
        fov: cameraFovColumn[physicalRow] as number,
        aspect: cameraAspectColumn[physicalRow] as number,
        autoAspect: cameraAutoAspectColumn[physicalRow] === 1,
        projectionOffset: validateCameraProjectionOffset(camProjectionOffset),
        near: cameraNearColumn[physicalRow] as number,
        far: cameraFarColumn[physicalRow] as number,
        projection,
        orthoLeft: cameraLeftColumn[physicalRow] as number,
        orthoRight: cameraRightColumn[physicalRow] as number,
        orthoBottom: cameraBottomColumn[physicalRow] as number,
        orthoTop: cameraTopColumn[physicalRow] as number,
        tonemap: tonemapFromF32(cameraTonemapColumn[physicalRow] as number),
        exposure: cameraExposureColumn[physicalRow] as number,
        whitePoint: cameraWhitePointColumn[physicalRow] as number,
        ...(output === undefined ? {} : { output }),
        antialias,
        ...taaFlickeringField(cameraTaaFlickeringColumn[physicalRow] as number),
        transparency: transparencyFromF32(cameraTransparencyColumn[physicalRow] as number),
        ...(dynamicResolutionResult.value === undefined
          ? {}
          : { dynamicResolution: dynamicResolutionResult.value }),
        bloom: ablatedBloom(() =>
          validateCameraBloom(
            cameraBloomColumn[physicalRow] as number,
            cameraBloomThresholdColumn[physicalRow] as number,
            cameraBloomIntensityColumn[physicalRow] as number,
            cameraBloomSmoothWidthColumn[physicalRow] as number,
            cameraBloomRadiusColumn[physicalRow] as number,
          ),
        ),
        bloomThreshold: cameraBloomThresholdColumn[physicalRow] as number,
        bloomIntensity: cameraBloomIntensityColumn[physicalRow] as number,
        bloomSmoothWidth: cameraBloomSmoothWidthColumn[physicalRow] as number,
        bloomRadius: cameraBloomRadiusColumn[physicalRow] as number,
        clearColor: [
          world[worldRead].getArrayElement(entity, Camera, 'clearColor', 0) as number,
          world[worldRead].getArrayElement(entity, Camera, 'clearColor', 1) as number,
          world[worldRead].getArrayElement(entity, Camera, 'clearColor', 2) as number,
          world[worldRead].getArrayElement(entity, Camera, 'clearColor', 3) as number,
        ],
        ...(depthOfFieldResult.ok && depthOfFieldResult.value !== undefined
          ? { depthOfField: depthOfFieldResult.value }
          : {}),
        ...(depthOfFieldError === undefined ? {} : { depthOfFieldError }),
        ...(motionBlurParams === undefined
          ? {}
          : {
              motionBlur: motionBlurParams,
            }),
        ...(clipping === undefined ? {} : { clipping }),
        ...(outline === undefined ? {} : { outline: outline }),
        ...(lensEffects === undefined ? {} : { lensEffects: lensEffects }),
        ...(lensFlare === undefined ? {} : { lensFlare: lensFlare }),
        ...(barrelDistortionResult.value === undefined
          ? {}
          : { barrelDistortion: barrelDistortionResult.value }),
        ...(ambientOcclusion === undefined
          ? {}
          : {
              ambientOcclusion: ambientOcclusion,
            }),
        ...(screenSpaceReflection === undefined
          ? {}
          : {
              screenSpaceReflection: screenSpaceReflection,
            }),
      };
      cameras.push(snapshot);
      if (planar !== undefined) cameras.push(planarCaptureSnapshot(world, snapshot, planar));
    }
  }
  const planarTargets = new Set<RenderTarget>();
  const otherTargets = new Set(
    cameras
      .filter((camera) => camera.planarReflection === undefined)
      .map((camera) => camera.target),
  );
  for (const camera of collectCubeCameraSnapshots(world)) otherTargets.add(camera.target);
  for (const camera of cameras) {
    if (camera.planarReflection === undefined || camera.target === undefined) continue;
    if (planarTargets.has(camera.target) || otherTargets.has(camera.target))
      throw new PlanarReflectionInvalidError('target-writer');
    planarTargets.add(camera.target);
  }
  return cameras;
}

type CameraQuery = ReturnType<ReturnType<typeof collectCameraSnapshotsQuery>['unwrap']>;
type CameraBatch =
  ReturnType<ReturnType<CameraQuery['batches']>['unwrap']> extends Iterable<infer B> ? B : never;

interface CameraEffectInputs {
  CameraView?: ShapeOf<SchemaOf<typeof CameraView>>;
  ClippingPlanes?: ShapeOf<SchemaOf<typeof ClippingPlanes>>;
  PlanarReflection?: ShapeOf<SchemaOf<typeof PlanarReflection>>;
  MotionBlur?: ShapeOf<SchemaOf<typeof MotionBlur>>;
  BarrelDistortion?: ShapeOf<SchemaOf<typeof BarrelDistortion>>;
  LensEffects?: ShapeOf<SchemaOf<typeof LensEffects>>;
  LensFlare?: ShapeOf<SchemaOf<typeof LensFlare>>;
  Outline?: ShapeOf<SchemaOf<typeof Outline>>;
  DepthOfField?: ShapeOf<SchemaOf<typeof DepthOfField>>;
  DynamicResolution?: ShapeOf<SchemaOf<typeof DynamicResolution>>;
  ScreenSpaceReflection?: ShapeOf<SchemaOf<typeof ScreenSpaceReflection>>;
  AmbientOcclusion?: ShapeOf<SchemaOf<typeof AmbientOcclusion>>;
  StereoCamera?: ShapeOf<SchemaOf<typeof StereoCamera>>;
}

/** Borrowed columns stay inside one live batch; no cached view escapes a snapshot. */
type CameraEffectColumns = {
  [C in keyof CameraEffectInputs]?: Partial<
    Record<keyof NonNullable<CameraEffectInputs[C]>, ArrayLike<number> | undefined>
  >;
};

function readCameraEffectInputs(
  world: World,
  batch: CameraBatch,
  columns: CameraEffectColumns,
  entity: EntityHandle,
  physicalRow: number,
): CameraEffectInputs {
  const inputs: CameraEffectInputs = {};
  fillCameraCaptureInputs(world, batch, columns, entity, physicalRow, inputs);
  fillCameraMotionInputs(world, batch, columns, entity, physicalRow, inputs);
  fillCameraLensInputs(world, batch, columns, entity, physicalRow, inputs);
  fillCameraOutputInputs(world, batch, columns, entity, physicalRow, inputs);
  fillCameraLightingInputs(world, batch, columns, entity, physicalRow, inputs);
  fillCameraCompositionInputs(world, batch, columns, entity, physicalRow, inputs);
  return inputs;
}

function fillCameraCaptureInputs(
  world: World,
  batch: CameraBatch,
  columns: CameraEffectColumns,
  entity: EntityHandle,
  physicalRow: number,
  inputs: CameraEffectInputs,
): void {
  if (world.hasComponent(entity, CameraView)) {
    columns.CameraView ??= {
      order: batch.read(CameraView, 'order'),
      resolutionScale: batch.read(CameraView, 'resolutionScale'),
      maxRenderShortSide: batch.read(CameraView, 'maxRenderShortSide'),
      updateInterval: batch.read(CameraView, 'updateInterval'),
      enabled: batch.read(CameraView, 'enabled'),
    };
    const numeric = columns.CameraView;
    inputs.CameraView = {
      viewport: readRenderArrayView(world, entity, CameraView, 'viewport') as Float32Array,
      order: numeric.order?.[physicalRow] as number,
      resolutionScale: numeric.resolutionScale?.[physicalRow] as number,
      maxRenderShortSide: numeric.maxRenderShortSide?.[physicalRow] as number,
      updateInterval: numeric.updateInterval?.[physicalRow] as number,
      enabled: numeric.enabled?.[physicalRow] === 1,
    };
  }
  if (world.hasComponent(entity, ClippingPlanes)) {
    columns.ClippingPlanes ??= {
      count: batch.read(ClippingPlanes, 'count'),
      intersection: batch.read(ClippingPlanes, 'intersection'),
      clipShadows: batch.read(ClippingPlanes, 'clipShadows'),
      caps: batch.read(ClippingPlanes, 'caps'),
    };
    const numeric = columns.ClippingPlanes;
    inputs.ClippingPlanes = {
      planes: readRenderArrayView(world, entity, ClippingPlanes, 'planes') as Float32Array,
      count: numeric.count?.[physicalRow] as number,
      intersection: numeric.intersection?.[physicalRow] === 1,
      clipShadows: numeric.clipShadows?.[physicalRow] === 1,
      caps: numeric.caps?.[physicalRow] === 1,
    };
  }
  if (world.hasComponent(entity, PlanarReflection)) {
    columns.PlanarReflection ??= {
      distance: batch.read(PlanarReflection, 'distance'),
      clipBias: batch.read(PlanarReflection, 'clipBias'),
      distortion: batch.read(PlanarReflection, 'distortion'),
      resolutionScale: batch.read(PlanarReflection, 'resolutionScale'),
      generateMipmaps: batch.read(PlanarReflection, 'generateMipmaps'),
      updateIntervalFrames: batch.read(PlanarReflection, 'updateIntervalFrames'),
      requestVersion: batch.read(PlanarReflection, 'requestVersion'),
    };
    const numeric = columns.PlanarReflection;
    inputs.PlanarReflection = {
      target: world[worldRead].getFieldValue(entity, PlanarReflection, 'target') as ShapeOf<
        SchemaOf<typeof PlanarReflection>
      >['target'],
      normal: readRenderArrayView(world, entity, PlanarReflection, 'normal') as Float32Array,
      distance: numeric.distance?.[physicalRow] as number,
      clipBias: numeric.clipBias?.[physicalRow] as number,
      distortion: (numeric.distortion?.[physicalRow] as number | undefined) ?? 0,
      resolutionScale: (numeric.resolutionScale?.[physicalRow] as number | undefined) ?? 1,
      generateMipmaps: numeric.generateMipmaps?.[physicalRow] === 1,
      updateIntervalFrames: numeric.updateIntervalFrames?.[physicalRow] as number,
      requestVersion: numeric.requestVersion?.[physicalRow] as number,
    };
  }
}

function fillCameraMotionInputs(
  world: World,
  batch: CameraBatch,
  columns: CameraEffectColumns,
  entity: EntityHandle,
  physicalRow: number,
  inputs: CameraEffectInputs,
): void {
  if (world.hasComponent(entity, MotionBlur)) {
    columns.MotionBlur ??= {
      shutterAngle: batch.read(MotionBlur, 'shutterAngle'),
      maxRadiusPixels: batch.read(MotionBlur, 'maxRadiusPixels'),
      sampleCount: batch.read(MotionBlur, 'sampleCount'),
      targetFps: batch.read(MotionBlur, 'targetFps'),
    };
    const numeric = columns.MotionBlur;
    inputs.MotionBlur = {
      shutterAngle: numeric.shutterAngle?.[physicalRow] as number,
      maxRadiusPixels: numeric.maxRadiusPixels?.[physicalRow] as number,
      sampleCount: numeric.sampleCount?.[physicalRow] as number,
      targetFps: numeric.targetFps?.[physicalRow] as number,
    };
  }
  if (world.hasComponent(entity, BarrelDistortion)) {
    columns.BarrelDistortion ??= {
      strength: batch.read(BarrelDistortion, 'strength'),
      centerX: batch.read(BarrelDistortion, 'centerX'),
      centerY: batch.read(BarrelDistortion, 'centerY'),
    };
    const numeric = columns.BarrelDistortion;
    inputs.BarrelDistortion = {
      strength: numeric.strength?.[physicalRow] as number,
      centerX: numeric.centerX?.[physicalRow] as number,
      centerY: numeric.centerY?.[physicalRow] as number,
    };
  }
}

function fillCameraLensInputs(
  world: World,
  batch: CameraBatch,
  columns: CameraEffectColumns,
  entity: EntityHandle,
  physicalRow: number,
  inputs: CameraEffectInputs,
): void {
  if (world.hasComponent(entity, LensEffects)) {
    columns.LensEffects ??= {
      vignetteIntensity: batch.read(LensEffects, 'vignetteIntensity'),
      vignetteRadius: batch.read(LensEffects, 'vignetteRadius'),
      vignetteSoftness: batch.read(LensEffects, 'vignetteSoftness'),
      chromaticAberration: batch.read(LensEffects, 'chromaticAberration'),
      chromaticAberrationStartOffset: batch.read(LensEffects, 'chromaticAberrationStartOffset'),
      grainIntensity: batch.read(LensEffects, 'grainIntensity'),
      grainSize: batch.read(LensEffects, 'grainSize'),
    };
    const numeric = columns.LensEffects;
    inputs.LensEffects = {
      vignetteIntensity: numeric.vignetteIntensity?.[physicalRow] as number,
      vignetteRadius: numeric.vignetteRadius?.[physicalRow] as number,
      vignetteSoftness: numeric.vignetteSoftness?.[physicalRow] as number,
      vignetteColor: readRenderArrayView(
        world,
        entity,
        LensEffects,
        'vignetteColor',
      ) as Float32Array,
      chromaticAberration: numeric.chromaticAberration?.[physicalRow] as number,
      chromaticAberrationStartOffset: numeric.chromaticAberrationStartOffset?.[
        physicalRow
      ] as number,
      grainIntensity: numeric.grainIntensity?.[physicalRow] as number,
      grainSize: numeric.grainSize?.[physicalRow] as number,
    };
  }
  if (world.hasComponent(entity, LensFlare)) {
    columns.LensFlare ??= {
      intensity: batch.read(LensFlare, 'intensity'),
      threshold: batch.read(LensFlare, 'threshold'),
      bokehSize: batch.read(LensFlare, 'bokehSize'),
    };
    const numeric = columns.LensFlare;
    inputs.LensFlare = {
      intensity: numeric.intensity?.[physicalRow] as number,
      threshold: numeric.threshold?.[physicalRow] as number,
      bokehSize: numeric.bokehSize?.[physicalRow] as number,
      tint: readRenderArrayView(world, entity, LensFlare, 'tint') as Float32Array,
      ghostTints: readRenderArrayView(world, entity, LensFlare, 'ghostTints') as Float32Array,
      ghostScales: readRenderArrayView(world, entity, LensFlare, 'ghostScales') as Float32Array,
    };
  }
}

function fillCameraOutputInputs(
  world: World,
  batch: CameraBatch,
  columns: CameraEffectColumns,
  entity: EntityHandle,
  physicalRow: number,
  inputs: CameraEffectInputs,
): void {
  if (world.hasComponent(entity, Outline)) {
    columns.Outline ??= {
      width: batch.read(Outline, 'width'),
      occlusion: batch.read(Outline, 'occlusion'),
    };
    const numeric = columns.Outline;
    inputs.Outline = {
      entities: readRenderArrayView(world, entity, Outline, 'entities') as Uint32Array,
      visibleColor: readRenderArrayView(world, entity, Outline, 'visibleColor') as Float32Array,
      hiddenColor: readRenderArrayView(world, entity, Outline, 'hiddenColor') as Float32Array,
      width: numeric.width?.[physicalRow] as number,
      occlusion: numeric.occlusion?.[physicalRow] as number,
    };
  }
  if (world.hasComponent(entity, DepthOfField)) {
    columns.DepthOfField ??= {
      focusDistance: batch.read(DepthOfField, 'focusDistance'),
      fStop: batch.read(DepthOfField, 'fStop'),
      sensorHeight: batch.read(DepthOfField, 'sensorHeight'),
      maxRadiusPixels: batch.read(DepthOfField, 'maxRadiusPixels'),
      quality: batch.read(DepthOfField, 'quality'),
      blurSide: batch.read(DepthOfField, 'blurSide'),
    };
    const numeric = columns.DepthOfField;
    inputs.DepthOfField = {
      focusDistance: numeric.focusDistance?.[physicalRow] as number,
      fStop: numeric.fStop?.[physicalRow] as number,
      sensorHeight: numeric.sensorHeight?.[physicalRow] as number,
      maxRadiusPixels: numeric.maxRadiusPixels?.[physicalRow] as number,
      quality: numeric.quality?.[physicalRow] as number,
      blurSide: numeric.blurSide?.[physicalRow] as number,
    };
  }
  if (world.hasComponent(entity, DynamicResolution)) {
    columns.DynamicResolution ??= {
      targetGpuMs: batch.read(DynamicResolution, 'targetGpuMs'),
      minScale: batch.read(DynamicResolution, 'minScale'),
      maxScale: batch.read(DynamicResolution, 'maxScale'),
    };
    const numeric = columns.DynamicResolution;
    inputs.DynamicResolution = {
      targetGpuMs: numeric.targetGpuMs?.[physicalRow] as number,
      minScale: numeric.minScale?.[physicalRow] as number,
      maxScale: numeric.maxScale?.[physicalRow] as number,
    };
  }
}

function fillCameraLightingInputs(
  world: World,
  batch: CameraBatch,
  columns: CameraEffectColumns,
  entity: EntityHandle,
  physicalRow: number,
  inputs: CameraEffectInputs,
): void {
  if (world.hasComponent(entity, ScreenSpaceReflection)) {
    columns.ScreenSpaceReflection ??= {
      maxDistance: batch.read(ScreenSpaceReflection, 'maxDistance'),
      thickness: batch.read(ScreenSpaceReflection, 'thickness'),
      maxRoughness: batch.read(ScreenSpaceReflection, 'maxRoughness'),
    };
    const numeric = columns.ScreenSpaceReflection;
    inputs.ScreenSpaceReflection = {
      maxDistance: numeric.maxDistance?.[physicalRow] as number,
      thickness: numeric.thickness?.[physicalRow] as number,
      maxRoughness: numeric.maxRoughness?.[physicalRow] as number,
    };
  }
  if (world.hasComponent(entity, AmbientOcclusion)) {
    columns.AmbientOcclusion ??= {
      algorithm: batch.read(AmbientOcclusion, 'algorithm'),
      radius: batch.read(AmbientOcclusion, 'radius'),
      bias: batch.read(AmbientOcclusion, 'bias'),
      intensity: batch.read(AmbientOcclusion, 'intensity'),
      thickness: batch.read(AmbientOcclusion, 'thickness'),
      distanceExponent: batch.read(AmbientOcclusion, 'distanceExponent'),
      distanceFallOff: batch.read(AmbientOcclusion, 'distanceFallOff'),
      resolutionScale: batch.read(AmbientOcclusion, 'resolutionScale'),
      directLightingStrength: batch.read(AmbientOcclusion, 'directLightingStrength'),
      quality: batch.read(AmbientOcclusion, 'quality'),
    };
    const numeric = columns.AmbientOcclusion;
    inputs.AmbientOcclusion = {
      algorithm: numeric.algorithm?.[physicalRow] as number,
      radius: numeric.radius?.[physicalRow] as number,
      bias: numeric.bias?.[physicalRow] as number,
      intensity: numeric.intensity?.[physicalRow] as number,
      thickness: numeric.thickness?.[physicalRow] as number,
      distanceExponent: numeric.distanceExponent?.[physicalRow] as number,
      distanceFallOff: numeric.distanceFallOff?.[physicalRow] as number,
      resolutionScale: numeric.resolutionScale?.[physicalRow] as number,
      directLightingStrength: numeric.directLightingStrength?.[physicalRow] as number,
      quality: numeric.quality?.[physicalRow] as number,
    };
  }
}

function fillCameraCompositionInputs(
  world: World,
  batch: CameraBatch,
  columns: CameraEffectColumns,
  entity: EntityHandle,
  physicalRow: number,
  inputs: CameraEffectInputs,
): void {
  if (world.hasComponent(entity, StereoCamera)) {
    columns.StereoCamera ??= {
      eyeSeparation: batch.read(StereoCamera, 'eyeSeparation'),
      convergence: batch.read(StereoCamera, 'convergence'),
      layout: batch.read(StereoCamera, 'layout'),
      swapEyes: batch.read(StereoCamera, 'swapEyes'),
    };
    const numeric = columns.StereoCamera;
    inputs.StereoCamera = {
      eyeSeparation: numeric.eyeSeparation?.[physicalRow] as number,
      convergence: numeric.convergence?.[physicalRow] as number,
      layout: numeric.layout?.[physicalRow] as number,
      swapEyes: numeric.swapEyes?.[physicalRow] === 1,
    };
  }
}

// No capability escapes this collector through an absent effect.
const NO_CAMERA_EFFECT = ok(undefined);

function resolveCameraLensInputs(inputs: CameraEffectInputs) {
  const lensEffects =
    inputs.LensEffects === undefined ? undefined : resolveLensEffects(inputs.LensEffects).unwrap();
  const lensFlare =
    inputs.LensFlare === undefined ? undefined : resolveLensFlare(inputs.LensFlare).unwrap();
  const outline =
    inputs.Outline === undefined ? undefined : resolveOutline(inputs.Outline).unwrap();
  const motionBlurParams =
    inputs.MotionBlur === undefined
      ? undefined
      : resolveMotionBlurParams(inputs.MotionBlur).unwrap();
  return { lensEffects, lensFlare, outline, motionBlurParams };
}
