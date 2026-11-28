import { createHash } from 'node:crypto';
import type { TextureAsset } from '@forgeax/engine-types';
import { type BakeOptions, type BakeResult, bakeMaps } from '../bake';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';

/** Shared scenes of the analytic bake (BK63) gates: exact patches, a coarse base carrying their domain. */

function arc(a0: number, a1: number): { p: [number, number][]; w: number[] } {
  const half = (a1 - a0) / 2;
  const mid = (a0 + a1) / 2;
  const k = 1 / Math.cos(half);
  return {
    p: [
      [Math.cos(a0), Math.sin(a0)],
      [Math.cos(mid) * k, Math.sin(mid) * k],
      [Math.cos(a1), Math.sin(a1)],
    ],
    w: [1, Math.cos(half), 1],
  };
}

/** A rational biquadratic sphere zone: 90 degrees of longitude, latitude lat0..lat1 (radians). */
export function sphereZone(r: number, lat0: number, lat1: number): NurbsSurface {
  const u = arc(0, Math.PI / 2);
  const v = arc(lat0, lat1);
  return {
    degreeU: 2,
    degreeV: 2,
    points: u.p.map((q) =>
      v.p.map((pr): Tuple3 => [q[0] * pr[0] * r, q[1] * pr[0] * r, pr[1] * r]),
    ),
    weights: u.w.map((a) => v.w.map((b) => a * b)),
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 0, 1, 1, 1],
  };
}

/** A quarter cylinder of radius r and height h about z (rational quadratic by linear). */
export function cylinderQuarter(r: number, h: number): NurbsSurface {
  const u = arc(0, Math.PI / 2);
  return {
    degreeU: 2,
    degreeV: 1,
    points: u.p.map((q) => [
      [q[0] * r, q[1] * r, 0],
      [q[0] * r, q[1] * r, h],
    ]),
    weights: u.w.map((a) => [a, a]),
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

/** A bicubic bump over [x0, x0 + w] x [0, 1] with its height in z. */
export function bicubicBump(x0: number, w: number, h: number): NurbsSurface {
  const samples = Array.from({ length: 7 }, (_, i) => i / 6);
  const grid = samples.map((a) =>
    samples.map((b): Tuple3 => [x0 + a * w, b, h * Math.sin(Math.PI * b) * (0.6 + 0.4 * a)]),
  );
  const s = nurbs.grid(grid);
  if (!s.ok) throw s.error;
  return s.value;
}

/** A flat rectangle patch of size w x h centered at (cx, 0, 0), normal +z. */
export function rectangle(cx: number, w: number, h: number): NurbsSurface {
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [
        [cx - w / 2, -h / 2, 0],
        [cx - w / 2, h / 2, 0],
      ],
      [
        [cx + w / 2, -h / 2, 0],
        [cx + w / 2, h / 2, 0],
      ],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

export interface Tessellation {
  readonly chord?: number;
  readonly angle?: number;
}

/** A model of one meshed patch named `name`; its corners carry the normalized domain in uv1. */
export function patchModel(
  surface: NurbsSurface,
  name: string,
  tessellation: Tessellation,
  flip = false,
): Model {
  const m = model();
  const report = m.surface({
    patches: [{ surface, name, ...(flip ? { flip } : {}) }],
    ...tessellation,
  });
  if (report.status !== 'ok') throw new Error(`surface ${name} failed: ${JSON.stringify(report)}`);
  return m;
}

/** Give every corner without a uv1 value [0, 0]: a part that carries no patch domain next to patched ones. */
export function fillUv1(m: Model): void {
  const mesh = m.editMesh;
  for (const f of mesh.faces())
    for (const h of mesh.faceHalves(f))
      if (mesh.corner('uv1', h) === undefined) mesh.setCorner('uv1', h, [0, 0]);
}

export interface Scene {
  readonly base: Model;
  readonly detail: Model;
  readonly surface: NurbsSurface;
}

/** A fine detail and a coarse base of the same patch, the base with a uv0 atlas. */
export function scene(
  surface: NurbsSurface,
  options: {
    readonly detail?: Tessellation;
    readonly base?: Tessellation;
    readonly resolution?: number;
    readonly flip?: boolean;
  } = {},
): Scene {
  const detail = patchModel(
    surface,
    'p',
    options.detail ?? { chord: 0.001, angle: 12 },
    options.flip,
  );
  const base = patchModel(surface, 'p', options.base ?? { chord: 0.03, angle: 30 }, options.flip);
  base.uv.auto({ resolution: options.resolution ?? 128, padding: 2 });
  return { base, detail, surface };
}

export function bake(options: BakeOptions): BakeResult {
  const r = bakeMaps(options);
  if (!r.ok) throw r.error;
  return r.value;
}

export const textureBytes = (r: BakeResult): Record<string, Buffer> =>
  Object.fromEntries(
    Object.entries(r.textures).map(([k, t]) => [
      k,
      Buffer.from((t as TextureAsset).data as Uint8Array),
    ]),
  );

/** One digest of every texture byte and the provenance of a bake. */
export function digestOf(r: BakeResult): string {
  const hash = createHash('sha256');
  for (const [k, b] of Object.entries(textureBytes(r)).sort(([a], [c]) => a.localeCompare(c))) {
    hash.update(k);
    hash.update(b);
  }
  hash.update(JSON.stringify(r.provenance));
  return hash.digest('hex');
}
