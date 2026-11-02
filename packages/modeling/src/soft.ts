import { err, ok, type Result } from '@forgeax/engine-types';
import { applyDeformation } from './deform';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { checkFalloff, type Falloff, falloffWeights } from './falloff';
import type { Axis, Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import type { OpDiagnostic, RoleCounts } from './ops';

/** Options of `translate`, `rotate` and `scale` that turn them into soft (proportional) edits. */
export interface SoftOptions {
  /** Move nearby unselected vertices by their falloff weight (proportional editing). */
  readonly falloff?: Falloff;
  /** Mirror the selection and the transform across the plane x = 0. */
  readonly symmetry?: 'x';
}

/** A rigid edit whose amount scales with a vertex weight in [0, 1]. */
export type WeightedTransform =
  | { readonly kind: 'translate'; readonly offset: Tuple3 }
  | {
      readonly kind: 'rotate';
      readonly axis: Axis;
      readonly degrees: number;
      readonly pivot: Tuple3;
    }
  | { readonly kind: 'scale'; readonly factor: Tuple3; readonly pivot: Tuple3 };

const MAX_REPORTED = 32;

/** The transform at weight `w`: offset x w, angle x w, factor 1 + (factor - 1) x w. */
export function weighted(t: WeightedTransform, p: Tuple3, w: number): Tuple3 {
  switch (t.kind) {
    case 'translate':
      return [p[0] + t.offset[0] * w, p[1] + t.offset[1] * w, p[2] + t.offset[2] * w];
    case 'scale': {
      const f = t.factor.map((s) => 1 + (s - 1) * w) as Tuple3;
      return [
        t.pivot[0] + (p[0] - t.pivot[0]) * f[0],
        t.pivot[1] + (p[1] - t.pivot[1]) * f[1],
        t.pivot[2] + (p[2] - t.pivot[2]) * f[2],
      ];
    }
    case 'rotate': {
      const a = (((t.degrees * w) % 360) * Math.PI) / 180;
      const c = cos(a);
      const s = sin(a);
      const x = p[0] - t.pivot[0];
      const y = p[1] - t.pivot[1];
      const z = p[2] - t.pivot[2];
      const q: Tuple3 =
        t.axis === 'x'
          ? [x, c * y - s * z, s * y + c * z]
          : t.axis === 'y'
            ? [c * x + s * z, y, -s * x + c * z]
            : [c * x - s * y, s * x + c * y, z];
      return [q[0] + t.pivot[0], q[1] + t.pivot[1], q[2] + t.pivot[2]];
    }
  }
}

const mirrorX = (p: Tuple3): Tuple3 => [-p[0], p[1], p[2]];

/** The vertex at the mirror image of each seed (within `tolerance`), and the seeds without one. */
function mirrorSeeds(
  mesh: EditMesh,
  seeds: readonly number[],
  tolerance: number,
): { mirrored: number[]; unmatched: number[] } {
  const cell = (x: number) => Math.floor(x / tolerance);
  const buckets = new Map<string, number[]>();
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    const k = `${cell(p[0])},${cell(p[1])},${cell(p[2])}`;
    const list = buckets.get(k);
    if (list === undefined) buckets.set(k, [v]);
    else list.push(v);
  }
  const mirrored: number[] = [];
  const unmatched: number[] = [];
  for (const s of seeds) {
    const m = mirrorX(mesh.position(s));
    let best = -1;
    let bestDistance = tolerance;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = -1; k <= 1; k++) {
          for (const v of buckets.get(`${cell(m[0]) + i},${cell(m[1]) + j},${cell(m[2]) + k}`) ??
            []) {
            const q = mesh.position(v);
            const d = Math.max(Math.abs(q[0] - m[0]), Math.abs(q[1] - m[1]), Math.abs(q[2] - m[2]));
            if (d < bestDistance || (d === bestDistance && best >= 0 && v < best)) {
              best = v;
              bestDistance = d;
            }
          }
        }
      }
    }
    if (best < 0) unmatched.push(s);
    else mirrored.push(best);
  }
  return { mirrored, unmatched };
}

/**
 * Proportional edit: the selected vertices take the full transform, falloff
 * neighbours a weighted amount. With `symmetry: 'x'` the selection is completed by its
 * mirror image and each side of x = 0 takes the transform of the selection on that
 * side (the mirrored transform across the plane); vertices on the plane average both,
 * so they stay on it.
 */
export function softTransform(
  mesh: EditMesh,
  op: string,
  seeds: readonly number[],
  transform: WeightedTransform,
  options: SoftOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  let falloff: Required<Falloff> | undefined;
  if (options.falloff !== undefined) {
    const checked = checkFalloff(options.falloff);
    if (!checked.ok) return checked;
    falloff = checked.value;
  }
  if (options.symmetry !== undefined && options.symmetry !== 'x') {
    return err(
      modelingError('model-invalid-argument', "symmetry is 'x' (the plane x = 0)", {
        symmetry: options.symmetry,
      }),
    );
  }
  if (options.symmetry === undefined) {
    const weights = falloffWeights(mesh, seeds, falloff);
    const moving = [...weights.keys()].sort((a, b) => a - b);
    return applyDeformation(
      mesh,
      op,
      moving,
      {
        kind: 'positions',
        position: (v) => weighted(transform, mesh.position(v), weights.get(v) as number),
      },
      tolerance,
      diagnostics,
      () => ({ weighted: moving.length - seeds.length }),
    );
  }
  const plane = Math.max(tolerance, 1e-9);
  const { mirrored, unmatched } = mirrorSeeds(mesh, seeds, plane);
  if (unmatched.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${unmatched.length} selected vertices have no mirror vertex across x = 0; their mirrored edit moves no vertex`,
      detail: {
        count: unmatched.length,
        vertices: unmatched.slice(0, MAX_REPORTED),
        at: unmatched.slice(0, MAX_REPORTED).map((v) => mesh.position(v)),
      },
    });
  }
  const all = [...new Set([...seeds, ...mirrored])];
  const positive = all.filter((v) => mesh.position(v)[0] >= -plane);
  const negative = all.filter((v) => mesh.position(v)[0] <= plane);
  const centroid = seeds.reduce((sum, v) => sum + mesh.position(v)[0], 0) / seeds.length;
  const direct = (p: Tuple3, w: number) => weighted(transform, p, w);
  const reflected = (p: Tuple3, w: number) => mirrorX(weighted(transform, mirrorX(p), w));
  const [onPositive, onNegative] = centroid >= 0 ? [direct, reflected] : [reflected, direct];
  const wPositive = falloffWeights(mesh, positive, falloff);
  const wNegative = falloffWeights(mesh, negative, falloff);
  const moving = [...new Set([...wPositive.keys(), ...wNegative.keys()])].sort((a, b) => a - b);
  return applyDeformation(
    mesh,
    op,
    moving,
    {
      kind: 'positions',
      position: (v) => {
        const p = mesh.position(v);
        if (p[0] > plane) return onPositive(p, wPositive.get(v) ?? 0);
        if (p[0] < -plane) return onNegative(p, wNegative.get(v) ?? 0);
        const w = Math.max(wPositive.get(v) ?? 0, wNegative.get(v) ?? 0);
        const a = onPositive(p, w);
        const b = onNegative(p, w);
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      },
    },
    tolerance,
    diagnostics,
    () => ({ weighted: moving.length - all.length, symmetry: 'x', mirrored: mirrored.length }),
  );
}

export function checkTransform(t: WeightedTransform): Result<WeightedTransform, ModelingError> {
  const finite = (v: readonly number[]) =>
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((c) => typeof c === 'number' && Number.isFinite(c));
  if (t.kind === 'translate' && !finite(t.offset)) {
    return err(
      modelingError('model-invalid-argument', 'offset is three finite numbers', {
        offset: t.offset,
      }),
    );
  }
  if ((t.kind === 'rotate' || t.kind === 'scale') && !finite(t.pivot)) {
    return err(
      modelingError('model-invalid-argument', 'pivot is three finite numbers', { pivot: t.pivot }),
    );
  }
  if (t.kind === 'rotate' && !Number.isFinite(t.degrees)) {
    return err(
      modelingError('model-invalid-argument', 'degrees is a finite angle', { degrees: t.degrees }),
    );
  }
  return ok(t);
}
