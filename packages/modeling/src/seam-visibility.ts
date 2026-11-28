import { err, ok, type Result } from '@forgeax/engine-types';
import { TriangleBvh } from './compute/bvh';
import { measureUv } from './compute/uv-ts';
import { type ModelingError, modelingError } from './errors';
import { dot, faceNormal, length, normalize, sub, type Tuple3, triangulateLoop } from './geom';
import {
  type CornerChannelName,
  type EditMesh,
  NONE,
  PART_ROLES,
  type PartRole,
  partRole,
} from './mesh';
import { DEFAULT_VIEWS, FACING, fibonacci, MAX_VIEWS, RANGE } from './visibility-audit';

export interface SeamVisibilityOptions {
  /** UV channel whose islands define the seams (default 'uv0'). */
  readonly channel?: CornerChannelName;
  /** Viewpoints on a Fibonacci sphere around the bounding box (default 96). */
  readonly views?: number;
  /** Roles that block sight (default form and detail). */
  readonly occluders?: readonly PartRole[];
  /** A chain whose hidden share is below this is listed in `exposed` (default 0.5). */
  readonly minHidden?: number;
  /** Atlas size in texels for the `thin` island flag (default 1024). */
  readonly resolution?: number;
}

export interface SeamChain {
  /** Seam edges of the chain (connected through shared vertices, one pair of islands). */
  readonly edges: readonly number[];
  readonly length: number;
  /** Length-weighted share of the chain that no counted viewpoint sees (0 to 1). */
  readonly hidden: number;
  readonly islands: readonly [number, number];
  /** Midpoint of the most exposed edge. */
  readonly worst: Tuple3;
}

export interface SeamIslandScore {
  readonly island: number;
  readonly faces: number;
  /** Seam length bounding the island (meters, edges shared with other islands). */
  readonly border: number;
  readonly hidden: number;
  /** The island is under 6 texels across or 6 or more times longer than wide, as the turret baseline counts. */
  readonly thin: boolean;
}

export interface SeamVisibilityReport {
  readonly views: number;
  readonly seams: number;
  readonly length: number;
  /** Length-weighted share of all seam length that is hidden; 1 when there are no seams. */
  readonly hiddenScore: number;
  readonly visibleLength: number;
  /** Chains by visible length, up to 32. */
  readonly chains: readonly SeamChain[];
  /** Chains whose hidden share is under `minHidden`. */
  readonly exposed: number;
  readonly byIsland: readonly SeamIslandScore[];
}

const MAX_CHAINS = 32;

const fail = (message: string, detail: Record<string, unknown>) =>
  err(modelingError('model-invalid-argument', message, detail));

/**
 * Proxy for how well the UV seams are hidden: for each seam edge (interior edge whose two
 * sides disagree on a corner value of the channel) the share of the viewpoints that face it
 * and cannot see its midpoint. Reads the mesh only; it is not an aesthetic judgment.
 *
 * Stated semantics: a seam no counted viewpoint faces (zero-area or degenerate faces) scores
 * hidden 1; the faces on either side of a seam never occlude it, so on open sheets or thin
 * shells a concave crease reads as visible from viewpoints behind the neighbouring face.
 */
export function measureSeamVisibility(
  mesh: EditMesh,
  options: SeamVisibilityOptions = {},
): Result<SeamVisibilityReport, ModelingError> {
  const channel = options.channel ?? 'uv0';
  const views = options.views ?? DEFAULT_VIEWS;
  if (!Number.isInteger(views) || views < 6 || views > MAX_VIEWS)
    return fail(`views is an integer in [6, ${MAX_VIEWS}]`, { code: 'views', views });
  const minHidden = options.minHidden ?? 0.5;
  if (!(minHidden >= 0 && minHidden <= 1))
    return fail('minHidden is in [0, 1]', { code: 'minHidden', minHidden });
  const resolution = options.resolution ?? 1024;
  if (!(resolution > 0 && Number.isFinite(resolution)))
    return fail('resolution is a positive number', { code: 'resolution', resolution });
  const blocking = options.occluders ?? ['form', 'detail'];
  const unknown = blocking.filter((r) => !PART_ROLES.includes(r));
  if (unknown.length > 0)
    return fail("occluders are 'form', 'detail' or 'tool'", { code: 'occluders', unknown });

  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])))
      return err(
        modelingError('model-precondition', 'every vertex position is finite', {
          code: 'non-finite-position',
          vertex: v,
          position: p,
          hint: 'repair or delete the vertex before measuring seam visibility',
        }),
      );
  }

  const found = measureUv(mesh, channel);
  if (!found.ok) return found;
  const { faceIsland, islands } = found.value;

  const value = (h: number) => mesh.corner(channel, h) as Float32Array;
  const same = (a: number, b: number) => {
    const x = value(a);
    const y = value(b);
    return x[0] === y[0] && x[1] === y[1];
  };
  const seams: number[] = [];
  for (const e of mesh.edges()) {
    const h = e * 2;
    if ((mesh.hFace[h] as number) === NONE || (mesh.hFace[h + 1] as number) === NONE) continue;
    if (!(same(h, mesh.hNext[h + 1] as number) && same(mesh.hNext[h] as number, h + 1)))
      seams.push(e);
  }

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
  const diagonal = Math.max(1e-9, length(sub(hi, lo)));
  const center: Tuple3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const bvh = indices.length === 0 ? undefined : new TriangleBvh(positions, indices);
  const eyes = fibonacci(views).map(
    (d): Tuple3 => [
      center[0] + d[0] * RANGE * diagonal,
      center[1] + d[1] * RANGE * diagonal,
      center[2] + d[2] * RANGE * diagonal,
    ],
  );

  const edgeLength = new Map<number, number>();
  const edgeHidden = new Map<number, number>();
  const edgeMid = new Map<number, Tuple3>();
  for (const e of seams) {
    const [a, b] = mesh.edgeVertices(e);
    const pa = mesh.position(a);
    const pb = mesh.position(b);
    const mid: Tuple3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
    const f0 = mesh.hFace[e * 2] as number;
    const f1 = mesh.hFace[e * 2 + 1] as number;
    const n0 = faceNormal(mesh, f0);
    const n1 = faceNormal(mesh, f1);
    let counted = 0;
    let seen = 0;
    for (const eye of eyes) {
      const d = sub(eye, mid);
      const dist = length(d);
      const u = normalize(d);
      if (dot(u, n0) < FACING && dot(u, n1) < FACING) continue;
      counted++;
      if (
        bvh !== undefined &&
        bvh.raycast(mid, u, dist, true, (t) => {
          const f = triangleFace[t];
          return f !== f0 && f !== f1;
        }) !== undefined
      )
        continue;
      seen++;
    }
    edgeLength.set(e, length(sub(pa, pb)));
    edgeHidden.set(e, counted === 0 ? 1 : 1 - seen / counted);
    edgeMid.set(e, mid);
  }

  const pairOf = (e: number): [number, number] => {
    const x = faceIsland[mesh.hFace[e * 2] as number] as number;
    const y = faceIsland[mesh.hFace[e * 2 + 1] as number] as number;
    return x <= y ? [x, y] : [y, x];
  };
  const parent = new Map<number, number>(seams.map((e) => [e, e]));
  const root = (e: number): number => {
    let r = e;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    return r;
  };
  const atVertex = new Map<string, number>();
  for (const e of seams) {
    const [x, y] = pairOf(e);
    for (const v of mesh.edgeVertices(e)) {
      const key = `${x}:${y}:${v}`;
      const other = atVertex.get(key);
      if (other === undefined) atVertex.set(key, e);
      else parent.set(root(e), root(other));
    }
  }
  const groups = new Map<number, number[]>();
  for (const e of seams) groups.set(root(e), [...(groups.get(root(e)) ?? []), e]);

  let total = 0;
  let hiddenLength = 0;
  const perIsland = islands.map(() => ({ border: 0, hidden: 0 }));
  for (const e of seams) {
    const len = edgeLength.get(e) as number;
    const h = edgeHidden.get(e) as number;
    total += len;
    hiddenLength += len * h;
    for (const island of pairOf(e)) {
      const cell = perIsland[island] as { border: number; hidden: number };
      cell.border += len;
      cell.hidden += len * h;
    }
  }
  const chains: SeamChain[] = [...groups.values()].map((list) => {
    let len = 0;
    let hid = 0;
    let worst = list[0] as number;
    for (const e of list) {
      const l = edgeLength.get(e) as number;
      len += l;
      hid += l * (edgeHidden.get(e) as number);
      if ((edgeHidden.get(e) as number) < (edgeHidden.get(worst) as number)) worst = e;
    }
    return {
      edges: list,
      length: len,
      hidden: len === 0 ? 1 : hid / len,
      islands: pairOf(list[0] as number),
      worst: edgeMid.get(worst) as Tuple3,
    };
  });
  chains.sort(
    (a, b) =>
      b.length * (1 - b.hidden) - a.length * (1 - a.hidden) ||
      (a.edges[0] as number) - (b.edges[0] as number),
  );

  const boxes = islands.map(() => ({ u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity }));
  for (const f of mesh.faces()) {
    const box = boxes[faceIsland[f] as number] as (typeof boxes)[number];
    for (const h of mesh.faceHalves(f)) {
      const c = value(h);
      box.u0 = Math.min(box.u0, c[0] as number);
      box.v0 = Math.min(box.v0, c[1] as number);
      box.u1 = Math.max(box.u1, c[0] as number);
      box.v1 = Math.max(box.v1, c[1] as number);
    }
  }
  const byIsland = islands.map((island, i): SeamIslandScore => {
    const b = boxes[i] as (typeof boxes)[number];
    const w = (b.u1 - b.u0) * resolution;
    const h = (b.v1 - b.v0) * resolution;
    const cell = perIsland[i] as { border: number; hidden: number };
    return {
      island: i,
      faces: island.faces,
      border: cell.border,
      hidden: cell.border === 0 ? 1 : cell.hidden / cell.border,
      thin: Math.min(w, h) < 6 || Math.max(w, h) / Math.max(1e-9, Math.min(w, h)) >= 6,
    };
  });
  return ok({
    views,
    seams: seams.length,
    length: total,
    hiddenScore: total === 0 ? 1 : hiddenLength / total,
    visibleLength: total - hiddenLength,
    chains: chains.slice(0, MAX_CHAINS),
    exposed: chains.filter((c) => c.hidden < minHidden).length,
    byIsland,
  });
}
