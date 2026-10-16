import { RhiError } from '@forgeax/engine-rhi';
import {
  SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_WGSL,
  SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_WGSL,
  SINGLE_LAYER_MEDIUM_RAW_DEPTH_WGSL,
} from '@forgeax/engine-shader';
import {
  BARREL_DISTORTION_FEATURE_IDENTITY,
  createBarrelDistortionRenderFeature,
} from '../features/barrel-distortion';
import { createLensEffectsRenderFeature } from '../features/lens-effects';
import { createLensFlareRenderFeature } from '../features/lens-flare';
import { createOutlineRenderFeature } from '../features/outline/shaders';
import { createSmaaRenderFeature } from '../features/smaa/shaders';
import type { RenderFeature } from '../features/types';
import {
  SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_POST_PROCESS_ID,
  SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_POST_PROCESS_ID,
  SINGLE_LAYER_MEDIUM_RAW_DEPTH_POST_PROCESS_ID,
} from '../pipeline/single-layer-medium-passes';

export function withBuiltinRenderFeatures(
  requested: readonly RenderFeature<unknown>[],
): RenderFeature<unknown>[] {
  const features = [...requested];
  if (!features.some((feature) => feature.identity === BARREL_DISTORTION_FEATURE_IDENTITY)) {
    features.push(createBarrelDistortionRenderFeature());
  }
  features.push(
    createOutlineRenderFeature(),
    createLensEffectsRenderFeature(),
    createLensFlareRenderFeature(),
    createSmaaRenderFeature(),
  );
  return features;
}

export function collectRequiredFullscreenPostProcesses(
  features: readonly RenderFeature<unknown>[],
): readonly { readonly identity: string; readonly source: string }[] {
  const entries = new Map<string, { readonly identity: string; readonly source: string }>([
    [
      SINGLE_LAYER_MEDIUM_RAW_DEPTH_POST_PROCESS_ID,
      {
        identity: SINGLE_LAYER_MEDIUM_RAW_DEPTH_POST_PROCESS_ID,
        source: SINGLE_LAYER_MEDIUM_RAW_DEPTH_WGSL,
      },
    ],
    [
      SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_POST_PROCESS_ID,
      {
        identity: SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_POST_PROCESS_ID,
        source: SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_WGSL,
      },
    ],
    [
      SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_POST_PROCESS_ID,
      {
        identity: SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_POST_PROCESS_ID,
        source: SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_WGSL,
      },
    ],
  ]);
  for (const feature of features) {
    for (const entry of feature.requiredFullscreenPostProcesses ?? []) {
      const existing = entries.get(entry.identity);
      if (existing !== undefined && existing.source !== entry.source) {
        throw new RhiError({
          code: 'internal-error',
          expected: `fullscreen identity '${entry.identity}' has one source across render features`,
          hint: 'rename the conflicting fullscreen identity or make its WGSL source identical',
        });
      }
      entries.set(entry.identity, entry);
    }
  }
  return Object.freeze([...entries.values()]);
}
