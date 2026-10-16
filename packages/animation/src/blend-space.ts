import { err, ok, type Result } from '@forgeax/engine-types';
import { AnimationBlendError } from './blend-errors';

type SpaceError = AnimationBlendError<'animation-blend-space-invalid'>;
const invalid = (field: SpaceError['detail']['field'], reason: string, index?: number) =>
  err(
    new AnimationBlendError('animation-blend-space-invalid', {
      field,
      reason,
      ...(index === undefined ? {} : { index }),
    }),
  );

export interface BlendSpace1D {
  readonly sampleCount: number;
  /** Overwrites all weights in original sample order. No clock or World mutation. */
  sample(weights: Float32Array, position: number): Result<void, SpaceError>;
}

export interface BlendSpace2D {
  readonly sampleCount: number;
  /** Barycentric interpolation, or projection to the nearest authored triangle boundary. */
  sample(weights: Float32Array, x: number, y: number): Result<void, SpaceError>;
}

export interface BlendSpace2DOptions {
  readonly points: readonly (readonly [number, number])[];
  readonly triangles: readonly (readonly [number, number, number])[];
}

function validateOutput(weights: Float32Array, count: number): Result<void, SpaceError> {
  return weights instanceof Float32Array && weights.length === count
    ? ok(undefined)
    : invalid('weights', `provide a Float32Array with exactly ${count} entries`);
}

/** Compile a bounded, copied sample layout; only the nearest two samples contribute. */
export function createBlendSpace1D(samples: readonly number[]): Result<BlendSpace1D, SpaceError> {
  if (samples.length === 0 || samples.length > 4096)
    return invalid('samples', 'provide between 1 and 4096 samples');
  const sorted = samples.map((position, index) => ({ position, index }));
  for (const { position, index } of sorted)
    if (!Number.isFinite(position))
      return invalid('samples', 'sample positions must be finite', index);
  sorted.sort((a, b) => a.position - b.position);
  for (let i = 1; i < sorted.length; i++) {
    const width = (sorted[i]?.position ?? 0) - (sorted[i - 1]?.position ?? 0);
    if (width <= 0 || !Number.isFinite(width))
      return invalid('samples', 'neighboring positions must be distinct with a finite interval', i);
  }
  const sampleCount = sorted.length;
  return ok({
    sampleCount,
    sample(weights, position) {
      const checked = validateOutput(weights, sampleCount);
      if (!checked.ok) return checked;
      if (!Number.isFinite(position)) return invalid('position', 'position must be finite');
      let lo = 0,
        hi = sampleCount - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((sorted[mid]?.position ?? 0) < position) lo = mid + 1;
        else hi = mid;
      }
      const upper = sorted[lo];
      const lower = sorted[Math.max(0, lo - 1)];
      if (upper === undefined || lower === undefined)
        return invalid('samples', 'missing compiled sample');
      weights.fill(0);
      if (lo === 0 || position >= upper.position) weights[upper.index] = 1;
      else {
        const t = (position - lower.position) / (upper.position - lower.position);
        weights[lower.index] = 1 - t;
        weights[upper.index] = t;
      }
      return ok(undefined);
    },
  });
}

interface Triangle {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly cx: number;
  readonly cy: number;
  readonly inverseArea: number;
}

/** Compile explicit topology once, preserving sample order and either winding. */
export function createBlendSpace2D(options: BlendSpace2DOptions): Result<BlendSpace2D, SpaceError> {
  const { points, triangles } = options;
  if (points.length < 3 || points.length > 4096)
    return invalid('samples', 'provide between 3 and 4096 points');
  if (triangles.length === 0 || triangles.length > 8192)
    return invalid('triangles', 'provide between 1 and 8192 triangles');
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const positions = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (
      point === undefined ||
      point.length !== 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    )
      return invalid('samples', 'each point needs two finite coordinates', i);
    const key = `${point[0]},${point[1]}`;
    if (positions.has(key)) return invalid('samples', 'point positions must be distinct', i);
    positions.add(key);
    minX = Math.min(minX, point[0]);
    maxX = Math.max(maxX, point[0]);
    minY = Math.min(minY, point[1]);
    maxY = Math.max(maxY, point[1]);
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  if (!(extent > 0) || !Number.isFinite(extent))
    return invalid('samples', 'sample extent must be positive and finite');
  const x = new Float64Array(points.length),
    y = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === undefined) continue;
    x[i] = (point[0] - minX) / extent;
    y[i] = (point[1] - minY) / extent;
  }
  const compiled: Triangle[] = [];
  const covered = new Set<number>();
  const unique = new Set<string>();
  for (let i = 0; i < triangles.length; i++) {
    const triangle = triangles[i];
    if (
      triangle === undefined ||
      triangle.length !== 3 ||
      triangle.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= points.length)
    )
      return invalid('triangles', 'triangle indices must name three sample points', i);
    const [a, b, c] = triangle;
    const key = [...triangle].sort((left, right) => left - right).join(',');
    if (unique.has(key)) return invalid('triangles', 'triangles must not be duplicated', i);
    unique.add(key);
    const ax = x[a] ?? 0,
      ay = y[a] ?? 0,
      bx = x[b] ?? 0,
      by = y[b] ?? 0,
      cx = x[c] ?? 0,
      cy = y[c] ?? 0;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) <= 1e-12)
      return invalid('triangles', 'triangle area must exceed 1e-12 of squared layout extent', i);
    compiled.push({ a, b, c, ax, ay, bx, by, cx, cy, inverseArea: 1 / area });
    covered.add(a);
    covered.add(b);
    covered.add(c);
  }
  if (covered.size !== points.length)
    return invalid('triangles', 'every sample must belong to a triangle');
  const sampleCount = points.length;
  return ok({
    sampleCount,
    sample(weights, px, py) {
      const checked = validateOutput(weights, sampleCount);
      if (!checked.ok) return checked;
      const qx = (px - minX) / extent,
        qy = (py - minY) / extent;
      if (
        !Number.isFinite(qx) ||
        !Number.isFinite(qy) ||
        Math.max(Math.abs(qx), Math.abs(qy)) > 1e150
      )
        return invalid(
          'position',
          'provide finite coordinates within representable layout distance',
        );
      for (const triangle of compiled) {
        const { ax, ay, bx, by, cx, cy, inverseArea } = triangle;
        const wb = ((qx - ax) * (cy - ay) - (qy - ay) * (cx - ax)) * inverseArea;
        const wc = ((bx - ax) * (qy - ay) - (by - ay) * (qx - ax)) * inverseArea;
        const wa = 1 - wb - wc;
        if (wa >= -1e-12 && wb >= -1e-12 && wc >= -1e-12) {
          const a = Math.max(0, wa),
            b = Math.max(0, wb),
            c = Math.max(0, wc),
            sum = a + b + c;
          weights.fill(0);
          weights[triangle.a] = a / sum;
          weights[triangle.b] = b / sum;
          weights[triangle.c] = c / sum;
          return ok(undefined);
        }
      }
      let distance = Infinity,
        from = 0,
        to = 0,
        fraction = 0;
      for (const triangle of compiled) {
        for (let edge = 0; edge < 3; edge++) {
          const a = edge === 0 ? triangle.a : edge === 1 ? triangle.b : triangle.c;
          const b = edge === 0 ? triangle.b : edge === 1 ? triangle.c : triangle.a;
          const ax = x[a] ?? 0,
            ay = y[a] ?? 0,
            dx = (x[b] ?? 0) - ax,
            dy = (y[b] ?? 0) - ay;
          const t = Math.max(
            0,
            Math.min(1, ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy)),
          );
          const ex = qx - ax - t * dx,
            ey = qy - ay - t * dy;
          const candidate = ex * ex + ey * ey;
          if (candidate < distance) {
            distance = candidate;
            from = a;
            to = b;
            fraction = t;
          }
        }
      }
      weights.fill(0);
      weights[from] = 1 - fraction;
      weights[to] = fraction;
      return ok(undefined);
    },
  });
}
