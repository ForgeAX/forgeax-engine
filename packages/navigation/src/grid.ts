import { err, type Result } from '@forgeax/engine-types';
import { invalidInput, type NavigationError } from './errors';
import {
  compileNavigationGridGraph,
  NAVIGATION_MAX_NODES,
  type NavigationEdge,
  type NavigationGraph,
} from './graph';

export interface NavigationGridSource {
  readonly width: number;
  readonly height: number;
  readonly cellSize?: number;
  readonly origin?: readonly [number, number, number];
  /** XY for 2D, XZ for ground movement in 3D. */
  readonly plane?: 'xy' | 'xz';
  /** Row-major, node = row * width + column; non-zero means blocked. */
  readonly blocked?: ArrayLike<number>;
  /** Positive per-cell entering cost multiplier, copied during construction. */
  readonly weights?: ArrayLike<number>;
  /** Diagonals require both adjacent cardinal cells to be unblocked. */
  readonly diagonal?: boolean;
}

export function createNavigationGrid(
  source: NavigationGridSource,
): Result<NavigationGraph, NavigationError> {
  const { width, height } = source;
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    width * height > NAVIGATION_MAX_NODES
  ) {
    return err(
      invalidInput(
        'dimensions',
        [width, height],
        `Positive integer dimensions with at most ${NAVIGATION_MAX_NODES} cells`,
      ),
    );
  }
  const cellSize = source.cellSize ?? 1;
  if (!Number.isFinite(cellSize) || cellSize <= 0)
    return err(invalidInput('cellSize', cellSize, 'Positive finite cell size'));
  const plane = source.plane ?? 'xz';
  if (plane !== 'xy' && plane !== 'xz') return err(invalidInput('plane', plane, 'xy or xz'));
  const origin = source.origin ?? [0, 0, 0];
  if (origin.length !== 3 || !origin.every(Number.isFinite))
    return err(invalidInput('origin', origin, 'Three finite coordinates'));
  const count = width * height;
  for (const field of ['blocked', 'weights'] as const) {
    const values = source[field];
    if (values !== undefined && values.length !== count)
      return err(invalidInput(`${field}.length`, values.length, `${count}`));
  }
  const blocked = new Uint8Array(count);
  const weights = new Float64Array(count);
  for (let id = 0; id < count; id++) {
    const solid = source.blocked?.[id] ?? 0;
    const weight = source.weights?.[id] ?? 1;
    if (!Number.isFinite(solid)) return err(invalidInput(`blocked[${id}]`, solid, 'Finite number'));
    if (
      !Number.isFinite(weight) ||
      weight <= 0 ||
      weight * cellSize * Math.SQRT2 > Number.MAX_VALUE / NAVIGATION_MAX_NODES
    )
      return err(invalidInput(`weights[${id}]`, weight, 'Positive finite bounded cost multiplier'));
    blocked[id] = solid === 0 ? 0 : 1;
    weights[id] = weight;
  }
  const positions = new Float32Array(count * 3);
  const edges: NavigationEdge[] = [];
  const directions = source.diagonal
    ? [
        [-1, 0],
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]
    : [
        [-1, 0],
        [0, -1],
        [1, 0],
        [0, 1],
      ];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const id = row * width + column;
      positions[id * 3] = origin[0] + column * cellSize;
      positions[id * 3 + 1] = origin[1] + (plane === 'xy' ? row * cellSize : 0);
      positions[id * 3 + 2] = origin[2] + (plane === 'xz' ? row * cellSize : 0);
      if (blocked[id]) continue;
      for (const [dx, dy] of directions) {
        const x = column + (dx as number);
        const y = row + (dy as number);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const to = y * width + x;
        if (blocked[to]) continue;
        if (dx !== 0 && dy !== 0 && (blocked[row * width + x] || blocked[y * width + column]))
          continue;
        edges.push({
          from: id,
          to,
          cost: cellSize * (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * (weights[to] as number),
        });
      }
    }
  }
  return compileNavigationGridGraph({ positions, edges, blocked }, source.diagonal ?? false);
}
