import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import { type ModelingError, modelingError } from '../errors';
import { decodeSnapshot, encodeSnapshot } from '../fxem';
import { newell, type Tuple3, triangulateLoop } from '../geom';
import { EditMesh, NONE } from '../mesh';
import {
  type Bounds,
  type BspNode,
  boundsOf,
  buildTree,
  classify,
  flipPoly,
  IN,
  ON_OPPOSITE,
  ON_SAME,
  OUT,
  type Poly,
  type PolyClass,
  planeOf,
} from './bsp';
import type {
  BackendOutput,
  BooleanJobParams,
  BooleanOperation,
  ComputeBackend,
  ComputeJobKind,
  ComputeJobRequest,
  ComputeLocation,
  FaceProvenance,
  WorkMeter,
} from './job';
import { TS_KERNEL_DIGEST } from './kernel-digest';
import { runRegion } from './region-ts';
import { segmentInsertions } from './segments';

/** Cache identity of the TS backend, derived from its source (see kernel-digest.ts). */
export const TS_BACKEND_IDENTITY = `forgeax-modeling-ts@${TS_KERNEL_DIGEST}`;

const MAX_LOCATIONS = 32;

/**
 * Canonical triangulation of every face of a decoded FXEM mesh, as triples of
 * half-edges: the same ear-clipping rule export uses, from each face's first
 * (canonical) corner. Both backends and the front end share it, so a triangle index
 * in the provenance means the same triangle everywhere. Undefined when a face
 * overlaps itself in its best-fit plane.
 */
export function jobTriangles(mesh: EditMesh): (number[][] | undefined)[] {
  return mesh.faces().map((f) => {
    const halves = mesh.faceHalves(f);
    const indices = triangulateLoop(halves.map((h) => mesh.position(mesh.hVert[h] as number)));
    if (indices === undefined) return undefined;
    const out: number[][] = [];
    for (let i = 0; i < indices.length; i += 3) {
      out.push([0, 1, 2].map((k) => halves[indices[i + k] as number] as number));
    }
    return out;
  });
}

interface Source {
  readonly operand: number;
  readonly face: number;
  readonly triangle: number;
}

interface Operand {
  readonly mesh: EditMesh;
  /** Polygons per edge-connected component, in order of their lowest face. */
  readonly components: Poly[][];
  readonly originals: Set<Tuple3>;
}

function prepare(
  mesh: EditMesh,
  operand: number,
  sources: Source[],
): Result<Operand, ModelingError> {
  const triangles = jobTriangles(mesh);
  const points = new Map<number, Tuple3>();
  const point = (v: number): Tuple3 => {
    let p = points.get(v);
    if (p === undefined) {
      p = mesh.position(v);
      points.set(v, p);
    }
    return p;
  };
  const parent = mesh.faces().map((f) => f);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[x] !== root) {
      const next = parent[x] as number;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      if (g === NONE) continue;
      const a = find(f);
      const b = find(g);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const byRoot = new Map<number, Poly[]>();
  for (const f of mesh.faces()) {
    const tris = triangles[f];
    if (tris === undefined) {
      return err(
        modelingError(
          'model-degenerate',
          'every operand face can be triangulated in its best-fit plane',
          { operand, face: f },
          'the face overlaps itself; split or rebuild it before the boolean',
        ),
      );
    }
    const root = find(f);
    let list = byRoot.get(root);
    if (list === undefined) {
      list = [];
      byRoot.set(root, list);
    }
    for (const [triangle, tri] of tris.entries()) {
      const corners = tri.map((h) => point(mesh.hVert[h] as number));
      const plane = planeOf(corners[0] as Tuple3, corners[1] as Tuple3, corners[2] as Tuple3);
      if (plane === undefined) continue;
      list.push({ points: corners, plane, source: sources.length });
      sources.push({ operand, face: f, triangle });
    }
  }
  const components = [...byRoot.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, polys]) => polys)
    .filter((polys) => polys.length > 0);
  return ok({ mesh, components, originals: new Set(points.values()) });
}

type Operation = Exclude<BooleanOperation, 'split'>;

/** Target fragments against one tool: kept (final), or passed on to the next tool. */
const TARGET: Record<Operation, { keep: readonly PolyClass[]; pass: readonly PolyClass[] }> = {
  union: { keep: [], pass: [OUT, ON_SAME] },
  difference: { keep: [], pass: [OUT, ON_OPPOSITE] },
  intersection: { keep: [IN, ON_SAME], pass: [OUT, ON_OPPOSITE] },
};

/** Tool fragments against the target. */
const TOOL: Record<Operation, readonly PolyClass[]> = {
  union: [OUT],
  difference: [IN],
  intersection: [IN],
};

interface Counters {
  treeNodes: number;
  fragments: number;
}

interface Solid {
  readonly polys: readonly Poly[];
  readonly root: BspNode | null;
  readonly bounds: Bounds;
}

function solidOf(
  polys: readonly Poly[],
  eps: number,
  work: WorkMeter,
  counters: Counters,
): Solid | undefined {
  const tree = buildTree(polys, eps, work);
  if (tree === undefined) return undefined;
  counters.treeNodes += tree.nodes;
  return { polys, root: tree.root, bounds: boundsOf(polys) };
}

/**
 * Every fragment is classified against trees of the original operands only (never
 * against derived geometry, which would accumulate rounding): target fragments run
 * through the tool components in turn, and each tool component's fragments are
 * classified against the target and then against the other tool components, so
 * overlapping or touching tools behave as their union (a coplanar duplicate is kept
 * once, by the earlier component).
 */
function evaluate(
  a: Operand,
  b: Operand,
  operation: Operation,
  eps: number,
  work: WorkMeter,
  counters: Counters,
): Poly[] | undefined {
  const target = solidOf(a.components.flat(), eps, work, counters);
  if (target === undefined) return undefined;
  const tools: Solid[] = [];
  for (const component of b.components) {
    const solid = solidOf(component, eps, work, counters);
    if (solid === undefined) return undefined;
    tools.push(solid);
  }
  const out: Poly[] = [];
  let pending: readonly Poly[] = target.polys;
  const rule = TARGET[operation];
  for (const tool of tools) {
    const classified = classify(pending, tool.root, tool.bounds, eps, work);
    if (classified === undefined) return undefined;
    const next: Poly[] = [];
    for (const { poly, type } of classified) {
      if (rule.keep.includes(type)) out.push(poly);
      else if (rule.pass.includes(type)) next.push(poly);
    }
    pending = next;
  }
  if (operation !== 'intersection') pushAll(out, pending);
  for (const [i, tool] of tools.entries()) {
    let kept = classify(tool.polys, target.root, target.bounds, eps, work);
    if (kept === undefined) return undefined;
    let polys = kept.filter((k) => TOOL[operation].includes(k.type)).map((k) => k.poly);
    for (const [j, other] of tools.entries()) {
      if (j === i || polys.length === 0) continue;
      kept = classify(polys, other.root, other.bounds, eps, work);
      if (kept === undefined) return undefined;
      polys = kept
        .filter((k) => k.type === OUT || (k.type === ON_SAME && i < j))
        .map((k) => k.poly);
    }
    for (const poly of polys) out.push(operation === 'difference' ? flipPoly(poly) : poly);
  }
  counters.fragments = out.length;
  return out;
}

/**
 * Spatial hash weld with transitive merging: points within `eps` of each other join
 * one cluster (so chains of near-coincident split points cannot leave sub-tolerance
 * edges behind), located at the cluster's first point.
 */
class Welder {
  readonly positions: Tuple3[] = [];
  private readonly parent: number[] = [];
  private readonly cells = new Map<string, number[]>();
  private readonly ids = new Map<Tuple3, number>();
  merged = 0;
  private readonly eps: number;

  constructor(eps: number) {
    this.eps = eps;
  }

  private find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root] as number;
    while (this.parent[x] !== root) {
      const next = this.parent[x] as number;
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  add(p: Tuple3): void {
    if (this.ids.has(p)) return;
    const size = this.eps * 4;
    const ix = Math.floor(p[0] / size);
    const iy = Math.floor(p[1] / size);
    const iz = Math.floor(p[2] / size);
    const id = this.positions.length;
    this.positions.push(p);
    this.parent.push(id);
    this.ids.set(p, id);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const other of this.cells.get(`${ix + dx},${iy + dy},${iz + dz}`) ?? []) {
            const q = this.positions[other] as Tuple3;
            const d0 = q[0] - p[0];
            const d1 = q[1] - p[1];
            const d2 = q[2] - p[2];
            if (d0 * d0 + d1 * d1 + d2 * d2 > this.eps * this.eps) continue;
            const ra = this.find(other);
            const rb = this.find(id);
            if (ra === rb) continue;
            this.merged++;
            this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
          }
        }
      }
    }
    const key = `${ix},${iy},${iz}`;
    const cell = this.cells.get(key);
    if (cell === undefined) this.cells.set(key, [id]);
    else cell.push(id);
  }

  /** Dense vertex ids and positions of the clusters, in order of their first point. */
  resolve(): { id: (p: Tuple3) => number; positions: Tuple3[] } {
    const dense = new Map<number, number>();
    const positions: Tuple3[] = [];
    for (let i = 0; i < this.positions.length; i++) {
      const root = this.find(i);
      if (!dense.has(root)) {
        dense.set(root, positions.length);
        positions.push(this.positions[root] as Tuple3);
      }
    }
    return {
      id: (p) => dense.get(this.find(this.ids.get(p) as number)) as number,
      positions,
    };
  }
}

function loopArea(points: readonly Tuple3[]): number {
  const n = newell(points);
  return Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) / 2;
}

function midpoint(a: Tuple3, b: Tuple3): Tuple3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** Vertex loops with their source, without repeated or zero-area loops. */
function cleanLoops(
  input: readonly (readonly number[])[],
  sources: readonly number[],
  positions: readonly Tuple3[],
  rep: (v: number) => number,
  eps: number,
): { loops: { loop: number[]; source: number }[]; slivers: number } {
  let slivers = 0;
  const loops: { loop: number[]; source: number }[] = [];
  for (const [i, ids] of input.entries()) {
    const loop: number[] = [];
    for (const raw of ids) {
      const id = rep(raw);
      if (loop[loop.length - 1] !== id) loop.push(id);
    }
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    if (
      loop.length < 3 ||
      new Set(loop).size !== loop.length ||
      loopArea(loop.map((v) => positions[v] as Tuple3)) <= eps * eps
    ) {
      slivers++;
      continue;
    }
    loops.push({ loop, source: sources[i] as number });
  }
  return { loops, slivers };
}

function openEdges(loops: readonly { loop: readonly number[] }[]): [number, number][] {
  const directed = new Set<string>();
  for (const { loop } of loops) {
    for (let i = 0; i < loop.length; i++) directed.add(`${loop[i]},${loop[(i + 1) % loop.length]}`);
  }
  const open: [number, number][] = [];
  for (const { loop } of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      if (!directed.has(`${b},${a}`)) open.push([a, b]);
    }
  }
  return open;
}

/**
 * Close the welded soup: insert T-junction vertices; where the seam is still open,
 * merge seam vertices (ends of open edges) closer than 4 then 16 tolerances (split
 * points that landed just over the weld distance apart) and insert again.
 */
export function closeSoup(
  ids: readonly (readonly number[])[],
  sources: readonly number[],
  positions: readonly Tuple3[],
  eps: number,
): {
  loops: { loop: number[]; source: number }[];
  slivers: number;
  inserted: number;
  collapsed: number;
} {
  const parent = positions.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[x] !== root) {
      const next = parent[x] as number;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  let collapsed = 0;
  let result = { loops: [] as { loop: number[]; source: number }[], slivers: 0, inserted: 0 };
  for (const radius of [0, eps * 4, eps * 16]) {
    if (radius > 0) {
      const open = openEdges(result.loops);
      if (open.length === 0) break;
      // Any two seam vertices within the radius, not only the ends of one open edge: two
      // split points of one corner just over the weld distance apart leave a gap whose
      // open sides are all long (its short side, if any, has faces on both sides).
      const seam = [...new Set(open.flat())].sort(
        (x, y) => (positions[x] as Tuple3)[0] - (positions[y] as Tuple3)[0] || x - y,
      );
      for (let i = 0; i < seam.length; i++) {
        const a = seam[i] as number;
        const p = positions[a] as Tuple3;
        for (let j = i + 1; j < seam.length; j++) {
          const b = seam[j] as number;
          const q = positions[b] as Tuple3;
          const d0 = q[0] - p[0];
          if (d0 > radius) break;
          const d1 = q[1] - p[1];
          const d2 = q[2] - p[2];
          if (d0 * d0 + d1 * d1 + d2 * d2 > radius * radius) continue;
          const ra = find(a);
          const rb = find(b);
          if (ra === rb) continue;
          parent[Math.max(ra, rb)] = Math.min(ra, rb);
          collapsed++;
        }
      }
    }
    const cleaned = cleanLoops(ids, sources, positions, find, eps);
    const { loops, inserted } = segmentInsertions(
      cleaned.loops.map((l) => l.loop),
      positions,
      eps,
    );
    result = {
      loops: loops.map((loop, i) => ({
        loop,
        source: (cleaned.loops[i] as { source: number }).source,
      })),
      slivers: cleaned.slivers,
      inserted,
    };
    if (radius === 0 && openEdges(result.loops).length === 0) break;
  }
  return { ...result, collapsed };
}

interface Assembled {
  readonly bytes: Uint8Array;
  readonly provenance: FaceProvenance;
  readonly metrics: Record<string, number>;
  readonly locations: ComputeLocation[];
}

/**
 * Weld the kept fragments, drop slivers, insert T-junction vertices and build the
 * half-edge mesh; faces that would hang a third face on an edge are reported, not
 * added. Original input points weld first so untouched geometry keeps exact values.
 */
function assemble(
  polys: readonly Poly[],
  originals: ReadonlySet<Tuple3>,
  sources: readonly Source[],
  eps: number,
): Assembled {
  const welder = new Welder(eps);
  for (const poly of polys) for (const p of poly.points) if (originals.has(p)) welder.add(p);
  for (const poly of polys) for (const p of poly.points) welder.add(p);
  const welded = welder.resolve();
  const ids = polys.map((poly) => poly.points.map((p) => welded.id(p)));
  const sourcesOf = polys.map((poly) => poly.source);
  const repaired = closeSoup(ids, sourcesOf, welded.positions, eps);
  const { loops, slivers, inserted, collapsed } = repaired;
  const resolved = loops.map((l) => l.loop);
  const mesh = new EditMesh();
  for (const p of welded.positions) mesh.addVertex(p[0], p[1], p[2]);
  const faceSource: number[] = [];
  const locations: ComputeLocation[] = [];
  let nonManifold = 0;
  for (const [i, loop] of resolved.entries()) {
    const added = mesh.addFace(loop);
    if (!added.ok) {
      nonManifold++;
      if (locations.length < MAX_LOCATIONS) {
        const points = loop.map((v) => welded.positions[v] as Tuple3);
        locations.push({
          reason: 'non-manifold-edge',
          position: midpoint(points[0] as Tuple3, points[1] as Tuple3),
          detail: { cause: added.error.expected },
        });
      }
      continue;
    }
    faceSource[added.value] = (loops[i] as { source: number }).source;
  }
  const { mesh: compacted, faceMap } = mesh.compact();
  const count = compacted.faceHighWater;
  const provenance: FaceProvenance = {
    operand: new Uint8Array(count),
    face: new Int32Array(count),
    triangle: new Int32Array(count),
  };
  for (let f = 0; f < faceMap.length; f++) {
    const g = faceMap[f] as number;
    if (g === NONE) continue;
    const s = sources[faceSource[f] as number] as Source;
    provenance.operand[g] = s.operand;
    provenance.face[g] = s.face;
    provenance.triangle[g] = s.triangle;
  }
  let openEdges = 0;
  for (const e of compacted.edges()) {
    if (!compacted.isBoundaryEdge(e)) continue;
    openEdges++;
    if (locations.length < MAX_LOCATIONS) {
      const [a, b] = compacted.edgeVertices(e);
      locations.push({
        reason: 'open-edge',
        position: midpoint(compacted.position(a), compacted.position(b)),
      });
    }
  }
  return {
    bytes: encodeSnapshot(compacted),
    provenance,
    metrics: {
      faces: count,
      welded: welder.merged,
      slivers,
      collapsed,
      tJunctions: inserted,
      nonManifold,
      openEdges,
    },
    locations,
  };
}

function runBoolean(
  request: ComputeJobRequest<'boolean'>,
  work: WorkMeter,
): Result<BackendOutput<'boolean'>, ModelingError> {
  const params: BooleanJobParams = request.params;
  if (!Number.isFinite(params.tolerance) || params.tolerance <= 0) {
    return err(
      modelingError('model-invalid-argument', 'tolerance is a positive number', {
        tolerance: params.tolerance,
      }),
    );
  }
  if (request.inputs.length !== 2) {
    return err(
      modelingError('model-invalid-argument', 'a boolean job has two FXEM inputs', {
        inputs: request.inputs.length,
      }),
    );
  }
  const sources: Source[] = [];
  const operands: Operand[] = [];
  for (const [index, bytes] of request.inputs.entries()) {
    const decoded = decodeSnapshot(bytes);
    if (!decoded.ok) return decoded;
    const prepared = prepare(decoded.value, index, sources);
    if (!prepared.ok) return prepared;
    operands.push(prepared.value);
  }
  const [a, b] = operands as [Operand, Operand];
  const eps = params.tolerance;
  const originals = new Set([...a.originals, ...b.originals]);
  const operations: Exclude<BooleanOperation, 'split'>[] =
    params.operation === 'split' ? ['difference', 'intersection'] : [params.operation];
  const outputs: Uint8Array[] = [];
  const provenance: FaceProvenance[] = [];
  const locations: ComputeLocation[] = [];
  const metrics: Record<string, number> = {
    inputTriangles: sources.length,
    toolComponents: b.components.length,
  };
  for (const [i, operation] of operations.entries()) {
    // Coplanarity decisions within one tolerance band can leave a sliver seam open; the
    // same job at a finer and a coarser band usually closes it. The attempt order is
    // fixed, so the result stays deterministic.
    let out: Assembled | undefined;
    let counters: Counters = { treeNodes: 0, fragments: 0 };
    let attempts = 0;
    for (const scale of [1, 0.25, 4]) {
      attempts++;
      counters = { treeNodes: 0, fragments: 0 };
      const polys = evaluate(a, b, operation, eps * scale, work, counters);
      if (polys === undefined) return err(work.failure as ModelingError);
      out = assemble(polys, originals, sources, eps * scale);
      if (out.metrics.openEdges === 0 && out.metrics.nonManifold === 0) break;
    }
    if (out === undefined) return err(work.failure as ModelingError);
    out.metrics.attempts = attempts;
    outputs.push(out.bytes);
    provenance.push(out.provenance);
    for (const l of out.locations) {
      if (locations.length < MAX_LOCATIONS)
        locations.push({ ...l, detail: { ...l.detail, output: i } });
    }
    const prefix = operations.length === 1 ? '' : `${operation}.`;
    for (const [key, value] of Object.entries({ ...counters, ...out.metrics })) {
      metrics[`${prefix}${key}`] = value;
    }
  }
  const broken = Object.entries(metrics).some(
    ([key, value]) => (key.endsWith('openEdges') || key.endsWith('nonManifold')) && value > 0,
  );
  return ok({
    status: broken ? 'partial' : 'ok',
    outputs,
    provenance,
    metrics,
    locations,
  });
}

/** The required TypeScript baseline backend: BSP CSG, weld, T-junction repair. */
export const tsBackend: ComputeBackend = {
  name: 'ts',
  identity: TS_BACKEND_IDENTITY,
  supports: (kind: ComputeJobKind) => kind === 'boolean' || kind === 'region',
  quality: () => 'baseline',
  run<K extends ComputeJobKind>(
    request: ComputeJobRequest<K>,
    work: WorkMeter,
  ): Result<BackendOutput<K>, ModelingError> {
    const out =
      request.kind === 'region'
        ? runRegion(request as ComputeJobRequest<'region'>, work)
        : runBoolean(request as ComputeJobRequest<'boolean'>, work);
    return out as Result<BackendOutput<K>, ModelingError>;
  },
};
