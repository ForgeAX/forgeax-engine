/** Independent, authored integer geometry and diagnostic qualification oracle.
 * It does not execute WGSL or establish a production GPU result. */
export type ClearancePoint = readonly [number, number, number];
type IntegerPoint = readonly [bigint, bigint, bigint];
export type ClearanceState = 'active' | 'inside' | 'pending' | 'untraced' | 'invalid';
export interface ClearanceCandidate {
  readonly id: string;
  readonly point: ClearancePoint;
  readonly state: ClearanceState;
  readonly updates: number;
  readonly trilinear: number;
  readonly angularSupport: boolean;
  readonly color: readonly [number, number, number];
  readonly transportAvailable: boolean;
}
export interface ClearanceWitness {
  readonly receiver: ClearancePoint;
  readonly normal: ClearancePoint;
  readonly biased: ClearancePoint;
  readonly anchor: ClearancePoint;
  readonly ordinary: readonly ClearanceCandidate[];
  readonly alternative: readonly ClearanceCandidate[];
  readonly anchorAvailable: boolean;
}

function integerPoint(point: ClearancePoint): IntegerPoint {
  if (!point.every(Number.isSafeInteger)) throw new Error('Oracle requires authored integers');
  return [BigInt(point[0]), BigInt(point[1]), BigInt(point[2])];
}
function difference(a: IntegerPoint, b: IntegerPoint): IntegerPoint {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: IntegerPoint, b: IntegerPoint): IntegerPoint {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: IntegerPoint, b: IntegerPoint): bigint {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
/** Closed-triangle intersection by independent plane and oriented halfspaces.
 * All divisions are eliminated with a positive integer denominator. */
export function authoredTriangleBlocks(
  origin: ClearancePoint,
  endpoint: ClearancePoint,
  triangle: readonly [ClearancePoint, ClearancePoint, ClearancePoint],
): boolean {
  const o = integerPoint(origin),
    delta = difference(integerPoint(endpoint), o);
  const [a, b, c] = triangle.map(integerPoint) as [IntegerPoint, IntegerPoint, IntegerPoint];
  const normal = cross(difference(b, a), difference(c, a));
  let denominator = dot(normal, delta),
    numerator = dot(normal, difference(a, o));
  if (dot(normal, normal) === 0n) throw new Error('Degenerate oracle triangle');
  if (denominator === 0n) {
    if (numerator === 0n) throw new Error('Coplanar oracle domain is deliberately unsupported');
    return false;
  }
  if (denominator < 0n) {
    denominator = -denominator;
    numerator = -numerator;
  }
  if (numerator < 0n || numerator > denominator) return false;
  const hit: IntegerPoint = [
    o[0] * denominator + delta[0] * numerator,
    o[1] * denominator + delta[1] * numerator,
    o[2] * denominator + delta[2] * numerator,
  ];
  for (const [first, second] of [
    [a, b],
    [b, c],
    [c, a],
  ] as const) {
    const relative: IntegerPoint = [
      hit[0] - first[0] * denominator,
      hit[1] - first[1] * denominator,
      hit[2] - first[2] * denominator,
    ];
    if (dot(cross(difference(second, first), relative), normal) < 0n) return false;
  }
  return true;
}
const wallVertices: readonly ClearancePoint[] = [
  [-1, -16, -16],
  [1, -16, -16],
  [1, 16, -16],
  [-1, 16, -16],
  [-1, -16, 16],
  [1, -16, 16],
  [1, 16, 16],
  [-1, 16, 16],
];
const wallFaces = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [3, 6, 2],
  [3, 7, 6],
  [0, 4, 7],
  [0, 7, 3],
  [1, 2, 6],
  [1, 6, 5],
] as const;
/** Complete twelve-triangle authored opaque slab x in[-1,1], |y/z|<=16. */
export function authoredTransportClear(origin: ClearancePoint, endpoint: ClearancePoint): boolean {
  return !wallFaces.some((face) =>
    authoredTriangleBlocks(
      origin,
      endpoint,
      face.map((i) => wallVertices[i]) as [ClearancePoint, ClearancePoint, ClearancePoint],
    ),
  );
}
export const qualificationBoxes80 = [
  [
    [70, -80, 140],
    [90, 320, 180],
  ],
  [
    [150, -80, 150],
    [170, 320, 170],
  ],
] as const;
export function authoredBoxClear(
  origin: ClearancePoint,
  endpoint: ClearancePoint,
  lo: ClearancePoint,
  hi: ClearancePoint,
): boolean {
  const vertices = [
    [lo[0], lo[1], lo[2]],
    [hi[0], lo[1], lo[2]],
    [hi[0], hi[1], lo[2]],
    [lo[0], hi[1], lo[2]],
    [lo[0], lo[1], hi[2]],
    [hi[0], lo[1], hi[2]],
    [hi[0], hi[1], hi[2]],
    [lo[0], hi[1], hi[2]],
  ] as const;
  return !wallFaces.some((face) =>
    authoredTriangleBlocks(
      origin,
      endpoint,
      face.map((i) => vertices[i]) as [ClearancePoint, ClearancePoint, ClearancePoint],
    ),
  );
}
export function authoredBoxesClear(origin: ClearancePoint, endpoint: ClearancePoint): boolean {
  return qualificationBoxes80.every(([lo, hi]) => authoredBoxClear(origin, endpoint, lo, hi));
}
function geometricCandidate(witness: ClearanceWitness, candidate: ClearanceCandidate): boolean {
  const side = candidate.point.reduce(
    (sum, value, axis) =>
      sum + (value - (witness.receiver[axis] ?? 0)) * (witness.normal[axis] ?? 0),
    0,
  );
  return side > 0 && candidate.trilinear > 0;
}
function unavailable(candidate: ClearanceCandidate): boolean {
  return (
    candidate.state === 'untraced' ||
    candidate.state === 'invalid' ||
    !candidate.transportAvailable ||
    (candidate.state === 'active' && !candidate.angularSupport)
  );
}
/** Expected support comes from complete independent alternative qualifications;
 * no pending color/history is ever inspected. Black with support is valid. */
export function independentClearanceQualification(witness: ClearanceWitness): boolean {
  const ordinary = witness.ordinary.filter((c) => geometricCandidate(witness, c));
  if (ordinary.some(unavailable)) return false;
  const pending = ordinary.filter((c) => c.state === 'pending');
  if (pending.some((c) => c.updates !== 0)) return false;
  if (!witness.anchorAvailable || !authoredTransportClear(witness.biased, witness.anchor))
    return false;
  let supported = false;
  for (const candidate of witness.alternative.filter((c) => geometricCandidate(witness, c))) {
    if (candidate.state === 'inside') continue;
    if (candidate.state !== 'active' || unavailable(candidate)) return false;
    if (
      authoredTransportClear(witness.anchor, candidate.point) &&
      authoredTransportClear(witness.biased, candidate.point)
    )
      supported = true;
  }
  return supported;
}
/** CPU diagnostic model of the sealed source's original fallbackAllowed policy.
 * It is explicitly not a CPU execution or independent oracle for WGSL. */
export function legacyFallbackPolicyModel(witness: ClearanceWitness): boolean {
  return witness.ordinary
    .filter((c) => geometricCandidate(witness, c))
    .every(
      (c) =>
        c.state === 'inside' || (c.state === 'active' && c.angularSupport && c.transportAvailable),
    );
}
const candidate = (
  id: string,
  point: ClearancePoint,
  state: ClearanceState,
): ClearanceCandidate => ({
  id,
  point,
  state,
  updates: state === 'pending' ? 0 : 1,
  trilinear: 0.25,
  angularSupport: true,
  color: [0.25, 0.125, 0.5],
  transportAvailable: true,
});
export function clearanceQualificationWitness(): ClearanceWitness {
  return {
    receiver: [3, 0, 0],
    normal: [0, 1, 0],
    biased: [3, 2, 0],
    anchor: [3, 1, 0],
    anchorAvailable: true,
    ordinary: [
      candidate('known-occluded', [-4, 8, 0], 'active'),
      candidate('pending-never-sampled', [4, 4, 4], 'pending'),
    ],
    alternative: [
      candidate('front-left', [4, 8, -4], 'active'),
      candidate('front-right', [4, 8, 4], 'active'),
      candidate('front-centre', [8, 8, 0], 'active'),
    ],
  };
}
