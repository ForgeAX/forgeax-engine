import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../../geom';
import { EDGE_SHARP, EditMesh } from '../../mesh';
import {
  constraintSegments,
  dihedralOf,
  type FeatureConstraint,
  featureDeviation,
  featureDeviationForTest,
  pointLineDistance,
} from '../features';
import { type QuadRemeshOptions, quadRemesh } from '../remesh';

/** Closed unit box, 12 triangles; every edge is a 90 degree crease, flagged sharp. */
function box(): EditMesh {
  const m = new EditMesh();
  const v = [
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [0.5, 0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
  ].map(([x, y, z]) => m.addVertex(x as number, y as number, z as number));
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
  ];
  for (const q of quads) {
    const [a, b, c, d] = q.map((i) => v[i] as number) as [number, number, number, number];
    tri(m, a, b, c);
    tri(m, a, c, d);
  }
  for (const e of m.edges()) if (dihedralOf(m, e) > 0.5) m.eFlags[e] = EDGE_SHARP;
  return m;
}

function tri(m: EditMesh, a: number, b: number, c: number, material = 0): number {
  const r = m.addFace([a, b, c], material);
  if (!r.ok) throw new Error(`addFace failed: ${r.error.code}`);
  return r.value;
}

/**
 * Two triangles a-b-c and a-c-d sharing the diagonal a-c. b and d lift by h on the same side, so the two triangle
 * normals differ by `degrees`: tan(degrees/2) = sqrt(2) h. Pairing merges the two triangles across a-c unless the
 * fold is steeper than the planarity gate allows (about 4 degrees under the default options).
 */
function bentSquare(degrees: number): {
  mesh: EditMesh;
  diagonal: FeatureConstraint['polyline'];
} {
  const m = new EditMesh();
  const h = Math.tan((degrees * Math.PI) / 360) * Math.SQRT1_2;
  const a = m.addVertex(0, 0, 0);
  const b = m.addVertex(1, 0, h);
  const c = m.addVertex(1, 1, 0);
  const d = m.addVertex(0, 1, h);
  tri(m, a, b, c);
  tri(m, a, c, d);
  return {
    mesh: m,
    diagonal: [
      [0, 0, 0],
      [1, 1, 0],
    ],
  };
}

/**
 * Flat 2x1 strip of four coplanar triangles: squares [0,1,4,3] and [1,2,5,4], each split along its diagonal.
 * Triangle t3 = [1,2,5] carries `material3`. The triangle [1,5,4] also shares edge 1-4 with [0,1,4], so the
 * greedy pass has a higher-scoring competing pair that must not reuse a triangle.
 */
function strip(material3 = 0): { m: EditMesh; t3: number } {
  const m = new EditMesh();
  const v = [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ].map(([x, y]) => m.addVertex(x as number, y as number, 0));
  const at = (i: number) => v[i] as number;
  tri(m, at(0), at(1), at(4));
  tri(m, at(0), at(4), at(3));
  const t3 = tri(m, at(1), at(2), at(5), material3);
  tri(m, at(1), at(5), at(4));
  return { m, t3 };
}

function quadStrip(cells: number, cellSize = 1): EditMesh {
  const m = new EditMesh();
  const bottom = Array.from({ length: cells + 1 }, (_, i) => m.addVertex(i * cellSize, 0, 0));
  const top = Array.from({ length: cells + 1 }, (_, i) => m.addVertex(i * cellSize, cellSize, 0));
  for (let i = 0; i < cells; i++) {
    const face = m.addFace([
      bottom[i] as number,
      bottom[i + 1] as number,
      top[i + 1] as number,
      top[i] as number,
    ]);
    expect(face.ok).toBe(true);
  }
  return m;
}

function triangleChainCloud(triangles: number): EditMesh {
  const mesh = new EditMesh();
  for (let index = 0; index < triangles; index++) {
    const x = index;
    addTriangleAt(mesh, [x, 0, 0], [x + 1, 0, 0], [x, 1, 0]);
  }
  return mesh;
}

function triangleEdgeCloud(triangles: number): EditMesh {
  const m = new EditMesh();
  for (let i = 0; i < triangles; i++) {
    const x = i * 2;
    const face = m.addFace([m.addVertex(x, 0, 0), m.addVertex(x + 1, 0, 0), m.addVertex(x, 1, 0)]);
    expect(face.ok).toBe(true);
  }
  return m;
}

function diagonalFeatureMesh(scale: number): EditMesh {
  const mesh = new EditMesh();
  const a = mesh.addVertex(0, 0, 0);
  const b = mesh.addVertex(scale, scale, 0);
  const c = mesh.addVertex(scale / 2, scale / 2, -scale * 10);
  tri(mesh, a, b, c);
  return mesh;
}

function ordinaryOracleFeatureMesh(scale: number): EditMesh {
  const mesh = new EditMesh();
  const a = mesh.addVertex(0, 0, 0);
  const b = mesh.addVertex(scale, 0, 0);
  const c = mesh.addVertex(scale / 2, scale / 2, 0);
  tri(mesh, a, b, c);
  return mesh;
}

function addTriangleAt(
  mesh: EditMesh,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): void {
  tri(mesh, mesh.addVertex(...a), mesh.addVertex(...b), mesh.addVertex(...c));
}

function mixedExtentFeatureMesh(tinyFirst: boolean): EditMesh {
  const mesh = new EditMesh();
  const addTiny = () => addTriangleAt(mesh, [0, 0, 0], [1e-300, 0, 0], [0, 1e-300, 0]);
  const base = 1e300;
  const step = Number.EPSILON * base * 8;
  const addHuge = () =>
    addTriangleAt(mesh, [base, base, base], [base + step, base, base], [base, base + step, base]);
  if (tinyFirst) {
    addTiny();
    addHuge();
  } else {
    addHuge();
    addTiny();
  }
  return mesh;
}

const oracleBits = new DataView(new ArrayBuffer(8));

function exactUnits(value: number): bigint {
  oracleBits.setFloat64(0, value, false);
  const high = oracleBits.getUint32(0, false);
  const low = oracleBits.getUint32(4, false);
  const exponent = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0x000f_ffff) << 32n) | BigInt(low);
  const significand = exponent === 0 ? fraction : (1n << 52n) | fraction;
  const shift = exponent === 0 ? 0 : exponent - 1;
  const magnitude = significand << BigInt(shift);
  return (high & 0x8000_0000) === 0 ? magnitude : -magnitude;
}

function exactLineDistanceWithin(
  point: readonly number[],
  origin: readonly number[],
  direction: readonly number[],
  tolerance: number,
): boolean {
  const offset = point.map(
    (value, axis) => exactUnits(value as number) - exactUnits(origin[axis] as number),
  );
  const d = direction.map(exactUnits);
  const cross = [
    (offset[1] as bigint) * (d[2] as bigint) - (offset[2] as bigint) * (d[1] as bigint),
    (offset[2] as bigint) * (d[0] as bigint) - (offset[0] as bigint) * (d[2] as bigint),
    (offset[0] as bigint) * (d[1] as bigint) - (offset[1] as bigint) * (d[0] as bigint),
  ];
  const crossSquared = cross.reduce((sum, value) => sum + value * value, 0n);
  const directionSquared = d.reduce((sum, value) => sum + value * value, 0n);
  const toleranceUnits = exactUnits(tolerance);
  if (directionSquared === 0n) {
    const offsetSquared = offset.reduce((sum, value) => sum + value * value, 0n);
    return offsetSquared <= toleranceUnits * toleranceUnits;
  }
  return crossSquared <= toleranceUnits * toleranceUnits * directionSquared;
}

function exactPointSegmentWithin(
  point: readonly number[],
  a: readonly number[],
  b: readonly number[],
  tolerance: number,
): boolean {
  const offset = point.map(
    (value, axis) => exactUnits(value as number) - exactUnits(a[axis] as number),
  );
  const direction = b.map(
    (value, axis) => exactUnits(value as number) - exactUnits(a[axis] as number),
  );
  const directionSquared = direction.reduce((sum, value) => sum + value * value, 0n);
  const projection = offset.reduce(
    (sum, value, axis) => sum + value * (direction[axis] as bigint),
    0n,
  );
  const toleranceUnits = exactUnits(tolerance);
  if (directionSquared === 0n || projection <= 0n) {
    const distanceSquared = offset.reduce((sum, value) => sum + value * value, 0n);
    return distanceSquared <= toleranceUnits * toleranceUnits;
  }
  if (projection >= directionSquared) {
    const endOffset = point.map(
      (value, axis) => exactUnits(value as number) - exactUnits(b[axis] as number),
    );
    const distanceSquared = endOffset.reduce((sum, value) => sum + value * value, 0n);
    return distanceSquared <= toleranceUnits * toleranceUnits;
  }
  const cross = [
    (offset[1] as bigint) * (direction[2] as bigint) -
      (offset[2] as bigint) * (direction[1] as bigint),
    (offset[2] as bigint) * (direction[0] as bigint) -
      (offset[0] as bigint) * (direction[2] as bigint),
    (offset[0] as bigint) * (direction[1] as bigint) -
      (offset[1] as bigint) * (direction[0] as bigint),
  ];
  const crossSquared = cross.reduce((sum, value) => sum + value * value, 0n);
  return crossSquared <= toleranceUnits * toleranceUnits * directionSquared;
}

function exactPointSegmentWithinRational(
  point: readonly bigint[],
  denominator: bigint,
  a: readonly number[],
  b: readonly number[],
  toleranceUnits: bigint,
): boolean {
  const edgeA = a.map(exactUnits);
  const direction = b.map((value, axis) => exactUnits(value) - (edgeA[axis] as bigint));
  const offset = point.map((value, axis) => value - (edgeA[axis] as bigint) * denominator);
  const lengthSquared = direction.reduce((sum, value) => sum + value * value, 0n);
  const toleranceSquared = toleranceUnits * toleranceUnits * denominator * denominator;
  const projection = offset.reduce(
    (sum, value, axis) => sum + value * (direction[axis] as bigint),
    0n,
  );
  if (lengthSquared === 0n || projection <= 0n)
    return offset.reduce((sum, value) => sum + value * value, 0n) <= toleranceSquared;
  if (projection >= denominator * lengthSquared) {
    const endOffset = point.map(
      (value, axis) => value - exactUnits(b[axis] as number) * denominator,
    );
    return endOffset.reduce((sum, value) => sum + value * value, 0n) <= toleranceSquared;
  }
  const cross = [
    (offset[1] as bigint) * (direction[2] as bigint) -
      (offset[2] as bigint) * (direction[1] as bigint),
    (offset[2] as bigint) * (direction[0] as bigint) -
      (offset[0] as bigint) * (direction[2] as bigint),
    (offset[0] as bigint) * (direction[1] as bigint) -
      (offset[1] as bigint) * (direction[0] as bigint),
  ];
  return cross.reduce((sum, value) => sum + value * value, 0n) <= toleranceSquared * lengthSquared;
}

function oracleCeilSqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let estimate = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate * estimate === value ? estimate : estimate + 1n;
    estimate = next;
  }
}

export function exactFeatureOracle(
  featureA: [number, number, number],
  featureB: [number, number, number],
  mesh: EditMesh,
  tolerance: number,
): 'inside' | 'outside' | 'uncertain' {
  const start = featureA.map(exactUnits);
  const end = featureB.map(exactUnits);
  const direction = end.map((value, axis) => value - (start[axis] as bigint));
  const lengthSquared = direction.reduce((sum, value) => sum + value * value, 0n);
  const toleranceUnits = exactUnits(tolerance);
  const edges = [...mesh.edges()].map((edge) => {
    const [va, vb] = mesh.edgeVertices(edge);
    return [mesh.position(va), mesh.position(vb)] as const;
  });
  let depth = 0;
  while (depth < 15 && lengthSquared > (toleranceUnits << BigInt(depth)) ** 2n) depth++;
  for (; depth <= 10; depth++) {
    const count = 1 << depth;
    const denominator = BigInt(count * 2);
    const radiusLoss = oracleCeilSqrt(lengthSquared);
    const guaranteedRadius = toleranceUnits * denominator - radiusLoss;
    let allSamples = true;
    for (let sample = 0; sample < count; sample++) {
      const numerator = BigInt(sample * 2 + 1);
      const point = start.map(
        (value, axis) => value * (denominator - numerator) + (end[axis] as bigint) * numerator,
      );
      const withinTolerance = edges.some(([a, b]) =>
        exactPointSegmentWithinRational(point, denominator, a, b, toleranceUnits),
      );
      if (!withinTolerance) return 'outside';
      if (
        guaranteedRadius < 0n ||
        !edges.some(([a, b]) =>
          exactPointSegmentWithinRational(point, denominator, a, b, guaranteedRadius),
        )
      )
        allSamples = false;
    }
    if (allSamples && guaranteedRadius >= 0n) return 'inside';
  }
  return 'uncertain';
}

function exactFeatureCovered(
  featureA: [number, number, number],
  featureB: [number, number, number],
  mesh: EditMesh,
  tolerance: number,
): boolean {
  const direction = featureB.map(
    (value, axis) => exactUnits(value) - exactUnits(featureA[axis] as number),
  );
  const lengthSquared = direction.reduce((sum, value) => sum + value * value, 0n);
  if (lengthSquared === 0n)
    return mesh.edges().some((edge) => {
      const [va, vb] = mesh.edgeVertices(edge);
      return exactPointSegmentWithin(featureA, mesh.position(va), mesh.position(vb), tolerance);
    });
  const toleranceUnits = exactUnits(tolerance);
  let depth = 0;
  while (depth < 8) {
    const reach = toleranceUnits << BigInt(depth);
    if (lengthSquared <= reach * reach) break;
    depth++;
  }
  const reach = toleranceUnits << BigInt(depth);
  if (lengthSquared > reach * reach) return false;
  const sampleCount = 1 << depth;
  for (let index = 0; index < sampleCount; index++) {
    const denominator = BigInt(sampleCount * 2);
    const numerator = BigInt(index * 2 + 1);
    const point = featureA.map(
      (value, axis) =>
        exactUnits(value) * (denominator - numerator) +
        exactUnits(featureB[axis] as number) * numerator,
    ) as [bigint, bigint, bigint];
    const covered = mesh.edges().some((edge) => {
      const [va, vb] = mesh.edgeVertices(edge);
      const a = mesh.position(va);
      const b = mesh.position(vb);
      const edgeDirection = b.map(
        (value, axis) => exactUnits(value) - exactUnits(a[axis] as number),
      );
      const offset = point.map(
        (value, axis) => value - exactUnits(a[axis] as number) * denominator,
      );
      const edgeLengthSquared = edgeDirection.reduce((sum, value) => sum + value * value, 0n);
      const projection = offset.reduce(
        (sum, value, axis) => sum + value * (edgeDirection[axis] as bigint),
        0n,
      );
      const scaledTolerance = toleranceUnits * denominator;
      if (edgeLengthSquared === 0n || projection <= 0n) {
        const squared = offset.reduce((sum, value) => sum + value * value, 0n);
        return squared <= scaledTolerance * scaledTolerance;
      }
      if (projection >= denominator * edgeLengthSquared) {
        const endOffset = point.map(
          (value, axis) => value - exactUnits(b[axis] as number) * denominator,
        );
        const squared = endOffset.reduce((sum, value) => sum + value * value, 0n);
        return squared <= scaledTolerance * scaledTolerance;
      }
      const cross = [
        (offset[1] as bigint) * (edgeDirection[2] as bigint) -
          (offset[2] as bigint) * (edgeDirection[1] as bigint),
        (offset[2] as bigint) * (edgeDirection[0] as bigint) -
          (offset[0] as bigint) * (edgeDirection[2] as bigint),
        (offset[0] as bigint) * (edgeDirection[1] as bigint) -
          (offset[1] as bigint) * (edgeDirection[0] as bigint),
      ];
      const crossSquared = cross.reduce((sum, value) => sum + value * value, 0n);
      return crossSquared <= scaledTolerance * scaledTolerance * edgeLengthSquared;
    });
    if (!covered) return false;
  }
  return true;
}

function nextUp(value: number): number {
  if (value === Infinity || value === 0) return value === 0 ? Number.MIN_VALUE : value;
  oracleBits.setFloat64(0, value, false);
  let bits = oracleBits.getBigUint64(0, false);
  bits += value > 0 ? 1n : -1n;
  oracleBits.setBigUint64(0, bits, false);
  return oracleBits.getFloat64(0, false);
}

function longEdgeAuditMesh(): EditMesh {
  const mesh = new EditMesh();
  addTriangleAt(mesh, [-1e300, 0.9e-300, 0.9e-300], [1e300, 0.9e-300, 0.9e-300], [0, 1e300, 0]);
  return mesh;
}

function roundSevenFeatureMesh(): EditMesh {
  const q: [number, number, number] = [
    7.863598691299558, 8.684780078002041e-11, 0.00001694051559329216,
  ];
  const q2 = q.reduce((sum, value) => sum + value * value, 0);
  const direction: [number, number, number] = [
    1 - (q[0] * q[0]) / q2,
    (-q[0] * q[1]) / q2,
    (-q[0] * q[2]) / q2,
  ];
  const directionLength = Math.sqrt(direction.reduce((sum, value) => sum + value * value, 0));
  for (let axis = 0; axis < 3; axis++)
    direction[axis] = (direction[axis] as number) / directionLength;
  const normal: [number, number, number] = [
    q[1] * (direction[2] as number) - q[2] * (direction[1] as number),
    q[2] * (direction[0] as number) - q[0] * (direction[2] as number),
    q[0] * (direction[1] as number) - q[1] * (direction[0] as number),
  ];
  const normalLength = Math.sqrt(normal.reduce((sum, value) => sum + value * value, 0));
  for (let axis = 0; axis < 3; axis++) normal[axis] = (normal[axis] as number) / normalLength;
  const a = q.map((value, axis) => value - 0.001 * (direction[axis] as number)) as [
    number,
    number,
    number,
  ];
  const b = q.map((value, axis) => value + 0.001 * (direction[axis] as number)) as [
    number,
    number,
    number,
  ];
  const c = q.map((value, axis) => value + 0.01 * (normal[axis] as number)) as [
    number,
    number,
    number,
  ];
  const mesh = new EditMesh();
  addTriangleAt(mesh, a, b, c);
  return mesh;
}

function run(m: EditMesh, options: QuadRemeshOptions = {}) {
  const r = quadRemesh(m, m.faces(), options);
  if (!r.ok) throw new Error(`quadRemesh failed: ${r.error.code}`);
  return r.value;
}

const quadCount = (provenance: readonly { readonly kind: string }[]) =>
  provenance.filter((p) => p.kind === 'quad').length;

/** Max distance from the diagonal's sampled points to the nearest output edge, measured by the solver itself. */
const dev = (m: EditMesh, polyline: FeatureConstraint['polyline'], id: string) => {
  const r = quadRemesh(m, m.faces(), {
    constraints: [{ id, polyline, tolerance: 1e-3 }],
  });
  return r.ok ? r.value.report.featureDeviation.byConstraint[id] : undefined;
};

describe('quadRemesh feature preservation', () => {
  it('keeps every sharp box edge as an output edge', () => {
    const m = box();
    const value = run(m);
    expect(value.report.unresolvedFeatures).toEqual([]);
    expect(value.report.quality.boundaryEdges).toBe(0);
    // The six square faces pair across their coplanar diagonals (not sharp); the 12 cube edges stay edges.
    expect(quadCount(value.provenance)).toBe(6);
    expect(value.mesh.faceCount).toBe(6);
    // A cube surface has 8 corners of valence 3 and no other non-4-valent vertex; each unit square has scaled Jacobian 1.
    expect(value.report.quality.interiorNon4Valence).toBe(8);
    expect(value.report.quality.scaledJacobian.min).toBeCloseTo(1, 9);
    expect(value.report.quality.scaledJacobian.mean).toBeCloseTo(1, 9);
  });

  it('keeps the crease within tolerance when the constraint names it', () => {
    for (const degrees of [1, 2, 3]) {
      const { mesh, diagonal } = bentSquare(degrees);
      const d = dev(mesh, diagonal, 'crease');
      expect(d).toBeCloseTo(0, 9);
    }
  });

  it('rejects a feature gap between the former nine verification samples', () => {
    const mesh = new EditMesh();
    for (let i = 0; i <= 8; i++) {
      const x = i / 8;
      const a = mesh.addVertex(x, 0, -0.1);
      const b = mesh.addVertex(x, 0, 0.1);
      const c = mesh.addVertex(x + 0.001, 0.2, 0);
      const face = mesh.addFace([a, b, c]);
      expect(face.ok).toBe(true);
    }
    const polyline: FeatureConstraint['polyline'] = [
      [0, 0, 0],
      [1, 0, 0],
    ];
    const unconstrained = quadRemesh(mesh, mesh.faces());
    expect(unconstrained.ok).toBe(true);
    if (!unconstrained.ok) return;
    const sample = [1 / 16, 0, 0] as const;
    const independentDistance = Math.min(
      ...unconstrained.value.mesh.edges().map((e) => {
        const [a, b] = unconstrained.value.mesh.edgeVertices(e);
        const pa = unconstrained.value.mesh.position(a);
        const pb = unconstrained.value.mesh.position(b);
        const ab: [number, number, number] = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        const ap: [number, number, number] = [
          sample[0] - pa[0],
          sample[1] - pa[1],
          sample[2] - pa[2],
        ];
        const lengthSquared = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
        const t =
          lengthSquared > 0
            ? Math.max(
                0,
                Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / lengthSquared),
              )
            : 0;
        return Math.sqrt(
          (ap[0] - ab[0] * t) * (ap[0] - ab[0] * t) +
            (ap[1] - ab[1] * t) * (ap[1] - ab[1] * t) +
            (ap[2] - ab[2] * t) * (ap[2] - ab[2] * t),
        );
      }),
    );
    expect(independentDistance).toBeGreaterThan(0.01);

    const constrained = quadRemesh(mesh, mesh.faces(), {
      constraints: [{ id: 'line', polyline, tolerance: 0.01 }],
    });
    expect(constrained.ok).toBe(false);
    if (!constrained.ok) expect(constrained.error.code).toBe('model-partial');
  });

  it('measures negative and beyond-end projections to the infinite line', () => {
    expect(pointLineDistance([-1, 1, 0], [0, 0, 0], [1, 0, 0])).toBe(1);
    expect(pointLineDistance([3, 1, 0], [0, 0, 0], [1, 0, 0])).toBe(1);
    expect(pointLineDistance([-1, 0, 0], [0, 0, 0], [0, 0, 0])).toBe(1);
  });

  it('matches brute-force feature verdicts over the seeded ordinary-scale corpus', () => {
    let state = 0x50504;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let sample = 0; sample < 800; sample++) {
      const mesh = triangleEdgeCloud(4);
      const a: [number, number, number] = [random() * 12 - 2, random() * 4 - 2, 0.25];
      const b: [number, number, number] = [a[0] + 0.05 + random() * 2, random() * 4 - 2, 0.25];
      const tolerance = 0.05 + random() * 0.6;
      const deviation = featureDeviation(mesh, [{ id: 'oracle', segments: [[a, b]], tolerance }]);
      let reference = 0;
      for (let step = 0; step <= 4096; step++) {
        const t = step / 4096;
        const point: [number, number, number] = [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ];
        let nearest = Infinity;
        for (const edge of mesh.edges()) {
          const [va, vb] = mesh.edgeVertices(edge);
          const start = mesh.position(va);
          const end = mesh.position(vb);
          const direction: Tuple3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
          const offset: Tuple3 = [point[0] - start[0], point[1] - start[1], point[2] - start[2]];
          const len2 =
            direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2];
          const projection =
            len2 === 0
              ? 0
              : Math.max(
                  0,
                  Math.min(
                    1,
                    (offset[0] * direction[0] +
                      offset[1] * direction[1] +
                      offset[2] * direction[2]) /
                      len2,
                  ),
                );
          const dx = offset[0] - projection * direction[0];
          const dy = offset[1] - projection * direction[1];
          const dz = offset[2] - projection * direction[2];
          nearest = Math.min(nearest, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        reference = Math.max(reference, nearest);
      }
      const oracleWithin = exactFeatureCovered(a, b, mesh, tolerance);
      if (deviation.unresolved.includes('oracle') && oracleWithin) continue;
      expect(deviation.unresolved.includes('oracle')).toBe(!oracleWithin);
    }
  });

  it('returns finite distances across subnormal and huge magnitudes', () => {
    expect(pointLineDistance([0, Number.MIN_VALUE * 8, 0], [0, 0, 0], [1e-300, 0, 0])).toBe(
      Number.MIN_VALUE * 8,
    );
    expect(pointLineDistance([0, 1e300, 0], [0, 0, 0], [1e300, 0, 0])).toBe(1e300);
  });

  it('certifies clearly-inside tiny ordinary features and fails closed below the range', () => {
    for (const scale of [1e-28, 1e-20, 1e-300, 1e-150]) {
      const start: [number, number, number] = [scale / 4, scale / 4, scale];
      const end: [number, number, number] = [scale / 2, scale / 2, scale];
      const tolerance = scale * 1.1;
      expect(exactLineDistanceWithin(start, [0, 0, 0], [scale, scale, 0], tolerance)).toBe(true);
      const deviation = featureDeviation(diagonalFeatureMesh(scale), [
        { id: 'tiny-boundary', segments: [[start, end]], tolerance },
      ]);
      expect(deviation.unresolved).toEqual(scale < 1e-100 ? ['tiny-boundary'] : []);
    }
  });

  it('leaves the audit-505i q=7.86 endpoint repro unresolved through both verifier paths', () => {
    const mesh = roundSevenFeatureMesh();
    const feature: [number, number, number] = [0, 0, 0];
    const end: [number, number, number] = [7.420734811503774e-13, 0, 0];
    const tolerance = 7.8635986913178035;
    for (const edge of mesh.edges()) {
      const [va, vb] = mesh.edgeVertices(edge);
      expect(
        exactPointSegmentWithin(feature, mesh.position(va), mesh.position(vb), tolerance),
      ).toBe(false);
    }
    const deviation = featureDeviation(mesh, [
      { id: 'round-seven', segments: [[feature, end]], tolerance },
    ]);
    expect(deviation.unresolved).toEqual(['round-seven']);
    const result = quadRemesh(mesh, mesh.faces(), {
      constraints: [{ id: 'round-seven', polyline: [feature, end], tolerance }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('model-partial');
      expect(result.error.detail?.unresolvedFeatures).toEqual(['round-seven']);
    }
  });

  it('rejects the long-edge interpolation false certification', () => {
    const mesh = longEdgeAuditMesh();
    const feature: [number, number, number] = [0, 0, 0];
    const tolerance = 1e-300;
    for (const edge of mesh.edges()) {
      const [va, vb] = mesh.edgeVertices(edge);
      expect(
        exactPointSegmentWithin(feature, mesh.position(va), mesh.position(vb), tolerance),
      ).toBe(false);
    }
    const groups = [
      {
        id: 'long-edge-off-mesh',
        segments: [[feature, [1e-300, 0, 0]] as [Tuple3, Tuple3]],
        tolerance,
      },
    ];
    const deviation = featureDeviation(mesh, groups);
    expect(deviation.unresolved).toEqual(['long-edge-off-mesh']);
    const result = quadRemesh(mesh, mesh.faces(), {
      constraints: [
        {
          id: 'long-edge-off-mesh',
          polyline: [feature, [1e-300, 0, 0]],
          tolerance,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.unresolvedFeatures).toEqual(['long-edge-off-mesh']);
  });

  it('leaves the audit-505h long-edge clipping repro unresolved through both verifier paths', () => {
    const mesh = new EditMesh();
    addTriangleAt(mesh, [-1e300, 0.9e-300, 0.9e-300], [1e300, 0.9e-300, 0.9e-300], [0, 1e300, 0]);
    const feature: [number, number, number] = [0, 0, 0];
    const end: [number, number, number] = [1e-300, 0, 0];
    const tolerance = 1e-300;
    for (const edge of mesh.edges()) {
      const [va, vb] = mesh.edgeVertices(edge);
      expect(
        exactPointSegmentWithin(feature, mesh.position(va), mesh.position(vb), tolerance),
      ).toBe(false);
    }
    const deviation = featureDeviation(mesh, [
      { id: 'clipping', segments: [[feature, end]], tolerance },
    ]);
    expect(deviation.unresolved).toEqual(['clipping']);
    const result = quadRemesh(mesh, mesh.faces(), {
      constraints: [{ id: 'clipping', polyline: [feature, end], tolerance }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('model-partial');
      expect(result.error.detail?.unresolvedFeatures).toEqual(['clipping']);
    }
  });

  it('rejects the near-tolerance zero-length long-edge false certification', () => {
    const mesh = new EditMesh();
    const tolerance = 1e-300;
    const y0 = -1000 * tolerance;
    const y1 = nextUp(1002 * tolerance);
    addTriangleAt(mesh, [-1e300, y0, 0], [1e300, y1, 0], [0, 0, 1e300]);
    const feature: [number, number, number] = [0, 0, 0];
    for (const edge of mesh.edges()) {
      const [va, vb] = mesh.edgeVertices(edge);
      expect(
        exactPointSegmentWithin(feature, mesh.position(va), mesh.position(vb), tolerance),
      ).toBe(false);
    }
    const deviation = featureDeviation(mesh, [
      { id: 'zero-long-edge', segments: [[feature, feature]], tolerance },
    ]);
    expect(deviation.unresolved).toEqual(['zero-long-edge']);
    const result = quadRemesh(mesh, mesh.faces(), {
      constraints: [{ id: 'zero-long-edge', polyline: [feature], tolerance }],
    });
    expect(result.ok).toBe(false);
  });

  it('does not let a remote long ordinary edge poison an independent valid edge', () => {
    const mesh = new EditMesh();
    const tolerance = 1e-3;
    addTriangleAt(
      mesh,
      [-1e25, tolerance * 0.9, tolerance * 0.9],
      [1e25, tolerance * 0.9, tolerance * 0.9],
      [0, 1e25, 0],
    );
    addTriangleAt(
      mesh,
      [0, tolerance * 0.1, 0],
      [tolerance, tolerance * 0.1, 0],
      [0, tolerance, 0],
    );
    const feature: [number, number, number][] = [
      [0, 0, 0],
      [tolerance, 0, 0],
    ];
    const deviation = featureDeviation(mesh, [
      {
        id: 'independent-valid-edge',
        segments: [[feature[0] as Tuple3, feature[1] as Tuple3]],
        tolerance,
      },
    ]);
    expect(deviation.unresolved).toEqual([]);
    expect(deviation.byConstraint['independent-valid-edge']).toBeLessThanOrEqual(tolerance);
  });

  it('leaves an exactly coincident huge edge at subnormal tolerance unresolved', () => {
    const mesh = new EditMesh();
    addTriangleAt(mesh, [0, 0, 0], [1e300, 0, 0], [0, 1e300, 0]);
    const constraint = {
      id: 'huge-exact-subnormal',
      polyline: [
        [0, 0, 0],
        [1e300, 0, 0],
      ] as [Tuple3, Tuple3],
      tolerance: 1e-320,
    };
    const deviation = featureDeviation(mesh, [
      {
        id: constraint.id,
        segments: [[constraint.polyline[0], constraint.polyline[1]]],
        tolerance: constraint.tolerance,
      },
    ]);
    expect(deviation.unresolved).toEqual([constraint.id]);
    expect(deviation.byConstraint[constraint.id]).toBe(Infinity);
    const result = quadRemesh(mesh, mesh.faces(), {
      constraints: [constraint],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('model-partial');
  });

  it('leaves remote extreme-scale geometry unresolved in both insertion orders', () => {
    for (const tinyFirst of [true, false]) {
      const deviation = featureDeviation(mixedExtentFeatureMesh(tinyFirst), [
        {
          id: 'tiny-local',
          segments: [
            [
              [0, 0, 0],
              [1e-300, 0, 0],
            ],
          ],
          tolerance: 1e-310,
        },
      ]);
      expect(deviation.unresolved).toEqual(['tiny-local']);
      expect(deviation.byConstraint['tiny-local']).toBe(Infinity);
    }
  });

  it('leaves a huge feature beside remote subnormal geometry unresolved', () => {
    const mesh = new EditMesh();
    const base = 1e300;
    const step = Number.EPSILON * base * 8;
    addTriangleAt(mesh, [base, base, base], [base + step, base, base], [base, base + step, base]);
    addTriangleAt(
      mesh,
      [Number.MIN_VALUE, 0, 0],
      [Number.MIN_VALUE * 2, 0, 0],
      [Number.MIN_VALUE, Number.MIN_VALUE, 0],
    );
    const deviation = featureDeviation(mesh, [
      {
        id: 'huge-local',
        segments: [
          [
            [base, base, base],
            [base + step, base, base],
          ],
        ],
        tolerance: step * 0.1,
      },
    ]);
    expect(deviation.unresolved).toEqual(['huge-local']);
  });

  it('leaves a translated local edge beyond the ordinary range unresolved', () => {
    const mesh = new EditMesh();
    const base = 1e300;
    const step = Number.EPSILON * base * 8;
    addTriangleAt(mesh, [base, base, base], [base + step, base, base], [base, base + step, base]);
    const deviation = featureDeviation(mesh, [
      {
        id: 'translated-local',
        segments: [
          [
            [base, base + step, base],
            [base + step, base + step, base],
          ],
        ],
        tolerance: step * 1.1,
      },
    ]);
    expect(deviation.unresolved).toEqual(['translated-local']);
  });

  it('leaves a coincident edge chain unresolved when normalized tolerance underflows', () => {
    const mesh = new EditMesh();
    const base = 1e300;
    const step = Number.EPSILON * base * 8;
    const a = mesh.addVertex(base, base, base);
    const middle = mesh.addVertex(base + step, base, base);
    const b = mesh.addVertex(base + step * 2, base, base);
    const c = mesh.addVertex(base + step, base + step, base);
    tri(mesh, a, middle, c);
    tri(mesh, middle, b, c);
    const deviation = featureDeviation(mesh, [
      {
        id: 'subnormal-edge-chain',
        segments: [
          [
            [base, base, base],
            [base + step * 2, base, base],
          ],
        ],
        tolerance: 1e-320,
      },
    ]);
    expect(deviation.unresolved).toEqual(['subnormal-edge-chain']);
    const nearby = featureDeviation(mesh, [
      {
        id: 'subnormal-offset-edge-chain',
        segments: [
          [
            [base, base, base + step],
            [base + step * 2, base, base + step],
          ],
        ],
        tolerance: 1e-320,
      },
    ]);
    expect(nearby.unresolved).toEqual(['subnormal-offset-edge-chain']);
    expect(nearby.byConstraint['subnormal-offset-edge-chain']).toBe(Infinity);
  });

  it('does not certify a non-coincident huge edge at subnormal tolerance', () => {
    const mesh = new EditMesh();
    const base = 1e300;
    const step = Number.EPSILON * base * 8;
    addTriangleAt(mesh, [base, base, base], [base + step, base, base], [base, base + step, base]);
    const deviation = featureDeviation(mesh, [
      {
        id: 'huge-offset-subnormal',
        segments: [
          [
            [base, base, base + step],
            [base + step, base, base + step],
          ],
        ],
        tolerance: 1e-320,
      },
    ]);
    expect(deviation.unresolved).toEqual(['huge-offset-subnormal']);
    expect(deviation.byConstraint['huge-offset-subnormal']).toBe(Infinity);
  });

  it('leaves huge long edges unresolved at the smallest tolerance', () => {
    const mesh = new EditMesh();
    addTriangleAt(mesh, [-1e300, 0.9e-300, 0.9e-300], [1e300, 0.9e-300, 0.9e-300], [0, 1e300, 0]);
    const deviation = featureDeviation(mesh, [
      {
        id: 'exact-frame-budget',
        segments: [
          [
            [0, 0, 0],
            [1e-300, 0, 0],
          ],
        ],
        tolerance: Number.MIN_VALUE,
      },
    ]);
    expect(deviation.unresolved).toEqual(['exact-frame-budget']);
    expect(deviation.byConstraint['exact-frame-budget']).toBe(Infinity);
  });

  it('matches the BigInt distance oracle at five coordinate scales', () => {
    let state = 0x50505;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (const scale of [1e-25, 1e-12, 1, 1e12, 1e25]) {
      for (let sample = 0; sample < 200; sample++) {
        const mesh = ordinaryOracleFeatureMesh(scale);
        const z = scale * (0.25 + random() * 0.5);
        const insideTolerance = z * (1 + 2e-9 + random() * 0.2);
        const outsideTolerance = z * (0.5 + random() * 0.4);
        const point: [number, number, number] = [scale * (0.25 + random() * 0.5), 0, z];
        const end: [number, number, number] = [point[0] + scale / 4, point[1], point[2]];
        const tolerance = sample % 2 === 0 ? insideTolerance : outsideTolerance;
        const exactWithin = exactLineDistanceWithin(point, [0, 0, 0], [scale, 0, 0], tolerance);
        expect(exactWithin).toBe(sample % 2 === 0);
        const deviation = featureDeviation(mesh, [
          { id: 'oracle', segments: [[point, end]], tolerance },
        ]);
        const certified = !deviation.unresolved.includes('oracle');
        expect(certified).toBe(exactWithin);
      }
    }
  });

  it('matches a BigInt oracle for 240 mixed-magnitude cases', () => {
    let state = 0x50506;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    let falseCertifications = 0;
    let clearInsideFalseRejections = 0;
    for (let sample = 0; sample < 240; sample++) {
      const category = Math.floor(sample / 80);
      const scale =
        category === 0
          ? sample % 2 === 0
            ? 1e-25
            : 1e-12
          : category === 1
            ? sample % 2 === 0
              ? 1e25
              : 1e12
            : ([1e-25, 1e-12, 1e12, 1e25][sample % 4] as number);
      const mesh = ordinaryOracleFeatureMesh(scale);
      if (scale < 1) {
        const base = 1e25;
        const step = Number.EPSILON * base * 8;
        addTriangleAt(
          mesh,
          [base, base, base],
          [base + step, base, base],
          [base, base + step, base],
        );
      } else {
        addTriangleAt(mesh, [1e-25, 0, 0], [2e-25, 0, 0], [1e-25, 1e-25, 0]);
      }
      const x = scale * (0.2 + random() * 0.3);
      const z = scale * (0.01 + random() * 0.02);
      const point: [number, number, number] = [x, 0, z];
      const end: [number, number, number] = [x + scale / 4, 0, z];
      const tolerance = sample % 3 === 0 ? z * 1.25 : sample % 3 === 1 ? z * 0.75 : z * (1 + 2e-9);
      const exactWithin = exactLineDistanceWithin(point, [0, 0, 0], [scale, 0, 0], tolerance);
      const deviation = featureDeviation(mesh, [
        { id: 'mixed-oracle', segments: [[point, end]], tolerance },
      ]);
      const certified = !deviation.unresolved.includes('mixed-oracle');
      if (certified && !exactWithin) falseCertifications++;
      if (!certified && exactWithin && sample % 3 === 0) clearInsideFalseRejections++;
      if (sample % 3 !== 2) expect(certified).toBe(exactWithin);
    }
    expect(falseCertifications).toBe(0);
    expect(clearInsideFalseRejections).toBe(0);
  });

  it('matches 360 adversarial long-edge cases against exact BigInt point oracles', () => {
    let state = 0x50507;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const tolerance = 1e-20;
    const featureLength = tolerance / 8;
    let falseCertifications = 0;
    let clearInsideFalseRejections = 0;
    for (let sample = 0; sample < 360; sample++) {
      const mesh = new EditMesh();
      const xExtent = 1e25 * (1 + (sample % 7));
      const kind = sample % 6;
      const inside = kind === 1 || kind === 3 || kind === 5;
      const start: [number, number, number] = [0, 0, 0];
      const middle: [number, number, number] = [featureLength / 2, 0, 0];
      const end: [number, number, number] = [featureLength, 0, 0];
      if (kind === 0) {
        const y0 = tolerance * (0.75 + random() * 0.2);
        const y1 = tolerance * (0.75 + random() * 0.2);
        const z0 = tolerance * (0.75 + random() * 0.2);
        const z1 = tolerance * (0.75 + random() * 0.2);
        addTriangleAt(mesh, [-xExtent, y0, z0], [xExtent, y1, z1], [0, 1e25, 0]);
      } else if (kind === 1 || kind === 3 || kind === 5) {
        const offset = kind === 5 ? tolerance * 0.125 : 0;
        const chainStart: [number, number, number] = kind === 1 ? [-2 * tolerance, 0, 0] : start;
        const chainEnd: [number, number, number] =
          kind === 1 ? [featureLength + 2 * tolerance, 0, 0] : end;
        const chainMiddle: [number, number, number] = [middle[0], offset, 0];
        const branch: [number, number, number] = [middle[0], offset, featureLength];
        addTriangleAt(mesh, chainStart, chainMiddle, branch);
        addTriangleAt(mesh, chainMiddle, chainEnd, branch);
        if (kind === 3) {
          const near = tolerance * 0.5;
          addTriangleAt(mesh, [-xExtent, near, near], [xExtent, near, near], [0, 1e25, 0]);
        }
        if (kind === 5) {
          addTriangleAt(
            mesh,
            middle,
            [middle[0], tolerance * 2, 0],
            [middle[0], tolerance * 2, featureLength],
          );
        }
      } else if (kind === 2) {
        const offset = nextUp(tolerance);
        addTriangleAt(mesh, [-xExtent, offset, 0], [xExtent, offset, 0], [0, 1e25, 0]);
      } else {
        const branch: [number, number, number] = [0, 0, featureLength];
        addTriangleAt(mesh, start, [-xExtent, 1e25, 0], [xExtent, 1e25, 0]);
        addTriangleAt(mesh, start, branch, [0, 1e25, 1e25]);
      }
      const featureStart: [number, number, number] =
        kind === 4 ? [0, tolerance * 2, 0] : [...start];
      const featureEnd: [number, number, number] = [
        featureStart[0] + featureLength,
        featureStart[1],
        featureStart[2],
      ];
      const feature = [featureStart, featureEnd] as const;
      const oracleSamples = [0, 0.25, 0.5, 0.75, 1].map((t) => [
        featureStart[0] + featureLength * t,
        featureStart[1],
        featureStart[2],
      ]);
      const exactWithin = oracleSamples.every((point) =>
        mesh.edges().some((edge) => {
          const [a, b] = mesh.edgeVertices(edge);
          return exactPointSegmentWithin(point, mesh.position(a), mesh.position(b), tolerance);
        }),
      );
      expect(exactWithin).toBe(inside);
      const deviation = featureDeviation(mesh, [
        { id: 'adversarial', segments: [[feature[0], feature[1]]], tolerance },
      ]);
      const certified = !deviation.unresolved.includes('adversarial');
      if (certified && !exactWithin) falseCertifications++;
      if (!certified && inside) clearInsideFalseRejections++;
      if (inside) expect(certified).toBe(true);
      else expect(certified).toBe(false);
    }
    expect(falseCertifications).toBe(0);
    expect(clearInsideFalseRejections).toBe(0);
  });

  it('checks 1500 mixed ordinary-range features against an independent BigInt oracle', () => {
    let state = 0x50508;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    let falseCertifications = 0;
    let falseRejections = 0;
    let oracleInsideCount = 0;
    let oracleOutsideCount = 0;
    let oracleUncertainCount = 0;
    let conservativeUnresolved = 0;
    for (let sample = 0; sample < 1_500; sample++) {
      const mesh = new EditMesh();
      const scale = [1e-28, 1e-14, 1e-5, 1, 1e5, 1e14, 1e28][sample % 7] as number;
      const tolerance = scale * 0.05;
      const featureLength = scale * 2;
      const start: [number, number, number] = [0, 0, 0];
      const end: [number, number, number] = [featureLength, 0, 0];
      const kind = sample % 6;
      if (kind === 0 || kind === 1) {
        const margin = sample % 12 < 6 ? 1e-6 : 1e-12;
        const offset = tolerance * (kind === 0 ? 1 - margin : 1 + margin);
        addTriangleAt(
          mesh,
          [0, offset, 0],
          [featureLength, offset, 0],
          [featureLength / 2, offset + scale, 0],
        );
      } else if (kind === 2) {
        const offset = tolerance * (0.1 + random() * 0.2);
        const middle = featureLength * (0.45 + random() * 0.1);
        addTriangleAt(
          mesh,
          [0, offset, 0],
          [middle - 2 * tolerance, offset, 0],
          [middle / 2, offset + scale, 0],
        );
        addTriangleAt(
          mesh,
          [middle + 2 * tolerance, offset, 0],
          [featureLength, offset, 0],
          [(middle + featureLength) / 2, offset + scale, 0],
        );
      } else if (kind === 3) {
        addTriangleAt(mesh, [0, 0, 0], [featureLength, 0, 0], [featureLength / 2, 0, scale]);
        addTriangleAt(
          mesh,
          [featureLength / 2, -scale, 0],
          [featureLength / 2, scale, 0],
          [featureLength / 2, 0, scale],
        );
      } else if (kind === 4) {
        const offset = tolerance * (0.1 + random() * 0.2);
        const slope = scale * (1e-6 + random() * 1e-6);
        addTriangleAt(
          mesh,
          [0, offset, 0],
          [featureLength, offset + slope, 0],
          [featureLength / 2, offset + scale, scale],
        );
      } else {
        const firstEnd = featureLength * (0.3 + random() * 0.1);
        const secondStart = firstEnd + tolerance * (0.25 + random() * 0.5);
        addTriangleAt(mesh, [0, 0, 0], [firstEnd, 0, 0], [firstEnd / 2, 0, scale]);
        addTriangleAt(
          mesh,
          [secondStart, 0, 0],
          [featureLength, 0, 0],
          [(secondStart + featureLength) / 2, 0, scale],
        );
      }
      const oracle = exactFeatureOracle(start, end, mesh, tolerance);
      if (oracle === 'inside') oracleInsideCount++;
      else if (oracle === 'outside') oracleOutsideCount++;
      else oracleUncertainCount++;
      const result = featureDeviation(mesh, [
        { id: 'feature-oracle', segments: [[start, end]], tolerance },
      ]);
      const certified = !result.unresolved.includes('feature-oracle');
      if (certified && oracle !== 'inside') falseCertifications++;
      if (!certified && oracle === 'inside') falseRejections++;
      if (!certified) conservativeUnresolved++;
    }
    process.stdout.write(
      `${JSON.stringify({
        cases: 1_500,
        oracleInsideCount,
        oracleOutsideCount,
        oracleUncertainCount,
        falseCertifications,
        falseRejections,
        conservativeUnresolved,
        unresolvedRate: conservativeUnresolved / 1_500,
      })}\n`,
    );
    expect(oracleInsideCount + oracleOutsideCount + oracleUncertainCount).toBe(1_500);
    expect(falseCertifications).toBe(0);
  });

  it('accepts a straight constraint covered by a chain of output edges', () => {
    const mesh = quadStrip(4);
    const deviation = featureDeviation(mesh, [
      {
        id: 'chain',
        segments: [
          [
            [0, 0, 0],
            [4, 0, 0],
          ],
        ],
        tolerance: 1e-6,
      },
    ]);
    expect(deviation.byConstraint.chain).toBe(0);
    expect(deviation.unresolved).toEqual([]);
  });

  it('certifies near-boundary distances and leaves the exact threshold unresolved', () => {
    const mesh = new EditMesh();
    addTriangleAt(mesh, [0, 0.75, 0], [1, 0.75, 0], [0, 1.75, 0]);
    const inside = featureDeviation(mesh, [
      {
        id: 'near-boundary',
        segments: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
        ],
        tolerance: 1,
      },
    ]);
    expect(inside.unresolved).toEqual([]);
    expect(inside.byConstraint['near-boundary']).toBeLessThanOrEqual(1);

    const equality = new EditMesh();
    addTriangleAt(equality, [-1, 1, 0], [1, 1, 0], [0, 2, 0]);
    const point = featureDeviation(equality, [
      {
        id: 'exact-threshold',
        segments: [
          [
            [0, 0, 0],
            [0, 0, 0],
          ],
        ],
        tolerance: 1,
      },
    ]);
    expect(point.unresolved).toEqual(['exact-threshold']);
  });

  it('certifies short and full-chain features on a 10,002-edge mesh', () => {
    const mesh = triangleChainCloud(3_334);
    expect(mesh.edgeCount).toBe(10_002);
    const short = featureDeviation(mesh, [
      {
        id: '10k-short',
        segments: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
        ],
        tolerance: 0.1,
      },
    ]);
    const long = featureDeviation(mesh, [
      {
        id: '10k-long',
        segments: [
          [
            [0, 0, 0],
            [3_334, 0, 0],
          ],
        ],
        tolerance: 0.1,
      },
    ]);
    expect(short.unresolved).toEqual([]);
    expect(short.byConstraint['10k-short']).toBeLessThan(1e-9);
    expect(long.unresolved).toEqual([]);
    expect(long.byConstraint['10k-long']).toBeLessThan(1e-9);
  });

  it('drifts past tolerance when the constraint is deleted (falsifier)', () => {
    for (const degrees of [1, 2, 3]) {
      const { mesh, diagonal } = bentSquare(degrees);
      const free = quadRemesh(mesh, mesh.faces(), { constraints: [] });
      expect(free.ok).toBe(true);
      if (!free.ok) return;
      // The unconstrained output has no edge on the diagonal: measure the same polyline against it.
      const drift = featureDeviation(
        free.value.mesh,
        constraintSegments([{ id: 'crease', polyline: diagonal, tolerance: 1e-3 }]),
      );
      expect(drift.byConstraint.crease as number).toBeGreaterThan(1e-3);
      expect(drift.unresolved).toEqual(['crease']);
    }
  });

  it('does not pair a fold steeper than the default planarity gate', () => {
    const { mesh } = bentSquare(10);
    expect(quadCount(run(mesh).provenance)).toBe(0);
  });

  it('bend gate rejects a 20 degree fold (above maxAngle, below sharpDegrees) when planarity is relaxed', () => {
    const { mesh } = bentSquare(20);
    expect(quadCount(run(mesh, { maxPlanarity: 1, maxAngle: 15 }).provenance)).toBe(0);
  });

  it('dihedral protection keeps a 40 degree fold when the bend gate is relaxed', () => {
    const { mesh } = bentSquare(40);
    expect(quadCount(run(mesh, { maxPlanarity: 1, maxAngle: 60 }).provenance)).toBe(0);
  });

  it('pairs a flat strip into two quads without reusing a triangle', () => {
    const { m } = strip();
    const value = run(m);
    expect(quadCount(value.provenance)).toBe(2);
    expect(value.mesh.faceCount).toBe(2);
  });

  it('does not pair triangles with different face roles', () => {
    const { m, t3 } = strip();
    m.fRole[t3] = 1;
    expect(quadCount(run(m).provenance)).toBe(1);
  });

  it('does not pair triangles with different face flags', () => {
    const { m, t3 } = strip();
    m.fFlags[t3] = 1;
    expect(quadCount(run(m).provenance)).toBe(1);
  });

  it('does not pair triangles with different face tags', () => {
    const { m, t3 } = strip();
    m.addTag(t3, m.tagIndex('audit-tag', true));
    expect(quadCount(run(m).provenance)).toBe(1);
  });

  it('material gate keeps a triangle with another material unpaired', () => {
    const { m } = strip(1);
    const value = run(m);
    expect(quadCount(value.provenance)).toBe(1);
    expect(value.mesh.faceCount).toBe(3);
  });

  it('corner-channel layout gate keeps a triangle with a channel on its corners unpaired', () => {
    const { m, t3 } = strip();
    for (const h of m.faceHalves(t3)) m.setCorner('uv0', h, [0, 0]);
    const value = run(m);
    expect(quadCount(value.provenance)).toBe(1);
    expect(value.mesh.faceCount).toBe(3);
  });

  it('does not pair when a corner channel exists on only one unshared corner', () => {
    const { m, t3 } = strip();
    const unsharedCorner = m.faceHalves(t3).find((h) => m.hVert[h] === 2);
    expect(unsharedCorner).toBeDefined();
    m.setCorner('uv0', unsharedCorner as number, [0.25, 0.75]);
    const value = run(m);
    expect(quadCount(value.provenance)).toBe(1);
    expect(value.mesh.faceCount).toBe(3);
  });

  it('does not pair triangles across a UV seam on their shared diagonal', () => {
    const mesh = new EditMesh();
    const a = mesh.addVertex(0, 0, 0);
    const b = mesh.addVertex(1, 0, 0);
    const c = mesh.addVertex(1, 1, 0);
    const d = mesh.addVertex(0, 1, 0);
    const first = tri(mesh, a, b, c);
    const second = tri(mesh, a, c, d);
    const firstHalves = mesh.faceHalves(first);
    const secondHalves = mesh.faceHalves(second);
    for (const h of firstHalves) mesh.setCorner('uv0', h, [mesh.hVert[h] as number, 0]);
    for (const h of secondHalves)
      mesh.setCorner('uv0', h, [mesh.hVert[h] === a ? 0 : 10 + (mesh.hVert[h] as number), 0]);

    const result = run(mesh);
    expect(quadCount(result.provenance)).toBe(0);
    expect(result.mesh.faceCount).toBe(2);
  });

  it('straight-corner gate rejects a pair with a near-180 degree corner', () => {
    const m = new EditMesh();
    const a = m.addVertex(0, 0, 0);
    const b = m.addVertex(1, -0.001, 0);
    const c = m.addVertex(2, 0, 0);
    const d = m.addVertex(1, 1, 0);
    tri(m, a, b, d);
    tri(m, b, c, d);
    expect(quadCount(run(m).provenance)).toBe(0);
  });

  it('returns model-partial with the constraint id when a polyline is off the mesh', () => {
    const m = box();
    const far: FeatureConstraint = {
      id: 'floating',
      polyline: [
        [5, 5, 5],
        [6, 5, 5],
      ],
      tolerance: 1e-3,
    };
    const result = quadRemesh(m, m.faces(), { constraints: [far] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('model-partial');
    expect(result.error.detail?.unresolvedFeatures).toEqual(['floating']);
  });

  it('reports prototype-sensitive constraint ids as own result keys', () => {
    const m = box();
    const polyline: FeatureConstraint['polyline'] = [
      [-0.5, -0.5, -0.5],
      [0.5, -0.5, -0.5],
    ];
    const ids = ['__proto__', 'constructor', 'toString'];
    const result = quadRemesh(m, m.faces(), {
      constraints: ids.map((id) => ({ id, polyline, tolerance: 1e-6 })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byConstraint = result.value.report.featureDeviation.byConstraint;
    for (const id of ids) {
      expect(Object.hasOwn(byConstraint, id)).toBe(true);
      expect(byConstraint[id]).toBe(0);
    }
  });

  it('rejects duplicate constraint ids and polylines with fewer than two points', () => {
    const m = box();
    const a: FeatureConstraint = {
      id: 'x',
      polyline: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      tolerance: 0.1,
    };
    const dup = quadRemesh(m, m.faces(), { constraints: [a, a] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('model-invalid-argument');
    const short = quadRemesh(m, m.faces(), {
      constraints: [{ id: 'y', polyline: [[0, 0, 0]], tolerance: 0.1 }],
    });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.code).toBe('model-invalid-argument');
  });

  it('reports feature deviations against selected output faces only', () => {
    const mesh = new EditMesh();
    const a = mesh.addVertex(0, 0, 0);
    const b = mesh.addVertex(1, 0, 0);
    const c = mesh.addVertex(1, 1, 0);
    const d = mesh.addVertex(0, 1, 0);
    const selected = tri(mesh, a, b, c);
    tri(mesh, a, c, d);
    const selectedOnly = quadRemesh(mesh, [selected]);
    expect(selectedOnly.ok).toBe(true);
    if (selectedOnly.ok) {
      expect(selectedOnly.value.report.scope).toBe('selected-faces');
      expect(selectedOnly.value.report.measuredFaces).toBe(1);
      expect(selectedOnly.value.report.quality.boundaryEdges).toBe(3);
      expect(selectedOnly.value.report.quality.nonQuadFaces).toBe(1);
    }
    const constraint: FeatureConstraint = {
      id: 'unselected-edge',
      polyline: [
        [0, 1, 0],
        [0, 0, 0],
      ],
      tolerance: 1e-6,
    };
    const result = quadRemesh(mesh, [selected], { constraints: [constraint] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('model-partial');
      expect(result.error.detail?.unresolvedFeatures).toEqual(['unselected-edge']);
    }
  });

  it('returns structured errors for non-finite input mesh positions', () => {
    const polyline: FeatureConstraint['polyline'] = [
      [0, 0, 0],
      [1, 0, 0],
    ];
    const cases = [
      { point: [Number.NaN, 0, 0] as const, axis: 0 },
      { point: [Number.POSITIVE_INFINITY, 0, 0] as const, axis: 0 },
    ];
    for (const { point, axis } of cases) {
      const mesh = new EditMesh();
      const a = mesh.addVertex(...point);
      const b = mesh.addVertex(1, 0, 0);
      const c = mesh.addVertex(0, 1, 0);
      tri(mesh, a, b, c);
      const invoke = () =>
        quadRemesh(mesh, mesh.faces(), {
          constraints: [{ id: 'finite', polyline, tolerance: 1e-3 }],
        });
      expect(invoke).not.toThrow();
      const result = invoke();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('model-invalid-argument');
        expect(result.error.hint).toContain('finite');
        expect(result.error.detail).toMatchObject({ vertex: a, axis });
      }
    }
  });

  it('certifies a bounded straight edge chain at every subdivision depth', () => {
    const mesh = new EditMesh();
    const a = mesh.addVertex(0, 0, 0);
    const middle = mesh.addVertex(1, 0, 0);
    const b = mesh.addVertex(2, 0, 0);
    const c = mesh.addVertex(1, 1, 0);
    tri(mesh, a, middle, c);
    tri(mesh, middle, b, c);
    const groups = [
      {
        id: 'depth',
        segments: [
          [
            [0, 0, 0],
            [2, 0, 0],
          ] as [Tuple3, Tuple3],
        ],
        tolerance: 1e-6,
      },
    ];
    for (const depth of [0, 64, 65]) {
      const deviation = featureDeviationForTest(mesh, groups, depth);
      expect(deviation.unresolved).toEqual([]);
      expect(deviation.byConstraint.depth).toBe(0);
    }
  });

  it('rejects non-finite feature coordinates and tolerances', () => {
    const m = box();
    const cases: FeatureConstraint[] = [
      {
        id: 'nan',
        polyline: [
          [Number.NaN, 0, 0],
          [1, 0, 0],
        ],
        tolerance: 0.1,
      },
      {
        id: 'infinite',
        polyline: [
          [0, 0, 0],
          [1, Number.POSITIVE_INFINITY, 0],
        ],
        tolerance: 0.1,
      },
      {
        id: 'tolerance',
        polyline: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        tolerance: Number.POSITIVE_INFINITY,
      },
    ];
    for (const constraint of cases) {
      const result = quadRemesh(m, m.faces(), { constraints: [constraint] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('model-invalid-argument');
    }
  });

  it('rejects a non-positive tolerance even when the polyline lies on the mesh', () => {
    const m = box();
    const onEdge: FeatureConstraint['polyline'] = [
      [-0.5, -0.5, -0.5],
      [0.5, -0.5, -0.5],
    ];
    for (const tolerance of [0, Number.NaN]) {
      const r = quadRemesh(m, m.faces(), {
        constraints: [{ id: 'edge', polyline: onEdge, tolerance }],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
    }
  });

  it('reports the largest per-constraint deviation as the max', () => {
    const m = box();
    const value = run(m, {
      constraints: [
        {
          id: 'near',
          polyline: [
            [-0.5, -0.5, -0.5],
            [0.5, -0.5, -0.5],
          ],
          tolerance: 1e-3,
        },
        {
          id: 'far',
          polyline: [
            [2, 0, 0],
            [3, 0, 0],
          ],
          tolerance: 100,
        },
      ],
    });
    const by = value.report.featureDeviation.byConstraint;
    expect(by.near).toBeCloseTo(0, 9);
    expect(by.far as number).toBeGreaterThan(0);
    expect(value.report.featureDeviation.max).toBeCloseTo(by.far as number, 12);
  });

  it('does not certify the subnormal short-edge audit repro', () => {
    const mesh = new EditMesh();
    const y = Number.MIN_VALUE * 8;
    const a = mesh.addVertex(0, y, 0);
    const b = mesh.addVertex(1, y, 0);
    const c = mesh.addVertex(0, y, 1);
    tri(mesh, a, b, c);
    const result = quadRemesh(mesh, mesh.faces(), {
      constraints: [
        {
          id: 'subnormal',
          polyline: [
            [0, 0, 0],
            [1e-300, 0, 0],
          ],
          tolerance: Number.MIN_VALUE,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.unresolvedFeatures).toEqual(['subnormal']);
  });

  it('leaves the coincident large-coordinate audit repro unresolved', () => {
    const mesh = new EditMesh();
    const a = mesh.addVertex(0, 1e290, 0);
    const b = mesh.addVertex(1e300, 1e290, 0);
    const c = mesh.addVertex(0, 2e290, 0);
    tri(mesh, a, b, c);
    const result = quadRemesh(mesh, mesh.faces(), {
      constraints: [
        {
          id: 'large-edge',
          polyline: [
            [0, 1e290, 0],
            [1e300, 1e290, 0],
          ],
          tolerance: 1e290,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('model-partial');
      expect(result.error.detail?.unresolvedFeatures).toEqual(['large-edge']);
    }
  });

  it.each([
    1e-323, 1e-20, 1e20, 1e150, 1e300,
  ])('does not certify an off-surface feature at scale %s', (scale) => {
    const mesh = new EditMesh();
    const offset = scale < 1e-300 ? scale : scale / 2;
    const a = mesh.addVertex(0, offset, 0);
    const b = mesh.addVertex(scale, offset, 0);
    const c = mesh.addVertex(0, offset * 2, 0);
    tri(mesh, a, b, c);
    const tolerance = offset / 2;
    const deviation = featureDeviation(mesh, [
      {
        id: 'scaled',
        segments: [
          [
            [0, 0, 0],
            [scale, 0, 0],
          ],
        ],
        tolerance,
      },
    ]);
    expect(deviation.unresolved).toEqual(['scaled']);
    expect(deviation.byConstraint.scaled).toBeGreaterThan(tolerance);
  });

  it('leaves subnormal normalized tolerances unresolved', () => {
    const mesh = new EditMesh();
    const a = mesh.addVertex(0, 0, 0);
    const b = mesh.addVertex(1e300, 1e300, 0);
    const c = mesh.addVertex(0, 1e300, 1e300);
    tri(mesh, a, b, c);
    const deviation = featureDeviation(mesh, [
      {
        id: 'subnormal-tolerance',
        segments: [
          [
            [0, 0, 0],
            [1e300, 0, 0],
          ],
        ],
        tolerance: 1e-20,
      },
    ]);
    expect(deviation.unresolved).toEqual(['subnormal-tolerance']);
    expect(deviation.byConstraint['subnormal-tolerance']).toBe(Infinity);
  });

  it('leaves a coincident large-coordinate constraint edge unresolved', () => {
    const mesh = new EditMesh();
    const a = mesh.addVertex(0, 1e290, 0);
    const b = mesh.addVertex(1e300, 1e290, 0);
    const c = mesh.addVertex(0, 1.0000001e290, 0);
    tri(mesh, a, b, c);
    const deviation = featureDeviation(mesh, [
      {
        id: 'large-edge',
        segments: [
          [
            [0, 1e290, 0],
            [1e300, 1e290, 0],
          ],
        ],
        tolerance: 1e290,
      },
    ]);
    expect(deviation.byConstraint['large-edge']).toBe(Infinity);
    expect(deviation.unresolved).toEqual(['large-edge']);
  });

  it('fails closed exactly at the ordinary range boundaries', () => {
    const verdict = (point: number, tolerance: number) => {
      const mesh = new EditMesh();
      addTriangleAt(mesh, [0, 0, 0], [point, 0, 0], [0, point, 0]);
      return featureDeviation(mesh, [
        {
          id: 'range',
          segments: [
            [
              [0, 0, 0],
              [point, 0, 0],
            ],
          ],
          tolerance,
        },
      ]).unresolved;
    };
    expect(verdict(1e30, 1)).toEqual([]);
    expect(verdict(nextUp(1e30), 1)).toEqual(['range']);
    expect(verdict(1, 1e-30)).toEqual([]);
    expect(verdict(1, 1e-30 * (1 - Number.EPSILON))).toEqual(['range']);
    const tinyExtent = new EditMesh();
    addTriangleAt(tinyExtent, [1e-29, 0, 0], [nextUp(1e-29), 0, 0], [1e-29, 1e-29, 0]);
    const tiny = featureDeviation(tinyExtent, [
      {
        id: 'extent',
        segments: [
          [
            [1e-29, 0, 0],
            [1e-29, 0, 0],
          ],
        ],
        tolerance: 1e-29,
      },
    ]);
    expect(tiny.unresolved).toEqual(['extent']);
  });

  it('rejects a diverging edge whose start lies on the feature', () => {
    const mesh = new EditMesh();
    addTriangleAt(mesh, [0, 0, 0], [2, 0.5, 0], [1, 1, 0]);
    const deviation = featureDeviation(mesh, [
      {
        id: 'diverging',
        segments: [
          [
            [0, 0, 0],
            [2, 0, 0],
          ],
        ],
        tolerance: 0.1,
      },
    ]);
    expect(deviation.unresolved).toEqual(['diverging']);
  });

  it('certifies a polyline whose end stubs lie within tolerance of the mesh', () => {
    const mesh = new EditMesh();
    const triangles: [Tuple3, Tuple3, Tuple3][] = [
      [
        [0, 0, 0],
        [0.5, 0, 0.02397127693021015],
        [0.5, 0.5, 0.021036774620197415],
      ],
      [
        [0, 0, 0],
        [0.5, 0.5, 0.021036774620197415],
        [0, 0.5, 0],
      ],
      [
        [0.5, 0, 0.02397127693021015],
        [1, 0, 0.04207354924039483],
        [1, 0.5, 0.03692301313020644],
      ],
      [
        [0.5, 0, 0.02397127693021015],
        [1, 0.5, 0.03692301313020644],
        [0.5, 0.5, 0.021036774620197415],
      ],
      [
        [0, 0.5, 0],
        [0.5, 0.5, 0.021036774620197415],
        [0, 1, 0],
      ],
      [
        [0.5, 0.5, 0.021036774620197415],
        [0.5, 1, 0.012951736199996287],
        [0, 1, 0],
      ],
      [
        [0.5, 0.5, 0.021036774620197415],
        [1, 0.5, 0.03692301313020644],
        [0.5, 1, 0.012951736199996287],
      ],
      [
        [1, 0.5, 0.03692301313020644],
        [1, 1, 0.022732435670642048],
        [0.5, 1, 0.012951736199996287],
      ],
    ];
    for (const t of triangles) addTriangleAt(mesh, ...t);
    const polyline: Tuple3[] = [
      [0, 1e-9, 5e-10],
      [0.5, 1e-9, 0.02397127743021015],
      [1, 1e-9, 0.04207354974039483],
    ];
    const segments = polyline.slice(1).map((end, i) => [polyline[i] ?? end, end] as const);
    const deviation = featureDeviation(mesh, [{ id: 'stub', segments, tolerance: 1e-6 }]);
    expect(deviation.unresolved).toEqual([]);
    expect(deviation.byConstraint.stub).toBeLessThanOrEqual(1e-6);
  });

  it('keeps a 1e-4 gap between collinear edges unresolved', () => {
    const mesh = new EditMesh();
    addTriangleAt(mesh, [0, 0, 0], [0.5, 0, 0], [0, 1, 0]);
    addTriangleAt(mesh, [0.5001, 0, 0], [1, 0, 0], [1, 1, 0]);
    const deviation = featureDeviation(mesh, [
      {
        id: 'gap',
        segments: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
        ],
        tolerance: 1e-5,
      },
    ]);
    expect(deviation.unresolved).toEqual(['gap']);
  });

  it('keeps coverage ending at 1 - 1e-3 of the feature unresolved', () => {
    const mesh = new EditMesh();
    addTriangleAt(mesh, [0, 0, 0], [0.999, 0, 0], [0, 1, 0]);
    const deviation = featureDeviation(mesh, [
      {
        id: 'short',
        segments: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
        ],
        tolerance: 1e-5,
      },
    ]);
    expect(deviation.unresolved).toEqual(['short']);
  });

  it('keeps coverage starting at 1e-3 of the feature unresolved', () => {
    const mesh = new EditMesh();
    addTriangleAt(mesh, [0.001, 0, 0], [1, 0, 0], [1, 1, 0]);
    const deviation = featureDeviation(mesh, [
      {
        id: 'late',
        segments: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
        ],
        tolerance: 1e-5,
      },
    ]);
    expect(deviation.unresolved).toEqual(['late']);
  });

  it('reports the half-chord term when a gap is bridged by the Lipschitz bound', () => {
    const mesh = new EditMesh();
    addTriangleAt(mesh, [0, 0, 0], [0.4, 0, 0], [0, 1, 0]);
    addTriangleAt(mesh, [0.6, 0, 0], [1, 0, 0], [1, 1, 0]);
    const deviation = featureDeviation(mesh, [
      {
        id: 'bridge',
        segments: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
        ],
        tolerance: 0.15,
      },
    ]);
    expect(deviation.unresolved).toEqual([]);
    expect(deviation.byConstraint.bridge).toBeGreaterThanOrEqual(0.1);
    expect(deviation.byConstraint.bridge).toBeLessThanOrEqual(0.15);
  });
});
