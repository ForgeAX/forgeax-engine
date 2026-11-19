import type { RhiCaps } from '@forgeax/engine-rhi';
import { SkyPass } from '../record/gpu-pass-timing/sky-pass-names';

/** Closed prepared-resource kinds owned by the RenderFeature vocabulary. */
export type PreparedKind = 'pipeline' | 'bindings' | 'vertex-data' | 'index-data' | 'attachment';

/** Closed stages that can attribute a feature failure. */
export type RenderFeatureStage =
  | 'extract'
  | 'plan'
  | 'prepare'
  | 'contribute'
  | 'record'
  | 'receipt'
  | 'recover'
  | 'dispose';

/** Recovery action attached to a structured feature failure. */
export type RenderFeatureRecovery = 'next-frame' | 'renderer-recover' | 'registration';

/** Standard splits these named feature passes across target initialization stages. */
export const STANDARD_FEATURE_PRE_OPAQUE_PASSES = Object.freeze([
  SkyPass.cloudShadow,
  SkyPass.cloudShadowFilter,
] as const);
export const STANDARD_FEATURE_SCENE_COMPOSITE_PASSES = Object.freeze([
  SkyPass.cloudAnalyticTrace,
  SkyPass.cloudSampledTrace,
  SkyPass.cloudProbe,
  SkyPass.cloudHistoryClear,
  SkyPass.cloudReconstruction,
  SkyPass.cloudResolve,
] as const);

export function isStandardFeatureStagePass(name: string): boolean {
  return (
    STANDARD_FEATURE_PRE_OPAQUE_PASSES.some((candidate) => candidate === name) ||
    STANDARD_FEATURE_SCENE_COMPOSITE_PASSES.some((candidate) => candidate === name)
  );
}

/** Boolean capability names are derived from the RHI capability source. */
type BooleanCapabilityKey = {
  [Key in keyof RhiCaps]-?: NonNullable<RhiCaps[Key]> extends boolean ? Key : never;
}[keyof RhiCaps];

export type RenderFeatureCapabilityKey = BooleanCapabilityKey;
