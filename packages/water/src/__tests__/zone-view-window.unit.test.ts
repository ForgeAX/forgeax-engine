import { describe, expect, it } from 'vitest';
import type { WaterZoneAsset } from '../contracts.js';
import type { WaterZoneSnapshot } from '../system.js';
import { createWaterZoneViewWindow } from '../zone-view-window.js';

const asset: WaterZoneAsset = {
  kind: 'water-zone',
  extentM: { spanXM: 76, spanZM: 50 },
  tileSizeM: 3,
  tessellationFactor: 3,
  lodScale: 1,
  waterInfo: {
    resolution: { widthPx: 16, heightPx: 16 },
    format: 'rgba16f',
    blurRadius: 0,
    localTessellation: true,
  },
};
const zone = (local = true, scale = 1): WaterZoneSnapshot => ({
  guid: 'zone',
  generation: 1,
  asset: { ...asset, waterInfo: { ...asset.waterInfo, localTessellation: local } },
  worldMatrixM: [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 1, 2, 4, 1],
});

describe('shared Zone view window', () => {
  it('keeps the opt-in far boundary near the observer across repeated forward and reverse recenters', () => {
    const source = zone();
    const following = {
      ...source,
      asset: {
        ...source.asset,
        farMeshBoundary: 'view-window' as const,
        waterInfo: { ...source.asset.waterInfo, localExtentM: [2048, 100, 2048] as const },
      },
    };
    let previous = createWaterZoneViewWindow(following, 'main', [0, 4, 0], 1);
    let recenters = 0;
    for (const x of [2, 4, 8, 16, 24, 16, 8, 0, -8]) {
      const next = createWaterZoneViewWindow(following, 'main', [x, 4, 0], 1, previous);
      if (next !== previous) recenters++;
      expect(Math.abs(next.centerXZ[0] - x)).toBeLessThanOrEqual(source.asset.tileSizeM);
      previous = next;
    }
    expect(recenters).toBeGreaterThanOrEqual(4);
  });
  it('uses the local default diameter and horizontal hysteresis while storing a snapped XYZ center', () => {
    const source = zone();
    const first = createWaterZoneViewWindow(source, 'main', [1, 5, 4], 1);
    expect(first.centerM).toEqual([0, 6, 3]);
    expect(first.extentXZ).toEqual([512, 512]);
    expect(first.updateHalfExtentXZ).toEqual([106, 106]);
    expect(first.resolution).toEqual([256, 256]);
    expect(createWaterZoneViewWindow(source, 'main', [105.99, 500, 3], 1, first)).toBe(first);
    const moved = createWaterZoneViewWindow(source, 'main', [106, 500, 3], 1, first);
    expect(moved).not.toBe(first);
    expect(moved.centerM).toEqual([105, 501, 3]);
    expect(createWaterZoneViewWindow(source, 'main', [0, 6, 3], 2, first)).not.toBe(first);
  });

  it('scales the diameter while retaining the world tile size and update margin', () => {
    const source = zone(true, 2);
    const window = createWaterZoneViewWindow(source, 'main', [4, 5, 7], 1);
    expect(window.centerM).toEqual([3, 6, 6]);
    expect(window.extentXZ).toEqual([1024, 1024]);
    expect(window.updateHalfExtentXZ).toEqual([362, 362]);
    expect(window.resolution).toEqual([512, 512]);
    expect(window.meshExtentXZ).toEqual([1536, 1536]);
  });

  it('keeps global WaterInfo centered on the actor and independently snaps the mesh center', () => {
    const source = zone(false);
    const window = createWaterZoneViewWindow(source, 'main', [30, 10, 40], 1);
    expect(window.centerM).toEqual([1, 2, 4]);
    expect(window.extentXZ).toEqual([76, 50]);
    expect(window.resolution).toEqual([32, 16]);
    expect(window.meshOriginXZ).toEqual([-48, -21]);
    expect(window.meshExtentXZ).toEqual([96, 48]);
    expect(createWaterZoneViewWindow(source, 'main', [500, 100, 500], 1, window)).toBe(window);
  });

  it('uses each authored horizontal local diameter and clamps only the update half extent', () => {
    const source = zone();
    const configured = {
      ...source,
      asset: {
        ...source.asset,
        waterInfo: { ...source.asset.waterInfo, localExtentM: [76, 100, 50] as const },
      },
    };
    const window = createWaterZoneViewWindow(configured, 'main', [0, 0, 0], 1);
    expect(window.extentXZ).toEqual([76, 50]);
    expect(window.updateHalfExtentXZ).toEqual([0.01, 0.01]);
    expect(window.resolution).toEqual([32, 16]);
  });

  it('truncates positive fractional tile counts before pow2, with zero rounding to one half tile', () => {
    const source = zone();
    const window = (x: number, z: number) =>
      createWaterZoneViewWindow(
        {
          ...source,
          asset: {
            ...source.asset,
            waterInfo: { ...source.asset.waterInfo, localExtentM: [x, 100, z] },
          },
        },
        'main',
        [0, 0, 0],
        1,
      );
    expect(window(48.2, 76).resolution).toEqual([16, 32]);
    expect(window(1, 2).resolution).toEqual([2, 2]);
  });
});
