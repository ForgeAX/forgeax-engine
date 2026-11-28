import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import {
  checkAll,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export const LATTICE_PATTERNS = ['bubujin', 'guibeijin', 'binglie', 'huiwen'] as const;
export type LatticePattern = (typeof LATTICE_PATTERNS)[number];

export interface LatticePatternOptions extends RecipeNaming {
  /**
   * `bubujin` stepped squares with four corner steps, `guibeijin` flat-top hexagons, `binglie`
   * seeded irregular rectangles, `huiwen` stepped squares with alternating diagonal steps.
   * Default `bubujin`.
   */
  readonly pattern?: LatticePattern;
  /** Panel width along X, meters (default 0.9). */
  readonly width?: number;
  /** Panel height along Y, meters (default 0.9). */
  readonly height?: number;
  /** Panel thickness along Z, meters (default 0.03). */
  readonly thickness?: number;
  /** Lattice pitch in meters (default 0.15). Cell edges are shared, openings sit inside them. */
  readonly cell?: number;
  /** Solid bar between neighbouring openings, meters (default 0.02). */
  readonly bar?: number;
  /** Solid margin from the panel outline to the lattice, meters (default 0.04). */
  readonly border?: number;
  /** Required for `binglie`: an integer that fixes the random cell sizes. Ignored otherwise. */
  readonly seed?: number;
}

/** Declared ranges. Lattice sizes are design choices, not source values. */
export const LATTICE_PATTERN_RANGES = {
  width: [0.1, 3],
  height: [0.1, 3],
  thickness: [0.005, 0.2],
  cell: [0.03, 1],
  bar: [0.003, 0.1],
  border: [0, 0.5],
  seed: [0, 4294967295],
} as const satisfies Record<string, Range>;

const DEFAULT_PATTERN: LatticePattern = 'bubujin';
const DEFAULT_WIDTH = 0.9;
const DEFAULT_HEIGHT = 0.9;
const DEFAULT_THICKNESS = 0.03;
const DEFAULT_CELL = 0.15;
const DEFAULT_BAR = 0.02;
const DEFAULT_BORDER = 0.04;
const COS30 = cos(Math.PI / 6);
const EPS = 1e-12;

type Vec = readonly [number, number];

/** Corners of a square in CCW order: unit position, travel direction in, travel direction out. */
const CORNERS: readonly { readonly at: Vec; readonly uIn: Vec; readonly uOut: Vec }[] = [
  { at: [0, 0], uIn: [0, -1], uOut: [1, 0] },
  { at: [1, 0], uIn: [1, 0], uOut: [0, 1] },
  { at: [1, 1], uIn: [0, 1], uOut: [-1, 0] },
  { at: [0, 1], uIn: [-1, 0], uOut: [0, -1] },
];

interface Resolved {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly thickness: number;
  readonly cell: number;
  readonly bar: number;
  readonly border: number;
  readonly openings: Point2[][];
}

function resolve(options: LatticePatternOptions): Result<Resolved, ModelingError> {
  const name = options.name ?? 'lattice-pattern';
  const pattern = options.pattern ?? DEFAULT_PATTERN;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const thickness = options.thickness ?? DEFAULT_THICKNESS;
  const cell = options.cell ?? DEFAULT_CELL;
  const bar = options.bar ?? DEFAULT_BAR;
  const border = options.border ?? DEFAULT_BORDER;
  if (!(LATTICE_PATTERNS as readonly string[]).includes(pattern)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'pattern is bubujin, guibeijin, binglie or huiwen',
        { pattern: String(pattern) },
        'pass a name from LATTICE_PATTERNS',
      ),
    );
  }
  if (pattern === 'binglie' && options.seed === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'binglie needs an integer seed',
        { pattern },
        'pass seed; the same seed reproduces the layout',
      ),
    );
  }
  const seed = options.seed ?? 0;
  const checked = checkAll([
    () => inRange('width', width, LATTICE_PATTERN_RANGES.width),
    () => inRange('height', height, LATTICE_PATTERN_RANGES.height),
    () => inRange('thickness', thickness, LATTICE_PATTERN_RANGES.thickness),
    () => inRange('cell', cell, LATTICE_PATTERN_RANGES.cell),
    () => inRange('bar', bar, LATTICE_PATTERN_RANGES.bar),
    () => inRange('border', border, LATTICE_PATTERN_RANGES.border),
    () =>
      pattern === 'binglie' ? inRange('seed', seed, LATTICE_PATTERN_RANGES.seed, true) : ok(0),
  ]);
  if (!checked.ok) return checked;
  if (bar >= cell / 2) {
    return err(
      modelingError(
        'model-invalid-argument',
        'bar is below half the cell so every opening keeps a positive size',
        { bar, cell },
        'use a bar under cell / 2',
      ),
    );
  }

  const openings =
    pattern === 'guibeijin'
      ? hexCells(width, height, cell, bar, border)
      : pattern === 'binglie'
        ? seededCells(width, height, cell, bar, border, seed)
        : squareCells(pattern, width, height, cell, bar, border);
  if (openings.length === 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        'at least one opening fits the panel',
        { width, height, cell, border },
        'enlarge the panel or reduce cell and border',
      ),
    );
  }
  return ok({ name, width, height, thickness, cell, bar, border, openings });
}

/**
 * A rectangular panel pierced by one lattice pattern, extruded along +Z from z = 0. Openings are
 * whole cells inset by half a bar, so neighbouring openings are separated by exactly `bar` along
 * shared cell edges. Cells that do not fit inside the border are left solid. Anchors are the
 * panel origin and centre; dimensions include the open-area ratio and the thinnest solid bar.
 */
export function latticePattern(
  options: LatticePatternOptions = {},
): Result<RecipePart, ModelingError> {
  const r = resolve(options);
  if (!r.ok) return r;
  const v = r.value;
  const outline: Point2[] = [
    [0, 0],
    [v.width, 0],
    [v.width, v.height],
    [0, v.height],
  ];
  const m: Model = model();
  m.extrudePolygon({ points: outline, holes: v.openings, depth: v.thickness, label: v.name });
  if (m.poisoned !== undefined) return err(m.poisoned);

  const openArea = v.openings.reduce((sum, p) => sum + polygonArea(p), 0);
  const outlineGap = v.openings.reduce(
    (best, p) => Math.min(best, edgeGap(p, v.width, v.height)),
    Number.POSITIVE_INFINITY,
  );
  const anchors: Record<string, [number, number, number]> = {
    origin: [0, 0, 0],
    center: [v.width / 2, v.height / 2, 0],
  };
  return finishPart(m, v.name, anchors, {
    width: v.width,
    height: v.height,
    thickness: v.thickness,
    cell: v.cell,
    bar: v.bar,
    border: v.border,
    openings: v.openings.length,
    openArea,
    openRatio: openArea / (v.width * v.height),
    minBar: Math.min(v.bar, outlineGap),
  });
}

function squareCells(
  pattern: LatticePattern,
  width: number,
  height: number,
  cell: number,
  bar: number,
  border: number,
): Point2[][] {
  const nx = Math.floor((width - 2 * border) / cell + EPS);
  const ny = Math.floor((height - 2 * border) / cell + EPS);
  const side = cell - bar;
  const step = side / 4;
  const out: Point2[][] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x0 = border + i * cell + bar / 2;
      const y0 = border + j * cell + bar / 2;
      const notched =
        pattern === 'bubujin'
          ? [true, true, true, true]
          : (i + j) % 2 === 0
            ? [true, false, true, false]
            : [false, true, false, true];
      out.push(steppedSquare(x0, y0, side, step, notched));
    }
  }
  return out;
}

/** A square with the flagged corners replaced by a one-step notch of size `q`. */
function steppedSquare(
  x0: number,
  y0: number,
  side: number,
  q: number,
  notched: readonly boolean[],
): Point2[] {
  const out: Point2[] = [];
  CORNERS.forEach((c, k) => {
    const px = x0 + c.at[0] * side;
    const py = y0 + c.at[1] * side;
    if (!notched[k]) {
      out.push([px, py]);
      return;
    }
    out.push([px - q * c.uIn[0], py - q * c.uIn[1]]);
    out.push([px + q * (c.uOut[0] - c.uIn[0]), py + q * (c.uOut[1] - c.uIn[1])]);
    out.push([px + q * c.uOut[0], py + q * c.uOut[1]]);
  });
  return out;
}

/** Flat-top hexagons on a triangular lattice of pitch `cell`, centred on the panel. */
function hexCells(
  width: number,
  height: number,
  cell: number,
  bar: number,
  border: number,
): Point2[][] {
  const apothem = cell / 2 - bar / 2;
  const circumradius = apothem / COS30;
  const reach = Math.ceil(Math.max(width, height) / cell) + 2;
  const margin = border + bar / 2;
  const inside = (p: readonly Point2[]): boolean =>
    p.every(
      ([x, y]) =>
        x >= margin - EPS &&
        x <= width - margin + EPS &&
        y >= margin - EPS &&
        y <= height - margin + EPS,
    );
  const out: Point2[][] = [];
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      const cx = width / 2 + i * cell * COS30;
      const cy = height / 2 + i * (cell / 2) + j * cell;
      const hex: Point2[] = Array.from(
        { length: 6 },
        (_, k) =>
          [
            cx + circumradius * cos((k * Math.PI) / 3),
            cy + circumradius * sin((k * Math.PI) / 3),
          ] as Point2,
      );
      if (inside(hex)) out.push(hex);
    }
  }
  return out;
}

/** Irregular rectangles in rows, with sizes drawn from a seeded generator. */
function seededCells(
  width: number,
  height: number,
  cell: number,
  bar: number,
  border: number,
  seed: number,
): Point2[][] {
  const next = mulberry32(seed);
  const size = (): number => cell * (0.6 + 0.8 * next());
  const d = bar / 2;
  const out: Point2[][] = [];
  let y = border;
  let h = size();
  while (y + h <= height - border) {
    let x = border;
    let w = size();
    while (x + w <= width - border) {
      out.push([
        [x + d, y + d],
        [x + w - d, y + d],
        [x + w - d, y + h - d],
        [x + d, y + h - d],
      ]);
      x += w;
      w = size();
    }
    y += h;
    h = size();
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polygonArea(p: readonly Point2[]): number {
  let twice = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as Point2;
    const b = p[(i + 1) % p.length] as Point2;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

/** Smallest distance from an opening's vertices to the panel outline. */
function edgeGap(p: readonly Point2[], width: number, height: number): number {
  return p.reduce(
    (best, [x, y]) => Math.min(best, x, width - x, y, height - y),
    Number.POSITIVE_INFINITY,
  );
}
