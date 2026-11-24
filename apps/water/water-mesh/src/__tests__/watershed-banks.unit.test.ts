import { insertWaterSplinePoint, type WaterSplinePoint } from '@forgeax/engine/water';
import { expect, it } from 'vitest';
import {
  lakeShoreDistance,
  RIVER_PATH,
  WORLD_ORIGIN,
  WORLD_SPACING_M,
  watershedHeight,
} from '../watershed';

const points: WaterSplinePoint[] = RIVER_PATH.map((p, i) => {
  const before = RIVER_PATH[Math.max(0, i - 1)] ?? p;
  const after = RIVER_PATH[Math.min(RIVER_PATH.length - 1, i + 1)] ?? p;
  const divisor = i === 0 || i === RIVER_PATH.length - 1 ? 1 : 2;
  const tangent = [0, 1, 2].map((axis) => ((after[axis] ?? 0) - (before[axis] ?? 0)) / divisor) as [
    number,
    number,
    number,
  ];
  return {
    inputKey: i,
    positionM: [p[0], p[1], p[2]],
    arriveTangentM: tangent,
    leaveTangentM: tangent,
    interpolationMode: 'curve-custom-tangent',
    up: [0, 1, 0],
    rollAngle: 0,
    angleUnit: 'degrees',
    widthM: p[3],
    depthM: 3,
    velocityMPerSec: 2.8,
    audioIntensity: 0,
  };
});

it.each([0, 1])('keeps the open estuary seabed submerged in Terrain variant %i', (variant) => {
  for (const [x, z] of [
    [170, -65],
    [210, -70],
    [220, -88],
  ] as const) {
    expect(terrainRange(x, z, variant).max, `estuary at ${x}:${z}`).toBeLessThan(-5);
  }
});

// Check both possible terrain diagonals, including interpolation between authored samples.
function terrainRange(x: number, z: number, variant: number) {
  const gx = (x - WORLD_ORIGIN[0]) / WORLD_SPACING_M;
  const gz = (z - WORLD_ORIGIN[2]) / WORLD_SPACING_M;
  const ix = Math.floor(gx),
    iz = Math.floor(gz),
    u = gx - ix,
    v = gz - iz;
  const height = (dx: number, dz: number) =>
    watershedHeight(
      WORLD_ORIGIN[0] + (ix + dx) * WORLD_SPACING_M,
      WORLD_ORIGIN[2] + (iz + dz) * WORLD_SPACING_M,
      variant,
    );
  const a = height(0, 0),
    b = height(1, 0),
    c = height(0, 1),
    d = height(1, 1);
  const forward =
    u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  const backward = u >= v ? a + (b - a) * u + (d - b) * v : a + (d - c) * u + (c - a) * v;
  return { min: Math.min(forward, backward), max: Math.max(forward, backward) };
}

it.each([0, 1])('contains the curved descending river in Terrain variant %i', (variant) => {
  for (let segment = 0; segment < RIVER_PATH.length - 1; segment++) {
    for (let step = 1; step <= 12; step++) {
      const sample = insertWaterSplinePoint(points, segment + 1, step / 13).unwrap()[segment + 1];
      if (!sample) throw new Error('Missing river sample');
      const [x, y, z] = sample.positionM;
      const tangent = sample.leaveTangentM;
      const length = Math.hypot(tangent[0], tangent[2]);
      expect(terrainRange(x, z, variant).max, `bed at ${segment}:${step}`).toBeLessThan(y - 0.3);
      // The terminal descent crosses the island shore and opens into the Ocean.
      if (segment >= 4) {
        expect(terrainRange(x, z, variant).max, `tidal bed at ${segment}:${step}`).toBeLessThan(
          -1.5,
        );
        continue;
      }
      for (const side of [-1, 1]) {
        const distance = side * sample.widthM * 0.5;
        const edgeX = x - (tangent[2] / length) * distance;
        const edgeZ = z + (tangent[0] / length) * distance;
        if (lakeShoreDistance(edgeX, edgeZ) < 1.2) continue;
        const edge = terrainRange(edgeX, edgeZ, variant);
        expect(edge.min, `bank ${side} at ${segment}:${step}`).toBeGreaterThan(y + 0.1);
      }
    }
  }
});
