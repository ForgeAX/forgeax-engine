import type { RhiCaps } from '@forgeax/engine-rhi';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/contracts';
import { createMode0CloudFeature } from '../cloud/reconstruction/feature';
import {
  createWaterAdvancedFeature,
  WATER_ADVANCED_FEATURE_IDENTITY,
} from '../water/advanced-feature';
import { createWaterFluidFeature, WATER_FLUID_FEATURE_IDENTITY } from '../water/fluid-feature';
import { createWaterGpuMeshFeature } from '../water/gpu-mesh-feature';
import { WATER_GPU_MESH_FEATURE } from '../water/gpu-mesh-source';
import {
  createWaterUnderwaterFeature,
  WATER_UNDERWATER_FEATURE_IDENTITY,
} from '../water/underwater-feature';
import { createWaterInfoFeature, WATER_INFO_FEATURE_IDENTITY } from '../water/water-info-feature';
import {
  BARREL_DISTORTION_FEATURE_IDENTITY,
  createBarrelDistortionRenderFeature,
} from './barrel-distortion';
import {
  createEditorAssistanceFeature,
  EDITOR_ASSISTANCE_FEATURE_IDENTITY,
} from './editor-assistance/feature';
import { createMotionBlurFeature } from './motion-blur/motion-blur-feature';
import type { RenderFeature } from './types';

/** The same fixed source roster is constructed in both execution realms. */
export function withBuiltinRenderFeatures(
  requested: readonly RenderFeature<unknown>[],
  caps?: Readonly<RhiCaps>,
  recordCloudAdoption?: Parameters<typeof createMode0CloudFeature>[0],
): RenderFeature<unknown>[] {
  const features = [...requested];
  if (!features.some((feature) => feature.identity === CLOUD_LAYER_FEATURE_IDENTITY))
    features.push(createMode0CloudFeature(recordCloudAdoption) as RenderFeature<unknown>);
  let waterInfo = features.find((feature) => feature.identity === WATER_INFO_FEATURE_IDENTITY);
  if (waterInfo === undefined) {
    waterInfo = createWaterInfoFeature() as RenderFeature<unknown>;
    features.unshift(waterInfo);
  }
  if (!features.some((feature) => feature.identity === WATER_FLUID_FEATURE_IDENTITY))
    features.splice(
      features.indexOf(waterInfo) + 1,
      0,
      createWaterFluidFeature({}, waterInfo) as RenderFeature<unknown>,
    );
  if (!features.some((feature) => feature.identity === WATER_ADVANCED_FEATURE_IDENTITY))
    features.splice(
      features.indexOf(waterInfo) + 1,
      0,
      createWaterAdvancedFeature(waterInfo) as RenderFeature<unknown>,
    );
  if (!features.some((feature) => feature.identity === WATER_GPU_MESH_FEATURE))
    features.splice(
      features.indexOf(waterInfo) + 1,
      0,
      createWaterGpuMeshFeature(waterInfo) as RenderFeature<unknown>,
    );
  if (!features.some((feature) => feature.identity === WATER_UNDERWATER_FEATURE_IDENTITY))
    features.push(createWaterUnderwaterFeature() as RenderFeature<unknown>);
  if (!features.some((feature) => feature.identity === BARREL_DISTORTION_FEATURE_IDENTITY))
    features.push(createBarrelDistortionRenderFeature());
  if (
    (caps === undefined ||
      (caps.compute && caps.storageBuffer && caps.storageTexture && caps.rgba16floatRenderable)) &&
    !features.some((feature) => feature.identity === 'forgeax.motion-blur')
  )
    features.push(createMotionBlurFeature());
  if (!features.some((feature) => feature.identity === EDITOR_ASSISTANCE_FEATURE_IDENTITY))
    features.push(createEditorAssistanceFeature());
  return features;
}
