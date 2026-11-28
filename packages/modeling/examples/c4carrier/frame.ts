import type { View } from '../case/render.ts';

/**
 * A camera that fits the actual mesh vertices to `fill` of the limiting image axis (the case
 * renderer's `frame` fits the bounding sphere, which leaves a hero subject at ~40% of the frame).
 * Iterates the eye distance and re-centres the target on the projected extents.
 */
export function fitView(positions: ArrayLike<number>, direction: readonly number[], aspect: number, fov: number, fill = 0.84): View {
  const n = Math.floor(positions.length / 3);
  const l = Math.hypot(direction[0] as number, direction[1] as number, direction[2] as number);
  const f = [-(direction[0] as number) / l, -(direction[1] as number) / l, -(direction[2] as number) / l];
  const rr = [f[1] as number * 0 - (f[2] as number), 0, f[0] as number];
  const rl = Math.hypot(rr[0] as number, rr[2] as number) || 1;
  const right = [(rr[0] as number) / rl, 0, (rr[2] as number) / rl];
  const up = [
    right[1] as number * (f[2] as number) - (right[2] as number) * (f[1] as number),
    (right[2] as number) * (f[0] as number) - (right[0] as number) * (f[2] as number),
    (right[0] as number) * (f[1] as number) - (right[1] as number) * (f[0] as number),
  ];
  const th = Math.tan(fov / 2);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const v = positions[i * 3 + k] as number;
    if (v < (min[k] as number)) min[k] = v;
    if (v > (max[k] as number)) max[k] = v;
  }
  const target = [0, 1, 2].map((k) => ((min[k] as number) + (max[k] as number)) / 2);
  const radius = Math.hypot(max[0] as number - (min[0] as number), max[1] as number - (min[1] as number), max[2] as number - (min[2] as number)) / 2;
  let dist = radius / Math.sin(fov / 2);
  for (let it = 0; it < 40; it++) {
    const eye = target.map((c, k) => c - (f[k] as number) * dist);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = [0, 1, 2].map((k) => (positions[i * 3 + k] as number) - (eye[k] as number));
      const z = (d[0] as number) * (f[0] as number) + (d[1] as number) * (f[1] as number) + (d[2] as number) * (f[2] as number);
      const x = ((d[0] as number) * (right[0] as number) + (d[2] as number) * (right[2] as number)) / (z * th * aspect);
      const y = ((d[0] as number) * (up[0] as number) + (d[1] as number) * (up[1] as number) + (d[2] as number) * (up[2] as number)) / (z * th);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    for (let k = 0; k < 3; k++) target[k] = (target[k] as number) + (right[k] as number) * cx * th * aspect * dist + (up[k] as number) * cy * th * dist;
    const half = Math.max((x1 - x0) / 2, (y1 - y0) / 2);
    dist *= half / fill;
  }
  const eye = target.map((c, k) => c - (f[k] as number) * dist);
  return { eye: eye as [number, number, number], target: target as [number, number, number] };
}

/** Float32 positions of a MeshAsset (interleaved vertices are not used by the modeling mesh). */
export function meshPositions(mesh: { readonly attributes: { readonly position?: unknown } }): Float32Array {
  const p = mesh.attributes.position;
  if (p instanceof Float32Array) return p;
  if (p instanceof ArrayBuffer) return new Float32Array(p);
  throw new Error('mesh has no float position attribute');
}

/** Constant diffuse irradiance of the turret case renders: the bevel and underside faces that neither light reaches stay readable instead of exact black. */
export const TURRET_AMBIENT = [1, 1, 1] as const;
