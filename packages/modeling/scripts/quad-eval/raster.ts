// Deterministic CPU renders for one fixed view: wireframe, flat-shaded z-buffer and scaled-Jacobian heatmap.
// PNG bytes come from the engine's encodePng; no GPU is involved, so output is byte-stable across runs.

import { encodePng } from '@forgeax/engine-image/png';
import { boundsOf, cross, dot, type EvalMesh, normalize, type Vec3 } from './mesh.ts';
import type { ElementInfo } from './metrics.ts';

export const RENDER_SIZE = 512;
export const VIEW_AZIMUTH_DEG = 35;
export const VIEW_ELEVATION_DEG = 25;

interface Screen {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Orthographic projection fitted to the reference bounds (90 % of the square). */
export function projector(points: readonly Vec3[]): {
  project(p: Vec3): Screen;
  rotate(n: Vec3): Vec3;
} {
  const az = (VIEW_AZIMUTH_DEG * Math.PI) / 180;
  const el = (VIEW_ELEVATION_DEG * Math.PI) / 180;
  const rot = (p: Vec3): Vec3 => {
    const x1 = Math.cos(az) * p[0] + Math.sin(az) * p[2];
    const z1 = -Math.sin(az) * p[0] + Math.cos(az) * p[2];
    const y2 = Math.cos(el) * p[1] - Math.sin(el) * z1;
    const z2 = Math.sin(el) * p[1] + Math.cos(el) * z1;
    return [x1, y2, z2];
  };
  const rotated = points.map(rot);
  const b = boundsOf(rotated);
  const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], 1e-12);
  const scale = (RENDER_SIZE * 0.9) / span;
  const cx = (b.max[0] + b.min[0]) / 2;
  const cy = (b.max[1] + b.min[1]) / 2;
  const half = RENDER_SIZE / 2;
  return {
    project(p) {
      const r = rot(p);
      return { x: half + (r[0] - cx) * scale, y: half - (r[1] - cy) * scale, z: r[2] };
    },
    rotate: rot,
  };
}

export function blank(fill: readonly [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(RENDER_SIZE * RENDER_SIZE * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = fill[0];
    rgba[i + 1] = fill[1];
    rgba[i + 2] = fill[2];
    rgba[i + 3] = 255;
  }
  return rgba;
}

function plot(rgba: Uint8Array, x: number, y: number, c: readonly [number, number, number]): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= RENDER_SIZE || yi >= RENDER_SIZE) return;
  const o = (yi * RENDER_SIZE + xi) * 4;
  rgba[o] = c[0];
  rgba[o + 1] = c[1];
  rgba[o + 2] = c[2];
}

function line(rgba: Uint8Array, a: Screen, b: Screen, c: readonly [number, number, number]): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    plot(rgba, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, c);
  }
}

export function renderWire(mesh: EvalMesh, fit: readonly Vec3[] = mesh.positions): Uint8Array {
  const proj = projector(fit);
  const rgba = blank([22, 24, 30]);
  const screen = mesh.positions.map((p) => proj.project(p));
  const ink: [number, number, number] = [210, 214, 222];
  const seen = new Set<number>();
  for (const loop of mesh.faces)
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const key = a < b ? a * mesh.positions.length + b : b * mesh.positions.length + a;
      if (seen.has(key)) continue;
      seen.add(key);
      line(rgba, screen[a] as Screen, screen[b] as Screen, ink);
    }
  return rgba;
}

/** Z-buffer over the fan triangles of every face; returns the nearest face id per pixel (-1 = background). */
function zbuffer(mesh: EvalMesh, proj: ReturnType<typeof projector>): Int32Array {
  const ids = new Int32Array(RENDER_SIZE * RENDER_SIZE).fill(-1);
  const depth = new Float64Array(RENDER_SIZE * RENDER_SIZE).fill(Number.NEGATIVE_INFINITY);
  mesh.faces.forEach((loop, face) => {
    const p0 = proj.project(mesh.positions[loop[0] as number] as [number, number, number]);
    for (let i = 1; i + 1 < loop.length; i++) {
      const p1 = proj.project(mesh.positions[loop[i] as number] as [number, number, number]);
      const p2 = proj.project(mesh.positions[loop[i + 1] as number] as [number, number, number]);
      const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
      const maxX = Math.min(RENDER_SIZE - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
      const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
      const maxY = Math.min(RENDER_SIZE - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
      const area = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
      if (area === 0) continue;
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const w0 = ((p1.x - x) * (p2.y - y) - (p2.x - x) * (p1.y - y)) / area;
          const w1 = ((p2.x - x) * (p0.y - y) - (p0.x - x) * (p2.y - y)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * p0.z + w1 * p1.z + w2 * p2.z;
          const o = y * RENDER_SIZE + x;
          if (z > (depth[o] as number)) {
            depth[o] = z;
            ids[o] = face;
          }
        }
    }
  });
  return ids;
}

export function renderShaded(
  mesh: EvalMesh,
  elements: readonly ElementInfo[],
  fit: readonly Vec3[] = mesh.positions,
): Uint8Array {
  const proj = projector(fit);
  const ids = zbuffer(mesh, proj);
  const rgba = blank([22, 24, 30]);
  const normals = mesh.faces.map((loop) => {
    const pts = loop.map((v) => mesh.positions[v] as [number, number, number]);
    let n: Vec3 = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const c = cross(
        pts[i] as [number, number, number],
        pts[(i + 1) % pts.length] as [number, number, number],
      );
      n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]];
    }
    return normalize(proj.rotate(n));
  });
  const light: Vec3 = [0, 0, 1];
  for (let o = 0; o < ids.length; o++) {
    const face = ids[o] as number;
    if (face < 0) continue;
    const element = elements[face];
    const n = normals[face] as [number, number, number];
    const lambert = Math.abs(dot(n, light));
    const shade = element?.degenerate ? 0.4 : 0.2 + 0.8 * lambert;
    rgba[o * 4] = Math.round(190 * shade);
    rgba[o * 4 + 1] = Math.round(196 * shade);
    rgba[o * 4 + 2] = Math.round(206 * shade);
  }
  return rgba;
}

/** Heatmap ramp for scaled Jacobian: blue at 1, teal at 2/3, amber at 1/3, dark red at or below 0. */
const RAMP: readonly { readonly t: number; readonly c: readonly [number, number, number] }[] = [
  { t: 0, c: [170, 20, 20] },
  { t: 1 / 3, c: [230, 200, 60] },
  { t: 2 / 3, c: [60, 170, 120] },
  { t: 1, c: [30, 60, 170] },
];

export function rampColour(sJ: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, sJ));
  for (let i = 1; i < RAMP.length; i++) {
    const hi = RAMP[i] as (typeof RAMP)[number];
    if (t <= hi.t) {
      const lo = RAMP[i - 1] as (typeof RAMP)[number];
      const k = (t - lo.t) / (hi.t - lo.t);
      return [0, 1, 2].map((ch) =>
        Math.round((lo.c[ch] as number) + ((hi.c[ch] as number) - (lo.c[ch] as number)) * k),
      ) as [number, number, number];
    }
  }
  return [30, 60, 170];
}

export function renderJacobian(
  mesh: EvalMesh,
  elements: readonly ElementInfo[],
  fit: readonly Vec3[] = mesh.positions,
): Uint8Array {
  const proj = projector(fit);
  const ids = zbuffer(mesh, proj);
  const rgba = blank([60, 60, 60]);
  for (let o = 0; o < ids.length; o++) {
    const face = ids[o] as number;
    if (face < 0) continue;
    const element = elements[face];
    const c: [number, number, number] =
      element === undefined || element.degenerate ? [255, 0, 255] : rampColour(element.sJ);
    rgba[o * 4] = c[0];
    rgba[o * 4 + 1] = c[1];
    rgba[o * 4 + 2] = c[2];
  }
  return rgba;
}

export function pngOf(rgba: Uint8Array): Uint8Array {
  return encodePng(RENDER_SIZE, RENDER_SIZE, rgba);
}
