import { err, ok, type Result } from '@forgeax/engine-types';
import { minOf, pushAll } from './arrays';
import { atan2, cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { add, cross, dot, newell, normalize, scale, sub, type Tuple3 } from './geom';
import { type EditMesh, NONE } from './mesh';
import { axisFrame, type BallCylinder } from './weld-ball';

const TAU = 6.283185307179586;
const BISECTIONS = 48;
const ROOT_MARGIN = 0.02;

/**
 * A scalar field over a tube surface whose zero set is a contact polyline. Positive values
 * are the fillet band side. `key` is the angle about the branch axis in [0, 2 pi).
 */
export interface ContactField {
  readonly value: (p: Tuple3) => number;
  readonly key: (p: Tuple3) => number;
}

export interface FieldCut {
  /** Cut vertices in ascending key order, starting at the smallest key. */
  readonly loop: readonly number[];
  readonly keys: readonly number[];
  /** Directed vertex pairs of the cut; every cut vertex has exactly two. */
  readonly edges: readonly (readonly [number, number])[];
  /** Faces on the positive (band) side and on the other side, after the split. */
  readonly band: readonly number[];
  readonly rest: readonly number[];
  /** Largest |field| at a cut-edge midpoint: how far the cut sits from the (shifted) polyline. */
  readonly deviation: number;
  /** How far the cut was moved off the polyline, away from the band side's border, to keep clear of it. */
  readonly shift: number;
}

export interface CutOptions {
  /** Cut-edge midpoints farther than this from the polyline get interior vertices; 0 never refines. */
  readonly maxDeviation?: number;
  /** Largest shift off the polyline allowed to avoid a face outside the set; 0 forbids any. */
  readonly maxShift?: number;
}

function wrap(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

function fail(why: string, detail: Record<string, unknown> = {}): Result<never, ModelingError> {
  return err(
    modelingError(
      'model-precondition',
      'the contact polyline cuts the tube faces into one band',
      { reason: 'weld-cut', why, ...detail },
      'the analytic cut did not fit; the caller falls back to the bevel fillet',
    ),
  );
}

interface Chart {
  readonly angle: (p: Tuple3) => number;
  readonly height: (p: Tuple3) => number;
}

function chartAbout(axis: BallCylinder): Chart {
  const [e1, e2] = axisFrame(axis.axis);
  return {
    angle: (p) => {
      const w = sub(p, axis.origin);
      return wrap(atan2(dot(w, e2), dot(w, e1)));
    },
    height: (p) => dot(sub(p, axis.origin), axis.axis),
  };
}

/** Indices of a cyclic key list, in either direction, rotated to start at the smallest key, or undefined if not ascending. */
function ascendingOrder(keys: readonly number[]): number[] | undefined {
  const forward = rotatedAscending(keys);
  if (forward !== undefined) return forward;
  const backward = rotatedAscending([...keys].reverse());
  return backward?.map((i) => keys.length - 1 - i);
}

function rotatedAscending(keys: readonly number[]): number[] | undefined {
  let first = 0;
  for (let i = 1; i < keys.length; i++)
    if ((keys[i] as number) < (keys[first] as number)) first = i;
  const order = keys.map((_, i) => (first + i) % keys.length);
  for (let i = 1; i < order.length; i++) {
    if ((keys[order[i] as number] as number) <= (keys[order[i - 1] as number] as number)) {
      return undefined;
    }
  }
  return order;
}

/** Index i with xs[i] <= x < xs[i + 1] on a cyclic ascending list (xs[last] continues to xs[0] + TAU). */
function bracket(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) <= x) lo = mid;
    else hi = mid;
  }
  return (xs[0] as number) <= x ? lo : xs.length - 1;
}

/**
 * Field of the host tube: its surface unrolled about the centroid of the contact polyline, the
 * polyline taken as a closed polygon star-shaped about that centre. Positive inside the polygon.
 * Undefined keys or a polygon that is not star-shaped refuse.
 */
export function hostField(
  host: BallCylinder,
  keyAxis: BallCylinder,
  points: readonly Tuple3[],
): Result<ContactField, ModelingError> {
  if (points.length < 3) return fail('few-points', { points: points.length });
  const hostChart = chartAbout(host);
  const keyChart = chartAbout(keyAxis);
  let centroid: Tuple3 = [0, 0, 0];
  for (const p of points) centroid = add(centroid, scale(p, 1 / points.length));
  const u0 = hostChart.height(centroid);
  const a0 = hostChart.angle(centroid);
  const planar = (p: Tuple3): [number, number] => {
    let d = hostChart.angle(p) - a0;
    if (d > TAU / 2) d -= TAU;
    if (d < -TAU / 2) d += TAU;
    return [hostChart.height(p) - u0, host.radius * d];
  };
  const pts = points.map(planar);
  const angles = pts.map(([x, y]) => wrap(atan2(y, x)));
  const order = ascendingOrder(angles);
  if (order === undefined) return fail('not-star-shaped');
  const poly = order.map((i) => pts[i] as [number, number]);
  const keys = order.map((i) => angles[i] as number);
  const value = (p: Tuple3): number => {
    const [x, y] = planar(p);
    const a = wrap(atan2(y, x));
    const i = bracket(keys, a);
    const j = (i + 1) % poly.length;
    const [px, py] = poly[i] as [number, number];
    const [qx, qy] = poly[j] as [number, number];
    const dx = cos(a);
    const dy = sin(a);
    const ex = qx - px;
    const ey = qy - py;
    const denom = ex * dy - ey * dx;
    const s = Math.abs(denom) < 1e-18 ? 0 : -(px * dy - py * dx) / denom;
    const rx = px + s * ex;
    const ry = py + s * ey;
    return rx * dx + ry * dy - (x * dx + y * dy);
  };
  return ok({ value, key: keyChart.angle });
}

/**
 * Field of the branch tube: the polyline as a graph of height over the angle about the branch
 * axis. Positive on the host side of it (smaller height).
 */
export function branchField(
  branch: BallCylinder,
  points: readonly Tuple3[],
): Result<ContactField, ModelingError> {
  if (points.length < 3) return fail('few-points', { points: points.length });
  const chart = chartAbout(branch);
  const angles = points.map(chart.angle);
  const order = ascendingOrder(angles);
  if (order === undefined) return fail('not-star-shaped');
  const keys = order.map((i) => angles[i] as number);
  const heights = order.map((i) => chart.height(points[i] as Tuple3));
  const value = (p: Tuple3): number => {
    const a = chart.angle(p);
    const i = bracket(keys, a);
    const j = (i + 1) % keys.length;
    const ka = keys[i] as number;
    let kb = keys[j] as number;
    if (kb <= ka) kb += TAU;
    const t = (a < ka ? a + TAU - ka : a - ka) / (kb - ka);
    const h = (heights[i] as number) * (1 - t) + (heights[j] as number) * t;
    return h - chart.height(p);
  };
  return ok({ value, key: chart.angle });
}

function lerp(a: Tuple3, b: Tuple3, t: number): Tuple3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Parameter of the sign change of `value` on the segment, pulled off the endpoints. */
function root(field: ContactField, a: Tuple3, b: Tuple3, positiveAtA: boolean): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    const positive = field.value(lerp(a, b, mid)) > 0;
    if (positive === positiveAtA) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return Math.min(1 - ROOT_MARGIN, Math.max(ROOT_MARGIN, t));
}

interface FaceAttrs {
  readonly material: number;
  readonly label: number;
  readonly role: number;
  readonly flags: number;
  readonly tags: number[];
}

function attrsOf(mesh: EditMesh, f: number): FaceAttrs {
  const tags: number[] = [];
  for (let w = 0; w < mesh.tagWords; w++) tags.push(mesh.fTags[f * mesh.tagWords + w] as number);
  return {
    material: mesh.fMaterial[f] as number,
    label: mesh.fLabel[f] as number,
    role: mesh.fRole[f] as number,
    flags: mesh.fFlags[f] as number,
    tags,
  };
}

function applyAttrs(mesh: EditMesh, f: number, a: FaceAttrs): void {
  mesh.fMaterial[f] = a.material;
  mesh.fLabel[f] = a.label;
  mesh.fRole[f] = a.role;
  mesh.fFlags[f] = a.flags;
  a.tags.forEach((word, w) => {
    mesh.fTags[f * mesh.tagWords + w] = word;
  });
}

interface RingEntry {
  readonly v: number;
  readonly pos: boolean;
  readonly cut: boolean;
}

/** The polygons a face splits into, as vertex loops with their side, cut by chords c0-c1, c2-c3, ... */
function splitRing(
  ring: readonly RingEntry[],
  crossings: readonly number[],
  path: readonly number[] = [],
) {
  const n = ring.length;
  const take = (from: number, to: number) => {
    const out: number[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      out.push((ring[i] as RingEntry).v);
      if (i === to) break;
    }
    return out;
  };
  let probe = ((crossings[0] as number) + 1) % n;
  while ((ring[probe] as RingEntry).cut) probe = (probe + 1) % n;
  const side = (ring[probe] as RingEntry).pos;
  const polygons: { loop: number[]; band: boolean }[] = [];
  const chords: [number, number][] = [];
  const middle: number[] = [];
  const k = crossings.length;
  if (k === 2) {
    const c0 = crossings[0] as number;
    const c1 = crossings[1] as number;
    const line = [(ring[c0] as RingEntry).v, ...path, (ring[c1] as RingEntry).v];
    for (let i = 0; i + 1 < line.length; i++)
      chords.push([line[i] as number, line[i + 1] as number]);
    polygons.push({ loop: [...take(c0, c1), ...[...path].reverse()], band: side });
    polygons.push({ loop: [...take(c1, c0), ...path], band: !side });
    return { polygons, chords };
  }
  for (let q = 0; q < k; q += 2) {
    const c0 = crossings[q] as number;
    const c1 = crossings[q + 1] as number;
    polygons.push({ loop: take(c0, c1), band: side });
    chords.push([(ring[c0] as RingEntry).v, (ring[c1] as RingEntry).v]);
    pushAll(middle, take(c1, crossings[(q + 2) % k] as number));
  }
  polygons.push({ loop: middle, band: !side });
  return { polygons, chords };
}

function walkLoop(chords: readonly (readonly [number, number])[]): number[] | undefined {
  const next = new Map<number, number[]>();
  for (const [a, b] of chords) {
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  }
  for (const list of next.values()) if (list.length !== 2) return undefined;
  const start = minOf(next.keys());
  const loop = [start];
  let prev = start;
  let at = (next.get(start) as number[])[0] as number;
  while (at !== start) {
    loop.push(at);
    const pair = next.get(at) as number[];
    const step = pair[0] === prev ? (pair[1] as number) : (pair[0] as number);
    prev = at;
    at = step;
    if (loop.length > next.size) return undefined;
  }
  return loop.length === next.size ? loop : undefined;
}

const REFINE_DEPTH = 5;
const GRADIENT_STEP = 1e-5;

/** First-order distance from `p` to the zero set: |F| over the finite-difference gradient length. */
function gap(field: ContactField, p: Tuple3): number {
  const f = field.value(p);
  let g2 = 0;
  for (let axis = 0; axis < 3; axis++) {
    const lo: Tuple3 = [p[0], p[1], p[2]];
    const hi: Tuple3 = [p[0], p[1], p[2]];
    lo[axis] = (lo[axis] as number) - GRADIENT_STEP;
    hi[axis] = (hi[axis] as number) + GRADIENT_STEP;
    const d = (field.value(hi) - field.value(lo)) / (2 * GRADIENT_STEP);
    g2 += d * d;
  }
  return g2 > 0 ? Math.abs(f) / Math.sqrt(g2) : Math.abs(f);
}
const SCAN_STEPS = 60;
const SCAN_RANGE = 3;

function insideFace(ps: readonly Tuple3[], normal: Tuple3, q: Tuple3): boolean {
  const [nx, ny, nz] = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])] as [
    number,
    number,
    number,
  ];
  const ax = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
  const u = (ax + 1) % 3;
  const w = (ax + 2) % 3;
  let inside = false;
  for (let i = 0, j = ps.length - 1; i < ps.length; j = i++) {
    const a = ps[i] as unknown as number[];
    const b = ps[j] as unknown as number[];
    const qq = q as unknown as number[];
    const [au, aw, bu, bw, qu, qw] = [a[u], a[w], b[u], b[w], qq[u], qq[w]] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (aw > qw !== bw > qw && qu < ((bu - au) * (qw - aw)) / (bw - aw) + au) {
      inside = !inside;
    }
  }
  return inside;
}

/** Interior points that pull the straight chord a-b onto the zero set inside a planar face. */
function refinePath(
  field: ContactField,
  ps: readonly Tuple3[],
  a: Tuple3,
  b: Tuple3,
  maxDeviation: number,
  depth: number,
): Tuple3[] {
  const mid = lerp(a, b, 0.5);
  if (depth >= REFINE_DEPTH || gap(field, mid) <= maxDeviation) return [];
  const normal = normalize(newell(ps));
  const chord = sub(b, a);
  const len = Math.sqrt(dot(chord, chord));
  if (!(len > 0)) return [];
  const side = normalize(cross(normal, chord));
  let hit: Tuple3 | undefined;
  for (let step = 1; step <= SCAN_STEPS && hit === undefined; step++) {
    for (const dir of [1, -1]) {
      const near = add(mid, scale(side, (dir * len * SCAN_RANGE * (step - 1)) / SCAN_STEPS));
      const far = add(mid, scale(side, (dir * len * SCAN_RANGE * step) / SCAN_STEPS));
      const loPositive = field.value(near) > 0;
      if (field.value(far) > 0 === loPositive) continue;
      let lo = near;
      let hi = far;
      for (let i = 0; i < BISECTIONS; i++) {
        const m = lerp(lo, hi, 0.5);
        if (field.value(m) > 0 === loPositive) lo = m;
        else hi = m;
      }
      const cand = lerp(lo, hi, 0.5);
      if (insideFace(ps, normal, cand)) {
        hit = cand;
        break;
      }
    }
  }
  if (hit === undefined) return [];
  const turn = (x: Tuple3, y: Tuple3): number => {
    const d = field.key(y) - field.key(x);
    return d > TAU / 2 ? d - TAU : d < -TAU / 2 ? d + TAU : d;
  };
  const whole = turn(a, b);
  const first = turn(a, hit);
  const second = turn(hit, b);
  if (first * whole <= 0 || second * whole <= 0) return [];
  const short = 0.02 * len;
  const da = sub(hit, a);
  const db = sub(hit, b);
  if (dot(da, da) < short * short || dot(db, db) < short * short) return [];
  return [
    ...refinePath(field, ps, a, hit, maxDeviation, depth + 1),
    hit,
    ...refinePath(field, ps, hit, b, maxDeviation, depth + 1),
  ];
}

interface Rebuilt {
  readonly source: FaceAttrs;
  readonly loop: number[];
  readonly band: boolean;
}

type Attempt =
  | { readonly ok: true; readonly cut: FieldCut; readonly work: EditMesh }
  | { readonly ok: false; readonly error: ModelingError; readonly need?: number };

function attempt(
  mesh: EditMesh,
  faces: readonly number[],
  field: ContactField,
  shift: number,
  maxDeviation: number,
  margin: number,
): Attempt {
  const shifted: ContactField = { value: (p) => field.value(p) + shift, key: field.key };
  const bad = (r: Result<never, ModelingError>, need?: number): Attempt =>
    need === undefined
      ? { ok: false, error: (r as { error: ModelingError }).error }
      : { ok: false, error: (r as { error: ModelingError }).error, need };
  const inSet = new Set(faces);
  const work = mesh.clone();
  const positive = new Map<number, boolean>();
  const sign = (v: number): boolean => {
    let s = positive.get(v);
    if (s === undefined) {
      s = shifted.value(work.position(v)) > 0;
      positive.set(v, s);
    }
    return s;
  };

  const cutVertex = new Map<number, number>();
  for (const f of faces) {
    for (const h of work.faceHalves(f)) {
      const e = h >> 1;
      if (cutVertex.has(e)) continue;
      const [a, b] = work.edgeVertices(e);
      if (sign(a) === sign(b)) continue;
      const other = work.hFace[h ^ 1] as number;
      if (other === NONE || !inSet.has(other)) {
        const low = Math.min(field.value(work.position(a)), field.value(work.position(b)));
        return bad(fail('open-border', { edge: e }), margin - low);
      }
      const t = root(shifted, work.position(a), work.position(b), sign(a));
      const p = lerp(work.position(a), work.position(b), t);
      cutVertex.set(e, work.addVertex(p[0], p[1], p[2]));
    }
  }
  if (cutVertex.size === 0) return bad(fail('no-crossing'));

  const touched = new Set<number>();
  for (const e of cutVertex.keys()) {
    touched.add(work.hFace[e * 2] as number);
    touched.add(work.hFace[e * 2 + 1] as number);
  }
  const order = [...touched].sort((x, y) => x - y);
  const kept = new Map<string, number>();
  const edgeKeyOf = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const rebuilt: Rebuilt[] = [];
  const chords: [number, number][] = [];
  for (const f of order) {
    const ring: RingEntry[] = [];
    const crossings: number[] = [];
    for (const h of work.faceHalves(f)) {
      const a = work.hVert[h] as number;
      const b = work.hVert[work.hNext[h] as number] as number;
      ring.push({ v: a, pos: sign(a), cut: false });
      const mid = cutVertex.get(h >> 1);
      const flags = work.eFlags[h >> 1] as number;
      if (mid === undefined) {
        if (flags !== 0) kept.set(edgeKeyOf(a, b), flags);
        continue;
      }
      crossings.push(ring.length);
      ring.push({ v: mid, pos: false, cut: true });
      if (flags !== 0) {
        kept.set(edgeKeyOf(a, mid), flags);
        kept.set(edgeKeyOf(mid, b), flags);
      }
    }
    if (crossings.length < 2 || crossings.length % 2 !== 0) {
      return bad(fail('face-parity', { face: f, crossings: crossings.length }));
    }
    const path: number[] = [];
    if (crossings.length === 2 && maxDeviation > 0) {
      const ps = ring.map((r) => work.position(r.v));
      const a = work.position((ring[crossings[0] as number] as RingEntry).v);
      const b = work.position((ring[crossings[1] as number] as RingEntry).v);
      for (const q of refinePath(shifted, ps, a, b, maxDeviation, 0)) {
        path.push(work.addVertex(q[0], q[1], q[2]));
      }
    }
    const split = splitRing(ring, crossings, path);
    const source = attrsOf(work, f);
    for (const p of split.polygons) rebuilt.push({ source, loop: p.loop, band: p.band });
    pushAll(chords, split.chords);
  }
  for (const f of order) work.removeFace(f);
  const band: number[] = [];
  const rest: number[] = [];
  for (const piece of rebuilt) {
    const added = work.addFace(piece.loop, piece.source.material);
    if (!added.ok) return { ok: false, error: added.error };
    applyAttrs(work, added.value, piece.source);
    (piece.band ? band : rest).push(added.value);
    for (let i = 0; i < piece.loop.length; i++) {
      const a = piece.loop[i] as number;
      const b = piece.loop[(i + 1) % piece.loop.length] as number;
      const flags = kept.get(edgeKeyOf(a, b));
      if (flags !== undefined) work.eFlags[work.findHalf(a, b) >> 1] = flags;
    }
  }
  for (const f of faces) {
    if (touched.has(f) || !work.isFaceAlive(f)) continue;
    (sign(work.faceVertices(f)[0] as number) ? band : rest).push(f);
  }

  const cycle = walkLoop(chords);
  if (cycle === undefined) return bad(fail('not-one-loop', { chords: chords.length }));
  const key = (v: number) => shifted.key(work.position(v));
  let ids = cycle;
  let keys = ids.map(key);
  let sorted = ascendingOrder(keys);
  if (sorted === undefined) return bad(fail('keys-not-ascending'));
  if (
    keys.length > 1 &&
    (keys[sorted[1] as number] as number) < (keys[sorted[0] as number] as number)
  ) {
    ids = [...cycle].reverse();
    keys = ids.map(key);
    sorted = ascendingOrder(keys);
  }
  if (sorted === undefined) return bad(fail('keys-not-ascending'));
  let deviation = 0;
  for (const [a, b] of chords) {
    const m = lerp(work.position(a), work.position(b), 0.5);
    deviation = Math.max(deviation, gap(shifted, m));
  }
  const loopIds = sorted.map((i) => ids[i] as number);
  return {
    ok: true,
    work,
    cut: {
      loop: loopIds,
      keys: sorted.map((i) => keys[i] as number),
      edges: chords,
      band,
      rest,
      deviation,
      shift,
    },
  };
}

/**
 * Splits `faces` of a closed manifold mesh exactly along the zero set of `field`: a vertex is
 * inserted where each crossed edge changes sign (the root of the field itself, not a linear
 * interpolation) and every crossed face is cut by one chord per sign run, with interior
 * vertices where a chord strays more than `maxDeviation`. Each cut vertex then has exactly two
 * cut edges. Where the zero set would run onto a face outside `faces` (a pinched band), the cut
 * is shifted off the polyline by up to `maxShift`. Fails, leaving the mesh untouched, when the
 * zero set is not one closed loop of ascending keys. Corner channel values of split faces are
 * not carried over.
 */
export function cutAlongField(
  mesh: EditMesh,
  faces: readonly number[],
  field: ContactField,
  options: CutOptions = {},
): Result<FieldCut, ModelingError> {
  const maxDeviation = options.maxDeviation ?? 0;
  const maxShift = options.maxShift ?? 0;
  const margin = maxShift / 8;
  let shift = 0;
  for (let round = 0; round < 8; round++) {
    const tried = attempt(mesh, faces, field, shift, maxDeviation, margin);
    if (tried.ok) {
      mesh.assign(tried.work);
      return ok(tried.cut);
    }
    if (
      tried.need === undefined ||
      !(shift + tried.need > shift) ||
      shift + tried.need > maxShift
    ) {
      return err(tried.error);
    }
    shift = shift + tried.need;
  }
  return fail('shift-retries');
}
