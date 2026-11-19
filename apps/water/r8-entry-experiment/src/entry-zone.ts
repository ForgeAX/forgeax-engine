import type { WaterZoneAsset } from '@forgeax/engine/types';

/** This experiment has a fixed zone domain rather than a camera-following water window. */
export function entryZone(source: WaterZoneAsset): WaterZoneAsset {
  return {
    ...source,
    extentM: { spanXM: 128, spanZM: 128 },
    farMeshBoundary: 'zone',
    farExtentM: { spanXM: 1800, spanZM: 1800 },
    tessellationFactor: 5,
    waterInfo: {
      ...source.waterInfo,
      resolution: { widthPx: 512, heightPx: 512 },
      localTessellation: false,
    },
  };
}
