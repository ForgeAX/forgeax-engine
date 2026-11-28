import { describe, expect, it } from 'vitest';
import { cloudShellInterval } from '../../tracing/geometry';
import {
  buildCloudShadowSample,
  type CloudLightSettings,
  type CookedCloudShadow,
  cloudBsmTraceInterval,
  cloudConsumerShadow,
  cloudMapShadowTransmittance,
  cloudRayShadowTransmittance,
  cloudShadowOpticalDepth,
  cloudShadowSegment,
  cookedCloudShadowProjection,
  filterCloudShadowSamples,
  prepareCloudLight,
  queryCloudShadow,
  viewCloudShadowProjection,
} from '../shadow';

type Point = readonly [number, number, number];
const radius = 6_360_000;

describe('BSM near-plane shell intervals', () => {
  it('keeps the UE map fixed inside a world grid cell and snaps to filtered texels', () => {
    const settings = {
      ...shadowSettings,
      ue5Reference: true,
      resolution: 512,
      extentMeters: 160000,
    };
    const a = viewCloudShadowProjection(settings, [6000, 2000, 0]);
    const b = viewCloudShadowProjection(settings, [9000, 2000, 0]);
    const c = viewCloudShadowProjection(settings, [11000, 2000, 0]);
    expect(a.origin).toEqual(b.origin);
    expect(c.origin).not.toEqual(a.origin);
    for (const axis of [c.right, c.up]) {
      const texel = axis.reduce((sum, x, i) => sum + x * (c.origin[i] ?? 0), 0) / 625;
      expect(texel).toBeCloseTo(Math.round(texel), 10);
    }
  });

  it('budgets extra midpoint samples by local sun elevation only in UE mode', () => {
    const settings = { ...shadowSettings, mapSamples: 16 };
    expect(viewCloudShadowProjection(settings, [0, 0, 0]).traceSamples).toBeUndefined();
    const high = viewCloudShadowProjection(
      { ...settings, ue5Reference: true, directionToLight: [0, 1, 0] },
      [0, 0, 0],
    );
    const low = viewCloudShadowProjection(
      { ...settings, ue5Reference: true, directionToLight: [1, 0, 0] },
      [0, 0, 0],
    );
    expect(high.traceSamples).toBeCloseTo(19.2);
    expect(low.traceSamples).toBe(32);
  });

  it('anchors a finite shared projection to the selected camera ground position', () => {
    const camera: Point = [15000, 2000, -30000];
    const map = viewCloudShadowProjection({ ...shadowSettings, depthMeters: 600000 }, camera);
    expect(map.depthMeters).toBe(600000);
    expect(map.extentMeters).toBe(40000);
    const radial = Math.hypot(camera[0], camera[1] + radius, camera[2]);
    const ground: Point = [
      (camera[0] * radius) / radial,
      ((camera[1] + radius) * radius) / radial - radius,
      (camera[2] * radius) / radial,
    ];
    const offset = point3(ground.map((value, index) => value - (map.origin[index] ?? 0)));
    expect(-dot3(offset, map.directionToLight)).toBeCloseTo(300000, 6);
    expect(Math.abs(dot3(offset, map.right))).toBeLessThanOrEqual(40000 / 128);
    expect(Math.abs(dot3(offset, map.up))).toBeLessThanOrEqual(40000 / 128);
    const moved = viewCloudShadowProjection(shadowSettings, [
      camera[0] + 20000,
      camera[1],
      camera[2],
    ]);
    expect(moved.origin).not.toEqual(map.origin);
    expect(
      viewCloudShadowProjection(
        { ...shadowSettings, lightDistanceMeters: 150000, depthMeters: 300000 },
        camera,
      ).depthMeters,
    ).toBe(300000);
  });
  it('keeps the lateral full width, light distance and far depth independent', () => {
    const map = viewCloudShadowProjection(
      { ...shadowSettings, extentMeters: 160000, lightDistanceMeters: 80000, depthMeters: 160000 },
      [0, 2, 0],
    );
    expect(map.extentMeters).toBe(160000);
    expect(map.depthMeters).toBe(160000);
    expect(dot3(map.origin, map.directionToLight)).toBeCloseTo(80000, 6);
    const deeper = viewCloudShadowProjection(
      { ...shadowSettings, lightDistanceMeters: 80000, depthMeters: 250000 },
      [0, 2, 0],
    );
    expect(deeper.depthMeters).toBe(250000);
    expect(dot3(deeper.origin, deeper.directionToLight)).toBeCloseTo(80000, 6);
  });
  it('skips a near plane below cloud bottom instead of tracing the far-side shell', () => {
    expect(cloudBsmTraceInterval([0, radius, 0], [1, 0, 0], radius, 5000, 10000)).toEqual([0, 0]);
  });

  it('traces the front shell and a complete outer-only grazing chord', () => {
    expect(cloudBsmTraceInterval([0, radius + 20000, 0], [0, -1, 0], radius, 5000, 10000)).toEqual([
      5000, 15000,
    ]);
    const y = radius + 10000;
    const halfChord = Math.sqrt((radius + 15000) ** 2 - y ** 2);
    const interval = cloudBsmTraceInterval([-500000, y, 0], [1, 0, 0], radius, 5000, 10000);
    expect(interval[0]).toBeCloseTo(500000 - halfChord, 5);
    expect(interval[1]).toBeCloseTo(500000 + halfChord, 5);
    expect(cloudBsmTraceInterval([0, radius + 20000, 0], [0, 1, 0], radius, 5000, 10000)).toEqual([
      0, 0,
    ]);
  });
});
const lowSun = [0.7143567204475403, 0.14999574422836304, 0.6835171580314636] as const;
const shadowSettings = {
  directionToLight: lowSun,
  extentMeters: 40_000,
  depthMeters: 200_005.671875,
  resolution: 128,
  mapSamples: 64,
  mode: 1,
  cast: true,
  biasMeters: 0,
  strength: 1,
  surfaceStrength: 1,
};
const dot3 = (a: Point, b: Point) => a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
const point3 = (values: readonly number[]): Point => [
  values[0] ?? 0,
  values[1] ?? 0,
  values[2] ?? 0,
];

// Independent f64 quadratic oracle, expressed from a receiver toward the sun.
function sphereRoots(
  point: Point,
  sun: Point,
  height: number,
): readonly [number, number] | undefined {
  const radial: Point = [point[0], point[1] + radius, point[2]];
  const b = dot3(radial, sun);
  const a = dot3(sun, sun);
  const c = dot3(radial, radial) - (radius + height) ** 2;
  const discriminant = b * b - a * c;
  if (discriminant <= 0) return undefined;
  return [(-b - Math.sqrt(discriminant)) / a, (-b + Math.sqrt(discriminant)) / a];
}

function requiredRoots(point: Point, sun: Point, height: number): readonly [number, number] {
  const roots = sphereRoots(point, sun, height);
  if (!roots) throw new Error('Expected oracle sphere intersection');
  return roots;
}

function columnPoint(map: CookedCloudShadow, u: number, v: number): Point {
  return point3(
    map.origin.map(
      (value, i) => value + map.extentMeters * (u * (map.right[i] ?? 0) + v * (map.up[i] ?? 0)),
    ),
  );
}

describe('cooked cloud shadow shell coverage', () => {
  it.each([10_000, 40_000])('covers the captured downstream ground column at %i m', (distance) => {
    const map = cookedCloudShadowProjection(shadowSettings, 5000, 10_000);
    const receiver: Point = [distance, 0, distance];
    const outer = requiredRoots(receiver, map.directionToLight, 15_000);
    const inner = requiredRoots(receiver, map.directionToLight, 5000);
    const relative = point3(receiver.map((value, i) => value - (map.origin[i] ?? 0)));
    expect(Math.abs(dot3(relative, map.right))).toBeLessThan(map.extentMeters / 2);
    expect(Math.abs(dot3(relative, map.up))).toBeLessThan(map.extentMeters / 2);
    const receiverDepth = -dot3(relative, map.directionToLight);
    const entry = receiverDepth - outer[1];
    const exit = receiverDepth - inner[1];
    expect(entry).toBeGreaterThanOrEqual(0);
    expect(exit).toBeLessThanOrEqual(map.depthMeters);
    const sample = buildCloudShadowSample(entry, exit, map.mapSamples, () => [1e-5, 1e-5, 1e-5]);
    expect(sample.maxOpticalDepth).toBeCloseTo((outer[1] - inner[1]) * 1e-5, 10);
    for (const consumer of ['cloud', 'surface'] as const) {
      const query = queryCloudShadow(sample, receiverDepth, consumer);
      expect(query.covered && query.opticalDepth).toBeCloseTo(sample.maxOpticalDepth, 10);
    }
    expect(map.extentMeters).toBe(40_000);
    expect(map.resolution).toBe(128);
    expect(map.mapSamples).toBe(64);
  });

  it('retains the complete near-origin counterexample and meter-depth queries', () => {
    const map = cookedCloudShadowProjection(shadowSettings, 5000, 10_000);
    const receiver: Point = [0, 0, 0];
    const outer = requiredRoots(receiver, map.directionToLight, 15_000);
    const inner = requiredRoots(receiver, map.directionToLight, 5000);
    const oldOrigin: Point = [71425.4375, 25111.853515625, 68341.921875];
    const oldDepth = dot3(oldOrigin, map.directionToLight);
    expect(oldDepth - outer[1]).toBeGreaterThan(6000);
    expect(oldDepth - inner[1]).toBeLessThan(shadowSettings.depthMeters);
    const depth = dot3(map.origin, map.directionToLight);
    expect(depth - outer[1]).toBeGreaterThan(0);
    expect(depth - inner[1]).toBeLessThan(map.depthMeters);
  });

  it.each([
    { name: 'captured low sun', sun: lowSun, extent: 40_000 },
    {
      name: 'positive grazing sun',
      sun: [Math.sqrt(1 - 0.01 ** 2), 0.01, 0] as const,
      extent: 40_000,
    },
    {
      name: 'packed inner tangent boundary',
      sun: [0.9960642402648133, 0.08863424431719484, 0] as const,
      extent: 40_000,
    },
    { name: 'zenith', sun: [0, 1, 0] as const, extent: 40_000 },
    { name: 'below horizon', sun: [0, -0.15, 1] as const, extent: 40_000 },
    { name: 'horizontal mixed inner/outer limb', sun: [1, 0, 0] as const, extent: 40_000 },
    { name: 'interior nearest point', sun: [0, 1, 0] as const, extent: 20_000_000 },
  ])('bounds every first shell interval across $name, also after f32 packing', ({
    sun,
    extent,
  }) => {
    const full = cookedCloudShadowProjection(
      { ...shadowSettings, directionToLight: sun, extentMeters: extent },
      5000,
      10_000,
    );
    const packed = {
      ...full,
      origin: point3(full.origin.map(Math.fround)),
      right: point3(full.right.map(Math.fround)),
      up: point3(full.up.map(Math.fround)),
      directionToLight: point3(full.directionToLight.map(Math.fround)),
      depthMeters: Math.fround(full.depthMeters),
    };
    for (const map of [full, packed]) {
      let hits = 0;
      let misses = 0;
      // Includes all corners/edges, central rays and the exact horizontal inner tangent.
      const coordinates = Array.from({ length: 33 }, (_, index) => index / 32 - 0.5);
      if (sun[1] === 0) coordinates.push((5000 - 10_000) / extent);
      for (const u of coordinates)
        for (const v of coordinates) {
          const origin = columnPoint(map, u, v);
          const outer = sphereRoots(origin, map.directionToLight, 15_000);
          if (!outer) {
            misses++;
            continue;
          }
          hits++;
          const inner = sphereRoots(origin, map.directionToLight, 5000);
          const entry = -outer[1];
          const exit = -(inner ? inner[1] : outer[0]);
          expect(entry).toBeGreaterThanOrEqual(0);
          expect(exit).toBeLessThanOrEqual(map.depthMeters);
          if (map === full && outer[1] - outer[0] > 1) {
            const interval = cloudShellInterval(
              {
                cameraRelativeToPlanetMeters: [origin[0], origin[1] + radius, origin[2]],
                direction: [
                  -map.directionToLight[0],
                  -map.directionToLight[1],
                  -map.directionToLight[2],
                ],
              },
              { planetRadiusMeters: radius, bottomMeters: 5000, thicknessMeters: 10_000 },
              {
                tracingStartMaxDistanceMeters: Infinity,
                tracingMaxDistanceMeters: map.depthMeters,
                tracingMaxDistanceMode: 'from-camera',
                tracingStartDistanceFromCameraMeters: 0,
                sceneDistanceMeters: map.depthMeters,
              },
            );
            if (!interval) throw new Error('Expected production shell intersection');
            expect(interval.entryMeters).toBeGreaterThanOrEqual(0);
            expect(interval.exitMeters).toBeLessThanOrEqual(map.depthMeters);
            // At an exact tangent the independent quadratics can round to opposite
            // sides of the inner-sphere branch. Both intervals must still fit.
            if (!inner || inner[1] - inner[0] > 1) {
              expect(interval.entryMeters).toBeCloseTo(entry, 3);
              expect(interval.exitMeters).toBeCloseTo(exit, 3);
            }
          }
        }
      expect(hits).toBeGreaterThan(0);
      if (sun[1] === 0 || extent > radius) expect(misses).toBeGreaterThan(0);
    }
  });

  it('fits beyond a short input budget without changing sampling controls', () => {
    const one = cookedCloudShadowProjection(
      { ...shadowSettings, depthMeters: 100, mapSamples: 1 },
      5000,
      10_000,
    );
    const many = cookedCloudShadowProjection(
      { ...shadowSettings, depthMeters: 100, mapSamples: 256 },
      5000,
      10_000,
    );
    expect(one.origin).toEqual(many.origin);
    expect(one.depthMeters).toBe(many.depthMeters);
    expect(one.depthMeters).toBeGreaterThan(100);
    expect(one.mapSamples).toBe(1);
    expect(many.mapSamples).toBe(256);
    expect(
      cookedCloudShadowProjection({ ...shadowSettings, depthMeters: 1_000_000 }, 5000, 10_000)
        .depthMeters,
    ).toBe(1_000_000);
  });

  it('uses map depth rather than camera entry limit for positive grazing-sun columns', () => {
    const map = cookedCloudShadowProjection(
      {
        ...shadowSettings,
        depthMeters: 350_000,
        directionToLight: [Math.sqrt(1 - 0.01 ** 2), 0.01, 0],
      },
      5000,
      10_000,
    );
    const origin = columnPoint(map, -0.0625, 0.0625);
    const ray = {
      cameraRelativeToPlanetMeters: [origin[0], origin[1] + radius, origin[2]] as Point,
      direction: point3(map.directionToLight.map((value) => -value)),
    };
    const shell = { planetRadiusMeters: radius, bottomMeters: 5000, thicknessMeters: 10_000 };
    const clip = {
      tracingStartMaxDistanceMeters: map.depthMeters,
      tracingMaxDistanceMeters: map.depthMeters,
      tracingMaxDistanceMode: 'from-camera' as const,
      tracingStartDistanceFromCameraMeters: 0,
      sceneDistanceMeters: map.depthMeters,
    };
    const interval = cloudShellInterval(ray, shell, clip);
    if (!interval) throw new Error('Expected complete map column');
    expect(interval.entryMeters).toBeGreaterThan(350_000);
    expect(interval.exitMeters).toBeLessThan(map.depthMeters);
    expect(
      cloudShellInterval(ray, shell, { ...clip, tracingStartMaxDistanceMeters: 350_000 }),
    ).toBeUndefined();
  });
});

describe('cloud shadow paths', () => {
  it('integrates squared segments at their midpoints with independent octave exponents', () => {
    const visited: number[] = [];
    const result = cloudRayShadowTransmittance(
      100,
      4,
      (distance) => {
        visited.push(distance);
        return 0.02;
      },
      0.5,
      2,
    );
    expect(visited).toEqual([3.125, 15.625, 40.625, 78.125]);
    expect(result).toEqual([Math.exp(-2), Math.exp(-1), Math.exp(-0.25)]);
    expect(cloudMapShadowTransmittance(2, 0.5, 2)).toBe(Math.exp(-0.5));
    const polynomial = cloudRayShadowTransmittance(100, 4, (distance) => distance * 0.0004, 1, 0);
    expect(polynomial[0]).toBeCloseTo(Math.exp(-2), 12);
  });

  it('encodes nonempty mean sigma and metre front/bias independently of the full column length', () => {
    const sample = buildCloudShadowSample(
      100,
      200,
      10,
      (distance) => (distance >= 130 && distance < 170 ? [0.03, 0.06, 0] : [0, 0, 0]),
      0.5,
      2,
    );
    expect(sample.frontDepthMeters).toBe(137);
    expect(sample.meanExtinctionPerMeter).toBeCloseTo(0.015, 12);
    expect(sample.maxOpticalDepth).toBeCloseTo(0.6, 12);
    expect(cloudShadowOpticalDepth(sample, 127)).toBe(0);
    expect(cloudShadowOpticalDepth(sample, 157)).toBeCloseTo(0.3, 12);
    expect(cloudShadowOpticalDepth(sample, 1e6)).toBeCloseTo(0.6, 12);
    expect(buildCloudShadowSample(100, 200, 10, () => [0, 0, 0])).toEqual({
      frontDepthMeters: 200,
      meanExtinctionPerMeter: 0,
      maxOpticalDepth: 0,
    });
  });

  it('interpolates encoded taps before query and makes uncovered receiver policy explicit', () => {
    const tap = (frontDepthMeters: number) => ({
      frontDepthMeters,
      meanExtinctionPerMeter: 0.1,
      maxOpticalDepth: 4,
    });
    const sample = filterCloudShadowSamples([tap(0), tap(10), tap(20), tap(30)], 0.25, 0.5);
    expect(sample.frontDepthMeters).toBe(12.5);
    expect(queryCloudShadow(sample, 32.5, 'surface')).toEqual({
      covered: true,
      opticalDepth: 2,
      transmittance: Math.exp(-2),
    });
    expect(queryCloudShadow(undefined, 1, 'cloud')).toEqual({
      covered: false,
      fallback: 'secondary-ray',
    });
    expect(queryCloudShadow(undefined, 1, 'surface')).toEqual({
      covered: false,
      fallback: 'unshadowed-surface',
    });
  });

  it('rejects invalid intervals or nonfinite medium', () => {
    expect(() => cloudShadowSegment(0, 0, 100)).toThrow(RangeError);
    expect(() => cloudRayShadowTransmittance(100, 0, () => 0, 1, 0)).toThrow(RangeError);
    expect(() => buildCloudShadowSample(100, 0, 10, () => [0, 0, 0])).toThrow(RangeError);
    expect(() => buildCloudShadowSample(0, 100, 10, () => [Number.NaN, 0, 0])).toThrow(RangeError);
  });
});

describe('primary cloud light preparation', () => {
  const settings: CloudLightSettings = {
    directionToLight: [0, 2, 0],
    illuminance: [100, 90, 80],
    selfShadow: 'beer-map',
    castCloudShadows: false,
    shadowExtentMeters: 10000,
    shadowDepthBiasMeters: 0,
    shadowTracingDistanceMeters: 20000,
    shadowViewSampleCountScale: 1,
    shadowMapSampleScale: 1,
    shadowResolutionScale: 1,
    shadowStrength: 1,
    surfaceShadowStrength: 1,
    atmosphereShadowStrength: 1,
  };
  it('keeps internal map demand when external casting is off, and normalizes the actual sun', () => {
    expect(prepareCloudLight(settings)).toEqual({
      ok: true,
      settings: { ...settings, directionToLight: [0, 1, 0] },
      requiresShadowMap: true,
    });
    expect(prepareCloudLight({ ...settings, selfShadow: 'raymarch' })).toMatchObject({
      ok: true,
      requiresShadowMap: false,
    });
    expect(
      prepareCloudLight({ ...settings, selfShadow: 'raymarch', castCloudShadows: true }),
    ).toMatchObject({ ok: true, requiresShadowMap: true });
  });
  it('rejects missing or invalid sun and isolates consumer strength', () => {
    expect(prepareCloudLight(undefined)).toMatchObject({ ok: false, reason: 'missing-sun' });
    expect(prepareCloudLight({ ...settings, directionToLight: [0, 0, 0] })).toMatchObject({
      ok: false,
      field: 'directionToLight',
    });
    expect(prepareCloudLight({ ...settings, shadowExtentMeters: Number.NaN })).toMatchObject({
      ok: false,
      field: 'shadowExtentMeters',
    });
    expect(cloudConsumerShadow(0.2, 0.5)).toBeCloseTo(0.6, 12);
    expect(cloudConsumerShadow(0.2, 0)).toBe(1);
  });
});
