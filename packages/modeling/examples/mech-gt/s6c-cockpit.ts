import type { Result } from '@forgeax/engine-types';
import { type ModelingError, type Point2, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { airfoil, by, chaikin, chaikinOpen, curvedScreen, type DetailPart, detailSession, finishDetail, ranged, ring, roundedRect } from './s6c-kit.ts';

/**
 * Case C-100 stage S6c (code name mech-gt): the cockpit recipes. Each is parametric and
 * car-agnostic, built in its own frame (meters; X across the car, Y up, Z forward unless a
 * recipe says otherwise) and returned as a `DetailPart` for `mount`.
 */

/** A closed (x, y) section at station z, as a planar 3D loop. */
const atZ = (pts: readonly Point2[], z: number): Tuple3[] => pts.map(([x, y]): Tuple3 => [x, y, z]);
/** A closed (z, y) section at station x. */
const atX = (pts: readonly Point2[], x: number): Tuple3[] => pts.map(([z, y]): Tuple3 => [x, y, z]);

export interface SeatOptions {
  readonly name: string;
  /** Overall width across the bolsters. */
  readonly width?: number;
  /** Cushion depth, back face to front lip. */
  readonly depth?: number;
  /** Backrest height along its own axis, headrest included. */
  readonly backHeight?: number;
  /** Backrest recline from vertical, degrees. */
  readonly recline?: number;
  /** Bolster rise above the seat pan. */
  readonly bolster?: number;
  /** Shell depth behind the upholstery line (under the cushion, behind the backrest). */
  readonly shell?: number;
}

export const SEAT_RANGES = { width: [0.4, 0.6], depth: [0.4, 0.6], backHeight: [0.55, 0.85], recline: [5, 35], bolster: [0.03, 0.12], shell: [0.012, 0.035] } as const;

/**
 * A bucket seat on rails, origin on the floor under the cushion center: carbon shell
 * (cushion and backrest undersides), leather bolsters and an Alcantara center insert,
 * an integrated headrest with a harness pass-through ring, two runner rails with their
 * carriages, four hex bolts with washers, and the fore-aft release bar.
 */
export function seat(o: SeatOptions): Result<DetailPart, ModelingError> {
  const width = o.width ?? 0.46;
  const depth = o.depth ?? 0.5;
  const backHeight = o.backHeight ?? 0.72;
  const recline = o.recline ?? 18;
  const bolster = o.bolster ?? 0.08;
  const shell = o.shell ?? 0.035;
  const checked = ranged({ width: [width, ...SEAT_RANGES.width], depth: [depth, ...SEAT_RANGES.depth], backHeight: [backHeight, ...SEAT_RANGES.backHeight], recline: [recline, ...SEAT_RANGES.recline], bolster: [bolster, ...SEAT_RANGES.bolster], shell: [shell, ...SEAT_RANGES.shell] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const w = width / 2;
  const rail = { y: 0.03, x: w * 0.62 };
  const pan = rail.y + 0.0245;

  // Rails: a C-section runner per side, its carriage, and two hex bolts with washers at each end.
  const runner: Point2[] = [[-0.018, 0], [0.018, 0], [0.018, 0.022], [0.011, 0.022], [0.011, 0.007], [-0.011, 0.007], [-0.011, 0.022], [-0.018, 0.022]];
  for (const s of [1, -1] as const) {
    const side = s > 0 ? 'l' : 'r';
    const x = s * rail.x;
    m.extrudePolygon({ points: runner.map(([a, b]): Point2 => [x + a, b]), depth: depth * 0.95, label: piece(`rail-${side}`), material: 'steel' });
    m.translate(by(`${o.name}-rail-${side}`), [0, 0.0005, -depth * 0.475]);
    m.extrudePolygon({ points: roundedRect(0.02, 0.024, 0.004, 2, [x, 0.0245 + 0.012]), depth: depth * 0.42, label: piece(`carriage-${side}`), material: 'trim' });
    m.translate(by(`${o.name}-carriage-${side}`), [0, 0, -depth * 0.25]);
    for (const [k, z] of [-depth * 0.44, depth * 0.44].entries()) {
      const end = k === 0 ? 'rear' : 'front';
      m.cylinder({ radiusTop: 0.011, radiusBottom: 0.011, height: 0.0016, radialSegments: 20, center: [x, 0.0083, z], label: piece(`washer-${side}-${end}`), material: 'steel' });
      m.cylinder({ radiusTop: 0.0075, radiusBottom: 0.0075, height: 0.006, radialSegments: 6, center: [x, 0.0125, z], label: piece(`bolt-${side}-${end}`), material: 'steel' });
    }
  }
  // Release bar under the front lip: a bent tube from rail to rail.
  m.sweep({ profile: ring(0.0055, 10), path: { kind: 'polyline', points: [[rail.x - 0.03, 0.032, depth * 0.42], [rail.x - 0.05, 0.032, depth * 0.5], [-rail.x + 0.05, 0.032, depth * 0.5], [-rail.x + 0.03, 0.032, depth * 0.42]], bend: { radius: 0.02, segments: 4 } }, label: piece('release-bar'), material: 'trim' });

  // Shell: one section swept from the front lip back along the cushion and up the reclined
  // backrest, morphing from the cushion section (bolsters up) through the lumbar and
  // shoulder sections to the headrest; the frame turns with the path, so the bolsters
  // that rise on the cushion face forward on the backrest.
  const section = (half: number, wing: number, dip: number): Point2[] =>
    chaikin([
      [half * 0.9, -shell], [half, -shell * 0.57], [half, wing * 0.7], [half * 0.96, wing], [half * 0.84, wing * 0.95], [half * 0.68, 0.02 + wing * 0.3], [half * 0.55, 0.02 - dip],
      [-half * 0.55, 0.02 - dip], [-half * 0.68, 0.02 + wing * 0.3], [-half * 0.84, wing * 0.95], [-half * 0.96, wing], [-half, wing * 0.7], [-half, -shell * 0.57], [-half * 0.9, -shell],
    ]);
  const head = (half: number): Point2[] => {
    const corners: Point2[] = [[half * 0.9, -shell], [half, -shell * 0.57], [half, 0.03], [half * 0.9, 0.04], [-half * 0.9, 0.04], [-half, 0.03], [-half, -shell * 0.57], [-half * 0.9, -shell]];
    const mid = (p: Point2, q: Point2): Point2 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    return chaikin(corners.flatMap((p, i): Point2[] => [p, mid(p, corners[(i + 1) % corners.length] as Point2)]).slice(0, 14));
  };
  const back = -depth / 2;
  const tilt = (recline * Math.PI) / 180;
  const base: Tuple3 = [0, pan + 0.035, back + 0.06];
  const top: Tuple3 = [0, base[1] + backHeight * Math.cos(tilt), base[2] - backHeight * Math.sin(tilt)];
  m.sweep({
    profile: [section(w * 0.92, bolster * 0.4, 0), section(w, bolster, 0.008), section(w, bolster * 0.9, 0.006), section(w * 0.98, bolster, 0.004), section(w, bolster + 0.05, 0.004), section(w * 0.95, bolster + 0.04, 0.002), head(w * 0.42), head(w * 0.36)],
    path: { kind: 'polyline', points: [[0, pan + 0.03, depth / 2], base, top], bend: { radius: Math.max(0.13, bolster + 0.08), segments: 6 } },
    up: [0, 1, 0],
    segments: 3,
    label: piece('shell'),
    material: 'leather',
  });
  m.assign(by(`${o.name}-shell`).and(sel.facing('-y', 60).or(sel.facing('-z', 60))), 'carbon');
  m.assign(by(`${o.name}-shell`).and(sel.inBox([-w * 0.5, 0, back - 0.4], [w * 0.5, pan + backHeight * 0.75, depth], { by: 'centroid' })).and(sel.facing('+y', 35).or(sel.facing('+z', 35))), 'alcantara');
  m.triangulate(sel.createdBy(`${o.name}-shell`, 'side'));

  // Harness pass-through: a carbon ring proud of the backrest's rear face at shoulder height.
  const shoulder = backHeight * 0.68;
  m.torus({ radius: 0.022, tube: 0.006, radialSegments: 10, tubularSegments: 24, center: [0, 0, 0], label: piece('harness-ring'), material: 'trim' });
  m.rotate(by(`${o.name}-harness-ring`), 'x', -recline);
  m.translate(by(`${o.name}-harness-ring`), [0, base[1] + shoulder * Math.cos(tilt) - 0.045 * Math.sin(tilt), base[2] - shoulder * Math.sin(tilt) - 0.045 * Math.cos(tilt)]);
  return finishDetail(o.name, m, pieces, { width, depth, backHeight, recline, hPointY: pan + 0.055, frontZ: depth / 2, backZ: top[2] - 0.05 });
}

export interface SteeringWheelOptions {
  readonly name: string;
  /** Rim radius at the top (meters). */
  readonly radius?: number;
  /** Flat bottom distance below the center, as a share of the radius. */
  readonly flat?: number;
  /** Rim section thickness, as a share of the radius. */
  readonly grip?: number;
  /** Visible column shroud length behind the hub. */
  readonly column?: number;
}

export const STEERING_RANGES = { radius: [0.15, 0.2], flat: [0.6, 0.95], grip: [0.08, 0.16], column: [0.1, 0.4] } as const;

/**
 * A flat-bottomed wheel in the local XZ plane (12 o'clock along +Z), its column along -Y:
 * leather rim with a top marker band, three carbon spokes, the hub and airbag pad, four
 * spoke buttons and a drive-mode rotary per side, carbon shift paddles, and the column
 * shroud with its stalk pair.
 */
export function steeringWheel(o: SteeringWheelOptions): Result<DetailPart, ModelingError> {
  const r = o.radius ?? 0.175;
  const flatRatio = o.flat ?? 0.82;
  const gripRatio = o.grip ?? 0.12;
  const column = o.column ?? 0.27;
  const checked = ranged({ radius: [r, ...STEERING_RANGES.radius], column: [column, ...STEERING_RANGES.column], flat: [flatRatio, ...STEERING_RANGES.flat], grip: [gripRatio, ...STEERING_RANGES.grip] });
  if (!checked.ok) return checked;
  const flat = r * flatRatio;
  const grip = r * gripRatio;
  const { m, piece, pieces } = detailSession(o.name);

  // Rim path: the circle down to just above the flat chord, then the chord (corners rounded).
  const aFlat = -Math.asin(flat / r);
  const arc: Tuple3[] = [];
  const n = 40;
  const a0 = aFlat + 0.14;
  const a1 = Math.PI - aFlat - 0.14;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    arc.push([r * Math.cos(a), 0, r * Math.sin(a)]);
  }
  const chordX = r * Math.cos(aFlat) * 0.72;
  const rimPath: Tuple3[] = [...arc, [-chordX, 0, -flat], [chordX, 0, -flat]];
  m.sweep({ profile: airfoil(grip * 1.25, 0.8, 6).map(([a, b]): Point2 => [b, a]), path: { kind: 'polyline', points: rimPath, bend: { radius: 0.022, segments: 4 } }, closed: true, up: [0, 1, 0], frame: 'up', label: piece('rim'), material: 'leather' });
  m.assign(by(`${o.name}-rim`).and(sel.inBox([-0.012, -0.05, r - 0.05], [0.012, 0.05, r + 0.05])), 'marker');

  // Spokes: horizontal pair and the lower spoke; ends stop 1 mm short of the rim.
  const inner = r - grip * 0.62;
  const spoke = roundedRect(0.034, 0.012, 0.005, 2);
  for (const s of [1, -1] as const) {
    m.sweep({ profile: spoke, path: [[s * 0.057, -0.004, 0], [s * (inner - 0.03), -0.004, -0.01], [s * (inner - 0.001), -0.004, -0.012]], label: piece(`spoke-${s > 0 ? 'l' : 'r'}`), material: 'carbon' });
  }
  m.sweep({ profile: roundedRect(0.04, 0.012, 0.005, 2), path: [[0, -0.004, -0.045], [0, -0.004, -flat + grip * 0.62 + 0.001]], label: piece('spoke-low'), material: 'carbon' });

  // Hub and airbag pad (revolved about the column axis, Y).
  m.revolve({ points: [[0, -0.05], [0.03, -0.05], [0.042, -0.035], [0.044, -0.012], [0.04, -0.011], [0, -0.011]], segments: 32, label: piece('hub'), material: 'trim' });
  m.extrudePolygon({ points: roundedRect(0.11, 0.085, 0.03, 5), depth: 0.022, label: piece('pad'), material: 'leather' });
  m.rotate(by(`${o.name}-pad`), 'x', -90);
  m.translate(by(`${o.name}-pad`), [0, -0.0105, 0.004]);
  m.bevel(by(`${o.name}-pad`).and(sel.facing('+y', 5)).boundary(), { width: 0.004, segments: 2, label: piece('pad-edge') });
  m.extrudePolygon({ points: [[-0.018, -0.006], [0.018, -0.006], [0.0, 0.012]], depth: 0.0015, label: piece('emblem'), material: 'chrome' });
  m.rotate(by(`${o.name}-emblem`), 'x', -90);
  m.translate(by(`${o.name}-emblem`), [0, 0.0117, 0.01]);

  // Spoke controls: two buttons per spoke and a drive-mode rotary below each, laid out for the rim size.
  const u = Math.min(1, r / 0.175) * Math.min(1, flatRatio / 0.82);
  for (const s of [1, -1] as const) {
    const side = s > 0 ? 'l' : 'r';
    for (const [k, x] of [0.075, 0.105].map((x) => x * Math.min(1, r / 0.175)).entries()) {
      m.cylinder({ radiusTop: 0.0075, radiusBottom: 0.008, height: 0.004, radialSegments: 16, center: [s * x, 0.0045, -0.008], label: piece(`button-${side}-${k}`), material: k === 0 ? 'switch' : 'marker' });
    }
    m.cylinder({ radiusTop: 0.012, radiusBottom: 0.013, height: 0.009, radialSegments: 18, center: [s * 0.08, 0.0025, -0.07 * u], label: piece(`rotary-${side}`), material: 'rim' });
    m.extrudePolygon({ points: [[-0.0015, 0], [0.0015, 0], [0.0015, 0.009], [-0.0015, 0.009]], depth: 0.0015, label: piece(`rotary-${side}-pointer`), material: 'marker' });
    m.rotate(by(`${o.name}-rotary-${side}-pointer`), 'x', -90);
    m.translate(by(`${o.name}-rotary-${side}-pointer`), [s * 0.08, 0.0072, -0.07 * u]);
  }
  // Rotary bosses sit on the lower spoke plane: a carbon pod per side joining them to the hub.
  for (const s of [1, -1] as const) {
    m.extrudePolygon({ points: roundedRect(0.04, 0.034, 0.012, 3, [s * 0.08, 0.068 * u]), depth: 0.008, label: piece(`pod-${s > 0 ? 'l' : 'r'}`), material: 'carbon' });
    m.rotate(by(`${o.name}-pod-${s > 0 ? 'l' : 'r'}`), 'x', -90);
    m.translate(by(`${o.name}-pod-${s > 0 ? 'l' : 'r'}`), [0, -0.0105, 0]);
  }

  // Shift paddles behind the rim, on the column side.
  const paddle: Point2[] = [[0, -0.02], [0.05, -0.028], [0.085, -0.02], [0.095, 0.0], [0.085, 0.02], [0.03, 0.026], [0, 0.016]];
  for (const s of [1, -1] as const) {
    const side = s > 0 ? 'l' : 'r';
    m.extrudePolygon({ points: paddle.map(([a, b]): Point2 => [s * (0.05 + a), b]), depth: 0.004, label: piece(`paddle-${side}`), material: 'carbon' });
    m.rotate(by(`${o.name}-paddle-${side}`), 'x', -90);
    m.translate(by(`${o.name}-paddle-${side}`), [0, -0.058, 0.03]);
  }
  // Column shroud and stalks.
  m.revolve({ points: [[0, -column], [0.048, -column], [0.05, -Math.max(0.085, column - 0.07)], [0.04, -0.08], [0.032, -0.063], [0, -0.063]], segments: 32, label: piece('column'), material: 'trim' });
  for (const s of [1, -1] as const) {
    m.sweep({ profile: ring(0.0045, 10), path: { kind: 'polyline', points: [[s * 0.056, -0.1, 0.0], [s * 0.1, -0.098, 0.004], [s * 0.13, -0.09, 0.006]], bend: { radius: 0.02, segments: 3 } }, label: piece(`stalk-${s > 0 ? 'l' : 'r'}`), material: 'switch' });
  }
  m.triangulate(by(`${o.name}-rim`));
  return finishDetail(o.name, m, pieces, { radius: r, flat, grip, columnLength: column });
}

export interface DashboardOptions {
  readonly name: string;
  /** Width across the cabin. */
  readonly width?: number;
  /** Driver side: +1 when the driver sits at +X. */
  readonly driver?: 1 | -1;
  /** Driver lateral position. */
  readonly driverX?: number;
}

export const DASH_RANGES = { width: [0.9, 1.5], driverX: [0.25, 0.5] } as const;

/** The dash section in (z, y): windshield base at +z, rear lip toward the cabin at z = 0. */
function dashSection(hump: number): Point2[] {
  return chaikin([
    [0.3, -0.16], [0.3, -0.02], [0.24, 0.04], [0.14, 0.08], [0.04, 0.1 + hump * 0.6], [-0.005, 0.1 + hump], [-0.02, 0.085 + hump], [-0.02, 0.06], [0.0, -0.05], [0.07, -0.13], [0.12, -0.16],
  ]);
}

/** The dash's rear face (between the lip and the knee roll), where the vents and display sit. */
export const DASH_FACE = { top: [-0.02, 0.06] as Point2, bottom: [0.0, -0.05] as Point2 } as const;

/**
 * The dashboard, origin at the center of its rear lip line, Z toward the windshield:
 * one lofted body whose sections rise into the driver's instrument binnacle, the
 * instrument display under the binnacle, four hexagonal vents (frame, three vanes and a
 * thumb wheel each), the passenger grab handle, the defrost grille along the windshield
 * edge, and the hazard and start strip across the center.
 */
export function dashboard(o: DashboardOptions): Result<DetailPart, ModelingError> {
  const width = o.width ?? 1.24;
  const driver = o.driver ?? 1;
  const dx = o.driverX ?? Math.min(0.38, width / 2 - 0.12);
  const checked = ranged({ width: [width, ...DASH_RANGES.width], driverX: [dx, DASH_RANGES.driverX[0], Math.min(DASH_RANGES.driverX[1], width / 2 - 0.12)] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const half = width / 2;
  const hood = 0.075;
  const stations: [number, number][] = [[-half, 0], [-half + 0.05, 0]];
  for (let i = 0; i <= 8; i++) {
    const u = -1 + i / 4;
    const x = driver * dx + u * 0.18;
    if (Math.abs(x) < half - 0.08) stations.push([x, hood * (0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, Math.abs(u))))]);
  }
  stations.push([half - 0.05, 0], [half, 0]);
  stations.sort((a, b) => a[0] - b[0]);
  m.loft({ profiles: stations.map(([x, h]) => atX(dashSection(h), x)), match: 'index', label: piece('body'), material: 'leather' });
  m.assign(by(`${o.name}-body`).and(sel.facing('-y', 50)), 'carbon');
  m.triangulate(by(`${o.name}-body`));

  // Instrument display: a curved-glass panel set back under the binnacle hood.
  curvedScreen(m, (f) => piece(`cluster-${f}`), { width: 0.3, height: 0.085, radius: 0.55, material: 'screen' });
  const cluster = by(`${o.name}-cluster-bezel`).or(by(`${o.name}-cluster-screen`));
  m.rotate(cluster, 'x', 12);
  m.translate(cluster, [driver * dx, 0.115, -0.034]);

  // Vents on the rear face: two at the ends, two flanking the center.
  const [fz, fy] = DASH_FACE.top;
  const [gz, gy] = DASH_FACE.bottom;
  const faceTilt = (Math.atan2(gz - fz, fy - gy) * 180) / Math.PI;
  const ventAt = (x: number, k: string) => {
    const t = 0.45;
    const z = fz + (gz - fz) * t - 0.0015;
    const y = fy + (gy - fy) * t;
    const frame = `vent-${k}-frame`;
    m.extrudePolygon({ points: ring(0.045, 6, [0, 0], Math.PI / 6), holes: [ring(0.036, 6, [0, 0], Math.PI / 6)], depth: 0.012, label: piece(frame), material: 'trim' });
    const ids = [by(`${o.name}-${frame}`)];
    for (let v = -1; v <= 1; v++) {
      const vane = `vent-${k}-vane-${v + 1}`;
      m.extrudePolygon({ points: roundedRect(v === 0 ? 0.036 : 0.046, 0.004, 0.0015, 1, [v === 0 ? -0.004 : 0, v * 0.017]), depth: 0.008, label: piece(vane), material: 'trim' });
      ids.push(by(`${o.name}-${vane}`));
    }
    const wheel = `vent-${k}-wheel`;
    m.cylinder({ radiusTop: 0.006, radiusBottom: 0.006, height: 0.01, radialSegments: 12, center: [0.0255, 0.0, 0.004], label: piece(wheel), material: 'chrome' });
    m.rotate(by(`${o.name}-${wheel}`), 'z', 90, [0.0255, 0, 0.004]);
    ids.push(by(`${o.name}-${wheel}`));
    const all = ids.reduce((a, b) => a.or(b));
    // Built facing +Z: turn to face the cabin (-Z) on the tilted rear face, then sink 2 mm proud of it.
    m.rotate(all, 'y', 180);
    m.rotate(all, 'x', -faceTilt);
    m.translate(all, [x, y, z - 0.002]);
  };
  for (const [k, x] of [['l', half - 0.12], ['cl', 0.16], ['cr', -0.16], ['r', -half + 0.12]] as const) ventAt(x, k);

  // Passenger grab handle: a bent bar on the passenger side of the rear face.
  const px = -driver * dx;
  m.sweep({ profile: roundedRect(0.024, 0.014, 0.006, 2), path: { kind: 'polyline', points: [[px - 0.16, -0.035, -0.017], [px - 0.14, -0.06, -0.055], [px + 0.14, -0.06, -0.055], [px + 0.16, -0.035, -0.017]], bend: { radius: 0.03, segments: 4 } }, label: piece('grab-handle'), material: 'alcantara' });

  // Defrost grille: slots along the windshield edge of the top surface.
  const slots: Point2[][] = [];
  for (let i = 0; i < 18; i++) slots.push(roundedRect(0.012, 0.004, 0.0015, 1, [-0.32 + (0.64 * i) / 17, 0]));
  m.extrudePolygon({ points: roundedRect(0.7, 0.024, 0.008, 3), holes: slots, depth: 0.004, label: piece('defrost'), material: 'trim' });
  m.rotate(by(`${o.name}-defrost`), 'x', -90);
  m.rotate(by(`${o.name}-defrost`), 'x', -Math.atan2(0.04 - -0.02, 0.24 - 0.3) * (180 / Math.PI) - 180);
  m.translate(by(`${o.name}-defrost`), [0, 0.012, 0.27]);
  return finishDetail(o.name, m, pieces, { width, driverX: driver * dx, height: 0.26, depth: 0.32 });
}

export interface ConsoleOptions {
  readonly name: string;
  /** Length from the dash (z = 0) back between the seats. */
  readonly length?: number;
  /** Clear channel half-width under the console (the stowed core passes through it). */
  readonly channel?: number;
  /** Clear channel height under the console top. */
  readonly clearance?: number;
}

export const CONSOLE_RANGES = { length: [0.75, 1.1], channel: [0.06, 0.16], clearance: [0.04, 0.3] } as const;

/**
 * The center console as a bridge over a clear channel (origin on the channel floor at the
 * dash, Z forward, the console running back along -Z): two carbon side walls under a
 * leather-topped deck, the touch display on its raked front face, a switch panel of eight
 * guarded toggle switches with the red flip cover over the start button, the gear-mode
 * keys and two rotary dials, and the armrest with its stitched cushion.
 */
export function centerConsole(o: ConsoleOptions): Result<DetailPart, ModelingError> {
  const length = o.length ?? 0.92;
  const channel = o.channel ?? 0.12;
  const clearance = o.clearance ?? 0.24;
  const checked = ranged({ length: [length, ...CONSOLE_RANGES.length], channel: [channel, ...CONSOLE_RANGES.channel], clearance: [clearance, ...CONSOLE_RANGES.clearance] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const wall = 0.014;
  const out = channel + wall;
  const top = clearance + 0.018;

  // Bridge: an inverted U swept back from the dash.
  // Sculpted bridge: the outer side bulges out at mid height and rolls into a rounded
  // deck shoulder; the waist narrows behind the switch panel and the armrest end flares.
  // The channel underneath stays a clean rectangle.
  const bridge = (bulge: number, drop: number): Point2[] => {
    const side = (s: 1 | -1): Point2[] => {
      const chain = chaikinOpen([[s * out, 0], [s * (out + bulge), clearance * 0.45], [s * (out + bulge * 0.6), clearance - 0.01], [s * (out - 0.004), top - 0.006 - drop], [s * (out - 0.035), top - drop], [0, top - drop]], 3);
      return s > 0 ? chain : [...chain].reverse();
    };
    const right = side(1);
    const left = side(-1);
    return [...right.slice(0, -1), ...left, [-channel, 0], [-channel, clearance + 0.002], [channel, clearance + 0.002], [channel, 0]];
  };
  const stations: [number, number, number][] = [[-0.02, 0.012, 0], [-0.2, 0.01, 0], [-(0.2 + (length - 0.26) * 0.5), 0.002, 0], [-length + 0.2, 0.012, 0], [-length + 0.04, 0.012, 0.003], [-length, 0.006, 0.007]];
  m.loft({ profiles: stations.map(([z, bulge, drop]) => atZ(bridge(bulge, drop), z)), match: 'index', segments: 2, label: piece('bridge'), material: 'carbon' });
  m.assign(by(`${o.name}-bridge`).and(sel.facing('+y', 35)), 'leather');
  m.triangulate(by(`${o.name}-bridge`));
  // Raked display at the front, on a stand on the deck.
  m.extrudePolygon({ points: [[-0.08, 0], [0.08, 0], [0.06, 0.08], [-0.06, 0.08]], depth: 0.05, label: piece('display-stand'), material: 'trim' });
  m.translate(by(`${o.name}-display-stand`), [0, top + 0.001, -0.12]);
  curvedScreen(m, (f) => piece(`display-${f}`), { width: 0.2, height: 0.12, radius: 0.45, material: 'screen' });
  const display = by(`${o.name}-display-bezel`).or(by(`${o.name}-display-screen`));
  m.rotate(display, 'x', -60);
  m.translate(display, [0, top + 0.128, -0.15]);

  // Switch panel: plate with eight guarded toggles and the start button under its flip cover.
  const plateZ = -0.3;
  const plateY = top + 0.0025;
  m.extrudePolygon({ points: roundedRect(2 * out - 0.03, 0.15, 0.01, 3), depth: 0.004, label: piece('switch-plate'), material: 'trim' });
  m.rotate(by(`${o.name}-switch-plate`), 'x', -90);
  m.translate(by(`${o.name}-switch-plate`), [0, plateY - 0.002, plateZ]);
  const deck = plateY + 0.0025;
  for (let i = 0; i < 8; i++) {
    const x = -0.075 + (0.15 * (i % 4)) / 3;
    const z = plateZ + (i < 4 ? 0.045 : -0.045);
    const k = String(i);
    m.cylinder({ radiusTop: 0.006, radiusBottom: 0.0075, height: 0.008, radialSegments: 12, center: [x, deck + 0.0045, z], label: piece(`toggle-${k}-boss`), material: 'chrome' });
    m.sweep({ profile: ring(0.0022, 8), path: [[x, deck + 0.0095, z], [x, deck + 0.016, z], [x, deck + 0.027, z + 0.009]], label: piece(`toggle-${k}-lever`), material: 'chrome' });
    m.extrudePolygon({ points: [[-0.012, 0], [0.012, 0], [0.012, 0.016], [0.009, 0.016], [0.009, 0.003], [-0.009, 0.003], [-0.009, 0.016], [-0.012, 0.016]], depth: 0.003, label: piece(`toggle-${k}-guard`), material: 'trim' });
    m.translate(by(`${o.name}-toggle-${k}-guard`), [x, deck + 0.0005, z - 0.018]);
  }
  // Start button: chrome bezel, red cap, and the red flip cover hinged open at 60 degrees.
  m.cylinder({ radiusTop: 0.016, radiusBottom: 0.017, height: 0.006, radialSegments: 24, center: [0, deck + 0.0035, plateZ], label: piece('start-bezel'), material: 'chrome' });
  m.cylinder({ radiusTop: 0.011, radiusBottom: 0.011, height: 0.004, radialSegments: 24, center: [0, deck + 0.009, plateZ], label: piece('start-button'), material: 'red' });
  m.extrudePolygon({ points: roundedRect(0.036, 0.036, 0.008, 3), holes: [roundedRect(0.03, 0.03, 0.006, 3)], depth: 0.012, label: piece('start-cover'), material: 'red' });
  m.rotate(by(`${o.name}-start-cover`), 'x', -90);
  m.rotate(by(`${o.name}-start-cover`), 'x', -60, [0, 0, -0.018]);
  m.translate(by(`${o.name}-start-cover`), [0, deck + 0.0015, plateZ]);
  for (const s of [1, -1] as const) {
    m.cylinder({ radiusTop: 0.003, radiusBottom: 0.003, height: 0.005, radialSegments: 10, center: [0, 0, 0], label: piece(`start-hinge-${s > 0 ? 'l' : 'r'}`), material: 'chrome' });
    m.rotate(by(`${o.name}-start-hinge-${s > 0 ? 'l' : 'r'}`), 'z', 90);
    m.translate(by(`${o.name}-start-hinge-${s > 0 ? 'l' : 'r'}`), [s * 0.0215, deck + 0.0035, plateZ - 0.018]);
  }

  // Gear keys and dials behind the switch panel.
  for (const [k, x] of [['p', -0.06], ['n', -0.02], ['r', 0.02], ['m', 0.06]] as const) {
    m.extrudePolygon({ points: roundedRect(0.032, 0.022, 0.005, 2), depth: 0.008, label: piece(`key-${k}`), material: k === 'r' ? 'marker' : 'switch' });
    m.rotate(by(`${o.name}-key-${k}`), 'x', -90);
    m.translate(by(`${o.name}-key-${k}`), [x, top + 0.0005, -0.43]);
  }
  for (const [k, x] of [['l', 0.05], ['r', -0.05]] as const) {
    m.cylinder({ radiusTop: 0.018, radiusBottom: 0.02, height: 0.016, radialSegments: 24, center: [x, top + 0.0085, -0.5], label: piece(`dial-${k}`), material: 'rim' });
  }
  // Armrest cushion.
  // The armrest takes what the switch panel, keys and dials leave at the rear.
  const armrest = Math.min(0.22, length - 0.59);
  m.extrudePolygon({ points: roundedRect(2 * out - 0.02, armrest, 0.03, 4), depth: 0.03, label: piece('armrest'), material: 'leather' });
  m.rotate(by(`${o.name}-armrest`), 'x', -90);
  m.translate(by(`${o.name}-armrest`), [0, top + 0.001, -length + 0.06 + armrest / 2]);
  m.bevel(by(`${o.name}-armrest`).and(sel.facing('+y', 5)).boundary(), { width: 0.008, segments: 2, label: piece('armrest-roll') });
  return finishDetail(o.name, m, pieces, { length, channel, clearance, top: top + 0.05 });
}

export interface PedalBoxOptions {
  readonly name: string;
}

/**
 * Pedal box, origin on the footwell floor under the brake pedal, Z forward: a hinged
 * mounting rail (over the v3 torso frame's chest uprights in car form) with three pedal arms (throttle hanging from the top, a wide brake, the
 * footrest) and drilled alloy pads.
 */
export function pedalBox(o: PedalBoxOptions): Result<DetailPart, ModelingError> {
  const { m, piece, pieces } = detailSession(o.name);
  const top = 0.265;
  m.sweep({ profile: roundedRect(0.024, 0.03, 0.006, 2), path: [[-0.17, top, 0.08], [0.15, top, 0.08]], label: piece('rail'), material: 'steel' });
  const pedal = (k: string, x: number, padW: number, padH: number, foot: Tuple3) => {
    m.sweep({ profile: roundedRect(0.016, 0.008, 0.003, 1), path: { kind: 'polyline', points: [[x, top - 0.017, 0.08], [x, top - 0.08, 0.05], [foot[0], foot[1] + padH / 2 + 0.002, foot[2] + 0.012]], bend: { radius: 0.03, segments: 3 } }, label: piece(`${k}-arm`), material: 'steel' });
    const holes = Array.from({ length: 3 }, (_, i) => ring(0.006, 10, [0, -padH / 2 + (padH * (i + 1)) / 4]));
    m.extrudePolygon({ points: roundedRect(padW, padH, 0.01, 3), holes, depth: 0.006, label: piece(`${k}-pad`), material: 'rim' });
    m.rotate(by(`${o.name}-${k}-pad`), 'x', -20);
    m.translate(by(`${o.name}-${k}-pad`), foot);
  };
  pedal('brake', 0, 0.09, 0.07, [0, 0.07, 0.008]);
  pedal('throttle', 0.11, 0.05, 0.12, [0.11, 0.07, 0.02]);
  m.extrudePolygon({ points: roundedRect(0.08, 0.16, 0.01, 3), holes: [ring(0.008, 10, [0, -0.04]), ring(0.008, 10, [0, 0]), ring(0.008, 10, [0, 0.04])], depth: 0.006, label: piece('footrest'), material: 'rim' });
  m.rotate(by(`${o.name}-footrest`), 'x', -50);
  m.translate(by(`${o.name}-footrest`), [-0.14, 0.066, 0.03]);
  return finishDetail(o.name, m, pieces, { railY: top });
}
