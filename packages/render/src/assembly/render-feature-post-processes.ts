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
import { LENS_EFFECTS_PROGRAM } from '../features/lens-effects';
import { LENS_FLARE_PROGRAMS } from '../features/lens-flare';
import { OUTLINE_PROGRAMS } from '../features/outline/shaders';
import { SMAA_PROGRAMS } from '../features/smaa/shaders';
import type { RenderFeature } from '../features/types';
import {
  SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_POST_PROCESS_ID,
  SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_POST_PROCESS_ID,
  SINGLE_LAYER_MEDIUM_RAW_DEPTH_POST_PROCESS_ID,
} from '../pipeline/single-layer-medium-passes';
import type { RenderSystem } from '../render-system';

const STANDARD_POST_PROCESS_PROGRAMS = [
  LENS_EFFECTS_PROGRAM,
  ...LENS_FLARE_PROGRAMS,
  ...OUTLINE_PROGRAMS,
  ...SMAA_PROGRAMS,
];

/** Standard owns these static declarations and their device-bound parameters. */
export function registerStandardPostProcessBuiltins(
  renderSystem: Pick<RenderSystem, 'registerBuiltinPostProcess'>,
): void {
  for (const { kind: _kind, name, ...entry } of STANDARD_POST_PROCESS_PROGRAMS)
    renderSystem.registerBuiltinPostProcess(name, entry);
}

export function withBuiltinRenderFeatures(
  requested: readonly RenderFeature<unknown>[],
): RenderFeature<unknown>[] {
  const features = [...requested];
  if (!features.some((feature) => feature.identity === BARREL_DISTORTION_FEATURE_IDENTITY)) {
    features.push(createBarrelDistortionRenderFeature());
  }
  return features;
}

export function collectRequiredFullscreenPostProcesses(
  features: readonly RenderFeature<unknown>[],
): readonly { readonly identity: string; readonly source: string }[] {
  const entries = new Map<string, { readonly identity: string; readonly source: string }>([
    ...STANDARD_POST_PROCESS_PROGRAMS.map(
      ({ name, source }) => [name, { identity: name, source }] as const,
    ),
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
