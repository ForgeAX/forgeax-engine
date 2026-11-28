import { ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, hypot2, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { curvePoint, curveTangent } from './curves';
import { coedgeEnds } from './faces';
import { type Element2, partial } from './section';
import { surfaceDerivatives, surfaceInverse } from './surfaces';
import type { Coedge, Curve, Edge, Face, Frame, Loop, Shape, Surface } from './types';
import { cross3, dot3, len3, madd3, type P2, type P3, scale3, sub3, unit3 } from './vec';

/** One side of an edge: the face's surface, its orientation, and the unit direction into the face across the edge. */
export interface BlendSide {
  readonly surface: Surface;
  readonly reversed: boolean;
  readonly inward: P3;
}

/**
 * The 2D section in which a blend between two analytic faces is solved in closed form.
 * `extrusion`: both faces are invariant along the line edge (planes containing it, cylinders parallel
 * to it); the section is the plane through `origin` normal to `axis`, with basis `x`, `y`.
 * `revolution`: both faces are invariant about the circle edge's axis; section coordinates are
 * (radius, height) in the half plane through `x`, measured from the circle center `origin` along `axis`.
 */
export interface Section {
  readonly family: 'extrusion' | 'revolution';
  readonly origin: P3;
  readonly axis: P3;
  readonly x: P3;
  readonly y: P3;
  /** The edge curve; every blend curve keeps its parameter. */
  readonly edge: Curve;
  readonly a: Element2;
  readonly b: Element2;
  readonly ta: P2;
  readonly tb: P2;
  /** The edge point in section coordinates. */
  readonly at: P2;
}

/** Angle within which two directions count as parallel (the pcurve closed-form threshold). */
const PARALLEL = 1e-9;

function parallel(a: P3, b: P3): boolean {
  return len3(cross3(a, b)) < PARALLEL;
}

function onAxis(o: P3, axisPoint: P3, axis: P3, scale: number): boolean {
  const d = sub3(o, axisPoint);
  return len3(sub3(d, scale3(axis, dot3(d, axis)))) < PARALLEL * Math.max(1, scale);
}

function nonAnalytic(side: string, s: Surface, family: string): Result<never, ModelingError> {
  return partial('blend-nonanalytic', `a face pair with a closed-form ${family} blend`, {
    side,
    surface: s.kind,
  });
}

function extrusionElement(
  side: BlendSide,
  name: string,
  s: Pick<Section, 'origin' | 'axis' | 'x' | 'y'>,
): Result<Element2, ModelingError> {
  const proj = (q: P3): P2 => [dot3(sub3(q, s.origin), s.x), dot3(sub3(q, s.origin), s.y)];
  const sign = side.reversed ? -1 : 1;
  const surface = side.surface;
  if (surface.kind === 'plane' && Math.abs(dot3(surface.frame.z, s.axis)) < PARALLEL) {
    const n = scale3(surface.frame.z, sign);
    return ok({ kind: 'line', p: proj(surface.frame.o), n: [dot3(n, s.x), dot3(n, s.y)] });
  }
  if (surface.kind === 'cylinder' && parallel(surface.frame.z, s.axis)) {
    return ok({ kind: 'arc', c: proj(surface.frame.o), r: surface.radius, sign });
  }
  return nonAnalytic(name, surface, 'extrusion');
}

function revolutionElement(
  side: BlendSide,
  name: string,
  s: Pick<Section, 'origin' | 'axis'>,
): Result<Element2, ModelingError> {
  const surface = side.surface;
  if (surface.kind === 'nurbs') return nonAnalytic(name, surface, 'revolution');
  const sign = side.reversed ? -1 : 1;
  const f = surface.frame;
  const h = dot3(sub3(f.o, s.origin), s.axis);
  if (surface.kind === 'plane') {
    if (!parallel(f.z, s.axis)) return nonAnalytic(name, surface, 'revolution');
    return ok({ kind: 'line', p: [0, h], n: [0, sign * dot3(f.z, s.axis)] });
  }
  const scale = 'radius' in surface ? surface.radius : surface.major;
  if (!onAxis(f.o, s.origin, s.axis, scale)) return nonAnalytic(name, surface, 'revolution');
  if (surface.kind === 'sphere') return ok({ kind: 'arc', c: [0, h], r: surface.radius, sign });
  if (!parallel(f.z, s.axis)) return nonAnalytic(name, surface, 'revolution');
  const up = dot3(f.z, s.axis);
  switch (surface.kind) {
    case 'cylinder':
      return ok({ kind: 'line', p: [surface.radius, 0], n: [sign, 0] });
    case 'torus':
      return ok({ kind: 'arc', c: [surface.major, h], r: surface.minor, sign });
    case 'cone': {
      const ca = cos(surface.halfAngle);
      const sa = sin(surface.halfAngle);
      return ok({ kind: 'line', p: [surface.radius, h], n: [sign * ca, -sign * sa * up] });
    }
  }
}

/**
 * The closed-form section of an edge between two faces at edge parameter `t`, or `model-partial`
 * `blend-nonanalytic` when the pair is neither an extrusion nor a revolution pair.
 */
export function sectionOf(
  edge: Curve,
  t: number,
  a: BlendSide,
  b: BlendSide,
): Result<Section, ModelingError> {
  let base: Pick<Section, 'family' | 'origin' | 'axis' | 'x' | 'y'>;
  if (edge.kind === 'line') {
    const axis = unit3(edge.d);
    const x = unit3(sub3(a.inward, scale3(axis, dot3(a.inward, axis))));
    base = { family: 'extrusion', origin: edge.o, axis, x, y: cross3(axis, x) };
  } else if (edge.kind === 'circle') {
    const f = edge.frame;
    base = { family: 'revolution', origin: f.o, axis: f.z, x: f.x, y: f.y };
  } else {
    return partial('blend-nonanalytic', 'a line or circle edge', { curve: edge.kind });
  }
  const p = curvePoint(edge, t);
  let ea: Result<Element2, ModelingError>;
  let eb: Result<Element2, ModelingError>;
  let proj: (v: P3, point: boolean) => P2;
  if (base.family === 'extrusion') {
    ea = extrusionElement(a, 'a', base);
    eb = extrusionElement(b, 'b', base);
    proj = (v, point) => {
      const d = point ? sub3(v, base.origin) : v;
      return [dot3(d, base.x), dot3(d, base.y)];
    };
  } else {
    ea = revolutionElement(a, 'a', base);
    eb = revolutionElement(b, 'b', base);
    const rel = sub3(p, base.origin);
    const radial = unit3(sub3(rel, scale3(base.axis, dot3(rel, base.axis))));
    proj = (v, point) => {
      const d = point ? sub3(v, base.origin) : v;
      return [dot3(d, radial), dot3(d, base.axis)];
    };
  }
  if (!ea.ok) return ea;
  if (!eb.ok) return eb;
  const unit2 = (q: P2): P2 => {
    const l = hypot2(q[0], q[1]);
    return [q[0] / l, q[1] / l];
  };
  return ok({
    ...base,
    edge,
    a: ea.value,
    b: eb.value,
    ta: unit2(proj(a.inward, false)),
    tb: unit2(proj(b.inward, false)),
    at: proj(p, true),
  });
}

/** A section point as the 3D curve it sweeps, keeping the edge parameter. */
export function sweptCurve(s: Section, q: P2): Curve {
  if (s.family === 'extrusion') {
    const e = s.edge as Curve & { kind: 'line' };
    return { kind: 'line', o: madd3(madd3(e.o, s.x, q[0]), s.y, q[1]), d: e.d };
  }
  const f = (s.edge as Curve & { kind: 'circle' }).frame;
  return { kind: 'circle', frame: { ...f, o: madd3(f.o, f.z, q[1]) }, radius: q[0] };
}

/** A direction of the section plane in 3D at the edge start (extrusion: everywhere). */
export function sectionDir(s: Section, q: P2): P3 {
  return madd3(scale3(s.x, q[0]), s.family === 'extrusion' ? s.y : s.axis, q[1]);
}

export function frameAt(o: P3, z: P3, x: P3): Frame {
  return { o, x, y: cross3(z, x), z };
}

export function angle2(q: P2): number {
  return atan2(q[1], q[0]);
}

/** Map a face of a shape to its blend side across edge `e`: the inward direction is (du x dv) x edge tangent. */
export function sideOf(shape: Shape, face: number, coedge: number, t: number): BlendSide {
  const f = shape.faces[face] as Face;
  const co = shape.coedges[coedge] as Coedge;
  const e = shape.edges[co.edge] as Edge;
  const surface = shape.surfaces[f.surface] as Surface;
  const curve = shape.curves[e.curve] as Curve;
  const pt = curvePoint(curve, t);
  const inv = surfaceInverse(surface, pt);
  const { du, dv } = surfaceDerivatives(surface, inv.u, inv.v);
  // Loops are counter-clockwise in (u, v) regardless of `reversed`, so the interior lies left of the
  // traversal about du x dv.
  const tangent = scale3(curveTangent(curve, t), co.reversed ? -1 : 1);
  return { surface, reversed: f.reversed, inward: unit3(cross3(cross3(du, dv), tangent)) };
}

/** The two faces and coedges using edge `e`, in coedge order, or `undefined` when the edge is not manifold. */
export function edgeFaces(
  shape: Shape,
  e: number,
): { faces: [number, number]; coedges: [number, number] } | undefined {
  const faces: number[] = [];
  const coedges: number[] = [];
  shape.faces.forEach((f: Face, fi) => {
    for (const l of f.loops) {
      for (const c of (shape.loops[l] as Loop).coedges) {
        if ((shape.coedges[c] as Coedge).edge === e) {
          faces.push(fi);
          coedges.push(c);
        }
      }
    }
  });
  if (faces.length !== 2) return undefined;
  return {
    faces: [faces[0] as number, faces[1] as number],
    coedges: [coedges[0] as number, coedges[1] as number],
  };
}

/** The (u, v) start of a coedge; exported for callers mapping sides back to parameter space. */
export function coedgeStart(shape: Shape, c: number): P2 {
  const co = shape.coedges[c] as Coedge;
  return coedgeEnds(shape.edges[co.edge] as Edge, co).start;
}
