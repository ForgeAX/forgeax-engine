import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, hypot2 } from '../dmath';
import type { ModelingError } from '../errors';
import { type LoopEdge, ShapeAssembler } from './assembler';
import { area2, isPointList, ringDefect, windPolygon } from './profile';
import { frameDefect } from './surfaces';
import type { ToleranceOptions } from './tolerance';
import { brepError, type Frame, type Shape } from './types';
import { cross3, dist3, madd3, type P2, type P3, scale3, sub3, TWO_PI, unit3 } from './vec';

/** Placement, naming and tolerance shared by every builder. Shapes are built in the local frame `z` up. */
/** Rounding of a coordinate relative to its magnitude, with margin for a few additions. */
const ORIGIN_EPS = 1e-15;

export interface BuildOptions extends ToleranceOptions {
  readonly frame?: Frame;
  /** Face labels are `<label>.<face>`; the default is the builder name. */
  readonly label?: string;
  readonly role?: string;
}

export interface BoxOptions extends BuildOptions {
  /** Edge lengths along the frame x, y and z; the box is centered on the frame origin. */
  readonly size: P3;
}

export interface CylinderOptions extends BuildOptions {
  readonly radius: number;
  /** Centered on the frame origin along the frame z. */
  readonly height: number;
}

/** Base circle at `-height / 2`, apex at `+height / 2`. */
export interface ConeOptions extends BuildOptions {
  readonly radius: number;
  readonly height: number;
}

export interface SphereOptions extends BuildOptions {
  readonly radius: number;
}

export interface TorusOptions extends BuildOptions {
  readonly major: number;
  readonly minor: number;
}

export interface ExtrudeOptions extends BuildOptions {
  /** Outline in the frame xy plane, either winding. */
  readonly profile: readonly P2[];
  /** Through holes strictly inside the outline, either winding. */
  readonly holes?: readonly (readonly P2[])[];
  /** Extent along the frame +z from the xy plane. */
  readonly depth: number;
}

export interface RevolveOptions extends BuildOptions {
  /**
   * `[radius, z]` polyline, counter-clockwise in the (radius, z) plane, revolved a full turn
   * about the frame z. Open profiles start and end on the axis (radius 0); closed ones repeat
   * the first point and keep every radius positive.
   */
  readonly profile: readonly P2[];
}

const WORLD: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function bad(why: string, ids?: Record<string, unknown>): Result<never, ModelingError> {
  return err(brepError('brep-bad-argument', why, ids));
}

function positive(name: string, value: number): Result<number, ModelingError> {
  return Number.isFinite(value) && value > 0
    ? ok(value)
    : bad(`${name} is a finite number greater than 0`, { [name]: value });
}

/** Assembler plus frame placement, deduplicated line and circle edges and the face naming policy. */
class Builder {
  readonly asm: ShapeAssembler;
  private readonly lines = new Map<string, number>();
  private readonly labelBase: string;
  private readonly role: string;

  readonly f: Frame;

  constructor(asm: ShapeAssembler, f: Frame, label: string, role: string) {
    this.asm = asm;
    this.f = f;
    this.labelBase = label;
    this.role = role;
  }

  static create(name: string, diag: number, options: BuildOptions): Result<Builder, ModelingError> {
    const frame = options.frame ?? WORLD;
    const defect = frameDefect(frame);
    if (defect !== undefined) return bad('an orthonormal right-handed frame', { reason: defect });
    const asm = ShapeAssembler.create(diag, options);
    if (!asm.ok) return asm;
    const reach = Math.max(Math.abs(frame.o[0]), Math.abs(frame.o[1]), Math.abs(frame.o[2]));
    if (reach * ORIGIN_EPS > asm.value.tol) {
      return bad(
        'a frame origin close enough to the part that f64 positions resolve the tolerance',
        {
          reason: 'origin-too-far',
          origin: reach,
          tol: asm.value.tol,
        },
      );
    }
    return ok(new Builder(asm.value, frame, options.label ?? name, options.role ?? ''));
  }

  /** A magnitude must exceed twice the tolerance, or distinct features collapse into one vertex. */
  atLeastTol(name: string, value: number): Result<number, ModelingError> {
    return value > 2 * this.asm.tol
      ? ok(value)
      : bad(`${name} greater than twice the tolerance (pass a smaller tol for tiny parts)`, {
          reason: 'size-below-tolerance',
          [name]: value,
          tol: this.asm.tol,
        });
  }

  pt(p: P3): P3 {
    const { o, x, y, z } = this.f;
    return madd3(madd3(madd3(o, x, p[0]), y, p[1]), z, p[2]);
  }

  dir(d: P3): P3 {
    const { x, y, z } = this.f;
    return madd3(madd3(scale3(x, d[0]), y, d[1]), z, d[2]);
  }

  /** A frame whose origin, axis and x are given in the local frame. */
  local(o: P3, z: P3, x: P3): Frame {
    const zz = this.dir(z);
    const xx = this.dir(x);
    return { o: this.pt(o), x: xx, y: cross3(zz, xx), z: zz };
  }

  /** The straight edge between two local points, shared by every face that asks for it. */
  line(a: P3, b: P3): LoopEdge {
    const pa = this.pt(a);
    const pb = this.pt(b);
    const va = this.asm.vertex(pa);
    const vb = this.asm.vertex(pb);
    const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
    const known = this.lines.get(key);
    if (known !== undefined) return { edge: known };
    const length = dist3(pa, pb);
    const curve = this.asm.curve({ kind: 'line', o: pa, d: unit3(sub3(pb, pa)) });
    const edge = this.asm.edge(curve, 0, length);
    this.lines.set(key, edge);
    return { edge };
  }

  /** A full circle of local radius `r` at local height `z` about the local axis, starting on local +x. */
  circle(r: number, z: number): LoopEdge {
    const f = this.local([0, 0, z], [0, 0, 1], [1, 0, 0]);
    const curve = this.asm.curve({ kind: 'circle', frame: f, radius: r });
    return { edge: this.asm.edge(curve, 0, TWO_PI) };
  }

  name(face: string): string {
    return `${this.labelBase}.${face}`;
  }

  add(
    surface: number,
    loops: readonly (readonly LoopEdge[])[],
    reversed: boolean,
    face: string,
  ): Result<number, ModelingError> {
    const ids: number[] = [];
    for (let i = 0; i < loops.length; i++) {
      const l = this.asm.loop(surface, loops[i] as readonly LoopEdge[], i === 0);
      if (!l.ok) return l;
      ids.push(l.value);
    }
    return ok(this.asm.face(surface, ids, reversed, this.name(face), this.role));
  }

  /** A planar face from closed polylines of local points (first = outline); `frame` carries the outward normal. */
  polygon(
    frame: Frame,
    loops: readonly (readonly P3[])[],
    face: string,
  ): Result<number, ModelingError> {
    const surface = this.asm.surface({ kind: 'plane', frame });
    const edges = loops.map((points) =>
      points.map((p, i) => this.line(p, points[(i + 1) % points.length] as P3)),
    );
    return this.add(surface, edges, false, face);
  }

  finish(faces: readonly number[]): Result<Shape, ModelingError> {
    this.asm.shell(faces);
    return this.asm.finish();
  }
}

function collect(
  results: readonly Result<number, ModelingError>[],
): Result<number[], ModelingError> {
  const out: number[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}

export function box(options: BoxOptions): Result<Shape, ModelingError> {
  const size = options.size;
  if (!Array.isArray(size) || size.length !== 3) return bad('size is [x, y, z]');
  for (let i = 0; i < 3; i++) {
    const s = positive(`size[${i}]`, size[i] as number);
    if (!s.ok) return s;
  }
  const h: P3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const b = Builder.create('box', hypot2(hypot2(size[0], size[1]), size[2]), options);
  if (!b.ok) return b;
  for (let i = 0; i < 3; i++) {
    const s = b.value.atLeastTol(`size[${i}]`, size[i] as number);
    if (!s.ok) return s;
  }
  const faces: Result<number, ModelingError>[] = [];
  const names = ['x', 'y', 'z'];
  for (let k = 0; k < 3; k++) {
    for (const s of [1, -1]) {
      const e = (i: number): P3 => [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
      const n = scale3(e(k), s);
      const ta = s > 0 ? e((k + 1) % 3) : e((k + 2) % 3);
      const tb = s > 0 ? e((k + 2) % 3) : e((k + 1) % 3);
      const ha = Math.abs(dotP(ta, h));
      const hb = Math.abs(dotP(tb, h));
      const c = scale3(n, h[k] as number);
      const corner = (sa: number, sb: number): P3 => madd3(madd3(c, ta, sa * ha), tb, sb * hb);
      faces.push(
        b.value.polygon(
          b.value.local(c, n, ta),
          [[corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]],
          `${s > 0 ? 'p' : 'n'}${names[k]}`,
        ),
      );
    }
  }
  const all = collect(faces);
  return all.ok ? b.value.finish(all.value) : all;
}

function dotP(a: P3, b: P3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function sphere(options: SphereOptions): Result<Shape, ModelingError> {
  const r = positive('radius', options.radius);
  if (!r.ok) return r;
  const b = Builder.create('sphere', 2 * options.radius, options);
  if (!b.ok) return b;
  const big = b.value.atLeastTol('radius', options.radius);
  if (!big.ok) return big;
  const { asm } = b.value;
  const f = b.value.local([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const surface = asm.surface({ kind: 'sphere', frame: f, radius: options.radius });
  const meridianFrame: Frame = { o: f.o, x: f.x, y: f.z, z: cross3(f.x, f.z) };
  const meridian = asm.edge(
    asm.curve({ kind: 'circle', frame: meridianFrame, radius: options.radius }),
    -Math.PI / 2,
    Math.PI / 2,
  );
  const south = asm.degenerateEdge(asm.vertex(madd3(f.o, f.z, -options.radius)));
  const north = asm.degenerateEdge(asm.vertex(madd3(f.o, f.z, options.radius)));
  const face = b.value.add(
    surface,
    [
      [
        { edge: meridian },
        { edge: north, span: [-TWO_PI, 0] },
        { edge: meridian },
        { edge: south, span: [TWO_PI, 0] },
      ],
    ],
    false,
    'face',
  );
  return face.ok ? b.value.finish([face.value]) : face;
}

export function torus(options: TorusOptions): Result<Shape, ModelingError> {
  const a = positive('major', options.major);
  if (!a.ok) return a;
  const m = positive('minor', options.minor);
  if (!m.ok) return m;
  if (!(options.minor < options.major))
    return bad('minor is less than major', { major: options.major, minor: options.minor });
  const b = Builder.create('torus', 2 * (options.major + options.minor), options);
  if (!b.ok) return b;
  for (const [name, value] of [
    ['minor', options.minor],
    ['major - minor', options.major - options.minor],
  ] as const) {
    const s = b.value.atLeastTol(name, value);
    if (!s.ok) return s;
  }
  const { asm } = b.value;
  const f = b.value.local([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const surface = asm.surface({
    kind: 'torus',
    frame: f,
    major: options.major,
    minor: options.minor,
  });
  const equator = asm.edge(
    asm.curve({ kind: 'circle', frame: f, radius: options.major + options.minor }),
    0,
    TWO_PI,
  );
  const tube: Frame = { o: madd3(f.o, f.x, options.major), x: f.x, y: f.z, z: cross3(f.x, f.z) };
  const meridian = asm.edge(
    asm.curve({ kind: 'circle', frame: tube, radius: options.minor }),
    0,
    TWO_PI,
  );
  const face = b.value.add(
    surface,
    [[{ edge: equator }, { edge: meridian }, { edge: equator }, { edge: meridian }]],
    false,
    'face',
  );
  return face.ok ? b.value.finish([face.value]) : face;
}

export function extrude(options: ExtrudeOptions): Result<Shape, ModelingError> {
  const d = positive('depth', options.depth);
  if (!d.ok) return d;
  const holes = options.holes ?? [];
  if (!Array.isArray(holes)) return bad('holes is an array of rings');
  const all = [options.profile, ...holes];
  for (const ring of all) {
    if (!isPointList(ring, 3)) return bad('an outline of at least 3 finite points');
    if (area2(ring) === 0) return bad('an outline with non-zero area');
  }
  const outline = windPolygon(options.profile, true);
  const rings = [outline, ...holes.map((h) => windPolygon(h, false))];
  let lo: P2 = outline[0] as P2;
  let hi: P2 = lo;
  for (const p of outline) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
  }
  const b = Builder.create(
    'extrude',
    hypot2(hypot2(hi[0] - lo[0], hi[1] - lo[1]), options.depth),
    options,
  );
  if (!b.ok) return b;
  const sized = b.value.atLeastTol('depth', options.depth);
  if (!sized.ok) return sized;
  const defect = ringDefect(rings, b.value.asm.tol, 'outline');
  if (defect !== undefined) {
    return bad(defect.expected, { reason: defect.reason, ...defect.ids });
  }
  const at = (p: P2, z: number): P3 => [p[0], p[1], z];
  const faces: Result<number, ModelingError>[] = [];
  const ring = (z: number): P3[][] => rings.map((r) => r.map((p) => at(p, z)));
  faces.push(b.value.polygon(b.value.local([0, 0, 0], [0, 0, -1], [1, 0, 0]), ring(0), 'bottom'));
  faces.push(
    b.value.polygon(
      b.value.local([0, 0, options.depth], [0, 0, 1], [1, 0, 0]),
      ring(options.depth),
      'top',
    ),
  );
  let side = 0;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i] as P2;
      const q = r[(i + 1) % r.length] as P2;
      const length = hypot2(q[0] - p[0], q[1] - p[1]);
      const x: P3 = [(q[0] - p[0]) / length, (q[1] - p[1]) / length, 0];
      const n: P3 = [x[1], -x[0], 0];
      faces.push(
        b.value.polygon(
          b.value.local(at(p, 0), n, x),
          [[at(p, 0), at(q, 0), at(q, options.depth), at(p, options.depth)]],
          `side${side++}`,
        ),
      );
    }
  }
  const out = collect(faces);
  return out.ok ? b.value.finish(out.value) : out;
}

export function revolve(options: RevolveOptions): Result<Shape, ModelingError> {
  const pts = options.profile;
  if (!isPointList(pts, 3) || pts.some((p) => p[0] < 0)) {
    return bad('a profile of at least 3 finite points with radius >= 0');
  }
  const first = pts[0] as P2;
  const last = pts[pts.length - 1] as P2;
  const closed = first[0] === last[0] && first[1] === last[1];
  const ring = closed ? pts.slice(0, -1) : pts.slice();
  if (closed ? ring.some((p) => p[0] <= 0) : first[0] !== 0 || last[0] !== 0) {
    return bad(
      closed
        ? 'a closed profile with positive radii'
        : 'an open profile starting and ending on the axis',
    );
  }
  if (!closed && ring.slice(1, -1).some((p) => p[0] === 0)) {
    return bad('an open profile that meets the axis only at its two ends', {
      reason: 'profile-touches-axis',
    });
  }
  const n = ring.length;
  const segments = closed ? n : n - 1;
  let rmax = 0;
  let zmin = Number.POSITIVE_INFINITY;
  let zmax = Number.NEGATIVE_INFINITY;
  for (const p of ring) {
    rmax = Math.max(rmax, p[0]);
    zmin = Math.min(zmin, p[1]);
    zmax = Math.max(zmax, p[1]);
  }
  const b = Builder.create('revolve', hypot2(2 * rmax, zmax - zmin), options);
  if (!b.ok) return b;
  const defect = ringDefect([ring], b.value.asm.tol, 'profile');
  if (defect !== undefined) return bad(defect.expected, { reason: defect.reason, ...defect.ids });
  if (!(area2(ring) > 0)) return bad('a profile counter-clockwise in the (radius, z) plane');
  const { asm } = b.value;
  const circles = new Map<number, LoopEdge>();
  const circleAt = (i: number): LoopEdge | undefined => {
    const p = ring[i] as P2;
    if (p[0] === 0) return undefined;
    let c = circles.get(i);
    if (c === undefined) {
      c = b.value.circle(p[0], p[1]);
      circles.set(i, c);
    }
    return c;
  };
  const faces: Result<number, ModelingError>[] = [];
  for (let i = 0; i < segments; i++) {
    const p = ring[i] as P2;
    const q = ring[(i + 1) % n] as P2;
    const name = `s${i}`;
    const dr = q[0] - p[0];
    const dz = q[1] - p[1];
    if (dr === 0 && dz === 0) return bad('a profile without repeated points', { index: i });
    if (dz === 0) {
      const down = dr > 0;
      const frame = b.value.local([0, 0, p[1]], [0, 0, down ? -1 : 1], [1, 0, 0]);
      const surface = asm.surface({ kind: 'plane', frame });
      const big = (p[0] > q[0] ? circleAt(i) : circleAt((i + 1) % n)) as LoopEdge;
      const small = p[0] > q[0] ? circleAt((i + 1) % n) : circleAt(i);
      faces.push(
        b.value.add(surface, small === undefined ? [[big]] : [[big], [small]], false, name),
      );
      continue;
    }
    const up = dz > 0;
    const lowIndex = up ? i : (i + 1) % n;
    const highIndex = up ? (i + 1) % n : i;
    const lo = ring[lowIndex] as P2;
    const hi = ring[highIndex] as P2;
    const lowEdge = circleAt(lowIndex);
    const highEdge = circleAt(highIndex);
    const lowV = asm.vertex(b.value.pt([lo[0], 0, lo[1]]));
    const highV = asm.vertex(b.value.pt([hi[0], 0, hi[1]]));
    const surface =
      dr === 0
        ? asm.surface({
            kind: 'cylinder',
            frame: b.value.local([0, 0, 0], [0, 0, 1], [1, 0, 0]),
            radius: lo[0],
          })
        : asm.surface({
            kind: 'cone',
            frame: b.value.local([0, 0, lo[1]], [0, 0, 1], [1, 0, 0]),
            radius: lo[0],
            halfAngle: atan2(hi[0] - lo[0], hi[1] - lo[1]),
          });
    const seamLine = b.value.line([lo[0], 0, lo[1]], [hi[0], 0, hi[1]]);
    const lowLoop: LoopEdge = lowEdge ?? { edge: asm.degenerateEdge(lowV), span: [TWO_PI, 0] };
    const highLoop: LoopEdge = highEdge ?? { edge: asm.degenerateEdge(highV), span: [-TWO_PI, 0] };
    const loop =
      lowEdge === undefined
        ? [seamLine, highLoop, seamLine, lowLoop]
        : [lowLoop, seamLine, highLoop, seamLine];
    faces.push(b.value.add(surface, [loop], !up, name));
  }
  const out = collect(faces);
  return out.ok ? b.value.finish(out.value) : out;
}

export function cylinder(options: CylinderOptions): Result<Shape, ModelingError> {
  const r = positive('radius', options.radius);
  if (!r.ok) return r;
  const h = positive('height', options.height);
  if (!h.ok) return h;
  const { radius, height } = options;
  const built = revolve({
    ...options,
    profile: [
      [0, -height / 2],
      [radius, -height / 2],
      [radius, height / 2],
      [0, height / 2],
    ],
    label: options.label ?? 'cylinder',
  });
  return built;
}

export function cone(options: ConeOptions): Result<Shape, ModelingError> {
  const r = positive('radius', options.radius);
  if (!r.ok) return r;
  const h = positive('height', options.height);
  if (!h.ok) return h;
  return revolve({
    ...options,
    profile: [
      [0, -options.height / 2],
      [options.radius, -options.height / 2],
      [0, options.height / 2],
    ],
    label: options.label ?? 'cone',
  });
}
