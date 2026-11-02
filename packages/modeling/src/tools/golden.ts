/**
 * Golden bake harness (U40, R7 3.6 / BK9): analytic shapes with exact surfaces, normals and
 * occlusion, against which a bake is measured in object space (tangent-frame independent).
 * Each case builds a low-poly base with uv0 and a dense detail mesh of the same analytic
 * surface; `goldenReport` decodes every covered texel through the shaders' `applyTBN`
 * with the base's exported frame and compares it with the analytic normal where the bake
 * ray meets the true surface, and the AO texel with the analytic open fraction of the
 * same ray cone.
 */

import {
  type BakeSurface,
  bakeSurface,
  decodeSnapshot,
  type Model,
  model,
  sel,
} from '@forgeax/engine-modeling';
import type { TextureAsset } from '@forgeax/engine-types';
import { maxOf } from '../arrays';
import type { BakeResult } from '../bake';
import type { NormalMode } from '../finish';
import type { Issue } from '../report';
import type { ValidationCode } from '../validate';

type V3 = readonly [number, number, number];

export type GoldenShape = 'sphere' | 'cylinder' | 'bevelledBox' | 'torus';

/** An analytic closed surface: signed distance (negative inside) and its unit normal. */
export interface AnalyticSurface {
  readonly sdf: (p: V3) => number;
  readonly normal: (p: V3) => V3;
  /** A convex surface occludes nothing above its tangent planes: AO is exactly 1. */
  readonly convex: boolean;
}

export interface GoldenCase {
  readonly shape: GoldenShape;
  /** Low-poly receiver with uv0. */
  readonly base: Model;
  /** Dense tessellation of the analytic surface. */
  readonly detail: Model;
  readonly surface: AnalyticSurface;
  /** Base export normals the bake and the renderer use. */
  readonly normals: NormalMode;
}

const len = (v: readonly number[]) => Math.hypot(...v);
const unit = (v: readonly number[]): V3 => {
  const l = len(v) || 1;
  return [(v[0] as number) / l, (v[1] as number) / l, (v[2] as number) / l];
};
const dot = (a: readonly number[], b: readonly number[]) =>
  (a[0] as number) * (b[0] as number) +
  (a[1] as number) * (b[1] as number) +
  (a[2] as number) * (b[2] as number);
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const at = (p: V3, d: V3, s: number): V3 => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];

/** Analytic surfaces of the golden shapes (dimensions match `goldenCase`). */
export const GOLDEN_SURFACES: Readonly<Record<GoldenShape, AnalyticSurface>> = {
  sphere: { sdf: (p) => len(p) - 0.5, normal: (p) => unit(p), convex: true },
  cylinder: {
    // Radius 0.4 along y, height 1.
    sdf: (p) => {
      const dx = Math.hypot(p[0], p[2]) - 0.4;
      const dy = Math.abs(p[1]) - 0.5;
      return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    },
    normal: (p) => {
      const r = Math.hypot(p[0], p[2]) || 1;
      const dx = Math.hypot(p[0], p[2]) - 0.4;
      const dy = Math.abs(p[1]) - 0.5;
      const sy = Math.sign(p[1]) || 1;
      if (dx > 0 && dy > 0) return unit([(p[0] / r) * dx, sy * dy, (p[2] / r) * dx]);
      return dx > dy ? [p[0] / r, 0, p[2] / r] : [0, sy, 0];
    },
    convex: true,
  },
  bevelledBox: {
    // A unit box whose edges are rounded with radius 0.1: inner box half 0.4.
    sdf: (p) => {
      const q = p.map((c) => Math.abs(c) - 0.4);
      return len(q.map((c) => Math.max(c, 0))) + Math.min(maxOf(q), 0) - 0.1;
    },
    normal: (p) => {
      const q = p.map((c) => Math.abs(c) - 0.4);
      if (q.some((c) => c > 0))
        return unit(q.map((c, k) => Math.max(c, 0) * (Math.sign(p[k] as number) || 1)));
      const k = q.indexOf(maxOf(q));
      return [0, 1, 2].map((i) => (i === k ? Math.sign(p[i] as number) || 1 : 0)) as unknown as V3;
    },
    convex: true,
  },
  torus: {
    // Ring radius 0.5 in xy around +z, tube radius 0.2.
    sdf: (p) => Math.hypot(Math.hypot(p[0], p[1]) - 0.5, p[2]) - 0.2,
    normal: (p) => {
      const r = Math.hypot(p[0], p[1]) || 1;
      return unit([p[0] - (0.5 * p[0]) / r, p[1] - (0.5 * p[1]) / r, p[2]]);
    },
    convex: false,
  },
};

/** The low/high pair of a golden shape; `uv` is the base's `uv.auto` resolution. */
export function goldenCase(shape: GoldenShape, uv = 256): GoldenCase {
  const base = model();
  const detail = model();
  switch (shape) {
    case 'sphere':
      base.sphere({ radius: 0.5, widthSegments: 16, heightSegments: 8 });
      detail.sphere({ radius: 0.5, widthSegments: 192, heightSegments: 96 });
      break;
    case 'cylinder':
      base.cylinder({ radiusTop: 0.4, radiusBottom: 0.4, height: 1, radialSegments: 12 });
      detail.cylinder({ radiusTop: 0.4, radiusBottom: 0.4, height: 1, radialSegments: 192 });
      break;
    case 'bevelledBox':
      base.box({ size: [1, 1, 1] });
      detail.box({ size: [1, 1, 1] });
      detail.bevel(sel.edges.all(), { width: 0.1, segments: 12 });
      break;
    case 'torus':
      base.torus({ radius: 0.5, tube: 0.2, radialSegments: 8, tubularSegments: 16 });
      detail.torus({ radius: 0.5, tube: 0.2, radialSegments: 96, tubularSegments: 192 });
      break;
  }
  base.uv.auto({ resolution: uv, padding: 4 });
  return { shape, base, detail, surface: GOLDEN_SURFACES[shape], normals: { mode: 'smooth' } };
}

export interface GoldenTexel {
  readonly x: number;
  readonly y: number;
  /** Base surface point, unit normal, tangent and handedness at the texel center. */
  readonly p: V3;
  readonly n: V3;
  readonly t: V3;
  readonly w: number;
}

/** Texel centers covered by the base's uv0 with their interpolated export frame. */
export function goldenTexels(s: BakeSurface, size: number): GoldenTexel[] {
  const out: GoldenTexel[] = [];
  const seen = new Uint8Array(size * size);
  for (let t = 0; t < s.indices.length / 3; t++) {
    const id = [0, 1, 2].map((k) => s.indices[t * 3 + k] as number);
    const uv = id.map((i) => [(s.uv[i * 2] as number) * size, (s.uv[i * 2 + 1] as number) * size]);
    const [p0, p1, p2] = uv as [number[], number[], number[]];
    const area =
      ((p1[0] as number) - (p0[0] as number)) * ((p2[1] as number) - (p0[1] as number)) -
      ((p2[0] as number) - (p0[0] as number)) * ((p1[1] as number) - (p0[1] as number));
    if (area === 0) continue;
    const x0 = Math.max(0, Math.floor(Math.min(p0[0] as number, p1[0] as number, p2[0] as number)));
    const x1 = Math.min(
      size - 1,
      Math.ceil(Math.max(p0[0] as number, p1[0] as number, p2[0] as number)),
    );
    const y0 = Math.max(0, Math.floor(Math.min(p0[1] as number, p1[1] as number, p2[1] as number)));
    const y1 = Math.min(
      size - 1,
      Math.ceil(Math.max(p0[1] as number, p1[1] as number, p2[1] as number)),
    );
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (seen[y * size + x] === 1) continue;
        const px = x + 0.5 - (p0[0] as number);
        const py = y + 0.5 - (p0[1] as number);
        const w1 =
          (px * ((p2[1] as number) - (p0[1] as number)) -
            ((p2[0] as number) - (p0[0] as number)) * py) /
          area;
        const w2 =
          (((p1[0] as number) - (p0[0] as number)) * py -
            px * ((p1[1] as number) - (p0[1] as number))) /
          area;
        const w = [1 - w1 - w2, w1, w2];
        if (w.some((c) => c < 0)) continue;
        seen[y * size + x] = 1;
        const lerp = (a: Float32Array, width: number, c: number) =>
          id.reduce((sum, i, k) => sum + (w[k] as number) * (a[i * width + c] as number), 0);
        out.push({
          x,
          y,
          p: [lerp(s.position, 3, 0), lerp(s.position, 3, 1), lerp(s.position, 3, 2)],
          n: unit([lerp(s.normal, 3, 0), lerp(s.normal, 3, 1), lerp(s.normal, 3, 2)]),
          t: [lerp(s.tangent, 4, 0), lerp(s.tangent, 4, 1), lerp(s.tangent, 4, 2)],
          w: lerp(s.tangent, 4, 3),
        });
      }
    }
  }
  return out;
}

/** The shaders' decode of a tangent-space normal texel: RG, Z rebuilt, then `applyTBN`. */
export function decodeTexelNormal(texture: TextureAsset, size: number, f: GoldenTexel): V3 {
  const o = (f.y * size + f.x) * 4;
  const x = ((texture.data[o] as number) / 255) * 2 - 1;
  const y = ((texture.data[o + 1] as number) / 255) * 2 - 1;
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  const n0 = f.n;
  const t0 = unit([0, 1, 2].map((c) => (f.t[c] as number) - dot(f.t, n0) * (n0[c] as number)));
  const b0 = cross(n0, t0).map((c) => c * f.w) as unknown as V3;
  return unit(
    [0, 1, 2].map((c) => (t0[c] as number) * x + (b0[c] as number) * y + (n0[c] as number) * z),
  );
}

/** Where the bake ray (from `distance` outside along the base normal, inward) meets the surface. */
export function analyticHit(surface: AnalyticSurface, p: V3, n: V3, distance: number): V3 {
  const steps = 256;
  let prev = surface.sdf(at(p, n, distance));
  for (let k = 1; k <= 2 * steps; k++) {
    const s = distance - (k * distance) / steps;
    const v = surface.sdf(at(p, n, s));
    if (prev > 0 && v <= 0) {
      let hi = s + distance / steps;
      let lo = s;
      for (let i = 0; i < 60; i++) {
        const mid = (hi + lo) / 2;
        if (surface.sdf(at(p, n, mid)) > 0) hi = mid;
        else lo = mid;
      }
      return at(p, n, (hi + lo) / 2);
    }
    prev = v;
  }
  // No crossing on the segment: the closest surface point.
  const g = surface.normal(p);
  return at(p, g, -surface.sdf(p));
}

/**
 * Analytic AO: the open fraction of cosine-weighted directions in the cone `90 - bias`
 * degrees around the normal (the bake's distribution), by a `grid` x `grid` midpoint
 * quadrature with sphere-traced visibility up to `distance`. With `attenuation: 'linear'`
 * (the bake default) an occluder at distance t occludes 1 - t / distance; `'none'` fully.
 */
export function analyticOcclusion(
  surface: AnalyticSurface,
  q: V3,
  n: V3,
  ao: GoldenAo,
  grid = 24,
): number {
  if (surface.convex) return 1;
  const cone = Math.cos((ao.bias * Math.PI) / 180);
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(cross(n, helper));
  const e2 = cross(n, e1);
  const start = at(q, n, 1e-5);
  const linear = (ao.attenuation ?? 'linear') === 'linear';
  let open = 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const r = Math.sqrt(((i + 0.5) / grid) * cone * cone);
      const phi = (2 * Math.PI * (j + 0.5)) / grid;
      const lx = r * Math.cos(phi);
      const ly = r * Math.sin(phi);
      const lz = Math.sqrt(1 - r * r);
      const d = unit(
        [0, 1, 2].map(
          (c) => (e1[c] as number) * lx + (e2[c] as number) * ly + (n[c] as number) * lz,
        ),
      );
      let s = 0;
      let occlusion = 0;
      for (let k = 0; k < 512 && s < ao.distance; k++) {
        const v = surface.sdf(at(start, d, s));
        if (v < 1e-6) {
          occlusion = linear ? 1 - s / ao.distance : 1;
          break;
        }
        s += v;
      }
      open += 1 - occlusion;
    }
  }
  return open / (grid * grid);
}

/** The bake's AO cone and reach (degrees, meters) and its occluder attenuation. */
export interface GoldenAo {
  readonly bias: number;
  readonly distance: number;
  readonly attenuation?: 'linear' | 'none';
}

export interface GoldenSettings {
  readonly resolution: number;
  /** The bake's projection distance and AO settings (meters, degrees). */
  readonly distance: number;
  readonly ao?: GoldenAo;
}

export interface GoldenThresholds {
  /** Object-space normal angular error percentiles in degrees (R7 3.6: 3 and 8). */
  readonly p95?: number;
  readonly p99?: number;
  /** Mean absolute AO error (R7 3.6: 0.05). */
  readonly aoMae?: number;
}

export interface GoldenReport {
  readonly pass: boolean;
  readonly shape: GoldenShape;
  readonly texels: number;
  readonly normal?: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
  };
  readonly ao?: { readonly mae: number; readonly max: number };
  readonly issues: readonly Issue<ValidationCode>[];
}

const percentile = (sorted: readonly number[], p: number) =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number);

/** Measure a bake of `golden.base` from `golden.detail` against the analytic truth. */
export function goldenReport(
  golden: GoldenCase,
  bake: BakeResult,
  settings: GoldenSettings,
  thresholds: GoldenThresholds = {},
): GoldenReport {
  const finite = (name: string, v: number | undefined, positive: boolean) => {
    if (v !== undefined && !(Number.isFinite(v) && (positive ? v > 0 : v >= 0)))
      throw new RangeError(
        `goldenReport ${name} must be finite and ${positive ? '>' : '>='} 0, got ${v}`,
      );
  };
  if (!(Number.isInteger(settings.resolution) && settings.resolution > 0))
    throw new RangeError(
      `goldenReport resolution must be a positive integer, got ${settings.resolution}`,
    );
  finite('distance', settings.distance, true);
  finite('ao.distance', settings.ao?.distance, true);
  finite('ao.bias', settings.ao?.bias, false);
  finite('p95', thresholds.p95, false);
  finite('p99', thresholds.p99, false);
  finite('aoMae', thresholds.aoMae, false);
  const mesh = decodeSnapshot(golden.base.snapshot());
  if (!mesh.ok) throw mesh.error;
  const surface = bakeSurface(mesh.value, golden.normals);
  if (!surface.ok) throw surface.error;
  const size = settings.resolution;
  const texels = goldenTexels(surface.value, size);
  const normalMap = bake.textures.normal;
  const aoMap = bake.textures.ao;
  const angles: number[] = [];
  const aoErrors: number[] = [];
  for (const f of texels) {
    const q = analyticHit(golden.surface, f.p, f.n, settings.distance);
    const truth = golden.surface.normal(q);
    if (normalMap !== undefined) {
      const measured = decodeTexelNormal(normalMap, size, f);
      angles.push((Math.acos(Math.min(1, Math.max(-1, dot(measured, truth)))) * 180) / Math.PI);
    }
    if (aoMap !== undefined && settings.ao !== undefined) {
      const value = (aoMap.data[(f.y * size + f.x) * 4] as number) / 255;
      aoErrors.push(Math.abs(value - analyticOcclusion(golden.surface, q, truth, settings.ao)));
    }
  }
  angles.sort((a, b) => a - b);
  const p95 = thresholds.p95 ?? 3;
  const p99 = thresholds.p99 ?? 8;
  const aoLimit = thresholds.aoMae ?? 0.05;
  const normal =
    angles.length === 0
      ? undefined
      : {
          p50: percentile(angles, 0.5),
          p95: percentile(angles, 0.95),
          p99: percentile(angles, 0.99),
          max: angles[angles.length - 1] as number,
        };
  const ao =
    aoErrors.length === 0
      ? undefined
      : { mae: aoErrors.reduce((a, b) => a + b, 0) / aoErrors.length, max: maxOf(aoErrors) };
  const issues: Issue<ValidationCode>[] = [];
  const measured = [...angles, ...aoErrors];
  if (texels.length === 0 || measured.length === 0 || !measured.every(Number.isFinite))
    issues.push({
      code: 'bake',
      severity: 'error',
      detail: {
        check: 'golden-unmeasured',
        texels: texels.length,
        measured: measured.length,
        finite: measured.every(Number.isFinite),
      },
    });
  if (normal !== undefined && (normal.p95 > p95 || normal.p99 > p99))
    issues.push({
      code: 'bake',
      severity: 'warn',
      detail: { check: 'golden-normal', ...normal, limits: { p95, p99 } },
    });
  if (ao !== undefined && ao.mae > aoLimit)
    issues.push({
      code: 'bake',
      severity: 'warn',
      detail: { check: 'golden-ao', ...ao, limit: aoLimit },
    });
  return {
    pass: issues.length === 0,
    shape: golden.shape,
    texels: texels.length,
    ...(normal === undefined ? {} : { normal }),
    ...(ao === undefined ? {} : { ao }),
    issues,
  };
}
