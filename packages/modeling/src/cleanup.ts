import { err, ok, type Result } from '@forgeax/engine-types';
import { minOf } from './arrays';
import { fillBoundaryLoops, nonplanarCaps } from './connect';
import { type ModelingError, modelingError } from './errors';
import { dot, faceNormal, facesVolume, sub, type Tuple3, triangulateLoop } from './geom';
import { EDGE_SHARP, type EditMesh, NONE } from './mesh';
import {
  type Attribution,
  flipFaces,
  type OpDiagnostic,
  type RepairSink,
  type RoleCounts,
  regionGroups,
  repairBase,
} from './ops';
import { type CornerSource, type FaceRewrite, faceCorners, rewriteFaces } from './rewrite';

class Groups {
  private readonly parent = new Map<number, number>();
  find(x: number): number {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) {
      root = this.parent.get(root) as number;
    }
    this.parent.set(x, root);
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
}

function removeOrphans(mesh: EditMesh, candidates: Iterable<number>): void {
  const used = new Set<number>();
  for (const f of mesh.faces()) for (const v of mesh.faceVertices(f)) used.add(v);
  for (const v of candidates) if (!used.has(v)) mesh.removeVertex(v);
}

function nonplanar(mesh: EditMesh, f: number, tolerance: number): boolean {
  const n = faceNormal(mesh, f);
  const loop = mesh.faceVertices(f);
  const p0 = mesh.position(loop[0] as number);
  return loop.some((v) => Math.abs(dot(sub(mesh.position(v), p0), n)) > tolerance * 10);
}

/**
 * Remove the selected interior edges, merging the faces on both sides into one
 * n-gon per connected group. The merged face keeps the attributes of its lowest
 * face, the union of the group's tags and the boundary corner values; vertices
 * left without faces are removed. A merge that would leave a hole or a pinched
 * boundary is `model-precondition`; different material slots are ambiguous.
 */
export function dissolve(
  mesh: EditMesh,
  edges: readonly number[],
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const groups = new Groups();
  let removed = 0;
  for (const e of edges) {
    const a = mesh.hFace[e * 2] as number;
    const b = mesh.hFace[e * 2 + 1] as number;
    if (a === NONE || b === NONE || a === b) continue;
    groups.union(a, b);
    removed++;
  }
  if (removed === 0) {
    return err(
      modelingError('model-op-no-effect', 'the selection has an interior edge between two faces', {
        edges: edges.length,
      }),
    );
  }
  const members = new Map<number, number[]>();
  for (const e of edges) {
    for (const h of [e * 2, e * 2 + 1]) {
      const f = mesh.hFace[h] as number;
      if (f === NONE) continue;
      const root = groups.find(f);
      const list = members.get(root) ?? [];
      if (!list.includes(f)) list.push(f);
      members.set(root, list);
    }
  }
  const rewrites: FaceRewrite[] = [];
  const merged: { tags: Uint32Array }[] = [];
  const vertices = new Set<number>();
  const selected = new Set(edges);
  const swept = new Set<number>();
  for (const [root, faces] of [...members].sort((x, y) => x[0] - y[0])) {
    if (faces.length < 2) continue;
    const inside = new Set(faces);
    const slots = new Set(faces.map((f) => mesh.fMaterial[f] as number));
    if (slots.size > 1) {
      return err(
        modelingError(
          'model-invalid-argument',
          'the dissolved faces share one material slot',
          { slots: [...slots].map((m) => mesh.materialNames[m]) },
          'assign one slot to the faces first, or dissolve each material region separately',
        ),
      );
    }
    const startOf = new Map<number, number>();
    for (const f of faces) {
      for (const h of mesh.faceHalves(f)) {
        vertices.add(mesh.hVert[h] as number);
        if (inside.has(mesh.hFace[h ^ 1] as number)) {
          if (!selected.has(h >> 1)) swept.add(h >> 1);
          continue;
        }
        const v = mesh.hVert[h] as number;
        if (startOf.has(v)) {
          return err(
            modelingError('model-precondition', 'the merged boundary visits each vertex once', {
              vertex: v,
            }),
          );
        }
        startOf.set(v, h);
      }
    }
    const first = minOf(startOf.values());
    const loop: CornerSource[] = [];
    let h = first;
    do {
      loop.push({ v: mesh.hVert[h] as number, corner: h });
      h = startOf.get(mesh.hVert[mesh.hNext[h] as number] as number) as number;
    } while (h !== first && loop.length <= startOf.size);
    if (loop.length !== startOf.size) {
      return err(
        modelingError(
          'model-precondition',
          'the merged region has one boundary loop (n-gons cannot hold holes)',
          { faces: faces.length },
          'leave at least one edge of the ring undissolved',
        ),
      );
    }
    const tags = new Uint32Array(mesh.tagWords);
    for (const f of faces) {
      for (let w = 0; w < mesh.tagWords; w++) {
        tags[w] = (tags[w] as number) | (mesh.fTags[f * mesh.tagWords + w] as number);
      }
    }
    merged.push({ tags });
    rewrites.push({ face: root, loops: [loop] });
    for (const f of faces) if (f !== root) rewrites.push({ face: f, loops: [] });
  }
  const sweptSharp = [...swept].filter((e) => ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0);
  const done = rewriteFaces(mesh, rewrites);
  if (!done.ok) return done;
  const created = done.value.filter((faces) => faces.length > 0).map((faces) => faces[0] as number);
  let bent = 0;
  for (const [i, f] of created.entries()) {
    mesh.fTags.set((merged[i] as { tags: Uint32Array }).tags, f * mesh.tagWords);
    if (nonplanar(mesh, f, tolerance)) bent++;
  }
  removeOrphans(mesh, vertices);
  if (swept.size > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${swept.size} unselected interior edge(s) of the merged groups were removed too (${sweptSharp.length} sharp)`,
      detail: { edges: swept.size, sharp: sweptSharp.length },
    });
  }
  if (bent > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${bent} merged face(s) are non-planar; export triangulates them in their best-fit plane`,
      detail: { faces: bent },
    });
  }
  return ok({ dissolvedEdges: removed, merged: created.length });
}

/**
 * Split the mesh along the selected interior edges (an edge split / rip): the
 * corners around each touched vertex group into fans that do not cross a selected
 * edge, and every fan after the first gets its own vertex copy. An edge only
 * opens when its cut reaches a boundary or closes a loop; edges that stay joined
 * are reported.
 */
export function split(
  mesh: EditMesh,
  edges: readonly number[],
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const cut = new Set(edges.filter((e) => !mesh.isBoundaryEdge(e)));
  if (cut.size === 0) {
    return err(
      modelingError('model-op-no-effect', 'the selection has an interior edge', {
        edges: edges.length,
      }),
    );
  }
  const touched = new Set<number>();
  for (const e of cut) for (const v of mesh.edgeVertices(e)) touched.add(v);
  const corners = new Map<number, number[]>();
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const v = mesh.hVert[h] as number;
      if (!touched.has(v)) continue;
      const list = corners.get(v) ?? [];
      list.push(h);
      corners.set(v, list);
    }
  }
  const fans = new Groups();
  for (const list of corners.values()) {
    for (const h of list) {
      if (cut.has(h >> 1) || (mesh.hFace[h ^ 1] as number) === NONE) continue;
      fans.union(h, mesh.hNext[h ^ 1] as number);
    }
  }
  const vertexOf = new Map<number, number>();
  const origin = new Map<number, number>();
  for (const [v, list] of [...corners].sort((x, y) => x[0] - y[0])) {
    const roots = [...new Set(list.map((h) => fans.find(h)))].sort((x, y) => x - y);
    for (const [i, root] of roots.entries()) {
      if (i === 0) {
        vertexOf.set(root, v);
        continue;
      }
      const copy = mesh.addVertex(...mesh.position(v));
      vertexOf.set(root, copy);
      origin.set(copy, v);
    }
  }
  if (origin.size === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'the cut reaches a boundary or closes a loop',
        { edges: cut.size },
        'extend the edge selection to the mesh boundary or around a closed loop',
      ),
    );
  }
  const rewrites: FaceRewrite[] = [];
  for (const f of mesh.faces()) {
    const loop = faceCorners(mesh, f);
    if (!loop.some((c) => 'corner' in c && touched.has(c.v))) continue;
    const mapped = loop.map((c) =>
      'corner' in c && touched.has(c.v)
        ? { v: vertexOf.get(fans.find(c.corner)) as number, corner: c.corner }
        : c,
    );
    if (mapped.some((c, i) => c.v !== (loop[i] as CornerSource).v)) {
      rewrites.push({ face: f, loops: [mapped] });
    }
  }
  const pairs = [...cut].map((e) => mesh.edgeVertices(e));
  const done = rewriteFaces(mesh, rewrites, new Map(), origin);
  if (!done.ok) return done;
  const joined = pairs.filter(([a, b]) => {
    const h = mesh.findHalf(a, b);
    return h !== NONE && !mesh.isBoundaryEdge(h >> 1);
  }).length;
  if (joined > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${joined} selected edge(s) stayed joined: their cut neither reaches a boundary nor closes a loop`,
      detail: { edges: joined },
    });
  }
  return ok({ splitVertices: origin.size });
}

/**
 * Make every closed, edge-connected component touched by the selection face
 * outward (positive volume) by flipping inside-out components. Open components
 * have no inside and are left as they are. Effect assertion: every touched closed
 * component ends with a positive volume.
 */
export function orient(
  mesh: EditMesh,
  faces: readonly number[],
): Result<RoleCounts, ModelingError> {
  const touched = new Set(faces);
  const components = regionGroups(mesh, mesh.faces(), 'perIsland').filter((c) =>
    c.some((f) => touched.has(f)),
  );
  let flipped = 0;
  let open = 0;
  for (const component of components) {
    const closed = component.every((f) =>
      mesh.faceHalves(f).every((h) => (mesh.hFace[h ^ 1] as number) !== NONE),
    );
    if (!closed) {
      open++;
      continue;
    }
    if (facesVolume(mesh, component) >= 0) continue;
    const done = flipFaces(mesh, component);
    if (!done.ok) return done;
    flipped += component.length;
  }
  return ok({ flipped, openComponents: open });
}

/** Face corners starting at the lexicographically smallest position, as compact() orders them. */
function canonicalCorners(mesh: EditMesh, f: number): CornerSource[] {
  const corners = faceCorners(mesh, f);
  let start = 0;
  for (let i = 1; i < corners.length; i++) {
    const p = mesh.position((corners[i] as CornerSource).v);
    const q = mesh.position((corners[start] as CornerSource).v);
    const d = p[0] - q[0] || p[1] - q[1] || p[2] - q[2];
    if (d < 0) start = i;
  }
  return [...corners.slice(start), ...corners.slice(0, start)];
}

/**
 * Triangulate the selected n-gons exactly as export would (from the same canonical
 * first corner): strictly convex faces
 * fan from their first corner, others use constrained ear clipping in their
 * best-fit (Newell) plane. A face ear clipping cannot resolve (it overlaps itself)
 * is `model-degenerate`, the same verdict as export. Triangles keep the source
 * face's attributes and corner values; new diagonals are smooth.
 */
export function triangulate(
  mesh: EditMesh,
  faces: readonly number[],
): Result<RoleCounts, ModelingError> {
  const rewrites: FaceRewrite[] = [];
  let triangles = 0;
  for (const f of faces) {
    if ((mesh.fLen[f] as number) === 3) continue;
    const corners = canonicalCorners(mesh, f);
    const points = corners.map((c) => mesh.position(c.v) as Tuple3);
    const indices = triangulateLoop(points);
    if (indices === undefined) {
      return err(
        modelingError(
          'model-degenerate',
          'every face can be triangulated by ear clipping in its best-fit plane',
          { face: f },
          'the face overlaps itself in its best-fit plane; split or rebuild it',
        ),
      );
    }
    const loops: CornerSource[][] = [];
    for (let i = 0; i < indices.length; i += 3) {
      loops.push([0, 1, 2].map((k) => corners[indices[i + k] as number] as CornerSource));
    }
    triangles += loops.length;
    rewrites.push({ face: f, loops });
  }
  if (rewrites.length === 0) {
    return err(
      modelingError('model-op-no-effect', 'the selection has a face with more than 3 corners', {
        faces: faces.length,
      }),
    );
  }
  const done = rewriteFaces(mesh, rewrites);
  if (!done.ok) return done;
  return ok({ triangulated: rewrites.length, triangles });
}

/**
 * The boundary half-edge that follows boundary half `h` (no face): rotate around
 * the end vertex of `h` through the faces of its fan to the next outgoing half
 * without a face.
 */
function nextBoundaryHalf(mesh: EditMesh, h: number): number {
  let out = h ^ 1;
  while ((mesh.hFace[out] as number) !== NONE) out = (mesh.hPrev[out] as number) ^ 1;
  return out;
}

/**
 * The boundary cycle through boundary half `first`, split into simple loops: a
 * pinched vertex (several fans) joins holes into one cycle that visits it more
 * than once, and each sub-cycle between two visits is one hole. Returns the
 * half-edges of each loop.
 */
function boundaryLoops(mesh: EditMesh, first: number): number[][] {
  const loops: number[][] = [];
  const path: number[] = [];
  const at = new Map<number, number>();
  let h = first;
  do {
    const v = mesh.hVert[h] as number;
    const seen = at.get(v);
    if (seen !== undefined) {
      const loop = path.splice(seen);
      for (const g of loop) at.delete(mesh.hVert[g] as number);
      loops.push(loop);
    }
    at.set(v, path.length);
    path.push(h);
    h = nextBoundaryHalf(mesh, h);
  } while (h !== first);
  loops.push(path);
  return loops;
}

/**
 * Close every boundary loop that contains a selected boundary edge with one n-gon
 * cap (role `cap`, sharp rim). Loops are traced from the selected edges only, so
 * other boundaries never matter, and a pinched vertex separates the holes that
 * meet there. The cap takes `material`, or the single slot its rim faces use;
 * non-planar caps are reported in the repair report.
 */
export function fillHoles(
  mesh: EditMesh,
  edges: readonly number[],
  material: number | undefined,
  tolerance: number,
  attribution: Attribution,
  repair: RepairSink,
): Result<RoleCounts, ModelingError> {
  const interior = edges.filter((e) => !mesh.isBoundaryEdge(e));
  if (interior.length > 0) {
    return err(
      modelingError(
        'model-precondition',
        'fillHoles takes boundary edges',
        { interiorEdges: interior.length },
        'select openings with sel.edges.meshBoundary()',
      ),
    );
  }
  const wanted = new Set(edges);
  const traced = new Set<number>();
  const loops: number[][] = [];
  for (const e of [...edges].sort((a, b) => a - b)) {
    const first = (mesh.hFace[e * 2] as number) === NONE ? e * 2 : e * 2 + 1;
    if (traced.has(first)) continue;
    for (const loop of boundaryLoops(mesh, first)) {
      for (const h of loop) traced.add(h);
      if (loop.some((h) => wanted.has(h >> 1))) {
        loops.push(loop.map((h) => mesh.hVert[h] as number));
      }
    }
  }
  const filled = fillBoundaryLoops(mesh, loops, attribution, material);
  if (!filled.ok) return filled;
  repair({
    op: 'fillHoles',
    ...repairBase(filled.value.caps),
    largestLoop: Math.max(0, ...loops.map((l) => l.length)),
    nonplanar: nonplanarCaps(filled.value.caps, tolerance),
  });
  return ok(filled.value.counts);
}
