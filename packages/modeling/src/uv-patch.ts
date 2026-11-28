import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import { type ModelingError, modelingError } from './errors';
import { UnionFind } from './finish';
import { cross, length, sub, type Tuple3 } from './geom';
import { type CornerChannelName, type EditMesh, NONE } from './mesh';
import type { OpDiagnostic, RoleCounts } from './ops';

export const PATCH_UV_MODES = ['intrinsic', 'conformalScaled'] as const;
export type PatchUvMode = (typeof PATCH_UV_MODES)[number];

export interface FromPatchOptions {
  /** `intrinsic`: uv0 is the patch domain. `conformalScaled`: the domain in metres, one period for every group. */
  readonly mode: PatchUvMode;
  /** Material cell `[i, j]` added to uv0 (the P2-S1 zone rule), integers within +-1024, default `[0, 0]`. */
  readonly zone?: readonly [number, number];
  /** conformalScaled: metres per cell. Default: the largest patch extent, so no group leaves its cell. */
  readonly period?: number;
}

interface Group {
  readonly faces: number[];
  area: number;
  lu: number;
  lv: number;
  min: [number, number];
  max: [number, number];
}

const DEGENERATE = 1e-12;
/** float32 keeps 14 bits of the local fraction at this cell index; beyond it uv0 loses its texel position. */
const MAX_CELL = 1024;

function fail(message: string, detail: Record<string, unknown>) {
  return err(modelingError('model-invalid-argument', message, detail));
}

/** Faces joined through edges whose domain channel agrees on both sides: one patch domain each. */
function patchGroups(
  mesh: EditMesh,
  faces: readonly number[],
  channel: CornerChannelName,
): number[][] {
  const index = new Map<number, number>();
  faces.forEach((f, i) => {
    index.set(f, i);
  });
  const same = (a: number, b: number) => {
    const x = mesh.corner(channel, a);
    const y = mesh.corner(channel, b);
    return x !== undefined && y !== undefined && x.every((v, k) => v === (y[k] as number));
  };
  const sets = new UnionFind(faces.length);
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const t = h ^ 1;
      const g = mesh.hFace[t] as number;
      if (g === NONE || g < f || !index.has(g)) continue;
      if (same(h, mesh.hNext[t] as number) && same(mesh.hNext[h] as number, t))
        sets.union(index.get(f) as number, index.get(g) as number);
    }
  }
  const out = new Map<number, number[]>();
  faces.forEach((f, i) => {
    const root = sets.find(i);
    const list = out.get(root);
    if (list === undefined) out.set(root, [f]);
    else list.push(f);
  });
  return [...out.values()];
}

/** Area-weighted squared isoparm lengths of one face from its triangle fan: [area, |dP/ds|^2, |dP/dt|^2]. */
function faceMetric(
  mesh: EditMesh,
  f: number,
  channel: CornerChannelName,
): readonly [number, number, number] {
  const halves = mesh.faceHalves(f);
  const p = halves.map((h) => mesh.position(mesh.hVert[h] as number) as Tuple3);
  const q = halves.map((h) => mesh.corner(channel, h) as Float32Array);
  let area = 0;
  let su = 0;
  let sv = 0;
  for (let k = 1; k + 1 < halves.length; k++) {
    const e1 = sub(p[k] as Tuple3, p[0] as Tuple3);
    const e2 = sub(p[k + 1] as Tuple3, p[0] as Tuple3);
    const a = length(cross(e1, e2)) / 2;
    const at = (i: number, c: 0 | 1) => (q[i] as Float32Array)[c] as number;
    const ds1 = at(k, 0) - at(0, 0);
    const dt1 = at(k, 1) - at(0, 1);
    const ds2 = at(k + 1, 0) - at(0, 0);
    const dt2 = at(k + 1, 1) - at(0, 1);
    const det = ds1 * dt2 - dt1 * ds2;
    if (Math.abs(det) < DEGENERATE || a === 0) continue;
    const ps: Tuple3 = [
      (e1[0] * dt2 - e2[0] * dt1) / det,
      (e1[1] * dt2 - e2[1] * dt1) / det,
      (e1[2] * dt2 - e2[2] * dt1) / det,
    ];
    const pt: Tuple3 = [
      (e2[0] * ds1 - e1[0] * ds2) / det,
      (e2[1] * ds1 - e1[1] * ds2) / det,
      (e2[2] * ds1 - e1[2] * ds2) / det,
    ];
    area += a;
    su += a * (ps[0] * ps[0] + ps[1] * ps[1] + ps[2] * ps[2]);
    sv += a * (pt[0] * pt[0] + pt[1] * pt[1] + pt[2] * pt[2]);
  }
  return [area, su, sv];
}

function measure(mesh: EditMesh, faces: number[], channel: CornerChannelName): Group {
  const g: Group = {
    faces,
    area: 0,
    lu: 0,
    lv: 0,
    min: [Infinity, Infinity],
    max: [-Infinity, -Infinity],
  };
  let su = 0;
  let sv = 0;
  for (const f of faces) {
    const [a, u, v] = faceMetric(mesh, f, channel);
    g.area += a;
    su += u;
    sv += v;
    for (const h of mesh.faceHalves(f)) {
      const c = mesh.corner(channel, h) as Float32Array;
      g.min = [Math.min(g.min[0], c[0] as number), Math.min(g.min[1], c[1] as number)];
      g.max = [Math.max(g.max[0], c[0] as number), Math.max(g.max[1], c[1] as number)];
    }
  }
  if (g.area > 0) {
    g.lu = Math.sqrt(su / g.area);
    g.lv = Math.sqrt(sv / g.area);
  }
  return g;
}

function uvArea(mesh: EditMesh, faces: readonly number[]): number {
  let area = 0;
  for (const f of faces) {
    const q = mesh.faceHalves(f).map((h) => mesh.corner('uv0', h) as Float32Array);
    for (let k = 1; k + 1 < q.length; k++) {
      const a = q[0] as Float32Array;
      const b = q[k] as Float32Array;
      const c = q[k + 1] as Float32Array;
      area +=
        Math.abs(
          ((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) -
            ((c[0] as number) - (a[0] as number)) * ((b[1] as number) - (a[1] as number)),
        ) / 2;
    }
  }
  return area;
}

/**
 * Game UV from the stored patch domain (BK51): uv0 is rewritten per patch group (faces joined
 * through equal domain values), the domain channel is only read (`channel`: uv1, or the carrier
 * once BK56 `uv.lightmap` moved it), so `{ mode: 'surface' }` normals and the P2-S1 domain rule
 * are untouched. `intrinsic` keeps the domain; `conformalScaled` scales each group's domain by
 * its measured isoparm lengths and divides by one period, so every patch shares a texel density.
 */
export function uvFromPatch(
  mesh: EditMesh,
  faces: readonly number[],
  options: FromPatchOptions,
  diagnostics: OpDiagnostic[],
  channel: CornerChannelName = 'uv1',
): Result<RoleCounts, ModelingError> {
  if (!PATCH_UV_MODES.includes(options.mode))
    return fail('uv.fromPatch mode is intrinsic or conformalScaled', {
      code: 'mode',
      mode: options.mode,
    });
  const zone = options.zone ?? [0, 0];
  if (
    !Number.isInteger(zone[0]) ||
    !Number.isInteger(zone[1]) ||
    Math.abs(zone[0]) > MAX_CELL ||
    Math.abs(zone[1]) > MAX_CELL
  )
    return fail(`uv.fromPatch zone is an integer cell within +-${MAX_CELL}`, {
      code: 'zone',
      zone,
    });
  if (options.period !== undefined && !(Number.isFinite(options.period) && options.period > 0))
    return fail('uv.fromPatch period is a positive number of meters', {
      code: 'period',
      period: options.period,
    });
  if (options.period !== undefined && options.mode === 'intrinsic')
    return fail('uv.fromPatch period applies to conformalScaled only', {
      code: 'period',
      mode: options.mode,
    });
  if (faces.length === 0) return ok({ patched: 0 });
  const missing = faces.filter((f) =>
    mesh.faceHalves(f).some((h) => mesh.corner(channel, h) === undefined),
  );
  if (!mesh.channels.has(channel) || missing.length > 0)
    return err(
      modelingError(
        'model-precondition',
        `uv.fromPatch needs the patch domain in ${channel} (m.surface writes it)`,
        {
          code: 'no-patch-domain',
          carrier: channel,
          faces: missing.slice(0, 32),
        },
      ),
    );

  const groups = patchGroups(mesh, faces, channel).map((list) => measure(mesh, list, channel));
  const live = groups.filter((g) => g.lu > 0 && g.lv > 0);
  const skipped = groups.length - live.length;
  const extent = (g: Group) => Math.max((g.max[0] - g.min[0]) * g.lu, (g.max[1] - g.min[1]) * g.lv);
  const period =
    options.mode === 'intrinsic'
      ? 1
      : (options.period ?? (live.length === 0 ? 1 : maxOf(live.map(extent))));

  const writes: { h: number; uv: [number, number] }[] = [];
  for (const g of live) {
    for (const f of g.faces) {
      for (const h of mesh.faceHalves(f)) {
        const c = mesh.corner(channel, h) as Float32Array;
        const s = c[0] as number;
        const t = c[1] as number;
        const u = options.mode === 'intrinsic' ? s : ((s - g.min[0]) * g.lu) / period;
        const v = options.mode === 'intrinsic' ? t : ((t - g.min[1]) * g.lv) / period;
        writes.push({ h, uv: [zone[0] + u, zone[1] + v] });
      }
    }
  }
  const lost = writes.find(
    ({ uv }) => !Number.isFinite(Math.fround(uv[0])) || !Number.isFinite(Math.fround(uv[1])),
  );
  if (lost !== undefined)
    return fail('uv.fromPatch would write a non-finite uv0 (period too small for the domain)', {
      code: 'overflow',
      period,
    });
  for (const { h, uv } of writes) mesh.setCorner('uv0', h, uv);

  const density = live.map((g) => Math.sqrt(uvArea(mesh, g.faces) / g.area));
  const spread = density.length === 0 ? 1 : maxOf(density) / minOf(density);
  const patched = live.reduce((n, g) => n + g.faces.length, 0);
  if (skipped > 0)
    diagnostics.push({
      severity: 'warn',
      message: `uv.fromPatch: ${skipped} patch group(s) have a degenerate domain and keep their uv0`,
      detail: { code: 'degenerate-domain', skipped },
    });
  diagnostics.push({
    severity: 'info',
    message: `uv.fromPatch (${options.mode}) wrote uv0 of ${live.length} patch group(s), density spread ${spread.toFixed(3)}`,
    detail: {
      mode: options.mode,
      groups: live.length,
      faces: patched,
      skipped,
      period,
      densitySpread: spread,
    },
  });
  return ok({ patched });
}
