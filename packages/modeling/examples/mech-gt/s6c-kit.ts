import { err, ok, type Result } from '@forgeax/engine-types';
import { type Model, ModelingError, model, type Point2, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { ACCENT, GT_STENCILS, PRIMER, type StencilSpec, stencilPlate } from './s6b-paint.ts';

/**
 * Case C-100 stage S6c (code name mech-gt): the shared kit of the detail recipes. A
 * recipe builds one detail in its own frame (X along the mount's long axis, Y out of the
 * mount surface, Z = X x Y), names every face `<name>-<feature>`, tags it `detail:<name>`
 * and returns it with its derived dimensions; `placeOn` carries it onto an anchor and adds
 * the host's `part:<id>` tag, so the S4/S7 rig binds it with the part it rides.
 */
export interface DetailPart {
  readonly model: Model;
  readonly name: string;
  /** Named sub-parts (labels) of the detail, each a real piece of geometry. */
  readonly pieces: readonly string[];
  readonly dimensions: Readonly<Record<string, number>>;
}

/** A mount on the body: origin, outward normal and long-axis tangent (unit), and the host part. */
export interface Anchor {
  readonly part: string;
  readonly origin: Tuple3;
  readonly normal: Tuple3;
  readonly tangent: Tuple3;
  /** Footprint or opening size along the tangent and the third axis (meters). */
  readonly size?: readonly [number, number];
  /** Closed opening outline in the anchor frame's tangent/third-axis plane, `[x, z]`. */
  readonly outline?: readonly Point2[];
}

/** Inclusive parameter range check; the first violation is the recipe's failure. */
export function ranged(params: Readonly<Record<string, readonly [value: number, min: number, max: number]>>): Result<void, ModelingError> {
  for (const [name, [value, min, max]] of Object.entries(params)) {
    if (!Number.isFinite(value) || value < min - 1e-12 || value > max + 1e-12) {
      return err(new ModelingError({ code: 'model-invalid-argument', expected: `${name} within [${min}, ${max}]`, detail: { [name]: value, min, max }, hint: 'pass a value inside the declared range' }));
    }
  }
  return ok(undefined);
}

/** A fresh detail session whose labels the recipe collects as its named pieces. */
export function detailSession(name: string): { readonly m: Model; readonly piece: (feature: string) => string; readonly pieces: string[] } {
  const pieces: string[] = [];
  return {
    m: model(),
    pieces,
    piece: (feature: string) => {
      const label = `${name}-${feature}`;
      if (!pieces.includes(label)) pieces.push(label);
      return label;
    },
  };
}

/** Close a detail: tag every face, mark creases sharp, give it meter-scaled box UVs on both channels. */
export function finishDetail(name: string, m: Model, pieces: readonly string[], dimensions: Record<string, number>, sharp = 35): Result<DetailPart, ModelingError> {
  m.tag(sel.all(), `detail:${name}`);
  if (m.count(sel.edges.dihedral('>', sharp)) > 0) m.markSharp(sel.edges.dihedral('>', sharp));
  // Stencil plates keep the planar uv1 cell their decal sheet is drawn in.
  const decals = m.inspect().materials.filter((slot) => slot.startsWith('gt-decal-') && m.count(sel.material(slot)) > 0);
  const plain = decals.reduce((faces, slot) => faces.minus(sel.material(slot)), sel.all());
  m.uv.project({ mode: 'box', scale: 1, channel: 'uv0' });
  m.uv.project({ mode: 'box', scale: 1, channel: 'uv1', faces: plain });
  if (m.poisoned !== undefined) return err(m.poisoned);
  return ok({ model: m, name, pieces, dimensions });
}

export const unwrapPart = (r: Result<DetailPart, ModelingError>): DetailPart => {
  if (!r.ok) throw r.error;
  return r.value;
};

// ---- vectors -------------------------------------------------------------------------

export const add3 = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Tuple3, s: number): Tuple3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Tuple3, b: Tuple3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Tuple3, b: Tuple3): Tuple3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit3 = (a: Tuple3): Tuple3 => scale3(a, 1 / Math.hypot(...a));

/**
 * Turn and move every face of `m` from its local frame onto the anchor frame: local X onto
 * the tangent (made orthogonal to the normal), local Y onto the normal, local Z onto their
 * cross product. The rotation is decomposed as Rz * Ry * Rx and applied with ordinary
 * rotate operations, so the history stays replayable.
 */
export function placeOn(m: Model, a: Pick<Anchor, 'origin' | 'normal' | 'tangent'>): void {
  const y = unit3(a.normal);
  const x = unit3(sub3(a.tangent, scale3(y, dot3(a.tangent, y))));
  const z = cross3(x, y);
  // Columns of R are the images of the local axes.
  const r20 = x[2];
  const r21 = y[2];
  const r22 = z[2];
  const r10 = x[1];
  const r00 = x[0];
  const ry = Math.asin(Math.max(-1, Math.min(1, -r20)));
  let rx: number;
  let rz: number;
  if (Math.abs(Math.cos(ry)) > 1e-9) {
    rx = Math.atan2(r21, r22);
    rz = Math.atan2(r10, r00);
  } else {
    rx = Math.atan2(-z[1], y[1]);
    rz = 0;
  }
  const deg = 180 / Math.PI;
  for (const [axis, angle] of [['x', rx], ['y', ry], ['z', rz]] as const) {
    if (Math.abs(angle) > 1e-12) m.rotate(sel.all(), axis, angle * deg);
  }
  m.translate(sel.all(), a.origin);
}

/** Place a finished detail on its anchor and tag it with the host part. */
export function mount(target: Model, part: DetailPart, a: Pick<Anchor, 'origin' | 'normal' | 'tangent' | 'part'>): void {
  const copy = model();
  copy.append(part.model.snapshot());
  placeOn(copy, a);
  if (a.part !== '') copy.tag(sel.all(), `part:${a.part}`);
  if (copy.poisoned !== undefined) throw copy.poisoned;
  target.append(copy);
}

// ---- 2D outlines ---------------------------------------------------------------------

/** A rounded rectangle centered on `c`, counter-clockwise, `n` points per corner. */
export function roundedRect(w: number, h: number, r: number, n = 4, c: Point2 = [0, 0]): Point2[] {
  const rr = Math.min(r, w / 2 - 1e-6, h / 2 - 1e-6);
  const out: Point2[] = [];
  const corners: [number, number, number][] = [[w / 2 - rr, h / 2 - rr, 0], [-w / 2 + rr, h / 2 - rr, 90], [-w / 2 + rr, -h / 2 + rr, 180], [w / 2 - rr, -h / 2 + rr, 270]];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = ((start + (90 * i) / n) * Math.PI) / 180;
      out.push([c[0] + cx + rr * Math.cos(a), c[1] + cy + rr * Math.sin(a)]);
    }
  }
  return out;
}

/** `n` points of a circle (counter-clockwise). */
export function ring(r: number, n: number, c: Point2 = [0, 0], phase = 0): Point2[] {
  return Array.from({ length: n }, (_, i): Point2 => [c[0] + r * Math.cos(phase + (2 * Math.PI * i) / n), c[1] + r * Math.sin(phase + (2 * Math.PI * i) / n)]);
}

/** An ellipse (counter-clockwise). */
export function ellipse(a: number, b: number, n: number, c: Point2 = [0, 0]): Point2[] {
  return Array.from({ length: n }, (_, i): Point2 => [c[0] + a * Math.cos((2 * Math.PI * i) / n), c[1] + b * Math.sin((2 * Math.PI * i) / n)]);
}

/** Symmetric airfoil section along +X (chord), thickness ratio `t`, closed and counter-clockwise. */
export function airfoil(chord: number, t: number, n = 10): Point2[] {
  const half = (x: number) => 5 * t * chord * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const xs = Array.from({ length: n + 1 }, (_, i) => (1 - Math.cos((Math.PI * i) / n)) / 2);
  const upper = xs.map((x): Point2 => [x * chord - chord / 2, half(x)]);
  const lower = xs.slice(1, -1).reverse().map((x): Point2 => [x * chord - chord / 2, -half(x)]);
  return [...upper.reverse(), ...lower.reverse()].reverse();
}

/** Chaikin corner cutting of a closed outline, `n` rounds: a smooth outline through the control polygon. */
export function chaikin(points: readonly Point2[], n = 2): Point2[] {
  let p = [...points];
  for (let k = 0; k < n; k++) {
    const next: Point2[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i] as Point2;
      const b = p[(i + 1) % p.length] as Point2;
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    p = next;
  }
  return p;
}

/** Where the line `coord = value` crosses a closed outline: the [low, high] span along the other coordinate (empty: [Infinity, -Infinity]). */
export function spanAt(poly: readonly Point2[], coord: 0 | 1, value: number): [number, number] {
  const other = coord === 0 ? 1 : 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Point2;
    const b = poly[(i + 1) % poly.length] as Point2;
    if ((a[coord] - value) * (b[coord] - value) > 0 || a[coord] === b[coord]) continue;
    const t = (value - a[coord]) / (b[coord] - a[coord]);
    const x = a[other] + t * (b[other] - a[other]);
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return [lo, hi];
}

/** Convex hull (counter-clockwise, monotone chain); lamp and intake openings are convex. */
export function hull2(points: readonly Point2[]): Point2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: Point2, a: Point2, b: Point2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && turn(lower[lower.length - 2] as Point2, lower[lower.length - 1] as Point2, q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  const upper: Point2[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && turn(upper[upper.length - 2] as Point2, upper[upper.length - 1] as Point2, q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Chaikin corner cutting of an open chain that keeps both end points. */
export function chaikinOpen(points: readonly Point2[], n = 2): Point2[] {
  let p = [...points];
  for (let k = 0; k < n; k++) {
    const next: Point2[] = [p[0] as Point2];
    for (let i = 0; i + 1 < p.length; i++) {
      const a = p[i] as Point2;
      const b = p[i + 1] as Point2;
      if (i > 0) next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      if (i + 2 < p.length) next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    next.push(p[p.length - 1] as Point2);
    p = next;
  }
  return p;
}

/**
 * A curved display in its bezel, the face toward -Z and concave toward the viewer
 * (curvature `radius` about Y), centered on the origin: a bezel body swept along the arc
 * and the glass face 1 mm proud of it.
 */
export function curvedScreen(m: Model, label: (feature: string) => string, o: { readonly width: number; readonly height: number; readonly radius: number; readonly material: string }): void {
  const span = (o.width / o.radius) * (180 / Math.PI);
  const arc = (r: number, w: number) => ({ kind: 'arc' as const, radius: r, angle: (w / r) * (180 / Math.PI), segments: Math.max(6, Math.ceil(span / 3)), axis: 'y' as const, center: [0, 0, -o.radius] as Tuple3, startAngle: -((w / r) * (180 / Math.PI)) / 2 });
  m.sweep({ profile: roundedRect(0.012, o.height, 0.004, 2), path: arc(o.radius, o.width), up: [0, 1, 0], frame: 'up', label: label('bezel'), material: 'trim' });
  m.sweep({ profile: roundedRect(0.002, o.height - 0.014, 0.0008, 1), path: arc(o.radius - 0.0076, o.width - 0.016), up: [0, 1, 0], frame: 'up', label: label('screen'), material: o.material });
}

/** Signed area (positive counter-clockwise). */
export function area2(p: readonly Point2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as Point2;
    const b = p[(i + 1) % p.length] as Point2;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Point in polygon (even-odd). */
export function inside2(p: Point2, poly: readonly Point2[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Point2;
    const b = poly[j] as Point2;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** Distance from a point to a closed polygon's boundary. */
export function edgeDistance2(p: Point2, poly: readonly Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Point2;
    const b = poly[(i + 1) % poly.length] as Point2;
    const d: Point2 = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1])));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]));
  }
  return best;
}

/**
 * Inward offset of a convex closed outline by `d`: its convex hull clipped by every edge
 * line moved inward (half-plane intersection), so short edges vanish instead of crossing.
 */
export function inset2(poly: readonly Point2[], d: number): Point2[] {
  const hull = hull2(poly);
  let out: Point2[] = hull;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i] as Point2;
    const b = hull[(i + 1) % hull.length] as Point2;
    const n = norm2([-(b[1] - a[1]), b[0] - a[0]]);
    const keep = (p: Point2) => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] - d;
    const next: Point2[] = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k] as Point2;
      const q = out[(k + 1) % out.length] as Point2;
      const fp = keep(p);
      const fq = keep(q);
      if (fp >= 0) next.push(p);
      if (fp * fq < 0) {
        const t = fp / (fp - fq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    out = next;
  }
  // Drop near-duplicate corners the clipping can leave.
  return out.filter((p, k) => {
    const q = out[(k + 1) % out.length] as Point2;
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-5;
  });
}

function norm2(v: Point2): Point2 {
  const l = Math.hypot(v[0], v[1]);
  return [v[0] / l, v[1] / l];
}

/**
 * Hexagonal cells (flat-top, `pitch` between cell centers, `web` between cells) whose
 * every corner lies at least `margin` inside `outline`: the holes of a hex mesh.
 */
export function hexCells(outline: readonly Point2[], pitch: number, web: number, margin: number): Point2[][] {
  const r = (pitch - web) / Math.sqrt(3);
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const dx = (pitch * Math.sqrt(3)) / 2;
  const cells: Point2[][] = [];
  for (let i = 0, x = x0; x <= x1; i++, x += dx) {
    for (let y = y0 + (i % 2 === 0 ? 0 : pitch / 2); y <= y1; y += pitch) {
      const hex = ring(r, 6, [x, y]);
      if (hex.every((q) => inside2(q, outline) && edgeDistance2(q, outline) >= margin)) cells.push(hex);
    }
  }
  return cells;
}

/**
 * Stencils on S6c details (criterion 12c): plates from the shared mech-gt stencil toolkit
 * (`s6b-paint.ts`) laid on a flat face of a detail, in the detail's own frame. Callers pick a
 * face flat under the whole plate, so the plate keeps its gap at every corner.
 */
export const S6C_STENCILS = {
  number: GT_STENCILS.number,
  noStep: GT_STENCILS.noStep,
  hydraulic: { key: 'hyd-small', size: [0.06, 0.035], background: PRIMER, frame: { inset: 0.002, width: 0.0015 }, lines: [{ text: 'HYD 210 BAR', height: 0.0042, at: [0, 0.006] }, { text: 'GT-07', height: 0.005, at: [0, -0.007], color: ACCENT }] },
} as const satisfies Record<string, StencilSpec>;

/**
 * Lay `spec` on a flat face: origin on the face, `normal` out of it, `across` the plate's
 * width direction. The text reads from the front with its up along normal x across.
 */
export function stencilOn(m: Model, spec: StencilSpec, origin: Tuple3, normal: Tuple3, across: Tuple3, label: string): void {
  const y = unit3(normal);
  const x = unit3(sub3(across, scale3(y, dot3(across, y))));
  stencilPlate(m, spec, { o: origin, x, y, z: cross3(x, y) }, { label });
}

/** The faces a label created, as a selector shorthand. */
export const by = (label: string) => sel.createdBy(label);
