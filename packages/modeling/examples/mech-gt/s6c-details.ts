import type { Result } from '@forgeax/engine-types';
import { type ModelingError, type Point2, recipes, sel, type Tuple3 } from '@forgeax/engine-modeling';
import type { StencilSpec } from './s6b-paint.ts';
import { airfoil, by, chaikin, type DetailPart, detailSession, edgeDistance2, ellipse, finishDetail, hexCells, inside2, inset2, ranged, ring, roundedRect, spanAt, stencilOn } from './s6c-kit.ts';

/**
 * Case C-100 stage S6c (code name mech-gt): the exterior detail recipes. Each is
 * parametric and car-agnostic and built in its anchor frame: X along the mount's long
 * axis, Y out of the body surface, Z = X x Y. Openings (lamps, intakes) take their
 * outline in the frame's XZ plane as `[x, z]` points; their internals sink along -Y.
 */

export interface LampOptions {
  readonly name: string;
  /** Opening outline `[x, z]` (convex), the lens rim. */
  readonly outline: readonly Point2[];
  /** Cavity depth behind the lens. */
  readonly depth: number;
  /** Projector modules along X (head lamps), 0 for a tail lamp. */
  readonly projectors?: number;
  /** Light-guide signature: the Y of the head lamps, the hexagon strokes of the tail lamps. */
  readonly signature: 'y' | 'hex';
  /** Slot of the light guides and LEDs. */
  readonly light: string;
  /** Add the clear outer lens (off when the body supplies it). */
  readonly lens?: boolean;
}

export const LAMP_RANGES = { depth: [0.06, 0.25], projectors: [0, 4] } as const;

/**
 * A lamp cavity: the housing wall around the opening, its back plate, a bezel ring
 * inside the rim, projector modules (reflector bowl, condenser lens and retaining ring
 * each), the light-guide signature as swept strokes, a row of LED chips on the back
 * plate, and optionally the clear outer lens.
 */
export function lampCavity(o: LampOptions): Result<DetailPart, ModelingError> {
  const projectors = o.projectors ?? 0;
  const checked = ranged({ depth: [o.depth, ...LAMP_RANGES.depth], projectors: [projectors, ...LAMP_RANGES.projectors] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const wall = 0.003;
  const rim = [...o.outline];
  const hole = inset2(rim, wall);
  const xs = rim.map((p) => p[0]);
  const zs = rim.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const sink = (label: string) => m.rotate(by(label), 'x', 90);

  // Housing wall (open toward the lens), back plate, and a bezel ring just inside the rim.
  m.extrudePolygon({ points: rim, holes: [hole], depth: o.depth, label: piece('housing'), material: 'trim' });
  sink(`${o.name}-housing`);
  m.extrudePolygon({ points: inset2(rim, wall + 0.0008), depth: 0.003, label: piece('back'), material: 'trim' });
  sink(`${o.name}-back`);
  m.translate(by(`${o.name}-back`), [0, -o.depth + 0.003, 0]);
  m.extrudePolygon({ points: inset2(rim, wall + 0.0008), holes: [inset2(rim, wall + 0.009)], depth: 0.012, label: piece('bezel'), material: 'chrome' });
  sink(`${o.name}-bezel`);
  m.translate(by(`${o.name}-bezel`), [0, -0.004, 0]);

  // Projectors: bowls on the back plate, each with its lens and retaining ring, facing +Y.
  const back = -o.depth + 0.0035;
  const zc = (z0 + z1) / 2;
  const span = x1 - x0;
  const pr0 = Math.min((z1 - z0) * 0.32, span / (2 * projectors + 2) - 0.008);
  // Bowls stop where their lenses would reach the light guides (8 mm behind the bezel).
  const bowlDepth = Math.min(o.depth * 0.45, o.depth - 0.058);
  const housingRoom = inset2(rim, wall + 0.002);
  const zSpan = (x: number): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < housingRoom.length; i++) {
      const a = housingRoom[i] as Point2;
      const b = housingRoom[(i + 1) % housingRoom.length] as Point2;
      if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
      const z = a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
    return [lo, hi];
  };
  for (let i = 0; i < projectors; i++) {
    const cx = x0 + (span * (i + 1)) / (projectors + 1);
    const k = String(i);
    // Center each module in the cavity's height at its station, sized to fit with the ring.
    const [lo, hi] = [Math.max(zSpan(cx - pr0)[0], zSpan(cx + pr0)[0]), Math.min(zSpan(cx - pr0)[1], zSpan(cx + pr0)[1])];
    const zc = (lo + hi) / 2;
    const pr = Math.min(pr0, (hi - lo) / 2 - 0.003);
    if (pr < 0.012 || bowlDepth < 0.01) continue;
    const cup: Point2[] = [];
    for (let j = 0; j <= 8; j++) {
      const t = j / 8;
      cup.push([pr * t, back + 0.002 + bowlDepth * t * t]);
    }
    const outer = cup.map(([r, y]): Point2 => [r, y]);
    const innerCup = [...cup].reverse().map(([r, y]): Point2 => [Math.max(0, r - 0.0025), y + 0.0025]);
    m.revolve({ points: [...outer, ...innerCup.filter(([r]) => r > 0.0005), [0, back + 0.0045]], segments: 32, label: piece(`bowl-${k}`), material: 'chrome' });
    m.translate(by(`${o.name}-bowl-${k}`), [cx, 0, zc]);
    const lensY = back + 0.002 + bowlDepth + 0.004;
    m.revolve({ points: [[0, lensY - 0.002], [pr * 0.55, lensY - 0.002], [pr * 0.58, lensY + 0.004], [pr * 0.4, lensY + 0.012], [0, lensY + 0.015]], segments: 32, label: piece(`lens-${k}`), material: 'glass' });
    m.translate(by(`${o.name}-lens-${k}`), [cx, 0, zc]);
    m.torus({ radius: pr * 0.58 + 0.004, tube: 0.0025, radialSegments: 8, tubularSegments: 32, label: piece(`ring-${k}`), material: 'chrome' });
    m.rotate(by(`${o.name}-ring-${k}`), 'x', 90);
    m.translate(by(`${o.name}-ring-${k}`), [cx, lensY + 0.002, zc]);
  }

  // Light-guide signature, 8 mm off the back plate.
  const gy = -0.022;
  const stroke = roundedRect(0.006, 0.006, 0.002, 1);
  const strokes: Tuple3[][] = [];
  const cxAll = (x0 + x1) / 2;
  const ix0 = x0 + 0.02;
  const ix1 = x1 - 0.02;
  if (o.signature === 'y') {
    const mx = ix0 + (ix1 - ix0) * 0.62;
    strokes.push([[ix0, gy, zc + (z1 - zc) * 0.55], [mx, gy, zc]], [[mx + 0.004, gy, zc], [ix1, gy, zc]], [[ix0, gy, zc - (zc - z0) * 0.55], [mx - 0.006, gy, zc - 0.006]]);
  } else {
    const hx = (ix1 - ix0) / 3.2;
    for (let i = 0; i < 3; i++) {
      const cx = ix0 + hx * (0.6 + i * 1.05);
      const hexR = Math.min(hx * 0.48, (z1 - z0) * 0.32);
      const pts = ring(hexR, 6, [cx, zc], Math.PI / 6).map(([x, z]): Tuple3 => [x, gy, z]);
      // Three edges of each hexagon as separate straight strokes, trimmed clear of each other.
      for (let e = 0; e < 3; e++) {
        const p = pts[e] as Tuple3;
        const q = pts[e + 1] as Tuple3;
        const f = 0.009 / Math.hypot(q[0] - p[0], q[2] - p[2]);
        strokes.push([[p[0] + (q[0] - p[0]) * f, gy, p[2] + (q[2] - p[2]) * f], [q[0] - (q[0] - p[0]) * f, gy, q[2] - (q[2] - p[2]) * f]]);
      }
    }
  }
  const room = inset2(rim, wall + 0.003);
  const fits = (x: number, z: number, margin: number) => inside2([x, z], room) && edgeDistance2([x, z], room) >= margin;
  const pull = (p: Tuple3): Tuple3 => {
    let q = p;
    for (let k = 0; k < 20 && !fits(q[0], q[2], 0.006); k++) q = [q[0] + (cxAll - q[0]) * 0.12, q[1], q[2] + (zc - q[2]) * 0.12];
    return q;
  };
  for (const [k, raw] of strokes.entries()) {
    const path = raw.map(pull);
    m.sweep({ profile: stroke, path: { kind: 'polyline', points: path, ...(o.signature === 'y' ? { bend: { radius: 0.004, segments: 2 } } : {}) }, up: [0, 1, 0], frame: 'up', label: piece(`guide-${k}`), material: o.light });
  }

  // LED chips along the lower edge of the back plate.
  const chips = Math.max(4, Math.floor((ix1 - ix0) / 0.018));
  for (let i = 0; i < chips; i++) {
    const cx = ix0 + ((ix1 - ix0) * (i + 0.5)) / chips;
    const cz = z0 + (zc - z0) * 0.35;
    if (![[-0.004, -0.0025], [0.004, -0.0025], [0.004, 0.0025], [-0.004, 0.0025]].every(([a, b]) => fits(cx + (a as number), cz + (b as number), 0.001))) continue;
    m.extrudePolygon({ points: roundedRect(0.008, 0.005, 0.0012, 1, [cx, cz]), depth: 0.002, label: piece(`led-${i}`), material: o.light });
    sink(`${o.name}-led-${i}`);
    m.translate(by(`${o.name}-led-${i}`), [0, back + 0.0025, 0]);
  }
  if (o.lens === true) {
    m.extrudePolygon({ points: rim, depth: 0.003, label: piece('cover'), material: 'glass' });
    sink(`${o.name}-cover`);
    m.translate(by(`${o.name}-cover`), [0, 0.0035, 0]);
  }
  return finishDetail(o.name, m, pieces, { depth: o.depth, projectors, width: span, height: z1 - z0 });
}

export interface IntakeMeshOptions {
  readonly name: string;
  readonly outline: readonly Point2[];
  /** Hex cell pitch (center to center). */
  readonly pitch?: number;
  /** Web between cells, as a share of the pitch. */
  readonly web?: number;
  /** Mesh recess behind the frame. */
  readonly recess?: number;
}

export const MESH_RANGES = { pitch: [0.008, 0.06], web: [0.1, 0.4], recess: [0.004, 0.08] } as const;

/** An intake grille: a carbon frame around the opening, a recessed hexagonal mesh plate behind it and the dark duct floor behind that, with a mounting stud at each end when the recess allows. */
export function intakeMesh(o: IntakeMeshOptions): Result<DetailPart, ModelingError> {
  const pitch = o.pitch ?? 0.022;
  const webShare = o.web ?? 0.2;
  const recess = o.recess ?? 0.015;
  const checked = ranged({ pitch: [pitch, ...MESH_RANGES.pitch], web: [webShare, ...MESH_RANGES.web], recess: [recess, ...MESH_RANGES.recess] });
  if (!checked.ok) return checked;
  const web = pitch * webShare;
  const { m, piece, pieces } = detailSession(o.name);
  const frameW = 0.008;
  const rim = [...o.outline];
  const inner = inset2(rim, frameW);
  m.extrudePolygon({ points: rim, holes: [inner], depth: 0.012, label: piece('frame'), material: 'carbon' });
  m.rotate(by(`${o.name}-frame`), 'x', 90);
  m.translate(by(`${o.name}-frame`), [0, 0.004, 0]);
  const plate = inset2(rim, frameW + 0.001);
  const cells = hexCells(plate, pitch, web, web);
  m.extrudePolygon({ points: plate, holes: cells, depth: 0.004, label: piece('mesh'), material: 'mesh' });
  m.rotate(by(`${o.name}-mesh`), 'x', 90);
  m.translate(by(`${o.name}-mesh`), [0, -recess, 0]);
  // Duct floor behind the mesh: the dark back of the intake seen through the cells.
  m.extrudePolygon({ points: plate, depth: 0.003, label: piece('duct'), material: 'mesh' });
  m.rotate(by(`${o.name}-duct`), 'x', 90);
  m.translate(by(`${o.name}-duct`), [0, -recess - 0.012, 0]);
  const z = plate.reduce((s, p) => s + p[1], 0) / plate.length;
  const [sx0, sx1] = spanAt(inset2(plate, 0.004), 1, z);
  for (const [k, x] of (recess >= 0.012 ? [sx0 + 0.003, sx1 - 0.003] : []).entries()) {
    m.cylinder({ radiusTop: 0.0025, radiusBottom: 0.0025, height: recess - 0.0085, radialSegments: 10, center: [x, -recess + 0.004 + (recess - 0.0085) / 2 + 0.0002, z], label: piece(`stud-${k}`), material: 'steel' });
  }
  return finishDetail(o.name, m, pieces, { cells: cells.length, pitch, web, recess });
}

/** The x intervals inside a closed outline along the line z = `z` (even-odd pairing of the crossings). */
function intervalsAt(poly: readonly Point2[], z: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Point2;
    const b = poly[(i + 1) % poly.length] as Point2;
    if (a[1] === b[1] || (a[1] - z) * (b[1] - z) > 0 || Math.min(a[1], b[1]) === z) continue;
    xs.push(a[0] + ((z - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < xs.length; k += 2) out.push([xs[k] as number, xs[k + 1] as number]);
  return out;
}

/** The common part of several interval sets. */
function intersectIntervals(sets: readonly (readonly [number, number][])[]): [number, number][] {
  let acc: [number, number][] = [...(sets[0] ?? [])];
  for (const set of sets.slice(1)) {
    const next: [number, number][] = [];
    for (const [a, b] of acc) for (const [c, d] of set) if (Math.min(b, d) > Math.max(a, c)) next.push([Math.max(a, c), Math.min(b, d)]);
    acc = next;
  }
  return acc;
}

export interface VaneOptions {
  readonly name: string;
  readonly outline: readonly Point2[];
  readonly count?: number;
  /** Vane chord into the opening. */
  readonly chord?: number;
  /** Vane angle about X, degrees. */
  readonly angle?: number;
}

export const VANE_RANGES = { count: [2, 12], chord: [0.02, 0.15], angle: [-40, 40] } as const;

/** Intake vanes: airfoil louvers spanning the opening along X, stacked along Z (split where a concave opening splits a row), inside a lip that follows the rim. */
export function intakeVanes(o: VaneOptions): Result<DetailPart, ModelingError> {
  const count = o.count ?? 5;
  const chord = o.chord ?? 0.06;
  const angle = o.angle ?? 15;
  const checked = ranged({ count: [count, ...VANE_RANGES.count], chord: [chord, ...VANE_RANGES.chord], angle: [angle, ...VANE_RANGES.angle] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const rim = [...o.outline];
  const zs = rim.map((p) => p[1]);
  const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
  const pitch = (z1 - z0) / count;
  // Neighbouring vanes keep 2 mm between them: a dense stack takes a shorter chord.
  const tilt = (Math.abs(angle) * Math.PI) / 180;
  const fit = Math.min(chord, (pitch - 0.002) / (Math.sin(tilt) + 0.14 * Math.cos(tilt)));
  const foil = airfoil(fit, 0.14, 8).map(([a, b]): Point2 => [b, a]);
  const reachZ = (fit / 2) * Math.sin(tilt) + fit * 0.08;
  // Concave openings: each row keeps the x intervals inside the outline at its top, middle
  // and bottom, 8 mm in from the rim; every interval wide enough gets its own vane.
  const margin = 0.008;
  for (let i = 0; i < count; i++) {
    const z = z0 + pitch * (i + 0.5);
    if (z - reachZ < z0 + 0.005 || z + reachZ > z1 - 0.005) continue;
    // Every 2 mm across the vane's height (plus 6 mm each side), and at every rim corner in
    // that band, so a sharp tip between sample lines still splits the row.
    const band: number[] = [];
    for (let h = z - reachZ - 0.006; h <= z + reachZ + 0.006; h += 0.002) band.push(h);
    for (const [, cz] of rim) if (Math.abs(cz - z) <= reachZ + 0.006) band.push(cz + 1e-6, cz - 1e-6);
    const rows = band.map((h) => intervalsAt(rim, h));
    const spans = intersectIntervals(rows).map(([a, b]): [number, number] => [a + margin, b - margin]).filter(([a, b]) => b - a >= 0.03);
    // Sharp tips of the outline slant across a vane's height: pull each end in until its
    // corners keep 6 mm to the rim.
    const clear = (x: number) => [z - reachZ - 0.003, z + reachZ + 0.003].every((h) => inside2([x, h], rim) && edgeDistance2([x, h], rim) >= 0.006);
    const fitted = spans
      .map(([a0, b0]): [number, number] => {
        let [a, b] = [a0, b0];
        while (b - a >= 0.03 && !clear(a)) a += 0.002;
        while (b - a >= 0.03 && !clear(b)) b -= 0.002;
        return [a, b];
      })
      .filter(([a, b]) => b - a >= 0.03);
    for (const [j, [lo, hi]] of fitted.entries()) {
      const label = piece(fitted.length === 1 ? `vane-${i}` : `vane-${i}-${j}`);
      m.sweep({ profile: foil, path: [[lo, -fit / 2 - 0.002, z], [hi, -fit / 2 - 0.002, z]], up: [0, 1, 0], frame: 'up', label, material: 'carbon' });
      m.rotate(by(label), 'x', angle, [0, -fit / 2 - 0.002, z]);
    }
  }
  // Surround: a 4 mm lip following the rim (concave outlines included), as deep as the vanes.
  const depthY = chord + 0.01;
  m.sweep({ profile: roundedRect(0.004, depthY, 0.0015, 1), path: rim.map(([x, z]): Tuple3 => [x, 0.002 - depthY / 2, z]), closed: true, up: [0, 1, 0], frame: 'up', label: piece('surround'), material: 'carbon' });
  return finishDetail(o.name, m, pieces, { count, chord, angle, pitch });
}

export interface MirrorOptions {
  readonly name: string;
  /** Stalk reach from the door skin to the housing. */
  readonly reach?: number;
  /** Housing width (outward) and height. */
  readonly width?: number;
  readonly height?: number;
  /** Housing center ahead of the base (the stalk sweeps forward to it). */
  readonly forward?: number;
  /** Housing center height above the base. */
  readonly lift?: number;
  /** Housing length along the car, glass face to nose. */
  readonly length?: number;
}

export const MIRROR_RANGES = { reach: [0.06, 0.2], width: [0.12, 0.26], height: [0.05, 0.12], forward: [0.08, 0.25], lift: [0.04, 0.1], length: [0.1, 0.26] } as const;

/**
 * A door mirror, X forward along the car, Y outward from the door skin, Z up: a base
 * plate on the skin, an airfoil stalk curving out and up, a lofted aero housing whose rear
 * face holds the glass in a bezel, and an amber repeater lens under the housing.
 */
export function doorMirror(o: MirrorOptions): Result<DetailPart, ModelingError> {
  const reach = o.reach ?? 0.11;
  const hw = o.width ?? 0.19;
  const hh = o.height ?? 0.085;
  const fwd = o.forward ?? 0.08;
  const top = o.lift ?? 0.045;
  const len = o.length ?? 0.105;
  const checked = ranged({ reach: [reach, ...MIRROR_RANGES.reach], width: [hw, ...MIRROR_RANGES.width], height: [hh, ...MIRROR_RANGES.height], forward: [fwd, ...MIRROR_RANGES.forward], lift: [top, ...MIRROR_RANGES.lift], length: [len, ...MIRROR_RANGES.length] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  // Base plate, flush on the skin (local y from 0 up).
  m.extrudePolygon({ points: chaikin(roundedRect(0.11, 0.05, 0.02, 2), 1), depth: 0.008, label: piece('base'), material: 'paint' });
  m.rotate(by(`${o.name}-base`), 'x', -90);
  m.bevel(by(`${o.name}-base`).and(sel.facing('+y', 5)).boundary(), { width: 0.003, segments: 2, label: piece('base-edge') });
  // Stalk: airfoil section, out, up and (with `forward`) swept ahead to the housing.
  const ys = (f: number) => 0.02 + f * (reach - 0.035);
  m.sweep({ profile: airfoil(0.044, 0.28, 8).map(([a, b]): Point2 => [b, a]), path: { kind: 'catmullRom', points: [[0.01, 0.02, 0], [0.008 + fwd * 0.15, ys(0.25), top * 0.1], [fwd * 0.6, ys(0.65), top * 0.55], [fwd - 0.02, reach - 0.022, top]], segments: 8 }, up: [0, 0, 1], frame: 'up', label: piece('stalk'), material: 'carbon' });
  // Housing: D sections in XZ (flat glass face toward -X) lofted outward along Y.
  const dCorners: Point2[] = [[-0.03, -hh / 2], [0.02, -hh / 2], [0.07, -hh * 0.2], [0.075, hh * 0.15], [0.03, hh / 2], [-0.03, hh / 2]];
  const stretch = len / 0.105;
  const d = (s: number): Point2[] => chaikin(dCorners.map(([x, z]): Point2 => [-0.03 + (x + 0.03) * stretch * s, z * s]), 2);
  const y0 = reach + 0.0008;
  const stations: [number, number][] = [[y0, 0.55], [y0 + 0.02, 0.92], [y0 + hw * 0.5, 1], [y0 + hw - 0.025, 0.95], [y0 + hw, 0.6]];
  m.loft({ profiles: stations.map(([y, s]) => d(s).map(([x, z]): Tuple3 => [x - 0.02 + fwd, y, z + top])), segments: 2, label: piece('housing'), material: 'paint' });
  m.assign(by(`${o.name}-housing`).and(sel.facing('-x', 30)), 'carbon');
  m.triangulate(sel.createdBy(`${o.name}-housing`));
  // Glass and its bezel, 1 mm proud of the flat rear face (x = -0.05).
  const gy = y0 + hw * 0.5;
  const glassOutline = roundedRect(hw * 0.7, hh * 0.68, 0.012, 3);
  m.extrudePolygon({ points: roundedRect(hw * 0.76, hh * 0.76, 0.015, 3), holes: [glassOutline], depth: 0.004, label: piece('bezel'), material: 'trim' });
  m.extrudePolygon({ points: inset2(glassOutline, 0.0006), depth: 0.002, label: piece('glass'), material: 'chrome' });
  for (const label of [`${o.name}-bezel`, `${o.name}-glass`]) {
    m.rotate(by(label), 'y', -90);
    m.translate(by(label), [-0.051 + fwd, gy, top]);
  }
  // Repeater: a slim amber lens under the housing's flat floor.
  m.extrudePolygon({ points: roundedRect(hw * 0.5, 0.008, 0.003, 2), depth: 0.003, label: piece('repeater'), material: 'amber' });
  m.rotate(by(`${o.name}-repeater`), 'z', 90);
  m.translate(by(`${o.name}-repeater`), [-0.03 + fwd, gy, top - hh / 2 - 0.0045]);
  return finishDetail(o.name, m, pieces, { reach, housingWidth: hw, housingHeight: hh, forward: fwd, lift: top, length: len });
}

export interface WiperOptions {
  readonly name: string;
  readonly arm?: number;
  readonly blade?: number;
}

export const WIPER_RANGES = { arm: [0.3, 0.7], blade: [0.35, 0.75] } as const;

/**
 * A wiper parked along X from its pivot (the origin, on the cowl, Y off the glass): a
 * domed pivot nut with its spindle collar, the spring housing, a pressed arm, the clip,
 * an aero blade with its spoiler and the rubber squeegee.
 */
export function wiper(o: WiperOptions): Result<DetailPart, ModelingError> {
  const arm = o.arm ?? 0.5;
  // The parked blade clears the pivot and spring housing: half of it reaches at most to 0.11 m from the pivot.
  const blade = o.blade ?? Math.min(0.6, 2 * arm - 0.18);
  const checked = ranged({ arm: [arm, ...WIPER_RANGES.arm], blade: [blade, WIPER_RANGES.blade[0], Math.min(WIPER_RANGES.blade[1], 2 * arm - 0.18)] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  m.revolve({ points: [[0, 0], [0.016, 0], [0.016, 0.006], [0.011, 0.012], [0, 0.014]], segments: 24, label: piece('collar'), material: 'trim' });
  m.revolve({ points: [[0, 0.0145], [0.009, 0.0145], [0.009, 0.019], [0.006, 0.023], [0, 0.024]], segments: 6, label: piece('nut'), material: 'steel' });
  // Spring housing: a tapered channel from the pivot.
  m.loft({ profiles: [0.0, 0.07].map((x, k) => roundedRect(k === 0 ? 0.026 : 0.018, k === 0 ? 0.02 : 0.014, 0.005, 2, [0, 0]).map(([z, y]): Tuple3 => [x + 0.019, y + 0.016, z])), label: piece('spring-housing'), material: 'trim' });
  // Arm: a slim pressed section arching just over the blade line, ending at the clip.
  const end: Tuple3 = [arm, 0.03, 0];
  m.sweep({ profile: roundedRect(0.012, 0.006, 0.002, 1), path: { kind: 'catmullRom', points: [[0.0905, 0.016, 0], [arm * 0.5, 0.032, 0], [arm - 0.02, 0.031, 0], end], segments: 6 }, up: [0, 1, 0], frame: 'up', label: piece('arm'), material: 'trim' });
  m.extrudePolygon({ points: roundedRect(0.04, 0.016, 0.004, 2), depth: 0.012, label: piece('clip'), material: 'trim' });
  m.rotate(by(`${o.name}-clip`), 'x', -90);
  m.translate(by(`${o.name}-clip`), [arm + 0.0205, 0.016, 0.0]);
  // Blade: spoiler body above the rubber, centered on the clip, along X.
  const spoiler: Point2[] = chaikin([[-0.009, 0], [0.011, 0], [0.004, 0.011], [-0.006, 0.008]], 1);
  m.sweep({ profile: spoiler, path: [[arm + 0.0205 - blade / 2, 0.0035, 0], [arm + 0.0205 + blade / 2, 0.0035, 0]], up: [0, 1, 0], frame: 'up', label: piece('blade'), material: 'trim' });
  m.sweep({ profile: [[-0.002, 0], [0.002, 0], [0.0005, 0.003], [-0.0005, 0.003]] as Point2[], path: [[arm + 0.0205 - blade / 2 + 0.005, 0.0, 0], [arm + 0.0205 + blade / 2 - 0.005, 0.0, 0]], up: [0, 1, 0], frame: 'up', label: piece('rubber'), material: 'rubber' });
  return finishDetail(o.name, m, pieces, { arm, blade, reach: arm + 0.0205 + blade / 2 });
}

export interface ExhaustOptions {
  readonly name: string;
  /** Tip count, side by side along X. */
  readonly tips?: number;
  /** Hexagon outer radius of one tip. */
  readonly size?: number;
  /** Visible tip length into the body. */
  readonly length?: number;
}

export const EXHAUST_RANGES = { tips: [1, 4], size: [0.03, 0.08], length: [0.05, 0.3] } as const;

/**
 * The exhaust exit, Y out of the tail: hexagonal titanium tips with their wall and a
 * rolled lip, a perforated inner baffle and inner pipe per tip, and the hexagonal
 * ceramic heat shield that surrounds the cluster.
 */
export function exhaust(o: ExhaustOptions): Result<DetailPart, ModelingError> {
  const tips = o.tips ?? 2;
  const size = o.size ?? 0.055;
  const length = o.length ?? 0.14;
  const checked = ranged({ tips: [tips, ...EXHAUST_RANGES.tips], size: [size, ...EXHAUST_RANGES.size], length: [length, ...EXHAUST_RANGES.length] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const gap = size * 2.15;
  const centers = Array.from({ length: tips }, (_, i) => (i - (tips - 1) / 2) * gap);
  const hex = (r: number, cx: number) => ring(r, 6, [cx, 0], Math.PI / 6);
  for (const [i, cx] of centers.entries()) {
    const k = String(i);
    m.extrudePolygon({ points: hex(size, cx), holes: [hex(size - 0.004, cx)], depth: length, label: piece(`tip-${k}`), material: 'exhaust' });
    m.rotate(by(`${o.name}-tip-${k}`), 'x', 90);
    m.translate(by(`${o.name}-tip-${k}`), [0, 0.01, 0]);
    m.bevel(by(`${o.name}-tip-${k}`).and(sel.facing('+y', 5)).boundary(), { width: 0.0015, segments: 2, label: piece(`tip-${k}-lip`) });
    // Inner pipe (round) and a perforated baffle plate across it.
    m.revolve({ points: [[size * 0.6, -length + 0.012], [size * 0.66, -length + 0.012], [size * 0.66, -0.03], [size * 0.6, -0.03]], segments: 36, label: piece(`pipe-${k}`), material: 'exhaust' });
    m.translate(by(`${o.name}-pipe-${k}`), [cx, 0, 0]);
    const holes = [ring(size * 0.08, 10, [0, 0]), ...Array.from({ length: 6 }, (_, j) => ring(size * 0.07, 10, [size * 0.32 * Math.cos((j * Math.PI) / 3), size * 0.32 * Math.sin((j * Math.PI) / 3)]))];
    m.extrudePolygon({ points: ring(size * 0.59, 36), holes, depth: 0.003, label: piece(`baffle-${k}`), material: 'steel' });
    m.rotate(by(`${o.name}-baffle-${k}`), 'x', 90);
    m.translate(by(`${o.name}-baffle-${k}`), [cx, -0.045, 0]);
  }
  // Heat shield: a hexagonal plate around the tips, holes 4 mm clear of each tip.
  const shieldW = (tips - 1) * gap + size * 2 + 0.05;
  const outline = chaikin(roundedRect(shieldW, 2 * (size + 0.004) + 0.016, 0.012, 1), 1);
  m.extrudePolygon({ points: outline, holes: centers.map((cx) => hex(size + 0.004, cx)), depth: 0.008, label: piece('shield'), material: 'ceramic' });
  m.rotate(by(`${o.name}-shield`), 'x', 90);
  m.translate(by(`${o.name}-shield`), [0, 0.002, 0]);
  return finishDetail(o.name, m, pieces, { tips, size, length, width: shieldW });
}

export interface FinOptions {
  readonly name: string;
  readonly count?: number;
  /** Fin length along the flow. */
  readonly length?: number;
  /** Fin height at the trailing edge. */
  readonly height?: number;
  /** Spacing across the car. */
  readonly spacing?: number;
  /** Stencil plate on the floor between the centre fin and the next (12c). */
  readonly stencil?: StencilSpec;
}

export const FIN_RANGES = { count: [2, 9], length: [0.2, 0.8], height: [0.03, 0.2], spacing: [0.08, 0.4] } as const;

/**
 * Diffuser fins on their own diffuser floor (Y down from it, Z = rearward flow): the floor
 * plate, each fin a profiled carbon blade rising toward the trailing edge with a rounded
 * leading edge and a Gurney strip, and the root rails that carry them.
 */
export function diffuserFins(o: FinOptions): Result<DetailPart, ModelingError> {
  const count = o.count ?? 5;
  const length = o.length ?? 0.45;
  const height = o.height ?? 0.09;
  const spacing = o.spacing ?? 0.2;
  const checked = ranged({ count: [count, ...FIN_RANGES.count], length: [length, ...FIN_RANGES.length], height: [height, ...FIN_RANGES.height], spacing: [spacing, ...FIN_RANGES.spacing] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  // Fin side profile in (flow, height): leading edge at flow 0, trailing edge at `length`.
  const side: Point2[] = chaikin([[0, 0.002], [length * 0.15, height * 0.18], [length * 0.6, height * 0.62], [length, height], [length, 0.002]], 1);
  for (let i = 0; i < count; i++) {
    const x = (i - (count - 1) / 2) * spacing;
    const k = String(i);
    const t = i === 0 || i === count - 1 ? 0.012 : 0.009;
    m.extrudePolygon({ points: side.map(([f, h]): Point2 => [-f, h]), depth: t, label: piece(`fin-${k}`), material: 'carbon' });
    // Outline x (flow) onto -Z then +Z rearward; extrusion onto +X.
    m.rotate(by(`${o.name}-fin-${k}`), 'y', 90);
    m.translate(by(`${o.name}-fin-${k}`), [x - t / 2, 0.0015, -length / 2]);
    m.bevel(by(`${o.name}-fin-${k}`).toEdges('touching').and(sel.edges.dihedral('>', 60)), { width: 0.0015, segments: 1, label: piece(`fin-${k}-edge`) });
    m.extrudePolygon({ points: roundedRect(t + 0.006, 0.012, 0.002, 1), depth: 0.004, label: piece(`gurney-${k}`), material: 'trim' });
    m.rotate(by(`${o.name}-gurney-${k}`), 'x', -90);
    m.translate(by(`${o.name}-gurney-${k}`), [x, height + 0.0025, length / 2 + 0.008]);
  }
  // The diffuser floor the fins stand on: a carbon plate over the whole fin field, above the roots.
  const fieldW = (count - 1) * spacing + 0.12;
  m.extrudePolygon({ points: roundedRect(fieldW, length + 0.04, 0.02, 3), depth: 0.004, label: piece('floor'), material: 'carbon' });
  m.rotate(by(`${o.name}-floor`), 'x', 90);
  m.bevel(by(`${o.name}-floor`).and(sel.facing('+y', 5)).boundary(), { width: 0.0015, segments: 1, label: piece('floor-edge') });
  if (o.stencil !== undefined) {
    // Between two fins and the two root rails, on the floor's road face.
    // Text up toward the trailing edge, so it reads from behind the car.
    stencilOn(m, o.stencil, [spacing / 2, 0, (length * 0.25 - length * 0.3) / 2], [0, 1, 0], [-1, 0, 0], piece('stencil'));
  }
  for (const [k, z] of [-length * 0.3, length * 0.25].entries()) {
    m.sweep({ profile: roundedRect(0.012, 0.0012, 0.0005, 1), path: [[-(count - 1) / 2 * spacing - 0.02, 0.0006, z], [(count - 1) / 2 * spacing + 0.02, 0.0006, z]], up: [0, 1, 0], frame: 'up', label: piece(`rail-${k}`), material: 'trim' });
  }
  return finishDetail(o.name, m, pieces, { count, length, height, spacing });
}

export const HANDLE_RANGES = { width: [0.08, 0.3] } as const;

export interface HandleOptions {
  readonly name: string;
  readonly width?: number;
}

/**
 * A flush door handle pocket (X along the car, Y out of the skin): the pocket frame, the
 * pull flap on its pivot pin, the key-less sensor pad and the release button.
 */
export function doorHandle(o: HandleOptions): Result<DetailPart, ModelingError> {
  const width = o.width ?? 0.16;
  const checked = ranged({ width: [width, ...HANDLE_RANGES.width] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const outline = roundedRect(width, 0.04, 0.012, 3);
  m.extrudePolygon({ points: outline, holes: [inset2(outline, 0.004)], depth: 0.02, label: piece('pocket'), material: 'trim' });
  m.rotate(by(`${o.name}-pocket`), 'x', 90);
  m.translate(by(`${o.name}-pocket`), [0, 0.003, 0]);
  m.extrudePolygon({ points: inset2(outline, 0.0055), depth: 0.004, label: piece('flap'), material: 'paint' });
  m.rotate(by(`${o.name}-flap`), 'x', 90);
  m.translate(by(`${o.name}-flap`), [0, 0.0005, 0]);
  m.cylinder({ radiusTop: 0.0025, radiusBottom: 0.0025, height: width - 0.016, radialSegments: 10, label: piece('pin'), material: 'steel' });
  m.rotate(by(`${o.name}-pin`), 'z', 90);
  m.translate(by(`${o.name}-pin`), [0, -0.008, 0.012]);
  m.cylinder({ radiusTop: 0.005, radiusBottom: 0.005, height: 0.0015, radialSegments: 16, center: [width / 2 + 0.014, 0.00075, 0], label: piece('button'), material: 'chrome' });
  return finishDetail(o.name, m, pieces, { width });
}

export const HINGE_RANGES = { reach: [0.12, 0.3] } as const;

export interface HingeOptions {
  readonly name: string;
  /** Arm reach from the pivot to the door's inner skin. */
  readonly reach?: number;
  /** Service stencil on the bracket's door-side face (12c). */
  readonly stencil?: StencilSpec;
}

/**
 * The scissor door's opening hardware, X along the hinge axis (across the car, the door
 * swings up about it), Y toward the door: the pillar bracket with lightening holes, the
 * pivot boss and its pin, the forged door arm, and the gas strut between bracket and arm
 * (the kernel's hydraulic-cylinder recipe).
 */
export function scissorHinge(o: HingeOptions): Result<DetailPart, ModelingError> {
  const reach = o.reach ?? 0.16;
  const checked = ranged({ reach: [reach, ...HINGE_RANGES.reach] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  // Bracket: a plate in the XZ plane behind the pivot (toward -Y), with two lightening holes.
  const plate: Point2[] = chaikin([[-0.045, -0.02], [0.045, -0.02], [0.05, 0.13], [0.0, 0.16], [-0.05, 0.13]], 1);
  m.extrudePolygon({ points: plate, holes: [ring(0.016, 16, [0, 0.055]), ring(0.012, 16, [0, 0.11])], depth: 0.008, label: piece('bracket'), material: 'steel' });
  m.rotate(by(`${o.name}-bracket`), 'x', 90);
  m.translate(by(`${o.name}-bracket`), [0, -0.03, 0]);
  // Pivot boss and arm eye: bored rings along X on one pin.
  const bored = (label: string, r: number, x0: number, x1: number) => {
    m.revolve({ points: [[0.0085, x0], [r, x0], [r, x1], [0.0085, x1], [0.0085, x0]], segments: 28, label: piece(label), material: 'steel' });
    m.rotate(by(`${o.name}-${label}`), 'z', -90);
  };
  bored('boss', 0.022, -0.025, 0.025);
  bored('arm-eye', 0.026, 0.027, 0.039);
  m.cylinder({ radiusTop: 0.008, radiusBottom: 0.008, height: 0.074, radialSegments: 16, label: piece('pin'), material: 'chrome' });
  m.rotate(by(`${o.name}-pin`), 'z', 90);
  // Door arm: a forged section sweeping from the eye out to the door.
  m.sweep({ profile: chaikin(roundedRect(0.012, 0.016, 0.004, 1), 1), path: { kind: 'catmullRom', points: [[0.033, 0.031, 0], [0.04, reach * 0.45, 0.02], [0.045, reach, 0.05]], segments: 6 }, up: [1, 0, 0], label: piece('arm'), material: 'steel' });
  // Text up along the bracket (+Z): the plate's width runs along -X.
  if (o.stencil !== undefined) stencilOn(m, o.stencil, [0.015, -0.03, 0.085], [0, 1, 0], [-1, 0, 0], piece('stencil'));
  // Gas strut from the bracket's top toward the arm.
  const strut = recipes.hydraulicCylinder({ name: `${o.name}-strut`, bore: 0.022, rod: 0.01, stroke: 0.1, extension: 0.4, segments: 16 });
  if (!strut.ok) return strut;
  const s = strut.value.model;
  s.rotate(sel.all(), 'x', -62);
  s.translate(sel.all(), [-0.04, -0.012, 0.13]);
  m.append(s);
  for (const label of s.inspect().labels.map((l) => l.label)) if (!pieces.includes(label)) pieces.push(label);
  return finishDetail(o.name, m, pieces, { reach });
}

/** Keep `ellipse` reachable for recipe consumers that shape custom openings. */
export const lampOutline = (width: number, height: number, slant: number): Point2[] =>
  ellipse(width / 2, height / 2, 24).map(([x, z]): Point2 => [x, z + (x / (width / 2)) * slant]);

