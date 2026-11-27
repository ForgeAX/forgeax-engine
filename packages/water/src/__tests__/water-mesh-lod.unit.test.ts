import { describe, expect, it } from 'vitest';
import {
  buildWaterMeshView,
  type WaterMeshBuildInput,
  type WaterMeshTileInstance,
  WaterMeshViewBuilder,
  type WaterMeshViewInput,
} from '../water-mesh.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const body = {
  guid: '00000000-0000-7000-8000-000000000001',
  generation: 1,
  type: 'ocean' as const,
  visible: true,
  affectsWaterMesh: true,
  priority: 0,
  materialKey: 'water',
  waveOriginXZ: [0, 0] as const,
  baseHeightM: 0,
  maxWaveHeightM: 0,
  polygon: {
    outer: [
      [-256, -256],
      [256, -256],
      [256, 256],
      [-256, 256],
    ] as const,
  },
};

const zone = (
  extentM: readonly [number, number],
  tessellationFactor: number,
): WaterMeshBuildInput => ({
  zoneGuid: '00000000-0000-7000-8000-000000000002',
  zoneGeneration: 1,
  originXZ: extentM[0] === 256 ? [-128, -128] : [0, 0],
  extentM,
  tileSizeM: 8,
  tessellationFactor,
  lodScale: 1,
  bodies: [body],
});

describe('WaterMesh LOD selection', () => {
  it('retains geometry preparation while matching fresh builds for changing views', () => {
    const input = zone([256, 256], 4);
    const builder = new WaterMeshViewBuilder(input);
    const views: WaterMeshViewInput[] = [
      { viewId: 'moving', observerM: [0, 8, 1000] },
      { viewId: 'moving', observerM: [0, 8, 8] },
      {
        viewId: 'moving',
        observerM: [32, 8, -32],
        frustumPlanes: [{ normal: [1, 0, 0], distance: 0 }],
        occluded: (bounds) => bounds.minM[2] > 0,
      },
      { viewId: 'moving', observerM: [0, 8, 1000] },
    ];
    for (const view of views) {
      const retained = builder.build(view);
      expect(retained).toEqual(buildWaterMeshView(input, view));
    }
    const first = builder.build(requiredFixtureValue(views[0]));
    const next = builder.build(requiredFixtureValue(views[0]));
    if (!first.ok || !next.ok) throw new Error('Expected valid mesh builds');
    expect(first.value.buckets[0]?.mesh).toBe(next.value.buckets[0]?.mesh);
    expect(first.value.instanceBytes).not.toBe(next.value.instanceBytes);
  });

  it('owns a detached geometry snapshot across caller edits', () => {
    const input = structuredClone(zone([256, 256], 4));
    const expected = structuredClone(input);
    const builder = new WaterMeshViewBuilder(input);
    Object.assign(input, { originXZ: [512, 512], tessellationFactor: 2 });
    Object.assign(requiredFixtureValue(input.bodies[0]), { visible: false });
    const view = { viewId: 'snapshot', observerM: [0, 8, 8] as const };
    expect(builder.build(view)).toEqual(buildWaterMeshView(expected, view));
    expect(builder.build(view)).not.toEqual(buildWaterMeshView(input, view));
  });

  it.each([0, 1])('retains leaf tiles for the two-quad grid budget %s', (tessellationFactor) => {
    const result = buildWaterMeshView(zone([16, 16], tessellationFactor), {
      viewId: 'minimum-density',
      observerM: [32, 1000, 8],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instances).toHaveLength(4);
    for (const tile of result.value.instances)
      expect(tile).toMatchObject({ lod0: 0, maxMorphLod: 0, quadsPerEdge: 2, shouldMorph: false });
  });

  it('selects logical LOD one at the two-scale nearest-distance threshold', () => {
    const input = zone([16, 16], 2);
    const result = buildWaterMeshView(input, { viewId: 'threshold', observerM: [32, 0, 8] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instances).toHaveLength(1);
    expect(result.value.instances[0]).toMatchObject({
      extentXZ: [16, 16],
      lod0: 1,
      densityIndex: 0,
      quadsPerEdge: 4,
    });
  });

  it('keeps parent spatial LOD separate from logical LOD and grid density', () => {
    const input = zone([256, 256], 4);
    const distant = buildWaterMeshView(input, { viewId: 'distant', observerM: [0, 8, 1000] });
    expect(distant.ok).toBe(true);
    if (!distant.ok) return;
    expect(distant.value.instances).toHaveLength(16);
    expect(distant.value.instances[0]).toMatchObject({
      extentXZ: [64, 64],
      lod0: 3,
      maxMorphLod: 3,
      densityIndex: 0,
      quadsPerEdge: 16,
    });

    const nearby = buildWaterMeshView(input, { viewId: 'nearby', observerM: [0, 8, 130] });
    expect(nearby.ok).toBe(true);
    if (!nearby.ok) return;
    for (const tile of nearby.value.instances) {
      const spatialLod = Math.log2(tile.extentXZ[0] / input.tileSizeM);
      const densityDelta = tile.lod0 - spatialLod;
      expect(tile.lod0).toBeGreaterThanOrEqual(spatialLod);
      const effectiveDensity = Math.min(densityDelta, input.tessellationFactor - 1);
      expect(tile.densityIndex).toBe(effectiveDensity);
      expect(tile.quadsPerEdge).toBe(
        Math.max(2, 2 ** Math.max(0, input.tessellationFactor - effectiveDensity)),
      );
    }
  });

  it.each([
    'minimum-scale',
    'exhausted-density',
    'distant-density',
  ] as const)('keeps every shared edge continuous: %s', (scenario) => {
    const exhausted = scenario !== 'minimum-scale';
    const input: WaterMeshBuildInput = exhausted
      ? {
          ...zone([1024, 1024], 5),
          originXZ: [-512, -512],
          tileSizeM: 16,
          lodScale: 2,
          bodies: [
            {
              ...body,
              polygon: {
                outer: [
                  [-512, -512],
                  [512, -512],
                  [512, 512],
                  [-512, 512],
                ],
                holes: [
                  [
                    [-170, -115],
                    [170, -100],
                    [135, 160],
                    [-130, 140],
                  ],
                ],
              },
            },
          ],
        }
      : { ...zone([256, 256], 8), lodScale: 0.5 };
    const result = buildWaterMeshView(input, {
      viewId: scenario,
      observerM: exhausted
        ? [410, scenario === 'distant-density' ? 4096 : 380, 440]
        : [3.7, 8, 20.3],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tiles = result.value.instances.filter((tile) => !tile.far);
    const f = Math.fround;
    const fract = (value: number) => value - Math.floor(value);
    const edge = (tile: WaterMeshTileInstance, side: 'left' | 'right' | 'top' | 'bottom') => {
      const positions: (readonly [number, number])[] = [];
      for (let index = 0; index <= tile.quadsPerEdge; index++) {
        const t = f(index / tile.quadsPerEdge);
        const local =
          side === 'top' ? [t, 0] : side === 'bottom' ? [t, 1] : side === 'left' ? [0, t] : [1, t];
        const position = [f(local[0] * tile.extentXZ[0]), f(local[1] * tile.extentXZ[1])];
        const quadSize = [
          f(tile.extentXZ[0] / tile.quadsPerEdge),
          f(tile.extentXZ[1] / tile.quadsPerEdge),
        ];
        if (tile.shouldMorph) {
          for (let lod = tile.lod0; lod < tile.maxMorphLod; lod++) {
            const distance = Math.hypot(
              f(requiredFixtureValue(position[0]) - tile.cameraRelativeXZ[0]),
              f(requiredFixtureValue(position[1]) - tile.cameraRelativeXZ[1]),
            );
            const height = lod === tile.lod0 ? Math.round(tile.heightMorph01 * 8191) / 8191 : 0;
            const distanceFactor = Math.min(
              1,
              Math.max(0, distance / (tile.lodScaleM * 2 ** lod) - 1),
            );
            const factor = Math.min(1, height + distanceFactor);
            for (const axis of [0, 1] as const) {
              const grid4 = f(requiredFixtureValue(quadSize[axis]) * 4);
              const offset = f(fract(f(requiredFixtureValue(position[axis]) / grid4)) - 0.5);
              if (Math.abs(offset) < 0.26)
                position[axis] = f(
                  requiredFixtureValue(position[axis]) + f(f(f(offset * factor) * grid4)),
                );
              quadSize[axis] = f(requiredFixtureValue(quadSize[axis]) * 2);
            }
            if (factor < 1) break;
          }
        }
        positions.push([
          f(tile.originXZ[0] + requiredFixtureValue(position[0])),
          f(tile.originXZ[1] + requiredFixtureValue(position[1])),
        ]);
      }
      return positions;
    };
    const cache = new Map<WaterMeshTileInstance, Map<string, (readonly [number, number])[]>>();
    const cachedEdge = (tile: WaterMeshTileInstance, side: 'left' | 'right' | 'top' | 'bottom') => {
      let sides = cache.get(tile);
      if (!sides) {
        sides = new Map();
        cache.set(tile, sides);
      }
      if (!sides.has(side)) sides.set(side, edge(tile, side));
      return requiredFixtureValue(sides.get(side));
    };
    let segments = 0;
    let crossSize = 0;
    let mixedLod = 0;
    for (let aIndex = 0; aIndex < tiles.length; aIndex++) {
      for (let bIndex = aIndex + 1; bIndex < tiles.length; bIndex++) {
        const a = requiredFixtureValue(tiles[aIndex]);
        const b = requiredFixtureValue(tiles[bIndex]);
        for (const axis of [0, 1] as const) {
          const along = 1 - axis;
          const lo = Math.max(
            requiredFixtureValue(a.originXZ[along]),
            requiredFixtureValue(b.originXZ[along]),
          );
          const hi = Math.min(
            requiredFixtureValue(a.originXZ[along]) + requiredFixtureValue(a.extentXZ[along]),
            requiredFixtureValue(b.originXZ[along]) + requiredFixtureValue(b.extentXZ[along]),
          );
          if (hi <= lo) continue;
          const aToB =
            requiredFixtureValue(a.originXZ[axis]) + requiredFixtureValue(a.extentXZ[axis]) ===
            b.originXZ[axis];
          const bToA =
            requiredFixtureValue(b.originXZ[axis]) + requiredFixtureValue(b.extentXZ[axis]) ===
            a.originXZ[axis];
          if (!aToB && !bToA) continue;
          const left = aToB ? a : b;
          const right = aToB ? b : a;
          const sideLeft = axis === 0 ? 'right' : 'bottom';
          const sideRight = axis === 0 ? 'left' : 'top';
          const strip = (tile: WaterMeshTileInstance, side: typeof sideLeft) =>
            [
              ...new Set(
                cachedEdge(tile, side)
                  .map((point) => requiredFixtureValue(point[along]))
                  .filter((value) => value >= lo - 0.0001 && value <= hi + 0.0001),
              ),
            ].sort((x, y) => x - y);
          const first = strip(left, sideLeft);
          const second = strip(right, sideRight);
          expect(first.length).toBe(second.length);
          for (let index = 0; index < first.length; index++)
            expect(
              Math.abs(requiredFixtureValue(first[index]) - requiredFixtureValue(second[index])),
            ).toBeLessThan(0.0001);
          segments++;
          if (a.extentXZ[axis] !== b.extentXZ[axis]) crossSize++;
          if (a.lod0 !== b.lod0) mixedLod++;
        }
      }
    }
    expect(segments).toBeGreaterThan(exhausted ? 0 : 100);
    expect(crossSize).toBeGreaterThan(0);
    if (!exhausted) expect(mixedLod).toBeGreaterThan(0);
  });
});
