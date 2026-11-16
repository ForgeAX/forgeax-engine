import type { WaterZoneAsset } from '@forgeax/engine/types';
import { validateWaterAsset } from '@forgeax/engine/water';
import { expect, it } from 'vitest';
import { entryZone } from '../entry-zone';

it('admits the fixed entry domain without retaining an incompatible view window', () => {
  const coast: WaterZoneAsset = {
    kind: 'water-zone',
    extentM: { spanXM: 8192, spanZM: 8192 },
    tileSizeM: 8,
    tessellationFactor: 6,
    lodScale: 1.7,
    farMeshBoundary: 'view-window',
    farExtentM: { spanXM: 4096, spanZM: 4096 },
    farMaterialGuid: '00000000-0000-7000-8000-000000000008',
    waterInfo: {
      resolution: { widthPx: 2048, heightPx: 2048 },
      format: 'rgba16f',
      blurRadius: 1,
      localTessellation: true,
      localExtentM: [2048, 100, 2048],
    },
  };
  const accepted = entryZone(coast);
  expect(validateWaterAsset({ ...accepted, farMeshBoundary: 'view-window' }).ok).toBe(false);
  expect(validateWaterAsset(accepted).ok).toBe(true);
  expect(accepted).toMatchObject({
    farMeshBoundary: 'zone',
    extentM: { spanXM: 128, spanZM: 128 },
    waterInfo: { localTessellation: false },
  });
});
