import type { Result } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { atan2, cos, sin } from './dmath';
import type { ModelingError } from './errors';
import { add, cross, dot, length, normalize, scale, sub, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import { invalid, refuse } from './pipe-weld';

/** Circular elbows at the degree-two nodes of a pipe network. */
export interface PipeBendOptions {
  /** Centreline bend radius (meters); at least 1.25 times the larger tube radius at the node. */
  readonly radius: number;
  /** Cage rows around one elbow (1 to 64); default one row per 15 degrees of turn (more when a chord sags over 3 % of the tube radius), at least two; fewer than one per 30 degrees is `bend-segments`. */
  readonly segments?: number;
  /** Degree-two nodes to bend; default every one that turns by more than 2 degrees. */
  readonly nodes?: readonly number[];
}

export interface BendBranch {
  readonly edge: number;
  readonly dir: Tuple3;
}

export interface BendArc {
  readonly node: number;
  readonly a: number;
  readonly b: number;
  readonly endA: 0 | 1;
  readonly endB: 0 | 1;
  readonly tangent: number;
  readonly angle: number;
  readonly cos: number;
  readonly sin: number;
  readonly axis: Tuple3;
  readonly tIn: Tuple3;
  readonly start: Tuple3;
  readonly toCentre: Tuple3;
  readonly radius: number;
  readonly rows: number;
}

export interface FrameBasis {
  u: Tuple3;
  e1: Tuple3;
  e2: Tuple3;
}

const MIN_RATIO = 1.25;
const MIN_TURN_COS = 0.99939;
const ROW_ANGLE = Math.PI / 12;
const MAX_ROWS = 64;
const MAX_ROW_TURN = Math.PI / 6;
const SAG_FRACTION = 0.03;
const MIN_SIN = 2e-3;
const LOOP_COS = 1 - 1e-9;

function rotate(v: Tuple3, axis: Tuple3, c: number, s: number): Tuple3 {
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

function defaultRows(angle: number, radius: number, tube: number): number {
  const sagStep = Math.sqrt((8 * SAG_FRACTION * tube) / radius);
  const rows = Math.ceil(angle / Math.min(ROW_ANGLE, sagStep) - 1e-9);
  return Math.min(MAX_ROWS, Math.max(2, rows));
}

export function readBend(
  bend: PipeBendOptions,
  nodes: readonly Tuple3[],
  branches: readonly (readonly BendBranch[])[],
  endOf: (edge: number, node: number) => 0 | 1,
  tubeAt: (edge: number, end: 0 | 1) => number,
): Result<Map<number, BendArc>, ModelingError> {
  if (typeof bend !== 'object' || bend === null) {
    return invalid('bend is { radius, segments?, nodes? }', { bend });
  }
  const finite = Number.isFinite(bend.radius) && bend.radius > 0;
  if (typeof bend.radius !== 'number' || !finite) {
    return invalid('bend.radius is a finite number greater than 0', { radius: bend.radius });
  }
  const rowsOption = bend.segments;
  if (
    rowsOption !== undefined &&
    (!Number.isInteger(rowsOption) || rowsOption < 1 || rowsOption > MAX_ROWS)
  ) {
    return invalid(`bend.segments is an integer from 1 to ${MAX_ROWS}`, { segments: rowsOption });
  }
  const picked = bend.nodes;
  if (picked !== undefined && !Array.isArray(picked)) {
    return invalid('bend.nodes lists node indices', { nodes: picked });
  }
  if (picked !== undefined) {
    for (const n of picked) {
      if (!Number.isInteger(n) || n < 0 || n >= nodes.length) {
        return invalid('bend.nodes lists node indices', { node: n, nodes: nodes.length });
      }
      if ((branches[n] as readonly BendBranch[]).length !== 2) {
        return invalid('a bend node joins exactly two struts', {
          node: n,
          degree: (branches[n] as readonly BendBranch[]).length,
        });
      }
    }
  }
  const wanted = picked === undefined ? undefined : new Set(picked);
  const arcs = new Map<number, BendArc>();
  for (let n = 0; n < nodes.length; n++) {
    const list = branches[n] as readonly BendBranch[];
    if (list.length !== 2 || (wanted !== undefined && !wanted.has(n))) continue;
    const [first, second] = list as readonly [BendBranch, BendBranch];
    const tIn = scale(first.dir, -1);
    const tOut = second.dir;
    const c = dot(tIn, tOut);
    if (wanted === undefined && c > MIN_TURN_COS) continue;
    const s = length(cross(tIn, tOut));
    if (!(s > MIN_SIN)) {
      return refuse(
        'a bend node turns the path',
        'bend-straight',
        { node: n },
        'drop the node from bend.nodes; a straight node has no elbow',
      );
    }
    const tube = Math.max(
      tubeAt(first.edge, endOf(first.edge, n)),
      tubeAt(second.edge, endOf(second.edge, n)),
    );
    if (!(bend.radius >= MIN_RATIO * tube)) {
      return refuse(
        'the bend radius is at least 1.25 times the tube radius',
        'bend-radius',
        { node: n, radius: bend.radius, tube, minimum: MIN_RATIO * tube },
        'raise bend.radius or lower the tube radius; the inner wall of a tighter elbow folds',
      );
    }
    const angle = atan2(s, c);
    const minRows = Math.max(1, Math.ceil(angle / MAX_ROW_TURN - 1e-9));
    if (rowsOption !== undefined && rowsOption < minRows) {
      return refuse(
        'bend.segments gives at most 30 degrees of turn per row',
        'bend-segments',
        { node: n, segments: rowsOption, minimum: minRows },
        `raise bend.segments to at least ${minRows} or omit it for the default`,
      );
    }
    const tangent = (bend.radius * s) / (1 + c);
    const inward = normalize(sub(tOut, scale(tIn, c)));
    const start = sub(nodes[n] as Tuple3, scale(tIn, tangent));
    arcs.set(n, {
      node: n,
      a: first.edge,
      b: second.edge,
      endA: endOf(first.edge, n),
      endB: endOf(second.edge, n),
      tangent,
      angle,
      cos: c,
      sin: s,
      axis: normalize(cross(tIn, tOut)),
      tIn,
      start,
      toCentre: inward,
      radius: bend.radius,
      rows: rowsOption ?? defaultRows(angle, bend.radius, tube),
    });
  }
  return ok(arcs);
}

/**
 * Carries each strut's section frame across its elbows so both ends of an elbow share one
 * ring correspondence; a closed chain of elbows whose frame does not return is refused.
 */
export function carryFrames(
  frames: FrameBasis[],
  arcs: ReadonlyMap<number, BendArc>,
): Result<null, ModelingError> {
  const byEdge = new Map<number, BendArc[]>();
  for (const arc of arcs.values()) {
    for (const e of [arc.a, arc.b]) {
      const list = byEdge.get(e);
      if (list === undefined) byEdge.set(e, [arc]);
      else list.push(arc);
    }
  }
  const done = new Set<number>();
  for (let root = 0; root < frames.length; root++) {
    if (done.has(root) || !byEdge.has(root)) continue;
    done.add(root);
    const stack = [root];
    while (stack.length > 0) {
      const e = stack.pop() as number;
      for (const arc of byEdge.get(e) ?? []) {
        const forward = arc.a === e;
        const other = forward ? arc.b : arc.a;
        const from = frames[e] as FrameBasis;
        const sgn = forward ? 1 : -1;
        const e1 = rotate(from.e1, arc.axis, arc.cos, sgn * arc.sin);
        const e2 = rotate(from.e2, arc.axis, arc.cos, sgn * arc.sin);
        const target = frames[other] as FrameBasis;
        if (done.has(other)) {
          if (!(dot(e1, target.e1) > LOOP_COS && dot(e2, target.e2) > LOOP_COS)) {
            return refuse(
              'a closed chain of elbows returns to its starting section frame',
              'bend-loop',
              { node: arc.node, edge: other },
              'open the loop at a node that is not bent, or make it planar',
            );
          }
          continue;
        }
        target.e1 = e1;
        target.e2 = e2;
        done.add(other);
        stack.push(other);
      }
    }
  }
  return ok(null);
}

export interface ArcRings {
  readonly rings: number[][];
  readonly faces: number[];
}

export function arcPoint(arc: BendArc, psi: number): Tuple3 {
  const centre = add(arc.start, scale(arc.toCentre, arc.radius));
  return add(
    centre,
    add(scale(arc.toCentre, -arc.radius * cos(psi)), scale(arc.tIn, arc.radius * sin(psi))),
  );
}

export function arcTangent(arc: BendArc, psi: number): Tuple3 {
  return add(scale(arc.tIn, cos(psi)), scale(arc.toCentre, sin(psi)));
}

/** Original-row positions of a row sequence after `levels` cubic B-spline refinements. */
function refineRows(seq: readonly number[], levels: number): number[] {
  let q = seq.slice();
  for (let l = 0; l < levels; l++) {
    const next: number[] = [];
    for (let j = 0; j < q.length; j++) {
      const here = q[j] as number;
      const prev = q[j - 1] ?? 2 * here - (q[j + 1] as number);
      const after = q[j + 1] ?? 2 * here - prev;
      next.push((prev + 6 * here + after) / 8, (here + after) / 2);
    }
    next.pop();
    q = next;
  }
  let stride = 1;
  for (let i = 0; i < levels; i++) stride *= 2;
  return seq.map((_, j) => q[j * stride] as number);
}

const REACH = 4;

/**
 * Cage rows (end rows included) whose refined original-row positions equal `ideal`. The rows
 * continue straight beyond both ends, as the struts do, so the end rings give up the transverse
 * pull of the first arc row. Refinement is linear along the rows: one dense solve serves every
 * coordinate; null when the system is singular.
 */
function solveRows(
  ideal: readonly number[][],
  levels: number,
  before: readonly number[][],
  after: readonly number[][],
): number[][] | null {
  const count = ideal.length;
  const n = count - 2;
  const dims = (ideal[0] as number[]).length;
  if (n < 1) return ideal.map((r) => r.slice());
  const total = count + 2 * REACH;
  const cols: number[][] = [];
  for (let j = 1; j <= n; j++) {
    const unit = new Array<number>(total).fill(0);
    unit[REACH + j] = 1;
    cols.push(refineRows(unit, levels).slice(REACH + 1, REACH + 1 + n));
  }
  const mat: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = cols.map((col) => col[i] as number);
    for (let k = 0; k < n; k++) row.push(k === i ? 1 : 0);
    mat.push(row);
  }
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) {
      if (
        Math.abs((mat[r] as number[])[c] as number) >
        Math.abs((mat[pivot] as number[])[c] as number)
      )
        pivot = r;
    }
    const row = mat[pivot] as number[];
    const d = row[c] as number;
    if (!(Math.abs(d) > 1e-9)) return null;
    mat[pivot] = mat[c] as number[];
    mat[c] = row;
    for (let k = 0; k < 2 * n; k++) row[k] = (row[k] as number) / d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const target = mat[r] as number[];
      const f = target[c] as number;
      for (let k = 0; k < 2 * n; k++) target[k] = (target[k] as number) - f * (row[k] as number);
    }
  }
  const rhs: number[][] = [];
  for (let d = 0; d < dims; d++) {
    const seq = new Array<number>(total).fill(0);
    for (let j = 0; j < REACH; j++) {
      seq[j] = (before[REACH - 1 - j] as number[])[d] as number;
      seq[REACH + count + j] = (after[j] as number[])[d] as number;
    }
    seq[REACH] = (ideal[0] as number[])[d] as number;
    seq[REACH + count - 1] = (ideal[count - 1] as number[])[d] as number;
    const fixed = refineRows(seq, levels);
    rhs.push(
      Array.from(
        { length: n },
        (_, i) => ((ideal[i + 1] as number[])[d] as number) - (fixed[REACH + 1 + i] as number),
      ),
    );
  }
  const out: number[][] = [(ideal[0] as number[]).slice()];
  for (let i = 0; i < n; i++) {
    const inv = (mat[i] as number[]).slice(n);
    out.push(rhs.map((r) => inv.reduce((sum, w, k) => sum + w * (r[k] as number), 0)));
  }
  out.push((ideal[count - 1] as number[]).slice());
  return out;
}

function cagePoint(
  arc: BendArc,
  frame: FrameBasis,
  cageA: number,
  cageB: number,
  i: number,
  k: number,
  m: number,
): Tuple3 {
  const psi = (arc.angle * i) / arc.rows;
  const c = cos(psi);
  const s = sin(psi);
  const radius = cageA + ((cageB - cageA) * i) / arc.rows;
  const theta = (2 * Math.PI * k) / m;
  const e1 = rotate(frame.e1, arc.axis, c, s);
  const e2 = rotate(frame.e2, arc.axis, c, s);
  return add(
    arcPoint(arc, psi),
    add(scale(e1, radius * cos(theta)), scale(e2, radius * sin(theta))),
  );
}

/**
 * Quad rows of one elbow between the two end rings: ring `i` is the first ring turned about
 * the bend axis by `i / rows` of the turn and placed on the centreline arc, its radius
 * ramping linearly between the two cage radii. Faces face away from the centreline.
 */
export function buildArc(
  mesh: EditMesh,
  arc: BendArc,
  ringA: readonly number[],
  ringB: readonly number[],
  frame: FrameBasis,
  cageA: number,
  cageB: number,
  levels: number,
  stepA: number,
  stepB: number,
  newVertices: number[],
): Result<ArcRings, ModelingError> {
  const m = ringA.length;
  const tOut = arcTangent(arc, arc.angle);
  const solved: number[][][] = [];
  for (let k = 0; k < m; k++) {
    const pts: Tuple3[] = [];
    for (let i = 0; i <= arc.rows; i++) {
      pts.push(
        i === 0
          ? mesh.position(ringA[k] as number)
          : i === arc.rows
            ? mesh.position(ringB[k] as number)
            : cagePoint(arc, frame, cageA, cageB, i, k, m),
      );
    }
    const first = pts[0] as Tuple3;
    const last = pts[arc.rows] as Tuple3;
    const before = Array.from({ length: REACH }, (_, j) => [
      ...sub(first, scale(arc.tIn, stepA * (REACH - j))),
    ]);
    const beyond = Array.from({ length: REACH }, (_, j) => [
      ...add(last, scale(tOut, stepB * (j + 1))),
    ]);
    const ideal = pts.map((p) => [...p]);
    solved.push(solveRows(ideal, levels, before, beyond) ?? ideal);
  }
  const rings: number[][] = [];
  for (let i = 0; i <= arc.rows; i++) {
    if (i === 0 || i === arc.rows) {
      const ring = i === 0 ? ringA : ringB;
      for (let k = 0; k < m; k++) {
        const q = (solved[k] as number[][])[i] as number[];
        mesh.setPosition(ring[k] as number, q[0] as number, q[1] as number, q[2] as number);
      }
      rings.push([...ring]);
      continue;
    }
    const ids: number[] = [];
    for (let k = 0; k < m; k++) {
      const q = (solved[k] as number[][])[i] as number[];
      const v = mesh.addVertex(q[0] as number, q[1] as number, q[2] as number);
      newVertices.push(v);
      ids.push(v);
    }
    rings.push(ids);
  }
  const quad = (i: number, k: number) => {
    const next = (k + 1) % m;
    return [
      (rings[i] as number[])[k] as number,
      (rings[i] as number[])[next] as number,
      (rings[i + 1] as number[])[next] as number,
      (rings[i + 1] as number[])[k] as number,
    ];
  };
  const probe = quad(0, 0).map((v) => mesh.position(v));
  const q0 = probe[0] as Tuple3;
  const normal = cross(sub(probe[1] as Tuple3, q0), sub(probe[3] as Tuple3, q0));
  const mid = scale(
    add(add(probe[0] as Tuple3, probe[1] as Tuple3), add(probe[2] as Tuple3, probe[3] as Tuple3)),
    0.25,
  );
  const outward = dot(normal, sub(mid, arcPoint(arc, arc.angle / (2 * arc.rows)))) > 0;
  const faces: number[] = [];
  for (let i = 0; i < arc.rows; i++) {
    for (let k = 0; k < m; k++) {
      const loop = quad(i, k);
      const face = mesh.addFace(outward ? loop : loop.reverse());
      if (!face.ok) return face;
      faces.push(face.value);
    }
  }
  return ok({ rings, faces });
}
