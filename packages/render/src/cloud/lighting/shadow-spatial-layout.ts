export const CLOUD_SHADOW_FINAL_TARGET = 'cloud-shadow';
export const CLOUD_SHADOW_RAW_TARGET = 'cloud-shadow-raw';
export const CLOUD_SHADOW_INTERMEDIATE_TARGETS = [
  'cloud-shadow-filter-1',
  'cloud-shadow-filter-2',
  'cloud-shadow-filter-3',
] as const;
export const CLOUD_SHADOW_SPATIAL_PASSES = [
  'cloud-layer-shadow-filter',
  'cloud-layer-shadow-filter-2',
  'cloud-layer-shadow-filter-3',
  'cloud-layer-shadow-filter-4',
] as const;

type IntermediateTarget = (typeof CLOUD_SHADOW_INTERMEDIATE_TARGETS)[number];
export interface CloudShadowSpatialPass {
  readonly name: (typeof CLOUD_SHADOW_SPATIAL_PASSES)[number];
  readonly input: typeof CLOUD_SHADOW_RAW_TARGET | IntermediateTarget;
  readonly output: typeof CLOUD_SHADOW_FINAL_TARGET | IntermediateTarget;
  readonly resolution: number;
}

export interface CloudShadowSpatialLayout {
  readonly rawResolution: number;
  readonly filteredResolution: number;
  readonly traceTarget: typeof CLOUD_SHADOW_RAW_TARGET | typeof CLOUD_SHADOW_FINAL_TARGET;
  readonly passes: readonly CloudShadowSpatialPass[];
}

/** Shares the same allocation and pass order between feature planning and Standard. */
export function cloudShadowSpatialLayout(
  rawResolution: number,
  spatialPassCount = 1,
  ue5Reference = false,
): CloudShadowSpatialLayout {
  let resolution = rawResolution;
  const round = ue5Reference ? Math.floor : Math.ceil;
  const passes = CLOUD_SHADOW_SPATIAL_PASSES.slice(0, spatialPassCount).map(
    (name, index): CloudShadowSpatialPass => {
      resolution = Math.max(1, round(resolution / 2));
      return {
        name,
        input: CLOUD_SHADOW_INTERMEDIATE_TARGETS[index - 1] ?? CLOUD_SHADOW_RAW_TARGET,
        output:
          index + 1 === spatialPassCount
            ? CLOUD_SHADOW_FINAL_TARGET
            : (CLOUD_SHADOW_INTERMEDIATE_TARGETS[index] ?? CLOUD_SHADOW_FINAL_TARGET),
        resolution,
      };
    },
  );
  return {
    rawResolution,
    filteredResolution: resolution,
    traceTarget: passes.length ? CLOUD_SHADOW_RAW_TARGET : CLOUD_SHADOW_FINAL_TARGET,
    passes,
  };
}
