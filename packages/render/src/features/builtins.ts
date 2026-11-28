import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/contracts';
import { createMode0CloudFeature } from '../cloud/reconstruction/feature';
import { standardCloudProducers } from '../cloud/standard-cloud-owner';
import {
  createWaterAdvancedFeature,
  WATER_ADVANCED_FEATURE_IDENTITY,
} from '../water/advanced-feature';
import { createWaterFluidFeature, WATER_FLUID_FEATURE_IDENTITY } from '../water/fluid-feature';
import { createWaterGpuMeshFeature } from '../water/gpu-mesh-feature';
import { WATER_GPU_MESH_FEATURE } from '../water/gpu-mesh-source';
import { standardWaterProducer } from '../water/standard-water-owner';
import {
  createWaterUnderwaterFeature,
  WATER_UNDERWATER_FEATURE_IDENTITY,
} from '../water/underwater-feature';
import { createWaterInfoFeature, WATER_INFO_FEATURE_IDENTITY } from '../water/water-info-feature';
import {
  createEditorAssistanceFeature,
  EDITOR_ASSISTANCE_FEATURE_IDENTITY,
} from './editor-assistance/feature';
import type { RenderFeature } from './types';

/** The same fixed source roster is constructed in both execution realms. */
export function withBuiltinRenderFeatures(
  requested: readonly RenderFeature<unknown>[],
  recordCloudAdoption?: Parameters<typeof createMode0CloudFeature>[0],
): RenderFeature<unknown>[] {
  const features = [...requested];
  if (!features.some((feature) => feature.identity === CLOUD_LAYER_FEATURE_IDENTITY)) {
    const clouds = createMode0CloudFeature(recordCloudAdoption) as RenderFeature<unknown>;
    standardCloudProducers.add(clouds);
    features.push(clouds);
  }
  let waterInfo = features.find((feature) => feature.identity === WATER_INFO_FEATURE_IDENTITY);
  if (waterInfo === undefined) {
    waterInfo = standardWaterProducer(createWaterInfoFeature());
    features.unshift(waterInfo);
  }
  if (!features.some((feature) => feature.identity === WATER_FLUID_FEATURE_IDENTITY))
    features.splice(
      features.indexOf(waterInfo) + 1,
      0,
      standardWaterProducer(createWaterFluidFeature({}, waterInfo)),
    );
  if (!features.some((feature) => feature.identity === WATER_ADVANCED_FEATURE_IDENTITY))
    features.splice(
      features.indexOf(waterInfo) + 1,
      0,
      standardWaterProducer(createWaterAdvancedFeature(waterInfo)),
    );
  if (!features.some((feature) => feature.identity === WATER_GPU_MESH_FEATURE))
    features.splice(
      features.indexOf(waterInfo) + 1,
      0,
      standardWaterProducer(createWaterGpuMeshFeature(waterInfo)),
    );
  if (!features.some((feature) => feature.identity === WATER_UNDERWATER_FEATURE_IDENTITY))
    features.push(standardWaterProducer(createWaterUnderwaterFeature()));
  if (!features.some((feature) => feature.identity === EDITOR_ASSISTANCE_FEATURE_IDENTITY))
    features.push(createEditorAssistanceFeature());
  return features;
}
