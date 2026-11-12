import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll, replaceAll } from './arrays';
import { jobTriangles, tsBackend } from './compute/boolean-ts';
import {
  type BooleanOperation,
  type ComputeBackend,
  type ComputeJobReport,
  type ComputeLocation,
  type ComputePolicy,
  type FaceProvenance,
  runComputeJob,
} from './compute/job';
import { mergeFlags } from './crease';
import { bisectMesh } from './cut';
import { type ModelingError, modelingError } from './errors';
import { decodeSnapshot, encodeSnapshot } from './fxem';
import {
  dot,
  faceArea,
  faceCentroid,
  faceNormal,
  facesVolume,
  length,
  newell,
  normalize,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { EDGE_SHARP, EditMesh } from './mesh';
import type { Attribution, OpDiagnostic, RoleCounts } from './ops';
import { mergePlanar } from './planar';
import { orient2d } from './predicates';
import { collapseSlivers, loopWidth } from './repair';

export interface BooleanOptions {
  /**
   * Labels the faces this boolean creates: operand faces get role `cutB`, the split
   * piece `piece`. Target faces, cut or not, keep their own label and role.
   */
  readonly label?: string;
  /** Tag added to the faces the operand brings in (`cutB`, and the split `piece`). */
  readonly tag?: string;
  /** Material slot of the faces that come from the operand. */
  readonly material?: string;
  /** Offset applied to the operand (Model or FXEM operands). */
  readonly translate?: Tuple3;
  /** Backend policy for this call; defaults to the session's `compute`. */
  readonly compute?: ComputePolicy;
  /**
   * What a `partial` result does: fail the operation (default) or keep it with a warning.
   * `'accept'` keeps only a closed manifold within the volume bounds whose faces do not all
   * map to a source face; an open, non-manifold or out-of-bounds result always fails.
   */
  readonly onPartial?: 'error' | 'accept';
  /** Work units for this job; defaults to the session's `budget.work`. */
  readonly budget?: number;
  /**
   * Widest sliver to collapse (meters): a result face narrower than this and than a
   * tenth of its source face is a remainder the cut left beside a feature of the other
   * operand. Defaults to 1/1000 of the operands' bounding diagonal; 0 keeps every
   * remainder except degenerate ones (a few tolerances wide).
   */
  readonly slivers?: number;
}

export interface BooleanContext {
  readonly tolerance: number;
  readonly policy: ComputePolicy;
  readonly native?: ComputeBackend;
  readonly signal?: { readonly aborted: boolean };
  readonly budget?: number;
}

/** Copy faces with their attributes, corner values and edge intent into a new mesh. */
export function extractFaces(mesh: EditMesh, faces: readonly number[]): EditMesh {
  const out = new EditMesh();
  pushAll(out.tagNames, mesh.tagNames);
  replaceAll(out.labelNames, mesh.labelNames);
  replaceAll(out.roleNames, mesh.roleNames);
  replaceAll(out.materialNames, mesh.materialNames);
  out.reserveTagWords(mesh.tagWords);
  const vertexOf = new Map<number, number>();
  for (const f of faces) {
    const loop = mesh.faceVertices(f).map((v) => {
      let mapped = vertexOf.get(v);
      if (mapped === undefined) {
        mapped = out.addVertex(...mesh.position(v));
        vertexOf.set(v, mapped);
      }
      return mapped;
    });
    const added = out.addFace(loop);
    if (!added.ok) continue;
    const g = added.value;
    mesh.copyFaceAttributesTo(f, out, g);
    const from = mesh.faceHalves(f);
    const to = out.faceHalves(g);
    for (const [i, h] of from.entries()) {
      for (const name of mesh.channels.keys()) {
        const value = mesh.corner(name, h);
        if (value !== undefined) out.setCorner(name, to[i] as number, value);
      }
      const flags = mesh.eFlags[h >> 1] as number;
      if (flags !== 0) out.eFlags[(to[i] as number) >> 1] = flags;
    }
  }
  return out;
}

function closedCheck(mesh: EditMesh, which: string): Result<void, ModelingError> {
  if (mesh.faceCount === 0) {
    return err(modelingError('model-precondition', `the ${which} has faces`, { operand: which }));
  }
  for (const e of mesh.edges()) {
    if (!mesh.isBoundaryEdge(e)) continue;
    const [a, b] = mesh.edgeVertices(e);
    return err(
      modelingError(
        'model-precondition',
        `the ${which} is a closed manifold (every edge has two faces)`,
        { operand: which, openEdge: [mesh.position(a), mesh.position(b)] },
        'close the openings first with m.fillHoles(sel.edges.meshBoundary()), then rerun the boolean',
      ),
    );
  }
  if (facesVolume(mesh, mesh.faces()) <= 0) {
    return err(
      modelingError(
        'model-precondition',
        `the ${which} encloses a positive volume (outward-facing)`,
        { operand: which, volume: facesVolume(mesh, mesh.faces()) },
        'flip inside-out components with m.orient(sel.all())',
      ),
    );
  }
  return ok(undefined);
}

function barycentric(p: Tuple3, a: Tuple3, b: Tuple3, c: Tuple3): Tuple3 {
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(p, a);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const denom = d00 * d11 - d01 * d01;
  if (denom === 0) return [1, 0, 0];
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  return [1 - v - w, v, w];
}

function onSegment(p: Tuple3, a: Tuple3, b: Tuple3, eps: number): boolean {
  const d = sub(b, a);
  const len2 = dot(d, d);
  if (len2 === 0) return false;
  const t = dot(sub(p, a), d) / len2;
  if (t < -1e-9 || t > 1 + 1e-9) return false;
  const off = sub(sub(p, a), [d[0] * t, d[1] * t, d[2] * t]);
  return dot(off, off) <= eps * eps;
}

/** Is the point inside (or within eps of) the face polygon, in its Newell plane? */
function insideFace(mesh: EditMesh, f: number, p: Tuple3, eps: number): boolean {
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  const n = newell(points);
  const drop =
    Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2])
      ? 0
      : Math.abs(n[1]) >= Math.abs(n[2])
        ? 1
        : 2;
  const u = (drop + 1) % 3;
  const w = (drop + 2) % 3;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j] as Tuple3;
    const b = points[i] as Tuple3;
    if (onSegment(p, a, b, eps)) return true;
    const ya = a[w] as number;
    const yb = b[w] as number;
    const py = p[w] as number;
    if (ya > py !== yb > py) {
      const turn = orient2d(a[u] as number, ya, b[u] as number, yb, p[u] as number, py);
      if (turn > 0 === yb > ya) inside = !inside;
    }
  }
  return inside;
}

/** A face narrower than this share of its source face's width is a sliver remainder of it. */
const SLIVER_SHARE = 0.1;
/** Default widest sliver, as a share of the operands' bounding diagonal. */
const SLIVER_SIZE = 1e-3;

function diagonal(meshes: readonly EditMesh[]): number {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    for (const v of m.vertices()) {
      const p = m.position(v);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, p[k] as number);
        max[k] = Math.max(max[k] as number, p[k] as number);
      }
    }
  }
  return length(sub(max, min));
}

/** Cut edges whose faces meet flatter than about 0.8 degrees are not creases. */
const CREASE_COS = 0.9999;

interface SourceKey {
  readonly operand: number;
  readonly face: number;
}

interface Written {
  readonly faces: number[];
  readonly source: Map<number, SourceKey>;
}

/**
 * Add one job output to `target`: faces take their source face's attributes (names
 * merged), corner values by barycentric mapping in the source triangle, intent
 * flags of the source edges they lie on, and the cut curve (edges between faces of
 * different operands) becomes sharp.
 */
function writeOutput(
  target: EditMesh,
  output: EditMesh,
  provenance: FaceProvenance,
  inputs: readonly EditMesh[],
  triangles: readonly (number[][] | undefined)[][],
  tolerance: number,
  relabeled: boolean,
): Written {
  // Names merge in the inputs' own table order, so the session tables do not depend on
  // the (position-sorted) output face order.
  for (const [operand, mesh] of inputs.entries()) {
    for (const name of mesh.materialNames) target.nameIndex(target.materialNames, name);
    for (const name of mesh.tagNames) target.tagIndex(name, true);
    if (operand === 1 && relabeled) continue;
    for (const name of mesh.labelNames.slice(1)) target.nameIndex(target.labelNames, name);
    for (const name of mesh.roleNames.slice(1)) target.nameIndex(target.roleNames, name);
  }
  const vertexOf = new Map<number, number>();
  for (const v of output.vertices()) vertexOf.set(v, target.addVertex(...output.position(v)));
  const faces: number[] = [];
  const source = new Map<number, SourceKey>();
  for (const r of output.faces()) {
    const operand = provenance.operand[r] as number;
    const sf = provenance.face[r] as number;
    const mesh = inputs[operand] as EditMesh;
    const added = target.addFace(output.faceVertices(r).map((v) => vertexOf.get(v) as number));
    if (!added.ok) continue;
    const g = added.value;
    faces.push(g);
    source.set(g, { operand, face: sf });
    target.fMaterial[g] = target.nameIndex(
      target.materialNames,
      mesh.materialNames[mesh.fMaterial[sf] as number] ?? 'Default',
    );
    const label = mesh.fLabel[sf] as number;
    if (label !== 0 && !(operand === 1 && relabeled)) {
      target.fLabel[g] = target.nameIndex(target.labelNames, mesh.labelNames[label] as string);
      target.fRole[g] = target.nameIndex(
        target.roleNames,
        mesh.roleNames[mesh.fRole[sf] as number] as string,
      );
    }
    target.fFlags[g] = mesh.fFlags[sf] as number;
    for (const [t, name] of mesh.tagNames.entries()) {
      if (mesh.hasTag(sf, t)) target.addTag(g, target.tagIndex(name, true));
    }
    const tri = (triangles[operand] as (number[][] | undefined)[])[sf]?.[
      provenance.triangle[r] as number
    ] as number[];
    const corners = tri.map((h) => mesh.position(mesh.hVert[h] as number));
    const halves = target.faceHalves(g);
    const flagged = mesh
      .faceHalves(sf)
      .filter((h) => (mesh.eFlags[h >> 1] as number) !== 0)
      .map((h) => ({
        a: mesh.position(mesh.hVert[h] as number),
        b: mesh.position(mesh.hVert[mesh.hNext[h] as number] as number),
        flags: mesh.eFlags[h >> 1] as number,
      }));
    for (const h of halves) {
      const p = target.position(target.hVert[h] as number);
      const q = target.position(target.hVert[target.hNext[h] as number] as number);
      const weights = barycentric(
        p,
        corners[0] as Tuple3,
        corners[1] as Tuple3,
        corners[2] as Tuple3,
      );
      for (const name of mesh.channels.keys()) {
        const values = tri.map((k) => mesh.corner(name, k));
        if (values.some((v) => v === undefined)) continue;
        const dim = (values[0] as Float32Array).length;
        const value = new Float32Array(dim);
        for (let i = 0; i < dim; i++) {
          value[i] = values.reduce(
            (sum, v, k) => sum + ((v as Float32Array)[i] as number) * (weights[k] as number),
            0,
          );
        }
        target.setCorner(name, h, value);
      }
      for (const edge of flagged) {
        if (onSegment(p, edge.a, edge.b, tolerance) && onSegment(q, edge.a, edge.b, tolerance)) {
          target.eFlags[h >> 1] = mergeFlags(target.eFlags[h >> 1] as number, edge.flags);
        }
      }
    }
  }
  markCutCurve(target, faces, source);
  return { faces, source };
}

/** The cut curve is a crease, except where the operands continue each other in one plane. */
function markCutCurve(
  target: EditMesh,
  faces: readonly number[],
  source: ReadonlyMap<number, SourceKey>,
): void {
  for (const g of faces) {
    for (const h of target.faceHalves(g)) {
      const twin = target.hFace[h ^ 1] as number;
      const other = source.get(twin);
      if (other === undefined || other.operand === (source.get(g) as SourceKey).operand) continue;
      if (dot(faceNormal(target, g), faceNormal(target, twin)) > CREASE_COS) continue;
      target.eFlags[h >> 1] = mergeFlags(target.eFlags[h >> 1] as number, EDGE_SHARP);
    }
  }
}

/**
 * Boundary loops (half lists) of a face region, or undefined when its boundary is not a
 * closed chain. Each half continues through the region's own fan at its end vertex, and a loop
 * that visits a vertex twice (a hole touching the outline, or two holes touching) splits there
 * into simple loops, so a pinched region still yields its outline and holes separately.
 */
function regionLoops(mesh: EditMesh, faces: ReadonlySet<number>): number[][] | undefined {
  const boundary: number[] = [];
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      if (!faces.has(mesh.hFace[h ^ 1] as number)) boundary.push(h);
    }
  }
  boundary.sort((a, b) => a - b);
  const isBoundary = new Set(boundary);
  const seen = new Set<number>();
  const loops: number[][] = [];
  for (const first of boundary) {
    if (seen.has(first)) continue;
    const path: number[] = [];
    const at = new Map<number, number>();
    let h = first;
    while (!seen.has(h)) {
      seen.add(h);
      const v = mesh.hVert[h] as number;
      const earlier = at.get(v);
      if (earlier !== undefined) {
        const loop = path.splice(earlier);
        for (const g of loop) at.delete(mesh.hVert[g] as number);
        loops.push(loop);
      }
      at.set(v, path.length);
      path.push(h);
      let g = mesh.hNext[h] as number;
      for (let guard = 0; !isBoundary.has(g); guard++) {
        if (guard > boundary.length + faces.size * 8) return undefined;
        g = mesh.hNext[g ^ 1] as number;
      }
      h = g;
    }
    if (h !== first) return undefined;
    loops.push(path);
  }
  return loops;
}

/** In-plane axes of a face normal, preferring world axes so cuts follow the part's grid. */
function planeAxes(n: Tuple3): [Tuple3, Tuple3] {
  const axes: Tuple3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const ranked = axes
    .map((a, i) => ({ a, i, d: Math.abs(dot(a, n)) }))
    .sort((x, y) => x.d - y.d || x.i - y.i);
  const project = (a: Tuple3) =>
    normalize(sub(a, [n[0] * dot(a, n), n[1] * dot(a, n), n[2] * dot(a, n)]));
  const e1 = project((ranked[0] as { a: Tuple3 }).a);
  const e2 = normalize([
    n[1] * e1[2] - n[2] * e1[1],
    n[2] * e1[0] - n[0] * e1[2],
    n[0] * e1[1] - n[1] * e1[0],
  ]);
  return [e1, e2];
}

/**
 * n-gons hold no holes, and growing one face around a hole leaves slivers. So a
 * source face whose surviving region has holes is first cut by straight lines (planes
 * across the face) through its holes along the region's long axis; each strip then
 * merges on its own. Returns the merge key of every face of the piece.
 */
function cutHoles(
  mesh: EditMesh,
  faces: readonly number[],
  key: ReadonlyMap<number, SourceKey>,
  sources: readonly EditMesh[],
  tolerance: number,
): Result<Map<number, string>, ModelingError> {
  const keys = new Map<number, string>();
  for (const f of faces) {
    const s = key.get(f) as SourceKey;
    keys.set(f, `${s.operand}:${s.face}`);
  }
  const names = [...new Set(keys.values())].sort();
  for (const k of names) {
    // Face ids move with every cut, so membership is re-read from the live key map.
    let group = new Set([...keys].filter(([, v]) => v === k).map(([f]) => f));
    const loops = regionLoops(mesh, group);
    if (loops === undefined || loops.length < 2) continue;
    const [operand, face] = k.split(':').map(Number) as [number, number];
    const src = sources[operand] as EditMesh;
    const n = normalize(newell(src.faceVertices(face).map((v) => src.position(v))));
    const [e1, e2] = planeAxes(n);
    const span = (axis: Tuple3, halves: readonly number[]) => {
      const values = halves.map((h) => dot(mesh.position(mesh.hVert[h] as number), axis));
      return [minOf(values), maxOf(values)] as const;
    };
    const all = loops.flat();
    const [a1, b1] = span(e1, all);
    const [a2, b2] = span(e2, all);
    const across = b1 - a1 >= b2 - a2 ? e2 : e1;
    const holes = loops
      .filter((loop) => dot(newell(loop.map((h) => mesh.position(mesh.hVert[h] as number))), n) < 0)
      .map((loop) => span(across, loop))
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const cuts: number[] = [];
    for (const [lo, hi] of holes) {
      if (cuts.some((c) => c > lo + tolerance && c < hi - tolerance)) continue;
      cuts.push((lo + hi) / 2);
    }
    for (const offset of cuts) {
      const point: Tuple3 = [across[0] * offset, across[1] * offset, across[2] * offset];
      const done = bisectMesh(mesh, { point, normal: across }, tolerance, group);
      if (!done.ok) return done;
      const moved = done.value.rewritten.map(({ face: f, faces: created }) => ({
        from: keys.get(f) as string,
        inGroup: group.has(f),
        created,
        face: f,
      }));
      const nextGroup = new Set(group);
      for (const m of moved) {
        keys.delete(m.face);
        nextGroup.delete(m.face);
      }
      for (const { from, inGroup, created } of moved) {
        for (const g of created) {
          keys.set(g, from);
          if (inGroup) nextGroup.add(g);
        }
      }
      group = nextGroup;
    }
    for (const f of group) {
      const c = faceCentroid(mesh, f);
      const signature = cuts.map((offset) => (dot(c, across) > offset ? '+' : '-')).join('');
      keys.set(f, `${k}:${signature}`);
    }
  }
  return ok(keys);
}

/** A point inside the face: the centroid of its largest export triangle (a vertex mean can fall outside a concave face). */
function interiorPoint(mesh: EditMesh, f: number): Tuple3 {
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  const indices = triangulateLoop(points);
  if (indices === undefined) return faceCentroid(mesh, f);
  let best: Tuple3 = faceCentroid(mesh, f);
  let area = -1;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => points[indices[i + k] as number] as Tuple3) as [
      Tuple3,
      Tuple3,
      Tuple3,
    ];
    const n = newell([a, b, c]);
    const size = dot(n, n);
    if (size > area) {
      area = size;
      best = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    }
  }
  return best;
}

function locationOf(mesh: EditMesh, f: number, reason: ComputeLocation['reason']): ComputeLocation {
  return { reason, position: faceCentroid(mesh, f), detail: { face: f } };
}

/**
 * The boolean operator front end (design 8.1): check the closed-manifold
 * precondition, hand canonical FXEM to the compute job, map provenance back to
 * source faces, tags and corner values, regroup coplanar same-source triangles with
 * cleanup.planar, verify every face against its source and the volume bounds, and
 * commit only an `ok` (or accepted `partial`) result.
 */
export function booleanOp(
  mesh: EditMesh,
  operation: BooleanOperation,
  operand: { readonly mesh: EditMesh } | { readonly faces: readonly number[] },
  options: BooleanOptions,
  attribution: Attribution,
  context: BooleanContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  let a: EditMesh;
  let b: EditMesh;
  if ('faces' in operand) {
    const tool = new Set(operand.faces);
    a = extractFaces(
      mesh,
      mesh.faces().filter((f) => !tool.has(f)),
    );
    b = extractFaces(mesh, operand.faces);
  } else {
    a = mesh;
    b = operand.mesh;
    const t = options.translate;
    if (t !== undefined) {
      if (!t.every((c) => Number.isFinite(c))) {
        return err(
          modelingError('model-invalid-argument', 'translate is three finite numbers', {
            translate: t,
          }),
        );
      }
      b = b.clone();
      for (const v of b.vertices()) {
        const p = b.position(v);
        b.setPosition(v, p[0] + t[0], p[1] + t[1], p[2] + t[2]);
      }
    }
  }
  if (
    options.slivers !== undefined &&
    !(Number.isFinite(options.slivers) && options.slivers >= 0)
  ) {
    return err(
      modelingError('model-invalid-argument', 'slivers is a finite width >= 0', {
        slivers: options.slivers,
      }),
    );
  }
  for (const [which, m] of [
    ['target', a],
    ['operand', b],
  ] as const) {
    const checked = closedCheck(m, which);
    if (!checked.ok) return checked;
  }
  const inputs = [encodeSnapshot(a), encodeSnapshot(b)];
  const decoded = inputs.map((bytes) => decodeSnapshot(bytes));
  const sources: EditMesh[] = [];
  for (const d of decoded) {
    if (!d.ok) return d;
    sources.push(d.value);
  }
  const job = runComputeJob(
    { kind: 'boolean', inputs, params: { operation, tolerance: context.tolerance } },
    tsBackend,
    {
      policy: options.compute ?? context.policy,
      ...(context.native === undefined ? {} : { native: context.native }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...((options.budget ?? context.budget) === undefined
        ? {}
        : { budget: (options.budget ?? context.budget) as number }),
    },
  );
  if (!job.ok) return job;
  const result = job.value;
  const triangles = sources.map((s) => jobTriangles(s));
  const next = mesh.clone();
  for (const f of next.faces()) next.removeFace(f);
  for (const v of next.vertices()) next.removeVertex(v);
  const locations: ComputeLocation[] = [...result.locations];
  const pieces: { faces: number[]; source: Map<number, SourceKey> }[] = [];
  let mergedGroups = 0;
  let removedVertices = 0;
  let collapsedSlivers = 0;
  const sliverWidth = options.slivers ?? SLIVER_SIZE * diagonal(sources);
  for (const [i, bytes] of result.outputs.entries()) {
    const output = decodeSnapshot(bytes);
    if (!output.ok) return output;
    const written = writeOutput(
      next,
      output.value,
      result.provenance[i] as FaceProvenance,
      sources,
      triangles,
      context.tolerance,
      attribution.label !== 0,
    );
    const cut = cutHoles(next, written.faces, written.source, sources, context.tolerance);
    if (!cut.ok) return cut;
    let keys = cut.value;
    let current = [...keys.keys()].sort((x, y) => x - y);
    for (let pass = 0; pass < 4; pass++) {
      const k = keys;
      const merged = mergePlanar(next, current, (f) => k.get(f) as string, context.tolerance * 10);
      if (!merged.ok) return merged;
      mergedGroups += merged.value.merged;
      removedVertices += merged.value.removedVertices;
      const rekeyed = new Map<number, string>();
      for (const [f, from] of merged.value.origin) rekeyed.set(f, k.get(from) as string);
      keys = rekeyed;
      current = merged.value.faces;
      if (merged.value.merged === 0) break;
    }
    const keyed = keys;
    const sliverLimit = (f: number): number => {
      const [operand, face] = (keyed.get(f) as string).split(':').map(Number) as [number, number];
      const src = sources[operand] as EditMesh;
      const across = loopWidth(src.faceVertices(face).map((v) => src.position(v)));
      return Math.max(4 * context.tolerance, Math.min(sliverWidth, SLIVER_SHARE * across));
    };
    const slivers = collapseSlivers(next, current, sliverLimit, context.tolerance);
    if (!slivers.ok) return slivers;
    collapsedSlivers += slivers.value.collapsed;
    const rekeyed = new Map<number, string>();
    for (const [f, from] of slivers.value.origin) rekeyed.set(f, keyed.get(from) as string);
    keys = rekeyed;
    current = slivers.value.faces;
    const source = new Map<number, SourceKey>();
    for (const [f, key] of keys) {
      const [operand, face] = key.split(':').map(Number) as [number, number];
      source.set(f, { operand, face });
    }
    if (slivers.value.collapsed > 0) markCutCurve(next, current, source);
    pieces.push({ faces: current, source });
  }
  let mapped = 0;
  let total = 0;
  const cutSources = new Set<string>();
  const survivors = new Set<string>();
  const roles: RoleCounts = { cutB: 0 };
  const cutB = attribution.label === 0 ? 0 : next.nameIndex(next.roleNames, 'cutB');
  const piece = attribution.label === 0 ? 0 : next.nameIndex(next.roleNames, 'piece');
  const operandMaterial =
    options.material === undefined
      ? undefined
      : next.nameIndex(next.materialNames, options.material);
  for (const [index, { faces, source }] of pieces.entries()) {
    const isPiece = operation === 'split' && index === 1;
    for (const f of faces) {
      const s = source.get(f) as SourceKey;
      const src = sources[s.operand] as EditMesh;
      total++;
      const n = normalize(newell(src.faceVertices(s.face).map((v) => src.position(v))));
      const origin = src.position(src.faceVertices(s.face)[0] as number);
      const onPlane = next
        .faceVertices(f)
        .every((v) => Math.abs(dot(sub(next.position(v), origin), n)) <= context.tolerance * 10);
      if (onPlane && insideFace(src, s.face, interiorPoint(next, f), context.tolerance * 10))
        mapped++;
      else if (locations.length < 32) locations.push(locationOf(next, f, 'unmapped-face'));
      const onCut = next.faceHalves(f).some((h) => {
        const other = source.get(next.hFace[h ^ 1] as number);
        return other !== undefined && other.operand !== s.operand;
      });
      // A split's pieces are a difference and an intersection, each bounded on its own.
      survivors.add(`${index}:${s.operand}:${s.face}`);
      if (onCut) cutSources.add(`${index}:${s.operand}:${s.face}`);
      // Like loopCut and bisect, a cut keeps the target's attribution: only the faces
      // this boolean brings in (operand faces, and the whole split piece) take its label.
      const role = isPiece ? 'piece' : s.operand === 1 ? 'cutB' : undefined;
      if (s.operand === 1 && operandMaterial !== undefined) next.fMaterial[f] = operandMaterial;
      if (role === undefined) continue;
      roles[role] = (roles[role] ?? 0) + 1;
      if (attribution.label !== 0) {
        next.fLabel[f] = attribution.label;
        next.fRole[f] = role === 'piece' ? piece : cutB;
      }
      if (attribution.tag >= 0) next.addTag(f, attribution.tag);
    }
  }
  const volumeA = facesVolume(sources[0] as EditMesh, (sources[0] as EditMesh).faces());
  const volumeB = facesVolume(sources[1] as EditMesh, (sources[1] as EditMesh).faces());
  const area = (m: EditMesh) => m.faces().reduce((s, f) => s + faceArea(m, f), 0);
  // Welding moves a vertex by at most the tolerance, so the volume moves by at most
  // tolerance x surface area.
  const slack = context.tolerance * (area(sources[0] as EditMesh) + area(sources[1] as EditMesh));
  const volumes = pieces.map((p) => facesVolume(next, p.faces));
  const resultVolume = volumes[0] as number;
  const outside = (v: number, lo: number, hi: number) => v < lo - slack || v > hi + slack;
  const center = (): Tuple3 => {
    const min: Tuple3 = [Infinity, Infinity, Infinity];
    const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
    for (const v of next.vertices()) {
      const p = next.position(v);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, p[k] as number);
        max[k] = Math.max(max[k] as number, p[k] as number);
      }
    }
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  };
  const volumeIssue = (detail: Record<string, unknown>) =>
    locations.push({ reason: 'volume', position: center(), detail });
  const noEffect = (expected: string) =>
    err(
      modelingError(
        'model-op-no-effect',
        expected,
        { volume: { target: volumeA, operand: volumeB } },
        'move or resize the operand so it overlaps the target',
      ),
    );
  if ((operation === 'difference' || operation === 'split') && pieces[0]?.faces.length === 0) {
    return err(
      modelingError(
        'model-degenerate',
        `the ${operation} leaves part of the target outside the operand`,
        { volume: { target: volumeA, operand: volumeB } },
        'the operand covers the whole target; shrink or move it, or delete the target instead',
      ),
    );
  }
  switch (operation) {
    case 'difference':
      if (roles.cutB === 0) return noEffect('the operand removes material from the target');
      if (outside(resultVolume, volumeA - volumeB, volumeA))
        volumeIssue({ resultVolume, volumeA, volumeB });
      break;
    case 'union':
      if (outside(resultVolume, Math.max(volumeA, volumeB), volumeA + volumeB))
        volumeIssue({ resultVolume, volumeA, volumeB });
      break;
    case 'intersection':
      if (pieces[0]?.faces.length === 0) return noEffect('the operands overlap');
      if (outside(resultVolume, 0, Math.min(volumeA, volumeB)))
        volumeIssue({ resultVolume, volumeA, volumeB });
      break;
    case 'split': {
      if ((pieces[1]?.faces.length ?? 0) === 0) return noEffect('the operand overlaps the target');
      const sum = (volumes[0] as number) + (volumes[1] as number);
      if (outside(sum, volumeA, volumeA)) volumeIssue({ volumes, volumeA });
      break;
    }
  }
  for (const e of next.edges()) {
    if (!next.isBoundaryEdge(e) || locations.some((l) => l.reason === 'open-edge')) continue;
    const [p, q] = next.edgeVertices(e);
    const pa = next.position(p);
    const pb = next.position(q);
    locations.push({
      reason: 'open-edge',
      position: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2],
    });
  }
  const resultFaces = pieces.reduce((n, p) => n + p.faces.length, 0);
  // Operand faces the result discards entirely do not count toward the n-gon bound.
  const inputFaces = survivors.size;
  const report: ComputeJobReport = result.report;
  const status = result.status === 'partial' || locations.length > 0 ? 'partial' : 'ok';
  const summary = {
    operation,
    status,
    backend: report.backend,
    backendIdentity: report.backendIdentity,
    quality: report.quality,
    cacheKey: report.cacheKey,
    metrics: {
      ...report.metrics,
      inputFaces,
      cutFaces: cutSources.size,
      resultFaces,
      mergedGroups,
      removedVertices,
      slivers: collapsedSlivers,
      provenanceMapped: mapped,
      provenanceFaces: total,
    },
  };
  if (status === 'partial') {
    const detail = { ...summary, locations: locations.slice(0, 32) };
    // 'accept' keeps only a valid solid whose faces lost their source; an open, non-manifold
    // or out-of-bounds result is never committed as ok.
    const broken =
      locations.length === 0 ||
      locations.some((l) => l.reason !== 'unmapped-face') ||
      next.edges().some((e) => next.isBoundaryEdge(e));
    if ((options.onPartial ?? 'error') === 'error' || broken) {
      return err(
        modelingError(
          'model-partial',
          broken
            ? `the ${operation} result is a closed manifold within the operands' volume bounds`
            : `the ${operation} result is a closed manifold whose faces all map to their sources`,
          detail,
          broken
            ? "inspect detail.locations; the result is open, non-manifold or outside the volume bounds, which onPartial: 'accept' does not keep; adjust the operands (coplanar or touching geometry is the usual cause)"
            : "inspect detail.locations; adjust the operands (coplanar or touching geometry is the usual cause), or pass onPartial: 'accept' to keep the partial result",
        ),
      );
    }
    diagnostics.push({
      severity: 'warn',
      message: `the ${operation} result is partial: ${locations.length} location(s) need attention`,
      detail,
    });
  }
  const unset = [...next.channels.keys()].filter((name) =>
    pieces.some((p) =>
      p.faces.some((f) => next.faceHalves(f).some((h) => next.corner(name, h) === undefined)),
    ),
  );
  if (unset.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `faces without a source value have no ${unset.join(', ')} values; re-project before export`,
      detail: { channels: unset },
    });
  }
  diagnostics.push({
    severity: 'info',
    message: `${operation} ran on the ${report.backend} backend (${report.quality})`,
    detail: summary,
  });
  mesh.assign(next);
  return ok(roles);
}
