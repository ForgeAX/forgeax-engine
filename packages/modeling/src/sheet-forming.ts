import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import type { Point2 } from './primitives';
import type { Issue } from './report';
import { type SheetBend, type SheetMetalSpec, sheet } from './sheet';

/** Sheet material properties in pascals and minimum inside-radius/thickness ratio. */
export interface SheetMaterial {
  readonly name: string;
  /** Young's modulus, Pa. */
  readonly youngsModulus: number;
  /** Yield strength, Pa. */
  readonly yieldStrength: number;
  /** Smallest inside bend radius over thickness the material takes without cracking. */
  readonly minBendRatio: number;
}

/** Shop limits used by {@link sheetForming}. */
export interface SheetFormingOptions {
  /** Shortest flange from the bend-zone edge, in thicknesses (default 4). */
  readonly minFlange?: number;
  /** Hole-edge clearance coefficients for thickness and bend radius (default [2.5, 1]). */
  readonly holeClearance?: readonly [number, number];
  /** Maximum tool-angle correction before `springback-large`, degrees (default 5). */
  readonly maxSpringback?: number;
}

/** Sheet-forming warning codes. */
export type FormingCode =
  | 'bend-radius-below-minimum'
  | 'flange-too-short'
  | 'hole-near-bend'
  | 'springback-large';

/** Calculated tooling values for one designed bend. */
export interface BendForming {
  readonly index: number;
  readonly angle: number;
  readonly radius: number;
  readonly minRadius: number;
  readonly springback: number;
  readonly toolAngle: number;
  readonly toolRadius: number;
  readonly allowance: number;
}

/** Sheet-forming calculations and warnings. */
export interface FormingReport {
  readonly pass: boolean;
  readonly material: string;
  readonly bends: readonly BendForming[];
  readonly issues: readonly Issue<FormingCode>[];
}

/** Typical room-temperature values for first checks; replace them with the supplier's data. */
export const SHEET_MATERIALS: Readonly<
  Record<
    'mild-steel' | 'high-strength-steel' | 'aluminium-5xxx' | 'aluminium-6xxx' | 'stainless-304',
    SheetMaterial
  >
> = Object.freeze({
  'mild-steel': Object.freeze({
    name: 'DC04-class mild steel (typical values)',
    youngsModulus: 210e9,
    yieldStrength: 180e6,
    minBendRatio: 0.5,
  }),
  'high-strength-steel': Object.freeze({
    name: 'HSLA 420-class steel (typical values)',
    youngsModulus: 210e9,
    yieldStrength: 420e6,
    minBendRatio: 1.5,
  }),
  'aluminium-5xxx': Object.freeze({
    name: '5xxx-O aluminium (typical values)',
    youngsModulus: 70e9,
    yieldStrength: 130e6,
    minBendRatio: 1,
  }),
  'aluminium-6xxx': Object.freeze({
    name: '6xxx-T4 aluminium (typical values)',
    youngsModulus: 70e9,
    yieldStrength: 120e6,
    minBendRatio: 1,
  }),
  'stainless-304': Object.freeze({
    name: '304 annealed stainless steel (typical values)',
    youngsModulus: 193e9,
    yieldStrength: 215e6,
    minBendRatio: 0.5,
  }),
});

interface BendFrame {
  readonly origin: Point2;
  readonly along: Point2;
  readonly across: Point2;
  readonly length: number;
  readonly halfAllowance: number;
}

interface HoleDistance {
  readonly distance: number;
  readonly point: Point2;
}

const invalid = (expected: string, detail: Record<string, unknown>) =>
  err(modelingError('model-invalid-argument', expected, detail));

function positiveFinite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function recoveryRatio(x: number): number {
  return 4 * x * x * x - 3 * x + 1;
}

/** Springback uses `Ri / Rf = 4x^3 - 3x + 1`, with `x = Ri Y / (E t)` (Kalpakjian & Schmid). */
function toolRadiusFor(
  radius: number,
  thickness: number,
  material: SheetMaterial,
  index: number,
): Result<{ readonly radius: number; readonly ratio: number }, ModelingError> {
  const xAtReleasedRadius =
    (radius / thickness) * (material.yieldStrength / material.youngsModulus);
  if (!Number.isFinite(xAtReleasedRadius) || xAtReleasedRadius >= 0.5) {
    return err(
      modelingError('model-precondition', 'springback relation applies only while x is below 0.5', {
        bend: index,
        xAtReleasedRadius,
        maximumX: 0.5,
        radius,
        thickness,
        youngsModulus: material.youngsModulus,
        yieldStrength: material.yieldStrength,
      }),
    );
  }

  let low = 0;
  let high = radius;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (mid === low || mid === high) break;
    const x = (mid / thickness) * (material.yieldStrength / material.youngsModulus);
    if (mid / radius < recoveryRatio(x)) low = mid;
    else high = mid;
  }
  const toolRadius = (low + high) / 2;
  const x = (toolRadius / thickness) * (material.yieldStrength / material.youngsModulus);
  const relationRatio = recoveryRatio(x);
  const springback = ((2 * toolRadius) / thickness + 1) / ((2 * radius) / thickness + 1);
  if (
    !positiveFinite(toolRadius) ||
    !Number.isFinite(relationRatio) ||
    relationRatio <= 0 ||
    !Number.isFinite(springback) ||
    springback <= 0 ||
    springback > 1
  ) {
    return err(
      modelingError('model-precondition', 'springback relation has a finite physical solution', {
        bend: index,
        toolRadius,
        springback,
        relationRatio,
        x,
      }),
    );
  }
  return ok({ radius: toolRadius, ratio: springback });
}

function makeFrame(bend: SheetBend, thickness: number, kFactor: number): BendFrame {
  const [a, b] = bend.line;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  const along: Point2 = [dx / length, dy / length];
  return {
    origin: a,
    along,
    across: [-along[1], along[0]],
    length,
    halfAllowance: sheet.bendAllowance(bend.angle, bend.radius, thickness, kFactor) / 2,
  };
}

function local(frame: BendFrame, point: Point2): Point2 {
  const dx = point[0] - frame.origin[0];
  const dy = point[1] - frame.origin[1];
  return [dx * frame.along[0] + dy * frame.along[1], dx * frame.across[0] + dy * frame.across[1]];
}

function pointOnSide(frame: BendFrame, along: number, across: number): Point2 {
  return [
    frame.origin[0] + along * frame.along[0] + across * frame.across[0],
    frame.origin[1] + along * frame.along[1] + across * frame.across[1],
  ];
}

/** Largest perpendicular distance from either zone edge to an outline vertex on that side. */
function flangeLength(ring: readonly Point2[], frame: BendFrame, side: -1 | 1): HoleDistance {
  let distance = 0;
  let point = pointOnSide(frame, frame.length / 2, side * frame.halfAllowance);
  for (const vertex of ring) {
    const across = local(frame, vertex)[1];
    const candidate = side * across - frame.halfAllowance;
    if (candidate > distance) {
      distance = candidate;
      point = vertex;
    }
  }
  return { distance, point };
}

function onSegment(point: Point2, a: Point2, b: Point2): boolean {
  const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  return (
    cross === 0 &&
    point[0] >= Math.min(a[0], b[0]) &&
    point[0] <= Math.max(a[0], b[0]) &&
    point[1] >= Math.min(a[1], b[1]) &&
    point[1] <= Math.max(a[1], b[1])
  );
}

function containsPoint(ring: readonly Point2[], point: Point2): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point2;
    const b = ring[(i + 1) % ring.length] as Point2;
    if (onSegment(point, a, b)) return true;
    if (a[1] > point[1] !== b[1] > point[1]) {
      const crossing = a[0] + ((point[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (point[0] < crossing) inside = !inside;
    }
  }
  return inside;
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const orient = (p: Point2, q: Point2, r: Point2) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = orient(a, b, c);
  const abD = orient(a, b, d);
  const cdA = orient(c, d, a);
  const cdB = orient(c, d, b);
  return (
    (abC === 0 && onSegment(c, a, b)) ||
    (abD === 0 && onSegment(d, a, b)) ||
    (cdA === 0 && onSegment(a, c, d)) ||
    (cdB === 0 && onSegment(b, c, d)) ||
    (((abC < 0 && abD > 0) || (abC > 0 && abD < 0)) &&
      ((cdA < 0 && cdB > 0) || (cdA > 0 && cdB < 0)))
  );
}

function closestOnSegment(point: Point2, a: Point2, b: Point2): Point2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return [a[0] + t * dx, a[1] + t * dy];
}

function distance(a: Point2, b: Point2): number {
  return Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]));
}

function holeDistance(hole: readonly Point2[], frame: BendFrame): HoleDistance {
  const zone: readonly Point2[] = [
    pointOnSide(frame, 0, -frame.halfAllowance),
    pointOnSide(frame, frame.length, -frame.halfAllowance),
    pointOnSide(frame, frame.length, frame.halfAllowance),
    pointOnSide(frame, 0, frame.halfAllowance),
  ];
  const localHole = hole.map((point) => local(frame, point));
  const inZone = (point: Point2) =>
    point[0] >= 0 &&
    point[0] <= frame.length &&
    point[1] >= -frame.halfAllowance &&
    point[1] <= frame.halfAllowance;
  const localZone: readonly Point2[] = [
    [0, -frame.halfAllowance],
    [frame.length, -frame.halfAllowance],
    [frame.length, frame.halfAllowance],
    [0, frame.halfAllowance],
  ];
  for (let i = 0; i < localHole.length; i++) {
    const a = localHole[i] as Point2;
    const b = localHole[(i + 1) % localHole.length] as Point2;
    if (inZone(a)) return { distance: 0, point: hole[i] as Point2 };
    for (let j = 0; j < localZone.length; j++) {
      if (
        segmentsIntersect(
          a,
          b,
          localZone[j] as Point2,
          localZone[(j + 1) % localZone.length] as Point2,
        )
      ) {
        return { distance: 0, point: hole[i] as Point2 };
      }
    }
  }
  for (const corner of localZone) {
    if (containsPoint(localHole, corner)) {
      const world = zone[localZone.indexOf(corner)] as Point2;
      return { distance: 0, point: world };
    }
  }

  let bestDistance = Infinity;
  let bestPoint = hole[0] as Point2;
  for (let i = 0; i < hole.length; i++) {
    const a = hole[i] as Point2;
    const b = hole[(i + 1) % hole.length] as Point2;
    for (let j = 0; j < zone.length; j++) {
      const c = zone[j] as Point2;
      const d = zone[(j + 1) % zone.length] as Point2;
      const candidates: readonly [Point2, Point2][] = [
        [a, closestOnSegment(a, c, d)],
        [b, closestOnSegment(b, c, d)],
        [closestOnSegment(c, a, b), c],
        [closestOnSegment(d, a, b), d],
      ];
      for (const [onHole, onZone] of candidates) {
        const candidate = distance(onHole, onZone);
        if (candidate < bestDistance) {
          bestDistance = candidate;
          bestPoint = onHole;
        }
      }
    }
  }
  return { distance: Number.isFinite(bestDistance) ? bestDistance : 0, point: bestPoint };
}

function bendPoint(bend: SheetBend): Point2 {
  return [(bend.line[0][0] + bend.line[1][0]) / 2, (bend.line[0][1] + bend.line[1][1]) / 2];
}

/**
 * Check bend radius, flange and hole clearances, and springback. Flanges use the greatest
 * perpendicular distance from a bend-zone edge to any outline vertex on that side.
 */
export function sheetForming(
  spec: SheetMetalSpec,
  material: SheetMaterial,
  options: SheetFormingOptions = {},
): Result<FormingReport, ModelingError> {
  if (typeof spec !== 'object' || spec === null)
    return invalid('spec is a sheet metal specification', { spec });
  const flat = sheet.flat(spec);
  if (!flat.ok) return flat;
  if (typeof material !== 'object' || material === null)
    return invalid('material is a sheet material', { material });
  if (typeof material.name !== 'string' || material.name.trim().length === 0) {
    return invalid('material.name is a non-empty string', { name: material.name });
  }
  for (const [name, value] of [
    ['youngsModulus', material.youngsModulus],
    ['yieldStrength', material.yieldStrength],
    ['minBendRatio', material.minBendRatio],
  ] as const) {
    if (!positiveFinite(value))
      return invalid(`${name} is finite and greater than 0`, { [name]: value });
  }
  if (typeof options !== 'object' || options === null)
    return invalid('options is an object', { options });

  const thickness = spec.thickness;
  const minFlange = options.minFlange ?? 4;
  const holeClearance = options.holeClearance ?? [2.5, 1];
  const maxSpringback = options.maxSpringback ?? 5;
  if (!nonNegativeFinite(minFlange))
    return invalid('minFlange is finite and at least 0', { minFlange });
  if (
    !Array.isArray(holeClearance) ||
    holeClearance.length !== 2 ||
    !nonNegativeFinite(holeClearance[0] as number) ||
    !nonNegativeFinite(holeClearance[1] as number)
  ) {
    return invalid('holeClearance has two finite non-negative coefficients', { holeClearance });
  }
  if (!nonNegativeFinite(maxSpringback)) {
    return invalid('maxSpringback is finite and at least 0', { maxSpringback });
  }

  const shape = flat.value[0];
  if (shape === undefined) return invalid('sheet outline contains one shape', { shapes: 0 });
  const kFactor = spec.kFactor ?? 0.44;
  const issues: Issue<FormingCode>[] = [];
  const bends: BendForming[] = [];
  for (const [index, bend] of spec.bends.entries()) {
    const tooling = toolRadiusFor(bend.radius, thickness, material, index);
    if (!tooling.ok) return tooling;
    const minRadius = material.minBendRatio * thickness;
    const toolAngle = bend.angle / tooling.value.ratio;
    const allowance = sheet.bendAllowance(bend.angle, bend.radius, thickness, kFactor);
    if (![minRadius, toolAngle, allowance].every(Number.isFinite)) {
      return invalid('forming results are finite', { bend: index });
    }
    bends.push({
      index,
      angle: bend.angle,
      radius: bend.radius,
      minRadius,
      springback: tooling.value.ratio,
      toolAngle,
      toolRadius: tooling.value.radius,
      allowance,
    });

    const point = bendPoint(bend);
    if (bend.radius < minRadius) {
      issues.push({
        code: 'bend-radius-below-minimum',
        severity: 'warn',
        detail: { bend: index, radius: bend.radius, minimum: minRadius, point },
      });
    }

    const frame = makeFrame(bend, thickness, kFactor);
    for (const [side, sign] of [
      ['negative', -1],
      ['positive', 1],
    ] as const) {
      const flange = flangeLength(shape.outer, frame, sign);
      const minimum = minFlange * thickness;
      if (flange.distance < minimum) {
        issues.push({
          code: 'flange-too-short',
          severity: 'warn',
          detail: {
            bend: index,
            side,
            length: flange.distance,
            minimum,
            point: flange.point,
          },
        });
      }
    }

    const minimumHoleClearance =
      (holeClearance[0] as number) * thickness + (holeClearance[1] as number) * bend.radius;
    for (const [holeIndex, hole] of (shape.holes ?? []).entries()) {
      const measured = holeDistance(hole, frame);
      if (measured.distance < minimumHoleClearance) {
        issues.push({
          code: 'hole-near-bend',
          severity: 'warn',
          detail: {
            bend: index,
            hole: holeIndex,
            distance: measured.distance,
            minimum: minimumHoleClearance,
            point: measured.point,
          },
        });
      }
    }

    const angleCorrection = Math.abs(toolAngle - bend.angle);
    if (angleCorrection > maxSpringback) {
      issues.push({
        code: 'springback-large',
        severity: 'warn',
        detail: {
          bend: index,
          angleCorrection,
          maximum: maxSpringback,
          toolAngle,
          angle: bend.angle,
          point,
        },
      });
    }
  }
  return ok({ pass: issues.length === 0, material: material.name, bends, issues });
}
