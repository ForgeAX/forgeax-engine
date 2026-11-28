import { ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { type BooleanOp, booleanSolids } from './boolean';
import { IDENTITY_PLACEMENT, type Placement, transformShape } from './transform';
import { BREP_LIMITS, type BrepDetailCode, brepFail, type Shape } from './types';
import { len3, type P3, scale3, sub3, TWO_PI, unit3 } from './vec';

/**
 * Pattern tools: copies of one tool solid placed by proper rigid motions, then applied to a base by a
 * chain of `booleanSolids` calls. Copies are exact (`transformShape`), so the chain is only as capable
 * as the boolean: the first copy the boolean cannot take stops the chain and no shape is returned
 * (`model-partial` carrying the boolean's own `detail.brep`, `detail.reason = 'pattern-step'`,
 * `detail.copy` = index of the failing copy and `detail.cause` = the boolean's expectation).
 */
export interface PatternLine {
  readonly origin: P3;
  readonly direction: P3;
}

export interface LinearPatternOptions {
  /** Direction of the row; normalised. */
  readonly direction: P3;
  /** Distance between neighbouring copies, > 0. */
  readonly spacing: number;
  /** Copies including the original, an integer in [1, 4096]. */
  readonly count: number;
}

export interface CircularPatternOptions {
  readonly axis: PatternLine;
  /** Copies including the original, an integer in [1, 4096]. */
  readonly count: number;
  /** Total angle in radians, default a full turn (copies then step by sweep / count; else by sweep / (count - 1)). */
  readonly sweep?: number;
}

const bad = (expected: string, ids: Record<string, unknown> = {}) =>
  brepFail<never>('brep-bad-argument', expected, ids);

const finite3 = (p: unknown): p is P3 =>
  Array.isArray(p) && p.length === 3 && p.every((x) => typeof x === 'number' && Number.isFinite(x));

function validCount(count: number): boolean {
  return Number.isInteger(count) && count >= 1 && count <= BREP_LIMITS.faces;
}

function unitDirection(d: P3): P3 | undefined {
  return finite3(d) && len3(d) > 1e-12 ? unit3(d) : undefined;
}

/** Rotation by `angle` about the line `axis`: the Rodrigues matrix, with `t = o - R o` fixing the line. */
function rotationAbout(axis: PatternLine, angle: number): Placement {
  const k = unit3(axis.direction);
  const c = cos(angle);
  const s = sin(angle);
  const m = 1 - c;
  const rot: Placement['rot'] = [
    [c + k[0] * k[0] * m, k[0] * k[1] * m - k[2] * s, k[0] * k[2] * m + k[1] * s],
    [k[1] * k[0] * m + k[2] * s, c + k[1] * k[1] * m, k[1] * k[2] * m - k[0] * s],
    [k[2] * k[0] * m - k[1] * s, k[2] * k[1] * m + k[0] * s, c + k[2] * k[2] * m],
  ];
  const o = axis.origin;
  const ro: P3 = [
    rot[0][0] * o[0] + rot[0][1] * o[1] + rot[0][2] * o[2],
    rot[1][0] * o[0] + rot[1][1] * o[1] + rot[1][2] * o[2],
    rot[2][0] * o[0] + rot[2][1] * o[1] + rot[2][2] * o[2],
  ];
  return { rot, t: sub3(o, ro) };
}

function place(tool: Shape, placements: readonly Placement[]): Result<Shape[], ModelingError> {
  const out: Shape[] = [];
  for (const p of placements) {
    const moved = transformShape(tool, p);
    if (!moved.ok) return moved;
    out.push(moved.value);
  }
  return ok(out);
}

/** `count` copies of `tool` in a row; copy 0 is `tool` itself. */
export function linearPattern(
  tool: Shape,
  options: LinearPatternOptions,
): Result<Shape[], ModelingError> {
  const dir = unitDirection(options.direction);
  if (dir === undefined) return bad('a finite non-zero direction');
  if (!(Number.isFinite(options.spacing) && options.spacing > 0)) return bad('spacing > 0');
  if (!validCount(options.count)) return bad('an integer count in [1, 4096]');
  const ps: Placement[] = [];
  for (let i = 0; i < options.count; i++) {
    ps.push(
      i === 0 ? IDENTITY_PLACEMENT : { ...IDENTITY_PLACEMENT, t: scale3(dir, i * options.spacing) },
    );
  }
  return place(tool, ps);
}

/** `count` copies of `tool` turned about `axis`; copy 0 is `tool` itself. */
export function circularPattern(
  tool: Shape,
  options: CircularPatternOptions,
): Result<Shape[], ModelingError> {
  const dir = unitDirection(options.axis?.direction);
  if (dir === undefined || !finite3(options.axis.origin)) {
    return bad('an axis with a finite origin and a finite non-zero direction');
  }
  if (!validCount(options.count)) return bad('an integer count in [1, 4096]');
  const sweep = options.sweep ?? TWO_PI;
  if (!(Number.isFinite(sweep) && sweep !== 0 && Math.abs(sweep) <= TWO_PI)) {
    return bad('a sweep in (0, 2 pi] (or negative)');
  }
  const full = Math.abs(Math.abs(sweep) - TWO_PI) < 1e-12;
  const steps = full ? options.count : Math.max(1, options.count - 1);
  const ps: Placement[] = [];
  for (let i = 0; i < options.count; i++) {
    ps.push(
      i === 0
        ? IDENTITY_PLACEMENT
        : rotationAbout({ origin: options.axis.origin, direction: dir }, (sweep * i) / steps),
    );
  }
  return place(tool, ps);
}

/**
 * `tool` and its half turn about `line`. For a tool symmetric about the plane through `line`
 * perpendicular to the lost axis (a through bore centred on the line's height) this is the mirror
 * image across the plane that contains `line` and the bore axis.
 */
export function mirrorPair(tool: Shape, line: PatternLine): Result<Shape[], ModelingError> {
  const dir = unitDirection(line?.direction);
  if (dir === undefined || !finite3(line.origin)) {
    return bad('a line with a finite origin and a finite non-zero direction');
  }
  return place(tool, [
    IDENTITY_PLACEMENT,
    rotationAbout({ origin: line.origin, direction: dir }, Math.PI),
  ]);
}

/** Applies each tool copy to `base` in order with `op`; stops at the first copy the boolean refuses. */
export function applyPattern(
  base: Shape,
  tools: readonly Shape[],
  op: BooleanOp = 'difference',
): Result<Shape, ModelingError> {
  if (tools.length === 0) return bad('at least one tool copy');
  let current = base;
  for (let i = 0; i < tools.length; i++) {
    const next = booleanSolids(current, tools[i] as Shape, op);
    if (!next.ok) {
      const inner = next.error.detail as { brep?: BrepDetailCode } | undefined;
      return brepFail(inner?.brep ?? 'brep-ssi-unsupported', 'a tool copy the boolean can apply', {
        reason: 'pattern-step',
        copy: i,
        copies: tools.length,
        cause: next.error.expected,
      });
    }
    current = next.value;
  }
  return ok(current);
}
