import { cos, sin } from './dmath';
import { type NormalMode, smoothAcross } from './finish';
import { faceArea } from './geom';
import { type EditMesh, NONE } from './mesh';
import type { Issue } from './report';
import type { ValidationCode } from './validate';

/**
 * The BK-V check catalogue, one union over two stages. `validate({ bake })`
 * runs the mesh-time checks (`BAKE_CHECKS`: V1 sharp-not-seam, V9 subpixel-bevel) as `bake`
 * issues whose `detail.check` names the check; the bake reports the others (V2 ray-miss,
 * V3 steep-wall, V4 mip-bleed, V5 stack-conflict, V12 opacity-coverage, cage-clip (audit A1),
 * stray-detail (audit A3), tangent-seam (audit A4)) as its own issues. V2 = share of misses; cage-clip = detail
 * outside the cage span (not duplicates).
 */
export type BakeCheck =
  | 'sharp-not-seam'
  | 'subpixel-bevel'
  | 'ray-miss'
  | 'steep-wall'
  | 'mip-bleed'
  | 'stack-conflict'
  | 'opacity-coverage'
  | 'cage-clip'
  | 'stray-detail'
  | 'tangent-seam';

/** The mesh-time checks `validate({ bake })` runs (default all of them). */
export const BAKE_CHECKS = [
  'sharp-not-seam',
  'subpixel-bevel',
] as const satisfies readonly BakeCheck[];

export interface BakeValidateOptions {
  /** Checks to run (default all). */
  readonly checks?: readonly (typeof BAKE_CHECKS)[number][];
  /**
   * The export normal mode the baked asset renders with (default smooth): its hard edges
   * (sharp edges, every edge when flat, dihedrals above the autoSmooth angle) are checked.
   */
  readonly normals?: NormalMode;
  /**
   * The typical view the asset is judged at: camera `distance` (meters), vertical `fov`
   * (degrees, default 60) and screen `height` (pixels, default 1080). `subpixel-bevel`
   * runs only with a view.
   */
  readonly view?: { readonly distance: number; readonly fov?: number; readonly height?: number };
}

/** Edges reported in detail (the count is always reported). */
const MAX_EDGES = 32;
/** UV coordinates closer than this are one corner value. */
const UV_EPSILON = 1e-6;

function sameUv(a: Float32Array | undefined, b: Float32Array | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return (
    Math.abs((a[0] as number) - (b[0] as number)) <= UV_EPSILON &&
    Math.abs((a[1] as number) - (b[1] as number)) <= UV_EPSILON
  );
}

/**
 * V1 (pitfall 1): a hard edge whose uv0 is continuous across it. Both sides then bake
 * contradicting normals into the same texels, which shows as a bright seam line; every
 * hard edge needs a UV seam.
 */
function sharpNotSeam(mesh: EditMesh, normals: NormalMode, issues: Issue<ValidationCode>[]): void {
  const edges: number[] = [];
  const faces = new Set<number>();
  let count = 0;
  for (const e of mesh.edges()) {
    const h = e * 2;
    const t = h + 1;
    if ((mesh.hFace[h] as number) === NONE || (mesh.hFace[t] as number) === NONE) continue;
    if (smoothAcross(mesh, e, normals)) continue;
    // Corner (A, origin of h) meets (B, origin of next(t)); (A, end of h) meets (B, origin of t).
    const continuous =
      sameUv(mesh.corner('uv0', h), mesh.corner('uv0', mesh.hNext[t] as number)) &&
      sameUv(mesh.corner('uv0', mesh.hNext[h] as number), mesh.corner('uv0', t));
    if (!continuous) continue;
    count++;
    if (edges.length < MAX_EDGES) {
      edges.push(e);
      faces.add(mesh.hFace[h] as number);
      faces.add(mesh.hFace[t] as number);
    }
  }
  if (count === 0) return;
  issues.push({
    code: 'bake',
    severity: 'warn',
    detail: {
      check: 'sharp-not-seam',
      count,
      edges,
      faces: [...faces],
      hint: 'cut a UV seam along every hard edge (uv.auto with respectSharp, or mark the seam), or soften the edge',
    },
  });
}

/**
 * V9 (pitfall 14): bevel faces narrower than a pixel at the typical view flicker into
 * broken highlights; widen the bevel or bake it into the normal map (a trim or T2 detail).
 * The width of a face is its area over its longest edge.
 */
function subpixelBevel(
  mesh: EditMesh,
  view: NonNullable<BakeValidateOptions['view']>,
  issues: Issue<ValidationCode>[],
): void {
  const fov = view.fov ?? 60;
  const height = view.height ?? 1080;
  if (!(view.distance > 0 && fov > 0 && fov < 180 && height > 0)) {
    issues.push({
      code: 'bake',
      severity: 'warn',
      detail: { check: 'subpixel-bevel', reason: 'invalid-view', view },
    });
    return;
  }
  const half = ((fov / 2) * Math.PI) / 180;
  const pxPerMeter = height / (2 * view.distance * (sin(half) / cos(half)));
  const bevel = mesh.roleNames.indexOf('bevel');
  if (bevel < 0) return;
  const faces: number[] = [];
  let count = 0;
  let narrowest = Number.POSITIVE_INFINITY;
  for (const f of mesh.faces()) {
    if ((mesh.fRole[f] as number) !== bevel) continue;
    const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
    let longest = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as readonly number[];
      const b = loop[(i + 1) % loop.length] as readonly number[];
      const dx = (a[0] as number) - (b[0] as number);
      const dy = (a[1] as number) - (b[1] as number);
      const dz = (a[2] as number) - (b[2] as number);
      longest = Math.max(longest, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    if (longest === 0) continue;
    const px = (faceArea(mesh, f) / longest) * pxPerMeter;
    if (px >= 1) continue;
    count++;
    narrowest = Math.min(narrowest, px);
    if (faces.length < MAX_EDGES) faces.push(f);
  }
  if (count === 0) return;
  issues.push({
    code: 'bake',
    severity: 'warn',
    detail: {
      check: 'subpixel-bevel',
      count,
      faces,
      narrowestPx: narrowest,
      pxPerMeter,
      hint: 'widen the bevel past a pixel at this view, or bake it into a normal map (trim strip) and keep the flat form',
    },
  });
}

export function checkBake(
  mesh: EditMesh,
  options: true | BakeValidateOptions,
  issues: Issue<ValidationCode>[],
): void {
  const settings = options === true ? {} : options;
  const checks = new Set(settings.checks ?? BAKE_CHECKS);
  if (checks.has('sharp-not-seam'))
    sharpNotSeam(mesh, settings.normals ?? { mode: 'smooth' }, issues);
  if (checks.has('subpixel-bevel') && settings.view !== undefined)
    subpixelBevel(mesh, settings.view, issues);
}
