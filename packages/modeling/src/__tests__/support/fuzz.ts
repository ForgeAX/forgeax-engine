import type { Tuple3 } from '../../geom';
import { type Model, model } from '../../model';

/** mulberry32: the one seeded generator of the kernel tests; draws are in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FuzzOp = 'union' | 'difference' | 'intersection';
export type FuzzKind = 'box' | 'cylinder' | 'sphere';

export interface SceneOptions {
  /** Primitives in the scene; the first is the target, each later one is a tool. */
  readonly primitives: number;
  /** Snap size of positions and sizes in meters (default 1/64: exact in binary floating point). */
  readonly grid?: number;
  /** Operation applied to tool i is `ops[(i - 1) % ops.length]`; required when primitives > 1. */
  readonly ops: readonly FuzzOp[];
}

export interface FuzzPrimitive {
  readonly kind: FuzzKind;
  /** Center and half-extents, in grid cells. */
  readonly center: Tuple3;
  readonly half: Tuple3;
  readonly segments: number;
}

export const DEFAULT_GRID = 1 / 64;
const SPAN = 2;
const HALF = 4;

function between(draw: () => number, lo: number, hi: number): number {
  return lo + Math.floor(draw() * (hi - lo + 1));
}

function primitive(draw: () => number): FuzzPrimitive {
  const pick = draw();
  const kind: FuzzKind = pick < 0.6 ? 'box' : pick < 0.85 ? 'cylinder' : 'sphere';
  const center: Tuple3 = [
    between(draw, -SPAN, SPAN),
    between(draw, -SPAN, SPAN),
    between(draw, -SPAN, SPAN),
  ];
  const a = between(draw, 1, HALF);
  const b = between(draw, 1, HALF);
  const c = between(draw, 1, HALF);
  const segments = 2 * between(draw, 3, 8);
  if (kind === 'box') return { kind, center, half: [a, b, c], segments };
  if (kind === 'cylinder') return { kind, center, half: [a, b, a], segments };
  return { kind, center, half: [a, a, a], segments };
}

function place(m: Model, p: FuzzPrimitive, grid: number): void {
  const center: Tuple3 = [p.center[0] * grid, p.center[1] * grid, p.center[2] * grid];
  const half = p.half.map((h) => h * grid) as unknown as Tuple3;
  if (p.kind === 'box') {
    m.box({ size: [2 * half[0], 2 * half[1], 2 * half[2]], center });
  } else if (p.kind === 'cylinder') {
    m.cylinder({
      radiusTop: half[0],
      radiusBottom: half[0],
      height: 2 * half[1],
      radialSegments: p.segments,
      center,
    });
  } else {
    m.sphere({
      radius: half[0],
      widthSegments: p.segments,
      heightSegments: Math.max(2, p.segments / 2),
      center,
    });
  }
}

export interface Scene {
  readonly primitives: readonly FuzzPrimitive[];
  /** Appends the target and applies each tool with its operation; failures stay on the session. */
  build(m: Model): void;
  /** A reproducer: the arguments and every primitive in grid cells. */
  describe(): string;
}

/**
 * A seeded scene of axis-aligned primitives on a coarse grid. Centers and half-extents are
 * whole grid cells, so box faces, cylinder caps and sphere poles fall on shared grid planes
 * and coplanar, coincident and tangent contacts occur on purpose and are exact in binary
 * floating point. The same seed and options give the same primitives, session and FXEM bytes.
 */
export function scene(seed: number, options: SceneOptions): Scene {
  if (options.primitives > 1 && options.ops.length === 0) {
    throw new Error('a scene with tools needs at least one op');
  }
  const grid = options.grid ?? DEFAULT_GRID;
  const draw = mulberry32(seed);
  const primitives = Array.from({ length: options.primitives }, () => primitive(draw));
  return {
    primitives,
    build(m) {
      for (const [i, p] of primitives.entries()) {
        if (i === 0) {
          place(m, p, grid);
          continue;
        }
        const tool = model();
        place(tool, p, grid);
        m[options.ops[(i - 1) % options.ops.length] as FuzzOp](tool);
      }
    },
    describe() {
      const parts = primitives.map(
        (p) =>
          `${p.kind} c=[${p.center.join(',')}] h=[${p.half.join(',')}]${p.kind === 'box' ? '' : ` n=${p.segments}`}`,
      );
      const ops = options.ops.join(',');
      return `scene(${seed}, { primitives: ${options.primitives}, grid: ${grid}, ops: [${ops}] }): ${parts.join('; ')}`;
    },
  };
}
