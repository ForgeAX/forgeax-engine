import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createExtrusionGeometry, createRevolutionGeometry, createSweepGeometry } from '../index';

function expectTriangleWinding(mesh: MeshAsset): void {
  const position = mesh.attributes.position;
  const normal = mesh.attributes.normal;
  const indices = mesh.indices;
  expect(position).toBeDefined();
  expect(normal).toBeDefined();
  expect(indices).toBeDefined();
  if (
    !(position instanceof Float32Array) ||
    !(normal instanceof Float32Array) ||
    indices === undefined
  )
    throw new Error('procedural mesh lacks position, normal, or index arrays');
  for (let i = 0; i < indices.length; i += 3) {
    const a = (indices[i] as number) * 3;
    const b = (indices[i + 1] as number) * 3;
    const c = (indices[i + 2] as number) * 3;
    const abx = (position[b] as number) - (position[a] as number);
    const aby = (position[b + 1] as number) - (position[a + 1] as number);
    const abz = (position[b + 2] as number) - (position[a + 2] as number);
    const acx = (position[c] as number) - (position[a] as number);
    const acy = (position[c + 1] as number) - (position[a + 1] as number);
    const acz = (position[c + 2] as number) - (position[a + 2] as number);
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    const dot =
      crossX * (normal[a] as number) +
      crossY * (normal[a + 1] as number) +
      crossZ * (normal[a + 2] as number);
    expect(dot).toBeGreaterThan(1e-8);
  }
}

function meshSurfaceAreaAndSignedVolume(mesh: MeshAsset): {
  readonly area: number;
  readonly signedVolume: number;
} {
  const position = mesh.attributes.position;
  const indices = mesh.indices;
  if (!(position instanceof Float32Array) || indices === undefined) {
    throw new Error('procedural mesh lacks indexed position data');
  }
  const pointAt = (offset: number): readonly [number, number, number] => [
    position[offset] as number,
    position[offset + 1] as number,
    position[offset + 2] as number,
  ];
  let area = 0;
  let signedVolume = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = pointAt((indices[offset] as number) * 3);
    const b = pointAt((indices[offset + 1] as number) * 3);
    const c = pointAt((indices[offset + 2] as number) * 3);
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acy = c[1] - a[1];
    const acz = c[2] - a[2];
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    area += Math.hypot(crossX, crossY, crossZ) / 2;
    signedVolume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return { area, signedVolume };
}

describe('reusable procedural geometry', () => {
  it('triangulates and extrudes a concave contour with normals, UVs, and bounds', () => {
    const result = createExtrusionGeometry(
      [
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: 1, y: 0 },
        { x: 0, y: -0.25 },
        { x: -1, y: 0 },
      ],
      2,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.indices?.length).toBeGreaterThan(0);
    const position = result.value.attributes.position;
    const normal = result.value.attributes.normal;
    const uv = result.value.attributes.uv;
    expect(position).toBeInstanceOf(Float32Array);
    expect(normal).toBeInstanceOf(Float32Array);
    expect(uv).toBeInstanceOf(Float32Array);
    if (
      !(position instanceof Float32Array) ||
      !(normal instanceof Float32Array) ||
      !(uv instanceof Float32Array)
    )
      return;
    expect(normal.length).toBe(position.length);
    expect(uv.length).toBe((result.value.vertices.length / 12) * 2);
    expect(Array.from(result.value.aabb ?? [])).toEqual([-1, -1, -1, 1, 0, 1]);
  });

  it('builds a curved path sweep and a surface of revolution', () => {
    const sweep = createSweepGeometry(
      [
        [0, 0, 0],
        [0, 1, 0],
        [1, 2, 0],
      ],
      0.2,
      8,
    );
    const revolution = createRevolutionGeometry(
      [
        { x: 0.5, y: -1 },
        { x: 0.75, y: 0 },
        { x: 0.5, y: 1 },
      ],
      8,
    );
    expect(sweep.ok).toBe(true);
    expect(revolution.ok).toBe(true);
    if (sweep.ok) expect(sweep.value.indices?.length).toBe(2 * 8 * 6);
    if (revolution.ok) expect(revolution.value.indices?.length).toBe(2 * 8 * 6);
  });

  it('keeps extrusion and sweep winding aligned with emitted normals', () => {
    const counterClockwise = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const clockwise = [...counterClockwise].reverse();
    for (const contour of [counterClockwise, clockwise]) {
      const extrusion = createExtrusionGeometry(contour, 1);
      expect(extrusion.ok).toBe(true);
      if (extrusion.ok) expectTriangleWinding(extrusion.value);
    }
    const sweep = createSweepGeometry(
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      1,
      8,
    );
    expect(sweep.ok).toBe(true);
    if (sweep.ok) expectTriangleWinding(sweep.value);
  });

  it('matches independent area, volume, and radial-normal expectations', () => {
    const extrusion = createExtrusionGeometry(
      [
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: 1, y: 1 },
        { x: -1, y: 1 },
      ],
      2,
    );
    expect(extrusion.ok).toBe(true);
    if (!extrusion.ok) return;
    const extrusionMetrics = meshSurfaceAreaAndSignedVolume(extrusion.value);
    // Square area * depth gives the closed volume; caps + four sides give the
    // independently derived surface area.
    expect(Math.abs(extrusionMetrics.signedVolume)).toBeCloseTo(8, 5);
    expect(extrusionMetrics.area).toBeCloseTo(24, 5);

    const segments = 8;
    const radius = 1;
    const height = 2;
    const sweep = createSweepGeometry(
      [
        [0, 0, 0],
        [0, height, 0],
      ],
      radius,
      segments,
    );
    expect(sweep.ok).toBe(true);
    if (!sweep.ok) return;
    const sweepMetrics = meshSurfaceAreaAndSignedVolume(sweep.value);
    const expectedLateralArea = 2 * segments * radius * Math.sin(Math.PI / segments) * height;
    expect(sweepMetrics.area).toBeCloseTo(expectedLateralArea, 5);
    const position = sweep.value.attributes.position;
    const normal = sweep.value.attributes.normal;
    expect(position).toBeInstanceOf(Float32Array);
    expect(normal).toBeInstanceOf(Float32Array);
    if (!(position instanceof Float32Array) || !(normal instanceof Float32Array)) return;
    for (let vertex = 0; vertex < position.length / 3; vertex += 1) {
      const x = position[vertex * 3] as number;
      const z = position[vertex * 3 + 2] as number;
      const length = Math.hypot(x, z);
      const nx = normal[vertex * 3] as number;
      const ny = normal[vertex * 3 + 1] as number;
      const nz = normal[vertex * 3 + 2] as number;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      expect(nx * (x / length) + nz * (z / length)).toBeGreaterThan(0.999);
    }

    const revolution = createRevolutionGeometry(
      [
        { x: radius, y: 0 },
        { x: radius, y: height },
      ],
      segments,
    );
    expect(revolution.ok).toBe(true);
    if (!revolution.ok) return;
    expect(meshSurfaceAreaAndSignedVolume(revolution.value).area).toBeCloseTo(
      expectedLateralArea,
      5,
    );
  });

  it('rejects malformed contours and degenerate paths before mesh creation', () => {
    const tooShort = createExtrusionGeometry(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      1,
    );
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok) {
      expect(tooShort.error.detail).toMatchObject({
        field: 'contour',
        value: 'needs at least three finite points',
        reason: 'needs at least three finite points',
      });
    }
    expect(
      createExtrusionGeometry(
        [
          { x: 0, y: 0 },
          { x: 2, y: 2 },
          { x: 0, y: 2 },
          { x: 2, y: 0 },
        ],
        1,
      ).ok,
    ).toBe(false);
    expect(
      createSweepGeometry(
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        1,
      ).ok,
    ).toBe(false);
    const closedSweep = createSweepGeometry(
      [
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [0, 0, 0],
      ],
      1,
      8,
    );
    expect(closedSweep.ok).toBe(true);
    const repeatedSweep = createSweepGeometry(
      [
        [0, 0, 0],
        [0, 1, 0],
        [0, 1, 0],
        [0, 2, 0],
      ],
      1,
      8,
    );
    expect(repeatedSweep.ok).toBe(false);
    if (!repeatedSweep.ok) {
      expect(repeatedSweep.error.detail).toMatchObject({
        field: 'path',
        value: 'must not contain repeated points',
        reason: 'must not contain repeated points',
      });
    }
    const repeatedRevolution = createRevolutionGeometry([
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ]);
    expect(repeatedRevolution.ok).toBe(false);
    if (!repeatedRevolution.ok) {
      expect(repeatedRevolution.error.detail).toMatchObject({
        field: 'profile',
        value: 'must not contain repeated points',
        reason: 'must not contain repeated points',
      });
    }
    expect(
      createRevolutionGeometry([
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ]).ok,
    ).toBe(false);
  });
});
