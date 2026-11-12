import { type DesignedContact, type FaceSelector, type JointSpec, type Model, model, nurbs, path, type Point2, sel, type StandardMaterialOptions, type TextureSink, type Tuple3 } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import parts from './parts.json' with { type: 'json' };
import { fenderPatches } from '../body-panels/panels.ts';
import { carFormFrames, rotation, TRANSFORM } from './pose.ts';
import { WHEELS } from './s2-body.ts';
import { bodyPatches, bodyPoint, lifted, mechSegments, segmentSpan, STOWED, T } from './s3-rough.ts';
import { GT_STENCILS, type GtSlot, type StencilSpec, stencilMaterial, stencilPlate, stencilSlot } from './s6b-paint.ts';
import type { RigExtension } from './s4-transform.ts';
import type { MechSource } from './s7-assembly.ts';

/**
 * Case C-100 stage S6b (code name mech-gt): the robot form at final fidelity. It replaces
 * the S3 octagonal blocks (`buildS3Mech`) with built members on the same rig: every limb is
 * a hollow tapered frame with end flanges and stiffening ribs, wrapped in layered armor
 * plates on standoffs, with hydraulic lines and a wiring harness clipped along it; the
 * telescoped thigh and shin carry an inner sleeve that slides out with the knee and ankle.
 * The hands have a palm, a back plate and four three-segment fingers plus a thumb on their
 * own revolute joints; the head has a helmet, faceplate, visor, eyes, ear modules and
 * antennas; the feet have a frame, a treaded sole and toe caps (the heel is the motion line's diffuser plate).
 *
 * Every member is built in a local frame (y along the bone from the proximal end, z toward
 * the front, x = y × z), placed on the S3 segment span of the shut skeleton in the mech
 * frame and folded to its joint's car-form frame, exactly like the S3 blocks. Main members
 * keep their `parts.json` ids (`part:<id>`); sub-parts are `s6b:<id>`, bound through
 * `s6bExtension` to the rig joint of their member (finger segments to their own joints).
 */

type V = Tuple3;
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V): V => mul(a, 1 / Math.hypot(...a));
const DEG = 180 / Math.PI;

/** The robot form paints with the shared mech-gt scheme (`s6b-paint.ts`). */
type Slot = GtSlot;

/** A local frame of a member in the mech frame: origin and orthonormal axes. */
export interface Local {
  readonly o: V;
  readonly x: V;
  readonly y: V;
  readonly z: V;
}

/** Local point -> mech frame. */
export const toMechFrame = (f: Local, p: V): V => add(f.o, add(add(mul(f.x, p[0]), mul(f.y, p[1])), mul(f.z, p[2])));

/** Euler angles (`Rz * Ry * Rx`, degrees) of the rotation whose columns are the local axes. */
function eulerOfAxes(f: Local): { x: number; y: number; z: number } {
  const ry = Math.asin(Math.max(-1, Math.min(1, -f.x[2])));
  // Gimbal lock (x axis vertical): R = Rz Ry with no x turn; the y axis gives the z turn.
  if (Math.abs(f.x[2]) > 1 - 1e-9) return { x: 0, y: ry * DEG, z: Math.atan2(-f.y[0], f.y[1]) * DEG };
  return { x: Math.atan2(f.y[2], f.z[2]) * DEG, y: ry * DEG, z: Math.atan2(f.x[1], f.x[0]) * DEG };
}

/** Move the faces of a session built in local coordinates onto the local frame. */
function placeLocal(m: Model, faces: FaceSelector, f: Local): void {
  const e = eulerOfAxes(f);
  m.rotate(faces, 'x', e.x);
  m.rotate(faces, 'y', e.y);
  m.rotate(faces, 'z', e.z);
  m.translate(faces, [...f.o]);
}

/** The car-form fold of a joint: mech-frame point -> car-form model space (the S3 block placement). */
function carFold(joint: string): (p: V) => V {
  const frame = carFormFrames().get(joint);
  const j = STOWED.joints.find((x) => x.name === joint);
  if (frame === undefined || j === undefined) throw new Error(joint);
  const r = rotation(frame.rotation);
  const pm = j.position as V;
  return (p) => {
    const d = sub(p, pm);
    return add([...frame.position] as V, [0, 1, 2].map((i) => dot(r[i] as unknown as V, d)) as unknown as V);
  };
}

/** The same fold applied to a session: undo the mech position, turn, place. */
function foldSession(m: Model, joint: string): void {
  const frame = carFormFrames().get(joint);
  const j = STOWED.joints.find((x) => x.name === joint);
  if (frame === undefined || j === undefined) throw new Error(joint);
  const pm = j.position;
  m.translate(sel.all(), [-(pm[0] as number), -(pm[1] as number), -(pm[2] as number)]);
  m.rotate(sel.all(), 'x', frame.rotation.x ?? 0);
  m.rotate(sel.all(), 'y', frame.rotation.y ?? 0);
  m.rotate(sel.all(), 'z', frame.rotation.z ?? 0);
  m.translate(sel.all(), [...frame.position]);
}

/** Member frame of an S3 segment: y along its span, z toward `front` (made perpendicular). */
export function memberFrame(part: string, front: V): { readonly frame: Local; readonly length: number; readonly size: readonly [number, number, number, number]; readonly joint: string } {
  const s = mechSegments().find((x) => x.part === part);
  if (s === undefined) throw new Error(part);
  const { start, end } = segmentSpan(s);
  const y = unit(sub(end, start));
  const z = unit(sub(front, mul(y, dot(front, y))));
  return { frame: { o: start, x: cross(y, z), y, z }, length: Math.hypot(...sub(end, start)), size: s.size, joint: s.joint };
}

// ---------------------------------------------------------------- section profiles

/** Rounded rectangle centred on the origin (x half `w/2`, y half `d/2`), counter-clockwise. */
export function roundedRect(w: number, d: number, r: number, n = 3): Point2[] {
  const rr = Math.min(r, w / 2 - 1e-4, d / 2 - 1e-4);
  const out: Point2[] = [];
  const corners: [number, number, number][] = [
    [w / 2 - rr, d / 2 - rr, 0],
    [-w / 2 + rr, d / 2 - rr, 90],
    [-w / 2 + rr, -d / 2 + rr, 180],
    [w / 2 - rr, -d / 2 + rr, 270],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= n; k++) {
      const a = ((a0 + (90 * k) / n) * Math.PI) / 180;
      out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
  }
  return out;
}

/** A profile in the local xz plane at height y (points [x, z] -> [x, y, z]). */
const at = (profile: readonly Point2[], y: number, dx = 0, dz = 0): V[] => profile.map(([x, z]) => [x + dx, y, z + dz]);

/** A closed circle of radius r in 2D. */
const circle = (r: number, n = 12): Point2[] => Array.from({ length: n }, (_, k) => [r * Math.cos((2 * Math.PI * k) / n), r * Math.sin((2 * Math.PI * k) / n)] as Point2);

/**
 * A member section: width (local x), depth (local z) and corner radius of a rounded
 * rectangle, or a convex outline `poly` (counter-clockwise, unit box [-0.5, 0.5]^2 scaled by
 * w and d) for faceted members.
 */
export interface Sec {
  readonly w: number;
  readonly d: number;
  readonly r: number;
  readonly poly?: readonly Point2[];
}

/** The closed outline of a section (a rounded rectangle, or its polygon scaled). */
export function outline(sec: Sec): Point2[] {
  if (sec.poly === undefined) return roundedRect(sec.w, sec.d, sec.r);
  return sec.poly.map(([x, z]) => [x * sec.w, z * sec.d] as Point2);
}

/**
 * The point at angle `a` (degrees, 0 = +x, 90 = +z) on the rounded rectangle `sec` grown
 * by `grow` on every side, found along the ray from the centre.
 */
export function rimPoint(sec: Sec, grow: number, a: number): Point2 {
  if (sec.poly !== undefined) {
    // Ray from the centre to the polygon edge it crosses, then `grow` further along the ray.
    const c = Math.cos((a * Math.PI) / 180);
    const s = Math.sin((a * Math.PI) / 180);
    const pts = outline(sec);
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x0, z0] = pts[i] as Point2;
      const [x1, z1] = pts[(i + 1) % pts.length] as Point2;
      const ex = x1 - x0;
      const ez = z1 - z0;
      const den = c * ez - s * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (x0 * ez - z0 * ex) / den;
      const u = (x0 * s - z0 * c) / den;
      if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, t);
    }
    return [(best + grow) * c, (best + grow) * s];
  }
  const hw = sec.w / 2 + grow;
  const hd = sec.d / 2 + grow;
  const r = Math.min(sec.r + grow, hw, hd);
  const c = Math.cos((a * Math.PI) / 180);
  const s = Math.sin((a * Math.PI) / 180);
  let t = Math.min(Math.abs(c) > 1e-12 ? hw / Math.abs(c) : Infinity, Math.abs(s) > 1e-12 ? hd / Math.abs(s) : Infinity);
  const x = t * c;
  const z = t * s;
  if (Math.abs(x) > hw - r && Math.abs(z) > hd - r) {
    // Corner: the ray meets the corner circle around (cx, cz).
    const cx = Math.sign(c) * (hw - r);
    const cz = Math.sign(s) * (hd - r);
    const b = c * cx + s * cz;
    t = b + Math.sqrt(Math.max(0, b * b - (cx * cx + cz * cz - r * r)));
  }
  return [t * c, t * s];
}

/** Outward unit normal (x, z) of the grown rim at angle `a`. */
export function rimNormal(sec: Sec, grow: number, a: number): Point2 {
  const p = rimPoint(sec, grow, a - 0.5);
  const q = rimPoint(sec, grow, a + 0.5);
  const tx = q[0] - p[0];
  const tz = q[1] - p[1];
  const n = Math.hypot(tx, tz);
  return [tz / n, -tx / n];
}

/**
 * An armor plate section over the section rim grown by `gap`: a band of thickness `t`
 * from angle `a0` to `a1`, its long edges chamfered (the outer face is narrower).
 */
function plateSection(sec: Sec, gap: number, t: number, a0: number, a1: number, n = 12): Point2[] {
  const c = Math.min(5, (a1 - a0) / 8);
  const outer: Point2[] = [];
  for (let k = 0; k <= n; k++) outer.push(rimPoint(sec, gap + t, a0 + c + ((a1 - a0 - 2 * c) * k) / n));
  const inner: Point2[] = [];
  for (let k = n; k >= 0; k--) inner.push(rimPoint(sec, gap, a0 + ((a1 - a0) * k) / n));
  return [rimPoint(sec, gap + t * 0.5, a0), ...outer, rimPoint(sec, gap + t * 0.5, a1), ...inner];
}

// ---------------------------------------------------------------- parts

/** Build layers, one checkpoint each: load-bearing structure, armor, then hoses and cables. */
export const LAYERS = ['structure', 'armor', 'lines'] as const;
export type Layer = (typeof LAYERS)[number];

interface Ctx {
  readonly m: Model;
  /** Only parts of this layer are built (all when absent). */
  readonly layer?: Layer;
}
/** Tag of a sub-part. */
const sub6 = (id: string) => `s6b:${id}`;

/**
 * One part in its own session, tagged as a whole. Its pieces never touch each other or other
 * parts (every attachment keeps a sub-millimetre clearance), so no boolean is needed: the
 * TS union leaves seam slivers that collapse on f32 export.
 */
function part(c: Ctx, tag: string, build: (p: Model) => void, layer: Layer = 'structure'): void {
  if (c.layer !== undefined && c.layer !== layer) return;
  const p = model();
  build(p);
  if (p.poisoned !== undefined) throw new Error(`${tag}: ${p.poisoned.message}`, { cause: p.poisoned });
  p.tag(sel.all(), tag);
  c.m.append(p.snapshot());
}

/** Section of a member at k in [0, 1] along it. */
type SecAt = (k: number) => Sec;

/** Frame bulge along a member: 8 % at mid-span. */
const bulge = (k: number) => 1 + 0.08 * Math.sin(Math.PI * k);
/** Tapered member section from the S3 block size (shrunk by `inset` per side), bulged mid-span. */
export function taper(size: readonly [number, number, number, number], inset: number): SecAt {
  return (k) => {
    const b = bulge(k);
    const w = (size[0] - 2 * inset + (size[2] - size[0]) * k) * b;
    const d = (size[1] - 2 * inset + (size[3] - size[1]) * k) * b;
    return { w, d, r: Math.min(w, d) * 0.28 };
  };
}

/**
 * Radial layers outside a member frame (meters from its surface): the rib, hose centres
 * (hoses 5 mm, fittings and clips under 8.5 mm), the inner armor layer and its thickness,
 * the outer layer above it. Hoses and armor never share an angle.
 */
const LAYER = { rib: 0.006, hose: 0.0095, plate: 0.009, t: 0.007, outer: 0.019, t2: 0.0056 } as const;
const WALL = 0.007;
const FLANGE = { lip: 0.012, depth: 0.014, bolt: 0.004 } as const;

/**
 * A hollow tapered member frame: lofted sections shelled open at both ends. Bolted end
 * collars clamp it 1 mm clear of its wall, and a stiffening rib stands 0.5 mm off its
 * lateral face; both are separate parts, so no boolean touches the hollow frame.
 */
function frame(c: Ctx, id: string, tag: string, l: number, sec: SecAt, lateral: number): void {
  part(c, tag, (p) => {
    const label = `${id}-frame`;
    p.loft({ profiles: [0, 0.18, 0.5, 0.82, 1].map((k) => at(outline(sec(k)), l * k)), match: 'index', segments: 3, label, material: 'gt-frame' });
    p.shell(sel.createdBy(label), { thickness: WALL, open: sel.createdBy(label, 'start').or(sel.createdBy(label, 'end')), label: `${label}-wall` });
  });
  for (const k of [0, 1] as const) {
    const collar = `${id}-collar-${k}`;
    // The collar's own section: the frame where it sits (its far edge), grown 1 mm.
    const y = k === 0 ? 0.003 : l - FLANGE.depth - 0.003;
    const s = sec(k === 0 ? (y + FLANGE.depth) / l : y / l);
    part(c, sub6(collar), (p) => {
      p.extrudePolygon({ points: roundedRect(s.w + 2 * FLANGE.lip, s.d + 2 * FLANGE.lip, s.r + FLANGE.lip), holes: [roundedRect(s.w + 0.002, s.d + 0.002, s.r + 0.001)], depth: FLANGE.depth, label: collar, material: 'gt-metal-steel' });
      p.rotate(sel.createdBy(collar), 'x', -90);
      p.translate(sel.createdBy(collar), [0, y, 0]);
        for (const a of [45, 135, 225, 315]) {
        const [bx, bz] = rimPoint(s, 0.0065, a);
        const bolt = `${collar}-bolt-${a}`;
        // Hex heads seated 0.3 mm off the collar face toward the member.
        const by = k === 0 ? y + FLANGE.depth + 0.0025 + 0.0003 : y - 0.0025 - 0.0003;
        p.cylinder({ radiusTop: FLANGE.bolt, radiusBottom: FLANGE.bolt, height: 0.005, radialSegments: 6, center: [bx, by, bz], label: bolt, material: 'gt-metal-steel' });
      }
    });
  }
  const rib = `${id}-rib`;
  part(c, sub6(rib), (p) => {
    // On the frame's own stations, 1 mm off its face.
    const k0 = (0.003 + FLANGE.depth + 0.004) / l;
    const pts: V[] = [k0, 0.18, 0.5, 0.82, 1 - k0].map((k) => {
      const [x, z] = rimPoint(sec(k), 0.0035 + 0.001, lateral);
      return [x, l * k, z];
    });
    const n = rimPoint({ w: 1, d: 1, r: 0 }, 0, lateral);
    p.sweep({ profile: [[-0.0035, -0.007], [0.0035, -0.007], [0.0035, 0.007], [-0.0035, 0.007]], path: path.catmullRom(pts, 8), frame: 'up', up: [-n[1], 0, n[0]], label: rib, material: 'gt-frame' });
  });
}

/** Armor plate over [y0, y1] of a member, grown `gap` off its section, angular span [a0, a1]; optional bolt heads on it. */
function plate(c: Ctx, id: string, y0: number, y1: number, sec: SecAt, l: number, gap: number, t: number, a0: number, a1: number, material: Slot = 'gt-paint', bolts: { readonly ys: readonly number[]; readonly as: readonly number[] } | undefined = undefined): void {
  part(c, sub6(id), (p) => {
    // Dense stations, so the plate follows its member between the member's own stations.
    const stations = [0, 0.06, ...Array.from({ length: 9 }, (_, i) => 0.06 + (0.88 * (i + 1)) / 10), 0.94, 1];
    const profiles = stations.map((k) => {
      const y = y0 + (y1 - y0) * k;
      const end = k === 0 || k === 1;
      // The plate ends taper: thinner and drawn in, a chamfered edge.
      return at(plateSection(sec(y / l), gap, end ? t * 0.35 : t, a0 + (end ? 2 : 0), a1 - (end ? 2 : 0)), y);
    });
    p.loft({ profiles, match: 'index', sharpAngle: 35, label: id, material });
    for (const y of bolts?.ys ?? []) {
      for (const a of bolts?.as ?? []) {
        // Seated 0.5 mm off the outer face along its normal (the sagitta under a head is under 0.3 mm): no boolean needed.
        const ss = sec(y / l);
        const [nx, nz] = rimNormal(ss, gap + t, a);
        const [x0, z0] = rimPoint(ss, gap + t, a);
        const label = `${id}-bolt-${Math.round(y * 1000)}-${a}`;
        p.cylinder({ radiusTop: 0.0055, radiusBottom: 0.0055, height: 0.005, radialSegments: 6, label, material: 'gt-metal-steel' });
        p.rotate(sel.createdBy(label), 'z', -90);
        p.rotate(sel.createdBy(label), 'y', -Math.atan2(nz, nx) * DEG);
        p.translate(sel.createdBy(label), [x0 + nx * 0.003, y, z0 + nz * 0.003]);
      }
    }
  }, 'armor');
}

/** Turn the faces' +Y (about the origin) onto the direction d. */
function pointY(m: Model, faces: FaceSelector, d: V): void {
  m.rotate(faces, 'x', Math.atan2(Math.hypot(d[0], d[2]), d[1]) * DEG);
  m.rotate(faces, 'y', Math.atan2(d[0], d[2]) * DEG);
}

/**
 * A hose or cable: a circle swept along a smooth path, with bored end fittings over its ends
 * and ring clips around it, each 0.2 mm or more clear of it (no boolean).
 */
function hose(c: Ctx, id: string, pts: readonly V[], r: number, material: Slot, fittings: boolean, clips: readonly number[] = []): void {
  part(c, sub6(id), (p) => {
    // Straight leads at fitted ends (20 mm, at most a third of the end span), so the hose runs straight through its fittings.
    const lead = (a: V, b: V): V => add(a, mul(unit(sub(b, a)), Math.min(0.02, Math.hypot(...sub(b, a)) / 3)));
    const run = fittings ? [pts[0] as V, lead(pts[0] as V, pts[1] as V), ...pts.slice(1, -1), lead(pts.at(-1) as V, pts.at(-2) as V), pts.at(-1) as V] : pts;
    p.sweep({ profile: circle(r, 10), path: path.catmullRom(run, 6), label: id, material });
    if (fittings) {
      // Bore 0.4 mm over the hose (12 sides keep their flats clear of its 10 corners), closed 0.5 mm past its end.
      const bore = r + 0.0004;
      for (const [a, b, end] of [[pts[0], pts[1], 'a'], [pts.at(-1), pts.at(-2), 'b']] as const) {
        const label = `${id}-fit-${end}`;
        p.revolve({ points: [[0, -0.0035], [r * 1.65, -0.0035], [r * 1.65, 0.006], [r * 1.45, 0.008], [r * 1.45, 0.016], [bore, 0.016], [bore, -0.0005], [0, -0.0005]], segments: 12, label, material: 'gt-metal-steel' });
        pointY(p, sel.createdBy(label), unit(sub(b as V, a as V)));
        p.translate(sel.createdBy(label), a as V);
      }
    }
    for (const k of clips) {
      const i = Math.min(pts.length - 2, Math.floor(k * (pts.length - 1)));
      const p0 = pts[i] as V;
      const p1 = pts[i + 1] as V;
      const q = add(p0, mul(sub(p1, p0), k * (pts.length - 1) - i));
      const label = `${id}-clip-${Math.round(k * 100)}`;
      p.torus({ radius: r + 0.0024, tube: 0.0016, radialSegments: 6, tubularSegments: 16, label, material: 'gt-metal-steel' });
      p.rotate(sel.createdBy(label), 'x', 90);
      pointY(p, sel.createdBy(label), unit(sub(p1, p0)));
      p.translate(sel.createdBy(label), q);
    }
  }, 'lines');
}

/** A run of hoses side by side over a member at angles `as`, centred `grow` off its section. */
function run(c: Ctx, id: string, sec: SecAt, l: number, grow: number, as: readonly number[], r: number, material: Slot, ks: readonly number[], fit: (n: number) => boolean, clips: (n: number) => readonly number[]): void {
  as.forEach((a, n) => {
    const pts = ks.map((k): V => {
      const [x, z] = rimPoint(sec(k), grow, a);
      return [x, l * k, z];
    });
    hose(c, `${id}-${n + 1}`, pts, r, material, fit(n), clips(n));
  });
}

// ---------------------------------------------------------------- members

/** Mech-frame direction of the robot's front and of a side's medial direction. */
const FRONT: V = [0, 0, 1];
const medialOf = (side: 'l' | 'r'): V => [side === 'l' ? -1 : 1, 0, 0];

/** The local angle (degrees, 0 = +x, 90 = +z) of a mech-frame direction in a member frame. */
function angleOf(f: Local, d: V): number {
  return ((Math.atan2(dot(d, f.z), dot(d, f.x)) * DEG) % 360 + 360) % 360;
}

/**
 * A limb: hollow frame with a lateral rib, an inner armor layer (front, lateral, back), an
 * outer front layer on bolts (and a lateral one where the stow leaves room), three hydraulic
 * lines along the medial face and a three-core harness between them and the back plate.
 */
/**
 * Deployable armor shells (F1 criterion 12a): a shell rides two telescopic posts along its
 * normal. In the car form it lies `stow` off the frame with the posts nested (tube on the
 * inner plate, sleeve inside it, rod on the shell); in the `armor` phase the sleeve and the
 * shell each slide `travel` out, so the limb section grows by twice their sum.
 */
export const DEPLOY = { stow: 0.04, t: 0.007, travel: 0.0175, tube: [0.006, 0.0075], sleeve: [0.0042, 0.0055], rod: 0.0037, seat: 0.0008, clear: 0.0005 } as const;

/** A shell of a limb: where it sits (centre angle), its angular span and its span along the member (shares). */
export interface Shell {
  readonly name: string;
  readonly at: 'front' | 'back';
  readonly span: number;
  readonly y: readonly [number, number];
  /** Turn of the centre toward the lateral side (degrees). */
  readonly toward?: number;
}
export const SHELLS: Readonly<Record<'core-upper-arm' | 'core-forearm' | 'core-thigh' | 'core-shin', readonly Shell[]>> = {
  // The elbow cylinders run down the upper arm's front: its shell sits at the back.
  'core-upper-arm': [{ name: 'back', at: 'back', span: 32, y: [0.14, 0.86] }],
  'core-forearm': [{ name: 'front', at: 'front', span: 34, y: [0.12, 0.88] }, { name: 'back', at: 'back', span: 30, y: [0.16, 0.84] }],
  // The leg-split rail runs along the thigh's lower front: only the upper front deploys there.
  'core-thigh': [
    { name: 'front', at: 'front', span: 36, y: [0.12, 0.35] },
    { name: 'back', at: 'back', span: 30, y: [0.16, 0.84] },
  ],
  // The rear subframe beam passes the shin's inboard back edge as the legs swing: its back shell leans lateral.
  'core-shin': [{ name: 'front', at: 'front', span: 36, y: [0.1, 0.9] }, { name: 'back', at: 'back', span: 17, y: [0.16, 0.84], toward: 12 }],
};

/** Geometry facts of a shell in its member frame: centre angle, deploy axis, post bases (local points). */
export interface ShellGeometry {
  readonly angle: number;
  readonly axis: V;
  readonly posts: readonly V[];
}

export function shellGeometry(f: Local, side: 'l' | 'r', l: number, sec: SecAt, shell: Shell): ShellGeometry {
  const front = angleOf(f, FRONT);
  const base = shell.at === 'front' ? front : (front + 180) % 360;
  const lat = (angleOf(f, medialOf(side)) + 180) % 360;
  const toLat = ((lat - base + 540) % 360) - 180 > 0 ? 1 : -1;
  const angle = (base + toLat * (shell.toward ?? 0) + 360) % 360;
  const mid = (shell.y[0] + shell.y[1]) / 2;
  const [nx, nz] = rimNormal(sec(mid), DEPLOY.stow, angle);
  const posts = [0.22, 0.78].map((s): V => {
    const k = shell.y[0] + (shell.y[1] - shell.y[0]) * s;
    const [x, z] = rimPoint(sec(k), LAYER.plate + LAYER.t, angle);
    return [x + nx * DEPLOY.seat, l * k, z + nz * DEPLOY.seat];
  });
  return { angle, axis: [nx, 0, nz], posts };
}

/** The shell, its two post sleeves and the post tubes (mount) on the inner plate. */
function shells(c: Ctx, f: Local, id: string, side: 'l' | 'r', l: number, sec: SecAt, list: readonly Shell[]): void {
  for (const shell of list) {
    const g = shellGeometry(f, side, l, sec, shell);
    const name = `${id}-shell-${shell.name}`;
    // Nested stowed: tube, sleeve and rod span the gap from the inner plate to the shell.
    const height = DEPLOY.stow - LAYER.plate - LAYER.t - DEPLOY.seat - DEPLOY.clear;
    const post = (p: Model, label: string, base: V, profile: Point2[]) => {
      p.revolve({ points: profile, segments: 16, label, material: 'gt-metal-steel' });
      pointY(p, sel.createdBy(label), g.axis);
      p.translate(sel.createdBy(label), base);
    };
    part(c, sub6(`${name}-mount`), (p) => {
      g.posts.forEach((b, i) => post(p, `${name}-tube-${i + 1}`, b, [[DEPLOY.tube[0], 0], [DEPLOY.tube[1], 0], [DEPLOY.tube[1], height], [DEPLOY.tube[0], height]]));
    });
    part(c, sub6(`${name}-sleeve`), (p) => {
      g.posts.forEach((b, i) => post(p, `${name}-sleeve-${i + 1}`, add(b, mul(g.axis, DEPLOY.clear)), [[DEPLOY.sleeve[0], 0], [DEPLOY.sleeve[1], 0], [DEPLOY.sleeve[1], height - DEPLOY.clear], [DEPLOY.sleeve[0], height - DEPLOY.clear]]));
    });
    part(c, sub6(name), (p) => {
      const span = shell.span;
      const stations = [0, 0.06, ...Array.from({ length: 9 }, (_, i) => 0.06 + (0.88 * (i + 1)) / 10), 0.94, 1];
      p.loft({
        profiles: stations.map((k) => {
          const y = l * (shell.y[0] + (shell.y[1] - shell.y[0]) * k);
          const end = k === 0 || k === 1;
          return at(plateSection(sec(y / l), DEPLOY.stow, end ? DEPLOY.t * 0.4 : DEPLOY.t, g.angle - span + (end ? 2 : 0), g.angle + span - (end ? 2 : 0)), y);
        }),
        match: 'index',
        sharpAngle: 35,
        label: name,
        material: 'gt-paint',
      });
      g.posts.forEach((b, i) => post(p, `${name}-rod-${i + 1}`, add(b, mul(g.axis, 2 * DEPLOY.clear)), [[0, 0], [DEPLOY.rod, 0], [DEPLOY.rod, height - 2 * DEPLOY.clear], [0, height - 2 * DEPLOY.clear]]));
    }, 'armor');
  }
}

interface LimbArmor {
  /** An outer lateral layer (the stow leaves no room outboard of the arms or beside the knee telescope cylinder). */
  readonly outerLateral: boolean;
  /** A joint gap [k0, k1] splitting the front plates into two segments (clear of the leg-split rack). */
  readonly frontGap?: readonly [number, number];
}

function limb(c: Ctx, f: Local, id: string, side: 'l' | 'r', l: number, sec: SecAt, armor: LimbArmor, deploy: readonly Shell[]): void {
  const med = angleOf(f, medialOf(side));
  const lat = (med + 180) % 360;
  const front = angleOf(f, FRONT);
  const back = (front + 180) % 360;
  frame(c, id, `part:${id}`, l, sec, lat);
  const gap = armor.frontGap;
  if (gap === undefined) plate(c, `${id}-plate-front`, l * 0.08, l * 0.9, sec, l, LAYER.plate, LAYER.t, front - 40, front + 40);
  else {
    plate(c, `${id}-plate-front`, l * 0.08, l * gap[0], sec, l, LAYER.plate, LAYER.t, front - 40, front + 40);
    plate(c, `${id}-plate-front-lower`, l * gap[1], l * 0.9, sec, l, LAYER.plate, LAYER.t, front - 40, front + 40);
  }
  plate(c, `${id}-plate-lateral`, l * 0.05, l * 0.94, sec, l, LAYER.plate, LAYER.t, lat - 38, lat + 38);
  plate(c, `${id}-plate-back`, l * 0.12, l * 0.86, sec, l, LAYER.plate, LAYER.t, back - 34, back + 34, 'gt-metal');
  // A front shell replaces the outer front layer (its posts stand where that layer lies).
  if (!deploy.some((x) => x.at === 'front')) {
    if (gap === undefined) plate(c, `${id}-plate-front-2`, l * 0.3, l * 0.8, sec, l, LAYER.outer, LAYER.t2, front - 24, front + 24, 'gt-paint', { ys: [l * 0.36, l * 0.74], as: [front - 14, front + 14] });
    else {
      plate(c, `${id}-plate-front-2`, l * 0.14, l * (gap[0] - 0.02), sec, l, LAYER.outer, LAYER.t2, front - 24, front + 24, 'gt-paint', { ys: [l * 0.2], as: [front - 14, front + 14] });
      plate(c, `${id}-plate-front-lower-2`, l * (gap[1] + 0.02), l * 0.84, sec, l, LAYER.outer, LAYER.t2, front - 24, front + 24, 'gt-paint', { ys: [l * 0.78], as: [front - 14, front + 14] });
    }
  }
  if (armor.outerLateral) plate(c, `${id}-plate-lateral-2`, l * 0.2, l * 0.74, sec, l, LAYER.outer, LAYER.t2, lat - 26, lat + 26, 'gt-paint', { ys: [l * 0.27, l * 0.67], as: [lat - 15, lat + 15] });
  // Spacing by arc length on the narrowest section: hose fittings (1.6 r) 2 mm apart, the harness beyond them.
  const rr = Math.min(sec(1).w, sec(1).d) / 2 + LAYER.hose;
  const dh = ((2 * 1.6 * 0.005 + 0.002) / rr) * DEG;
  const ks = [0.07, 0.3, 0.6, 0.93];
  run(c, `${id}-hydraulic`, sec, l, LAYER.hose, [med - dh, med, med + dh], 0.005, 'gt-primer', ks, () => true, () => [0.33, 0.66]);
  const toBack = ((back - med + 540) % 360) - 180 > 0 ? 1 : -1;
  // Cores 1.5 mm apart.
  const da = ((2 * 0.003 + 0.0015) / rr) * DEG;
  const h = med + toBack * (dh + ((1.6 * 0.005 + 0.003 + 0.002) / rr) * DEG + da);
  run(c, `${id}-harness`, sec, l, 0.0045, [h - da, h, h + da], 0.003, 'gt-paint-accent', [0.06, 0.15, 0.5, 0.85, 0.94], () => false, () => []);
}

/** The inner sleeve of a telescoped bone, inside the frame's distal end; it slides out with the joint below. */
function sleeve(c: Ctx, id: string, l: number, sec: SecAt, length: number): void {
  const label = `${id}-sleeve`;
  const s = sec(1);
  // 7 mm inside the frame bore; the wear strips, seated 0.3 mm off it, leave 2.7 mm.
  const w = s.w - 2 * WALL - 0.014;
  const d = s.d - 2 * WALL - 0.014;
  part(c, sub6(label), (p) => {
    p.loft({ profiles: [at(roundedRect(w, d, Math.min(w, d) * 0.25), l - length), at(roundedRect(w, d, Math.min(w, d) * 0.25), l - 0.003)], match: 'index', label, material: 'gt-metal-steel' });
    p.shell(sel.createdBy(label), { thickness: 0.005, open: sel.createdBy(label, 'start'), label: `${label}-wall` });
    for (const z of [1, -1] as const) {
      const strip = `${label}-strip-${z > 0 ? 'p' : 'n'}`;
      p.sweep({ profile: [[-0.006, -0.002], [0.006, -0.002], [0.006, 0.002], [-0.006, 0.002]], path: [[0, l - length + 0.02, z * (d / 2 + 0.0023)], [0, l - 0.02, z * (d / 2 + 0.0023)]], frame: 'up', up: [0, 0, 1], label: strip, material: 'gt-metal' });
    }
  });
}

// ---------------------------------------------------------------- hands

/** Finger rows: spread position (share of the palm width from its centre, + toward the front) and length scale. */
const FINGERS = [
  { name: 'f1', x: 0.375, scale: 1 },
  { name: 'f2', x: 0.125, scale: 1.06 },
  { name: 'f3', x: -0.125, scale: 1 },
  { name: 'f4', x: -0.375, scale: 0.84 },
] as const;
/** Phalanx lengths of a unit finger and of the thumb (meters). */
const PHALANX = [0.1, 0.08, 0.065] as const;
// Short enough that the straight stowed thumb clears the stowed rear fender ahead of the hand.
const THUMB = [0.058, 0.048, 0.04] as const;
const KNUCKLE_GAP = 0.0025;
/**
 * Finger curl per joint (degrees toward the palm, relative to the previous segment): stowed
 * in the car form as a fist, relaxed in the robot form (the `armor` phase uncurls them).
 */
export const CURL = { stowed: [90, 70, 40], relaxed: [8, 12, 10], thumbStowed: [0, 0, 0], thumbRelaxed: [-10, 12, 10] } as const;
/** The palm: a base on the wrist and a metacarpal sleeve over it that slides `extend` toward the fingers. */
export const PALM = { base: 0.095, sleeve: 0.1, wall: 0.004, clear: 0.003, extend: 0.08, width: 0.05, depth: 0.75 } as const;

/** One phalanx of a hand: its id, base (local hand coordinates), direction, length and section. */
interface Phalanx {
  readonly id: string;
  readonly base: V;
  readonly dir: V;
  readonly len: number;
  readonly w: number;
  readonly t: number;
  readonly tip: boolean;
  /** Its revolute joint at the knuckle barrel centre: parent joint name and local axis (curling toward the palm). */
  readonly parent: string;
  readonly pivot: V;
  readonly axis: V;
  readonly limits: readonly [number, number];
  /** The `armor`-phase turn from the stowed fist to the relaxed hand (degrees). */
  readonly open: number;
}

export interface HandLayout {
  /** Palm base length, the sleeve's stowed span along y, palm width and thickness. */
  readonly palm: number;
  readonly sleeve: readonly [number, number];
  readonly w: number;
  readonly t: number;
  readonly phalanges: readonly Phalanx[];
}

/**
 * The hand of side `side` in its member frame (y from the wrist toward the fingertips, z the
 * palm normal, x the spread): a palm base on the wrist, a metacarpal sleeve over it carrying
 * four fingers of three phalanges, stowed as a fist, and a thumb from the base's front edge.
 * Deployed (sleeve out, fingers relaxed) the hand is about 0.45 m long.
 */
export function handLayout(side: 'l' | 'r'): HandLayout {
  const m = memberFrame(`hand-${side}`, medialOf(side));
  const w = Math.max(m.size[1], m.size[3]) + PALM.width;
  const t = Math.max(m.size[0], m.size[2]) * PALM.depth;
  const fx = dot(m.frame.x, FRONT) >= 0 ? 1 : -1;
  const fw = (w / 4) * 0.8;
  const ft = fw * 0.92;
  const sleeve: [number, number] = [0.002, 0.002 + PALM.sleeve];
  // Curled 90 degrees, a proximal phalanx lies across the knuckle line: half its thickness clear of the sleeve's end.
  const knuckle = sleeve[1] + ft * 0.55 + KNUCKLE_GAP;
  const out: Phalanx[] = [];
  const id = `hand-${side}`;
  for (const f of FINGERS) {
    // Each pivot (barrel centre) lies past the previous segment's end along that segment; the
    // segment is built back from its pivot along its own (curled) direction.
    let pivot: V = [fx * f.x * w, knuckle, 0];
    let parent = `${id}-metacarpal-joint`;
    let curl = 0;
    let prev: V = [0, 1, 0];
    PHALANX.forEach((len0, i) => {
      const len = len0 * f.scale - KNUCKLE_GAP;
      const pid = `${id}-${f.name}-p${i + 1}`;
      const pt = ft * (1 - 0.08 * i);
      curl += CURL.stowed[i] as number;
      const r = (curl * Math.PI) / 180;
      const dir: V = [0, Math.cos(r), Math.sin(r)];
      if (i > 0) pivot = add(pivot, mul(prev, pt * 0.55 + KNUCKLE_GAP));
      else pivot = add(pivot, [0, pt * 0.3, 0]);
      const base = sub(pivot, mul(dir, pt * 0.3));
      out.push({ id: pid, base, dir, len, w: fw * (1 - 0.08 * i), t: pt, tip: i === 2, parent, pivot, axis: [1, 0, 0], limits: [-100, 20], open: (CURL.relaxed[i] as number) - (CURL.stowed[i] as number) });
      parent = `${pid}-joint`;
      // The segment's end: its body runs to `len` from its base.
      pivot = add(base, mul(dir, len));
      prev = dir;
    });
  }
  // The thumb leaves the palm base's front edge, across toward the palm side.
  const dir0 = unit([fx * 0.3, 0.8, 0.45]);
  const yaw = Math.atan2(dir0[0], dir0[2]);
  const axis: V = [Math.cos(yaw), 0, -Math.sin(yaw)];
  let base: V = [fx * (0.5 * w + 0.014), PALM.base * 0.3, t * 0.5 + 0.008];
  let parent = `wrist-${side}`;
  let curl = 0;
  THUMB.forEach((len0, i) => {
    const len = len0 - KNUCKLE_GAP;
    const pid = `${id}-thumb-p${i + 1}`;
    const pt = ft * 1.08 * (1 - 0.08 * i);
    curl += CURL.thumbStowed[i] as number;
    // Curl turns the thumb about its knuckle axis toward the palm.
    const dir = rotateAbout(dir0, axis, curl);
    out.push({ id: pid, base, dir, len, w: fw * 1.08 * (1 - 0.08 * i), t: pt, tip: i === 2, parent, pivot: add(base, mul(dir, pt * 0.3)), axis, limits: [-60, 60], open: (CURL.thumbRelaxed[i] as number) - (CURL.thumbStowed[i] as number) });
    parent = `${pid}-joint`;
    base = add(base, mul(dir, len + KNUCKLE_GAP));
  });
  return { palm: PALM.base, sleeve, w, t, phalanges: out };
}

/** Rodrigues rotation of v about the unit axis k by `deg` degrees. */
function rotateAbout(v: V, k: V, deg: number): V {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

/**
 * One phalanx along +y from the origin, a clevis: the knuckle barrel on the pivot between two
 * side cheeks, and the lofted body past the barrel, narrow where the cheeks hold it; its back
 * scale and grip pad are separate parts on the body stations. No piece touches another, so
 * no boolean is needed.
 */
function phalanx(c: Ctx, ph: Phalanx): void {
  const { w, t, len } = ph;
  const br = t * 0.3;
  const y0 = 2 * br + 0.0008;
  // Body section along it: inside the cheeks up to `neck`, full past it, the tip rounded off.
  const neck = Math.min(0.35, (t * 1.05 - y0) / (len - y0));
  const sec = (k: number): Sec => {
    const g = k <= neck ? 0.76 : Math.min(1, 0.76 + ((k - neck) / 0.12) * 0.24);
    // A tip rounds off over its last 30 % (an ellipse down to 45 %).
    const tip = k <= 0.7 ? 1 - 0.1 * k : 0.93 * Math.sqrt(1 - ((k - 0.7) / 0.3) ** 2 * 0.77);
    const s = (ph.tip ? tip : 1 - 0.1 * k) * g;
    return { w: w * s, d: t * 0.9 * s, r: Math.min(w, t) * 0.4 * s };
  };
  const yk = (k: number) => y0 + (len - y0) * k;
  const ks = [...new Set([0, neck, Math.min(0.99, neck + 0.06), Math.min(0.995, neck + 0.12), 0.55, 0.7, 0.82, 0.9, 0.96, 1].filter((k) => k >= neck || k === 0))].sort((a, b) => a - b);
  part(c, sub6(ph.id), (p) => {
    const barrel = `${ph.id}-knuckle`;
    p.cylinder({ radiusTop: br, radiusBottom: br, height: w * 0.74, radialSegments: 14, label: barrel, material: 'gt-metal-steel' });
    p.rotate(sel.createdBy(barrel), 'z', 90);
    p.translate(sel.createdBy(barrel), [0, br, 0]);
    for (const sx of [1, -1] as const) {
      const cheek = `${ph.id}-cheek-${sx > 0 ? 'p' : 'n'}`;
      const x0 = sx * (w * 0.385 + 0.0006);
      const x1 = x0 + sx * w * 0.08;
      const yTop = yk(neck) - 0.0006;
      // A side plate around the barrel end, tapering onto the body neck.
      p.loft({ profiles: [x0, x1].map((x) => [[x, 0.0004, -t * 0.32], [x, yTop, -t * 0.26], [x, yTop, t * 0.26], [x, 0.0004, t * 0.32]] as V[]), match: 'index', label: cheek, material: 'gt-metal-steel' });
    }
    p.loft({ profiles: ks.map((k) => at(outline(sec(k)), yk(k))), match: 'index', label: `${ph.id}-body`, material: 'gt-frame' });
  });
  const cover = ks.filter((k) => k >= Math.min(0.99, neck + 0.12) && k <= 0.9);
  if (cover.length < 2) return;
  part(c, sub6(`${ph.id}-scale`), (p) => {
    p.loft({ profiles: cover.map((k) => at(plateSection(sec(k), 0.0012, 0.0035, 205, 335, 8), yk(k))), match: 'index', label: `${ph.id}-scale`, material: 'gt-paint' });
  }, 'armor');
  part(c, sub6(`${ph.id}-pad`), (p) => {
    p.loft({ profiles: cover.map((k) => at(plateSection(sec(k), 0.0012, 0.0025, 38, 142, 8), yk(k))), match: 'index', label: `${ph.id}-pad`, material: 'gt-primer' });
  }, 'armor');
}
/**
 * A hand: the palm base with its wrist cuff on the wrist; the metacarpal sleeve over it
 * (a shelled loft open toward the wrist, its closed end the knuckle face) with the back
 * plate, knuckle guard and tendon lines, sliding out in the `armor` phase; and the
 * phalanges on their knuckle pivots.
 */
function hand(c: Ctx, side: 'l' | 'r'): void {
  const id = `hand-${side}`;
  const { palm: pl, sleeve, w, t, phalanges } = handLayout(side);
  // Base inside the sleeve bore with `clear` all round; the sleeve's outer section.
  const bw = w - 2 * (PALM.wall + PALM.clear);
  const bt = t - 2 * (PALM.wall + PALM.clear);
  part(c, `part:${id}`, (p) => {
    p.loft({ profiles: [0.004, pl * 0.5, pl].map((y) => at(roundedRect(bw, bt, bt * 0.3), y)), match: 'index', label: `${id}-palm`, material: 'gt-frame' });
    const cuff = `${id}-cuff`;
    p.revolve({ points: [[0, -0.018], [0.5, -0.018], [0.53, -0.01], [0.5, -0.001], [0, -0.001]], segments: 24, label: cuff, material: 'gt-metal-steel' });
    p.scale(sel.createdBy(cuff), [w * 0.8, 1, t * 1.06], [0, 0, 0]);
  });
  const msec = (): Sec => ({ w, d: t, r: t * 0.3 });
  part(c, sub6(`${id}-metacarpal`), (p) => {
    const label = `${id}-metacarpal`;
    p.loft({ profiles: [sleeve[0], sleeve[1]].map((y) => at(roundedRect(w, t, t * 0.3), y)), match: 'index', label, material: 'gt-frame' });
    p.shell(sel.createdBy(label), { thickness: PALM.wall, open: sel.createdBy(label, 'start'), label: `${label}-wall` });
  });
  const len = sleeve[1] - sleeve[0];
  plate(c, `${id}-backplate`, sleeve[0] + len * 0.08, sleeve[0] + len * 0.92, msec, 1, 0.003, 0.006, 205, 335);
  plate(c, `${id}-knuckle-guard`, sleeve[0] + len * 0.7, sleeve[1] - 0.002, msec, 1, 0.011, 0.005, 210, 330, 'gt-metal');
  for (const f of FINGERS) {
    const x = (phalanges.find((q) => q.id === `${id}-${f.name}-p1`) as Phalanx).base[0];
    hose(c, `${id}-${f.name}-tendon`, [[x * 0.55, sleeve[0] + len * 0.1, t / 2 + 0.004], [x * 0.85, sleeve[0] + len * 0.55, t / 2 + 0.004], [x, sleeve[0] + len * 0.9, t / 2 + 0.004]], 0.0022, 'gt-primer', false);
  }
  for (const ph of phalanges) {
    const s = model();
    phalanx({ m: s, ...(c.layer === undefined ? {} : { layer: c.layer }) }, ph);
    // A layer without parts of this phalanx leaves the session empty: appending it would be a no-op error.
    if (s.count(sel.all()) === 0) continue;
    pointY(s, sel.all(), ph.dir);
    s.translate(sel.all(), ph.base);
    c.m.append(s.snapshot());
  }
}

// ---------------------------------------------------------------- head

/**
 * V-fin: two blades hinged either side of the forehead centre, in a plane just in front of
 * the helmet. Stowed they point down and out over the face (`stowed`, inside the head's
 * frontal outline while the head rises); in the `armor` phase each turns up about the
 * front-back axis to `angle` above the horizontal. Turning in their own plane, they never
 * reach the helmet.
 */
export const VFIN = { y: 0.73, length: 0.2, root: 0.034, tip: 0.008, t: 0.006, gap: 0.016, hinge: 0.017, boss: 0.012, angle: 55, stowed: -60 } as const;

/** The V-fin hinge of a side in the head's local frame and the blade's stowed direction (+x left). */
export function vfinHinge(l: number, d: number, side: 'l' | 'r'): { readonly at: V; readonly out: number } {
  const sx = side === 'l' ? 1 : -1;
  return { at: [sx * VFIN.hinge, l * VFIN.y, d / 2 + VFIN.gap + VFIN.t / 2], out: sx };
}

function vfin(c: Ctx, l: number, d: number): void {
  for (const side of ['l', 'r'] as const) {
    const { at: h, out } = vfinHinge(l, d, side);
    const id = `head-vfin-${side}`;
    part(c, sub6(id), (p) => {
      // Root boss on the hinge axis (front-back), then the blade swept back-up along x.
      p.cylinder({ radiusTop: VFIN.boss, radiusBottom: VFIN.boss, height: VFIN.t * 1.6, radialSegments: 16, label: `${id}-boss`, material: 'gt-metal' });
      p.rotate(sel.createdBy(`${id}-boss`), 'x', 90);
      p.translate(sel.createdBy(`${id}-boss`), h);
      const ks = [0, 0.35, 0.75, 1];
      p.loft({
        profiles: ks.map((k) => {
          const x = h[0] + out * (VFIN.boss + 0.001 + (VFIN.length - VFIN.boss) * k);
          const hh = VFIN.root + (VFIN.tip - VFIN.root) * k;
          // The blade rises toward its tip: the upper edge sweeps up 30 % of the root height.
          const y0 = h[1] - VFIN.root / 2 + VFIN.root * 0.3 * k;
          const z = h[2];
          const tt = (VFIN.t / 2) * (1 - 0.5 * k);
          return [[x, y0, z - tt], [x, y0 + hh, z - tt * 0.6], [x, y0 + hh, z + tt * 0.6], [x, y0, z + tt]] as V[];
        }),
        match: 'index',
        label: id,
        material: 'gt-metal',
      });
      p.rotate(sel.all(), 'z', out * VFIN.stowed, h);
    }, 'armor');
  }
}

/**
 * Crest (F1 criterion 12b, head height): a swept fin on the crown centre line. Stowed it lies
 * flat across the crown; in the `armor` phase it turns 90 degrees up about its front-back
 * hinge line just above the crown. The chin guard below the faceplate slides `chin` down.
 */
export const CREST = { height: 0.15, base: 0.8, t: 0.008, gap: 0.002, chin: 0.035 } as const;

/** The crest hinge line in the head's local frame: a point on it (the axis runs along z). */
export const crestHinge = (l: number): V => [0, l + CREST.gap + CREST.t / 2, 0];

function crest(c: Ctx, l: number, crown: number): void {
  part(c, sub6('head-crest'), (p) => {
    const h = crestHinge(l);
    // Built standing: a plate in the yz plane over the crown, swept back toward its tip.
    const sections = [0, 0.5, 1].map((k) => {
      const y = h[1] + CREST.height * k;
      const z0 = -crown * 0.45 * CREST.base + crown * 0.2 * k;
      const z1 = crown * 0.45 * CREST.base - crown * 0.35 * k * k;
      const tt = (CREST.t / 2) * (1 - 0.5 * k);
      return [[-tt, y, z0], [-tt * 0.5, y, z1], [tt * 0.5, y, z1], [tt, y, z0]] as V[];
    });
    p.loft({ profiles: sections, match: 'index', label: 'head-crest', material: 'gt-metal' });
    // Stowed: turned down flat across the crown (toward +x).
    p.rotate(sel.all(), 'z', -90, h);
  }, 'armor');
}

/** Faceted helmet outline: a ridge down the front, cheek facets, flat sides, a squared back (unit box). */
const HELMET: readonly Point2[] = [[0.5, 0.1], [0.32, 0.38], [0, 0.5], [-0.32, 0.38], [-0.5, 0.1], [-0.5, -0.24], [-0.34, -0.5], [0.34, -0.5], [0.5, -0.24]];

/** The helmet section along the head (k from the neck up): crown swell, narrow jaw, chamfered top. */
function helmetSection(size: readonly [number, number, number, number]): (k: number) => Sec {
  const w = Math.max(size[0], size[2]) * 0.92;
  const d = Math.max(size[1], size[3]) * 0.95;
  return (k: number): Sec => {
    // A swelling crown, drawn in at the jaw and chamfered over the top (continuous at both breaks).
    const f = k < 0.15 ? 0.84 + 0.16 * (3 - 2 * (k / 0.15)) * (k / 0.15) ** 2 : k > 0.82 ? 1 - 2.2 * (k - 0.82) ** 1.3 : 1;
    const s = (0.95 + 0.05 * Math.sin(Math.PI * k)) * f;
    // The jaw is narrower than the brow: width grows faster than depth over the lower third.
    const jaw = k < 0.35 ? 0.9 + 0.1 * (k / 0.35) : 1;
    return { w: w * s * jaw, d: d * (s * 0.94 + 0.06), r: 0, poly: HELMET };
  };
}

/** Depth of the head's front clearance plane (twice the front reach of brow and helmet over the V-fin band). */
function headDepth(size: readonly [number, number, number, number]): number {
  const hsec = helmetSection(size);
  return Math.max(...[0.62, 0.7, 0.73, 0.8].map((k) => rimPoint(hsec(k), 0.015, 90)[1] * 2));
}

/**
 * The head (local y up from the neck, z front, x left): a faceted helmet with a front ridge
 * and a flat crown with a crest, its neck collar; a V visor over two eye lenses under a
 * brow, a faceplate with vent ribs and a chin guard, cheek guards, ear modules with antenna
 * blades swept back, and the neck cables.
 */
function head(c: Ctx, l: number, size: readonly [number, number, number, number]): void {
  const w = Math.max(size[0], size[2]) * 0.92;
  const d = Math.max(size[1], size[3]) * 0.95;
  const hsec = helmetSection(size);
  // Dense linear stations: the plates over it then keep their gap between stations.
  const ks = [0.04, 0.1, 0.15, 0.22, 0.3, 0.35, 0.42, 0.5, 0.58, 0.66, 0.74, 0.82, 0.88, 0.94, 1];
  part(c, 'part:head-unit', (p) => {
    p.loft({ profiles: ks.map((k) => at(outline(hsec(k)), l * k)), match: 'index', label: 'head-helmet', material: 'gt-paint' });
    // The neck collar ring under the helmet rim, 1 mm below it.
    const neck = 'head-collar';
    p.revolve({ points: [[0, -1], [0.4, -1], [0.46, -0.5], [0.42, 0], [0, 0]], segments: 24, label: neck, material: 'gt-metal-steel' });
    p.scale(sel.createdBy(neck), [w * 0.72, l * 0.055, d * 0.72], [0, 0, 0]);
    p.translate(sel.createdBy(neck), [0, l * 0.04 - 0.001, 0]);
  });
  crest(c, l, hsec(1).d);
  plate(c, 'head-faceplate', l * 0.1, l * 0.44, hsec, l, 0.003, 0.008, 52, 128, 'gt-metal');
  for (const [n, k] of [[1, 0.17], [2, 0.245], [3, 0.32]] as const) plate(c, `head-vent-${n}`, l * k, l * (k + 0.03), hsec, l, 0.0125, 0.004, 64, 116, 'gt-metal-steel');
  plate(c, 'head-chin', l * 0.045, l * 0.095, hsec, l, 0.003, 0.012, 58, 122, 'gt-paint');
  plate(c, 'head-visor', l * 0.5, l * 0.6, hsec, l, 0.0075, 0.004, 28, 152, 'gt-glass');
  plate(c, 'head-brow', l * 0.615, l * 0.7, hsec, l, 0.003, 0.012, 24, 156, 'gt-paint');
  vfin(c, l, headDepth(size));
  for (const [side, a] of [['l', 66], ['r', 114]] as const) {
    plate(c, `head-eye-${side}`, l * 0.525, l * 0.575, hsec, l, 0.0025, 0.0035, a - 17, a + 17, 'gt-glow');
    const cheek = side === 'l' ? 12 : 168;
    plate(c, `head-cheek-${side}`, l * 0.12, l * 0.46, hsec, l, 0.003, 0.009, cheek - 22, cheek + 22);
    const sx = side === 'l' ? 1 : -1;
    const ex = (hsec(0.58).w / 2) * sx;
    // Ear module: a ringed disc on the side with the antenna blade rising beside it.
    part(c, sub6(`head-ear-${side}`), (p) => {
      const ear = `head-ear-${side}`;
      p.revolve({ points: [[0, 0], [0.034, 0], [0.036, 0.006], [0.028, 0.012], [0.03, 0.016], [0.018, 0.022], [0, 0.022]], segments: 24, label: ear, material: 'gt-metal-steel' });
      p.rotate(sel.createdBy(ear), 'z', -90 * sx);
      p.translate(sel.createdBy(ear), [ex + 0.002 * sx, l * 0.58, -d * 0.12]);
      const ant = `head-antenna-${side}`;
      p.loft({
        profiles: [0, 0.5, 1].map((k) => {
          const y = l * (0.6 + 0.4 * k);
          const z = -d * 0.12 - d * 0.36 * k;
          const x = ex + (0.029 - 0.006 * k) * sx;
          const h = 0.032 * (1 - 0.7 * k);
          const tt = 0.004 * (1 - 0.5 * k);
          return [[x - tt, y, z - h / 2], [x + tt, y, z - h / 2], [x + tt * 0.5, y, z + h / 2], [x - tt * 0.5, y, z + h / 2]] as V[];
        }),
        match: 'index',
        label: ant,
        material: 'gt-metal',
      });
    });
  }
  for (const n of [1, 2, 3]) {
    const x = (n - 2) * 0.03;
    hose(c, `head-cable-${n}`, [[x, l * 0.0, -hsec(0.04).d / 2 - 0.016], [x, l * 0.12, -hsec(0.12).d / 2 - 0.013], [x, l * 0.3, -hsec(0.3).d / 2 - 0.011]], 0.005, n === 2 ? 'gt-paint-accent' : 'gt-primer', true);
  }
}

// ---------------------------------------------------------------- feet

/**
 * The ankle-to-toe member (`core-foot`, local y forward along it, z up): a hollow arch frame
 * with flanges, a treaded sole under it and armor over the instep. The toe member (`foot`) is
 * a block with three toe caps and its own treaded sole.
 */
function footMembers(c: Ctx, side: 'l' | 'r', which: 'core-foot' | 'foot', l: number, size: readonly [number, number, number, number]): void {
  const id = `${which}-${side}`;
  const sec = taper(size, 0.004);
  if (which === 'core-foot') {
    frame(c, id, `part:${id}`, l, sec, (angleOf(memberFrame(id, [0, 1, 0]).frame, medialOf(side)) + 180) % 360);
    plate(c, `${id}-instep`, l * 0.08, l * 0.92, sec, l, LAYER.plate, LAYER.t, 50, 130);
    plate(c, `${id}-instep-2`, l * 0.25, l * 0.8, sec, l, LAYER.outer, LAYER.t2, 64, 116, 'gt-metal');
  } else {
    part(c, `part:${id}`, (p) => {
      p.loft({ profiles: [0, 0.5, 1].map((k) => at(outline(sec(k)), l * k)), match: 'index', segments: 2, label: `${id}-block`, material: 'gt-frame' });
    });
    // Three toe caps side by side across the top.
    for (const [n, a] of [[1, 43], [2, 90], [3, 137]] as const) plate(c, `${id}-toe-${n}`, 0.004, l - 0.002, sec, l, 0.0025, 0.006, a - 20, a + 20);
  }
  // The sole stands clear of the frame's collars; the tread lugs stand on it.
  const sole = which === 'core-foot' ? FLANGE.lip + 0.0015 : 0.003;
  plate(c, `${id}-sole`, 0.002, l - 0.002, sec, l, sole, 0.01, 236, 304, 'gt-primer');
  const lugs = Math.max(2, Math.round(l / 0.05));
  for (let i = 0; i < lugs; i++) {
    const y0 = (l * (i + 0.2)) / lugs;
    plate(c, `${id}-tread-${i + 1}`, y0, y0 + (l * 0.55) / lugs, sec, l, sole + 0.0105, 0.006, 241, 299, 'gt-primer');
  }
}

// ---------------------------------------------------------------- assembly

interface Member {
  readonly part: string;
  readonly front: V;
  readonly build: (c: Ctx, f: Local, l: number, size: readonly [number, number, number, number]) => void;
}

/** Room each limb frame keeps inside the S3 block section, per side (meters): the armor takes the rest. */
const INSET = { 'core-upper-arm': 0.014, 'core-forearm': 0.012, 'core-thigh': 0.012, 'core-shin': 0.012 } as const;
const SLEEVE = 0.3;
const LIMB_ARMOR: Readonly<Record<'core-upper-arm' | 'core-forearm' | 'core-thigh' | 'core-shin', LimbArmor>> = {
  'core-upper-arm': { outerLateral: false },
  'core-forearm': { outerLateral: false },
  'core-thigh': { outerLateral: false, frontGap: [0.37, 0.49] },
  'core-shin': { outerLateral: true },
};

export function members(): Member[] {
  const out: Member[] = [{ part: 'head-unit', front: FRONT, build: (c, _f, l, size) => head(c, l, size) }];
  for (const side of ['l', 'r'] as const) {
    for (const base of ['core-upper-arm', 'core-forearm', 'core-thigh', 'core-shin'] as const) {
      out.push({
        part: `${base}-${side}`,
        front: FRONT,
        build: (c, f, l, size) => {
          const sec = taper(size, INSET[base]);
          limb(c, f, `${base}-${side}`, side, l, sec, LIMB_ARMOR[base], SHELLS[base]);
          shells(c, f, `${base}-${side}`, side, l, sec, SHELLS[base]);
          if (base === 'core-thigh' || base === 'core-shin') sleeve(c, `${base}-${side}`, l, sec, SLEEVE);
        },
      });
    }
    out.push({ part: `hand-${side}`, front: medialOf(side), build: (c) => hand(c, side) });
    out.push({ part: `core-foot-${side}`, front: [0, 1, 0], build: (c, _f, l, size) => footMembers(c, side, 'core-foot', l, size) });
    out.push({ part: `foot-${side}`, front: [0, 1, 0], build: (c, _f, l, size) => footMembers(c, side, 'foot', l, size) });
  }
  return out;
}

// ---------------------------------------------------------------- torso

/**
 * A segmented armor plate in the mech frame: lofted across x between `x0` and `x1`, a
 * crowned section over [y0, y1] standing from `z0` toward +z (the robot's front), chamfered
 * at all four edges.
 */
function bellyPlate(c: Ctx, id: string, x0: number, x1: number, y0: number, y1: number, z0: number, t: number, material: Slot): void {
  part(c, sub6(id), (p) => {
    const ch = Math.min(0.012, (y1 - y0) / 6, (x1 - x0) / 6);
    const section = (x: number, inset: number): V[] => {
      const a = y0 + inset;
      const b = y1 - inset;
      const mid = (a + b) / 2;
      const h = t - inset * 0.6;
      return [[x, a, z0], [x, b, z0], [x, b - ch, z0 + h * 0.8], [x, mid, z0 + h], [x, a + ch, z0 + h * 0.8]];
    };
    p.loft({ profiles: [section(x0, ch * 0.7), section(x0 + ch, 0), section(x1 - ch, 0), section(x1, ch * 0.7)], match: 'index', sharpAngle: 30, label: id, material });
  }, 'armor');
}

/**
 * Abdomen rows (mech y above the stowed root) below and above the spine joint (root + 0.4),
 * and the plate face (mech z from the root) clear of the tub underside (root car height
 * 0.58 - tub floor 0.19). Root-relative, so they follow joint-table changes.
 */
const ABDOMEN = { rows: [[0.045, 0.215], [0.239, 0.379], [0.422, 0.657], [0.681, 0.937]] as const, z0: 0.396, t: 0.018, half: 0.5, firstHalf: 0.47, keel: 0.012 } as const;

/** The stowed (shut-skeleton) position of a joint in the mech frame. */
const stowedAt = (joint: string): V => STOWED.joints.find((j) => j.name === joint)?.position as unknown as V;

/**
 * The abdomen: the robot lies face down in the car, so the underside of the tub is its belly.
 * Four rows of left and right plates with a keel strip between them stand 6 mm clear of the
 * tub; in the car form they read as a segmented undertray 0.17 m off the road.
 */
function abdomen(c: Ctx): void {
  const root = stowedAt('root');
  ABDOMEN.rows.forEach(([r0, r1], i) => {
    const [y0, y1] = [root[1] + r0, root[1] + r1];
    const z0 = root[2] + ABDOMEN.z0;
    const n = i + 1;
    // The lowest row passes the rear subframe rails as the legs swing: it is narrower.
    const half = i === 0 ? ABDOMEN.firstHalf : ABDOMEN.half - 0.02 * i;
    bellyPlate(c, `abdomen-${n}-l`, ABDOMEN.keel + 0.008, half, y0, y1, z0, ABDOMEN.t, 'gt-paint');
    bellyPlate(c, `abdomen-${n}-r`, -half, -(ABDOMEN.keel + 0.008), y0, y1, z0, ABDOMEN.t, 'gt-paint');
    bellyPlate(c, `abdomen-${n}-keel`, -ABDOMEN.keel, ABDOMEN.keel, y0 + 0.01, y1 - 0.01, z0, ABDOMEN.t * 0.7, 'gt-metal');
  });
}

// ---------------------------------------------------------------- pauldrons

/**
 * The front fender flips into the shoulder armor (pauldron). S6b numbers it; the inner liner
 * of earlier revisions is gone, because in the limit layout the tyre and its swing fill the
 * fender's inside. The fender band below is the arch-clear upper part of the fender skin.
 */
const BAND = { archMargin: 0.03, u: [0.13, 0.32] as const } as const;

/**
 * The front fender's outer skin of a side, whichever source the S3 car uses: the body-surface
 * patch (`bodyPatches()['front-fender-<side>']`, sampled through `lifted`) or the C-106
 * `fenderPatches`. `point(z, s, inset)` is the skin point at station z and band parameter s
 * in [0, 1] (the upper band of the fender from its inboard edge toward the shoulder, above
 * the wheel arch), moved `inset` inward (negative: outward) in the station plane.
 */
interface FenderSkin {
  /** The source: the S3 body surface (true) or the C-106 fender panels. */
  readonly body: boolean;
  readonly point: (z: number, s: number, inset: number) => V;
  readonly normal: (z: number, s: number) => V;
}

function fenderSkin(side: 'l' | 'r'): FenderSkin {
  const sign = side === 'l' ? 1 : -1;
  const wheel = WHEELS.find((w) => w.name === `f${side}`) as (typeof WHEELS)[number];
  const arch = { z: wheel.z, y: wheel.d / 2, r: wheel.d / 2 + 0.035 + BAND.archMargin };
  const clearOfArch = (q: V) => Math.hypot(q[2] - arch.z, q[1] - arch.y) >= arch.r;
  const planar = (q: V, z: number): V => [q[0], q[1], z];
  if (bodyPatches()[`front-fender-${side}`] !== undefined) {
    // Body surface: t from the arch-clear low edge up to just under the shoulder line.
    // Below the shoulder crease: an offset band across the crease would fold.
    const top = T.shoulder - 0.1;
    const low = (z: number) => {
      let t = top - 0.12;
      while (t > 0.2 && clearOfArch(bodyPoint(z, t - 0.01, sign))) t -= 0.01;
      return t;
    };
    const tOf = (z: number, s: number) => low(z) + (top - low(z)) * s;
    return {
      body: true,
      point: (z, s, inset) => planar(lifted(z, tOf(z, s), sign, -inset), z),
      normal: (z, s) => unit(sub(lifted(z, tOf(z, s), sign, 0.001), lifted(z, tOf(z, s), sign, 0))),
    };
  }
  const surface = (fenderPatches(sign)[0] as ReturnType<typeof fenderPatches>[number]).surface;
  // The C-106 front patch runs v 0 -> 1 from z 2.184 to 1.0 on planar stations; u from the inboard edge outward.
  const vOf = (z: number) => (2.184 - z) / (2.184 - 1.0);
  const raw = (u: number, v: number): { p: V; n: V } => {
    const p = nurbs.surfacePoint(surface, u, v) as V;
    const d = nurbs.surfaceDerivatives(surface, u, v, 1);
    let n = unit(cross((d[1] as V[])[0] as V, (d[0] as V[])[1] as V));
    // Outward: away from a point inside the fender, above the wheel.
    if (n[0] * (p[0] - sign * 0.8) + n[1] * (p[1] - 0.45) < 0) n = mul(n, -1);
    return { p, n };
  };
  const uOf = (z: number, s: number) => {
    let um = BAND.u[1];
    while (um > BAND.u[0] + 0.02 && !clearOfArch(nurbs.surfacePoint(surface, um, vOf(z)) as V)) um -= 0.01;
    return BAND.u[0] + (um - BAND.u[0]) * s;
  };
  return {
    body: false,
    point: (z, s, inset) => {
      const { p, n } = raw(uOf(z, s), vOf(z));
      const m = unit([n[0], n[1], 0]);
      return planar(add(p, mul(m, -inset)), z);
    },
    normal: (z, s) => raw(uOf(z, s), vOf(z)).n,
  };
}


/**
 * The pauldron number (F1 criteria 12b/12c): a flat chamfered emblem plate on the front
 * fender, tangent to the skin at the plate centre and 0.5 mm off it, with its own planar
 * uv1 cell [0, 1]^2 that the `gt-decal-number-<side>` sheet fills. In the car form it is a
 * livery number on the front fender.
 */
/** `at`: [band parameter, car z] on the body-surface fender (limit layout: front of the fender, clear of the wheel swing); `atC106` on the C-106 fender (clear of its pop rail). */
export const NUMBER = { at: [0.5, 1.85] as const, atC106: [0.5, 1.34] as const, size: GT_STENCILS.number.size, t: 0.003, gap: 0.0005 } as const;
export const numberSlot = (side: 'l' | 'r') => stencilSlot(`number-${side}`);

/** The emblem's frame on the fender skin: origin on the skin, y the outward normal, x across the fender, z along the car. */
function numberFrame(side: 'l' | 'r'): Local {
  const skin = fenderSkin(side);
  const [s0, z0] = skin.body ? NUMBER.at : NUMBER.atC106;
  const p = skin.point(z0, s0, 0);
  const n = skin.normal(z0, s0);
  const z: V = unit(sub([0, 0, 1], mul(n, n[2])));
  // Lift the flat plate over the highest skin point under its footprint (a concave skin rises toward its edges).
  let lift = 0;
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      const q = skin.point(z0 + (i / 3) * NUMBER.size[1] * 0.7, Math.min(1, Math.max(0, s0 + j / 9)), 0);
      lift = Math.max(lift, dot(sub(q, p), n));
    }
  }
  return { o: add(p, mul(n, lift)), x: cross(n, z), y: n, z };
}

function pauldronNumber(c: Ctx, side: 'l' | 'r'): void {
  const id = `front-fender-${side}-number`;
  part(c, sub6(id), (p) => {
    // The plate is flat: numberFrame lifts it over the skin under its footprint.
    stencilPlate(p, numberSpec(side), numberFrame(side), { t: NUMBER.t, gap: NUMBER.gap, label: id });
    p.tag(sel.all(), 'decal');
  }, 'armor');
}

/** The stencil of a side's pauldron number: the shared livery number in its own slot. */
export const numberSpec = (side: 'l' | 'r'): StencilSpec => ({ ...GT_STENCILS.number, key: `number-${side}` });

/** The pauldron number sheets as materials: off-white numerals over the main paint, on each patch's uv1 cell. */
export function s6bDecalMaterials(): Record<string, (texture: TextureSink) => StandardMaterialOptions> {
  return Object.fromEntries((['l', 'r'] as const).map((side) => [numberSlot(side), stencilMaterial(numberSpec(side))]));
}


/**
 * The chest plate group (F1 criterion 12b, the chest focal point): above the abdomen rows the
 * tub underside is the robot's upper chest. Two crowned pectoral plates with a raised upper
 * layer and vent slats, and a proud centre keel, stand on the tub line in the car form (an
 * undertray continuation) and slide `travel` forward in the `armor` phase. Chest-relative.
 */
export const CHEST = { y: [0.06, 0.46] as const, half: 0.55, keel: 0.03, z0: 0.396, t: 0.022, t2: 0.014, travel: 0.06 } as const;

function chestArmor(c: Ctx): void {
  const root = stowedAt('root');
  const ch = stowedAt('chest');
  const [y0, y1] = [ch[1] + CHEST.y[0], ch[1] + CHEST.y[1]];
  const z0 = root[2] + CHEST.z0;
  for (const [side, sx] of [['l', 1], ['r', -1]] as const) {
    const span = (a: number, b: number): [number, number] => (sx > 0 ? [a, b] : [-b, -a]);
    const [xa, xb] = span(CHEST.keel + 0.006, CHEST.half);
    bellyPlate(c, `chest-plate-${side}`, xa, xb, y0, y1, z0, CHEST.t, 'gt-paint');
    const [ua, ub] = span(0.09, CHEST.half - 0.07);
    bellyPlate(c, `chest-plate-${side}-upper`, ua, ub, y0 + 0.17, y1 - 0.03, z0 + CHEST.t + 0.002, CHEST.t2, 'gt-paint');
    for (let k = 0; k < 3; k++) {
      const [va, vb] = span(0.12, CHEST.half - 0.1);
      bellyPlate(c, `chest-vent-${side}-${k + 1}`, va, vb, y0 + 0.03 + k * 0.042, y0 + 0.055 + k * 0.042, z0 + CHEST.t * 0.85 + 0.002, 0.008, 'gt-frame');
    }
  }
  bellyPlate(c, 'chest-keel', -CHEST.keel, CHEST.keel, y0 - 0.01, y1 + 0.01, z0, CHEST.t + CHEST.t2 + 0.004, 'gt-metal');
}

/** Robot-only parts on the torso (no S3 block): built in the mech frame, folded by `joint`, each sub-part bound by `bind`. */
interface Extra {
  readonly id: string;
  /** The joint whose car-form fold places it; `null`: built in the car form (absent from the standing form). */
  readonly joint: string | null;
  readonly build: (c: Ctx) => void;
  readonly bind: (id: string) => string;
}
const MECH_FRAME: Local = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export function extras(): Extra[] {
  return [
    // Rows below the spine joint ride the pelvis (root), the rest the spine.
    { id: 'chest', joint: 'chest', build: chestArmor, bind: () => 'chest-armor-joint' },
    { id: 'abdomen', joint: 'root', build: abdomen, bind: (id) => (Number(/^abdomen-(\d)/.exec(id)?.[1]) <= 2 ? 'root' : 'spine') },
    ...(['l', 'r'] as const).map((side) => ({ id: `front-fender-${side}`, joint: null, build: (c: Ctx) => pauldronNumber(c, side), bind: () => rigJointOf(`front-fender-${side}`) })),
  ];
}

/**
 * The robot form at S6b fidelity in the car form: the same contract as `buildS3Mech` (every
 * member placed on its joint's car-form frame), with sub-parts tagged `s6b:<id>`. `standing`
 * leaves the members on the shut skeleton in the mech frame instead (detail views).
 */
export function buildS6bMech(session: SessionFactory = () => model(), form: 'car' | 'standing' = 'car'): Model {
  const m = session('mech');
  for (const layer of LAYERS) {
    for (const mb of members()) {
      const { frame: f, length, size, joint } = memberFrame(mb.part, mb.front);
      const s = session(`${layer}-${mb.part}`);
      mb.build({ m: s, layer }, f, length, size);
      if (s.count(sel.all()) === 0) continue;
      placeLocal(s, sel.all(), f);
      if (form === 'car') foldSession(s, joint);
      m.append(s);
    }
    for (const x of extras()) {
      if (x.joint === null && form === 'standing') continue;
      const s = session(`${layer}-${x.id}`);
      x.build({ m: s, layer });
      if (s.count(sel.all()) === 0) continue;
      if (x.joint !== null) {
        placeLocal(s, sel.all(), MECH_FRAME);
        if (form === 'car') foldSession(s, x.joint);
      }
      m.append(s);
    }
    m.checkpoint(layer);
  }
  m.uv.project({ mode: 'box', scale: 0.5 });
  // Decal patches keep their own planar uv1 cells.
  m.uv.project({ mode: 'box', scale: 0.5, channel: 'uv1', faces: form === 'car' ? sel.all().minus(sel.tag('decal')) : sel.all() });
  return m;
}

// ---------------------------------------------------------------- rig

/** The rig joint a parts.json unit rides in `rigOver`: its joint, through the mechanisms that move it in phase order. */
export function rigJointOf(unit: string): string {
  const p = parts.parts.find((x) => x.id === unit) ?? TRANSFORM.pieces.find((x) => x.id === unit);
  if (p === undefined) throw new Error(`unknown unit ${unit}`);
  const order = TRANSFORM.phases.map((x) => x.name);
  let joint = p.mech.joint;
  for (const m of TRANSFORM.mechanisms.filter((x) => x.moves.includes(unit)).sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase))) joint = `${m.id}-on-${joint}`;
  return joint;
}

/** The member a sub-part id belongs to: the longest member part id it starts with. */
function memberOf(id: string): string {
  const m = members()
    .map((x) => x.part)
    .filter((p) => id.startsWith(`${p}-`) || (p === 'head-unit' && id.startsWith('head-')))
    .sort((a, b) => b.length - a.length)[0];
  if (m === undefined) throw new Error(`no member for ${id}`);
  return m;
}

export interface S6bRig {
  /** Finger, thumb and shell deploy joints, car-form rest positions (append after the S4 joint table). */
  readonly joints: readonly JointSpec[];
  /** The shell deploy stages, keyed in the `armor` phase. */
  readonly keys: readonly { readonly joint: string; readonly value: number; readonly phase: string }[];
  /** Sub-part -> rig joint. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly contacts: readonly DesignedContact[];
}

/**
 * The rig additions of the S6b robot form over `m` (a session holding `buildS6bMech`): the
 * finger joints, every `s6b:` sub-part with its joint (its member's joint, the telescope of
 * a sleeve, a phalanx its own joint), and the designed contacts of the knuckles.
 */
export function s6bRig(m: Model): S6bRig {
  const joints: JointSpec[] = [];
  const contacts: DesignedContact[] = [];
  const keys: { joint: string; value: number; phase: string }[] = [];
  for (const side of ['l', 'r'] as const) {
    const { frame: f, joint } = memberFrame(`hand-${side}`, medialOf(side));
    const fold = carFold(joint);
    const turn = (d: V) => sub(fold(add(toMechFrame(f, [0, 0, 0]), sub(toMechFrame(f, d), f.o))), fold(f.o));
    const layout = handLayout(side);
    // The metacarpal sleeve slides along the hand toward the fingers.
    joints.push({ name: `hand-${side}-metacarpal-joint`, parent: `wrist-${side}`, position: fold(f.o), kind: 'prismatic', axis: unit(turn([0, 1, 0])), limits: [0, PALM.extend] });
    keys.push({ joint: `hand-${side}-metacarpal-joint`, value: PALM.extend, phase: 'armor' });
    for (const p of layout.phalanges) {
      joints.push({ name: `${p.id}-joint`, parent: p.parent, position: fold(toMechFrame(f, p.pivot)), kind: 'revolute', axis: unit(turn(p.axis)), limits: p.limits });
      keys.push({ joint: `${p.id}-joint`, value: p.open, phase: 'armor' });
      const prev = p.parent === `wrist-${side}` ? `hand-${side}` : p.parent === `hand-${side}-metacarpal-joint` ? `hand-${side}-metacarpal` : p.parent.slice(0, -'-joint'.length);
      contacts.push({ parts: [p.id, prev], tolerance: 0.006 });
    }
  }
  // Shells: a stage joint (the sleeves) on the member's joint, the deploy joint (the shell) on it, both along the shell normal.
  const shellJoints = new Map<string, { stage: string; deploy: string }>();
  for (const side of ['l', 'r'] as const) {
    for (const [base, list] of Object.entries(SHELLS) as [keyof typeof SHELLS, readonly Shell[]][]) {
      const member = `${base}-${side}`;
      const { frame: f, length, size, joint } = memberFrame(member, FRONT);
      const fold = carFold(joint);
      const sec = taper(size, INSET[base]);
      for (const shell of list) {
        const g = shellGeometry(f, side, length, sec, shell);
        const name = `${member}-shell-${shell.name}`;
        const at = fold(toMechFrame(f, g.posts[0] as V));
        const axis = unit(sub(fold(toMechFrame(f, add(g.posts[0] as V, g.axis))), at));
        const stage = `${name}-stage`;
        const deploy = `${name}-deploy`;
        joints.push({ name: stage, parent: rigJointOf(member), position: at, kind: 'prismatic', axis, limits: [0, DEPLOY.travel] });
        joints.push({ name: deploy, parent: stage, position: at, kind: 'prismatic', axis, limits: [0, DEPLOY.travel] });
        keys.push({ joint: stage, value: DEPLOY.travel, phase: 'armor' }, { joint: deploy, value: DEPLOY.travel, phase: 'armor' });
        shellJoints.set(name, { stage, deploy });
      }
    }
  }
  // V-fin blades: a revolute on the head (through its lift), turning up about the head's front axis.
  {
    const { frame: f, length, size, joint } = memberFrame('head-unit', FRONT);
    const fold = carFold(joint);
    const turn = (d: V) => unit(sub(fold(add(f.o, sub(toMechFrame(f, d), f.o))), fold(f.o)));
    const hd = headDepth(size);
    for (const side of ['l', 'r'] as const) {
      const h = vfinHinge(length, hd, side);
      const name = `head-vfin-${side}-joint`;
      const value = h.out * (VFIN.angle - VFIN.stowed);
      joints.push({ name, parent: rigJointOf('head-unit'), position: fold(toMechFrame(f, h.at)), kind: 'revolute', axis: turn([0, 0, 1]), limits: value > 0 ? [0, value + 5] : [value - 5, 0] });
      keys.push({ joint: name, value, phase: 'armor' });
    }
    joints.push({ name: 'head-crest-joint', parent: rigJointOf('head-unit'), position: fold(toMechFrame(f, crestHinge(length))), kind: 'revolute', axis: turn([0, 0, 1]), limits: [0, 95] });
    keys.push({ joint: 'head-crest-joint', value: 90, phase: 'armor' });
    joints.push({ name: 'head-chin-joint', parent: rigJointOf('head-unit'), position: fold(f.o), kind: 'prismatic', axis: turn([0, -1, 0]), limits: [0, CREST.chin] });
    keys.push({ joint: 'head-chin-joint', value: CREST.chin, phase: 'armor' });
  }
  // The chest plates slide forward (mech +z) on the chest.
  {
    const fold = carFold('chest');
    const at = stowedAt('chest');
    joints.push({ name: 'chest-armor-joint', parent: 'chest', position: fold(at), kind: 'prismatic', axis: unit(sub(fold(add(at, [0, 0, 1])), fold(at))), limits: [0, CHEST.travel] });
    keys.push({ joint: 'chest-armor-joint', value: CHEST.travel, phase: 'armor' });
  }
  const bindings: Record<string, string> = {};
  for (const t of m.inspect().tags.filter((x) => x.startsWith('s6b:'))) {
    const id = t.slice(4);
    const phalanx = /^(hand-[lr]-(?:f\d|thumb)-p\d)(?:-scale|-pad)?$/.exec(id);
    const sleeveOf = /^core-(thigh|shin)-([lr])-sleeve$/.exec(id);
    const extra = extras().find((x) => id === x.id || id.startsWith(`${x.id}-`));
    const shell = /^(.*-shell-[a-z-]+?)(-sleeve|-mount)?$/.exec(id);
    const sj = shell === null ? undefined : shellJoints.get(shell[1] as string);
    if (extra !== undefined) bindings[id] = extra.bind(id);
    else if (/^head-(vfin-[lr]|crest|chin)$/.test(id)) bindings[id] = `${id}-joint`;
    else if (/^hand-[lr]-(metacarpal|backplate|knuckle-guard|f\d-tendon)$/.test(id)) bindings[id] = `${id.slice(0, 6)}-metacarpal-joint`;
    else if (sj !== undefined && shell !== null) bindings[id] = shell[2] === '-sleeve' ? sj.stage : shell[2] === '-mount' ? rigJointOf(memberOf(id)) : sj.deploy;
    else if (phalanx !== null) bindings[id] = `${phalanx[1]}-joint`;
    else if (sleeveOf !== null) bindings[id] = `${sleeveOf[1] === 'thigh' ? 'knee' : 'ankle'}-${sleeveOf[2]}-telescope`;
    else bindings[id] = rigJointOf(memberOf(id));
  }
  return { joints, keys, bindings, contacts };
}

/**
 * The S6b robot form as the S7 assembly's mech source: the geometry is built once, and its
 * rig extension adds the hand joints and binds every sub-part.
 */
export function s6bMechSource(): MechSource {
  let built: Model | undefined;
  const mech = () => {
    built ??= buildS6bMech();
    return built;
  };
  return {
    build: mech,
    extension: (): RigExtension => {
      const r = s6bRig(mech());
      return { joints: r.joints, keys: r.keys, parts: Object.entries(r.bindings).map(([part, joint]) => ({ faces: sel.tag(sub6(part)), joint, part })), contacts: r.contacts };
    },
  };
}
