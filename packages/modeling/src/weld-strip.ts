import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from './arrays';
import { atan2, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { add, cross, dot, normalize, scale, sub, type Tuple3 } from './geom';
import { type EditMesh, FACE_EDGE_ROUND, NONE } from './mesh';
import {
  axisFrame,
  type BallCylinder,
  type BallStation,
  cylinderPairStation,
  stationCount,
} from './weld-ball';
import { branchField, cutAlongField, hostField } from './weld-cut';

const TAU = 6.283185307179586;
export const STRIP_CHORD = 0.05;
export const STRIP_SHIFT = 1.0;

/** Test hook: the falsifier gate turns snapping off and must go red. */
export const STRIP_TUNING = { snap: true };

export interface BallStripInput {
  readonly host: BallCylinder;
  readonly branch: BallCylinder;
  readonly hostLabels: ReadonlySet<number>;
  readonly branchLabel: number;
  readonly weldLabel: number;
  readonly weldRole: number;
  readonly rho: number;
  readonly segments: number;
}

export interface BallStripResult {
  readonly faces: number;
  /** Largest distance of a cut chord from its contact curve, in units of rho. */
  readonly deviation: number;
  /** Largest shift of a cut off its contact curve, in units of rho. */
  readonly shift: number;
}

interface Ordered {
  readonly ids: number[];
  readonly keys: number[];
}

function wrap(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

function signedStep(from: number, to: number): number {
  const d = wrap(to - from);
  return d > TAU / 2 ? d - TAU : d;
}

function ascending(ids: readonly number[], keys: readonly number[]): Ordered | undefined {
  let first = 0;
  for (let i = 1; i < keys.length; i++)
    if ((keys[i] as number) < (keys[first] as number)) first = i;
  const rotated = ids.map((_, i) => (first + i) % ids.length);
  const out: Ordered = {
    ids: rotated.map((i) => ids[i] as number),
    keys: rotated.map((i) => keys[i] as number),
  };
  for (let i = 1; i < out.keys.length; i++) {
    if ((out.keys[i] as number) <= (out.keys[i - 1] as number)) return undefined;
  }
  return out;
}

function unwrapped(keys: readonly number[], start: number): number[] {
  const out: number[] = [];
  let at = start + signedStep(start, keys[0] as number);
  out.push(at);
  for (let i = 1; i < keys.length; i++) {
    at += wrap((keys[i] as number) - (keys[i - 1] as number));
    out.push(at);
  }
  return out;
}

/** Triangle zipper between two ascending cyclic rows of different counts; lo edges ascend. */
function zipper(lo: Ordered, up: Ordered): number[][] {
  const n = lo.ids.length;
  let start = 0;
  let near = Infinity;
  for (let j = 0; j < up.ids.length; j++) {
    const d = Math.abs(signedStep(lo.keys[0] as number, up.keys[j] as number));
    if (d < near) {
      near = d;
      start = j;
    }
  }
  const upIds = up.ids.map((_, j) => up.ids[(start + j) % up.ids.length] as number);
  const upKeys = up.ids.map((_, j) => up.keys[(start + j) % up.ids.length] as number);
  const m = upIds.length;
  const l = unwrapped(lo.keys, lo.keys[0] as number);
  const u = unwrapped(upKeys, lo.keys[0] as number);
  const loAt = (i: number) => (i < n ? (l[i] as number) : (l[0] as number) + TAU);
  const upAt = (j: number) => (j < m ? (u[j] as number) : (u[0] as number) + TAU);
  const faces: number[][] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const advanceLo = i < n && (j >= m || loAt(i + 1) <= upAt(j + 1));
    if (advanceLo) {
      faces.push([lo.ids[i] as number, lo.ids[(i + 1) % n] as number, upIds[j % m] as number]);
      i++;
    } else {
      faces.push([lo.ids[i % n] as number, upIds[(j + 1) % m] as number, upIds[j % m] as number]);
      j++;
    }
  }
  return faces;
}

function fail(why: string, detail: Record<string, unknown> = {}): Result<never, ModelingError> {
  return err(
    modelingError(
      'model-precondition',
      'the rolling-ball strip fits the joint',
      { reason: 'weld-ball', why, ...detail },
      'the analytic strip did not fit this joint',
    ),
  );
}

function snapOnto(mesh: EditMesh, loop: readonly number[], curve: readonly Tuple3[]): void {
  for (const v of loop) {
    const p = mesh.position(v);
    let best: Tuple3 = p;
    let bestD = Infinity;
    for (let i = 0; i < curve.length; i++) {
      const a = curve[i] as Tuple3;
      const b = curve[(i + 1) % curve.length] as Tuple3;
      const ab = sub(b, a);
      const len = dot(ab, ab);
      const t = len < 1e-18 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len));
      const q = add(a, scale(ab, t));
      const w = sub(p, q);
      const d = dot(w, w);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    mesh.setPosition(v, best[0], best[1], best[2]);
  }
}

function arcPoint(s: BallStation, rho: number, t: number): Tuple3 {
  const da = normalize(sub(s.contactA, s.centre));
  const db = normalize(sub(s.contactB, s.centre));
  const phi = atan2(Math.sqrt(dot(cross(da, db), cross(da, db))), dot(da, db));
  const k = sin(phi);
  const d = k < 1e-9 ? da : add(scale(da, sin((1 - t) * phi) / k), scale(db, sin(t * phi) / k));
  return add(s.centre, scale(d, rho));
}

/**
 * Replaces the fillet band between a straight host tube and a straight branch tube by a
 * rolling-ball strip: both tubes are cut exactly along the analytic contact curves, the faces
 * between the cuts are removed, and quad rows on circular arcs of radius rho bridge the two
 * boundary loops. The mesh is only valid on success; callers restore a clone on failure.
 */
export function ballStrip(
  mesh: EditMesh,
  input: BallStripInput,
): Result<BallStripResult, ModelingError> {
  const { host, branch, rho, segments } = input;
  const count = stationCount(branch.radius, rho);
  const stations: BallStation[] = [];
  for (let i = 0; i < count; i++) {
    const s = cylinderPairStation(host, branch, rho, (TAU * (i + 0.5)) / count, 1);
    if (s === undefined) return fail('no-ball');
    stations.push(s);
  }
  const isHost = (f: number) => input.hostLabels.has(mesh.fLabel[f] as number);
  const isBranch = (f: number) => mesh.fLabel[f] === input.branchLabel;
  const hf = hostField(
    host,
    branch,
    stations.map((s) => s.contactA),
  );
  if (!hf.ok) return fail('host-field', { cause: hf.error.detail });
  const bf = branchField(
    branch,
    stations.map((s) => s.contactB),
  );
  if (!bf.ok) return fail('branch-field', { cause: bf.error.detail });
  const options = { maxDeviation: STRIP_CHORD * rho, maxShift: STRIP_SHIFT * rho };
  const cutHost = cutAlongField(mesh, mesh.faces().filter(isHost), hf.value, options);
  if (!cutHost.ok) return fail('cut-host', { cause: cutHost.error.detail });
  const cutBranch = cutAlongField(mesh, mesh.faces().filter(isBranch), bf.value, options);
  if (!cutBranch.ok) return fail('cut-branch', { cause: cutBranch.error.detail });

  const material = mesh.fMaterial[
    (cutHost.value.band[0] ?? cutHost.value.rest[0]) as number
  ] as number;
  const removed = [...cutHost.value.band, ...cutBranch.value.band];
  const touched = new Set<number>();
  for (const f of removed) {
    for (const v of mesh.faceVertices(f)) touched.add(v);
    mesh.removeFace(f);
  }
  const used = new Set<number>();
  for (const f of mesh.faces()) for (const v of mesh.faceVertices(f)) used.add(v);
  for (const v of touched) if (!used.has(v)) mesh.removeVertex(v);

  if (STRIP_TUNING.snap) {
    snapOnto(
      mesh,
      cutHost.value.loop,
      stations.map((s) => s.contactA),
    );
    snapOnto(
      mesh,
      cutBranch.value.loop,
      stations.map((s) => s.contactB),
    );
  }
  const hostSide: Ordered = { ids: [...cutHost.value.loop], keys: [...cutHost.value.keys] };
  const branchSide: Ordered = { ids: [...cutBranch.value.loop], keys: [...cutBranch.value.keys] };
  const [e1, e2] = axisFrame(branch.axis);
  const angleAbout = (p: Tuple3) => {
    const w = sub(p, branch.origin);
    return wrap(atan2(dot(w, e2), dot(w, e1)));
  };
  const rows: number[][] = [];
  for (let r = 1; r < segments; r++) {
    rows.push(
      stations.map((s) => {
        const p = arcPoint(s, rho, r / segments);
        return mesh.addVertex(p[0], p[1], p[2]);
      }),
    );
  }
  const loops: number[][] = [];
  if (segments === 1) {
    pushAll(loops, zipper(hostSide, branchSide));
  } else {
    const near = rows[0] as number[];
    const far = rows[rows.length - 1] as number[];
    const nearHost = ascending(
      near,
      stations.map((s) => angleAbout(s.contactA)),
    );
    const nearBranch = ascending(
      far,
      stations.map((s) => angleAbout(s.contactB)),
    );
    if (nearHost === undefined || nearBranch === undefined) return fail('station-keys');
    pushAll(loops, zipper(hostSide, nearHost));
    for (let r = 0; r + 1 < rows.length; r++) {
      const lo = rows[r] as number[];
      const up = rows[r + 1] as number[];
      for (let k = 0; k < lo.length; k++) {
        const k1 = (k + 1) % lo.length;
        loops.push([lo[k] as number, lo[k1] as number, up[k1] as number, up[k] as number]);
      }
    }
    pushAll(loops, zipper(nearBranch, branchSide));
  }
  const a = hostSide.ids[0] as number;
  const b = hostSide.ids[1] as number;
  const reversed = mesh.hFace[mesh.findHalf(a, b)] !== NONE;
  for (const loop of loops) {
    const added = mesh.addFace(reversed ? [...loop].reverse() : loop, material);
    if (!added.ok) return added;
    mesh.fLabel[added.value] = input.weldLabel;
    mesh.fRole[added.value] = input.weldRole;
    mesh.fFlags[added.value] = (mesh.fFlags[added.value] as number) | FACE_EDGE_ROUND;
  }
  if (mesh.edges().some((e) => mesh.isBoundaryEdge(e))) return fail('open');
  return ok({
    faces: loops.length,
    deviation: Math.max(cutHost.value.deviation, cutBranch.value.deviation) / rho,
    shift: Math.max(cutHost.value.shift, cutBranch.value.shift) / rho,
  });
}
