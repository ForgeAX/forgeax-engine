import type { TextureAsset } from '@forgeax/engine-types';
import { type BakeSurface, bakeSurface } from '../compute/bake-ts';
import type { NormalMode } from '../finish';
import { decodeSnapshot } from '../fxem';
import type { Model } from '../model';

/**
 * Measurement helpers of the bake quality gates (B20 S1): texel frames of the base atlas,
 * the shaders' normal decode, a bilinear sampler, the seam angle across hard edges, and
 * the analytic rounded box (exact surface normals for the bevelled-box pair).
 */
export type V3 = [number, number, number];

export const norm = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0] as number, v[1] as number, v[2] as number);
  return [(v[0] as number) / l, (v[1] as number) / l, (v[2] as number) / l];
};
export const dot3 = (a: readonly number[], b: readonly number[]) =>
  (a[0] as number) * (b[0] as number) +
  (a[1] as number) * (b[1] as number) +
  (a[2] as number) * (b[2] as number);
export const cross3 = (a: readonly number[], b: readonly number[]): V3 => [
  (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number),
  (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number),
  (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number),
];
export const degrees = (a: readonly number[], b: readonly number[]) =>
  (Math.acos(Math.min(1, Math.max(-1, dot3(norm(a), norm(b))))) * 180) / Math.PI;

export function surfaceOf(
  m: Model,
  normals: Exclude<NormalMode, { readonly mode: 'transfer' }> = { mode: 'smooth' },
): BakeSurface {
  const mesh = decodeSnapshot(m.snapshot());
  if (!mesh.ok) throw mesh.error;
  const s = bakeSurface(mesh.value, normals);
  if (!s.ok) throw s.error;
  return s.value;
}

export interface TexelFrame {
  readonly x: number;
  readonly y: number;
  readonly p: V3;
  readonly n: V3;
  readonly t: V3;
  readonly w: number;
  /** Render triangle and barycentric weights of the texel center. */
  readonly triangle: number;
  readonly bary: readonly [number, number, number];
}

/** Texel centers covered by the base atlas with their interpolated vertex frame. */
export function texelFrames(s: BakeSurface, size: number): TexelFrame[] {
  const out: TexelFrame[] = [];
  const seen = new Uint8Array(size * size);
  for (let t = 0; t < s.indices.length / 3; t++) {
    const id = [0, 1, 2].map((k) => s.indices[t * 3 + k] as number);
    const uv = id.map((i) => [
      (s.uv[i * 2] as number) * size,
      (s.uv[i * 2 + 1] as number) * size,
    ]) as [[number, number], [number, number], [number, number]];
    const [p0, p1, p2] = uv;
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (area === 0) continue;
    const x0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
    const x1 = Math.min(size - 1, Math.floor(Math.max(p0[0], p1[0], p2[0])));
    const y0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
    const y1 = Math.min(size - 1, Math.floor(Math.max(p0[1], p1[1], p2[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (seen[y * size + x] === 1) continue;
        const px = x + 0.5;
        const py = y + 0.5;
        const w1 = ((px - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (py - p0[1])) / area;
        const w2 = ((p1[0] - p0[0]) * (py - p0[1]) - (px - p0[0]) * (p1[1] - p0[1])) / area;
        const w = [1 - w1 - w2, w1, w2] as const;
        if (w.some((c) => c < 0)) continue;
        seen[y * size + x] = 1;
        const lerp = (a: Float32Array, width: number, c: number) =>
          id.reduce((sum, i, k) => sum + (w[k] as number) * (a[i * width + c] as number), 0);
        out.push({
          x,
          y,
          p: [0, 1, 2].map((c) => lerp(s.position, 3, c)) as V3,
          n: norm([0, 1, 2].map((c) => lerp(s.normal, 3, c))),
          t: [0, 1, 2].map((c) => lerp(s.tangent, 4, c)) as V3,
          w: lerp(s.tangent, 4, 3),
          triangle: t,
          bary: w,
        });
      }
    }
  }
  return out;
}

/** The shaders' decode of a tangent normal (RG, z reconstructed) through applyTBN. */
export function applyTbn(rgb: readonly number[], n: V3, t: V3, w: number): V3 {
  const x = (rgb[0] as number) * 2 - 1;
  const y = (rgb[1] as number) * 2 - 1;
  const tn: V3 = [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
  const n0 = norm(n);
  const d = dot3(t, n0);
  const t0 = norm([t[0] - d * n0[0], t[1] - d * n0[1], t[2] - d * n0[2]]);
  const b0 = cross3(n0, t0).map((c) => c * (w === 0 ? 1 : w)) as V3;
  return norm(
    [0, 1, 2].map(
      (c) => (t0[c] as number) * tn[0] + (b0[c] as number) * tn[1] + (n0[c] as number) * tn[2],
    ),
  );
}

/** Mip-0 texel of an rgba8 texture, normalized. */
export function texel(texture: TextureAsset, size: number, x: number, y: number): number[] {
  const data = texture.data as Uint8Array;
  const o = (y * size + x) * 4;
  return [0, 1, 2, 3].map((c) => (data[o + c] as number) / 255);
}

/** Bilinear mip-0 sample at atlas uv (clamped), as the Renderer's linear filter does. */
export function bilinear(texture: TextureAsset, size: number, u: number, v: number): number[] {
  const x = u * size - 0.5;
  const y = v * size - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (i: number, j: number) =>
    texel(texture, size, Math.min(size - 1, Math.max(0, i)), Math.min(size - 1, Math.max(0, j)));
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  return [0, 1, 2, 3].map(
    (k) =>
      ((a[k] as number) * (1 - fx) + (b[k] as number) * fx) * (1 - fy) +
      ((c[k] as number) * (1 - fx) + (d[k] as number) * fx) * fy,
  );
}

/**
 * Seam angles across the base's hard edges: points along every render edge whose
 * endpoints are shared by another triangle with other render vertices (a split edge);
 * each side bilinear-samples the normal map at its own uv and decodes it with its own
 * frame, and the angle between the two world normals is what a renderer shows there.
 */
export function seamAngles(s: BakeSurface, normal: TextureAsset, size: number, steps = 32) {
  const key = (i: number) =>
    [0, 1, 2].map((c) => (s.position[i * 3 + c] as number).toFixed(6)).join(',');
  const sides = new Map<string, { a: number; b: number }[]>();
  for (let t = 0; t < s.indices.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const a = s.indices[t * 3 + k] as number;
      const b = s.indices[t * 3 + ((k + 1) % 3)] as number;
      const [ka, kb] = [key(a), key(b)];
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const list = sides.get(id) ?? [];
      list.push(ka < kb ? { a, b } : { a: b, b: a });
      sides.set(id, list);
    }
  }
  const lerp = (a: Float32Array, width: number, i: number, j: number, u: number) =>
    Array.from(
      { length: width },
      (_, c) => (a[i * width + c] as number) * (1 - u) + (a[j * width + c] as number) * u,
    );
  const out: { angle: number; p: V3 }[] = [];
  for (const list of sides.values()) {
    if (list.length !== 2) continue;
    const [e, f] = list as [{ a: number; b: number }, { a: number; b: number }];
    if (e.a === f.a && e.b === f.b) continue;
    for (let k = 1; k < steps; k++) {
      const u = k / steps;
      const world = (side: { a: number; b: number }) => {
        const uv = lerp(s.uv, 2, side.a, side.b, u);
        const n = norm(lerp(s.normal, 3, side.a, side.b, u));
        const t = lerp(s.tangent, 4, side.a, side.b, u);
        return applyTbn(
          bilinear(normal, size, uv[0] as number, uv[1] as number),
          n,
          t.slice(0, 3) as V3,
          t[3] as number,
        );
      };
      out.push({ angle: degrees(world(e), world(f)), p: lerp(s.position, 3, e.a, e.b, u) as V3 });
    }
  }
  return out;
}

/** Signed distance of the rounded box with half extents `h` and edge radius `r`. */
export function roundedBoxSdf(p: readonly number[], h: number, r: number): number {
  const q = p.map((x) => Math.abs(x) - (h - r));
  const outside = Math.hypot(...q.map((x) => Math.max(x, 0)));
  return outside + Math.min(Math.max(q[0] as number, q[1] as number, q[2] as number), 0) - r;
}

/** Exact unit normal of the rounded box at a surface point. */
export function roundedBoxNormal(p: readonly number[], h: number, r: number): V3 {
  const c = p.map((x) => Math.min(h - r, Math.max(-(h - r), x)));
  const d = p.map((x, i) => x - (c[i] as number));
  if (Math.hypot(...d) > 1e-12) return norm(d);
  const a = p.map(Math.abs);
  const i =
    (a[0] as number) >= (a[1] as number) && (a[0] as number) >= (a[2] as number)
      ? 0
      : (a[1] as number) >= (a[2] as number)
        ? 1
        : 2;
  const n: V3 = [0, 0, 0];
  n[i] = Math.sign(p[i] as number);
  return n;
}

/** First hit of a ray with the rounded box by sphere tracing, or undefined within `tmax`. */
export function traceRoundedBox(o: V3, d: V3, tmax: number, h: number, r: number): V3 | undefined {
  let t = 0;
  for (let i = 0; i < 512 && t <= tmax; i++) {
    const p: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const s = roundedBoxSdf(p, h, r);
    if (Math.abs(s) < 1e-9) return p;
    t += Math.abs(s);
  }
  return undefined;
}

export const percentile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] as number);
};
export const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
