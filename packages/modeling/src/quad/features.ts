import { atan2 } from '../dmath';
import { cross, dot, faceNormal, sub, type Tuple3 } from '../geom';
import { EDGE_SHARP, type EditMesh, NONE } from '../mesh';

/** An AI-authored feature: a polyline the output must reproduce within `tolerance` (metres of the case). */
export interface FeatureConstraint {
  readonly id: string;
  readonly polyline: readonly Tuple3[];
  readonly tolerance: number;
}

export interface FeatureDeviation {
  readonly max: number;
  readonly byConstraint: Readonly<Record<string, number>>;
  /** Groups whose max deviation exceeds their tolerance. */
  readonly unresolved: readonly string[];
}

interface Segment {
  readonly a: Tuple3;
  readonly b: Tuple3;
  readonly bounds: Bounds;
  readonly center: Tuple3;
}

type Bounds = readonly [number, number, number, number, number, number];

interface Node {
  readonly bounds: Bounds;
  readonly left?: Node;
  readonly right?: Node;
  readonly segments?: readonly Segment[];
}

interface SegmentVerdict {
  readonly distance: number;
  readonly unresolved: boolean;
}

interface ChainInterval {
  readonly low: number;
  readonly high: number;
  readonly lowDistance: number;
  readonly highDistance: number;
  readonly limit: number;
}

const MAX_SUBDIVISION_DEPTH = 64;
const MAX_SAMPLE_BUDGET = 32_768;
const MAX_CANDIDATE_BUDGET = 65_536;
const MIN_ORDINARY = 1e-30;
const MAX_ORDINARY = 1e30;
/*
 * Certification is restricted to ordinary magnitudes: every nonzero coordinate, tolerance and coordinate extent lies in
 * [1e-30, 1e30]; anything else is unresolved. Let M bound |coordinate| and the tolerance of one evaluation and
 * u = EPSILON / 2. Then no product overflows (< 1e62), and an underflowed square perturbs a distance by < 1e-153.
 * For any computed t in [0, 1], u + t * (v - u) lies on segment uv, so the computed |p - u - t * fl(v - u)| bounds the
 * true point-segment distance from above up to rounding: four component operations err by <= 10uM each (8.7 EPSILON M
 * as a vector) and the norm of a vector below 7M by <= 2.5u relative (9 EPSILON M). A feature point a + s * fl(b - a)
 * errs by <= 6.1 EPSILON M, a half chord max(t - t0, t1 - t) * |fl(b - a)| by <= 10 EPSILON M, and the final sums and
 * the subtraction from the tolerance by <= 2 EPSILON M. The total is below 36 EPSILON M; 256 EPSILON M leaves 7x
 * margin, so `estimate + slack <= tolerance` proves the exact distance is within tolerance.
 */
const ROUNDING_SLACK = 256 * Number.EPSILON;
const floatBits = new DataView(new ArrayBuffer(8));
const UNRESOLVED: SegmentVerdict = { distance: Infinity, unresolved: true };

class SegmentIndex {
  readonly root: Node | undefined;

  constructor(segments: readonly Segment[]) {
    this.root = buildNode([...segments]);
  }

  within(point: Tuple3, radius: number, visit: (segment: Segment) => void): void {
    this.intersecting(expandedPointBounds(point, radius), visit);
  }

  intersecting(bounds: Bounds, visit: (segment: Segment) => boolean | void): void {
    if (this.root === undefined) return;
    const walk = (node: Node): boolean => {
      if (!boundsOverlap(bounds, node.bounds)) return false;
      if (node.segments !== undefined) {
        for (const item of node.segments)
          if (boundsOverlap(bounds, item.bounds) && visit(item) === true) return true;
        return false;
      }
      return walk(node.left as Node) || walk(node.right as Node);
    };
    walk(this.root);
  }
}

/** Edge ids that must stay edges: flagged sharp, dihedral above `sharpDegrees`, or lying on a constraint polyline. */
export function protectedEdges(
  mesh: EditMesh,
  sharpDegrees: number,
  constraints: readonly FeatureConstraint[],
): Set<number> {
  const out = new Set<number>();
  const minDihedral = (sharpDegrees * Math.PI) / 180;
  for (const e of mesh.edges()) {
    if (((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0) out.add(e);
    else if (dihedralOf(mesh, e) > minDihedral) out.add(e);
  }
  const indexed: (Segment & {
    readonly group: number;
    readonly tolerance: number;
  })[] = [];
  for (let group = 0; group < constraints.length; group++) {
    const constraint = constraints[group] as FeatureConstraint;
    for (let i = 0; i + 1 < constraint.polyline.length; i++) {
      const a = constraint.polyline[i] as Tuple3;
      const b = constraint.polyline[i + 1] as Tuple3;
      indexed.push({ ...segment(a, b), group, tolerance: constraint.tolerance });
    }
  }
  if (indexed.length === 0) return out;
  const index = new SegmentIndex(indexed);
  const maxTolerance = constraints.reduce(
    (maximum, constraint) => Math.max(maximum, constraint.tolerance),
    0,
  );
  for (const e of mesh.edges()) {
    if (out.has(e)) continue;
    const [a, b] = edgeEnds(mesh, e);
    const pa = mesh.position(a);
    const pb = mesh.position(b);
    const mid = midpoint(pa, pb);
    const first = constraintsNearPoint(pa, index, maxTolerance);
    if (first.size === 0) continue;
    const second = constraintsNearPoint(pb, index, maxTolerance);
    const middle = constraintsNearPoint(mid, index, maxTolerance);
    for (const group of first) {
      if (second.has(group) && middle.has(group)) {
        out.add(e);
        break;
      }
    }
  }
  return out;
}

/** Unsigned dihedral angle in radians between the two faces of edge e (0 for boundary edges). */
export function dihedralOf(mesh: EditMesh, e: number): number {
  const f0 = mesh.hFace[e * 2] as number;
  const f1 = mesh.hFace[e * 2 + 1] as number;
  if (f0 === NONE || f1 === NONE) return 0;
  const n0 = faceNormal(mesh, f0);
  const n1 = faceNormal(mesh, f1);
  const c = cross(n0, n1);
  return atan2(Math.sqrt(dot(c, c)), dot(n0, n1));
}

/** Conservative maximum distance from each constraint segment to the selected output-edge set. */
export function featureDeviation(
  mesh: EditMesh,
  groups: readonly {
    readonly id: string;
    readonly segments: readonly (readonly [Tuple3, Tuple3])[];
    readonly tolerance: number;
  }[],
  faceIds: Iterable<number> = mesh.faces(),
): FeatureDeviation {
  return featureDeviationForTest(mesh, groups, MAX_SUBDIVISION_DEPTH, faceIds);
}

export function featureDeviationForTest(
  mesh: EditMesh,
  groups: readonly {
    readonly id: string;
    readonly segments: readonly (readonly [Tuple3, Tuple3])[];
    readonly tolerance: number;
  }[],
  depthLimit: number,
  faceIds: Iterable<number> = mesh.faces(),
): FeatureDeviation {
  const edgeIds = new Set<number>();
  for (const f of faceIds) {
    if (!mesh.isFaceAlive(f)) continue;
    for (const h of mesh.faceHalves(f)) edgeIds.add(h >> 1);
  }
  const edgeSegments = [...edgeIds].map((e) => {
    const [a, b] = edgeEnds(mesh, e);
    return segment(mesh.position(a), mesh.position(b));
  });
  const ordinaryMesh = edgeSegments.every((item) => ordinarySegment(item.a, item.b));
  const edgeIndex = new SegmentIndex(edgeSegments);
  const byConstraint: Record<string, number> = Object.create(null) as Record<string, number>;
  const unresolved: string[] = [];
  let max = 0;
  for (const group of groups) {
    let groupWorst = 0;
    let groupUnresolved = false;
    for (const [a, b] of group.segments) {
      const result = ordinaryMesh
        ? localFeatureDeviation(a, b, edgeIndex, group.tolerance, depthLimit)
        : UNRESOLVED;
      groupWorst = Math.max(groupWorst, result.distance);
      groupUnresolved ||= result.unresolved;
    }
    byConstraint[group.id] = groupUnresolved ? Infinity : groupWorst;
    max = Math.max(max, byConstraint[group.id] as number);
    if (groupUnresolved) unresolved.push(group.id);
  }
  return { max, byConstraint, unresolved };
}

/** The polyline of each constraint as segments, for featureDeviation. */
export function constraintSegments(
  constraints: readonly FeatureConstraint[],
): { id: string; segments: [Tuple3, Tuple3][]; tolerance: number }[] {
  return constraints.map((c) => {
    const segments: [Tuple3, Tuple3][] = [];
    for (let i = 0; i + 1 < c.polyline.length; i++) {
      segments.push([c.polyline[i] as Tuple3, c.polyline[i + 1] as Tuple3]);
    }
    return { id: c.id, segments, tolerance: c.tolerance };
  });
}

export function edgeEnds(mesh: EditMesh, e: number): [number, number] {
  return mesh.edgeVertices(e);
}

function localFeatureDeviation(
  a: Tuple3,
  b: Tuple3,
  edges: SegmentIndex,
  tolerance: number,
  depthLimit: number,
): SegmentVerdict {
  if (!(tolerance > 0) || !ordinary(tolerance) || !ordinarySegment(a, b)) return UNRESOLVED;
  const candidates: Segment[] = [];
  let exceededCandidateBudget = false;
  edges.intersecting(expandedSegmentBounds(a, b, tolerance), (edge) => {
    if (candidates.length < MAX_CANDIDATE_BUDGET) candidates.push(edge);
    else exceededCandidateBudget = true;
    return exceededCandidateBudget;
  });
  if (candidates.length === 0 || exceededCandidateBudget) return UNRESOLVED;
  for (const edge of candidates)
    if (
      (samePoint(edge.a, a) && samePoint(edge.b, b)) ||
      (samePoint(edge.a, b) && samePoint(edge.b, a))
    )
      return { distance: 0, unresolved: false };
  const featureMagnitude = Math.max(magnitude(a), magnitude(b), tolerance);
  const chain = chainCovers(a, b, candidates, tolerance, featureMagnitude);
  if (chain !== undefined) return chain;
  return lipschitzCoverage(a, b, edges, tolerance, featureMagnitude, depthLimit);
}

/*
 * Every interval lives in the one feature parameter frame s in [0, 1], point a + s * (b - a). An edge contributes
 * [low, high] when both parameter endpoints are within tolerance - slack of it; distance to a segment is convex along a
 * line, so the edge covers every point between them. The sorted union must reach both ends without an interior gap.
 * A stub at either end (a feature endpoint that projects just inside an edge end) is bridged by the 1-Lipschitz bound:
 * every point of the stub is within distance-at-the-covered-end + stub length, which must itself stay within the limit.
 */
function chainCovers(
  a: Tuple3,
  b: Tuple3,
  candidates: readonly Segment[],
  tolerance: number,
  featureMagnitude: number,
): SegmentVerdict | undefined {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) return undefined;
  const length = Math.sqrt(lengthSquared);
  const intervals: ChainInterval[] = [];
  for (const edge of candidates) {
    const first = clampUnit(
      ((edge.a[0] - a[0]) * dx + (edge.a[1] - a[1]) * dy + (edge.a[2] - a[2]) * dz) / lengthSquared,
    );
    const second = clampUnit(
      ((edge.b[0] - a[0]) * dx + (edge.b[1] - a[1]) * dy + (edge.b[2] - a[2]) * dz) / lengthSquared,
    );
    const low = first < second ? first : second;
    const high = first < second ? second : first;
    if (!(high > low)) continue;
    const limit = tolerance - slack(featureMagnitude, edge);
    const lowDistance = parameterDistance(a, dx, dy, dz, low, edge);
    if (!(lowDistance <= limit)) continue;
    const highDistance = parameterDistance(a, dx, dy, dz, high, edge);
    if (!(highDistance <= limit)) continue;
    intervals.push({ low, high, lowDistance, highDistance, limit });
  }
  if (intervals.length === 0) return undefined;
  intervals.sort((left, right) => left.low - right.low || left.high - right.high);
  const head = intervals[0] as ChainInterval;
  let worst = 0;
  let covered = 0;
  if (head.low > 0) {
    const bridged = head.lowDistance + head.low * length;
    if (!(bridged <= head.limit)) return undefined;
    worst = bridged;
    covered = head.low;
  }
  let tail = head;
  for (const interval of intervals) {
    if (interval.low > covered) return undefined;
    worst = Math.max(worst, interval.lowDistance, interval.highDistance);
    if (interval.high > covered) {
      covered = interval.high;
      tail = interval;
    }
    if (covered >= 1) return { distance: worst, unresolved: false };
  }
  const bridged = tail.highDistance + (1 - covered) * length;
  return bridged <= tail.limit
    ? { distance: Math.max(worst, bridged), unresolved: false }
    : undefined;
}

/** Distance to a closed set is 1-Lipschitz: a midpoint within tolerance - halfChord - slack covers its interval. */
function lipschitzCoverage(
  a: Tuple3,
  b: Tuple3,
  edges: SegmentIndex,
  tolerance: number,
  featureMagnitude: number,
  depthLimit: number,
): SegmentVerdict {
  const direction = sub(b, a);
  const length = Math.sqrt(dot(direction, direction));
  let budget = MAX_SAMPLE_BUDGET;
  let worst = 0;
  const covers = (t0: number, t1: number, depth: number): boolean => {
    if (budget-- <= 0) return false;
    const t = (t0 + t1) / 2;
    const point = pointAt(a, direction, t);
    const half = Math.max(t - t0, t1 - t) * length;
    let bound = Infinity;
    let nearest = Infinity;
    edges.within(point, tolerance, (edge) => {
      const distance = ordinaryPointSegmentDistance(point, edge.a, edge.b);
      bound = Math.min(bound, distance + slack(featureMagnitude, edge));
      nearest = Math.min(nearest, distance);
    });
    if (bound + half <= tolerance) {
      worst = Math.max(worst, nearest + half);
      return true;
    }
    if (nearest > tolerance || half === 0 || depth >= depthLimit) return false;
    return covers(t0, t, depth + 1) && covers(t, t1, depth + 1);
  };
  return covers(0, 1, 0) ? { distance: Math.min(worst, tolerance), unresolved: false } : UNRESOLVED;
}

function ordinaryPointSegmentDistance(point: Tuple3, a: Tuple3, b: Tuple3): number {
  return pointSegmentDistanceXYZ(point[0], point[1], point[2], a, b);
}

function parameterDistance(
  a: Tuple3,
  dx: number,
  dy: number,
  dz: number,
  s: number,
  edge: Segment,
): number {
  return pointSegmentDistanceXYZ(a[0] + s * dx, a[1] + s * dy, a[2] + s * dz, edge.a, edge.b);
}

function pointSegmentDistanceXYZ(px: number, py: number, pz: number, a: Tuple3, b: Tuple3): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const ez = b[2] - a[2];
  const ox = px - a[0];
  const oy = py - a[1];
  const oz = pz - a[2];
  const lengthSquared = ex * ex + ey * ey + ez * ez;
  const t = lengthSquared > 0 ? clampUnit((ox * ex + oy * ey + oz * ez) / lengthSquared) : 0;
  const x = ox - t * ex;
  const y = oy - t * ey;
  const z = oz - t * ez;
  return Math.sqrt(x * x + y * y + z * z);
}

function pointAt(a: Tuple3, direction: Tuple3, s: number): Tuple3 {
  return [a[0] + s * direction[0], a[1] + s * direction[1], a[2] + s * direction[2]];
}

function slack(featureMagnitude: number, edge: Segment): number {
  const bounds = edge.bounds;
  return (
    ROUNDING_SLACK *
    Math.max(featureMagnitude, -bounds[0], -bounds[1], -bounds[2], bounds[3], bounds[4], bounds[5])
  );
}

function clampUnit(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

function magnitude(point: Tuple3): number {
  return Math.max(Math.abs(point[0]), Math.abs(point[1]), Math.abs(point[2]));
}

function ordinary(value: number): boolean {
  const size = Math.abs(value);
  return size === 0 || (size >= MIN_ORDINARY && size <= MAX_ORDINARY);
}

function ordinarySegment(a: Tuple3, b: Tuple3): boolean {
  for (let axis = 0; axis < 3; axis++) {
    const from = a[axis] as number;
    const to = b[axis] as number;
    if (!ordinary(from) || !ordinary(to) || !ordinary(to - from)) return false;
  }
  return true;
}

function samePoint(a: Tuple3, b: Tuple3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function midpointCoordinate(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (!Number.isFinite(scale) || scale === 0) return scale;
  return (a / scale / 2 + b / scale / 2) * scale;
}

function midpoint(a: Tuple3, b: Tuple3): Tuple3 {
  return [
    midpointCoordinate(a[0], b[0]),
    midpointCoordinate(a[1], b[1]),
    midpointCoordinate(a[2], b[2]),
  ];
}

function constraintsNearPoint(
  point: Tuple3,
  index: SegmentIndex,
  maxTolerance: number,
): Set<number> {
  const near = new Set<number>();
  index.within(point, maxTolerance, (item) => {
    const deviation = pointSegmentDistance(point, item.a, item.b);
    if (deviation > (item as Segment & { readonly tolerance: number }).tolerance) return;
    near.add((item as Segment & { readonly group: number }).group);
  });
  return near;
}

function buildNode(segments: Segment[]): Node | undefined {
  if (segments.length === 0) return undefined;
  const bounds = boundsOf(segments);
  if (segments.length <= 8) return { bounds, segments };
  const centerBounds = boundsOfPoints(segments.map((item) => item.center));
  const extent: [number, number, number] = [
    (centerBounds[3] as number) - (centerBounds[0] as number),
    (centerBounds[4] as number) - (centerBounds[1] as number),
    (centerBounds[5] as number) - (centerBounds[2] as number),
  ];
  const axis =
    extent[0] >= extent[1] && extent[0] >= extent[2] ? 0 : extent[1] >= extent[2] ? 1 : 2;
  segments.sort((left, right) => left.center[axis] - right.center[axis]);
  const middle = segments.length >>> 1;
  return {
    bounds,
    left: buildNode(segments.slice(0, middle)) as Node,
    right: buildNode(segments.slice(middle)) as Node,
  };
}

function segment(a: Tuple3, b: Tuple3): Segment {
  return {
    a,
    b,
    bounds: [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.min(a[2], b[2]),
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.max(a[2], b[2]),
    ],
    center: interpolate(a, b, 0.5),
  };
}

function boundsOf(segments: readonly Segment[]): Bounds {
  return boundsOfPoints(
    segments.flatMap(({ bounds }) => [
      [bounds[0], bounds[1], bounds[2]],
      [bounds[3], bounds[4], bounds[5]],
    ]),
  );
}

function boundsOfPoints(points: readonly Tuple3[]): Bounds {
  const bounds: [number, number, number, number, number, number] = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ];
  for (const point of points)
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis] as number, point[axis] as number);
      bounds[axis + 3] = Math.max(bounds[axis + 3] as number, point[axis] as number);
    }
  return bounds;
}

function expandedSegmentBounds(a: Tuple3, b: Tuple3, radius: number): Bounds {
  return [
    nextDown(Math.min(a[0], b[0]) - radius),
    nextDown(Math.min(a[1], b[1]) - radius),
    nextDown(Math.min(a[2], b[2]) - radius),
    nextUp(Math.max(a[0], b[0]) + radius),
    nextUp(Math.max(a[1], b[1]) + radius),
    nextUp(Math.max(a[2], b[2]) + radius),
  ];
}

function expandedPointBounds(point: Tuple3, radius: number): Bounds {
  return [
    nextDown(point[0] - radius),
    nextDown(point[1] - radius),
    nextDown(point[2] - radius),
    nextUp(point[0] + radius),
    nextUp(point[1] + radius),
    nextUp(point[2] + radius),
  ];
}

function nextUp(value: number): number {
  if (value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  floatBits.setFloat64(0, value, false);
  let high = floatBits.getUint32(0, false);
  let low = floatBits.getUint32(4, false);
  if (value > 0) {
    low = (low + 1) >>> 0;
    if (low === 0) high = (high + 1) >>> 0;
  } else if (low === 0) {
    high = (high - 1) >>> 0;
    low = 0xffff_ffff;
  } else low = (low - 1) >>> 0;
  floatBits.setUint32(0, high, false);
  floatBits.setUint32(4, low, false);
  return floatBits.getFloat64(0, false);
}

function nextDown(value: number): number {
  if (value === -Infinity) return value;
  if (value === 0) return -Number.MIN_VALUE;
  floatBits.setFloat64(0, value, false);
  let high = floatBits.getUint32(0, false);
  let low = floatBits.getUint32(4, false);
  if (value > 0) {
    if (low === 0) {
      high = (high - 1) >>> 0;
      low = 0xffff_ffff;
    } else low = (low - 1) >>> 0;
  } else {
    low = (low + 1) >>> 0;
    if (low === 0) high = (high + 1) >>> 0;
  }
  floatBits.setUint32(0, high, false);
  floatBits.setUint32(4, low, false);
  return floatBits.getFloat64(0, false);
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2]
  );
}

function pointSegmentDistance(point: Tuple3, a: Tuple3, b: Tuple3): number {
  const direction = difference3(b, a);
  const offset = difference3(point, a);
  if (direction.every((component) => component === 0)) return norm(offset);
  if (![...direction, ...offset].every(Number.isFinite)) return Infinity;
  const t = projectionParameter(offset, direction);
  if (!Number.isFinite(t)) return Infinity;
  const clamped = Math.min(1, Math.max(0, t));
  return norm([
    scaledResidual(offset[0], direction[0], clamped),
    scaledResidual(offset[1], direction[1], clamped),
    scaledResidual(offset[2], direction[2], clamped),
  ]);
}

export function pointLineDistance(point: Tuple3, origin: Tuple3, direction: Tuple3): number {
  const offset = difference3(point, origin);
  if (![...direction, ...offset].every(Number.isFinite)) return Infinity;
  if (direction.every((component) => component === 0)) return norm(offset);
  const t = projectionParameter(offset, direction);
  if (!Number.isFinite(t)) return Infinity;
  return norm([
    scaledResidual(offset[0], direction[0], t),
    scaledResidual(offset[1], direction[1], t),
    scaledResidual(offset[2], direction[2], t),
  ]);
}

function projectionParameter(offset: Tuple3, direction: Tuple3): number {
  const directionScale = Math.max(
    Math.abs(direction[0]),
    Math.abs(direction[1]),
    Math.abs(direction[2]),
  );
  const offsetScale = Math.max(Math.abs(offset[0]), Math.abs(offset[1]), Math.abs(offset[2]));
  if (directionScale === 0) return offsetScale === 0 ? 0 : Number.NaN;
  if (offsetScale === 0) return 0;
  const d: Tuple3 = [
    direction[0] / directionScale,
    direction[1] / directionScale,
    direction[2] / directionScale,
  ];
  const p: Tuple3 = [offset[0] / offsetScale, offset[1] / offsetScale, offset[2] / offsetScale];
  const factor = dot(p, d) / dot(d, d);
  const t =
    offsetScale <= directionScale
      ? factor * (offsetScale / directionScale)
      : Math.abs(factor) <= 1
        ? (factor * offsetScale) / directionScale
        : (offsetScale / directionScale) * factor;
  return Number.isFinite(t) ? t : Number.NaN;
}

function scaledResidual(offset: number, direction: number, t: number): number {
  const scale = Math.max(Math.abs(offset), Math.abs(direction));
  if (scale === 0) return 0;
  return (offset / scale - (direction / scale) * t) * scale;
}

function difference3(a: Tuple3, b: Tuple3): Tuple3 {
  return [difference(a[0], b[0]), difference(a[1], b[1]), difference(a[2], b[2])];
}

function difference(a: number, b: number): number {
  const delta = a - b;
  if (Number.isFinite(delta)) return delta;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (!Number.isFinite(scale) || scale === 0) return Number.NaN;
  return (a / scale - b / scale) * scale;
}

function norm(vector: Tuple3): number {
  const scale = Math.max(Math.abs(vector[0]), Math.abs(vector[1]), Math.abs(vector[2]));
  if (!Number.isFinite(scale)) return Infinity;
  if (scale === 0) return 0;
  const x = vector[0] / scale;
  const y = vector[1] / scale;
  const z = vector[2] / scale;
  return scale * Math.sqrt(x * x + y * y + z * z);
}

function interpolate(a: Tuple3, b: Tuple3, t: number): Tuple3 {
  if (!Number.isFinite(t)) return [Number.NaN, Number.NaN, Number.NaN];
  const scale = Math.max(
    Math.abs(a[0]),
    Math.abs(a[1]),
    Math.abs(a[2]),
    Math.abs(b[0]),
    Math.abs(b[1]),
    Math.abs(b[2]),
  );
  if (!Number.isFinite(scale)) return [Number.NaN, Number.NaN, Number.NaN];
  if (scale === 0) return [0, 0, 0];
  return [
    (a[0] / scale + (b[0] / scale - a[0] / scale) * t) * scale,
    (a[1] / scale + (b[1] / scale - a[1] / scale) * t) * scale,
    (a[2] / scale + (b[2] / scale - a[2] / scale) * t) * scale,
  ];
}
