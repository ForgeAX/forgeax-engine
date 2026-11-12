import { err, ok, type Result } from '@forgeax/engine-types';
import { minOf } from './arrays';
import { cos } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { dot, faceArea, faceCentroid, faceNormal, sub, type Tuple3 } from './geom';
import { type EditMesh, NONE } from './mesh';
import type { OpDiagnostic, RoleCounts } from './ops';
import { type CornerSource, type FaceRewrite, faceCorners, rewriteFaces } from './rewrite';

/** Corner values closer than this are equal (float32 storage of interpolated values). */
const VALUE_TOLERANCE = 1e-5;

function cornersEqual(mesh: EditMesh, h: number, k: number): boolean {
  for (const name of mesh.channels.keys()) {
    const a = mesh.corner(name, h);
    const b = mesh.corner(name, k);
    if (a === undefined || b === undefined) {
      if (a !== b) return false;
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      if (Math.abs((a[i] as number) - (b[i] as number)) > VALUE_TOLERANCE) return false;
    }
  }
  return true;
}

export interface PlanarOutcome {
  /** Resulting faces in place of the input faces (merged and untouched). */
  readonly faces: number[];
  /** Resulting face -> the input face whose attributes it carries. */
  readonly origin: Map<number, number>;
  readonly merged: number;
  readonly removedVertices: number;
}

/**
 * Can `g` join the disk-shaped group? It shares one contiguous run of smooth edges
 * with the group (so the union stays one disk without holes), touches the group at
 * no other vertex, agrees with the group's corner values across the run, and lies
 * in the seed plane.
 */
function joinable(
  mesh: EditMesh,
  g: number,
  group: ReadonlySet<number>,
  groupVertices: ReadonlySet<number>,
  plane: { readonly n: Tuple3; readonly c: Tuple3 },
  distance: number,
): boolean {
  if (dot(faceNormal(mesh, g), plane.n) <= 0) return false;
  const halves = mesh.faceHalves(g);
  for (const h of halves) {
    if (Math.abs(dot(sub(mesh.position(mesh.hVert[h] as number), plane.c), plane.n)) > distance)
      return false;
  }
  const shared = halves.map((h) => group.has(mesh.hFace[h ^ 1] as number));
  const runs = shared.filter((s, i) => s && !shared[(i + halves.length - 1) % halves.length]);
  if (runs.length !== 1 || shared.every(Boolean)) return false;
  const onPath = new Set<number>();
  for (const [i, h] of halves.entries()) {
    if (!shared[i]) continue;
    if ((mesh.eFlags[h >> 1] as number) !== 0) return false;
    const twin = h ^ 1;
    if (!cornersEqual(mesh, h, mesh.hNext[twin] as number)) return false;
    if (!cornersEqual(mesh, mesh.hNext[h] as number, twin)) return false;
    onPath.add(mesh.hVert[h] as number);
    onPath.add(mesh.hVert[twin] as number);
  }
  for (const h of halves) {
    const v = mesh.hVert[h] as number;
    if (!onPath.has(v) && groupVertices.has(v)) return false;
  }
  return true;
}

function boundaryLoop(mesh: EditMesh, faces: readonly number[]): CornerSource[] | undefined {
  const inside = new Set(faces);
  const startOf = new Map<number, number>();
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      if (inside.has(mesh.hFace[h ^ 1] as number)) continue;
      const v = mesh.hVert[h] as number;
      if (startOf.has(v)) return undefined;
      startOf.set(v, h);
    }
  }
  const first = minOf(startOf.values());
  const loop: CornerSource[] = [];
  let h = first;
  do {
    loop.push({ v: mesh.hVert[h] as number, corner: h });
    h = startOf.get(mesh.hVert[mesh.hNext[h] as number] as number) as number;
  } while (h !== first && h !== undefined && loop.length <= startOf.size);
  return loop.length === startOf.size ? loop : undefined;
}

/**
 * Merge adjacent faces with equal `key` that are coplanar (every vertex within
 * `distance` of the seed face's plane) into hole-free n-gons, growing each group from
 * its largest face, then drop the collinear degree-2 vertices left on straight
 * edges. Edges with author intent (sharp, seam) and corner-value discontinuities
 * are never merged away.
 */
export function mergePlanar(
  mesh: EditMesh,
  faces: readonly number[],
  key: (f: number) => string,
  distance: number,
): Result<PlanarOutcome, ModelingError> {
  const candidates = new Set(faces);
  const order = [...faces]
    .map((f) => ({ f, area: faceArea(mesh, f) }))
    .sort((x, y) => y.area - x.area || x.f - y.f)
    .map((x) => x.f);
  const assigned = new Set<number>();
  const groups: number[][] = [];
  for (const seed of order) {
    if (assigned.has(seed)) continue;
    const plane = { n: faceNormal(mesh, seed), c: faceCentroid(mesh, seed) };
    const k = key(seed);
    const group = new Set([seed]);
    const groupVertices = new Set(mesh.faceVertices(seed));
    assigned.add(seed);
    const queue: number[] = [];
    const enqueue = (f: number) => {
      for (const h of mesh.faceHalves(f)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (g !== NONE && !assigned.has(g) && candidates.has(g) && key(g) === k) queue.push(g);
      }
    };
    enqueue(seed);
    while (queue.length > 0) {
      const g = queue.shift() as number;
      if (assigned.has(g)) continue;
      if (!joinable(mesh, g, group, groupVertices, plane, distance)) continue;
      group.add(g);
      assigned.add(g);
      for (const v of mesh.faceVertices(g)) groupVertices.add(v);
      enqueue(g);
    }
    groups.push([...group].sort((a, b) => a - b));
  }
  const rewrites: FaceRewrite[] = [];
  const roots: number[] = [];
  const kept: number[] = [];
  const interior = new Set<number>();
  for (const group of groups) {
    if (group.length === 1) {
      kept.push(group[0] as number);
      continue;
    }
    const loop = boundaryLoop(mesh, group);
    if (loop === undefined) {
      return err(
        modelingError('model-degenerate', 'every merged planar group has one boundary loop', {
          faces: group.length,
        }),
      );
    }
    for (const f of group) for (const v of mesh.faceVertices(f)) interior.add(v);
    rewrites.push({ face: group[0] as number, loops: [loop] });
    roots.push(group[0] as number);
    for (const f of group.slice(1)) rewrites.push({ face: f, loops: [] });
  }
  const origin = new Map<number, number>();
  for (const f of kept) origin.set(f, f);
  if (rewrites.length > 0) {
    const done = rewriteFaces(mesh, rewrites);
    if (!done.ok) return done;
    for (const [i, rewrite] of rewrites.entries()) {
      const created = done.value[i] as number[];
      if (created.length > 0) origin.set(created[0] as number, rewrite.face);
    }
    removeUnused(mesh, interior);
  }
  const removed = removeCollinear(mesh, [...origin.keys()], distance, origin);

  if (!removed.ok) return removed;
  return ok({
    faces: [...origin.keys()].sort((a, b) => a - b),
    origin,
    merged: roots.length,
    removedVertices: removed.value,
  });
}

function removeUnused(mesh: EditMesh, vertices: Iterable<number>): void {
  const used = new Set<number>();
  for (const f of mesh.faces()) for (const v of mesh.faceVertices(f)) used.add(v);
  for (const v of vertices) if (!used.has(v)) mesh.removeVertex(v);
}

function linear(mesh: EditMesh, prev: number, at: number, next: number, t: number): boolean {
  for (const name of mesh.channels.keys()) {
    const a = mesh.corner(name, prev);
    const m = mesh.corner(name, at);
    const b = mesh.corner(name, next);
    if (a === undefined || m === undefined || b === undefined) {
      if (m !== undefined) return false;
      continue;
    }
    for (let i = 0; i < m.length; i++) {
      const expected = (a[i] as number) + ((b[i] as number) - (a[i] as number)) * t;
      if (Math.abs((m[i] as number) - expected) > VALUE_TOLERANCE) return false;
    }
  }
  return true;
}

/**
 * Remove vertices of the given faces that lie on a straight edge: exactly two edges
 * meet there, both carry the same intent flags, the vertex is within `distance` of
 * the line through its neighbors, and every corner value there is the linear blend
 * of its neighbors. Updates `origin` for rewritten faces.
 */
function removeCollinear(
  mesh: EditMesh,
  faces: readonly number[],
  distance: number,
  origin: Map<number, number>,
): Result<number, ModelingError> {
  let removed = 0;
  let current = new Set(faces);
  for (let pass = 0; pass < 64; pass++) {
    const around = new Map<number, number[]>();
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const v = mesh.hVert[h] as number;
        const list = around.get(v);
        if (list === undefined) around.set(v, [h]);
        else list.push(h);
      }
    }
    const touched = new Set<number>();
    const drops = new Map<number, Set<number>>();
    const joined: { a: number; b: number; flags: number }[] = [];
    const candidates = [...new Set([...current].flatMap((f) => mesh.faceVertices(f)))].sort(
      (a, b) => a - b,
    );
    for (const v of candidates) {
      if (touched.has(v)) continue;
      const corners = around.get(v) ?? [];
      if (corners.length === 0 || corners.length > 2) continue;
      if (!corners.every((h) => current.has(mesh.hFace[h] as number))) continue;
      const neighbors = new Set<number>();
      for (const h of corners) {
        neighbors.add(mesh.hVert[mesh.hNext[h] as number] as number);
        neighbors.add(mesh.hVert[mesh.hPrev[h] as number] as number);
      }
      if (neighbors.size !== 2) continue;
      const [a, b] = [...neighbors] as [number, number];
      if (touched.has(a) || touched.has(b) || mesh.findHalf(a, b) !== NONE) continue;
      const pa = mesh.position(a);
      const pb = mesh.position(b);
      const pv = mesh.position(v);
      const d = sub(pb, pa);
      const len2 = dot(d, d);
      if (len2 === 0) continue;
      const t = dot(sub(pv, pa), d) / len2;
      if (t <= 0 || t >= 1) continue;
      const off = sub(sub(pv, pa), [d[0] * t, d[1] * t, d[2] * t]);
      if (dot(off, off) > distance * distance) continue;
      const ha = mesh.findHalf(a, v);
      const hb = mesh.findHalf(v, b);
      if ((mesh.eFlags[ha >> 1] as number) !== (mesh.eFlags[hb >> 1] as number)) continue;
      const fits = corners.every((h) => {
        const f = mesh.hFace[h] as number;
        const len = mesh.fLen[f] as number;
        const dropping = drops.get(f)?.size ?? 0;
        if (len - dropping <= 3) return false;
        const prev = mesh.hPrev[h] as number;
        const next = mesh.hNext[h] as number;
        const along = mesh.hVert[prev] as number;
        return linear(mesh, prev, h, next, along === a ? t : 1 - t);
      });
      if (!fits) continue;
      for (const h of corners) {
        const f = mesh.hFace[h] as number;
        const set = drops.get(f) ?? new Set<number>();
        set.add(v);
        drops.set(f, set);
      }
      joined.push({ a, b, flags: mesh.eFlags[ha >> 1] as number });
      touched.add(v);
      touched.add(a);
      touched.add(b);
    }
    if (drops.size === 0) break;
    const rewrites: FaceRewrite[] = [...drops.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([face, vertices]) => ({
        face,
        loops: [faceCorners(mesh, face).filter((c) => !vertices.has(c.v))],
      }));
    const done = rewriteFaces(mesh, rewrites);
    if (!done.ok) return done;
    for (const { a, b, flags } of joined) {
      const h = mesh.findHalf(a, b);
      if (h !== NONE) mesh.eFlags[h >> 1] = flags;
    }
    // Rewritten faces reuse freed ids in any order: retire every source id first.
    const next = new Set(current);
    const from = rewrites.map((rewrite) => origin.get(rewrite.face) ?? rewrite.face);
    for (const rewrite of rewrites) {
      next.delete(rewrite.face);
      origin.delete(rewrite.face);
    }
    for (const [i] of rewrites.entries()) {
      const g = (done.value[i] as number[])[0] as number;
      next.add(g);
      origin.set(g, from[i] as number);
    }
    current = next;
    const dropped = new Set<number>();
    for (const vertices of drops.values()) for (const v of vertices) dropped.add(v);
    for (const v of dropped) mesh.removeVertex(v);
    removed += dropped.size;
  }
  return ok(removed);
}

/** Attribute identity of a face for the public cleanup.planar: slot, origin, flags and tags. */
export function attributeKey(mesh: EditMesh, f: number): string {
  const tags = mesh.fTags.subarray(f * mesh.tagWords, (f + 1) * mesh.tagWords).join('.');
  return `${mesh.fMaterial[f]}|${mesh.fLabel[f]}|${mesh.fRole[f]}|${mesh.fFlags[f]}|${tags}`;
}

/**
 * `cleanup.planar` (design 8): merge coplanar adjacent faces with identical
 * attributes back into n-gons and remove collinear vertices. Effect assertion: at
 * least one merge or vertex removal.
 */
export function cleanupPlanar(
  mesh: EditMesh,
  faces: readonly number[],
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const done = mergePlanar(mesh, faces, (f) => attributeKey(mesh, f), tolerance * 10);
  if (!done.ok) return done;
  if (done.value.merged === 0 && done.value.removedVertices === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'cleanup.planar merges coplanar faces or removes a collinear vertex',
        { faces: faces.length },
        'the faces are already maximal n-gons; faces with different tags, slots or origins never merge',
      ),
    );
  }
  return ok({ mergedGroups: done.value.merged, removedVertices: done.value.removedVertices });
}

/** Cosine of the widest quad corner, 170 degrees. */
const STRAIGHT_CORNER = -0.9848;

export interface QuadOptions {
  /** Largest angle in degrees between the two triangles' normals (default 15). */
  readonly maxAngle?: number;
  /** Largest distance between the quad's diagonals over the longer diagonal (default 0.02). */
  readonly maxPlanarity?: number;
}

/** Quad-dominance facts of faces: quad share of the area, quad planarity p99 and vertex valence. */
export interface QuadMetrics {
  readonly quads: number;
  readonly triangles: number;
  readonly polygons: number;
  readonly quadAreaRatio: number;
  readonly planarityP99: number;
  /** Interior vertices with valence 3 to 6 over all interior vertices (1 without any). */
  readonly regularValence: number;
  readonly highValence: number;
}

function cross3(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function len3(a: Tuple3): number {
  return Math.sqrt(dot(a, a));
}

/** Distance between the diagonal lines ac and bd of quad abcd, over the longer diagonal. */
export function quadPlanarity(p: readonly Tuple3[]): number {
  const [a, b, c, d] = p as [Tuple3, Tuple3, Tuple3, Tuple3];
  const u = sub(c, a);
  const v = sub(d, b);
  const n = cross3(u, v);
  const l = len3(n);
  const diagonal = Math.max(len3(u), len3(v));
  if (!(l > 0) || !(diagonal > 0)) return Infinity;
  return Math.abs(dot(sub(b, a), n)) / l / diagonal;
}

export function quadMetrics(mesh: EditMesh, faces: readonly number[]): QuadMetrics {
  let quads = 0;
  let triangles = 0;
  let quadArea = 0;
  let area = 0;
  const planarity: number[] = [];
  const valence = new Map<number, number>();
  const boundary = new Set<number>();
  const chosen = new Set(faces);
  for (const f of faces) {
    const halves = mesh.faceHalves(f);
    const a = faceArea(mesh, f);
    area += a;
    if (halves.length === 3) triangles++;
    if (halves.length === 4) {
      quads++;
      quadArea += a;
      planarity.push(quadPlanarity(mesh.faceVertices(f).map((v) => mesh.position(v))));
    }
    for (const h of halves) {
      const v = mesh.hVert[h] as number;
      valence.set(v, (valence.get(v) ?? 0) + 1);
      if (!chosen.has(mesh.hFace[h ^ 1] as number)) {
        boundary.add(v);
        boundary.add(mesh.hVert[h ^ 1] as number);
      }
    }
  }
  let interior = 0;
  let regular = 0;
  let high = 0;
  for (const [v, k] of [...valence].sort((x, y) => x[0] - y[0])) {
    if (boundary.has(v)) continue;
    interior++;
    if (k >= 3 && k <= 6) regular++;
    if (k > 6) high++;
  }
  planarity.sort((x, y) => x - y);
  return {
    quads,
    triangles,
    polygons: faces.length - quads - triangles,
    quadAreaRatio: area > 0 ? quadArea / area : 0,
    planarityP99:
      planarity.length === 0
        ? 0
        : (planarity[
            Math.min(planarity.length - 1, Math.floor(planarity.length * 0.99))
          ] as number),
    regularValence: interior === 0 ? 1 : regular / interior,
    highValence: high,
  };
}

/**
 * Pair adjacent triangles into quads: an interior edge between two triangles of
 * equal attributes, with no author intent (sharp, seam) and continuous corner values, joins
 * when the triangles' normals are within `maxAngle`, the quad is convex with every corner
 * under 170 degrees, and its planarity is within `maxPlanarity`. Triangles with the fewest
 * candidates pair first, each with its best-scoring partner (planarity, bend, corner
 * squareness; ties by edge id), so the result depends only on the mesh. Returns the quads.
 */
export function pairQuads(
  mesh: EditMesh,
  faces: readonly number[],
  options: QuadOptions,
): Result<number, ModelingError> {
  const maxAngle = options.maxAngle ?? 15;
  const maxPlanarity = options.maxPlanarity ?? 0.02;
  if (!(maxAngle >= 0 && maxAngle < 90)) {
    return err(modelingError('model-invalid-argument', 'maxAngle is in [0, 90)', { maxAngle }));
  }
  if (!(maxPlanarity >= 0 && Number.isFinite(maxPlanarity))) {
    return err(
      modelingError('model-invalid-argument', 'maxPlanarity is finite and >= 0', { maxPlanarity }),
    );
  }
  const minCos = cos((maxAngle * Math.PI) / 180);
  const chosen = new Set(faces.filter((f) => mesh.faceHalves(f).length === 3));
  const candidates: { e: number; score: number; loop: CornerSource[]; f: number; g: number }[] = [];
  for (const f of [...chosen].sort((x, y) => x - y)) {
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      if (g === NONE || g <= f || !chosen.has(g)) continue;
      if ((mesh.eFlags[h >> 1] as number) !== 0) continue;
      if (attributeKey(mesh, f) !== attributeKey(mesh, g)) continue;
      const twin = h ^ 1;
      if (!cornersEqual(mesh, h, mesh.hNext[twin] as number)) continue;
      if (!cornersEqual(mesh, mesh.hNext[h] as number, twin)) continue;
      const nf = faceNormal(mesh, f);
      const ng = faceNormal(mesh, g);
      const bend = dot(nf, ng);
      if (bend < minCos) continue;
      // h runs a -> b in f; the quad is a, (g's apex), b, (f's apex).
      const fApex = mesh.hNext[mesh.hNext[h] as number] as number;
      const gApex = mesh.hNext[mesh.hNext[twin] as number] as number;
      const loop: CornerSource[] = [
        { v: mesh.hVert[h] as number, corner: h },
        { v: mesh.hVert[gApex] as number, corner: gApex },
        { v: mesh.hVert[mesh.hNext[h] as number] as number, corner: mesh.hNext[h] as number },
        { v: mesh.hVert[fApex] as number, corner: fApex },
      ];
      const p = loop.map((c) => mesh.position(c.v));
      const n: Tuple3 = [nf[0] + ng[0], nf[1] + ng[1], nf[2] + ng[2]];
      let convex = true;
      let square = 0;
      for (let i = 0; i < 4; i++) {
        const prev = p[(i + 3) % 4] as Tuple3;
        const at = p[i] as Tuple3;
        const next = p[(i + 1) % 4] as Tuple3;
        const u = sub(next, at);
        const w = sub(prev, at);
        if (dot(cross3(u, w), n) <= 0) convex = false;
        const l = len3(u) * len3(w);
        const c = l > 0 ? dot(u, w) / l : -1;
        // A nearly straight corner makes a degenerate triangle of the other diagonal.
        if (c < STRAIGHT_CORNER) convex = false;
        square += Math.abs(c);
      }
      if (!convex) continue;
      const planarity = quadPlanarity(p);
      if (planarity > maxPlanarity) continue;
      candidates.push({ e: h >> 1, score: planarity + (1 - bend) + square / 4, loop, f, g });
    }
  }
  candidates.sort((x, y) => x.score - y.score || x.e - y.e);
  // Fewest-options-first greedy matching: a triangle with one candidate pairs before its
  // partner spends itself elsewhere, which leaves far fewer triangles than score order alone.
  const partners = new Map<number, typeof candidates>();
  for (const c of candidates) {
    for (const t of [c.f, c.g]) {
      const list = partners.get(t);
      if (list === undefined) partners.set(t, [c]);
      else list.push(c);
    }
  }
  type Candidate = (typeof candidates)[number];
  const used = new Set<number>();
  const free = (t: number): Candidate[] =>
    (partners.get(t) ?? []).filter((c) => !used.has(c.f) && !used.has(c.g));
  // Min-heap of [free count, best score, best edge, triangle]; stale entries are skipped.
  type Entry = readonly [number, number, number, number];
  const heap: Entry[] = [];
  const less = (a: Entry, b: Entry) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
  const push = (t: number) => {
    const list = free(t);
    if (list.length === 0) return;
    const first = list[0] as Candidate;
    const entry: Entry = [list.length, first.score, first.e, t];
    heap.push(entry);
    for (let i = heap.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (less(heap[up] as Entry, heap[i] as Entry) <= 0) break;
      [heap[up], heap[i]] = [heap[i] as Entry, heap[up] as Entry];
      i = up;
    }
  };
  const pop = (): Entry | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l] as Entry, heap[m] as Entry) < 0) m = l;
        if (r < heap.length && less(heap[r] as Entry, heap[m] as Entry) < 0) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i] as Entry, heap[m] as Entry];
        i = m;
      }
    }
    return top;
  };
  for (const t of [...partners.keys()].sort((a, b) => a - b)) push(t);
  const rewrites: FaceRewrite[] = [];
  for (let entry = pop(); entry !== undefined; entry = pop()) {
    const t = entry[3];
    if (used.has(t)) continue;
    const list = free(t);
    const best = list[0];
    if (best === undefined) continue;
    if (list.length !== entry[0] || best.e !== entry[2]) {
      push(t);
      continue;
    }
    used.add(best.f);
    used.add(best.g);
    rewrites.push({ face: best.f, loops: [best.loop] }, { face: best.g, loops: [] });
    for (const c of [...(partners.get(best.f) ?? []), ...(partners.get(best.g) ?? [])]) {
      for (const other of [c.f, c.g]) if (!used.has(other)) push(other);
    }
  }
  if (rewrites.length === 0) return ok(0);
  const done = rewriteFaces(mesh, rewrites);
  if (!done.ok) return done;
  return ok(rewrites.length / 2);
}

/** `cleanup.quads`: pairQuads with the no-effect assertion and the quad metrics. */
export function cleanupQuads(
  mesh: EditMesh,
  faces: readonly number[],
  options: QuadOptions,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const before = new Set(mesh.faces());
  const paired = pairQuads(mesh, faces, options);
  if (!paired.ok) return paired;
  if (paired.value === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'cleanup.quads pairs at least two triangles',
        { faces: faces.length },
        'raise maxAngle or maxPlanarity; sharp edges, seams and attribute borders never pair',
      ),
    );
  }
  const kept = new Set(faces);
  const result = mesh.faces().filter((f) => kept.has(f) || !before.has(f));
  diagnostics.push({
    severity: 'info',
    message: `cleanup.quads made ${paired.value} quad(s)`,
    detail: { paired: paired.value, ...quadMetrics(mesh, result) },
  });
  return ok({ quads: paired.value });
}
