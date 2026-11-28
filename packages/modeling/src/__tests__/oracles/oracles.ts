import type { Tuple3 } from '../../geom';
import { massProperties } from '../../mass';
import { type Model, model } from '../../model';
import { sel } from '../../selectors';

/**
 * Closed forms of the faceted solids the kernel builds, not of the smooth solids they approximate:
 * a 24-gon cylinder weighs what a 24-gon prism weighs. The tolerances can then stay at rounding
 * level and the rows do not depend on how fine a tessellation is.
 */
export interface Oracle {
  readonly name: string;
  build(m: Model): void;
  /** Enclosed volume (m^3). */
  readonly volume: number;
  /** Surface area (m^2). */
  readonly area: number;
  readonly centroid: Tuple3;
  /** Inertia about the centroid at density 1, row-major. */
  readonly inertia?: readonly [Tuple3, Tuple3, Tuple3];
  /** Relative tolerance of every compared quantity. */
  readonly tolerance: number;
}

type Point2 = readonly [number, number];

const TAU = 2 * Math.PI;

/** Area of a regular n-gon of circumradius r. */
export function ngonArea(n: number, r: number): number {
  return (n / 2) * r * r * Math.sin(TAU / n);
}

/** Polar moment of area of a regular n-gon about its center, as the sum of n center triangles. */
export function ngonPolar(n: number, r: number): number {
  const theta = TAU / n;
  return (n * r ** 4 * Math.sin(theta) * (2 + Math.cos(theta))) / 12;
}

/** Vertices of a regular n-gon, the first on the +first axis. */
export function ngon(n: number, r: number, center: Point2 = [0, 0]): Point2[] {
  return Array.from({ length: n }, (_, k) => [
    center[0] + r * Math.cos((TAU * k) / n),
    center[1] + r * Math.sin((TAU * k) / n),
  ]);
}

/**
 * Volume, side area and axis centroid of a polygon `[rho, z]` (rho >= 0) revolved in `segments`
 * straight wedges. A wedge slice at height z is the area between two chords, so the volume is
 * `segments sin(a)` times the first moment of the profile about the axis; the side face of a
 * profile edge is a trapezoid of parallel chords `2 rho sin(a/2)` long, a distance
 * `hypot(d rho cos(a/2), dz)` apart.
 */
export function revolved(
  profile: readonly Point2[],
  segments: number,
): { volume: number; area: number; axisCentroid: number } {
  const a = TAU / segments;
  let moment = 0;
  let momentZ = 0;
  let area = 0;
  for (let i = 0; i < profile.length; i++) {
    const [r1, z1] = profile[i] as Point2;
    const [r2, z2] = profile[(i + 1) % profile.length] as Point2;
    const cross = r1 * z2 - r2 * z1;
    moment += (cross * (r1 + r2)) / 6;
    momentZ += (cross * (r1 * (2 * z1 + z2) + r2 * (z1 + 2 * z2))) / 24;
    area +=
      segments * Math.sin(a / 2) * (r1 + r2) * Math.hypot((r2 - r1) * Math.cos(a / 2), z2 - z1);
  }
  return {
    volume: Math.abs(segments * Math.sin(a) * moment),
    area,
    axisCentroid: momentZ / moment,
  };
}

function boxInertia(volume: number, size: Tuple3): [Tuple3, Tuple3, Tuple3] {
  const [a, b, c] = size;
  return [
    [(volume * (b * b + c * c)) / 12, 0, 0],
    [0, (volume * (a * a + c * c)) / 12, 0],
    [0, 0, (volume * (a * a + b * b)) / 12],
  ];
}

function boxRow(name: string, size: Tuple3, center: Tuple3): Oracle {
  const [a, b, c] = size;
  const volume = a * b * c;
  return {
    name,
    build: (m) => void m.box({ size, center }),
    volume,
    area: 2 * (a * b + b * c + c * a),
    centroid: center,
    inertia: boxInertia(volume, size),
    tolerance: 1e-9,
  };
}

function cylinderRow(
  name: string,
  radius: number,
  height: number,
  sides: number,
  center: Tuple3,
): Oracle {
  const base = ngonArea(sides, radius);
  const volume = base * height;
  const polar = ngonPolar(sides, radius);
  const across = (polar / 2) * height + (base * height ** 3) / 12;
  return {
    name,
    build: (m) =>
      void m.cylinder({
        radiusTop: radius,
        radiusBottom: radius,
        height,
        radialSegments: sides,
        center,
      }),
    volume,
    area: 2 * base + 2 * sides * radius * Math.sin(Math.PI / sides) * height,
    centroid: center,
    inertia: [
      [across, 0, 0],
      [0, polar * height, 0],
      [0, 0, across],
    ],
    tolerance: 1e-9,
  };
}

/** A solid of revolution about the +y axis through `center`, centroid on the axis. */
function revolveRow(
  name: string,
  build: (m: Model) => void,
  profile: readonly Point2[],
  segments: number,
  center: Tuple3,
): Oracle {
  const r = revolved(profile, segments);
  return {
    name,
    build,
    volume: r.volume,
    area: r.area,
    centroid: [center[0], center[1] + r.axisCentroid, center[2]],
    tolerance: 1e-9,
  };
}

function sphereRow(): Oracle {
  const radius = 1.5;
  const [w, h] = [24, 12];
  const center: Tuple3 = [0.5, -1, 2];
  const profile: Point2[] = [[0, -radius]];
  for (let k = 1; k < h; k++) {
    const theta = (Math.PI * k) / h;
    profile.push([radius * Math.sin(theta), -radius * Math.cos(theta)]);
  }
  profile.push([0, radius]);
  return revolveRow(
    'sphere',
    (m) => void m.sphere({ radius, widthSegments: w, heightSegments: h, center }),
    profile,
    w,
    center,
  );
}

function coneRow(): Oracle {
  const [radius, height, sides] = [0.8, 2, 20];
  const center: Tuple3 = [-1, 0.5, 0.25];
  return revolveRow(
    'cone',
    (m) => void m.cone({ radius, height, radialSegments: sides, center }),
    [
      [0, -height / 2],
      [radius, -height / 2],
      [0, height / 2],
    ],
    sides,
    center,
  );
}

function torusRow(): Oracle {
  const [radius, tube, ring, tubular] = [3, 1, 12, 32];
  const center: Tuple3 = [1, 2, -3];
  const r = revolved(
    ngon(ring, tube, [radius, 0]).map(([rho, z]) => [rho, z] as Point2),
    tubular,
  );
  return {
    name: 'torus',
    build: (m) =>
      void m.torus({ radius, tube, radialSegments: ring, tubularSegments: tubular, center }),
    volume: r.volume,
    area: r.area,
    centroid: center,
    tolerance: 1e-9,
  };
}

/** A box with a cylindrical hole through its height, off the box center. */
function holeRow(): Oracle {
  const size: Tuple3 = [4, 2, 3];
  const [radius, sides] = [0.5, 32];
  const offset: Tuple3 = [0.3, 0, -0.2];
  const box = boxRow('', size, [0, 0, 0]);
  const hole = ngonArea(sides, radius) * size[1];
  const volume = box.volume - hole;
  return {
    name: 'box.cylinder-hole',
    build: (m) => {
      m.box({ size });
      const tool = model();
      tool.cylinder({
        radiusTop: radius,
        radiusBottom: radius,
        height: 3,
        radialSegments: sides,
        center: offset,
      });
      m.difference(tool);
    },
    volume,
    area:
      box.area -
      2 * ngonArea(sides, radius) +
      2 * sides * radius * Math.sin(Math.PI / sides) * size[1],
    centroid: [(-hole * offset[0]) / volume, 0, (-hole * offset[2]) / volume],
    tolerance: 1e-9,
  };
}

interface Piece {
  readonly low: number;
  readonly high: number;
  /** Width of the polygon at the two ends of the piece. */
  readonly widthLow: number;
  readonly widthHigh: number;
  readonly widthMid: number;
}

/**
 * The widths of a convex polygon along x as piecewise linear functions of z: the polygon is cut
 * at its vertex heights, and each cut interval is crossed by exactly two edges.
 */
function widthPieces(polygon: readonly Point2[]): Piece[] {
  const levels = [...new Set(polygon.map((p) => p[1]))].sort((a, b) => a - b);
  const merged: number[] = [];
  for (const z of levels) {
    if (merged.length === 0 || z - (merged.at(-1) as number) > 1e-12) merged.push(z);
  }
  const pieces: Piece[] = [];
  for (let i = 0; i + 1 < merged.length; i++) {
    const low = merged[i] as number;
    const high = merged[i + 1] as number;
    const mid = (low + high) / 2;
    const crossing = polygon.flatMap((p, k) => {
      const q = polygon[(k + 1) % polygon.length] as Point2;
      return Math.min(p[1], q[1]) < mid && mid < Math.max(p[1], q[1]) ? [[p, q] as const] : [];
    });
    const at = (z: number) => {
      const xs = crossing.map(([p, q]) => p[0] + ((z - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
      return Math.abs((xs[0] as number) - (xs[1] as number));
    };
    pieces.push({ low, high, widthLow: at(low), widthHigh: at(high), widthMid: at(mid) });
  }
  return pieces;
}

/**
 * Two equal n-gon prisms (n a multiple of 4) crossing at right angles, long enough to contain
 * each other's section. The volume is the integral over z of the product of the two widths,
 * piecewise quadratic and integrated exactly by Simpson's rule; the surface is each prism's
 * side strips clipped to the other's width, counted for both.
 */
function steinmetzRow(): Oracle {
  const [radius, sides] = [1, 16];
  const polygon = ngon(sides, radius).map(([x, z]) => [x, z] as Point2);
  const pieces = widthPieces(polygon);
  let volume = 0;
  for (const p of pieces) {
    volume += ((p.high - p.low) / 6) * (p.widthLow ** 2 + 4 * p.widthMid ** 2 + p.widthHigh ** 2);
  }
  let strips = 0;
  for (let k = 0; k < sides; k++) {
    const p = polygon[k] as Point2;
    const q = polygon[(k + 1) % sides] as Point2;
    const span = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dz = Math.abs(q[1] - p[1]);
    const zLow = Math.min(p[1], q[1]);
    const zHigh = Math.max(p[1], q[1]);
    let integral = 0;
    for (const piece of pieces) {
      if (piece.low >= zLow - 1e-12 && piece.high <= zHigh + 1e-12) {
        integral += ((piece.high - piece.low) * (piece.widthLow + piece.widthHigh)) / 2;
      }
    }
    strips += (span / dz) * integral;
  }
  return {
    name: 'cylinders.intersection',
    build: (m) => {
      const cut = () => {
        const t = model();
        t.cylinder({
          radiusTop: radius,
          radiusBottom: radius,
          height: 3,
          radialSegments: sides,
        });
        return t;
      };
      m.cylinder({ radiusTop: radius, radiusBottom: radius, height: 3, radialSegments: sides });
      const tool = cut();
      tool.rotate(sel.all(), 'z', 90);
      m.intersection(tool);
    },
    volume,
    area: 2 * strips,
    centroid: [0, 0, 0],
    tolerance: 1e-9,
  };
}

function shelledRow(): Oracle {
  const size: Tuple3 = [2, 3, 4];
  const wall = 0.25;
  const outer = boxRow('', size, [0, 0, 0]);
  const innerSize = size.map((s) => s - 2 * wall) as unknown as Tuple3;
  const inner = boxRow('', innerSize, [0, 0, 0]);
  const tensor = (k: number) =>
    (outer.inertia?.[k]?.[k] as number) - (inner.inertia?.[k]?.[k] as number);
  return {
    name: 'box.shelled',
    build: (m) => {
      m.box({ size });
      m.shell(sel.all(), { thickness: wall });
    },
    volume: outer.volume - inner.volume,
    area: outer.area + inner.area,
    centroid: [0, 0, 0],
    inertia: [
      [tensor(0), 0, 0],
      [0, tensor(1), 0],
      [0, 0, tensor(2)],
    ],
    tolerance: 1e-9,
  };
}

const add3 = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: Tuple3, s: number): Tuple3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: Tuple3, b: Tuple3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit3 = (a: Tuple3): Tuple3 => scale3(a, 1 / Math.sqrt(dot3(a, a)));

/**
 * A regular n-gon section swept along a polyline, mitered at the joints so that the section
 * perpendicular to each span keeps its shape. Each span is an oblique prism whose end cuts are
 * the joint's bisecting planes, so its volume is the section area times the span length: the
 * faceted Pappus theorem, with the smooth theorem's 2 pi R A replaced by A times the polyline
 * length. The lateral area is the section perimeter times the length. The centroid adds, per
 * span, the first moment of the oblique cut: with the end offsets linear in the section
 * coordinates, only the isotropic second moment of the section survives.
 */
function sweepRow(): Oracle {
  const [sides, tube, radius, degrees, spans] = [24, 4, 40, 90, 16];
  const points: Tuple3[] = Array.from({ length: spans + 1 }, (_, k) => {
    const phi = (degrees * k * Math.PI) / (180 * spans);
    return [radius * Math.sin(phi), 0, radius * Math.cos(phi)];
  });
  const section = ngonArea(sides, tube);
  const second = ngonPolar(sides, tube) / 2;
  const directions = points.slice(1).map((p, k) => unit3(sub3(p, points[k] as Tuple3)));
  const tangent = (k: number): Tuple3 =>
    k === 0
      ? (directions[0] as Tuple3)
      : k === spans
        ? (directions[spans - 1] as Tuple3)
        : unit3(add3(directions[k - 1] as Tuple3, directions[k] as Tuple3));
  let length = 0;
  let moment: Tuple3 = [0, 0, 0];
  for (let k = 0; k < spans; k++) {
    const d = directions[k] as Tuple3;
    const start = points[k] as Tuple3;
    const span = Math.sqrt(
      dot3(sub3(points[k + 1] as Tuple3, start), sub3(points[k + 1] as Tuple3, start)),
    );
    const slope = (t: Tuple3): Tuple3 => {
      const g = scale3(t, -1 / dot3(d, t));
      return sub3(g, scale3(d, dot3(g, d)));
    };
    const ga = slope(tangent(k));
    const gb = slope(tangent(k + 1));
    length += span;
    const lateral = scale3(sub3(gb, ga), second);
    const along = scale3(d, (span * span * section + second * (dot3(gb, gb) - dot3(ga, ga))) / 2);
    moment = add3(moment, add3(add3(scale3(start, section * span), lateral), along));
  }
  const volume = section * length;
  return {
    name: 'sweep.circle-arc',
    build: (m) =>
      void m.sweep({
        profile: ngon(sides, tube),
        path: { kind: 'arc', radius, angle: degrees, segments: spans, axis: 'y' },
      }),
    volume,
    area: 2 * section + 2 * sides * tube * Math.sin(Math.PI / sides) * length,
    centroid: scale3(moment, 1 / volume),
    tolerance: 1e-9,
  };
}

export const ORACLES: readonly Oracle[] = [
  boxRow('box', [0.2, 0.1, 0.4], [1, 2, 3]),
  cylinderRow('cylinder', 0.05, 0.3, 256, [0, 0, 0]),
  sphereRow(),
  coneRow(),
  torusRow(),
  holeRow(),
  steinmetzRow(),
  shelledRow(),
  sweepRow(),
];

export function oracle(name: string): Oracle {
  const row = ORACLES.find((o) => o.name === name);
  if (row === undefined) throw new Error(`no oracle row ${name}`);
  return row;
}

export interface Measured {
  readonly volume: number;
  readonly area: number;
  readonly centroid: Tuple3;
  readonly inertia: readonly [Tuple3, Tuple3, Tuple3];
}

/** Builds a row on a fresh session and reads its mass properties at density 1. */
export function measure(row: Oracle): Measured {
  const m = model();
  row.build(m);
  const p = massProperties(m, { density: 1 });
  if (!p.ok) throw p.error;
  return p.value;
}
