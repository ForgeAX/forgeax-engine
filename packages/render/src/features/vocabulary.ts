import type { RhiCaps } from '@forgeax/engine-rhi';

/** Closed prepared-resource kinds owned by the RenderFeature vocabulary. */
export type PreparedKind = 'pipeline' | 'bindings' | 'vertex-data' | 'index-data' | 'attachment';

/** Closed stages that can attribute a feature failure. */
export type RenderFeatureStage =
  | 'extract'
  | 'plan'
  | 'prepare'
  | 'contribute'
  | 'record'
  | 'recover'
  | 'dispose';

/** Recovery action attached to a structured feature failure. */
export type RenderFeatureRecovery = 'next-frame' | 'renderer-recover' | 'registration';

/** Boolean capability names are derived from the RHI capability source. */
type BooleanCapabilityKey = {
  [Key in keyof RhiCaps]-?: RhiCaps[Key] extends boolean ? Key : never;
}[keyof RhiCaps];

export type RenderFeatureCapabilityKey = BooleanCapabilityKey;
