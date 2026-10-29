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

/** Position-welded edge census: boundary/non-manifold edge counts and orientation consistency. */
function weldedEdgeCensus(mesh: MeshAsset): {
  readonly boundary: number;
  readonly nonManifold: number;
  readonly consistentlyOriented: boolean;
} {
  const position = mesh.attributes.position;
  const indices = mesh.indices;
  if (!(position instanceof Float32Array) || indices === undefined)
    throw new Error('procedural mesh lacks indexed position data');
  const weld = new Map<string, number>();
  const id = (vertex: number): number => {
    const key = `${position[vertex * 3]},${position[vertex * 3 + 1]},${position[vertex * 3 + 2]}`;
    let value = weld.get(key);
    if (value === undefined) {
      value = weld.size;
      weld.set(key, value);
    }
    return value;
  };
  const directed = new Map<string, number>();
  const undirected = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [0, 1, 2].map((k) => id(indices[i + k] as number));
    for (let k = 0; k < 3; k++) {
      const a = tri[k] as number;
      const b = tri[(k + 1) % 3] as number;
      directed.set(`${a}>${b}`, (directed.get(`${a}>${b}`) ?? 0) + 1);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      undirected.set(key, (undirected.get(key) ?? 0) + 1);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const count of undirected.values()) {
    if (count === 1) boundary++;
    else if (count !== 2) nonManifold++;
  }
  return {
    boundary,
    nonManifold,
    consistentlyOriented: [...directed.values()].every((count) => count === 1),
  };
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
    if (sweep.ok) expect(sweep.value.indices?.length).toBe(2 * 8 * 6 + 2 * 8 * 3);
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
    // Default caps close the prism: two regular-polygon areas and an enclosed volume.
    const capArea = (segments / 2) * radius * radius * Math.sin((2 * Math.PI) / segments);
    expect(sweepMetrics.area).toBeCloseTo(expectedLateralArea + 2 * capArea, 5);
    expect(sweepMetrics.signedVolume).toBeCloseTo(capArea * height, 5);
    const position = sweep.value.attributes.position;
    const normal = sweep.value.attributes.normal;
    expect(position).toBeInstanceOf(Float32Array);
    expect(normal).toBeInstanceOf(Float32Array);
    if (!(position instanceof Float32Array) || !(normal instanceof Float32Array)) return;
    for (let vertex = 0; vertex < position.length / 3; vertex += 1) {
      if (Math.abs(Math.abs(normal[vertex * 3 + 1] as number) - 1) < 1e-6) continue; // cap
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

  it('caps open circular sweeps into a watertight, outward-oriented solid', () => {
    const path: [number, number, number][] = [
      [0, 0, 0],
      [0.3, 0.5, 0],
      [0, 1, 0.2],
      [-0.3, 1.3, 0],
    ];
    const capped = createSweepGeometry(path, 0.12, 12);
    const open = createSweepGeometry(path, 0.12, 12, { capped: false });
    expect(capped.ok && open.ok).toBe(true);
    if (!capped.ok || !open.ok) return;
    expect(weldedEdgeCensus(capped.value)).toEqual({
      boundary: 0,
      nonManifold: 0,
      consistentlyOriented: true,
    });
    expect(weldedEdgeCensus(open.value).boundary).toBe(2 * 12);
    expect(open.value.indices?.length).toBe(3 * 12 * 6);
    expect(capped.value.indices?.length).toBe(3 * 12 * 6 + 2 * 12 * 3);
    expectTriangleWinding(capped.value);
    expect(meshSurfaceAreaAndSignedVolume(capped.value).signedVolume).toBeGreaterThan(0);

    const { position, normal, uv, tangent } = capped.value.attributes;
    if (
      !(position instanceof Float32Array) ||
      !(normal instanceof Float32Array) ||
      !(uv instanceof Float32Array) ||
      !(tangent instanceof Float32Array)
    )
      throw new Error('capped sweep lacks canonical attributes');
    type V3 = readonly [number, number, number];
    const at = (array: Float32Array, offset: number): V3 => [
      array[offset] as number,
      array[offset + 1] as number,
      array[offset + 2] as number,
    ];
    const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const unitDelta = (from: V3, to: V3): V3 => {
      const d: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const length = Math.hypot(...d);
      return [d[0] / length, d[1] / length, d[2] / length];
    };
    const startOut = unitDelta(path[1] as V3, path[0] as V3);
    const endOut = unitDelta(path[2] as V3, path[3] as V3);
    let startCap = 0;
    let endCap = 0;
    for (let v = 0; v < position.length / 3; v++) {
      const n = at(normal, v * 3);
      const t = at(tangent, v * 4);
      expect(Math.hypot(...n)).toBeCloseTo(1, 5);
      expect(Math.hypot(...t)).toBeCloseTo(1, 4);
      expect(Math.abs(dot(n, t))).toBeLessThan(1e-4);
      expect(Math.abs(tangent[v * 4 + 3] as number)).toBe(1);
      const u = uv[v * 2] as number;
      const w = uv[v * 2 + 1] as number;
      expect(u >= 0 && u <= 1 && w >= 0 && w <= 1).toBe(true);
      if (dot(n, startOut) > 1 - 1e-5) startCap++;
      if (dot(n, endOut) > 1 - 1e-5) endCap++;
    }
    // Each cap: one centre plus a duplicated ring (segments + 1 including the seam).
    expect(startCap).toBe(12 + 2);
    expect(endCap).toBe(12 + 2);
  });

  it('omits caps on a closed sweep path', () => {
    const loop: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 0],
    ];
    const closed = createSweepGeometry(loop, 0.1, 8);
    const explicit = createSweepGeometry(loop, 0.1, 8, { capped: true });
    expect(closed.ok && explicit.ok).toBe(true);
    if (!closed.ok || !explicit.ok) return;
    expect(closed.value.indices?.length).toBe(3 * 8 * 6);
    expect(explicit.value.indices?.length).toBe(3 * 8 * 6);
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
