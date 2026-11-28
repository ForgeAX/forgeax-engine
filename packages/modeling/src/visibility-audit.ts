import { err, ok, type Result } from '@forgeax/engine-types';
import { TriangleBvh } from './compute/bvh';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  dot,
  faceArea,
  faceCentroid,
  faceNormal,
  length,
  normalize,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { vertexComponents } from './lowpoly';
import { type EditMesh, PART_ROLES, type PartRole, partRole } from './mesh';

export interface VisibilityOptions {
  /** Viewpoints on a Fibonacci sphere around the bounding box (default 96). */
  readonly views?: number;
  /** Roles that block sight (default form and detail: a tool is never part of the asset). */
  readonly occluders?: readonly PartRole[];
  /** Sample points per face: the centroid, or the centroid and three points toward its corners (default 1). */
  readonly samples?: 1 | 4;
  /** Exposure under which a part counts as hidden (default 0.02). */
  readonly minVisible?: number;
}

export const VISIBILITY_FINDINGS = ['detail-seen', 'tool-seen', 'form-hidden'] as const;
export type VisibilityFindingCode = (typeof VISIBILITY_FINDINGS)[number];

export interface PartVisibility {
  readonly part: number;
  readonly role: PartRole;
  readonly faces: number;
  readonly area: number;
  /** Area-weighted share of the viewpoints facing a face that see it (0 hidden, 1 fully exposed). */
  readonly visible: number;
  /** Viewpoints that see any face of the part. */
  readonly views: number;
  readonly tags: readonly string[];
}

export interface VisibilityFinding {
  readonly code: VisibilityFindingCode;
  readonly part: number;
  readonly role: PartRole;
  readonly visible: number;
  readonly faces: readonly number[];
  readonly hint: string;
}

export interface VisibilityAudit {
  readonly views: number;
  readonly parts: readonly PartVisibility[];
  readonly findings: readonly VisibilityFinding[];
  readonly byRole: Readonly<Record<PartRole, { parts: number; area: number; visibleArea: number }>>;
}

export const DEFAULT_VIEWS = 96;
export const MAX_VIEWS = 4096;
const MAX_FACES = 32;
/** A viewpoint counts as facing a face when it is this far (cosine) above the face plane. */
export const FACING = 0.15;
export const RANGE = 2;

const fail = (message: string, detail: Record<string, unknown>) =>
  err(modelingError('model-invalid-argument', message, detail));

export function fibonacci(n: number): Tuple3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i): Tuple3 => {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return [cos(golden * i) * r, y, sin(golden * i) * r];
  });
}

function samplePoints(mesh: EditMesh, f: number, count: 1 | 4): Tuple3[] {
  const c = faceCentroid(mesh, f);
  if (count === 1) return [c];
  const ring = mesh.faceVertices(f).map((v) => mesh.position(v));
  const pick = [0, Math.floor(ring.length / 3), Math.floor((2 * ring.length) / 3)];
  return [
    c,
    ...pick.map((i): Tuple3 => {
      const p = ring[i] as Tuple3;
      return [(c[0] + p[0]) / 2, (c[1] + p[1]) / 2, (c[2] + p[2]) / 2];
    }),
  ];
}

/**
 * Measure, from a sphere of viewpoints, how much of each part (vertex-connected component)
 * can be seen, and report parts whose role disagrees with it. Reads the mesh only.
 */
export function auditVisibility(
  mesh: EditMesh,
  faces: readonly number[],
  options: VisibilityOptions,
): Result<VisibilityAudit, ModelingError> {
  const views = options.views ?? DEFAULT_VIEWS;
  if (!Number.isInteger(views) || views < 6 || views > MAX_VIEWS)
    return fail(`views is an integer in [6, ${MAX_VIEWS}]`, { code: 'views', views });
  const samples = options.samples ?? 1;
  if (samples !== 1 && samples !== 4)
    return fail('samples is 1 or 4', { code: 'samples', samples });
  const minVisible = options.minVisible ?? 0.02;
  if (!(minVisible >= 0 && minVisible <= 1))
    return fail('minVisible is in [0, 1]', { code: 'minVisible', minVisible });
  const blocking = options.occluders ?? ['form', 'detail'];
  const unknown = blocking.filter((r) => !PART_ROLES.includes(r));
  if (unknown.length > 0)
    return fail("occluders are 'form', 'detail' or 'tool'", { code: 'occluders', unknown });

  const positions: number[] = [];
  const indices: number[] = [];
  const triangleFace: number[] = [];
  const lo: Tuple3 = [Infinity, Infinity, Infinity];
  const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const f of mesh.faces()) {
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    for (const p of points)
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c] as number, p[c] as number);
        hi[c] = Math.max(hi[c] as number, p[c] as number);
      }
    if (!blocking.includes(partRole(mesh, f))) continue;
    const tri = triangulateLoop(points);
    if (tri === undefined) continue;
    const base = positions.length / 3;
    for (const p of points) positions.push(p[0], p[1], p[2]);
    for (const i of tri) indices.push(base + i);
    for (let t = 0; t < tri.length; t += 3) triangleFace.push(f);
  }
  const empty = {
    form: { parts: 0, area: 0, visibleArea: 0 },
    detail: { parts: 0, area: 0, visibleArea: 0 },
    tool: { parts: 0, area: 0, visibleArea: 0 },
  };
  if (faces.length === 0) return ok({ views, parts: [], findings: [], byRole: empty });
  const diagonal = Math.max(1e-9, length(sub(hi, lo)));
  const center: Tuple3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const bvh = indices.length === 0 ? undefined : new TriangleBvh(positions, indices);
  const eye = fibonacci(views).map(
    (d): Tuple3 => [
      center[0] + d[0] * RANGE * diagonal,
      center[1] + d[1] * RANGE * diagonal,
      center[2] + d[2] * RANGE * diagonal,
    ],
  );

  const parts: PartVisibility[] = [];
  const findings: VisibilityFinding[] = [];
  const byRole = {
    form: { parts: 0, area: 0, visibleArea: 0 },
    detail: { parts: 0, area: 0, visibleArea: 0 },
    tool: { parts: 0, area: 0, visibleArea: 0 },
  };
  const components = PART_ROLES.flatMap((r) =>
    vertexComponents(
      mesh,
      faces.filter((f) => partRole(mesh, f) === r),
    ),
  ).sort((a, b) => (a[0] as number) - (b[0] as number));
  components.forEach((component, part) => {
    const role = partRole(mesh, component[0] as number);
    let area = 0;
    let exposed = 0;
    const seen = new Uint8Array(views);
    const tags = new Set<string>();
    for (const f of component) {
      for (let t = 0; t < mesh.tagNames.length; t++)
        if (mesh.hasTag(f, t)) tags.add(mesh.tagNames[t] as string);
      const a = faceArea(mesh, f);
      const n = faceNormal(mesh, f);
      const points = samplePoints(mesh, f, samples);
      let facing = 0;
      let hit = 0;
      for (const p of points) {
        eye.forEach((e, v) => {
          const d = sub(e, p);
          const dist = length(d);
          const u = normalize(d);
          if (dot(u, n) < FACING) return;
          facing++;
          if (
            bvh !== undefined &&
            bvh.raycast(p, u, dist, true, (t) => triangleFace[t] !== f) !== undefined
          )
            return;
          hit++;
          seen[v] = 1;
        });
      }
      area += a;
      if (facing > 0) exposed += (a * hit) / facing;
    }
    const visible = area === 0 ? 0 : exposed / area;
    const seenViews = seen.reduce((s, x) => s + x, 0);
    parts.push({
      part,
      role,
      faces: component.length,
      area,
      visible,
      views: seenViews,
      tags: [...tags].sort(),
    });
    byRole[role].parts++;
    byRole[role].area += area;
    byRole[role].visibleArea += exposed;
    const finding = (code: VisibilityFindingCode, hint: string, list: readonly number[]) =>
      findings.push({ code, part, role, visible, faces: list.slice(0, MAX_FACES), hint });
    if (role === 'form' && visible < minVisible)
      finding(
        'form-hidden',
        'interior form part: the low keeps and unwraps it; mark it detail or delete it',
        component,
      );
    if (role === 'detail' && visible >= minVisible)
      finding(
        'detail-seen',
        'the low drops this part: the silhouette changes unless the bake covers it',
        component,
      );
    if (role === 'tool' && visible >= minVisible)
      finding(
        'tool-seen',
        'a cutter left in the session shows from outside: delete it or mark it detail',
        component,
      );
  });
  return ok({ views, parts, findings, byRole });
}
