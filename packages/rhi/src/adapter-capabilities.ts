import type { RhiAdapter } from './index';

/** Snapshot WebGPU-shaped adapter facts without retaining mutable native collections. */
export function projectAdapterCapabilities(
  rawFeatures: ReadonlySet<GPUFeatureName> | null | undefined,
  rawLimits: Readonly<Record<string, unknown>> | null | undefined,
): Pick<RhiAdapter, 'features' | 'limits'> {
  const features = new Set(rawFeatures ?? []);
  const limits: Record<string, number> = {};
  for (const key in rawLimits ?? {}) {
    const value = rawLimits?.[key];
    if (typeof value === 'number') limits[key] = value;
  }
  return { features, limits };
}
