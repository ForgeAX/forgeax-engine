import { ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from '../arrays';
import { hypot3 } from '../dmath';
import type { ModelingError } from '../errors';
import { ShapeAssembler } from './assembler';
import {
  booleanPlanarCross,
  booleanPlanarCrossCarryingHoles,
  hasOnlyPlanarFaces,
} from './boolean-planar-cross';
import { Copier } from './copier';
import { curvePoint } from './curves';
import { type IntersectionBranch, intersectSurfaces } from './intersect';
import { closedHoleLoops } from './nurbs-chain';
import { clipNurbsBranches } from './nurbs-clip';
import { type NurbsCylinderSection, unionNurbsCylinder } from './nurbs-cylinder-union';
import { type NurbsSection, unionNurbsPlane } from './nurbs-plane-union';
import { joinBranches } from './query/stitch';
import { type CapHole, planSectionCap } from './section-cap';
import { tessellate } from './tessellate';
import { classifyOnFace, faceTrim } from './trim-face';
import { cutBranch } from './trim-span';
import { brepFail, type Frame, type Shape, type Surface } from './types';
import { validate } from './validate';
import { dist3, type P3, TWO_PI } from './vec';

/**
 * E1c slice 2: a boolean of two input solids. Each planar face is cut by the closed circles where it
 * meets a cylindrical face of the other solid; each cylinder is cut into height strips at those
 * circles. Pieces are classified in or out of the other solid by ray parity through its tessellation,
 * kept or dropped by the operation's rule, and sewn into one shell from edges shared by position.
 * Anything outside this family returns `model-partial` rather than a shape.
 */
export type BooleanOp = 'union' | 'difference' | 'intersect';

type Side = 0 | 1;

/** One clipped NURBS section between a NURBS face and a plane face, as found by the pair loop. */
interface NurbsSectionRecord {
  readonly wallSide: Side;
  readonly wallFace: number;
  readonly plateSide: Side;
  readonly plateFace: number;
  readonly nurbsIsA: boolean;
  readonly branch: IntersectionBranch;
  readonly t0: number;
  readonly t1: number;
  readonly p0: P3;
  readonly p1: P3;
}

interface NurbsCylinderRecord {
  readonly wallSide: Side;
  readonly wallFace: number;
  readonly lateralSide: Side;
  readonly lateralFace: number;
  readonly section: NurbsCylinderSection;
}

interface Lateral {
  readonly side: Side;
  readonly face: number;
  readonly surface: Surface & { readonly kind: 'cylinder' };
  /** The two boundary circles of the cylinder face, by height along its axis. */
  readonly lo: { readonly h: number; readonly edge: number };
  readonly hi: { readonly h: number; readonly edge: number };
}

interface Cut {
  readonly lateral: number;
  readonly h: number;
}

interface Tri {
  readonly a: P3;
  readonly b: P3;
  readonly c: P3;
}

/** A fixed direction: ray parity avoids edges and vertices with probability one. */
const RAY: P3 = [0.2672612419124244, 0.5345224838248488, 0.8017837257372732];
const SAMPLES = 64;

function sub(a: P3, b: P3): P3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: P3, b: P3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: P3, b: P3): P3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unsupported(why: string, ids: Record<string, unknown> = {}): Result<never, ModelingError> {
  return brepFail('brep-ssi-unsupported', why, ids);
}

function triangles(shape: Shape): Result<Tri[], ModelingError> {
  const m = tessellate(shape, { angle: Math.PI / 32 });
  if (!m.ok) return m;
  const out: Tri[] = [];
  for (const f of m.value.faces()) {
    const vs = m.value.faceVertices(f).map((v) => m.value.position(v));
    for (let i = 1; i + 1 < vs.length; i++)
      out.push({ a: vs[0] as P3, b: vs[i] as P3, c: vs[i + 1] as P3 });
  }
  return ok(out);
}

/**
 * Whether the ray from `o` along `dir` crosses triangle `t`. `ambiguous` is set when the crossing lies
 * within `EDGE_BAND` of a triangle edge: a ray through a shared edge is counted by both triangles or by
 * neither, so its parity is unreliable and the caller must cast another direction.
 */
const EDGE_BAND = 1e-9;
function rayHits(o: P3, t: Tri, dir: P3, flags: { ambiguous: boolean }): boolean {
  const e1 = sub(t.b, t.a);
  const e2 = sub(t.c, t.a);
  const p = cross(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-14) return false;
  const inv = 1 / det;
  const s = sub(o, t.a);
  const u = dot(s, p) * inv;
  if (u < -EDGE_BAND || u > 1 + EDGE_BAND) return false;
  const q = cross(s, e1);
  const v = dot(dir, q) * inv;
  if (v < -EDGE_BAND || u + v > 1 + EDGE_BAND) return false;
  const hit = dot(e2, q) * inv;
  if (hit <= 1e-12) return false;
  if (Math.abs(u) < EDGE_BAND || Math.abs(v) < EDGE_BAND || Math.abs(1 - u - v) < EDGE_BAND) {
    flags.ambiguous = true;
  }
  return true;
}

/** Parity of crossings with the solid, cast along a direction that crosses no shared edge. */
const RAY_FALLBACKS: readonly P3[] = [
  [0.6, 0.48, 0.64],
  [0.1, 0.9, 0.42],
  [0.77, -0.21, 0.6],
];
function insideSolid(tris: readonly Tri[], p: P3): boolean {
  for (const dir of [RAY, ...RAY_FALLBACKS]) {
    const flags = { ambiguous: false };
    let n = 0;
    for (const t of tris) if (rayHits(p, t, dir, flags)) n++;
    if (!flags.ambiguous) return n % 2 === 1;
  }
  let n = 0;
  for (const t of tris) if (rayHits(p, t, RAY, { ambiguous: false })) n++;
  return n % 2 === 1;
}

/** Sample points of a face's outer loop: edge end vertices, or circle samples for closed edges. */
function loopSamples(shape: Shape, f: number): P3[] {
  const face = shape.faces[f];
  return loopPoints(shape, face?.loops[0] ?? -1);
}

/** Loop samples in traversal order, honouring each coedge's `reversed` flag (NURBS clipping needs it). */
function orientedLoopSamples(shape: Shape, f: number): P3[] {
  const loop = shape.loops[shape.faces[f]?.loops[0] ?? -1];
  const pts: P3[] = [];
  for (const c of loop?.coedges ?? []) {
    const co = shape.coedges[c];
    const e = shape.edges[co?.edge ?? -1];
    if (co === undefined || e === undefined) continue;
    if (e.curve < 0) {
      const p = shape.vertices[e.v0]?.p;
      if (p !== undefined) pts.push(p);
      continue;
    }
    const curve = shape.curves[e.curve];
    if (curve === undefined) continue;
    for (let i = 0; i < 8; i++) {
      const u = co.reversed ? 1 - i / 8 : i / 8;
      pts.push(curvePoint(curve, e.t0 + (e.t1 - e.t0) * u));
    }
  }
  return pts;
}

function loopPoints(shape: Shape, l: number): P3[] {
  const loop = shape.loops[l];
  const pts: P3[] = [];
  for (const c of loop?.coedges ?? []) {
    const e = shape.edges[shape.coedges[c]?.edge ?? -1];
    if (e === undefined) continue;
    if (e.curve < 0) {
      const p = shape.vertices[e.v0]?.p;
      if (p !== undefined) pts.push(p);
      continue;
    }
    const curve = shape.curves[e.curve];
    if (curve === undefined) continue;
    for (let i = 0; i < 8; i++) pts.push(curvePoint(curve, e.t0 + ((e.t1 - e.t0) * i) / 8));
  }
  return pts;
}

/** A point strictly inside a planar face, checked against that face's own trim. */
function planarInterior(shape: Shape, f: number): Result<P3, ModelingError> {
  const pts = loopSamples(shape, f);
  if (pts.length === 0) return unsupported('a planar face with a loop', { face: f });
  const n = pts.length;
  const p: P3 = [
    pts.reduce((acc, q) => acc + q[0], 0) / n,
    pts.reduce((acc, q) => acc + q[1], 0) / n,
    pts.reduce((acc, q) => acc + q[2], 0) / n,
  ];
  const trim = faceTrim(shape, f);
  if (classifyOnFace(trim, p) === 'in') return ok(p);
  // An annulus centroid lies in its hole. Probe rays from the outer-loop centre instead.
  const face = shape.faces[f];
  const outer = face?.loops.find((l) => shape.loops[l]?.outer !== false) ?? -1;
  const ring = loopPoints(shape, outer);
  if (ring.length > 0) {
    const m = ring.length;
    const c: P3 = [
      ring.reduce((acc, q) => acc + q[0], 0) / m,
      ring.reduce((acc, q) => acc + q[1], 0) / m,
      ring.reduce((acc, q) => acc + q[2], 0) / m,
    ];
    for (const q of ring) {
      for (const t of [0.5, 0.75, 0.9, 0.97]) {
        const s: P3 = [
          c[0] + (q[0] - c[0]) * t,
          c[1] + (q[1] - c[1]) * t,
          c[2] + (q[2] - c[2]) * t,
        ];
        if (classifyOnFace(trim, s) === 'in') return ok(s);
      }
    }
  }
  return unsupported('a planar face whose centroid lies inside its trim', {
    face: f,
    class: 'out',
  });
}

/** A point on the first edge of loop `l`, used to place a bounding hole against a cut circle. */
function loopFirstPoint(shape: Shape, l: number): P3 {
  const loop = shape.loops[l];
  const e = shape.edges[shape.coedges[loop?.coedges[0] ?? -1]?.edge ?? -1];
  if (e === undefined) return [0, 0, 0];
  if (e.curve < 0) return shape.vertices[e.v0]?.p ?? [0, 0, 0];
  const curve = shape.curves[e.curve];
  return curve === undefined ? [0, 0, 0] : curvePoint(curve, e.t0);
}

function boundingBox(pts: readonly P3[]): { lo: P3; hi: P3 } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k] as number, p[k] as number);
      hi[k] = Math.max(hi[k] as number, p[k] as number);
    }
  }
  return { lo: lo as unknown as P3, hi: hi as unknown as P3 };
}

function boxesMeet(a: { lo: P3; hi: P3 }, b: { lo: P3; hi: P3 }, tol: number): boolean {
  for (let k = 0; k < 3; k++) {
    if ((a.hi[k] as number) < (b.lo[k] as number) - tol) return false;
    if ((b.hi[k] as number) < (a.lo[k] as number) - tol) return false;
  }
  return true;
}

function lateralOf(shape: Shape, side: Side, f: number): Result<Lateral, ModelingError> {
  const face = shape.faces[f];
  const surface = face === undefined ? undefined : shape.surfaces[face.surface];
  if (surface?.kind !== 'cylinder') return unsupported('a cylindrical face', { face: f });
  const loop = face === undefined ? undefined : shape.loops[face.loops[0] ?? -1];
  if (face?.loops.length !== 1 || loop === undefined || loop.coedges.length !== 4) {
    return unsupported('a cylinder bounded by two circles and two seams', {
      face: f,
    });
  }
  const circles: { h: number; edge: number }[] = [];
  let seams = 0;
  for (const c of loop.coedges) {
    const edge = shape.coedges[c]?.edge ?? -1;
    const e = shape.edges[edge];
    const curve = e === undefined || e.curve < 0 ? undefined : shape.curves[e.curve];
    if (curve?.kind === 'circle') {
      circles.push({
        h: dot(sub(curve.frame.o, surface.frame.o), surface.frame.z),
        edge,
      });
    } else if (curve?.kind === 'line') {
      seams++;
    }
  }
  if (circles.length !== 2 || seams !== 2) {
    return unsupported('a cylinder bounded by two circles and two seams', {
      face: f,
    });
  }
  const [c0, c1] = circles as [{ h: number; edge: number }, { h: number; edge: number }];
  const lo = c0.h < c1.h ? c0 : c1;
  const hi = c0.h < c1.h ? c1 : c0;
  return ok({ side, face: f, surface, lo, hi });
}

function seamPoint(surface: Surface & { readonly kind: 'cylinder' }, h: number): P3 {
  const { o, x, z } = surface.frame;
  const r = surface.radius;
  return [o[0] + h * z[0] + r * x[0], o[1] + h * z[1] + r * x[1], o[2] + h * z[2] + r * x[2]];
}

function axisPoint(frame: Frame, h: number): P3 {
  const { o, z } = frame;
  return [o[0] + h * z[0], o[1] + h * z[1], o[2] + h * z[2]];
}

function collect(
  results: readonly Result<number, ModelingError>[],
): Result<number[], ModelingError> {
  const ids: number[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    ids.push(r.value);
  }
  return ok(ids);
}

function pushTo(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

type Circle = { o: P3; z: P3; r: number };
type FaceRef = { side: Side; face: number };
/** A coplanar, opposite-normal contact: the guest's face lies inside the host's face and is removed by union. */
interface Contact {
  readonly host: FaceRef;
  readonly guest: FaceRef;
  readonly guestOuter: number;
  readonly pairs: readonly { host: number; guest: number }[];
}

function planeFrame(shape: Shape, f: number): Frame {
  const face = shape.faces[f] as Shape['faces'][number];
  const surf = shape.surfaces[face.surface] as Surface;
  if (surf.kind !== 'plane') throw new Error('planeFrame called on a non-plane face');
  return surf.frame;
}

function outwardNormal(shape: Shape, f: number): P3 {
  const face = shape.faces[f] as Shape['faces'][number];
  const z = planeFrame(shape, f).z;
  const k = face.reversed ? -1 : 1;
  return [k * z[0], k * z[1], k * z[2]];
}

function loopCircle(shape: Shape, l: number): Circle | null {
  const loop = shape.loops[l];
  if (loop?.coedges.length !== 1) return null;
  const e = shape.edges[shape.coedges[loop.coedges[0] ?? -1]?.edge ?? -1];
  const curve = e === undefined || e.curve < 0 ? undefined : shape.curves[e.curve];
  return curve?.kind === 'circle' ? { o: curve.frame.o, z: curve.frame.z, r: curve.radius } : null;
}

function sameCircle(a: Circle, b: Circle, tol: number): boolean {
  return (
    dist3(a.o, b.o) <= tol &&
    Math.abs(a.r - b.r) <= tol &&
    Math.abs(Math.abs(dot(a.z, b.z)) - 1) <= 1e-9
  );
}

function loopEdgeOf(shape: Shape, l: number): number {
  return shape.coedges[shape.loops[l]?.coedges[0] ?? -1]?.edge ?? -1;
}

/** The span of `lat` along `host`'s axis, in the host's coordinates. */
function axialSpan(host: Lateral, lat: Lateral): { lo: number; hi: number } {
  const { o, z } = host.surface.frame;
  const ends = [lat.lo.h, lat.hi.h].map((h) => dot(sub(seamPoint(lat.surface, h), o), z));
  return { lo: minOf(ends), hi: maxOf(ends) };
}

/** Overlap length along the first cylinder's axis of two coaxial cylinders; zero or less when they only touch. */
function axialOverlap(la: Lateral, lb: Lateral): number {
  const g = axialSpan(la, lb);
  return Math.min(la.hi.h, g.hi) - Math.max(la.lo.h, g.lo);
}

/** A coaxial equal-radius contact: `guest` lies wholly inside `host`'s span; `lo`..`hi` is the overlap in host coordinates. */
interface Coaxial {
  readonly host: number;
  readonly guest: number;
  readonly lo: number;
  readonly hi: number;
}

/** The overlap in host coordinates when `guest` lies wholly inside `host`'s span and the overlap is positive. */
function guestWithin(
  host: Lateral,
  guest: Lateral,
  tol: number,
): { lo: number; hi: number } | null {
  const g = axialSpan(host, guest);
  const lo = Math.max(host.lo.h, g.lo);
  const hi = Math.min(host.hi.h, g.hi);
  if (hi - lo <= tol) return null;
  const guestWhole = Math.abs(lo - g.lo) <= tol && Math.abs(hi - g.hi) <= tol;
  const hostWhole = Math.abs(lo - host.lo.h) <= tol && Math.abs(hi - host.hi.h) <= tol;
  return guestWhole && !hostWhole ? { lo, hi } : null;
}

/**
 * Coaxial equal-radius laterals of opposite solids, one wholly inside the other, whose material lies on
 * opposite sides of the shared surface: the overlapped band is interior to a union. Every other coaxial
 * pair stays with the refusal that names it.
 */
function coaxialContacts(
  laterals: readonly Lateral[],
  tris: readonly [Tri[], Tri[]],
  tol: number,
): Coaxial[] {
  const out: Coaxial[] = [];
  for (let i = 0; i < laterals.length; i++) {
    for (let j = i + 1; j < laterals.length; j++) {
      const la = laterals[i] as Lateral;
      const lb = laterals[j] as Lateral;
      if (la.side === lb.side) continue;
      if (Math.abs(la.surface.radius - lb.surface.radius) > tol) continue;
      const za = la.surface.frame.z;
      if (Math.abs(Math.abs(dot(za, lb.surface.frame.z)) - 1) > 1e-9) continue;
      const off = sub(lb.surface.frame.o, la.surface.frame.o);
      const along = dot(off, za);
      if (hypot3(off[0] - za[0] * along, off[1] - za[1] * along, off[2] - za[2] * along) > tol)
        continue;
      const asI = guestWithin(la, lb, tol);
      const host = asI !== null ? i : j;
      const guest = asI !== null ? j : i;
      const ov = asI ?? guestWithin(lb, la, tol);
      if (ov === null) continue;
      const hostLat = laterals[host] as Lateral;
      const guestLat = laterals[guest] as Lateral;
      // Probe a point just inside the shared radius at the overlap's middle: the two solids' material
      // lies on the same side when both probes agree, which is a true overlap rather than a contact.
      const hm = (ov.lo + ov.hi) / 2;
      const axis = axisPoint(hostLat.surface.frame, hm);
      const surf = seamPoint(hostLat.surface, hm);
      const r = hostLat.surface.radius;
      const u: P3 = [(surf[0] - axis[0]) / r, (surf[1] - axis[1]) / r, (surf[2] - axis[2]) / r];
      const d = r * 0.1;
      const probe: P3 = [
        axis[0] + (r - d) * u[0],
        axis[1] + (r - d) * u[1],
        axis[2] + (r - d) * u[2],
      ];
      if (insideSolid(tris[hostLat.side], probe) === insideSolid(tris[guestLat.side], probe))
        continue;
      out.push({ host, guest, lo: ov.lo, hi: ov.hi });
    }
  }
  return out;
}

/**
 * Tests one role assignment of a coplanar opposite-normal pair. The guest's outer loop must lie inside the
 * host's trim; each guest hole must match a host hole exactly; each unmatched host hole must lie outside the
 * guest. Returns null when the guest is not inside the host, so the caller may try the other way round.
 */
function planarContact(
  solids: readonly [Shape, Shape],
  host: FaceRef,
  guest: FaceRef,
  tol: number,
): Result<Contact | null, ModelingError> {
  const H = solids[host.side];
  const G = solids[guest.side];
  const nH = outwardNormal(H, host.face);
  const nG = outwardNormal(G, guest.face);
  if (dot(nH, nG) > -1 + 1e-9) return ok(null);
  if (Math.abs(dot(sub(planeFrame(G, guest.face).o, planeFrame(H, host.face).o), nH)) > tol) {
    return ok(null);
  }
  const outerOf = (s: Shape, f: number): number[] =>
    (s.faces[f] as Shape['faces'][number]).loops.filter((l) => s.loops[l]?.outer !== false);
  const holesOf = (s: Shape, f: number): number[] =>
    (s.faces[f] as Shape['faces'][number]).loops.filter((l) => s.loops[l]?.outer === false);
  const hOuter = outerOf(H, host.face);
  const gOuter = outerOf(G, guest.face);
  if (hOuter.length !== 1 || gOuter.length !== 1) {
    return unsupported('a planar contact face with one outer loop', {});
  }
  const hTrim = faceTrim(H, host.face);
  const gTrim = faceTrim(G, guest.face);
  const guestOuter = gOuter[0] as number;
  for (const p of loopPoints(G, guestOuter)) if (classifyOnFace(hTrim, p) !== 'in') return ok(null);
  const hHoles = holesOf(H, host.face);
  const pairs: { host: number; guest: number }[] = [];
  const matched = new Set<number>();
  for (const gl of holesOf(G, guest.face)) {
    const gc = loopCircle(G, gl);
    const hl =
      gc === null
        ? undefined
        : hHoles.find((l) => {
            const hc = loopCircle(H, l);
            return hc !== null && sameCircle(hc, gc, tol);
          });
    if (hl === undefined) return unsupported('a contact hole without a matching host hole', {});
    pairs.push({ host: hl, guest: gl });
    matched.add(hl);
  }
  for (const hl of hHoles) {
    if (matched.has(hl)) continue;
    for (const p of loopPoints(H, hl)) {
      if (classifyOnFace(gTrim, p) !== 'out') {
        return unsupported('a host hole inside the contact region', {});
      }
    }
  }
  return ok({ host, guest, guestOuter, pairs });
}

function planarContactEither(
  solids: readonly [Shape, Shape],
  a: FaceRef,
  b: FaceRef,
  tol: number,
): Result<Contact | null, ModelingError> {
  const first = planarContact(solids, a, b, tol);
  if (!first.ok || first.value !== null) return first;
  return planarContact(solids, b, a, tol);
}

/**
 * A same-direction coplanar guest face whose outer loop lies inside the host face is covered by it: a
 * union keeps the host face alone, so the guest is dropped without a contact hole.
 */
function sameSideAbsorbed(solids: readonly [Shape, Shape], a: FaceRef, b: FaceRef): FaceRef | null {
  for (const [host, guest] of [
    [a, b],
    [b, a],
  ] as const) {
    const H = solids[host.side];
    const G = solids[guest.side];
    if (dot(outwardNormal(H, host.face), outwardNormal(G, guest.face)) < 1 - 1e-9) continue;
    const gOuter = (G.faces[guest.face] as Shape['faces'][number]).loops.filter(
      (l) => G.loops[l]?.outer !== false,
    );
    if (gOuter.length !== 1) continue;
    const hTrim = faceTrim(H, host.face);
    if (loopPoints(G, gOuter[0] as number).every((p) => classifyOnFace(hTrim, p) === 'in'))
      return guest;
  }
  return null;
}

function isContactCap(
  branch: IntersectionBranch,
  lat: Lateral,
  circles: readonly Circle[],
  tol: number,
): boolean {
  if (branch.curve.kind !== 'circle') return false;
  const bc: Circle = {
    o: branch.curve.frame.o,
    z: branch.curve.frame.z,
    r: branch.curve.radius,
  };
  const h = dot(sub(bc.o, lat.surface.frame.o), lat.surface.frame.z);
  const atCap = Math.abs(h - lat.lo.h) <= tol || Math.abs(h - lat.hi.h) <= tol;
  return atCap && circles.some((c) => sameCircle(c, bc, tol));
}

/**
 * The height of the circle a branch makes on a cylinder, or `null` when the circle misses the planar
 * face (wholly outside) or lies beyond the cylinder's extent. A circle that is neither is unsupported.
 */
function circleOnCylinder(
  branch: IntersectionBranch,
  lat: Lateral,
  planar: { owner: Shape; face: number; surface: Surface },
  sA: Surface,
  sB: Surface,
  tol: number,
  coaxialEnds: readonly number[],
): Result<number | null, ModelingError> {
  if (!branch.closed || branch.curve.kind !== 'circle')
    return unsupported('a closed circle branch');
  const axis = lat.surface.frame.z;
  if (Math.abs(Math.abs(dot(branch.curve.frame.z, axis)) - 1) > 1e-7) {
    return unsupported('a circle normal along the cylinder axis');
  }
  const h = dot(sub(branch.curve.frame.o, lat.surface.frame.o), axis);
  // The plane/cylinder intersection is the full unbounded circle; one beyond the bounded lateral face
  // cannot cut it, so it is no contact rather than an unsupported case.
  if (h < lat.lo.h - tol || h > lat.hi.h + tol) return ok(null);
  // A coaxial contact already cuts the lateral here, and its circle is the planar face's own boundary.
  if (coaxialEnds.some((e) => Math.abs(e - h) <= tol)) return ok(null);
  const trim = faceTrim(planar.owner, planar.face);
  let inside = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t = branch.t0 + ((branch.t1 - branch.t0) * i) / SAMPLES;
    const c = classifyOnFace(trim, curvePoint(branch.curve, t));
    if (c === 'in') inside++;
    else if (c !== 'out')
      return unsupported('a circle that is neither wholly in nor out of the planar face');
  }
  if (inside === 0) return ok(null);
  if (inside !== SAMPLES) return unsupported('a circle partly inside the planar face');
  if (h <= lat.lo.h + tol || h >= lat.hi.h - tol) {
    return unsupported('a circle on a cylinder cap or beyond its extent', {
      h,
    });
  }
  const spans = cutBranch(sA, sB, branch, tol);
  const uSeams = spans.cuts.filter((c) => c.kind === 'u-seam').length;
  if (uSeams !== 1) return unsupported('a circle crossing the cylinder seam once', { uSeams });
  void planar.surface;
  return ok(h);
}

export function booleanSolids(a: Shape, b: Shape, op: BooleanOp): Result<Shape, ModelingError> {
  for (const s of [a, b]) {
    const report = validate(s);
    if (!report.ok)
      return brepFail('brep-bad-argument', 'an input solid must validate', {
        issues: report.issues.length,
      });
  }
  const tol = Math.max(a.tol, b.tol);
  // G2: a tool whose edges pierce a host circular cap is split first; the union then gains the cap's inner loop.
  const section = op === 'union' ? planSectionCap(a, b, tol) : ok(null);
  if (!section.ok) return section;
  const solids: readonly [Shape, Shape] = section.value?.solids ?? [a, b];
  const sectionHoles = section.value?.holes ?? new Map<string, CapHole>();
  const sectionPieces = section.value?.pieces ?? new Set<string>();

  const laterals: Lateral[] = [];
  const lateralIndex = new Map<string, number>();
  for (const side of [0, 1] as const) {
    const shape = solids[side];
    for (let f = 0; f < shape.faces.length; f++) {
      const face = shape.faces[f] as Shape['faces'][number];
      if (shape.surfaces[face.surface]?.kind !== 'cylinder') continue;
      const lat = lateralOf(shape, side, f);
      if (!lat.ok) return lat;
      lateralIndex.set(`${side}:${f}`, laterals.length);
      laterals.push(lat.value);
    }
  }

  // Every cylinder/plane branch that can bound a piece lies inside this ball around the origin.
  let reach = 0;
  for (const sh of [a, b]) {
    for (const v of sh.vertices) reach = Math.max(reach, Math.sqrt(dot(v.p, v.p)));
  }
  const span = { c: [0, 0, 0] as P3, r: 2 * reach + 1 };

  // Pair every face of one solid with every face of the other. Plane/plane pairs may meet only where
  // their boxes do not overlap; cylinder/cylinder pairs must not meet; plane/cylinder pairs meet in
  // closed circles, each of which cuts the planar face and the cylinder.
  const cuts: Cut[] = [];
  const planarCuts = new Map<string, number[]>();
  const lateralCuts = new Map<string, number[]>();
  const contacts: Contact[] = [];
  const contactCircles = new Map<string, Circle[]>();
  const absorbed = new Set<string>();
  const nurbsSections: NurbsSectionRecord[] = [];
  const nurbsCylinderRecords: NurbsCylinderRecord[] = [];
  const tris: [Tri[], Tri[]] = [[], []];
  for (const side of [0, 1] as const) {
    const t = triangles(solids[side]);
    if (!t.ok) return t;
    tris[side] = t.value;
  }
  // Each coaxial contact cuts its host lateral at the guest's ends; the guest bore and the overlapped band
  // are dropped by the strip emission, and the guest's end circles share the host's cut edges.
  const coaxial = coaxialContacts(laterals, tris, tol);
  const coaxialPairs = new Set<string>();
  const coaxialSkip = new Map<number, number[]>();
  const coaxialCuts: (Coaxial & {
    readonly cuts: readonly (number | null)[];
  })[] = [];
  for (const c of coaxial) {
    const host = laterals[c.host] as Lateral;
    coaxialPairs.add(`${Math.min(c.host, c.guest)}:${Math.max(c.host, c.guest)}`);
    const cutIds: (number | null)[] = [];
    for (const h of [c.lo, c.hi]) {
      coaxialSkip.set(c.host, [...(coaxialSkip.get(c.host) ?? []), h]);
      if (h <= host.lo.h + tol || h >= host.hi.h - tol) {
        cutIds.push(null);
        continue;
      }
      const id = cuts.length;
      cuts.push({ lateral: c.host, h });
      pushTo(lateralCuts, `${host.side}:${host.face}`, id);
      cutIds.push(id);
    }
    coaxialCuts.push({ ...c, cuts: cutIds });
  }
  const inCoaxialOverlap = (li: number | undefined, p: P3): boolean =>
    coaxialCuts.some((c) => {
      if (c.host !== li && c.guest !== li) return false;
      const host = laterals[c.host] as Lateral;
      const h = dot(sub(p, host.surface.frame.o), host.surface.frame.z);
      return h > c.lo + tol && h < c.hi - tol;
    });
  // Only a union with a planar-planar pair needs the planar pass; every other operation keeps the
  // original single face-major order, so each refusal reason stays on the same surface pair.
  const planarPassNeeded =
    op === 'union' &&
    solids[0].faces.some((f) => solids[0].surfaces[f.surface]?.kind === 'plane') &&
    solids[1].faces.some((f) => solids[1].surfaces[f.surface]?.kind === 'plane');
  {
    // Each (A face, B face) pair is visited once; the surface order inside intersectSurfaces is fixed.
    // Planar pairs go first, so a coplanar contact is registered before the cylinder circles on its plane.
    const sa: Side = 0;
    const sb: Side = 1;
    const phases: readonly (boolean | null)[] = planarPassNeeded ? [true, false] : [null];
    for (const planarPhase of phases) {
      for (let fa = 0; fa < solids[sa].faces.length; fa++) {
        for (let fb = 0; fb < solids[sb].faces.length; fb++) {
          const faceA = solids[sa].faces[fa] as Shape['faces'][number];
          const faceB = solids[sb].faces[fb] as Shape['faces'][number];
          const surfA = solids[sa].surfaces[faceA.surface] as Surface;
          const surfB = solids[sb].surfaces[faceB.surface] as Surface;
          const kinds = `${surfA.kind}/${surfB.kind}`;
          // NURBS faces enter only against a plane; NURBS x cylinder and NURBS x NURBS stay refused.
          const nurbsPlane =
            (surfA.kind === 'nurbs' && surfB.kind === 'plane') ||
            (surfA.kind === 'plane' && surfB.kind === 'nurbs');
          const nurbsCylinder =
            (surfA.kind === 'nurbs' && surfB.kind === 'cylinder') ||
            (surfA.kind === 'cylinder' && surfB.kind === 'nurbs');
          if (surfA.kind !== 'plane' && surfA.kind !== 'cylinder' && !nurbsPlane && !nurbsCylinder)
            return unsupported('plane or cylinder faces', { kinds });
          if (surfB.kind !== 'plane' && surfB.kind !== 'cylinder' && !nurbsPlane && !nurbsCylinder)
            return unsupported('plane or cylinder faces', { kinds });
          if (planarPhase !== null) {
            const isPlanePair = surfA.kind === 'plane' && surfB.kind === 'plane';
            if (isPlanePair !== planarPhase) continue;
          }
          if (surfA.kind === 'cylinder' && surfB.kind === 'cylinder') {
            const ia = lateralIndex.get(`${sa}:${fa}`);
            const ib = lateralIndex.get(`${sb}:${fb}`);
            if (
              ia !== undefined &&
              ib !== undefined &&
              coaxialPairs.has(`${Math.min(ia, ib)}:${Math.max(ia, ib)}`)
            )
              continue;
          }
          const r = intersectSurfaces(surfA, surfB, tol, {
            window: span,
            ids: [sa, sb],
          });
          if (!r.ok) return r;
          const partial = r.value.partials[0];
          const coplanar =
            surfA.kind === 'plane' &&
            surfB.kind === 'plane' &&
            partial?.code === 'brep-ssi-coincident';
          if (
            surfA.kind === 'cylinder' &&
            surfB.kind === 'cylinder' &&
            partial?.code === 'brep-ssi-coincident'
          ) {
            const la = laterals[lateralIndex.get(`${sa}:${fa}`) ?? -1];
            const lb = laterals[lateralIndex.get(`${sb}:${fb}`) ?? -1];
            if (la === undefined || lb === undefined)
              return unsupported('a cylinder in the index', { kinds });
            if (axialOverlap(la, lb) <= tol) continue;
            return unsupported('coaxial cylinders that overlap', { kinds });
          }
          if (nurbsCylinder) {
            // S4: chain-level gate. Closed hole loops are admitted as sections; the wall hole and
            // cylinder piece assembly is not implemented, so an admitted loop is refused by name.
            const chains = joinBranches(
              r.value.branches.map((b) => ({
                closed: b.closed,
                ends: [curvePoint(b.curve, b.t0), curvePoint(b.curve, b.t1)] as [P3, P3],
              })),
              tol * 10,
            );
            const loops = closedHoleLoops(chains, partial?.code);
            if (!loops.ok) return loops;
            if (loops.value.length === 0) continue;
            const branch = r.value.branches[0];
            const nurbsIsA = surfA.kind === 'nurbs';
            const onWall = branch === undefined ? undefined : nurbsIsA ? branch.onA : branch.onB;
            const onCyl = branch === undefined ? undefined : nurbsIsA ? branch.onB : branch.onA;
            if (
              loops.value.length !== 1 ||
              r.value.branches.length !== 1 ||
              branch === undefined ||
              !branch.closed ||
              branch.curve.kind !== 'nurbs' ||
              onWall?.kind !== 'nurbs' ||
              onCyl?.kind !== 'nurbs'
            )
              return unsupported('nurbs-assembly-pending', {
                reason: 'cylinder-hole-assembly',
                loops: loops.value.length,
              });
            nurbsCylinderRecords.push({
              wallSide: (nurbsIsA ? sa : sb) as Side,
              wallFace: nurbsIsA ? fa : fb,
              lateralSide: (nurbsIsA ? sb : sa) as Side,
              lateralFace: nurbsIsA ? fb : fa,
              section: {
                wallFace: nurbsIsA ? fa : fb,
                curve: branch.curve.curve,
                onWall: onWall.curve,
                onCylinder: onCyl.curve,
                t0: branch.t0,
                t1: branch.t1,
              },
            });
            continue;
          }
          if (partial !== undefined && !coplanar)
            return brepFail(partial.code, 'a tangent or unsupported surface pair', {});
          if (r.value.branches.length === 0 && !coplanar) continue;
          if (surfA.kind === 'plane' && surfB.kind === 'plane') {
            // A section-capped host cap meets its tool's split pieces only along their shared section edge.
            const ka = `${sa}:${fa}`;
            const kb = `${sb}:${fb}`;
            if (
              (sectionHoles.has(ka) && sectionPieces.has(kb)) ||
              (sectionHoles.has(kb) && sectionPieces.has(ka))
            )
              continue;
            // A section piece lying inside the other solid is discarded by union, so its edge contact
            // with that solid's face needs no cut.
            const insidePiece = (side: Side, face: number, other: Side): boolean => {
              if (!sectionPieces.has(`${side}:${face}`)) return false;
              const p = planarInterior(solids[side], face);
              return p.ok && insideSolid(tris[other], p.value);
            };
            if (!coplanar && (insidePiece(sa, fa, sb) || insidePiece(sb, fb, sa))) continue;
            // Coplanar or crossing planes only matter where their own loops meet; disjoint loops never do.
            const boxA = boundingBox(loopSamples(solids[sa], fa));
            const boxB = boundingBox(loopSamples(solids[sb], fb));
            if (!boxesMeet(boxA, boxB, tol)) continue;
            if (coplanar && op === 'union') {
              const g = sameSideAbsorbed(solids, { side: sa, face: fa }, { side: sb, face: fb });
              if (g !== null) {
                absorbed.add(`${g.side}:${g.face}`);
                continue;
              }
            }
            const c: Result<Contact | null, ModelingError> =
              coplanar && op === 'union'
                ? planarContactEither(solids, { side: sa, face: fa }, { side: sb, face: fb }, tol)
                : ok(null);
            if (!c.ok) return c;
            if (c.value === null) {
              if (hasOnlyPlanarFaces(solids)) return booleanPlanarCross(solids, tol, op);
              const carried = booleanPlanarCrossCarryingHoles(solids, tol, op);
              if (carried !== null) return carried;
              // Reaching here means a curved face is present (the all-planar case returned above), so the
              // missing piece is a planar arrangement that carries circle loops, not the planar cut graph.
              return unsupported('planar faces that meet along a line', {
                kinds,
                reason: 'planar-chord-with-curved-solid',
              });
            }
            const contact = c.value;
            contacts.push(contact);
            const circles: Circle[] = [];
            const outer = loopCircle(solids[contact.guest.side], contact.guestOuter);
            if (outer !== null) circles.push(outer);
            for (const pr of contact.pairs) {
              const hc = loopCircle(solids[contact.guest.side], pr.guest);
              if (hc !== null) circles.push(hc);
            }
            for (const key of [`${sa}:${fa}`, `${sb}:${fb}`]) {
              contactCircles.set(key, [...(contactCircles.get(key) ?? []), ...circles]);
            }
            continue;
          }
          if (surfA.kind === 'cylinder' && surfB.kind === 'cylinder') {
            return unsupported('cylinders that meet', { kinds });
          }
          if (nurbsPlane) {
            // S2b1: the NURBS section is clipped to the plane face; the wall hole and kept piece
            // assembly is not implemented yet, so a clipped branch is refused by name.
            if (r.value.branches.length === 0) continue;
            const planeSideN = surfA.kind === 'plane' ? sa : sb;
            const planeFaceN = surfA.kind === 'plane' ? fa : fb;
            const clipped = clipNurbsBranches(
              r.value.branches,
              orientedLoopSamples(solids[planeSideN], planeFaceN),
              outwardNormal(solids[planeSideN], planeFaceN),
              tol,
            );
            if (!clipped.ok) return clipped;
            for (const ci of clipped.value) {
              const br = r.value.branches[ci.branch] as IntersectionBranch;
              nurbsSections.push({
                wallFace: surfA.kind === 'nurbs' ? fa : fb,
                plateFace: planeFaceN,
                wallSide: surfA.kind === 'nurbs' ? sa : sb,
                plateSide: planeSideN,
                nurbsIsA: surfA.kind === 'nurbs',
                branch: br,
                t0: ci.t0,
                t1: ci.t1,
                p0: ci.p0,
                p1: ci.p1,
              });
            }
            continue;
          }
          const planeSide = surfA.kind === 'plane' ? sa : sb;
          const planeFace = surfA.kind === 'plane' ? fa : fb;
          const lateralSide = (1 - planeSide) as Side;
          const lateralFace = surfA.kind === 'plane' ? fb : fa;
          const li = lateralIndex.get(`${lateralSide}:${lateralFace}`);
          if (li === undefined)
            return unsupported('a cylinder in the index', {
              face: lateralFace,
            });
          const lat = laterals[li] as Lateral;
          const planeSurface = solids[planeSide].surfaces[
            solids[planeSide].faces[planeFace]?.surface ?? -1
          ] as Surface;
          // A planar face whose every sampled point lies strictly inside the cylinder's radius cannot meet
          // its lateral surface; the convex footprint then stays inside the disc, so no branch exists.
          const footprint = loopSamples(solids[planeSide], planeFace);
          const inside = footprint.every((q) => {
            const w = sub(q, lat.surface.frame.o);
            const along = dot(w, lat.surface.frame.z);
            const perp = sub(w, [
              lat.surface.frame.z[0] * along,
              lat.surface.frame.z[1] * along,
              lat.surface.frame.z[2] * along,
            ]);
            return Math.sqrt(dot(perp, perp)) < lat.surface.radius - tol;
          });
          if (inside && footprint.length > 0) continue;
          for (const branch of r.value.branches) {
            if (
              isContactCap(branch, lat, contactCircles.get(`${planeSide}:${planeFace}`) ?? [], tol)
            )
              continue;
            const h = circleOnCylinder(
              branch,
              lat,
              {
                owner: solids[planeSide],
                face: planeFace,
                surface: planeSurface,
              },
              surfA,
              surfB,
              tol,
              coaxialSkip.get(li) ?? [],
            );
            if (!h.ok) return h;
            if (h.value === null) continue;
            const dup = cuts.some(
              (c) => c.lateral === li && Math.abs(c.h - (h.value as number)) < tol,
            );
            if (dup) return unsupported('a circle reached by two faces');
            const id = cuts.length;
            cuts.push({ lateral: li, h: h.value });
            pushTo(planarCuts, `${planeSide}:${planeFace}`, id);
            pushTo(lateralCuts, `${lateralSide}:${lateralFace}`, id);
          }
        }
      }
    }
  }

  const diag = dist3(
    boundingBox(a.vertices.map((v) => v.p)).lo,
    boundingBox(a.vertices.map((v) => v.p)).hi,
  );
  if (nurbsCylinderRecords.length > 0) {
    // S4: NURBS walls with one cylinder, each section a closed loop; bare union only.
    const rec = nurbsCylinderRecords[0] as NurbsCylinderRecord;
    const sameLateral = nurbsCylinderRecords.every(
      (x) =>
        x.lateralSide === rec.lateralSide &&
        x.lateralFace === rec.lateralFace &&
        x.wallSide === rec.wallSide,
    );
    const li = lateralIndex.get(`${rec.lateralSide}:${rec.lateralFace}`);
    const lat = li === undefined ? undefined : laterals[li];
    const bare =
      op === 'union' &&
      sameLateral &&
      nurbsSections.length === 0 &&
      cuts.length === 0 &&
      contacts.length === 0 &&
      absorbed.size === 0 &&
      coaxial.length === 0 &&
      sectionHoles.size === 0 &&
      sectionPieces.size === 0;
    if (!bare || lat === undefined)
      return unsupported('nurbs-assembly-pending', { reason: 'cylinder-hole-assembly' });
    return unionNurbsCylinder({
      solids,
      wallSide: rec.wallSide,
      lateralSide: rec.lateralSide,
      lateral: { surface: lat.surface, lo: lat.lo, hi: lat.hi, face: lat.face },
      sections: nurbsCylinderRecords.map((x) => x.section),
      diag,
      tol,
      inside: (side, p) => insideSolid(tris[side], p),
    });
  }
  if (nurbsSections.length > 0) {
    // S2b2: only the bare union of one NURBS wall with one plate is assembled. Any other planar
    // or cylinder work in the same pair loop keeps its refusal by name.
    const bareUnion =
      op === 'union' &&
      cuts.length === 0 &&
      contacts.length === 0 &&
      absorbed.size === 0 &&
      coaxial.length === 0 &&
      sectionHoles.size === 0 &&
      sectionPieces.size === 0 &&
      nurbsSections.every((s) => s.wallSide !== s.plateSide);
    if (!bareUnion)
      return unsupported('nurbs-assembly-pending', {
        sections: nurbsSections.length,
      });
    const wallSide = nurbsSections[0]?.wallSide as Side;
    if (nurbsSections.some((s) => s.wallSide !== wallSide))
      return unsupported('nurbs-assembly-pending', { reason: 'walls-on-both-solids' });
    const sections: NurbsSection[] = [];
    for (const s of nurbsSections) {
      // intersectSurfaces reports onA for its first operand; the NURBS face is that operand when nurbsIsA.
      const onWall = s.nurbsIsA ? s.branch.onA : s.branch.onB;
      const onPlate = s.nurbsIsA ? s.branch.onB : s.branch.onA;
      if (s.branch.curve.kind !== 'nurbs' || onWall.kind !== 'nurbs' || onPlate.kind !== 'nurbs')
        return unsupported('nurbs-assembly-pending', { reason: 'section-pcurve-kind' });
      sections.push({
        wallFace: s.wallFace,
        plateFace: s.plateFace,
        curve: s.branch.curve.curve,
        onWall: onWall.curve,
        onPlate: onPlate.curve,
        t0: s.t0,
        t1: s.t1,
        p0: s.p0,
        p1: s.p1,
      });
    }
    return unionNurbsPlane({
      solids,
      wallSide,
      sections,
      diag,
      tol,
      inside: (side, p) => insideSolid(tris[side], p),
    });
  }
  const asm = ShapeAssembler.create(Math.max(diag, tol));
  if (!asm.ok) return asm;
  const out = asm.value;
  const copiers: [Copier, Copier] = [new Copier(solids[0], out), new Copier(solids[1], out)];
  const circleEdges = new Map<number, number>();
  const seamEdges = new Map<string, number>();

  const circle = (cut: number): number => {
    const known = circleEdges.get(cut);
    if (known !== undefined) return known;
    const c = cuts[cut] as Cut;
    const lat = laterals[c.lateral] as Lateral;
    const frame = lat.surface.frame;
    const curve = out.curve({
      kind: 'circle',
      frame: { o: axisPoint(frame, c.h), x: frame.x, y: frame.y, z: frame.z },
      radius: lat.surface.radius,
    });
    const id = out.edge(curve, 0, TWO_PI);
    circleEdges.set(cut, id);
    return id;
  };
  const seam = (lat: Lateral, h0: number, h1: number): number => {
    const p = seamPoint(lat.surface, h0);
    const q = seamPoint(lat.surface, h1);
    const v0 = out.vertex(p);
    const v1 = out.vertex(q);
    const key = v0 < v1 ? `${v0}:${v1}` : `${v1}:${v0}`;
    const known = seamEdges.get(key);
    if (known !== undefined) return known;
    const len = dist3(p, q);
    const d: P3 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len, (q[2] - p[2]) / len];
    const id = out.edge(out.curve({ kind: 'line', o: p, d }), 0, len);
    seamEdges.set(key, id);
    return id;
  };

  // A piece of side `side` survives when its location against the other solid matches the rule.
  const keep = (side: Side, insideOther: boolean): boolean => {
    if (op === 'union') return !insideOther;
    if (op === 'intersect') return insideOther;
    return side === 0 ? !insideOther : insideOther;
  };
  // A surviving piece of `b` inside `a` faces into the void a difference leaves, so its normal flips.
  const flip = (side: Side): boolean => op === 'difference' && side === 1;

  // Coincident bore circles of a contact are one edge: the guest's copy reuses the host's.
  for (const c of contacts) {
    for (const pr of c.pairs) {
      const out = copiers[c.host.side].edge(loopEdgeOf(solids[c.host.side], pr.host));
      copiers[c.guest.side].alias(loopEdgeOf(solids[c.guest.side], pr.guest), out);
    }
  }
  // A coaxial guest's end circles are the host's cut circles at the same heights (or the host's own end).
  for (const c of coaxialCuts) {
    const host = laterals[c.host] as Lateral;
    const guest = laterals[c.guest] as Lateral;
    const hostH = (h: number): number =>
      dot(sub(seamPoint(guest.surface, h), host.surface.frame.o), host.surface.frame.z);
    for (const end of [guest.lo, guest.hi]) {
      const eh = hostH(end.h);
      const k = Math.abs(eh - c.lo) <= tol ? 0 : 1;
      const cut = c.cuts[k];
      const target =
        cut !== null && cut !== undefined
          ? circle(cut)
          : copiers[host.side].edge(k === 0 ? host.lo.edge : host.hi.edge);
      copiers[guest.side].alias(end.edge, target);
    }
  }
  const hostsOf = new Map<string, Contact[]>();
  const guestFaces = new Set<string>();
  for (const c of contacts) {
    const key = `${c.host.side}:${c.host.face}`;
    hostsOf.set(key, [...(hostsOf.get(key) ?? []), c]);
    guestFaces.add(`${c.guest.side}:${c.guest.face}`);
  }

  const faces: number[] = [];
  for (const side of [0, 1] as const) {
    const shape = solids[side];
    const other = (1 - side) as Side;
    const cp = copiers[side];
    for (let f = 0; f < shape.faces.length; f++) {
      const face = shape.faces[f] as Shape['faces'][number];
      const surf = cp.surface(face.surface);
      const reversed = face.reversed !== flip(side);
      const surfaceKind = shape.surfaces[face.surface]?.kind;

      if (surfaceKind === 'plane') {
        const key = `${side}:${f}`;
        if (guestFaces.has(key) || absorbed.has(key)) continue;
        const hosted = hostsOf.get(key);
        if (hosted !== undefined) {
          if ((planarCuts.get(key) ?? []).length > 0)
            return unsupported('a planar contact face with a cylinder cut', {
              face: f,
            });
          const outer = face.loops.find((l) => shape.loops[l]?.outer !== false);
          if (outer === undefined)
            return unsupported('a planar face with an outer loop', { face: f });
          const matchedHost = new Set(hosted.flatMap((c) => c.pairs.map((pr) => pr.host)));
          const loops = collect([
            out.loop(surf, cp.loopEdges(outer), true),
            ...face.loops
              .filter((l) => l !== outer && !matchedHost.has(l))
              .map((l) => out.loop(surf, cp.loopEdges(l), false)),
            ...hosted.map((c) =>
              out.loop(surf, copiers[c.guest.side].loopEdges(c.guestOuter), false),
            ),
          ]);
          if (!loops.ok) return loops;
          faces.push(out.face(surf, loops.value, reversed, face.label, face.role));
          continue;
        }
        const hole = sectionHoles.get(key);
        if (hole !== undefined) {
          // Union keeps the cap outside the tool's section: the inner loop is the section polygon.
          const outer = face.loops.find((l) => shape.loops[l]?.outer !== false);
          if (outer === undefined || face.loops.length !== 1)
            return unsupported('a section cap with one outer loop', {
              face: f,
            });
          const loops = collect([
            out.loop(surf, cp.loopEdges(outer), true),
            out.loop(
              surf,
              hole.edges.map((e) => ({ edge: copiers[hole.tool].edge(e) })),
              false,
            ),
          ]);
          if (!loops.ok) return loops;
          faces.push(out.face(surf, loops.value, reversed, face.label, face.role));
          continue;
        }
        const cs = planarCuts.get(`${side}:${f}`) ?? [];
        if (cs.length === 0) {
          const p = planarInterior(shape, f);
          if (!p.ok) return p;
          if (!keep(side, insideSolid(tris[other], p.value))) continue;
          const ids = collect(
            face.loops.map((l) => out.loop(surf, cp.loopEdges(l), shape.loops[l]?.outer ?? true)),
          );
          if (!ids.ok) return ids;
          faces.push(out.face(surf, ids.value, reversed, face.label, face.role));
          continue;
        }
        const outers = face.loops.filter((l) => shape.loops[l]?.outer !== false);
        const holes = face.loops.filter((l) => shape.loops[l]?.outer === false);
        if (cs.length !== 1 || outers.length !== 1)
          return unsupported('one circle on a planar face with one outer loop', { face: f });
        const outerLoop = outers[0] as number;
        const cutId = cs[0] as number;
        const c = cuts[cutId] as Cut;
        const lat = laterals[c.lateral] as Lateral;
        const discInside = insideSolid(tris[other], axisPoint(lat.surface.frame, c.h));
        // The disc and the annulus are the two pieces of the planar face cut by the circle. Holes that
        // already bound the face go with the piece that contains them. Each piece is built only when
        // kept, so no unused loop is left behind.
        const center = axisPoint(lat.surface.frame, c.h);
        const inDisc = (l: number): boolean =>
          dist3(loopFirstPoint(shape, l), center) < lat.surface.radius;
        const holesIn = holes.filter(inDisc);
        const holesOut = holes.filter((l) => !inDisc(l));
        const keepAnnulus = keep(side, !discInside);
        const keepDisc = keep(side, discInside);
        if (keepAnnulus) {
          const annulus = collect([
            out.loop(surf, cp.loopEdges(outerLoop), true),
            ...holesOut.map((l) => out.loop(surf, cp.loopEdges(l), false)),
            out.loop(surf, [{ edge: circle(cutId) }], false),
          ]);
          if (!annulus.ok) return annulus;
          faces.push(out.face(surf, annulus.value, reversed, face.label, face.role));
        }
        if (keepDisc) {
          const disc = collect([
            out.loop(surf, [{ edge: circle(cutId) }], true),
            ...holesIn.map((l) => out.loop(surf, cp.loopEdges(l), false)),
          ]);
          if (!disc.ok) return disc;
          faces.push(out.face(surf, disc.value, reversed, face.label, face.role));
        }
        continue;
      }

      const li = lateralIndex.get(`${side}:${f}`);
      const lat = li === undefined ? undefined : laterals[li];
      if (lat === undefined) return unsupported('a lateral face in the index', { face: f });
      const cs = lateralCuts.get(`${side}:${f}`) ?? [];
      if (cs.length === 0) {
        const mid = seamPoint(lat.surface, (lat.lo.h + lat.hi.h) / 2);
        if (inCoaxialOverlap(li, mid)) continue;
        if (!keep(side, insideSolid(tris[other], mid))) continue;
        const ids = collect(
          face.loops.map((l) => out.loop(surf, cp.loopEdges(l), shape.loops[l]?.outer ?? true)),
        );
        if (!ids.ok) return ids;
        faces.push(out.face(surf, ids.value, reversed, face.label, face.role));
        continue;
      }
      const bounds: { h: number; edge: () => number }[] = [
        { h: lat.lo.h, edge: () => cp.edge(lat.lo.edge) },
        ...cs.map((id) => ({ h: (cuts[id] as Cut).h, edge: () => circle(id) })),
        { h: lat.hi.h, edge: () => cp.edge(lat.hi.edge) },
      ].sort((x, y) => x.h - y.h);
      for (let i = 0; i + 1 < bounds.length; i++) {
        const lo = bounds[i] as (typeof bounds)[number];
        const hi = bounds[i + 1] as (typeof bounds)[number];
        const mid = seamPoint(lat.surface, (lo.h + hi.h) / 2);
        if (inCoaxialOverlap(li, mid)) continue;
        if (!keep(side, insideSolid(tris[other], mid))) continue;
        const strip = collect([
          out.loop(
            surf,
            [
              { edge: lo.edge() },
              { edge: seam(lat, lo.h, hi.h) },
              { edge: hi.edge() },
              { edge: seam(lat, lo.h, hi.h) },
            ],
            true,
          ),
        ]);
        if (!strip.ok) return strip;
        faces.push(out.face(surf, strip.value, reversed, face.label, face.role));
      }
    }
  }

  out.shell(faces);
  return out.finish();
}
