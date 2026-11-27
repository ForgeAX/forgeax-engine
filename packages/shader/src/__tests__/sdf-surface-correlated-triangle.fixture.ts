import { SDF_SURFACE_INTERSECTION_WGSL } from '../sdf-surface-intersection-wgsl';
import { exactEndpointDyadic } from './sdf-surface-exact-endpoints.fixture';

type V3 = readonly [number, number, number];
interface CorrelatedCase {
  readonly name: string;
  readonly triangle: readonly [V3, V3, V3];
  readonly origin: V3;
  readonly originHi: V3;
  readonly direction: V3;
  readonly directionHi: V3;
  readonly range: readonly [number, number];
  readonly requiredHit: boolean;
  readonly valid?: number;
}
const view = new DataView(new ArrayBuffer(4));
function bits(value: number) {
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}
const q = (value: number) => exactEndpointDyadic(bits(value));
const subtract = (a: readonly bigint[], b: readonly bigint[]) =>
  a.map((value, index) => value - (b[index] ?? 0n));
const cross = (a: readonly bigint[], b: readonly bigint[]) => [
  (a[1] ?? 0n) * (b[2] ?? 0n) - (a[2] ?? 0n) * (b[1] ?? 0n),
  (a[2] ?? 0n) * (b[0] ?? 0n) - (a[0] ?? 0n) * (b[2] ?? 0n),
  (a[0] ?? 0n) * (b[1] ?? 0n) - (a[1] ?? 0n) * (b[0] ?? 0n),
];
const dot = (a: readonly bigint[], b: readonly bigint[]) =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0n), 0n);

/** Actual ray 542407 / primitive 149290, after the production inverse certificate.
 * These local boxes deliberately include the affine transform's outward error.
 * The original GPU returned uncertain (return-site witness 316).
 */
const actual: CorrelatedCase = {
  name: 'sponza-542407-149290',
  triangle: [
    [-190.99560546875, 47.53239822387695, 200.09649658203125],
    [-196.91799926757812, 47.4015007019043, 198.56280517578125],
    [-197.11790466308594, 59.849998474121094, 198.67759704589844],
  ],
  origin: [-47.026432037353516, 472.8070983886719, -251.01055908203125],
  originHi: [-46.956119537353516, 473.455078125, -250.62525939941406],
  direction: [-29.648502349853516, -82.65750885009766, 88.95897674560547],
  directionHi: [-29.648483276367188, -82.6574478149414, 88.95903778076172],
  range: [0, 60],
  requiredHit: true,
};
const simple: CorrelatedCase = {
  name: 'interior',
  triangle: [
    [0, 0, 0],
    [4, 0, 0],
    [0, 4, 0],
  ],
  origin: [1, 1, 2],
  originHi: [1, 1, 2],
  direction: [0, 0, -1],
  directionHi: [0, 0, -1],
  range: [0, 4],
  requiredHit: true,
};
const beyondEdge = (point: V3): V3 =>
  point.map((value, axis) =>
    Math.fround(
      value +
        0.05 *
          ((actual.triangle[1][axis] ?? 0) +
            (actual.triangle[2][axis] ?? 0) -
            2 * (actual.triangle[0][axis] ?? 0)),
    ),
  ) as unknown as V3;
export const correlatedTriangleCases: readonly CorrelatedCase[] = [
  actual,
  {
    ...actual,
    name: 'reversed',
    triangle: [actual.triangle[0], actual.triangle[2], actual.triangle[1]],
  },
  simple,
  { ...simple, name: 'closed-endpoint', range: [2, 2] },
  {
    ...simple,
    name: 'edge-crossing',
    origin: [1, -0.125, 2],
    originHi: [1, 0.125, 2],
    requiredHit: false,
  },
  { ...simple, name: 'endpoint-crossing', originHi: [1, 1, 3], range: [0, 2], requiredHit: false },
  { ...simple, name: 'outside', origin: [3, 3, 2], originHi: [3, 3, 2], requiredHit: false },
  { ...simple, name: 'parallel', direction: [1, 0, 0], directionHi: [1, 0, 0], requiredHit: false },
  {
    ...simple,
    name: 'zero-direction',
    direction: [0, 0, 0],
    directionHi: [0, 0, 0],
    requiredHit: false,
  },
  { ...simple, name: 'disabled', valid: 0, requiredHit: false },
  {
    ...simple,
    name: 'center-only-witness',
    origin: [-2, -2, 2],
    originHi: [4, 4, 2],
    requiredHit: false,
  },
  {
    ...actual,
    name: 'correlated-outside-W',
    origin: beyondEdge(actual.origin),
    originHi: beyondEdge(actual.originHi),
    requiredHit: false,
  },
  {
    ...actual,
    name: 'correlated-beyond-endpoint',
    range: [0, Math.fround(5.0509)],
    requiredHit: false,
  },
];

/** Independent exact dyadic corner equations, with no interval operator port.
 * Each numerator is multiaffine in independent origin/direction coordinates.
 * Once det keeps one strict sign, their signs and linear-fractional time bounds
 * throughout the box follow from these 64 vertices.
 */
export function correlatedTriangleOracle(row: CorrelatedCase) {
  const [a, b, c] = row.triangle.map((point) => point.map(q));
  if (!a || !b || !c) throw new Error('Three vertices required');
  const e1 = subtract(b, a),
    e2 = subtract(c, a),
    scale = 1n << 149n;
  const evaluate = (o: readonly bigint[], d: readonly bigint[]) => {
    const s = subtract(o, a),
      p = cross(d, e2),
      det = dot(e1, p);
    const sign = det < 0n ? -1n : 1n;
    const u = dot(s, p) * sign,
      v = dot(d, cross(s, e1)) * sign;
    const t = dot(e2, cross(s, e1)) * sign,
      magnitude = det * sign;
    const w = magnitude - u - v;
    // Independent identity check for the cyclic expression used by the refinement.
    const cyclicW = dot(subtract(b, o), cross(d, subtract(c, b))) * sign;
    if (w !== cyclicW) throw new Error('Cyclic numerator is not the same real expression');
    return {
      det,
      u,
      v,
      w,
      t,
      magnitude,
      afterRange: t * scale > q(row.range[1]) * magnitude,
      hit:
        det !== 0n &&
        u >= 0n &&
        v >= 0n &&
        w >= 0n &&
        t * scale >= q(row.range[0]) * magnitude &&
        t * scale <= q(row.range[1]) * magnitude,
    };
  };
  const corners = Array.from({ length: 64 }, (_, mask) =>
    evaluate(
      row.origin.map((lo, axis) => q(mask & (1 << axis) ? (row.originHi[axis] ?? lo) : lo)),
      row.direction.map((lo, axis) =>
        q(mask & (1 << (axis + 3)) ? (row.directionHi[axis] ?? lo) : lo),
      ),
    ),
  );
  const center = evaluate(
    row.origin.map((lo, axis) => (q(lo) + q(row.originHi[axis] ?? lo)) / 2n),
    row.direction.map((lo, axis) => (q(lo) + q(row.directionHi[axis] ?? lo)) / 2n),
  );
  const sameSign =
    corners.every((corner) => corner.det > 0n) || corners.every((corner) => corner.det < 0n);
  return {
    corners,
    center,
    universalHit: row.valid !== 0 && sameSign && corners.every((corner) => corner.hit),
  };
}

export function assessCorrelatedTriangle(index: number, actual: Uint32Array) {
  const row = correlatedTriangleCases[index];
  if (!row || actual.length !== 4) throw new Error('One complete triangle result required');
  const oracle = correlatedTriangleOracle(row),
    failures: string[] = [];
  if (![0, 1, 2].includes(actual[0] ?? -1)) failures.push('invalid primitive result state');
  if (actual[0] === 0 && [...oracle.corners, oracle.center].some((point) => point.hit))
    failures.push('false universal primitive clear');
  if (row.requiredHit && actual[0] !== 1) failures.push('required universal interior hit absent');
  if (actual[0] === 1 && !oracle.universalHit) failures.push('false universal primitive hit');
  if (actual[0] === 1 && oracle.universalHit) {
    const lo = exactEndpointDyadic(actual[1] ?? 0),
      hi = exactEndpointDyadic(actual[2] ?? 0),
      scale = 1n << 149n;
    if (
      lo > hi ||
      oracle.corners.some(
        (corner) =>
          corner.t * scale < lo * corner.magnitude || corner.t * scale > hi * corner.magnitude,
      )
    )
      failures.push('exact real time outside returned enclosure');
    if (actual[3] !== ((oracle.corners[0]?.det ?? 0n) > 0n ? 1 : 0))
      failures.push('incorrect winding');
  }
  return failures;
}

export function correlatedTriangleInput() {
  const words = new Uint32Array(correlatedTriangleCases.length * 32);
  correlatedTriangleCases.forEach((row, index) => {
    const at = index * 32;
    for (const [offset, value] of [
      [0, row.origin],
      [4, row.originHi],
      [8, row.direction],
      [12, row.directionHi],
      [20, row.triangle[0]],
      [24, row.triangle[1]],
      [28, row.triangle[2]],
    ] as const)
      words.set(value.map(bits), at + offset);
    words.set([bits(row.range[0]), bits(row.range[1]), row.valid ?? 1, 0], at + 16);
  });
  return new Uint8Array(words.buffer);
}

export const correlatedTriangleKernel =
  SDF_SURFACE_INTERSECTION_WGSL +
  `
@group(0) @binding(0) var<storage,read> rows:array<vec4u>;
@group(0) @binding(1) var<storage,read_write> results:array<vec4u>;
@compute @workgroup_size(1) fn correlatedTriangle(@builtin(global_invocation_id) id:vec3u){
 let at=id.x*8u;if(at+7u>=arrayLength(&rows)){return;}
 let r=rows[at+4u];
 let ray=SdfSurfaceRay(rows[at].xyz,rows[at+1u].xyz,rows[at+2u].xyz,rows[at+3u].xyz,r.xy,r.z);
 let hit=sdfSurfaceTriangle(ray,rows[at+5u].xyz,rows[at+6u].xyz,rows[at+7u].xyz);
 results[id.x]=vec4u(hit.state,bitcast<u32>(hit.tLower),bitcast<u32>(hit.tUpper),hit.frontFace);
}`;

/** Controlled old-path negative control, retaining the same module and inputs. */
export function correlatedTriangleWithoutRefinement() {
  const start = correlatedTriangleKernel.indexOf(' // Only refine the unresolved path.');
  const end = correlatedTriangleKernel.indexOf(
    ' return SdfSurfaceIntersection(2u,lo,hi,frontFace);',
    start,
  );
  if (start < 0 || end < start) throw new Error('Unique unresolved-tail refinement required');
  return correlatedTriangleKernel.slice(0, start) + correlatedTriangleKernel.slice(end);
}
