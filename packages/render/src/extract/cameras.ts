import type { EntityHandle, SchemaOf, ShapeOf, World } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { mat4, vec3 } from '@forgeax/engine-math';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
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
import { readEnvironmentPose } from '../extract/environment-gate';
import {
  depthOfFieldRequestFailure,
  resolveDepthOfFieldParams,
} from '../features/depth-of-field/depth-of-field-params';
import { resolveMotionBlurParams } from '../features/motion-blur/motion-blur-params';
import type { CameraSnapshot } from '../render-contract';
import { collectCubeCameraSnapshots, resolveCameraTarget } from '../render-system-extract';
import type { RenderTarget } from '../targets/contracts';

export function collectCameraSnapshots(world: World): CameraSnapshot[] {
  const cameras: CameraSnapshot[] = [];
  const cameraQuery = world
    .query({
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
    })
    .unwrap();
  for (const batch of cameraQuery.batches().unwrap()) {
    const entities = batch.entities;
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
    const cameraViewOrderColumn = batch.read(CameraView, 'order');
    const cameraViewResolutionScaleColumn = batch.read(CameraView, 'resolutionScale');
    const cameraViewMaxRenderShortSideColumn = batch.read(CameraView, 'maxRenderShortSide');
    const cameraViewUpdateIntervalColumn = batch.read(CameraView, 'updateInterval');
    const cameraViewEnabledColumn = batch.read(CameraView, 'enabled');
    const clippingPlanesCountColumn = batch.read(ClippingPlanes, 'count');
    const clippingPlanesIntersectionColumn = batch.read(ClippingPlanes, 'intersection');
    const clippingPlanesClipShadowsColumn = batch.read(ClippingPlanes, 'clipShadows');
    const planarReflectionDistanceColumn = batch.read(PlanarReflection, 'distance');
    const planarReflectionClipBiasColumn = batch.read(PlanarReflection, 'clipBias');
    const planarReflectionUpdateIntervalFramesColumn = batch.read(
      PlanarReflection,
      'updateIntervalFrames',
    );
    const planarReflectionRequestVersionColumn = batch.read(PlanarReflection, 'requestVersion');
    const motionBlurShutterAngleColumn = batch.read(MotionBlur, 'shutterAngle');
    const motionBlurMaxRadiusPixelsColumn = batch.read(MotionBlur, 'maxRadiusPixels');
    const motionBlurSampleCountColumn = batch.read(MotionBlur, 'sampleCount');
    const motionBlurTargetFpsColumn = batch.read(MotionBlur, 'targetFps');
    const barrelDistortionStrengthColumn = batch.read(BarrelDistortion, 'strength');
    const barrelDistortionCenterXColumn = batch.read(BarrelDistortion, 'centerX');
    const barrelDistortionCenterYColumn = batch.read(BarrelDistortion, 'centerY');
    const lensEffectsVignetteIntensityColumn = batch.read(LensEffects, 'vignetteIntensity');
    const lensEffectsVignetteRadiusColumn = batch.read(LensEffects, 'vignetteRadius');
    const lensEffectsVignetteSoftnessColumn = batch.read(LensEffects, 'vignetteSoftness');
    const lensEffectsChromaticAberrationColumn = batch.read(LensEffects, 'chromaticAberration');
    const lensEffectsChromaticAberrationAngleColumn = batch.read(
      LensEffects,
      'chromaticAberrationAngle',
    );
    const lensEffectsGrainIntensityColumn = batch.read(LensEffects, 'grainIntensity');
    const lensEffectsGrainSizeColumn = batch.read(LensEffects, 'grainSize');
    const lensFlareIntensityColumn = batch.read(LensFlare, 'intensity');
    const lensFlareThresholdColumn = batch.read(LensFlare, 'threshold');
    const lensFlareBokehSizeColumn = batch.read(LensFlare, 'bokehSize');
    const outlineWidthColumn = batch.read(Outline, 'width');
    const outlineOcclusionColumn = batch.read(Outline, 'occlusion');
    const depthOfFieldFocusDistanceColumn = batch.read(DepthOfField, 'focusDistance');
    const depthOfFieldFStopColumn = batch.read(DepthOfField, 'fStop');
    const depthOfFieldSensorHeightColumn = batch.read(DepthOfField, 'sensorHeight');
    const depthOfFieldMaxRadiusPixelsColumn = batch.read(DepthOfField, 'maxRadiusPixels');
    const depthOfFieldQualityColumn = batch.read(DepthOfField, 'quality');
    const depthOfFieldBlurSideColumn = batch.read(DepthOfField, 'blurSide');
    const dynamicResolutionTargetGpuMsColumn = batch.read(DynamicResolution, 'targetGpuMs');
    const dynamicResolutionMinScaleColumn = batch.read(DynamicResolution, 'minScale');
    const dynamicResolutionMaxScaleColumn = batch.read(DynamicResolution, 'maxScale');
    const screenSpaceReflectionMaxDistanceColumn = batch.read(ScreenSpaceReflection, 'maxDistance');
    const screenSpaceReflectionThicknessColumn = batch.read(ScreenSpaceReflection, 'thickness');
    const screenSpaceReflectionMaxRoughnessColumn = batch.read(
      ScreenSpaceReflection,
      'maxRoughness',
    );
    const ambientOcclusionAlgorithmColumn = batch.read(AmbientOcclusion, 'algorithm');
    const ambientOcclusionRadiusColumn = batch.read(AmbientOcclusion, 'radius');
    const ambientOcclusionBiasColumn = batch.read(AmbientOcclusion, 'bias');
    const ambientOcclusionIntensityColumn = batch.read(AmbientOcclusion, 'intensity');
    const ambientOcclusionThicknessColumn = batch.read(AmbientOcclusion, 'thickness');
    const ambientOcclusionDistanceExponentColumn = batch.read(AmbientOcclusion, 'distanceExponent');
    const ambientOcclusionDistanceFallOffColumn = batch.read(AmbientOcclusion, 'distanceFallOff');
    const ambientOcclusionResolutionScaleColumn = batch.read(AmbientOcclusion, 'resolutionScale');
    const ambientOcclusionDirectLightingStrengthColumn = batch.read(
      AmbientOcclusion,
      'directLightingStrength',
    );
    const ambientOcclusionQualityColumn = batch.read(AmbientOcclusion, 'quality');
    const stereoCameraEyeSeparationColumn = batch.read(StereoCamera, 'eyeSeparation');
    const stereoCameraConvergenceColumn = batch.read(StereoCamera, 'convergence');
    const stereoCameraLayoutColumn = batch.read(StereoCamera, 'layout');
    const stereoCameraSwapEyesColumn = batch.read(StereoCamera, 'swapEyes');
    const selection = batch.kind === 'indexed' ? batch.rows : undefined;
    const first = batch.kind === 'range' ? batch.start : 0;
    const readEffectInputs = (entity: EntityHandle, physicalRow: number) => ({
      CameraView: world.hasComponent(entity, CameraView)
        ? {
            viewport: readRenderArrayView(world, entity, CameraView, 'viewport') as Float32Array,
            order: cameraViewOrderColumn?.[physicalRow] as number,
            resolutionScale: cameraViewResolutionScaleColumn?.[physicalRow] as number,
            maxRenderShortSide: cameraViewMaxRenderShortSideColumn?.[physicalRow] as number,
            updateInterval: cameraViewUpdateIntervalColumn?.[physicalRow] as number,
            enabled: cameraViewEnabledColumn?.[physicalRow] === 1,
          }
        : undefined,
      ClippingPlanes: world.hasComponent(entity, ClippingPlanes)
        ? {
            planes: readRenderArrayView(world, entity, ClippingPlanes, 'planes') as Float32Array,
            count: clippingPlanesCountColumn?.[physicalRow] as number,
            intersection: clippingPlanesIntersectionColumn?.[physicalRow] === 1,
            clipShadows: clippingPlanesClipShadowsColumn?.[physicalRow] === 1,
          }
        : undefined,
      PlanarReflection: world.hasComponent(entity, PlanarReflection)
        ? {
            target: world[worldRead].getFieldValue(entity, PlanarReflection, 'target') as ShapeOf<
              SchemaOf<typeof PlanarReflection>
            >['target'],
            normal: readRenderArrayView(world, entity, PlanarReflection, 'normal') as Float32Array,
            distance: planarReflectionDistanceColumn?.[physicalRow] as number,
            clipBias: planarReflectionClipBiasColumn?.[physicalRow] as number,
            updateIntervalFrames: planarReflectionUpdateIntervalFramesColumn?.[
              physicalRow
            ] as number,
            requestVersion: planarReflectionRequestVersionColumn?.[physicalRow] as number,
          }
        : undefined,
      MotionBlur: world.hasComponent(entity, MotionBlur)
        ? {
            shutterAngle: motionBlurShutterAngleColumn?.[physicalRow] as number,
            maxRadiusPixels: motionBlurMaxRadiusPixelsColumn?.[physicalRow] as number,
            sampleCount: motionBlurSampleCountColumn?.[physicalRow] as number,
            targetFps: motionBlurTargetFpsColumn?.[physicalRow] as number,
          }
        : undefined,
      BarrelDistortion: world.hasComponent(entity, BarrelDistortion)
        ? {
            strength: barrelDistortionStrengthColumn?.[physicalRow] as number,
            centerX: barrelDistortionCenterXColumn?.[physicalRow] as number,
            centerY: barrelDistortionCenterYColumn?.[physicalRow] as number,
          }
        : undefined,
      LensEffects: world.hasComponent(entity, LensEffects)
        ? {
            vignetteIntensity: lensEffectsVignetteIntensityColumn?.[physicalRow] as number,
            vignetteRadius: lensEffectsVignetteRadiusColumn?.[physicalRow] as number,
            vignetteSoftness: lensEffectsVignetteSoftnessColumn?.[physicalRow] as number,
            vignetteColor: readRenderArrayView(
              world,
              entity,
              LensEffects,
              'vignetteColor',
            ) as Float32Array,
            chromaticAberration: lensEffectsChromaticAberrationColumn?.[physicalRow] as number,
            chromaticAberrationAngle: lensEffectsChromaticAberrationAngleColumn?.[
              physicalRow
            ] as number,
            grainIntensity: lensEffectsGrainIntensityColumn?.[physicalRow] as number,
            grainSize: lensEffectsGrainSizeColumn?.[physicalRow] as number,
          }
        : undefined,
      LensFlare: world.hasComponent(entity, LensFlare)
        ? {
            intensity: lensFlareIntensityColumn?.[physicalRow] as number,
            threshold: lensFlareThresholdColumn?.[physicalRow] as number,
            bokehSize: lensFlareBokehSizeColumn?.[physicalRow] as number,
            tint: readRenderArrayView(world, entity, LensFlare, 'tint') as Float32Array,
            ghostTints: readRenderArrayView(world, entity, LensFlare, 'ghostTints') as Float32Array,
            ghostScales: readRenderArrayView(
              world,
              entity,
              LensFlare,
              'ghostScales',
            ) as Float32Array,
          }
        : undefined,
      Outline: world.hasComponent(entity, Outline)
        ? {
            entities: readRenderArrayView(world, entity, Outline, 'entities') as Uint32Array,
            visibleColor: readRenderArrayView(
              world,
              entity,
              Outline,
              'visibleColor',
            ) as Float32Array,
            hiddenColor: readRenderArrayView(world, entity, Outline, 'hiddenColor') as Float32Array,
            width: outlineWidthColumn?.[physicalRow] as number,
            occlusion: outlineOcclusionColumn?.[physicalRow] as number,
          }
        : undefined,
      DepthOfField: world.hasComponent(entity, DepthOfField)
        ? {
            focusDistance: depthOfFieldFocusDistanceColumn?.[physicalRow] as number,
            fStop: depthOfFieldFStopColumn?.[physicalRow] as number,
            sensorHeight: depthOfFieldSensorHeightColumn?.[physicalRow] as number,
            maxRadiusPixels: depthOfFieldMaxRadiusPixelsColumn?.[physicalRow] as number,
            quality: depthOfFieldQualityColumn?.[physicalRow] as number,
            blurSide: depthOfFieldBlurSideColumn?.[physicalRow] as number,
          }
        : undefined,
      DynamicResolution: world.hasComponent(entity, DynamicResolution)
        ? {
            targetGpuMs: dynamicResolutionTargetGpuMsColumn?.[physicalRow] as number,
            minScale: dynamicResolutionMinScaleColumn?.[physicalRow] as number,
            maxScale: dynamicResolutionMaxScaleColumn?.[physicalRow] as number,
          }
        : undefined,
      ScreenSpaceReflection: world.hasComponent(entity, ScreenSpaceReflection)
        ? {
            maxDistance: screenSpaceReflectionMaxDistanceColumn?.[physicalRow] as number,
            thickness: screenSpaceReflectionThicknessColumn?.[physicalRow] as number,
            maxRoughness: screenSpaceReflectionMaxRoughnessColumn?.[physicalRow] as number,
          }
        : undefined,
      AmbientOcclusion: world.hasComponent(entity, AmbientOcclusion)
        ? {
            algorithm: ambientOcclusionAlgorithmColumn?.[physicalRow] as number,
            radius: ambientOcclusionRadiusColumn?.[physicalRow] as number,
            bias: ambientOcclusionBiasColumn?.[physicalRow] as number,
            intensity: ambientOcclusionIntensityColumn?.[physicalRow] as number,
            thickness: ambientOcclusionThicknessColumn?.[physicalRow] as number,
            distanceExponent: ambientOcclusionDistanceExponentColumn?.[physicalRow] as number,
            distanceFallOff: ambientOcclusionDistanceFallOffColumn?.[physicalRow] as number,
            resolutionScale: ambientOcclusionResolutionScaleColumn?.[physicalRow] as number,
            directLightingStrength: ambientOcclusionDirectLightingStrengthColumn?.[
              physicalRow
            ] as number,
            quality: ambientOcclusionQualityColumn?.[physicalRow] as number,
          }
        : undefined,
      StereoCamera: world.hasComponent(entity, StereoCamera)
        ? {
            eyeSeparation: stereoCameraEyeSeparationColumn?.[physicalRow] as number,
            convergence: stereoCameraConvergenceColumn?.[physicalRow] as number,
            layout: stereoCameraLayoutColumn?.[physicalRow] as number,
            swapEyes: stereoCameraSwapEyesColumn?.[physicalRow] === 1,
          }
        : undefined,
    });
    for (let ordinal = 0; ordinal < batch.count; ordinal++) {
      const physicalRow =
        selection === undefined ? first + ordinal : (selection[ordinal] as number);
      const entity = entities[physicalRow] as EntityHandle;
      const effectInputs = readEffectInputs(entity, physicalRow);
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
      const camRangeEv = readRenderArrayView(world, entity, Camera, 'rangeEv') as Float32Array;
      const camRates = readRenderArrayView(world, entity, Camera, 'rates') as Float32Array;

      const cameraView = effectInputs.CameraView;
      const clipping = extractClippingPlanes(effectInputs.ClippingPlanes);
      const planar = effectInputs.PlanarReflection;
      if (planar !== undefined && camTarget !== 0 && cameraView === undefined)
        throw new PlanarReflectionInvalidError('camera');
      if (planar !== undefined && (planar.target === 0 || planar.updateIntervalFrames < 1))
        throw new PlanarReflectionInvalidError(
          planar.target === 0 ? 'target' : 'updateIntervalFrames',
        );
      const motionBlur = effectInputs.MotionBlur;
      const barrelDistortion = effectInputs.BarrelDistortion;
      const lensEffects = resolveLensEffects(effectInputs.LensEffects);
      if (!lensEffects.ok) throw lensEffects.error;
      const lensFlare = resolveLensFlare(effectInputs.LensFlare);
      if (!lensFlare.ok) throw lensFlare.error;
      const outline = resolveOutline(effectInputs.Outline);
      if (!outline.ok) throw outline.error;
      const motionBlurResult = resolveMotionBlurParams(motionBlur);
      if (!motionBlurResult.ok) throw motionBlurResult.error;
      const motionBlurParams = motionBlurResult.value;
      const depthOfField = effectInputs.DepthOfField;
      const dynamicResolution = effectInputs.DynamicResolution;
      const screenSpaceReflection = effectInputs.ScreenSpaceReflection;
      const ambientOcclusion = effectInputs.AmbientOcclusion;
      const projection = cameraProjectionFromF32(cameraProjectionColumn[physicalRow] as number);
      const depthOfFieldResult = resolveDepthOfFieldParams(depthOfField, {
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
              rangeEv: camRangeEv,
              rates: camRates,
            }),
            temperature: cameraTemperatureColumn[physicalRow] as number,
            tint: cameraTintColumn[physicalRow] as number,
            colorLut: camColorLut,
            colorLutStrength: cameraColorLutStrengthColumn[physicalRow] as number,
          }
        : undefined;
      const antialias = antialiasFromF32(cameraAntialiasColumn[physicalRow] as number);
      const dynamicResolutionResult = validateDynamicResolutionCamera(dynamicResolution, antialias);
      if (!dynamicResolutionResult.ok) throw dynamicResolutionResult.error;
      const barrelDistortionResult = validateBarrelDistortionParameters(barrelDistortion);
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
        transparency: transparencyFromF32(cameraTransparencyColumn[physicalRow] as number),
        ...(dynamicResolutionResult.value === undefined
          ? {}
          : { dynamicResolution: dynamicResolutionResult.value }),
        bloom: validateCameraBloom(
          cameraBloomColumn[physicalRow] as number,
          cameraBloomThresholdColumn[physicalRow] as number,
          cameraBloomIntensityColumn[physicalRow] as number,
          cameraBloomSmoothWidthColumn[physicalRow] as number,
          cameraBloomRadiusColumn[physicalRow] as number,
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
        ...(outline.value === undefined ? {} : { outline: outline.value }),
        ...(lensEffects.value === undefined ? {} : { lensEffects: lensEffects.value }),
        ...(lensFlare.value === undefined ? {} : { lensFlare: lensFlare.value }),
        ...(barrelDistortion === undefined
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
      if (planar !== undefined) {
        const reflectionTarget = resolveCameraTarget(world, planar.target);
        if (reflectionTarget === undefined) throw new PlanarReflectionInvalidError('target');
        const { view: _view, ...capture } = snapshot;
        const { target: _target, ...reflection } = planar;
        cameras.push({
          ...capture,
          target: reflectionTarget,
          planarReflection: { ...reflection, normal: new Float32Array(planar.normal) },
        });
      }
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
