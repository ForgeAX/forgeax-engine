import { err, ok, type Result } from '@forgeax/engine-types';
import { mergeFlags } from './crease';
import { type ModelingError, modelingError } from './errors';
import { add, dot, length, newell, normalize, scale, sub, type Tuple3 } from './geom';
import { EDGE_SHARP, type EditMesh, NONE } from './mesh';
import {
  type Attribution,
  detachFaces,
  detachRegion,
  edgeFlagsBetween,
  markRole,
  type OpDiagnostic,
  type RepairSite,
  type RoleCounts,
  requireFinite,
  requireSegments,
  restoreFace,
  setEdgeFlags,
  sharedVertices,
} from './ops';
import { type CornerSource, rewriteFaces } from './rewrite';

export function copyEdgeIntent(
  from: EditMesh,
  to: EditMesh,
  loops: readonly (readonly number[])[],
  map: (v: number) => number,
): void {
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const flags = edgeFlagsBetween(from, a, b);
      if (flags !== 0) setEdgeFlags(to, map(a), map(b), flags);
    }
  }
}

/** Copy faces as a new island with their attributes, corner values and edge intent; role `copy`. */
export function duplicate(
  mesh: EditMesh,
  faces: readonly number[],
  label: number,
): Result<RoleCounts, ModelingError> {
  const copies = duplicateFaces(mesh, faces);
  if (!copies.ok) return copies;
  const counts: RoleCounts = {};
  markRole(mesh, copies.value, label, 'copy', counts);
  return ok(counts);
}

/** Copy faces (corner values, edge intent, attributes) as a separate island; returns the copies. */
export function duplicateFaces(
  mesh: EditMesh,
  faces: readonly number[],
): Result<number[], ModelingError> {
  const saved = detachFaces(mesh, faces);
  const copyOf = new Map<number, number>();
  for (const s of saved) {
    for (const v of s.loop) if (!copyOf.has(v)) copyOf.set(v, mesh.addVertex(...mesh.position(v)));
  }
  const scratch = mesh.clone();
  const copies: number[] = [];
  for (const s of saved) {
    const restored = restoreFace(mesh, scratch, s, (v) => copyOf.get(v) as number);
    if (!restored.ok) return restored;
    copies.push(restored.value);
  }
  copyEdgeIntent(
    scratch,
    mesh,
    saved.map((s) => s.loop),
    (v) => copyOf.get(v) as number,
  );
  return ok(copies);
}

/**
 * Detach faces from the rest of the mesh in place: vertices they share with other
 * faces are duplicated, so shared edges become two boundary edges.
 */
export function disconnect(
  mesh: EditMesh,
  faces: readonly number[],
): Result<RoleCounts, ModelingError> {
  const shared = sharedVertices(mesh, faces, false);
  if (shared.size === 0) {
    return err(
      modelingError('model-op-no-effect', 'the faces share a vertex with the rest of the mesh', {
        faces: faces.length,
      }),
    );
  }
  const done = detachRegion(mesh, faces, () => undefined, false, shared);
  if (!done.ok) return done;
  return ok({ disconnected: faces.length, splitVertices: shared.size });
}

export interface AppendOptions {
  /** Offset applied to every appended vertex. */
  readonly translate?: Tuple3;
}

/**
 * Copy another mesh into this one. Tags, labels, roles and material slots merge
 * by name; an explicit label replaces the operand's origins with role `part`.
 */
export function append(
  mesh: EditMesh,
  source: EditMesh,
  options: AppendOptions,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  const t = options.translate ?? [0, 0, 0];
  for (const c of t) {
    const checked = requireFinite('translate', c);
    if (!checked.ok) return checked;
  }
  const faces = source.faces();
  if (faces.length === 0) {
    return err(modelingError('model-op-no-effect', 'the appended mesh has faces', {}));
  }
  const vertexOf = new Map<number, number>();
  for (const v of source.vertices()) vertexOf.set(v, mesh.addVertex(...add(source.position(v), t)));
  const tagOf = source.tagNames.map((name) => mesh.tagIndex(name, true));
  const part = attribution.label === 0 ? 0 : mesh.nameIndex(mesh.roleNames, 'part');
  const loops: number[][] = [];
  for (const f of faces) {
    const loop = source.faceVertices(f);
    const material = mesh.nameIndex(
      mesh.materialNames,
      source.materialNames[source.fMaterial[f] as number] ?? 'Default',
    );
    const added = mesh.addFace(
      loop.map((v) => vertexOf.get(v) as number),
      material,
    );
    if (!added.ok) return added;
    const g = added.value;
    loops.push(loop);
    mesh.fFlags[g] = source.fFlags[f] as number;
    if (attribution.label !== 0) {
      mesh.fLabel[g] = attribution.label;
      mesh.fRole[g] = part;
    } else if ((source.fLabel[f] as number) !== 0) {
      mesh.fLabel[g] = mesh.nameIndex(
        mesh.labelNames,
        source.labelNames[source.fLabel[f] as number] as string,
      );
      mesh.fRole[g] = mesh.nameIndex(
        mesh.roleNames,
        source.roleNames[source.fRole[f] as number] as string,
      );
    }
    for (let i = 0; i < source.tagNames.length; i++) {
      if (source.hasTag(f, i)) mesh.addTag(g, tagOf[i] as number);
    }
    if (attribution.tag >= 0) mesh.addTag(g, attribution.tag);
    const from = source.faceHalves(f);
    const to = mesh.faceHalves(g);
    for (let i = 0; i < from.length; i++) {
      for (const name of source.channels.keys()) {
        const value = source.corner(name, from[i] as number);
        if (value !== undefined) mesh.setCorner(name, to[i] as number, value);
      }
    }
  }
  copyEdgeIntent(source, mesh, loops, (v) => vertexOf.get(v) as number);
  return ok({ part: faces.length });
}

export interface BridgeOptions {
  /** Face rows between the two loops (default 1). */
  readonly segments?: number;
  /** Material slot index for the strip; required when the loops border different slots. */
  readonly material?: number;
}

/** Trace the free (faceless) halves of the selected boundary edges into closed loops. */
export function traceBoundaryLoops(
  mesh: EditMesh,
  edges: readonly number[],
): Result<number[][], ModelingError> {
  const startOf = new Map<number, number>();
  for (const e of edges) {
    const free = (mesh.hFace[e * 2] as number) === NONE ? e * 2 : e * 2 + 1;
    if ((mesh.hFace[free] as number) !== NONE) {
      return err(
        modelingError(
          'model-precondition',
          'bridge joins open boundary loops',
          { edge: e },
          'delete the faces to bridge first, then select their boundary with sel.edges.meshBoundary()',
        ),
      );
    }
    const a = mesh.hVert[free] as number;
    if (startOf.has(a)) {
      return err(
        modelingError('model-precondition', 'each boundary vertex starts one selected edge', {
          vertex: a,
        }),
      );
    }
    startOf.set(a, free);
  }
  const loops: number[][] = [];
  const used = new Set<number>();
  for (const first of [...startOf.values()].sort((x, y) => x - y)) {
    if (used.has(first)) continue;
    const loop: number[] = [];
    let h = first;
    while (!used.has(h)) {
      used.add(h);
      loop.push(mesh.hVert[h] as number);
      const next = startOf.get(mesh.hVert[h ^ 1] as number);
      if (next === undefined) {
        return err(
          modelingError(
            'model-precondition',
            'the selected boundary edges form closed loops',
            { vertex: mesh.hVert[h ^ 1] },
            'select whole boundary loops, for example sel.edges.meshBoundary()',
          ),
        );
      }
      h = next;
    }
    loops.push(loop);
  }
  return ok(loops);
}

/**
 * Join two closed boundary loops with a quad strip (`side` role). Loops need the
 * same vertex count; the pairing rotation minimizes squared distances. Strip faces
 * inherit the tags both loops share; rung edges are smooth.
 */
export function bridge(
  mesh: EditMesh,
  edges: readonly number[],
  options: BridgeOptions,
  attribution: Attribution,
  diagnostics: OpDiagnostic[] = [],
): Result<RoleCounts, ModelingError> {
  const rows = options.segments ?? 1;
  const checkedRows = requireSegments('segments', rows, 1);
  if (!checkedRows.ok) return checkedRows;
  const traced = traceBoundaryLoops(mesh, edges);
  if (!traced.ok) return traced;
  if (traced.value.length !== 2) {
    return err(
      modelingError('model-precondition', 'the selection forms exactly two boundary loops', {
        loops: traced.value.length,
      }),
    );
  }
  let [a, b] = traced.value as [number[], number[]];
  if (a.length !== b.length) {
    // Loops of different sizes (a limb end into a body opening): the shorter loop's
    // longest boundary edges split at their midpoints until the counts match.
    const shorter = a.length < b.length ? a : b;
    const target = Math.max(a.length, b.length);
    const before = shorter.length;
    const grown = splitLongestEdges(mesh, shorter, target);
    if (!grown.ok) return grown;
    if (shorter === a) a = grown.value;
    else b = grown.value;
    diagnostics.push({
      severity: 'info',
      message: `bridge split ${target - before} edge(s) of the shorter loop to match ${target} vertices`,
      detail: { counts: [before, target], inserted: target - before },
    });
  }
  const n = a.length;
  let best = 0;
  let bestCost = Infinity;
  for (let k = 0; k < n; k++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const d = sub(mesh.position(a[i] as number), mesh.position(b[(k - i + n) % n] as number));
      cost += d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    }
    if (cost < bestCost - 1e-12) {
      best = k;
      bestCost = cost;
    }
  }
  const partner = (i: number) => b[(best - i + n * 2) % n] as number;
  const sideFace = (u: number, v: number) => mesh.hFace[mesh.findHalf(v, u)] as number;
  const columns = a.map((v, i) => ({
    faceA: sideFace(v, a[(i + 1) % n] as number),
    faceB: sideFace(partner(i + 1), partner(i)),
  }));
  const materials = new Set(
    columns.flatMap((c) => [c.faceA, c.faceB]).map((f) => mesh.fMaterial[f] as number),
  );
  let material = options.material;
  if (material === undefined) {
    if (materials.size > 1) {
      return err(
        modelingError(
          'model-invalid-argument',
          'the strip material is unambiguous',
          { slots: [...materials].map((m) => mesh.materialNames[m]) },
          'pass material: <slot> to bridge loops that border different material slots',
        ),
      );
    }
    material = [...materials][0] as number;
  }
  const rings: number[][] = [a];
  for (let r = 1; r < rows; r++) {
    rings.push(
      a.map((v, i) => {
        const p = mesh.position(v);
        return mesh.addVertex(...add(p, scale(sub(mesh.position(partner(i)), p), r / rows)));
      }),
    );
  }
  rings.push(a.map((_, i) => partner(i)));
  const strip: number[] = [];
  for (let r = 0; r < rows; r++) {
    const lower = rings[r] as number[];
    const upper = rings[r + 1] as number[];
    for (let i = 0; i < n; i++) {
      const k = (i + 1) % n;
      const added = mesh.addFace(
        [lower[i] as number, lower[k] as number, upper[k] as number, upper[i] as number],
        material,
      );
      if (!added.ok) return added;
      const f = added.value;
      const { faceA, faceB } = columns[i] as { faceA: number; faceB: number };
      for (let w = 0; w < mesh.tagWords; w++) {
        mesh.fTags[f * mesh.tagWords + w] =
          (mesh.fTags[faceA * mesh.tagWords + w] as number) &
          (mesh.fTags[faceB * mesh.tagWords + w] as number);
      }
      if (attribution.tag >= 0) mesh.addTag(f, attribution.tag);
      strip.push(f);
    }
  }
  const counts: RoleCounts = {};
  markRole(mesh, strip, attribution.label, 'side', counts);
  return ok(counts);
}

/**
 * Close boundary loops (vertex lists in free-half order) with one n-gon cap each,
 * role `cap`, sharp rim. The cap takes `material` or the single slot its rim faces
 * use, and the tags they all share. Each cap reports its Newell deviation (`caps`, in
 * loop order): the largest corner distance from the plane through its centroid.
 */
export function fillBoundaryLoops(
  mesh: EditMesh,
  loops: readonly (readonly number[])[],
  attribution: Attribution,
  material: number | undefined,
): Result<{ readonly counts: RoleCounts; readonly caps: readonly RepairSite[] }, ModelingError> {
  const plans = [];
  for (const loop of loops) {
    const rim = loop.map((v, i) => {
      const w = loop[(i + 1) % loop.length] as number;
      return mesh.hFace[mesh.findHalf(w, v)] as number;
    });
    const slots = new Set(rim.map((f) => mesh.fMaterial[f] as number));
    if (material === undefined && slots.size > 1) {
      return err(
        modelingError(
          'model-invalid-argument',
          'the cap material is unambiguous',
          { slots: [...slots].map((m) => mesh.materialNames[m]) },
          'pass material: <slot> to fill openings whose rim uses several material slots',
        ),
      );
    }
    plans.push({ loop, rim, material: material ?? ([...slots][0] as number) });
  }
  const caps: number[] = [];
  const sites: RepairSite[] = [];
  for (const plan of plans) {
    const added = mesh.addFace(plan.loop, plan.material);
    if (!added.ok) return added;
    const f = added.value;
    for (let w = 0; w < mesh.tagWords; w++) {
      let shared = 0xffffffff;
      for (const r of plan.rim) shared &= mesh.fTags[r * mesh.tagWords + w] as number;
      mesh.fTags[f * mesh.tagWords + w] = shared >>> 0;
    }
    if (attribution.tag >= 0) mesh.addTag(f, attribution.tag);
    for (const h of mesh.faceHalves(f)) {
      mesh.eFlags[h >> 1] = mergeFlags(mesh.eFlags[h >> 1] as number, EDGE_SHARP);
    }
    sites.push(newellDeviation(plan.loop.map((v) => mesh.position(v))));
    caps.push(f);
  }
  const counts: RoleCounts = {};
  markRole(mesh, caps, attribution.label, 'cap', counts);
  return ok({ counts, caps: sites });
}

/** The centroid of a polygon and its largest corner distance from the Newell plane through it. */
function newellDeviation(points: readonly Tuple3[]): RepairSite {
  const at: Tuple3 = [0, 0, 0];
  for (const p of points) {
    for (let k = 0; k < 3; k++) at[k] = (at[k] as number) + (p[k] as number) / points.length;
  }
  const n = normalize(newell(points));
  let deviation = 0;
  for (const p of points) deviation = Math.max(deviation, Math.abs(dot(n, sub(p, at))));
  return { at, deviation };
}

/** How many caps lie farther than 10 x `tolerance` from their Newell plane. */
export function nonplanarCaps(caps: readonly RepairSite[], tolerance: number): number {
  return caps.filter((c) => c.deviation > tolerance * 10).length;
}

/**
 * Split the edges of a boundary loop (vertices in free-half order) until it has `target`
 * vertices, spread by arc length: edge `i` ends at the `round(target x s_i / L)`-th vertex
 * of the grown loop, so equal edges split evenly around the loop instead of in one run and
 * the bridge rungs stay within half a segment of their partners. Every edge keeps at
 * least one piece; the face along a split edge gains the vertices with interpolated
 * corner values.
 */
function splitLongestEdges(
  mesh: EditMesh,
  loop: readonly number[],
  target: number,
): Result<number[], ModelingError> {
  const n = loop.length;
  const lengths = loop.map((v, i) =>
    length(sub(mesh.position(loop[(i + 1) % n] as number), mesh.position(v))),
  );
  const total = lengths.reduce((a, b) => a + b, 0);
  const pieces: number[] = [];
  let walked = 0;
  let placed = 0;
  for (let i = 0; i < n; i++) {
    walked += lengths[i] as number;
    const remaining = n - 1 - i;
    const end =
      i === n - 1
        ? target
        : Math.min(
            target - remaining,
            Math.max(placed + 1, Math.round(total > 0 ? (target * walked) / total : i + 1)),
          );
    pieces.push(end - placed);
    placed = end;
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = loop[i] as number;
    const w = loop[(i + 1) % n] as number;
    out.push(u);
    const k = pieces[i] as number;
    let from = u;
    for (let j = 1; j < k; j++) {
      // Split the remaining sub-edge from -> w so the new vertex sits at j / k of u -> w.
      const h = mesh.findHalf(w, from);
      const face = mesh.hFace[h] as number;
      const t = 1 / (k - j + 1);
      const p = add(mesh.position(from), scale(sub(mesh.position(w), mesh.position(from)), t));
      const v = mesh.addVertex(...p);
      const corners: CornerSource[] = [];
      for (const g of mesh.faceHalves(face)) {
        corners.push({ v: mesh.hVert[g] as number, corner: g });
        if (g === h) corners.push({ v, from: h, to: mesh.hNext[h] as number, t: 1 - t });
      }
      const done = rewriteFaces(
        mesh,
        [{ face, loops: [corners] }],
        new Map([[v, [w, from] as const]]),
      );
      if (!done.ok) return done;
      out.push(v);
      from = v;
    }
  }
  return ok(out);
}
