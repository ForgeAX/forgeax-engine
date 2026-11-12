import { ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import { bridge } from './connect';
import { atan2, cos, hypot2, sin } from './dmath';
import type { ModelingError } from './errors';
import { add, cross, dot, length, normalize, scale, sub, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import { markRole, type OpDiagnostic, type RoleCounts, requireFinite } from './ops';
import {
  arcPoint,
  arcTangent,
  type BendArc,
  buildArc,
  carryFrames,
  type FrameBasis,
  type PipeBendOptions,
  readBend,
} from './pipe-bend';
import { invalid, type PipeWeldOptions, refuse, weldNetwork } from './pipe-weld';
import { type SubdivideContext, subdivide } from './subdivide';
import { segmentDistance } from './sweep';

export interface PipeNetworkOptions {
  /** Skeleton node positions in meters. */
  readonly nodes: readonly Tuple3[];
  /** Struts as node index pairs; every node belongs to at least one. */
  readonly edges: readonly (readonly [number, number])[];
  /** Default tube radius of a strut end (meters), measured on the output mesh. */
  readonly radius: number;
  /**
   * Radius of the struts ending at each node; overrides `radius`. A strut between two nodes
   * of different radius tapers linearly between them.
   */
  readonly nodeRadius?: readonly number[];
  /**
   * Radius per edge, overriding `nodeRadius`: one number for the whole strut, or
   * `[at edges[e][0], at edges[e][1]]`.
   */
  readonly edgeRadius?: readonly (number | readonly [number, number])[];
  /** Quads around every strut cage ring (even, 4 to 64; default 8). */
  readonly ringSegments?: number;
  /** Cage quad rows along every strut (default 2). */
  readonly strutSegments?: number;
  /** Catmull-Clark levels applied to the cage (1 to 3; default 1). */
  readonly levels?: number;
  /**
   * Hard joint instead of the rounded soft joint: tubes of `ringSegments` sides (default 16)
   * unioned exactly, with a rolling-ball fillet of `weld.radius` along every intersection.
   * Excludes `levels`; faces carry `node:<i>`, `strut:<e>` and `weld:<owning joint>`.
   */
  readonly weld?: PipeWeldOptions;
  /**
   * Circular elbows at the degree-two nodes: the two struts stop `radius * tan(turn / 2)`
   * short of the node and a constant-section arc of centreline radius `bend.radius` joins them,
   * faces `node:<i>` with role `bend`. Soft joint only; `bend.radius` below 1.25 tube radii is
   * `model-precondition` (`bend-radius`); too few rows is `bend-segments`.
   */
  readonly bend?: PipeBendOptions;
}

const MIN_ANGLE_COS = 0.9659258262890683;
const MIN_RING_DISTANCE = 1.5;
const NODE_MARGIN = 1.15;
const TIGHT_COS = 0.766;
const CLEARANCE = 1.5;
const MAX_RING = 64;
const BEND_STATIONS = [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98];
const ROUND_WARN = 0.06;

function widestPair(list: readonly Branch[]): { widest: number; pair: [Branch, Branch] } {
  let widest = -1;
  let pair: [Branch, Branch] = [list[0] as Branch, list[0] as Branch];
  for (let p = 0; p < list.length; p++) {
    for (let q = p + 1; q < list.length; q++) {
      const c = dot((list[p] as Branch).dir, (list[q] as Branch).dir);
      if (c > widest) {
        widest = c;
        pair = [list[p] as Branch, list[q] as Branch];
      }
    }
  }
  return { widest, pair };
}

interface Branch {
  readonly edge: number;
  readonly other: number;
  readonly dir: Tuple3;
}

/** Mean radius of a unit regular m-gon after `levels` Catmull-Clark rounds of a straight tube. */
function tubeFactor(m: number, levels: number): number {
  let ring: Tuple3[] = [];
  for (let k = 0; k < m; k++) {
    const a = (2 * Math.PI * k) / m;
    ring.push([cos(a), sin(a), 0]);
  }
  for (let l = 0; l < levels; l++) {
    const next: Tuple3[] = [];
    const n = ring.length;
    for (let k = 0; k < n; k++) {
      const p = ring[k] as Tuple3;
      const before = ring[(k + n - 1) % n] as Tuple3;
      const after = ring[(k + 1) % n] as Tuple3;
      next.push(scale(add(add(before, after), scale(p, 6)), 1 / 8));
      next.push(scale(add(p, after), 1 / 2));
    }
    ring = next;
  }
  return ring.reduce((sum, p) => sum + hypot2(p[0], p[1]), 0) / ring.length;
}

interface HullFace {
  a: number;
  b: number;
  c: number;
  n: Tuple3;
  d: number;
  alive: boolean;
}

function hullFace(points: readonly Tuple3[], a: number, b: number, c: number): HullFace {
  const pa = points[a] as Tuple3;
  const n = normalize(cross(sub(points[b] as Tuple3, pa), sub(points[c] as Tuple3, pa)));
  return { a, b, c, n, d: dot(n, pa), alive: true };
}

/** Triangles of the convex hull, counter-clockwise from outside; undefined when the points are flat. */
function convexHull(points: readonly Tuple3[]): [number, number, number][] | undefined {
  const count = points.length;
  const at = (i: number) => points[i] as Tuple3;
  let i0 = 0;
  for (let i = 1; i < count; i++) if ((at(i)[0] as number) < (at(i0)[0] as number)) i0 = i;
  const farthest = (score: (i: number) => number) => {
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < count; i++) {
      const s = score(i);
      if (s > bestScore) {
        best = i;
        bestScore = s;
      }
    }
    return { best, score: bestScore };
  };
  const first = farthest((i) => length(sub(at(i), at(i0))));
  const i1 = first.best;
  const line = sub(at(i1), at(i0));
  const second = farthest((i) => length(cross(line, sub(at(i), at(i0)))));
  const i2 = second.best;
  const normal = normalize(cross(line, sub(at(i2), at(i0))));
  const third = farthest((i) => Math.abs(dot(normal, sub(at(i), at(i0)))));
  const i3 = third.best;
  if (first.score < 1e-9 || second.score < 1e-12 || third.score < 1e-9) return undefined;
  const faces: HullFace[] = [];
  const seed = (a: number, b: number, c: number, opposite: number) => {
    const f = hullFace(points, a, b, c);
    faces.push(dot(f.n, at(opposite)) - f.d > 0 ? hullFace(points, a, c, b) : f);
  };
  seed(i0, i1, i2, i3);
  seed(i0, i1, i3, i2);
  seed(i0, i2, i3, i1);
  seed(i1, i2, i3, i0);
  for (let i = 0; i < count; i++) {
    if (i === i0 || i === i1 || i === i2 || i === i3) continue;
    const p = at(i);
    const visible = faces.filter((f) => f.alive && dot(f.n, p) - f.d > 1e-13);
    if (visible.length === 0) continue;
    const directed = new Set<number>();
    for (const f of visible) {
      directed.add(f.a * count + f.b);
      directed.add(f.b * count + f.c);
      directed.add(f.c * count + f.a);
    }
    for (const f of visible) {
      f.alive = false;
      for (const [a, b] of [
        [f.a, f.b],
        [f.b, f.c],
        [f.c, f.a],
      ] as const) {
        if (!directed.has(b * count + a)) faces.push(hullFace(points, a, b, i));
      }
    }
  }
  return faces.filter((f) => f.alive).map((f) => [f.a, f.b, f.c]);
}

function jitter(i: number, k: number): number {
  return (Math.imul(i * 3 + k + 1, 2654435761) >>> 8) / 16777216 - 0.5;
}

/** Distances from the axis through `at` of the mesh's edge crossings with the plane normal to it. */
function sectionRadii(
  mesh: EditMesh,
  faces: readonly number[],
  at: Tuple3,
  axis: Tuple3,
  reach: number,
): number[] {
  const radii: number[] = [];
  const signed = (v: number) => dot(sub(mesh.position(v), at), axis);
  for (const f of faces) {
    const loop = mesh.faceVertices(f);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const da = signed(a);
      const db = signed(b);
      if (!((da <= 0 && db > 0) || (da > 0 && db <= 0))) continue;
      const pa = mesh.position(a);
      const p = add(pa, scale(sub(mesh.position(b), pa), da / (da - db)));
      const rel = sub(p, at);
      const radial = sub(rel, scale(axis, dot(rel, axis)));
      const r = length(radial);
      if (r < reach) radii.push(r);
    }
  }
  return radii;
}

/**
 * Pipe network from a skeleton graph: every node of
 * degree >= 2 is the convex hull of one cage ring per branch (a sphere-like polyhedron
 * whose ring faces are the branch openings), every strut a quad band bridging two
 * rings of equal edge count, every leaf a flat cap; Catmull-Clark then rounds the cage
 * into an all-quad mesh. Faces carry label `node:<i>` (role `node`, or `cap` on a leaf)
 * and `strut:<i>` (role `strut`); `radius` is the output tube radius, compensated for
 * the shrink of the subdivision. A node with branches closer than 40 degrees refines at least two levels, since one level folds the tight hull. Branches closer than 15 degrees, struts too short for
 * their node openings and struts that pass within 1.5 radii of each other or of a foreign
 * node are `model-precondition` (detail.reason), never a self-intersecting mesh.
 */
export function pipeNetwork(
  mesh: EditMesh,
  options: PipeNetworkOptions,
  context: SubdivideContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const radius = requireFinite('radius', options.radius);
  if (!radius.ok) return radius;
  if (!(options.radius > 0)) return invalid('radius is greater than 0', { radius: options.radius });
  if (options.radius < 10 * context.tolerance) {
    return refuse(
      'radius is at least ten times the model tolerance',
      'radius-small',
      { radius: options.radius, tolerance: context.tolerance },
      'raise radius or build the network at a larger scale',
    );
  }
  if (
    options.weld !== undefined &&
    (typeof options.weld !== 'object' || options.weld === null || Array.isArray(options.weld))
  ) {
    return invalid('weld is an object { radius, segments?, end? }', { weld: options.weld });
  }
  const positive = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;
  const ringSegments = options.ringSegments ?? (options.weld === undefined ? 8 : 16);
  if (
    !Number.isInteger(ringSegments) ||
    ringSegments < 4 ||
    ringSegments > MAX_RING ||
    ringSegments % 2 !== 0
  ) {
    return invalid(`ringSegments is an even integer from 4 to ${MAX_RING}`, { ringSegments });
  }
  const strutSegments = options.strutSegments ?? (options.weld === undefined ? 4 : 1);
  if (!Number.isInteger(strutSegments) || strutSegments < 1 || strutSegments > 64) {
    return invalid('strutSegments is an integer from 1 to 64', { strutSegments });
  }
  if (options.weld !== undefined && options.bend !== undefined) {
    return invalid('bend belongs to the soft joint; a weld miters its own bends', {
      bend: options.bend,
    });
  }
  if (options.weld !== undefined && options.levels !== undefined) {
    return invalid('levels belongs to the soft joint; a weld has no subdivision', {
      levels: options.levels,
    });
  }
  const requested = options.levels ?? 1;
  if (!Number.isInteger(requested) || requested < 1 || requested > 3) {
    return invalid('levels is an integer from 1 to 3', { levels: requested });
  }
  const { nodes, edges } = options;
  if (!Array.isArray(nodes) || nodes.length === 0 || !Array.isArray(edges) || edges.length === 0) {
    return invalid('nodes and edges are non-empty lists', {
      nodes: nodes?.length,
      edges: edges?.length,
    });
  }
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i];
    if (
      !Array.isArray(p) ||
      p.length !== 3 ||
      !p.every((x) => typeof x === 'number' && Number.isFinite(x))
    ) {
      return invalid('every node is three finite coordinates', { node: i });
    }
  }
  const { nodeRadius, edgeRadius } = options;
  if (nodeRadius !== undefined) {
    if (
      !Array.isArray(nodeRadius) ||
      nodeRadius.length !== nodes.length ||
      !nodeRadius.every(positive)
    ) {
      return invalid('nodeRadius lists one positive radius per node', {
        nodeRadius: nodeRadius?.length,
        nodes: nodes.length,
      });
    }
  }
  if (edgeRadius !== undefined) {
    const good = (v: unknown) =>
      positive(v) || (Array.isArray(v) && v.length === 2 && v.every(positive));
    if (
      !Array.isArray(edgeRadius) ||
      edgeRadius.length !== edges.length ||
      !edgeRadius.every(good)
    ) {
      return invalid('edgeRadius lists a positive radius or a positive pair per edge', {
        edgeRadius: edgeRadius?.length,
        edges: edges.length,
      });
    }
  }
  const seen = new Set<number>();
  for (let e = 0; e < edges.length; e++) {
    const [i, j] = edges[e] as readonly [number, number];
    if (
      !Number.isInteger(i) ||
      !Number.isInteger(j) ||
      i < 0 ||
      j < 0 ||
      i >= nodes.length ||
      j >= nodes.length
    ) {
      return invalid('every edge joins two node indices', { edge: e, nodes: nodes.length });
    }
    if (i === j) return invalid('an edge joins two different nodes', { edge: e, node: i });
    const key = Math.min(i, j) * nodes.length + Math.max(i, j);
    if (seen.has(key))
      return invalid('every node pair has at most one edge', { edge: e, nodes: [i, j] });
    seen.add(key);
  }
  const point = (i: number) => nodes[i] as Tuple3;
  const branches: Branch[][] = nodes.map(() => []);
  for (let e = 0; e < edges.length; e++) {
    const [i, j] = edges[e] as readonly [number, number];
    const span = sub(point(j), point(i));
    const len = length(span);
    if (!(len > 0))
      return refuse('strut ends are distinct points', 'edge-short', { edge: e, length: len });
    const dir = scale(span, 1 / len);
    (branches[i] as Branch[]).push({ edge: e, other: j, dir });
    (branches[j] as Branch[]).push({ edge: e, other: i, dir: scale(dir, -1) });
  }
  for (let n = 0; n < nodes.length; n++) {
    if ((branches[n] as Branch[]).length === 0) {
      return invalid('every node belongs to an edge', { node: n });
    }
  }

  const endRadius = (edge: number, end: 0 | 1): number => {
    const spec = edgeRadius?.[edge];
    if (spec !== undefined) return typeof spec === 'number' ? spec : (spec[end] as number);
    const node = (edges[edge] as readonly [number, number])[end] as number;
    return nodeRadius?.[node] ?? options.radius;
  };
  if (options.weld !== undefined) {
    return weldNetwork(
      mesh,
      {
        options: { weld: options.weld },
        nodes,
        edges,
        branches,
        ringSegments,
        strutSegments,
        endRadius,
        widestCos: (list) => {
          let widest = -1;
          for (let p = 0; p < list.length; p++)
            for (let q = p + 1; q < list.length; q++)
              widest = Math.max(widest, dot((list[p] as Branch).dir, (list[q] as Branch).dir));
          return widest;
        },
      },
      context,
      diagnostics,
    );
  }
  const endOf = (edge: number, node: number) =>
    ((edges[edge] as readonly [number, number])[0] === node ? 0 : 1) as 0 | 1;
  for (let n = 0; n < nodes.length; n++) {
    const { widest, pair } = widestPair(branches[n] as Branch[]);
    if (widest > MIN_ANGLE_COS) {
      const [a, b] = pair;
      const degrees = (atan2(length(cross(a.dir, b.dir)), widest) * 180) / Math.PI;
      return refuse(
        'branches at a node are at least 15 degrees apart',
        'branch-angle',
        { node: n, edges: [a.edge, b.edge], degrees },
        'split the node or spread the branches; closer branches would fuse their tubes',
      );
    }
  }
  let arcs: Map<number, BendArc> = new Map();
  if (options.bend !== undefined) {
    const planned = readBend(options.bend, nodes, branches, endOf, endRadius);
    if (!planned.ok) return planned;
    arcs = planned.value;
  }
  const tight = branches.some(
    (list, n) =>
      !arcs.has(n) &&
      list.some((a, p) => list.some((b, q) => q > p && dot(a.dir, b.dir) > TIGHT_COS)),
  );
  const levels = tight ? Math.max(requested, 2) : requested;
  const factor = tubeFactor(ringSegments, levels);
  const cageAt = (edge: number, end: 0 | 1) => endRadius(edge, end) / factor;
  const widestCage = nodes.map((_, n) =>
    Math.max(
      ...(branches[n] as Branch[]).map((b) =>
        cageAt(b.edge, (edges[b.edge] as readonly [number, number])[0] === n ? 0 : 1),
      ),
    ),
  );
  const openings: number[] = [];
  for (let n = 0; n < nodes.length; n++) {
    const list = branches[n] as Branch[];
    const { widest } = widestPair(list);
    const cage = widestCage[n] as number;
    const arc = arcs.get(n);
    if (arc !== undefined) openings.push(arc.tangent);
    else if (list.length === 1) openings.push(0);
    else if (widest <= 0) openings.push(cage * MIN_RING_DISTANCE);
    else {
      const reach = (NODE_MARGIN * (1 + widest)) / Math.sqrt(1 - widest * widest);
      openings.push(cage * Math.max(MIN_RING_DISTANCE, reach));
    }
  }
  const stepOf = (e: number) => {
    const [i, j] = edges[e] as readonly [number, number];
    const room =
      length(sub(point(j), point(i))) - (openings[i] as number) - (openings[j] as number);
    return room / strutSegments;
  };
  const strutRadius = edges.map((_, e) => Math.max(endRadius(e, 0), endRadius(e, 1)));
  for (let e = 0; e < edges.length; e++) {
    const [i, j] = edges[e] as readonly [number, number];
    const len = length(sub(point(j), point(i)));
    const room = len - (openings[i] as number) - (openings[j] as number);
    const gap = (strutRadius[e] as number) * CLEARANCE;
    const stubCage = Math.max(cageAt(e, 0), cageAt(e, 1));
    if (room < 3 * stubCage) {
      const needed = (openings[i] as number) + (openings[j] as number) + 3 * stubCage;
      return refuse(
        'a strut is longer than its two node openings plus three radii',
        'edge-short',
        { edge: e, length: len, needed },
        `lengthen the strut to at least needed (${needed}) or lower the radius`,
      );
    }
    for (let f = e + 1; f < edges.length; f++) {
      const [k, l] = edges[f] as readonly [number, number];
      if (k === i || k === j || l === i || l === j) continue;
      const d = Math.sqrt(segmentDistance(point(i), point(j), point(k), point(l)));
      if (d < gap + (strutRadius[f] as number) * CLEARANCE) {
        return refuse(
          'struts without a shared node stay 3 radii apart',
          'strut-collision',
          { edges: [e, f], distance: d },
          'move the skeleton nodes apart or join the struts at a node',
        );
      }
    }
    for (let n = 0; n < nodes.length; n++) {
      if (n === i || n === j) continue;
      const d = Math.sqrt(segmentDistance(point(i), point(j), point(n), point(n)));
      if (d < (openings[n] as number) + gap) {
        return refuse(
          'a strut keeps clear of foreign nodes',
          'strut-collision',
          { edge: e, node: n, distance: d },
          'move the skeleton nodes apart or join the strut at that node',
        );
      }
    }
  }

  const frames = edges.map((edge) => {
    const u = normalize(sub(point(edge[1]), point(edge[0])));
    const lead =
      Math.abs(u[0]) <= Math.abs(u[1]) && Math.abs(u[0]) <= Math.abs(u[2])
        ? 0
        : Math.abs(u[1]) <= Math.abs(u[2])
          ? 1
          : 2;
    const reference: Tuple3 = [0, 0, 0];
    reference[lead] = 1;
    const e1 = normalize(cross(u, reference));
    return { u, e1, e2: cross(u, e1) } as FrameBasis;
  });
  const carried = carryFrames(frames, arcs);
  if (!carried.ok) return carried;
  const existing = new Set(mesh.faces());
  const rings = new Map<number, number[]>();
  const ringKey = (edge: number, end: 0 | 1) => edge * 2 + end;
  const ringPoint = (edge: number, end: 0 | 1, k: number): Tuple3 => {
    const frame = frames[edge] as (typeof frames)[number];
    const node = (edges[edge] as readonly [number, number])[end] as number;
    const angle = (2 * Math.PI * k) / ringSegments;
    const cageRadius = cageAt(edge, end);
    const centre = add(
      point(node),
      scale(frame.u, (end === 0 ? 1 : -1) * (openings[node] as number)),
    );
    return add(
      centre,
      add(scale(frame.e1, cageRadius * cos(angle)), scale(frame.e2, cageRadius * sin(angle))),
    );
  };
  for (let e = 0; e < edges.length; e++) {
    for (const end of [0, 1] as const) {
      const ids: number[] = [];
      for (let k = 0; k < ringSegments; k++) ids.push(mesh.addVertex(...ringPoint(e, end, k)));
      rings.set(ringKey(e, end), ids);
    }
  }
  const labelOf = (name: string) => mesh.nameIndex(mesh.labelNames, name);
  const counts: RoleCounts = {};
  const roleFaces = new Map<string, number[]>();
  const remember = (label: number, role: string, face: number) => {
    const key = `${label}|${role}`;
    const list = roleFaces.get(key);
    if (list === undefined) roleFaces.set(key, [face]);
    else list.push(face);
  };
  const extra: number[] = [];
  const failed = (cause: Result<never, ModelingError>) => {
    for (const f of mesh.faces()) if (!existing.has(f)) mesh.removeFace(f);
    for (const ids of rings.values()) for (const v of ids) mesh.removeVertex(v);
    for (const v of extra) mesh.removeVertex(v);
    return cause;
  };
  for (let n = 0; n < nodes.length; n++) {
    const list = branches[n] as Branch[];
    const label = labelOf(`node:${n}`);
    const ends = list.map(
      (b) => ((edges[b.edge] as readonly [number, number])[0] === n ? 0 : 1) as 0 | 1,
    );
    if (list.length === 1) {
      const ids = rings.get(ringKey((list[0] as Branch).edge, ends[0] as 0 | 1)) as number[];
      const frame = frames[(list[0] as Branch).edge] as FrameBasis;
      const right = dot(cross(frame.e1, frame.e2), frame.u) > 0;
      const loop = (ends[0] === 0) === right ? [...ids].reverse() : ids;
      const cap = mesh.addFace(loop);
      if (!cap.ok) return failed(cap);
      remember(label, 'cap', cap.value);
      continue;
    }
    const arc = arcs.get(n);
    if (arc !== undefined) {
      const spun = buildArc(
        mesh,
        arc,
        rings.get(ringKey(arc.a, arc.endA)) as number[],
        rings.get(ringKey(arc.b, arc.endB)) as number[],
        frames[arc.a] as FrameBasis,
        cageAt(arc.a, arc.endA),
        cageAt(arc.b, arc.endB),
        levels,
        stepOf(arc.a),
        stepOf(arc.b),
        extra,
      );
      if (!spun.ok) return failed(spun);
      for (const f of spun.value.faces) remember(label, 'bend', f);
      continue;
    }
    const owner: number[] = [];
    const hullPoints: Tuple3[] = [];
    const vertexOf: number[] = [];
    const ringOf: number[] = [];
    const scaleOf = widestCage[n] as number;
    list.forEach((b, slot) => {
      const ids = rings.get(ringKey(b.edge, ends[slot] as 0 | 1)) as number[];
      ids.forEach((v, k) => {
        const p = mesh.position(v);
        const i = hullPoints.length;
        hullPoints.push([
          p[0] + jitter(i, 0) * 1e-7 * scaleOf,
          p[1] + jitter(i, 1) * 1e-7 * scaleOf,
          p[2] + jitter(i, 2) * 1e-7 * scaleOf,
        ]);
        vertexOf.push(v);
        ringOf.push(slot);
        owner.push(k);
      });
    });
    const hull = convexHull(hullPoints);
    if (hull === undefined) {
      return failed(refuse('a node opening set spans a solid', 'node-hull', { node: n }));
    }
    const capTriangles = new Array<number>(list.length).fill(0);
    const solid = hull.filter(([a, b, c]) => {
      const slot = ringOf[a] as number;
      if (slot === ringOf[b] && slot === ringOf[c]) {
        capTriangles[slot] = (capTriangles[slot] as number) + 1;
        return false;
      }
      return true;
    });
    const used = new Set(hull.flat());
    if (used.size !== hullPoints.length || capTriangles.some((t) => t !== ringSegments - 2)) {
      return failed(
        refuse(
          'every branch opening is a face of its node polyhedron',
          'node-hull',
          { node: n, edges: list.map((b) => b.edge) },
          'spread the branches or lengthen the node opening',
        ),
      );
    }
    for (const [a, b, c] of solid) {
      const face = mesh.addFace([
        vertexOf[a] as number,
        vertexOf[b] as number,
        vertexOf[c] as number,
      ]);
      if (!face.ok) return failed(face);
      remember(label, 'node', face.value);
    }
  }
  for (const [key, faces] of roleFaces) {
    const [label, role] = key.split('|') as [string, string];
    markRole(mesh, faces, Number(label), role, counts);
  }
  const strutRole = new Set<number>();
  for (let e = 0; e < edges.length; e++) {
    const label = labelOf(`strut:${e}`);
    const loopA = rings.get(ringKey(e, 0)) as number[];
    const loopB = rings.get(ringKey(e, 1)) as number[];
    const selected = [loopA, loopB].flatMap((loop) =>
      loop.map((v, k) => mesh.findHalf(v, loop[(k + 1) % loop.length] as number) >> 1),
    );
    const strip = bridge(
      mesh,
      selected,
      { segments: strutSegments },
      { label, material: 0, tag: -1 },
      diagnostics,
    );
    if (!strip.ok) return failed(strip);
    strutRole.add(label);
  }
  const cage = mesh.faces().filter((f) => !existing.has(f));
  for (const f of cage) {
    if (strutRole.has(mesh.fLabel[f] as number))
      mesh.fRole[f] = mesh.nameIndex(mesh.roleNames, 'strut');
  }
  const refined = subdivide(mesh, cage, { levels }, context, diagnostics);
  if (!refined.ok) return refined;

  const output = mesh.faces().filter((f) => !existing.has(f));
  let worst = 0;
  const stations: { edge: number; at: number; expected: number; deviation: number }[] = [];
  for (let e = 0; e < edges.length; e++) {
    const [i, j] = edges[e] as readonly [number, number];
    const frame = frames[e] as (typeof frames)[number];
    const len = length(sub(point(j), point(i)));
    const startOpen = openings[i] as number;
    const endOpen = openings[j] as number;
    const span = len - startOpen - endOpen;
    const from =
      (branches[i] as Branch[]).length > 1
        ? startOpen + (widestCage[i] as number)
        : 3 * cageAt(e, 0);
    const to =
      len -
      ((branches[j] as Branch[]).length > 1
        ? endOpen + (widestCage[j] as number)
        : 3 * cageAt(e, 1));
    const joints = [...(arcs.has(i) ? [startOpen] : []), ...(arcs.has(j) ? [len - endOpen] : [])];
    for (const s of [from, (from + to) / 2, to, ...joints]) {
      const t = Math.min(1, Math.max(0, (s - startOpen) / span));
      const expected = endRadius(e, 0) + (endRadius(e, 1) - endRadius(e, 0)) * t;
      const radii = sectionRadii(
        mesh,
        output,
        add(point(i), scale(frame.u, s)),
        frame.u,
        1.6 * expected,
      );
      if (radii.length === 0) continue;
      const deviation = maxOf(radii.map((r) => Math.abs(r - expected) / expected));
      worst = Math.max(worst, deviation);
      stations.push({ edge: e, at: s, expected, deviation });
    }
  }
  let worstRound = 0;
  const bends: {
    node: number;
    at: number;
    expected: number;
    deviation: number;
    roundness: number;
  }[] = [];
  for (const arc of arcs.values()) {
    const from = endRadius(arc.a, arc.endA);
    const to = endRadius(arc.b, arc.endB);
    for (const t of BEND_STATIONS) {
      const psi = arc.angle * t;
      const expected = from + (to - from) * t;
      const radii = sectionRadii(
        mesh,
        output,
        arcPoint(arc, psi),
        arcTangent(arc, psi),
        1.6 * expected,
      );
      if (radii.length === 0) continue;
      const mean = radii.reduce((sum, r) => sum + r, 0) / radii.length;
      const deviation = maxOf(radii.map((r) => Math.abs(r - expected) / expected));
      const roundness = (maxOf(radii) - minOf(radii)) / mean;
      worst = Math.max(worst, deviation);
      worstRound = Math.max(worstRound, roundness);
      bends.push({ node: arc.node, at: t, expected, deviation, roundness });
    }
  }
  diagnostics.push({
    severity: worst <= 0.03 && worstRound <= ROUND_WARN ? 'info' : 'warn',
    message: `section radius deviation at ${stations.length} strut stations${arcs.size === 0 ? '' : ` and ${bends.length} bend stations`}, max ${(worst * 100).toFixed(2)} %`,
    detail: {
      maxDeviation: worst,
      ...(arcs.size === 0 ? {} : { maxRoundness: worstRound }),
      radius: options.radius,
      stations,
      ...(arcs.size === 0 ? {} : { bends }),
    },
  });
  return ok(refined.value);
}
