import { err, ok, type Result } from '@forgeax/engine-types';
import { verticesOnSegment } from './compute/segments';
import { type ModelingError, modelingError } from './errors';
import { dot, length, newell, normalize, sub, type Tuple3, triangulateLoop } from './geom';
import { type EditMesh, NONE } from './mesh';
import {
  MAX_REPAIR_SITES,
  type OpDiagnostic,
  type RepairSink,
  type RepairSite,
  type RoleCounts,
  repairBase,
  requirePositive,
} from './ops';
import { type CornerSource, type FaceRewrite, faceCorners, rewriteFaces } from './rewrite';

function positions(mesh: EditMesh): Tuple3[] {
  const out: Tuple3[] = [];
  for (let v = 0; v < mesh.vertexHighWater; v++) out.push(mesh.position(v));
  return out;
}

/** Insert points into face edges: `inserts` maps a face half to the vertices placed after its start, with parameters. */
function insertIntoFaces(
  mesh: EditMesh,
  inserts: ReadonlyMap<number, readonly { vertex: number; t: number }[]>,
  onInsert?: (vertex: number, from: number, to: number) => void,
): Result<number, ModelingError> {
  const byFace = new Map<number, number[]>();
  for (const h of inserts.keys()) {
    const f = mesh.hFace[h] as number;
    const list = byFace.get(f) ?? [];
    list.push(h);
    byFace.set(f, list);
  }
  const parent = new Map<number, readonly [number, number]>();
  const rewrites: FaceRewrite[] = [];
  let inserted = 0;
  for (const f of [...byFace.keys()].sort((a, b) => a - b)) {
    const loop: CornerSource[] = [];
    const present = new Set(mesh.faceVertices(f));
    for (const h of mesh.faceHalves(f)) {
      loop.push({ v: mesh.hVert[h] as number, corner: h });
      const next = mesh.hNext[h] as number;
      for (const { vertex, t } of inserts.get(h) ?? []) {
        if (present.has(vertex)) continue;
        present.add(vertex);
        loop.push({ v: vertex, from: h, to: next, t });
        parent.set(vertex, [mesh.hVert[h] as number, mesh.hVert[next] as number]);
        onInsert?.(vertex, mesh.hVert[h] as number, mesh.hVert[next] as number);
        inserted++;
      }
    }
    rewrites.push({ face: f, loops: [loop] });
  }
  const done = rewriteFaces(mesh, rewrites, parent);
  if (!done.ok) return done;
  return ok(inserted);
}

/**
 * `resolveTJunctions` (design 8 repair): a boundary edge that has vertices of other
 * boundary edges lying on it (within `distance`) takes those vertices into its face,
 * so both sides of a seam share their vertices and the seam can close. Corner values
 * are interpolated along the edge; the pieces keep the edge's intent flags.
 */
export function resolveTJunctions(
  mesh: EditMesh,
  distance: number,
  repair: RepairSink,
): Result<RoleCounts, ModelingError> {
  const checked = requirePositive('distance', distance);
  if (!checked.ok) return checked;
  const events: RepairSite[] = [];
  // The input edge each piece of a split edge descends from, so a vertex inserted in a later
  // pass is measured against the edge the input had, not against a bent piece of it.
  const hostOf = new Map<string, readonly [Tuple3, Tuple3]>();
  const pieceKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let pass = 0; pass < 8; pass++) {
    const open = mesh.edges().filter((e) => mesh.isBoundaryEdge(e));
    const ends = new Set<number>();
    for (const e of open) for (const v of mesh.edgeVertices(e)) ends.add(v);
    const points = positions(mesh);
    const sorted = [...ends].sort(
      (x, y) => (points[x] as Tuple3)[0] - (points[y] as Tuple3)[0] || x - y,
    );
    const inserts = new Map<number, { vertex: number; t: number }[]>();
    for (const e of open) {
      const h = (mesh.hFace[e * 2] as number) === NONE ? e * 2 + 1 : e * 2;
      const a = mesh.hVert[h] as number;
      const b = mesh.hVert[mesh.hNext[h] as number] as number;
      const hits = verticesOnSegment(a, b, points, sorted, distance);
      if (hits.length > 0) inserts.set(h, hits);
    }
    if (inserts.size === 0) break;
    const placed = new Map<string, { from: number; to: number; vertices: number[] }>();
    const done = insertIntoFaces(mesh, inserts, (vertex, from, to) => {
      const key = pieceKey(from, to);
      const host = hostOf.get(key) ?? ([points[from], points[to]] as [Tuple3, Tuple3]);
      const at = mesh.position(vertex);
      events.push({ at, deviation: distanceToLine(at, host[0], host[1]) });
      const entry = placed.get(key) ?? { from, to, vertices: [] };
      entry.vertices.push(vertex);
      placed.set(key, entry);
    });
    if (!done.ok) return done;
    if (done.value === 0) break;
    for (const [key, { from, to, vertices }] of placed) {
      const host = hostOf.get(key) ?? ([points[from], points[to]] as [Tuple3, Tuple3]);
      const chain = [from, ...vertices, to];
      for (let i = 0; i + 1 < chain.length; i++) {
        hostOf.set(pieceKey(chain[i] as number, chain[i + 1] as number), host);
      }
    }
  }
  if (events.length === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        `a boundary edge has another boundary vertex within ${distance} m of its interior`,
        { distance, boundaryEdges: mesh.edges().filter((e) => mesh.isBoundaryEdge(e)).length },
        'raise distance, or weld coincident vertices with m.weld()',
      ),
    );
  }
  repair({ op: 'resolveTJunctions', ...repairBase(events) });
  return ok({});
}

/** Distance of `p` from the line through `a` and `b`. */
function distanceToLine(p: Tuple3, a: Tuple3, b: Tuple3): number {
  const d = sub(b, a);
  const r = sub(p, a);
  const len2 = dot(d, d);
  const t = len2 > 0 ? dot(r, d) / len2 : 0;
  return length(sub(r, [d[0] * t, d[1] * t, d[2] * t]));
}

/** Faceless halves of the selected boundary edges, chained head to tail. */
function boundaryChains(
  mesh: EditMesh,
  edges: readonly number[],
): Result<{ halves: number[]; closed: boolean }[], ModelingError> {
  const free = new Map<number, number>();
  for (const e of edges) {
    if (!mesh.isBoundaryEdge(e)) {
      return err(
        modelingError(
          'model-precondition',
          'weldEdgeSequence takes boundary edges',
          { edge: e },
          'select the two open edge sequences with sel.edges.meshBoundary()',
        ),
      );
    }
    const h = (mesh.hFace[e * 2] as number) === NONE ? e * 2 : e * 2 + 1;
    const start = mesh.hVert[h] as number;
    if (free.has(start)) {
      return err(
        modelingError(
          'model-precondition',
          'each selected boundary vertex starts one selected edge',
          {
            vertex: start,
          },
        ),
      );
    }
    free.set(start, h);
  }
  const ends = new Map<number, number>();
  for (const h of free.values()) ends.set(mesh.hVert[h ^ 1] as number, h);
  const used = new Set<number>();
  const chains: { halves: number[]; closed: boolean }[] = [];
  for (const h of [...free.values()].sort((a, b) => a - b)) {
    if (used.has(h)) continue;
    let first = h;
    while (ends.has(mesh.hVert[first] as number)) {
      const previous = ends.get(mesh.hVert[first] as number) as number;
      if (previous === h) break;
      first = previous;
    }
    const halves: number[] = [];
    let at = first;
    for (;;) {
      halves.push(at);
      used.add(at);
      const next = free.get(mesh.hVert[at ^ 1] as number);
      if (next === undefined || next === first) break;
      at = next;
    }
    const closed = free.get(mesh.hVert[at ^ 1] as number) === first;
    chains.push({ halves, closed });
  }
  return ok(chains);
}

function arcParameters(points: readonly Tuple3[], closed: boolean): number[] {
  const out = [0];
  let sum = 0;
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    sum += length(sub(points[(i + 1) % points.length] as Tuple3, points[i] as Tuple3));
    out.push(sum);
  }
  return out.map((s) => (sum === 0 ? 0 : s / sum));
}

/**
 * `weldEdgeSequence` (design 8 repair): stitch two selected boundary edge sequences
 * that face each other. The second runs opposite to the first (that is how two open
 * sides of one seam are oriented); both get vertices at the other's arc-length
 * parameters, then paired vertices merge at their midpoint and the seam closes. A
 * pair farther apart than `maxDistance` is `model-precondition`.
 */
export function weldEdgeSequence(
  mesh: EditMesh,
  edges: readonly number[],
  maxDistance: number,
  repair: RepairSink,
): Result<RoleCounts, ModelingError> {
  const traced = boundaryChains(mesh, edges);
  if (!traced.ok) return traced;
  const chains = traced.value;
  if (
    chains.length !== 2 ||
    (chains[0] as { closed: boolean }).closed !== (chains[1] as { closed: boolean }).closed
  ) {
    return err(
      modelingError(
        'model-precondition',
        'the selection is two boundary edge sequences, both open or both closed',
        { sequences: chains.map((c) => ({ edges: c.halves.length, closed: c.closed })) },
      ),
    );
  }
  const closed = (chains[0] as { closed: boolean }).closed;
  const verticesOf = (halves: readonly number[]) => {
    const vs = halves.map((h) => mesh.hVert[h] as number);
    if (!closed) vs.push(mesh.hVert[(halves[halves.length - 1] as number) ^ 1] as number);
    return vs;
  };
  const first = verticesOf((chains[0] as { halves: number[] }).halves);
  let second = verticesOf((chains[1] as { halves: number[] }).halves).reverse();
  if (closed) {
    const p0 = mesh.position(first[0] as number);
    let best = 0;
    for (let i = 1; i < second.length; i++) {
      if (
        length(sub(mesh.position(second[i] as number), p0)) <
        length(sub(mesh.position(second[best] as number), p0))
      )
        best = i;
    }
    second = [...second.slice(best), ...second.slice(0, best)];
  }
  const sequences = [first, second];
  const params = sequences.map((vs) =>
    arcParameters(
      vs.map((v) => mesh.position(v)),
      closed,
    ),
  );
  const merged = [...new Set([...(params[0] as number[]), ...(params[1] as number[])])].sort(
    (x, y) => x - y,
  );
  const grid: number[] = [];
  for (const t of merged)
    if (grid.length === 0 || t - (grid[grid.length - 1] as number) > 1e-9) grid.push(t);
  const inserts = new Map<number, { vertex: number; t: number }[]>();
  const full: number[][] = [];
  for (const [s, vs] of sequences.entries()) {
    const own = params[s] as number[];
    const out: number[] = [];
    let segment = 0;
    for (const t of grid) {
      while (segment + 1 < own.length - 1 && (own[segment + 1] as number) <= t + 1e-9) segment++;
      const at = own.findIndex((u) => Math.abs(u - t) <= 1e-9);
      if (at >= 0 && at < vs.length) {
        out.push(vs[at] as number);
        continue;
      }
      if (closed && at === vs.length) continue;
      const a = vs[segment] as number;
      const b = vs[(segment + 1) % vs.length] as number;
      const local =
        (t - (own[segment] as number)) / ((own[segment + 1] as number) - (own[segment] as number));
      const pa = mesh.position(a);
      const pb = mesh.position(b);
      const v = mesh.addVertex(
        pa[0] + (pb[0] - pa[0]) * local,
        pa[1] + (pb[1] - pa[1]) * local,
        pa[2] + (pb[2] - pa[2]) * local,
      );
      out.push(v);
      const ab = mesh.findHalf(a, b);
      const forward = (mesh.hFace[ab] as number) !== NONE;
      const face = forward ? ab : ab ^ 1;
      const list = inserts.get(face) ?? [];
      list.push({ vertex: v, t: forward ? local : 1 - local });
      inserts.set(face, list);
    }
    full.push(out);
  }
  for (const list of inserts.values()) list.sort((x, y) => x.t - y.t);
  let inserted = 0;
  if (inserts.size > 0) {
    const done = insertIntoFaces(mesh, inserts);
    if (!done.ok) return done;
    inserted = done.value;
  }
  const [p, q] = full as [number[], number[]];
  if (p.length !== q.length) {
    return err(
      modelingError('model-degenerate', 'both sequences reach the same vertex count', {
        counts: [p.length, q.length],
      }),
    );
  }
  const partner = new Map<number, number>();
  const events: RepairSite[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as number;
    const b = q[i] as number;
    if (a === b) continue;
    const gap = length(sub(mesh.position(a), mesh.position(b)));
    if (gap > maxDistance) {
      return err(
        modelingError(
          'model-precondition',
          `paired seam vertices are within ${maxDistance} m`,
          { gap, at: mesh.position(a) },
          'move the sequences together first, or raise maxDistance',
        ),
      );
    }
    partner.set(b, a);
    const pa = mesh.position(a);
    const pb = mesh.position(b);
    events.push({
      at: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2],
      deviation: gap / 2,
    });
  }
  const rewrites: FaceRewrite[] = [];
  for (const f of mesh.faces()) {
    const corners = faceCorners(mesh, f);
    if (!corners.some((c) => partner.has(c.v))) continue;
    rewrites.push({
      face: f,
      loops: [corners.map((c) => ({ ...c, v: partner.get(c.v) ?? c.v }) as CornerSource)],
    });
  }
  for (const [b, a] of partner) {
    const pa = mesh.position(a);
    const pb = mesh.position(b);
    mesh.setPosition(a, (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2);
  }
  const done = rewriteFaces(mesh, rewrites);
  if (!done.ok) return done;
  for (const b of partner.keys()) mesh.removeVertex(b);
  repair({ op: 'weldEdgeSequence', ...repairBase(events), inserted });
  return ok({});
}

/**
 * Width of a polygon across its longest edge: the largest distance of a vertex from
 * that edge's line (a triangle's height; about the width of a strip).
 */
export function loopWidth(points: readonly Tuple3[]): number {
  let longest = -1;
  let from = 0;
  for (let i = 0; i < points.length; i++) {
    const d = sub(points[(i + 1) % points.length] as Tuple3, points[i] as Tuple3);
    const l = dot(d, d);
    if (l > longest) {
      longest = l;
      from = i;
    }
  }
  const a = points[from] as Tuple3;
  const d = sub(points[(from + 1) % points.length] as Tuple3, a);
  const len2 = dot(d, d);
  let width = 0;
  for (const p of points) {
    const r = sub(p, a);
    const t = len2 > 0 ? dot(r, d) / len2 : 0;
    width = Math.max(width, length(sub(r, [d[0] * t, d[1] * t, d[2] * t])));
  }
  return width;
}

/**
 * The live faces of `faces` narrower than `width` (see `loopWidth`): the one sliver
 * definition, shared by `cleanup.slivers`, which removes them, and `validate({ slivers })`,
 * which fails while any remain.
 */
export function sliverFaces(mesh: EditMesh, faces: readonly number[], width: number): number[] {
  return faces.filter(
    (f) =>
      mesh.isFaceAlive(f) && loopWidth(mesh.faceVertices(f).map((v) => mesh.position(v))) <= width,
  );
}

interface Plane {
  readonly n: Tuple3;
  readonly w: number;
  readonly area?: number;
}

/**
 * The point closest to every plane in least squares, pulled toward `near` with a small
 * weight so that fewer than three independent planes still give a definite point.
 */
function planesPoint(planes: readonly Plane[], near: Tuple3): Tuple3 {
  const mu = 1e-9;
  const a = [mu, 0, 0, 0, mu, 0, 0, 0, mu];
  const b = [near[0] * mu, near[1] * mu, near[2] * mu];
  for (const { n, w } of planes) {
    for (let i = 0; i < 3; i++) {
      b[i] = (b[i] as number) + (n[i] as number) * w;
      for (let j = 0; j < 3; j++) {
        a[i * 3 + j] = (a[i * 3 + j] as number) + (n[i] as number) * (n[j] as number);
      }
    }
  }
  for (let c = 0; c < 3; c++) {
    let pivot = c;
    for (let r = c + 1; r < 3; r++) {
      if (Math.abs(a[r * 3 + c] as number) > Math.abs(a[pivot * 3 + c] as number)) pivot = r;
    }
    if (pivot !== c) {
      for (let k = 0; k < 3; k++) {
        const t = a[c * 3 + k] as number;
        a[c * 3 + k] = a[pivot * 3 + k] as number;
        a[pivot * 3 + k] = t;
      }
      const t = b[c] as number;
      b[c] = b[pivot] as number;
      b[pivot] = t;
    }
    const d = a[c * 3 + c] as number;
    for (let r = c + 1; r < 3; r++) {
      const f = (a[r * 3 + c] as number) / d;
      for (let k = c; k < 3; k++)
        a[r * 3 + k] = (a[r * 3 + k] as number) - f * (a[c * 3 + k] as number);
      b[r] = (b[r] as number) - f * (b[c] as number);
    }
  }
  const x: Tuple3 = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let sum = b[r] as number;
    for (let k = r + 1; k < 3; k++) sum -= (a[r * 3 + k] as number) * (x[k] as number);
    x[r] = sum / (a[r * 3 + r] as number);
  }
  return x;
}

export interface SliverOutcome {
  /** Resulting faces in place of the input faces. */
  readonly faces: number[];
  /** Resulting face -> the input face whose attributes and source it carries. */
  readonly origin: Map<number, number>;
  /** Sliver faces removed. */
  readonly collapsed: number;
  /** One per removed sliver: its largest vertex move to the final position of the vertex it merged into. */
  readonly sites: readonly RepairSite[];
}

/**
 * Remove sliver faces by collapsing their short edges, as a boolean result leaves them
 * where a cut runs just past a feature of the other operand. `limit(f)` is the largest
 * width (see `loopWidth`) at which face `f` counts as a sliver, 0 for none. Each sliver
 * goes whole or not at all: its short edges collapse in turn, each merged vertex at the
 * least-squares meet of the planes of its other faces, which must keep every one of
 * those faces within `tolerance` of its plane, its orientation and a simple outline,
 * and the mesh manifold. Vertices move at most twice the face's limit.
 */
export function collapseSlivers(
  mesh: EditMesh,
  faces: readonly number[],
  limit: (f: number) => number,
  tolerance: number,
): Result<SliverOutcome, ModelingError> {
  const origin = new Map<number, number>();
  for (const f of faces) origin.set(f, f);
  let collapsed = 0;
  // Union-find over the vertices merged away in any pass, and each moved or removed
  // vertex's position before its first change, so the reported move is measured from the input.
  const merged = new Map<number, number>();
  const root = (v: number): number => {
    let r = v;
    while (merged.has(r)) r = merged.get(r) as number;
    return r;
  };
  const input = new Map<number, Tuple3>();
  const removedSlivers: number[][] = [];
  for (let pass = 0; pass < 4; pass++) {
    // The faces around each vertex, kept current through the rewrites: a sliver's patch is
    // read from it rather than from a scan of every face.
    const around = new Map<number, Set<number>>();
    const index = (g: number) => {
      for (const v of mesh.faceVertices(g)) {
        const set = around.get(v) ?? new Set<number>();
        set.add(g);
        around.set(v, set);
      }
    };
    for (const g of mesh.faces()) index(g);
    const candidates = [...origin.keys()]
      .map((f) => ({ f, width: loopWidth(mesh.faceVertices(f).map((v) => mesh.position(v))) }))
      .filter(({ f, width }) => width <= limit(origin.get(f) as number))
      .sort((x, y) => x.width - y.width || x.f - y.f);
    let changed = false;
    for (const { f } of candidates) {
      if (!origin.has(f) || !mesh.isFaceAlive(f)) continue;
      const maxMove = 2 * Math.max(limit(origin.get(f) as number), tolerance);
      const plan = planSliver(mesh, f, maxMove, tolerance, around);
      if (plan === undefined) continue;
      const rewrites: FaceRewrite[] = [...plan.loops.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([face, loop]) => ({ face, loops: loop.length >= 3 ? [loop] : [] }));
      for (const r of rewrites) {
        for (const v of mesh.faceVertices(r.face)) around.get(v)?.delete(r.face);
      }
      const own = mesh.faceVertices(f);
      for (const v of [...plan.moved.keys(), ...plan.removed]) {
        if (!input.has(v)) input.set(v, mesh.position(v));
      }
      for (const [v, p] of plan.moved) mesh.setPosition(v, p[0], p[1], p[2]);
      const done = rewriteFaces(mesh, rewrites);
      if (!done.ok) return done;
      for (const created of done.value) for (const g of created) index(g);
      const from = rewrites.map((r) => origin.get(r.face));
      for (const r of rewrites) origin.delete(r.face);
      for (const [i, created] of done.value.entries()) {
        const source = from[i];
        if (source === undefined) continue;
        for (const g of created) origin.set(g, source);
      }
      for (const v of plan.removed) {
        mesh.removeVertex(v);
        around.delete(v);
      }
      for (const [v, into] of plan.merged) merged.set(v, into);
      removedSlivers.push(own);
      collapsed++;
      changed = true;
    }
    if (!changed) break;
  }
  const sites: RepairSite[] = removedSlivers.map((own) => {
    let site: RepairSite | undefined;
    for (const v of own) {
      const into = mesh.position(root(v));
      const deviation = length(sub(into, input.get(v) ?? into));
      if (site === undefined || deviation > site.deviation) site = { at: into, deviation };
    }
    return site as RepairSite;
  });
  return ok({ faces: [...origin.keys()].sort((a, b) => a - b), origin, collapsed, sites });
}

/**
 * The rewrite that removes sliver `f`: new loops (as rewrite corners) of every face
 * around its vertices, moved vertex positions and the vertices merged away, or
 * undefined when some check fails.
 */
function planSliver(
  mesh: EditMesh,
  f: number,
  maxMove: number,
  tolerance: number,
  around: ReadonlyMap<number, ReadonlySet<number>>,
):
  | {
      readonly loops: Map<number, CornerSource[]>;
      readonly moved: Map<number, Tuple3>;
      readonly removed: number[];
      /** Each vertex merged away, to the vertex it merged into. */
      readonly merged: Map<number, number>;
    }
  | undefined {
  const own = mesh.faceVertices(f);
  const ownSet = new Set(own);
  const patch = new Set<number>();
  // Per vertex in ascending face order, as a scan of the faces would add them.
  for (const v of own)
    for (const g of [...(around.get(v) ?? [])].sort((a, b) => a - b)) patch.add(g);
  const planes = new Map<number, Plane>();
  const corners = new Map<number, number[]>();
  for (const g of patch) {
    const halves = mesh.faceHalves(g);
    corners.set(g, halves);
    if (g === f) continue;
    const points = halves.map((h) => mesh.position(mesh.hVert[h] as number));
    const normal = newell(points);
    const n = normalize(normal);
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) return undefined;
    let w = 0;
    for (const p of points) w += dot(n, p) / points.length;
    planes.set(g, { n, w, area: length(normal) / 2 });
  }
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while (parent.has(r)) r = parent.get(r) as number;
    return r;
  };
  const position = new Map<number, Tuple3>();
  const at = (v: number): Tuple3 => position.get(v) ?? mesh.position(v);
  const loopOf = (g: number): number[] => {
    const out: number[] = [];
    for (const h of corners.get(g) as number[]) {
      const v = find(mesh.hVert[h] as number);
      if (out[out.length - 1] !== v) out.push(v);
    }
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
  };
  for (let step = 0; step < own.length; step++) {
    const loop = loopOf(f);
    if (loop.length < 3 || new Set(loop).size < loop.length) break;
    let best = -1;
    let shortest = Infinity;
    for (let i = 0; i < loop.length; i++) {
      const d = length(sub(at(loop[(i + 1) % loop.length] as number), at(loop[i] as number)));
      if (d < shortest) {
        shortest = d;
        best = i;
      }
    }
    if (shortest > maxMove) return undefined;
    const a = loop[best] as number;
    const b = loop[(best + 1) % loop.length] as number;
    const near: Tuple3 = [
      (at(a)[0] + at(b)[0]) / 2,
      (at(a)[1] + at(b)[1]) / 2,
      (at(a)[2] + at(b)[2]) / 2,
    ];
    parent.set(b, a);
    const constraints: Plane[] = [];
    for (const [g, plane] of planes) {
      const after = loopOf(g);
      if (after.length >= 3 && after.includes(a)) constraints.push(plane);
    }
    const p = planesPoint(constraints, near);
    for (const v of ownSet) {
      if (find(v) === a && length(sub(p, mesh.position(v))) > maxMove) return undefined;
    }
    position.set(a, p);
  }
  const final = loopOf(f);
  if (final.length >= 3) return undefined;
  const loops = new Map<number, CornerSource[]>();
  const edges = new Set<string>();
  for (const g of patch) {
    const halves = corners.get(g) as number[];
    const loop: CornerSource[] = [];
    for (const h of halves) {
      const v = find(mesh.hVert[h] as number);
      if (loop[loop.length - 1]?.v !== v) loop.push({ v, corner: h });
    }
    while (loop.length > 1 && loop[0]?.v === loop[loop.length - 1]?.v) loop.pop();
    if (g === f || loop.length < 3) {
      loops.set(g, []);
      continue;
    }
    const vs = loop.map((c) => c.v);
    if (new Set(vs).size !== vs.length) return undefined;
    const plane = planes.get(g) as Required<Plane>;
    const points = vs.map(at);
    for (const q of points) if (Math.abs(dot(plane.n, q) - plane.w) > tolerance) return undefined;
    // No face may flip or newly become degenerate; faces that already were go on.
    const area = dot(newell(points), plane.n) / 2;
    if (area <= 0 || (area <= tolerance * tolerance && plane.area > tolerance * tolerance)) {
      return undefined;
    }
    if (triangulateLoop(points) === undefined) return undefined;
    for (let i = 0; i < vs.length; i++) {
      const x = vs[i] as number;
      const y = vs[(i + 1) % vs.length] as number;
      const key = `${x},${y}`;
      if (edges.has(key)) return undefined;
      edges.add(key);
      const h = mesh.findHalf(x, y);
      if (h !== NONE && !patch.has(mesh.hFace[h] as number)) return undefined;
    }
    loops.set(g, loop);
  }
  const moved = new Map<number, Tuple3>();
  for (const [v, p] of position) if (find(v) === v) moved.set(v, p);
  const removed = own.filter((v) => find(v) !== v);
  return { loops, moved, removed, merged: new Map(removed.map((v) => [v, find(v)])) };
}

/**
 * `cleanup.slivers`: collapse the faces narrower than `width` (see `loopWidth`) with
 * `collapseSlivers`. Slivers whose collapse would bend, flip or pinch a neighbour stay
 * and are reported; none narrower than the width is `model-op-no-effect`.
 */
export function cleanupSlivers(
  mesh: EditMesh,
  faces: readonly number[],
  options: { readonly width: number; readonly quiet?: boolean },
  tolerance: number,
  diagnostics: OpDiagnostic[],
  repair: RepairSink,
): Result<RoleCounts, ModelingError> {
  const width = options?.width;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    return err(modelingError('model-invalid-argument', 'width is a finite length > 0', { width }));
  }
  const found = sliverFaces(mesh, faces, width).length;
  if (found === 0 && options.quiet === true) {
    diagnostics.push({
      severity: 'info',
      message: `cleanup.slivers found no face narrower than ${width} m`,
      detail: { width, faces: faces.length },
    });
    repair({ op: 'cleanup.slivers', changed: 0, sites: [], found: 0, kept: [], keptCount: 0 });
    return ok({});
  }
  if (found === 0) {
    return err(
      modelingError('model-op-no-effect', `cleanup.slivers finds a face narrower than ${width} m`, {
        width,
        faces: faces.length,
      }),
    );
  }
  const done = removeSlivers(mesh, faces, width, tolerance);
  if (!done.ok) return done;
  const { kept, sites } = done.value;
  const keptAt = kept.slice(0, MAX_REPAIR_SITES).map((f) => faceCentroidOf(mesh, f));
  repair({
    op: 'cleanup.slivers',
    ...repairBase(sites),
    found,
    kept: keptAt,
    keptCount: kept.length,
  });
  if (kept.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${kept.length} sliver face(s) stay: collapsing them would bend, flip or pinch a neighbour`,
      detail: {
        faces: kept.slice(0, MAX_REPAIR_SITES),
        at: keptAt,
      },
    });
  }
  return ok({});
}

/**
 * Remove the faces of `faces` narrower than `width`: short-edge collapse where every
 * neighbour stays planar, oriented and simple, then needles (apexes within the width
 * of their long edge) join the face across that edge. Returns the count removed and the
 * narrow faces that stay, and one site per removed face.
 */
export function removeSlivers(
  mesh: EditMesh,
  faces: readonly number[],
  width: number,
  tolerance: number,
): Result<
  {
    readonly removed: number;
    readonly kept: number[];
    readonly sites: readonly RepairSite[];
  },
  ModelingError
> {
  if (sliverFaces(mesh, faces, width).length === 0) return ok({ removed: 0, kept: [], sites: [] });
  const done = collapseSlivers(mesh, faces, () => width, tolerance);
  if (!done.ok) return done;
  const live = () => sliverFaces(mesh, done.value.faces, width);
  const absorbed = absorbNeedles(mesh, live(), width, tolerance);
  if (!absorbed.ok) return absorbed;
  return ok({
    removed: done.value.collapsed + absorbed.value.length,
    kept: live(),
    sites: [...done.value.sites, ...absorbed.value],
  });
}

/**
 * Remove needle faces: every vertex lies within `width` of the line of the face's
 * longest edge. The needle is deleted and its other vertices join the face across that
 * edge (in order along it, as near-straight corners), so no vertex moves; on an open
 * boundary the boundary moves in by at most the width. Returns one site per needle gone: deviation 0
 * where it joined a neighbour, its apex distance from the long edge where it was deleted.
 */
function absorbNeedles(
  mesh: EditMesh,
  faces: readonly number[],
  width: number,
  tolerance: number,
): Result<RepairSite[], ModelingError> {
  const sites: RepairSite[] = [];
  for (const f of faces) {
    if (!mesh.isFaceAlive(f)) continue;
    const halves = mesh.faceHalves(f);
    const loop = halves.map((h) => mesh.hVert[h] as number);
    let long = -1;
    let longest = 0;
    for (let i = 0; i < loop.length; i++) {
      const d = length(
        sub(mesh.position(loop[(i + 1) % loop.length] as number), mesh.position(loop[i] as number)),
      );
      if (d > longest) {
        longest = d;
        long = i;
      }
    }
    const a = loop[long] as number;
    const c = loop[(long + 1) % loop.length] as number;
    const pa = mesh.position(a);
    const axis = sub(mesh.position(c), pa);
    const apex: { v: number; t: number; corner: number }[] = [];
    let needle = longest > 0;
    let reach = 0;
    for (let k = 2; k < loop.length && needle; k++) {
      const v = loop[(long + k) % loop.length] as number;
      const t = dot(sub(mesh.position(v), pa), axis) / (longest * longest);
      const off = length(
        sub(mesh.position(v), [pa[0] + axis[0] * t, pa[1] + axis[1] * t, pa[2] + axis[2] * t]),
      );
      if (t <= 0 || t >= 1 || off > width) needle = false;
      reach = Math.max(reach, off);
      apex.push({ v, t, corner: halves[(long + k) % loop.length] as number });
    }
    if (!needle) continue;
    // f runs a -> c along its long edge, then back through its apex vertices to a; the
    // face across runs c -> a and takes over those freed half-edges in the same order.
    const across = mesh.hFace[(halves[long] as number) ^ 1] as number;
    const centroid = faceCentroidOf(mesh, f);
    // A needle on an open boundary (every edge but the long one free) can also just go: its
    // neighbour keeps all its vertices and the boundary moves in by at most the width.
    // Joining keeps the outline exactly, so it is preferred where the plane allows it.
    const onBoundary = halves.every((h, i) => i === long || (mesh.hFace[h ^ 1] as number) === NONE);
    let joins = across !== NONE;
    if (joins) {
      // The neighbour takes the apex vertices: they must lie in its plane, or it bends.
      const points = mesh.faceVertices(across).map((v) => mesh.position(v));
      const n = normalize(newell(points));
      const w = dot(n, points[0] as Tuple3);
      joins = apex.every(({ v }) => Math.abs(dot(n, mesh.position(v)) - w) <= tolerance);
    }
    if (!joins && across !== NONE && !onBoundary) continue;
    if (!joins && across !== NONE) {
      // Apex vertices with only free edges besides the needle's become isolated.
      const lone = apex
        .filter(({ corner }) => {
          const prev = mesh.hPrev[corner] as number;
          return (
            (mesh.hFace[prev ^ 1] as number) === NONE && (mesh.hFace[corner ^ 1] as number) === NONE
          );
        })
        .map(({ v }) => v);
      const done = rewriteFaces(mesh, [{ face: f, loops: [] }]);
      if (!done.ok) return done;
      for (const v of lone) mesh.removeVertex(v);
      sites.push({ at: centroid, deviation: reach });
      continue;
    }
    const rewrites: FaceRewrite[] = [{ face: f, loops: [] }];
    if (across !== NONE) {
      const loopAcross: CornerSource[] = [];
      for (const h of mesh.faceHalves(across)) {
        loopAcross.push({ v: mesh.hVert[h] as number, corner: h });
        if (
          (mesh.hVert[h] as number) === c &&
          (mesh.hVert[mesh.hNext[h] as number] as number) === a
        ) {
          // The apex keeps its own corner values: it sits off the edge, so values
          // interpolated along the edge would collapse the face's UV triangles.
          for (const { v, corner } of apex) loopAcross.push({ v, corner });
        }
      }
      rewrites.push({ face: across, loops: [loopAcross] });
    }
    const done = rewriteFaces(mesh, rewrites);
    if (!done.ok) return done;
    sites.push({ at: centroid, deviation: across === NONE ? reach : 0 });
  }
  return ok(sites);
}

function faceCentroidOf(mesh: EditMesh, f: number): Tuple3 {
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  return [0, 1, 2].map(
    (k) => points.reduce((s, p) => s + (p[k] as number), 0) / points.length,
  ) as Tuple3;
}
