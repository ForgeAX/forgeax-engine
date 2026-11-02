import type { Result } from '@forgeax/engine-types';
import { type Model, type ModelingError, type Point2, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { by, type DetailPart, detailSession, finishDetail, ranged, ring, roundedRect } from './s6c-kit.ts';

/**
 * Case C-100 stage S6c (code name mech-gt): the running-gear detail recipes. Every one is
 * built about its wheel axis, +Y pointing out of the car (the anchor normal), X forward
 * and Z up (the anchor's third axis), meters, origin at the wheel center.
 */

/** Turn the faces of `label` about Y so their bounds center sits at polar angle `target` (degrees, in XZ from +X toward +Z). */
function aimAbout(m: Model, label: string, target: number): void {
  const b = m.bounds(by(label));
  if (!b.ok) throw b.error;
  const cx = (b.value.min[0] + b.value.max[0]) / 2;
  const cz = (b.value.min[2] + b.value.max[2]) / 2;
  const phi = (Math.atan2(cz, cx) * 180) / Math.PI;
  m.rotate(by(label), 'y', phi - target);
}

export interface WheelOptions {
  readonly name: string;
  /** Rim seat diameter (the tire's inner diameter). */
  readonly diameter: number;
  /** Rim width along the axis. */
  readonly width: number;
  /** Spoke count. */
  readonly spokes?: number;
  /** Face dish: how far the hub sits inboard of the outer lip. */
  readonly dish?: number;
}

export const WHEEL_RANGES = { diameter: [0.45, 0.6], width: [0.18, 0.4], spokes: [5, 14], dish: [0.01, 0.065] } as const;

/**
 * A forged center-lock wheel: the barrel (outer and inner flanges, drop center, stepped
 * lip) as one revolved wall, tapered spokes with a chamfered top swept from the hub to the
 * lip, the stepped hub, the six-lobe center-lock nut with its safety clip, and the valve
 * stem through the barrel between two spokes.
 */
export function forgedWheel(o: WheelOptions): Result<DetailPart, ModelingError> {
  const spokes = o.spokes ?? 10;
  const dish = o.dish ?? 0.05;
  const checked = ranged({ diameter: [o.diameter, ...WHEEL_RANGES.diameter], width: [o.width, ...WHEEL_RANGES.width], spokes: [spokes, ...WHEEL_RANGES.spokes], dish: [dish, ...WHEEL_RANGES.dish] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const r = o.diameter / 2;
  const hw = (o.width / 2) * 0.92;
  const lip = hw * 0.2;
  // Barrel wall in (radius, axial): outer surface out-to-in, inner surface back.
  m.revolve({
    points: [
      [r - 0.002, -hw], [r - 0.002, -hw + 0.015], [r - 0.028, -hw + 0.04], [r - 0.028, lip], [r - 0.002, lip + 0.025], [r - 0.002, hw],
      [r - 0.016, hw], [r - 0.016, lip + 0.02], [r - 0.042, lip - 0.005], [r - 0.042, -hw + 0.04], [r - 0.016, -hw + 0.012], [r - 0.016, -hw], [r - 0.002, -hw],
    ],
    segments: 96,
    label: piece('barrel'),
    material: 'rim',
  });
  // Hub: a stepped boss, its face `dish` inboard of the lip.
  const face = hw - dish;
  const hubR = 0.085;
  m.revolve({ points: [[0.013, face - 0.05], [hubR, face - 0.05], [hubR, face - 0.008], [hubR - 0.012, face], [0.013, face], [0.013, face - 0.05]], segments: 48, label: piece('hub'), material: 'rim' });
  // Spokes: tapered, chamfered sections from the hub out and up to the lip.
  const section: Point2[] = [[-0.016, -0.014], [0.016, -0.014], [0.016, 0.006], [0.01, 0.014], [-0.01, 0.014], [-0.016, 0.006]];
  const tip = r - 0.03;
  for (let k = 0; k < spokes; k++) {
    const a = (2 * Math.PI * k) / spokes;
    const at = (rad: number, y: number): Tuple3 => [rad * Math.cos(a), y, rad * Math.sin(a)];
    m.sweep({ profile: section, path: { kind: 'catmullRom', points: [at(hubR + 0.015, face - 0.02), at((hubR + tip) / 2, face + dish * 0.45 - 0.014), at(tip, hw - 0.03)], segments: 8 }, up: [0, 1, 0], frame: 'up', scale: [1, 0.7], label: piece(`spoke-${k}`), material: 'rim' });
  }
  // Center-lock nut with six lobes, the safety clip ring on its face, and the axle cap.
  const lobes: Point2[] = Array.from({ length: 36 }, (_, i): Point2 => {
    const t = (2 * Math.PI * i) / 36;
    const rr = 0.04 + 0.006 * Math.cos(6 * t);
    return [rr * Math.cos(t), rr * Math.sin(t)];
  });
  m.extrudePolygon({ points: lobes, holes: [ring(0.014, 24)], depth: 0.028, label: piece('nut'), material: 'chrome' });
  m.rotate(by(`${o.name}-nut`), 'x', -90);
  m.translate(by(`${o.name}-nut`), [0, face + 0.0005, 0]);
  m.cylinder({ radiusTop: 0.0125, radiusBottom: 0.0125, height: 0.034, radialSegments: 24, center: [0, face + 0.012, 0], label: piece('axle-cap'), material: 'marker' });
  m.torus({ radius: 0.024, tube: 0.0018, radialSegments: 8, tubularSegments: 36, label: piece('clip'), material: 'steel' });
  m.translate(by(`${o.name}-clip`), [0, face + 0.0305, 0]);
  m.rotate(by(`${o.name}-clip`), 'x', 90, [0, face + 0.0305, 0]);
  // Valve stem through the drop-center wall, halfway between two spokes.
  const va = Math.PI / spokes;
  const stem = (rad: number, y: number): Tuple3 => [rad * Math.cos(va), y, rad * Math.sin(va)];
  m.sweep({ profile: ring(0.0035, 12), path: [stem(r - 0.0215, lip + 0.026), stem(r - 0.04, lip + 0.056)], label: piece('valve'), material: 'rubber' });
  m.sweep({ profile: ring(0.0045, 12), path: [stem(r - 0.0404, lip + 0.0567), stem(r - 0.0455, lip + 0.066)], label: piece('valve-cap'), material: 'chrome' });
  m.triangulate(sel.all().minus(sel.createdBy(`${o.name}-barrel`)).minus(by(`${o.name}-nut`)));
  return finishDetail(o.name, m, pieces, { diameter: o.diameter, width: o.width, spokes, face, tip });
}

export interface DiscOptions {
  readonly name: string;
  readonly radius: number;
  /** Friction ring depth (outer minus inner radius). */
  readonly ring?: number;
  readonly thickness?: number;
  /** Axial position of the ring's mid plane. */
  readonly offset?: number;
  /** Hat flange position (axial), toward the hub. */
  readonly hat?: number;
}

export const DISC_RANGES = { radius: [0.15, 0.25], ring: [0.05, 0.1], thickness: [0.02, 0.045] } as const;

/**
 * A two-piece ventilated, cross-drilled disc: two friction plates with staggered drilled
 * holes, curved cooling vanes between them, the alloy hat (flange and drum) with its
 * mounting bolts, and the floating bobbins that carry the ring.
 */
export function brakeDisc(o: DiscOptions): Result<DetailPart, ModelingError> {
  const depth = o.ring ?? 0.072;
  const t = o.thickness ?? 0.034;
  const y0 = o.offset ?? 0;
  const hat = o.hat ?? 0.045;
  const checked = ranged({ radius: [o.radius, ...DISC_RANGES.radius], ring: [depth, ...DISC_RANGES.ring], thickness: [t, ...DISC_RANGES.thickness] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const ro = o.radius;
  const ri = ro - depth;
  const plate = t * 0.32;
  // Drilled holes in three rows, each staggered a quarter pitch from the one inside it.
  const holes: Point2[][] = [];
  for (let k = 0; k < 3; k++) {
    const rr = ri + (depth * (k + 1)) / 4;
    for (let j = 0; j < 12; j++) {
      const a = (2 * Math.PI * (j + k / 4)) / 12;
      holes.push(ring(0.0032, 10, [rr * Math.cos(a), rr * Math.sin(a)]));
    }
  }
  for (const [k, y] of [y0 + t / 2 - plate, y0 - t / 2].entries()) {
    const label = piece(`plate-${k === 0 ? 'out' : 'in'}`);
    m.extrudePolygon({ points: ring(ro, 96), holes: [ring(ri, 72), ...holes], depth: plate, label, material: 'brake' });
    m.rotate(by(label), 'x', -90);
    m.translate(by(label), [0, y, 0]);
  }
  // Curved vanes, clear of both plates by 0.4 mm.
  const gap = t - 2 * plate - 0.0008;
  for (let j = 0; j < 36; j++) {
    const a = (2 * Math.PI * j) / 36;
    const vane: Point2[] = [];
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const rr = ri + 0.003 + ((depth - 0.006) * i) / n;
      const aa = a + 0.25 * (i / n);
      vane.push([rr * Math.cos(aa), rr * Math.sin(aa)]);
    }
    const back = vane.map(([x, z]): Point2 => {
      const l = Math.hypot(x, z);
      const w = 0.0015 / l;
      return [x * Math.cos(w) - z * Math.sin(w), x * Math.sin(w) + z * Math.cos(w)];
    });
    const label = piece(`vane-${j}`);
    m.extrudePolygon({ points: [...vane, ...back.reverse()], depth: gap, label, material: 'brake' });
    m.rotate(by(label), 'x', -90);
    m.translate(by(label), [0, y0 - gap / 2, 0]);
  }
  // Hat: flange at `hat`, drum down to the ring's inner edge, lip under the outer plate.
  const hr = ri - 0.004;
  m.revolve({ points: [[0.03, hat], [0.03, hat - 0.006], [hr - 0.006, hat - 0.006], [hr - 0.006, y0 - t / 2 + 0.002], [hr, y0 - t / 2 + 0.002], [hr, hat], [0.03, hat]], segments: 72, label: piece('hat'), material: 'trim' });
  for (let j = 0; j < 6; j++) {
    const a = (2 * Math.PI * j) / 6;
    m.cylinder({ radiusTop: 0.006, radiusBottom: 0.006, height: 0.006, radialSegments: 6, center: [0.05 * Math.cos(a), hat - 0.0095, 0.05 * Math.sin(a)], label: piece(`hat-bolt-${j}`), material: 'steel' });
  }
  for (let j = 0; j < 10; j++) {
    const a = (2 * Math.PI * (j + 0.5)) / 10;
    m.cylinder({ radiusTop: 0.0015, radiusBottom: 0.0015, height: t + 0.004, radialSegments: 10, center: [(ri - 0.002) * Math.cos(a), y0, (ri - 0.002) * Math.sin(a)], label: piece(`bobbin-${j}`), material: 'chrome' });
  }
  return finishDetail(o.name, m, pieces, { outer: ro, inner: ri, thickness: t, offset: y0 });
}

export interface CaliperOptions {
  readonly name: string;
  /** Disc outer radius and thickness the caliper straddles. */
  readonly disc: number;
  readonly thickness: number;
  /** Disc mid plane (axial). */
  readonly offset?: number;
  /** Pistons per side. */
  readonly pistons?: number;
  /** Polar angle of the caliper center (degrees in XZ from +X toward +Z). */
  readonly at?: number;
}

export const CALIPER_RANGES = { pistons: [2, 5], at: [0, 360] } as const;

/**
 * A monoblock multi-piston caliper straddling the disc: the U-section body revolved over
 * the arc the pistons need, rounded edges, one piston bore boss per piston on the outer
 * jaw, two bleed nipples and the brake-line banjo on the bridge, the pad retaining pin,
 * and a blank raised plate as the logo slot (no lettering).
 */
export function caliper(o: CaliperOptions): Result<DetailPart, ModelingError> {
  const pistons = o.pistons ?? 3;
  const at = o.at ?? 135;
  const checked = ranged({ pistons: [pistons, ...CALIPER_RANGES.pistons], at: [at, ...CALIPER_RANGES.at] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const ro = o.disc;
  const y0 = o.offset ?? 0;
  const half = o.thickness / 2 + 0.002;
  const jaw = 0.028;
  const lo = ro - 0.068;
  const hi = ro + 0.02;
  const arc = 14 * pistons + 22;
  const body = piece('body');
  m.revolve({ points: [[lo, y0 + half], [lo, y0 + half + jaw], [hi, y0 + half + jaw], [hi, y0 - half - jaw], [lo, y0 - half - jaw], [lo, y0 - half], [ro + 0.004, y0 - half], [ro + 0.004, y0 + half], [lo, y0 + half]], segments: 24, angle: arc, label: body, material: 'caliper' });
  m.bevel(by(body).toEdges('touching').and(sel.edges.dihedral('>', 60)), { width: 0.003, segments: 2, label: piece('round') });
  // Piston bosses on the outer jaw face, evenly over the arc.
  const outer = y0 + half + jaw;
  const mid = (lo + ro) / 2;
  for (let i = 0; i < pistons; i++) {
    const a = ((-arc / 2 + 11 + ((arc - 22) * (i + 0.5)) / pistons) * Math.PI) / 180;
    m.cylinder({ radiusTop: 0.0125, radiusBottom: 0.014, height: 0.004, radialSegments: 24, center: [mid * Math.cos(a), outer + 0.0025, mid * Math.sin(a)], label: piece(`piston-${i}`), material: 'caliper' });
  }
  // Blank logo plate along the bridge's outer face.
  m.extrudePolygon({ points: roundedRect(Math.min(0.09, (hi * arc * Math.PI) / 180 - 0.06), 0.016, 0.005, 3), depth: 0.0015, label: piece('logo-plate'), material: 'marker' });
  m.rotate(by(`${o.name}-logo-plate`), 'y', 90);
  m.translate(by(`${o.name}-logo-plate`), [hi + 0.0035, y0 + 0.0075, 0]);
  // Bleed nipples and the banjo fitting, radial on the bridge.
  const end = arc / 2 - 7;
  for (const [k, a, rad] of [['bleed-out', end, 0.0035], ['bleed-in', end, 0.0035], ['banjo', -end, 0.006]] as const) {
    const label = piece(k);
    m.cylinder({ radiusTop: rad * 0.8, radiusBottom: rad, height: 0.012, radialSegments: k === 'banjo' ? 6 : 12, center: [0, 0, 0], label, material: k === 'banjo' ? 'steel' : 'chrome' });
    m.rotate(by(label), 'z', -90);
    const y = k === 'bleed-out' ? y0 + half + jaw * 0.6 : k === 'bleed-in' ? y0 - half - jaw * 0.6 : y0 - half - jaw * 0.3;
    m.translate(by(label), [hi + 0.0065, y, 0]);
    m.rotate(by(label), 'y', -a);
  }
  // Pad retaining pin over the bridge.
  m.cylinder({ radiusTop: 0.003, radiusBottom: 0.003, height: 2 * (half + jaw) - 0.01, radialSegments: 10, center: [hi + 0.0035, y0, 0], label: piece('pin'), material: 'steel' });
  m.rotate(by(`${o.name}-pin`), 'y', end * 0.6);
  // Body built centered on +X: aim everything at `at`.
  const b = m.bounds(by(body));
  if (!b.ok) return b;
  const phi = (Math.atan2((b.value.min[2] + b.value.max[2]) / 2, (b.value.min[0] + b.value.max[0]) / 2) * 180) / Math.PI;
  // The fittings were placed about +X; turn the body onto them first, then all onto `at`.
  m.rotate(by(body).or(by(`${o.name}-round`)), 'y', phi);
  m.rotate(sel.all(), 'y', -at);
  return finishDetail(o.name, m, pieces, { pistons: pistons * 2, arc, outer: hi });
}

export const LINER_RANGES = { radius: [0.25, 0.5], width: [0.025, 0.5], arc: [90, 260], offset: [-0.06, 0.25] } as const;

export interface LinerOptions {
  readonly name: string;
  /** Inner radius (tire clearance). */
  readonly radius: number;
  /** Axial width. */
  readonly width: number;
  /** Arc covered, degrees, centered on +Z (up). */
  readonly arc?: number;
  /** Axial offset of the liner's middle (negative: inboard). */
  readonly offset?: number;
  /** Only the fore or aft half (for arches whose panel is split at the axle). */
  readonly half?: 'fore' | 'aft';
}

/**
 * A wheel-arch liner: a ribbed plastic shell over the top of the wheel, with stiffening
 * ribs across it and an outer return flange; optionally only its fore or aft half.
 */
export function archLiner(o: LinerOptions): Result<DetailPart, ModelingError> {
  const arc = o.arc ?? 200;
  const off = o.offset ?? -0.02;
  const checked = ranged({ radius: [o.radius, ...LINER_RANGES.radius], width: [o.width, ...LINER_RANGES.width], arc: [arc, ...LINER_RANGES.arc], offset: [off, ...LINER_RANGES.offset] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const w = o.width / 2;
  const t = 0.004;
  const shell: Point2[] = [[o.radius, off - w], [o.radius + t, off - w], [o.radius + t, off + w - 0.01], [o.radius + 0.022, off + w - 0.004], [o.radius + 0.022, off + w], [o.radius, off + w], [o.radius, off - w]];
  // Angles from +X (forward) toward +Z (up); the fore half ends at the top, the aft half starts there.
  const [from, to] = o.half === 'fore' ? [90 - arc / 2, 90] : o.half === 'aft' ? [90, 90 + arc / 2] : [90 - arc / 2, 90 + arc / 2];
  const label = piece('shell');
  const span = to - from - (o.half === undefined ? 0 : 0.4);
  m.revolve({ points: shell, segments: Math.max(12, Math.round(span / 4)), angle: span, label, material: 'liner' });
  aimAbout(m, label, (from + to) / 2);
  // Ribs across the liner every 20 degrees, standing on its outer face (wide liners only).
  for (let a = from + 10, i = 0; o.width >= 0.08 && a < to - 5; a += 20, i++) {
    const label = piece(`rib-${i}`);
    m.extrudePolygon({ points: roundedRect(0.006, o.width - 0.03, 0.002, 1), depth: 0.012, label, material: 'liner' });
    // Thin along the arc, long along the axis, standing radially out of the shell.
    m.rotate(by(label), 'y', 90);
    m.translate(by(label), [o.radius + t + 0.0005, off, 0]);
    m.rotate(by(label), 'y', -a);
  }
  return finishDetail(o.name, m, pieces, { radius: o.radius, width: o.width, arc });
}
