import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import { type BooleanContext, booleanOp, extractFaces } from './boolean';
import { hausdorff, signedDeviation } from './compute/mesh-query';
import { append } from './connect';
import { hypot3 } from './dmath';
import { silhouetteIoU } from './drawing-check';
import { type ModelingError, modelingError } from './errors';
import { encodeSnapshot } from './fxem';
import { facesVolume, type Tuple3 } from './geom';
import { EDGE_SEAM, EDGE_SHARP, type EditMesh, partRole } from './mesh';
import {
  type Attribution,
  deleteFaces,
  markEdges,
  type OpDiagnostic,
  type RoleCounts,
} from './ops';
import { cleanupQuads, type QuadOptions, quadMetrics } from './planar';
import { cleanupTiling, simplifyFaces } from './remesh';
import { removeSlivers, sliverFaces } from './repair';
import type { Issue } from './report';
import { sel } from './selectors';
import { type AutoUvOptions, autoUv, type UvContext } from './uv';
import type { PerspectiveView } from './views';
import { type ProcessContext, voxelRebuild } from './voxel';

/** `m.lowpoly`: one unioned, simplified, mostly-quad shell per rigid part set. */
export interface LowpolyOptions {
  /**
   * How parts join (default mode 'auto': the mesh boolean (`'exact'`) in part order; a part that fails
   * against the partial shell retries against the finished one, and only a part that still
   * fails `model-partial` or a precondition is voxel-unioned with the shells it touches
   * (`union: 'mixed'`, reported `fallback`); mode 'voxel' rebuilds the whole set).
   * "Exact" means the mesh boolean on the triangle meshes (BSP CSG), not the B-rep boolean in
   * `@forgeax/engine-modeling/brep`; mode 'exact' returns the first failure instead of voxel-unioning.
   * `voxelSize` defaults to half the thinnest part's shortest bounds side, clamped to
   * [longest / 64, longest / 16] of the whole set: two voxels across the thinnest plate.
   */
  readonly union?: { readonly mode?: 'auto' | 'exact' | 'voxel'; readonly voxelSize?: number };
  /** Export triangles to keep (a quad counts 2), as simplify's `targetFaces`. */
  readonly targetFaces: number;
  /** Edges above this dihedral (degrees, default 45) become sharp: kept by QEM, UV seams. */
  readonly hardAngle?: number;
  /** Outline views for the QEM contour weight (weight default 1) and the IoU report. */
  readonly silhouette?: {
    readonly views: readonly PerspectiveView[];
    readonly weight?: number;
  };
  /**
   * Remove the faces narrower than this (meters, `cleanup.slivers`' width: height over the
   * longest edge) after the union, before simplification: first where every neighbour stays
   * planar, then moving surface by at most the width. What stays is counted in the report's
   * `slivers.kept`; `validate({ slivers })` gates it. Omitted: none removed.
   */
  readonly slivers?: number;
  /** cleanup.quads options, or false to keep triangles. */
  readonly quads?: QuadOptions | false;
  /** uv.auto options (sharp edges are always seams); omitted: no UVs. */
  readonly uv?: Omit<AutoUvOptions, 'respectSharp'>;
  /**
   * Tag each output component `groupPrefix + k` (the shape `bakeMaps` reads). When
   * `preserveGroups` is true and input faces already carry `groupPrefix + <id>` tags,
   * each group unions and simplifies within itself so `bake:<id>` correspondences match
   * the high-poly groups before all groups are UV-unwrapped together into one atlas.
   */
  readonly tags?: { readonly groupPrefix: string; readonly preserveGroups?: boolean };
  /**
   * `'form'` derives the low by part role (`m.markRole`): every part whose faces are all
   * `detail` or `tool` (floating details, separate fittings) is dropped before the union; a
   * part with any `form` face is kept whole. Omitted: every part joins.
   */
  readonly roles?: 'form';
}

/**
 * What the voxel union rebuilt away, as a net count (input minus rebuilt output, so an
 * attribute the output still carries is not lost): faces per label, material and non-form
 * role, set corners per channel, and seam edges. `bySource` splits the same counts by the input tag of each face
 * (`untagged` for none); sources and names with no loss are absent, keys ascend.
 */
export interface LowpolyLost {
  readonly labels: Readonly<Record<string, number>>;
  readonly materials: Readonly<Record<string, number>>;
  readonly corners: Readonly<Record<string, number>>;
  readonly roles: Readonly<Record<string, number>>;
  readonly seams: number;
  readonly bySource: Readonly<
    Record<
      string,
      { readonly labels: number; readonly materials: number; readonly corners: number }
    >
  >;
}

export type LowpolyIssueCode =
  | 'not-closed'
  | 'deviation'
  | 'silhouette'
  | 'quad-ratio'
  | 'valence'
  | 'planarity'
  | 'over-budget';

/** Gate limits of the lowpoly report (warn issues). */
const MIN_QUAD_RATIO = 0.85;
const MIN_IOU = 0.97;
const MAX_DEVIATION = 0.02;
/** Tiling moves stay within this fraction of the shell diagonal. */
const TILING_ERROR = 1e-4;

export interface LowpolyContext {
  readonly remesh: ProcessContext;
  readonly uv: UvContext;
  readonly boolean: BooleanContext;
}

const NO_ATTRIBUTION: Attribution = { label: 0, material: 0, tag: -1 };

/** Vertex-connected components of faces, each ascending, ordered by their smallest face. */
export function vertexComponents(mesh: EditMesh, faces: readonly number[]): number[][] {
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while ((parent.get(r) as number) !== r) r = parent.get(r) as number;
    let c = v;
    while (c !== r) {
      const n = parent.get(c) as number;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const f of faces) {
    const vs = mesh.faceVertices(f);
    for (const v of vs) if (!parent.has(v)) parent.set(v, v);
    const a = find(vs[0] as number);
    for (const v of vs) {
      const b = find(v);
      if (b !== a) parent.set(b, a);
    }
  }
  const groups = new Map<number, number[]>();
  for (const f of [...faces].sort((x, y) => x - y)) {
    const r = find(mesh.faceVertices(f)[0] as number);
    const g = groups.get(r);
    if (g === undefined) groups.set(r, [f]);
    else g.push(f);
  }
  return [...groups.values()];
}

function soup(mesh: EditMesh): { points: Float64Array; corners: Int32Array } {
  const corners: number[] = [];
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    for (let i = 1; i + 1 < vs.length; i++) {
      corners.push(vs[0] as number, vs[i] as number, vs[i + 1] as number);
    }
  }
  return { points: mesh.pos, corners: Int32Array.from(corners) };
}

function exportTriangles(mesh: EditMesh): number {
  let n = 0;
  for (const f of mesh.faces()) n += mesh.faceVertices(f).length - 2;
  return n;
}

function closed(mesh: EditMesh, faces: readonly number[]): boolean {
  const own = new Set(faces);
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const other = mesh.hFace[h ^ 1] as number;
      if (!own.has(other)) return false;
    }
  }
  return true;
}

function bounds(mesh: EditMesh): { longest: number; shortest: number; diagonal: number } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i] as number, p[i] as number);
      hi[i] = Math.max(hi[i] as number, p[i] as number);
    }
  }
  const d = [0, 1, 2].map((i) => (hi[i] as number) - (lo[i] as number));
  return {
    longest: maxOf(d),
    shortest: minOf(d),
    diagonal: hypot3(d[0] as number, d[1] as number, d[2] as number),
  };
}

function info(diagnostics: readonly OpDiagnostic[], prefix: string): Record<string, unknown> {
  for (let i = diagnostics.length - 1; i >= 0; i--) {
    const d = diagnostics[i] as OpDiagnostic;
    if (d.severity === 'info' && d.message.startsWith(prefix)) return { ...d.detail };
  }
  return {};
}

function sortedRecord<T>(map: ReadonlyMap<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key) as T;
  return out;
}

/** Two voxels across the thinnest part, within [longest / 64, longest / 16] of the set. */
function defaultVoxelSize(mesh: EditMesh, parts: readonly number[][]): number {
  const longest = bounds(mesh).longest;
  let thinnest = Infinity;
  for (const part of parts)
    thinnest = Math.min(thinnest, bounds(extractFaces(mesh, part)).shortest);
  return Math.min(longest / 16, Math.max(longest / 64, thinnest / 2));
}

interface Census {
  readonly labels: Map<string, number>;
  readonly materials: Map<string, number>;
  readonly corners: Map<string, number>;
  readonly roles: Map<string, number>;
  readonly owners: Map<string, { labels: number; materials: number; corners: number }>;
  seams: number;
}

/** Face counts of non-default labels, materials and roles, set corners and seam edges. */
function census(mesh: EditMesh): Census {
  const out: Census = {
    labels: new Map(),
    materials: new Map(),
    corners: new Map(),
    roles: new Map(),
    owners: new Map(),
    seams: 0,
  };
  const bump = (m: Map<string, number>, key: string, n: number) =>
    m.set(key, (m.get(key) ?? 0) + n);
  for (const f of mesh.faces()) {
    const label = mesh.fLabel[f] as number;
    const material = mesh.fMaterial[f] as number;
    const role = partRole(mesh, f);
    let cornerCount = 0;
    for (const [name, channel] of mesh.channels) {
      let n = 0;
      for (const h of mesh.faceHalves(f)) if ((channel.set[h] as number) !== 0) n++;
      if (n > 0) bump(out.corners, name, n);
      cornerCount += n;
    }
    const lostLabel = label !== 0 ? 1 : 0;
    const lostMaterial = material !== 0 ? 1 : 0;
    if (lostLabel === 1) bump(out.labels, mesh.labelNames[label] as string, 1);
    if (lostMaterial === 1) bump(out.materials, mesh.materialNames[material] as string, 1);
    if (role !== 'form') bump(out.roles, role, 1);
    if (lostLabel + lostMaterial + cornerCount === 0) continue;
    const owners: string[] = [];
    for (let t = 0; t < mesh.tagNames.length; t++) {
      if (mesh.hasTag(f, t)) owners.push(mesh.tagNames[t] as string);
    }
    if (owners.length === 0) owners.push('untagged');
    for (const owner of owners) {
      const entry = out.owners.get(owner) ?? { labels: 0, materials: 0, corners: 0 };
      entry.labels += lostLabel;
      entry.materials += lostMaterial;
      entry.corners += cornerCount;
      out.owners.set(owner, entry);
    }
  }
  for (const e of mesh.edges()) if (((mesh.eFlags[e] as number) & EDGE_SEAM) !== 0) out.seams++;
  return out;
}

function shortfall(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>) {
  const out = new Map<string, number>();
  for (const [key, n] of before) {
    const missing = n - (after.get(key) ?? 0);
    if (missing > 0) out.set(key, missing);
  }
  return sortedRecord(out);
}

/**
 * What a voxel rebuild of `mesh` dropped, by net count: the input's census minus the rebuilt
 * mesh's, so an attribute the rebuild carried over is not reported lost.
 */
function voxelLoss(before: Census, rebuilt: EditMesh): LowpolyLost {
  const after = census(rebuilt);
  const by = new Map<string, { labels: number; materials: number; corners: number }>();
  for (const [owner, was] of before.owners) {
    const now = after.owners.get(owner) ?? { labels: 0, materials: 0, corners: 0 };
    const entry = {
      labels: Math.max(0, was.labels - now.labels),
      materials: Math.max(0, was.materials - now.materials),
      corners: Math.max(0, was.corners - now.corners),
    };
    if (entry.labels + entry.materials + entry.corners > 0) by.set(owner, entry);
  }
  return {
    labels: shortfall(before.labels, after.labels),
    materials: shortfall(before.materials, after.materials),
    corners: shortfall(before.corners, after.corners),
    roles: shortfall(before.roles, after.roles),
    seams: Math.max(0, before.seams - after.seams),
    bySource: sortedRecord(by),
  };
}

const sumRecords = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
  const out = new Map<string, number>(Object.entries(a));
  for (const [k, n] of Object.entries(b)) out.set(k, (out.get(k) ?? 0) + n);
  return sortedRecord(out);
};

function sumLost(a: LowpolyLost | undefined, b: LowpolyLost): LowpolyLost {
  if (a === undefined) return b;
  const by = new Map<string, { labels: number; materials: number; corners: number }>();
  for (const src of [a.bySource, b.bySource]) {
    for (const [k, v] of Object.entries(src)) {
      const e = by.get(k) ?? { labels: 0, materials: 0, corners: 0 };
      by.set(k, {
        labels: e.labels + v.labels,
        materials: e.materials + v.materials,
        corners: e.corners + v.corners,
      });
    }
  }
  return {
    labels: sumRecords(a.labels, b.labels),
    materials: sumRecords(a.materials, b.materials),
    corners: sumRecords(a.corners, b.corners),
    roles: sumRecords(a.roles, b.roles),
    seams: a.seams + b.seams,
    bySource: sortedRecord(by),
  };
}

const overlaps = (a: { min: Tuple3; max: Tuple3 }, b: { min: Tuple3; max: Tuple3 }, pad: number) =>
  [0, 1, 2].every(
    (i) =>
      (a.min[i] as number) - pad <= (b.max[i] as number) &&
      (b.min[i] as number) - pad <= (a.max[i] as number),
  );

function boxOf(mesh: EditMesh, faces: readonly number[]): { min: Tuple3; max: Tuple3 } {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const f of faces) {
    for (const v of mesh.faceVertices(f)) {
      const p = mesh.position(v);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i] as number, p[i] as number);
        max[i] = Math.max(max[i] as number, p[i] as number);
      }
    }
  }
  return { min, max };
}

/**
 * Union the parts of `work` in place. 'exact' joins part by part with the mesh boolean (BSP CSG over
 * the triangle meshes, `booleanOp` in boolean.ts), not the B-rep exact boolean in brep/boolean.ts.
 * A part that fails (`model-partial`, `model-precondition`) is deferred and retried once
 * against the finished shell (the order that failed is often not the order that works);
 * in 'auto' mode a part that still fails is voxel-unioned with only the shell components
 * its bounds touch, so the materials, tags and labels of every other part survive.
 * 'voxel' rebuilds the whole set.
 */
function unionParts(
  work: EditMesh,
  parts: readonly number[][],
  options: LowpolyOptions,
  context: LowpolyContext,
  inner: OpDiagnostic[],
): Result<
  {
    readonly union: 'none' | 'exact' | 'voxel' | 'mixed';
    readonly exactError?: string;
    readonly voxelSize?: number;
    readonly clusters?: number;
    readonly lost?: LowpolyLost;
  },
  ModelingError
> {
  if (parts.length < 2) return ok({ union: 'none' });
  const mode = options.union?.mode ?? 'auto';
  let exactError: string | undefined;
  let running: EditMesh | undefined;
  let stuck: number[][] = [];
  if (mode !== 'voxel') {
    running = extractFaces(work, parts[0] as number[]);
    let deferred: { part: number[]; error: ModelingError }[] = [];
    const join = (part: number[]) =>
      booleanOp(
        running as EditMesh,
        'union',
        { mesh: extractFaces(work, part) },
        {},
        NO_ATTRIBUTION,
        context.boolean,
        inner,
      );
    for (const part of parts.slice(1)) {
      const joined = join(part);
      if (!joined.ok) deferred.push({ part, error: joined.error });
    }
    const retry = deferred;
    deferred = [];
    for (const { part } of retry) {
      const joined = join(part);
      if (!joined.ok) deferred.push({ part, error: joined.error });
    }
    for (const { error } of deferred) {
      const recoverable = error.code === 'model-partial' || error.code === 'model-precondition';
      if (mode === 'exact' || !recoverable) return err(error);
      exactError ??= error.code;
    }
    stuck = deferred.map((d) => d.part);
    if (stuck.length === 0) {
      work.assign(running);
      return ok({ union: 'exact' });
    }
  }
  let lost: LowpolyLost | undefined;
  let voxelSize: number | undefined;
  let clusters = 0;
  const rebuild = (cluster: EditMesh, size: number | undefined) => {
    const parts = vertexComponents(cluster, cluster.faces());
    const sized = size ?? options.union?.voxelSize ?? defaultVoxelSize(cluster, parts);
    voxelSize = Math.max(voxelSize ?? 0, sized);
    const before = census(cluster);
    const rebuilt = voxelRebuild(
      cluster,
      cluster.faces(),
      'union',
      { voxelSize: sized, radius: 0, sharp: true },
      NO_ATTRIBUTION,
      false,
      context.remesh,
      inner,
    );
    if (rebuilt.ok) lost = sumLost(lost, voxelLoss(before, cluster));
    return rebuilt;
  };
  if (running === undefined) {
    const rebuilt = rebuild(work, undefined);
    if (!rebuilt.ok) return rebuilt;
    return ok({ union: 'voxel', voxelSize: voxelSize as number, lost: lost as LowpolyLost });
  }
  const size = options.union?.voxelSize ?? defaultVoxelSize(work, parts);
  const pad = size;
  for (const part of stuck) {
    const piece = extractFaces(work, part);
    const box = boxOf(piece, piece.faces());
    const shells = vertexComponents(running, running.faces());
    const touched = shells.filter((c) => overlaps(boxOf(running as EditMesh, c), box, pad));
    const rest = new Set(running.faces());
    const cluster = extractFaces(work, part);
    for (const c of touched) {
      for (const f of c) rest.delete(f);
    }
    const merged = extractFaces(running, touched.flat());
    const join = append(cluster, merged, {}, NO_ATTRIBUTION);
    if (!join.ok) return join;
    const rebuilt = rebuild(cluster, size);
    if (!rebuilt.ok) return rebuilt;
    const next = extractFaces(running, [...rest]);
    const added = append(next, cluster, {}, NO_ATTRIBUTION);
    if (!added.ok) return added;
    running = next;
    clusters++;
  }
  work.assign(running);
  return ok({
    union: 'mixed',
    ...(exactError === undefined ? {} : { exactError }),
    voxelSize: size,
    clusters,
    lost: lost as LowpolyLost,
  });
}

/** What the sliver pass did: found before, removed, left, the largest move and the volume change. */
export interface LowpolySlivers {
  readonly width: number;
  readonly found: number;
  readonly removed: number;
  readonly kept: number;
  readonly maxMove: number;
  readonly volumeChange: number;
}

/**
 * Remove slivers of `width` in place, in two passes: the exact one (every neighbour stays
 * planar within the model tolerance), then one that lets neighbours bend by up to `width`.
 */
function clearSlivers(
  work: EditMesh,
  width: number,
  tolerance: number,
): Result<LowpolySlivers, ModelingError> {
  const all = work.faces();
  const found = sliverFaces(work, all, width).length;
  const volume = facesVolume(work, all);
  let removed = 0;
  let maxMove = 0;
  for (const slack of [tolerance, width]) {
    const done = removeSlivers(work, work.faces(), width, slack);
    if (!done.ok) return done;
    removed += done.value.removed;
    for (const site of done.value.sites) maxMove = Math.max(maxMove, site.deviation);
  }
  return ok({
    width,
    found,
    removed,
    kept: sliverFaces(work, work.faces(), width).length,
    maxMove,
    volumeChange: volume === 0 ? 0 : (facesVolume(work, work.faces()) - volume) / volume,
  });
}

/**
 * The lowpoly pipeline on `faces` of `mesh`: parts (vertex-connected components)
 * unioned, hard edges marked sharp, QEM to `targetFaces`, triangle pairs to quads, optional
 * uv.auto with sharp seams and one tag per output component. The selected faces are
 * replaced; one info diagnostic carries the verdict and issues.
 */
/** The faces of every part with at least one `form` face (deriveLowByRole). */
function formParts(
  mesh: EditMesh,
  faces: readonly number[],
  diagnostics: OpDiagnostic[],
): number[] {
  const kept: number[] = [];
  const dropped: Record<string, number> = { detail: 0, tool: 0 };
  for (const part of vertexComponents(mesh, faces)) {
    if (part.some((f) => partRole(mesh, f) === 'form')) {
      for (const f of part) kept.push(f);
      continue;
    }
    for (const f of part) {
      const role = partRole(mesh, f);
      dropped[role] = (dropped[role] ?? 0) + 1;
    }
  }
  if (dropped.detail !== 0 || dropped.tool !== 0) {
    diagnostics.push({
      severity: 'info',
      message: `lowpoly drops the detail and tool parts (faces by role: ${JSON.stringify(dropped)})`,
      detail: { dropped },
    });
  }
  return kept.sort((a, b) => a - b);
}

type UnionOutcome = Extract<ReturnType<typeof unionParts>, { ok: true }>['value'];

function unionAndSimplifyShell(
  work: EditMesh,
  parts: readonly number[][],
  targetFaces: number,
  hardAngle: number,
  weight: number,
  options: LowpolyOptions,
  context: LowpolyContext,
  inner: OpDiagnostic[],
): Result<{ readonly joined: UnionOutcome; readonly slivers?: LowpolySlivers }, ModelingError> {
  const joined = unionParts(work, parts, options, context, inner);
  if (!joined.ok) return joined;

  // A smooth part (a dome, a sphere) has no hard edge; that is not an empty-selection error.
  const hard = sel.edges.dihedral('>', hardAngle).atLeast(0).resolve(work);
  if (!hard.ok) return hard;
  markEdges(work, hard.value, EDGE_SHARP, true);

  const scale = bounds(work).diagonal;
  const before = exportTriangles(work);
  if (before > targetFaces) {
    const simplified = simplifyFaces(
      work,
      work.faces(),
      {
        targetFaces,
        ...(options.silhouette === undefined
          ? {}
          : { silhouette: { views: options.silhouette.views, weight } }),
      },
      context.remesh,
      inner,
    );
    if (!simplified.ok) return simplified;
  }
  if (options.quads !== false) {
    // QEM leaves triangle fans on flat faces; Delaunay flips (no surface change) dissolve
    // their poles before pairing, so the quads follow the faces' edges.
    const tiled = cleanupTiling(
      work,
      work.faces(),
      { maxError: TILING_ERROR * scale },
      context.remesh,
      inner,
    );
    if (!tiled.ok && tiled.error.code !== 'model-op-no-effect') return tiled;
    const paired = cleanupQuads(work, work.faces(), options.quads ?? {}, inner);
    if (!paired.ok && paired.error.code !== 'model-op-no-effect') return paired;
  }
  const slivers =
    options.slivers === undefined
      ? undefined
      : clearSlivers(work, options.slivers, context.boolean.tolerance);
  if (slivers !== undefined && !slivers.ok) return slivers;
  return ok({
    joined: joined.value,
    ...(slivers === undefined ? {} : { slivers: slivers.value }),
  });
}

export function lowpolyFaces(
  mesh: EditMesh,
  faces: readonly number[],
  options: LowpolyOptions,
  context: LowpolyContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const hardAngle = options.hardAngle ?? 45;
  if (!(Number.isFinite(hardAngle) && hardAngle > 0 && hardAngle < 180)) {
    return err(
      modelingError('model-invalid-argument', 'hardAngle is in (0, 180) degrees', { hardAngle }),
    );
  }
  if (!(Number.isInteger(options.targetFaces) && options.targetFaces >= 4)) {
    return err(
      modelingError('model-invalid-argument', 'targetFaces is an integer >= 4', {
        targetFaces: options.targetFaces,
      }),
    );
  }
  if (options.slivers !== undefined && !(Number.isFinite(options.slivers) && options.slivers > 0)) {
    return err(
      modelingError('model-invalid-argument', 'slivers is a finite width > 0', {
        slivers: options.slivers,
      }),
    );
  }
  const weight = options.silhouette?.weight ?? 1;
  if (options.silhouette !== undefined && !(Number.isFinite(weight) && weight >= 0)) {
    return err(
      modelingError('model-invalid-argument', 'silhouette.weight is finite and >= 0', { weight }),
    );
  }
  const prefix = options.tags?.groupPrefix;
  if (prefix !== undefined && (typeof prefix !== 'string' || prefix.length === 0)) {
    return err(
      modelingError('model-invalid-argument', 'tags.groupPrefix is a non-empty string', {
        groupPrefix: prefix,
      }),
    );
  }
  if (options.roles !== undefined && options.roles !== 'form') {
    return err(
      modelingError('model-invalid-argument', "roles is 'form'", { roles: options.roles }),
    );
  }
  const kept = options.roles === 'form' ? formParts(mesh, faces, diagnostics) : faces;
  if (kept.length === 0) {
    return err(
      modelingError(
        'model-precondition',
        "lowpoly({ roles: 'form' }) keeps at least one part with a form face",
        { faces: faces.length },
        "mark the body's faces 'form' (m.markRole), or omit roles",
      ),
    );
  }
  const input = extractFaces(mesh, kept);
  const parts = vertexComponents(input, input.faces());
  for (const [index, part] of parts.entries()) {
    const volume = facesVolume(input, part);
    if (!closed(input, part) || !(volume > 0)) {
      return err(
        modelingError(
          'model-precondition',
          'every part is a closed, outward-oriented shell (positive volume)',
          { part: index, faces: part.length, volume, closed: closed(input, part) },
          volume < 0
            ? 'the part is inside-out: m.flip its faces or rebuild it, then rerun lowpoly'
            : 'close the part first (m.fillHoles or voxel.fillHoles), then rerun lowpoly',
        ),
      );
    }
  }
  const partVolumes = parts.map((p) => facesVolume(input, p));
  const inner: OpDiagnostic[] = [];

  // Optional group-preserving mode: union + simplify per existing `<prefix><id>` group
  // so multi-part `bake:<id>` tags remain aligned with high-poly before shared UV packing.
  const preservedGroups = new Map<string, number[]>();
  if (prefix !== undefined && options.tags?.preserveGroups === true) {
    const matchingTags = input.tagNames
      .map((name, idx) => ({ name, idx }))
      .filter((t) => t.name.startsWith(prefix));
    for (const f of input.faces()) {
      const hit = matchingTags.find((t) => input.hasTag(f, t.idx));
      const key = hit?.name ?? '';
      const arr = preservedGroups.get(key);
      if (arr === undefined) preservedGroups.set(key, [f]);
      else arr.push(f);
    }
  }

  let work: EditMesh;
  let unionOutcome: UnionOutcome;
  let sliversOutcome: LowpolySlivers | undefined;
  let shell: EditMesh;
  const preserveTagged =
    preservedGroups.size > 0 && !(preservedGroups.size === 1 && preservedGroups.has(''));

  if (!preserveTagged) {
    work = input.clone();
    const res = unionAndSimplifyShell(
      work,
      parts,
      options.targetFaces,
      hardAngle,
      weight,
      options,
      context,
      inner,
    );
    if (!res.ok) return res;
    unionOutcome = res.value.joined;
    sliversOutcome = res.value.slivers;
    // Clone input before simplification for Hausdorff comparison? Wait: existing code compared against unioned shell!
    shell = input.clone();
    const shellUnion = unionParts(shell, parts, options, context, []);
    if (!shellUnion.ok) shell = input.clone();
  } else {
    shell = extractFaces(input, []);
    work = extractFaces(input, []);
    const entries = [...preservedGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const totalGroupFaces = Math.max(
      1,
      entries.reduce((s, [, fs]) => s + fs.length, 0),
    );
    let remainingBudget = Math.max(options.targetFaces, entries.length * 4);
    let combinedUnion: UnionOutcome = { union: 'none' };
    for (const [idx, [tagName, groupFaceIds]] of entries.entries()) {
      const sub = extractFaces(input, groupFaceIds);
      const subParts = vertexComponents(sub, sub.faces());
      const subShell = sub.clone();
      const su = unionParts(subShell, subParts, options, context, []);
      if (su.ok) append(shell, subShell, {}, NO_ATTRIBUTION);
      else append(shell, sub.clone(), {}, NO_ATTRIBUTION);

      const leftGroups = entries.length - idx - 1;
      const proportional = Math.max(
        4,
        Math.round((options.targetFaces * groupFaceIds.length) / totalGroupFaces),
      );
      const groupTarget =
        idx === entries.length - 1
          ? Math.max(4, remainingBudget)
          : Math.min(proportional, Math.max(4, remainingBudget - leftGroups * 4));
      remainingBudget = Math.max(4 * leftGroups, remainingBudget - groupTarget);

      const res = unionAndSimplifyShell(
        sub,
        subParts,
        groupTarget,
        hardAngle,
        weight,
        options,
        context,
        inner,
      );
      if (!res.ok) return res;
      if (res.value.joined.union !== 'none') combinedUnion = res.value.joined;
      if (tagName !== '') {
        const tagIdx = sub.tagIndex(tagName, true);
        for (const f of sub.faces()) sub.addTag(f, tagIdx);
      }
      const appended = append(work, sub, {}, NO_ATTRIBUTION);
      if (!appended.ok) return appended;
    }
    unionOutcome = combinedUnion;
  }

  const scale = bounds(shell).diagonal;
  if (options.uv !== undefined) {
    const mapped = autoUv(
      work,
      work.faces(),
      { ...options.uv, respectSharp: true },
      context.uv,
      inner,
    );
    if (!mapped.ok) return mapped;
  }

  const components = vertexComponents(work, work.faces());
  const groupNames = new Set<string>();
  const groups: {
    tag?: string;
    faces: number;
    closed: boolean;
    volume: number;
    sources: string[];
  }[] = [];
  for (const [k, comp] of components.entries()) {
    const sources = new Set<string>();
    for (const f of comp) {
      for (let t = 0; t < work.tagNames.length; t++) {
        if (work.hasTag(f, t)) sources.add(work.tagNames[t] as string);
      }
    }
    let tag: string | undefined;
    if (preserveTagged && prefix !== undefined) {
      tag = [...sources].find((s) => s.startsWith(prefix));
      if (tag !== undefined) groupNames.add(tag);
    } else if (prefix !== undefined) {
      tag = `${prefix}${k}`;
      groupNames.add(tag);
      const t = work.tagIndex(tag, true);
      for (const f of comp) work.addTag(f, t);
    }
    groups.push({
      ...(tag === undefined ? {} : { tag }),
      faces: comp.length,
      closed: closed(work, comp),
      volume: facesVolume(work, comp),
      sources: [...sources].filter((s) => !groupNames.has(s)).sort(),
    });
  }

  const tris = exportTriangles(work);
  const quality = quadMetrics(work, work.faces());
  const distance = hausdorff(soup(shell), soup(work));
  const signed = signedDeviation(soup(work), soup(shell));
  const views: number[] = [];
  if (options.silhouette !== undefined) {
    const subject = encodeSnapshot(work);
    const reference = encodeSnapshot(input);
    for (const view of options.silhouette.views) {
      const iou = silhouetteIoU(subject, view, reference);
      if (!iou.ok) return iou;
      views.push(iou.value.iou);
    }
  }
  const maxPlanarity = (options.quads === false ? undefined : options.quads?.maxPlanarity) ?? 0.02;
  const issues: Issue<LowpolyIssueCode>[] = [];
  const warn = (code: LowpolyIssueCode, detail: Record<string, unknown>) =>
    issues.push({ code, severity: 'warn', detail });
  for (const [k, g] of groups.entries()) {
    if (!g.closed || !(g.volume > 0)) warn('not-closed', { component: k, volume: g.volume });
  }
  if (distance.max > MAX_DEVIATION * scale) {
    warn('deviation', { hausdorff: distance.max, limit: MAX_DEVIATION * scale });
  }
  for (const [k, iou] of views.entries()) {
    if (iou < MIN_IOU) warn('silhouette', { view: k, iou, limit: MIN_IOU });
  }
  if (options.quads !== false) {
    if (quality.quadAreaRatio < MIN_QUAD_RATIO) {
      warn('quad-ratio', { quadAreaRatio: quality.quadAreaRatio, limit: MIN_QUAD_RATIO });
    }
    if (quality.planarityP99 > maxPlanarity) {
      warn('planarity', { planarityP99: quality.planarityP99, limit: maxPlanarity });
    }
  }
  if (quality.highValence > 0) warn('valence', { highValence: quality.highValence });
  if (tris > options.targetFaces) warn('over-budget', { tris, targetFaces: options.targetFaces });

  for (const d of inner) if (d.severity === 'warn') diagnostics.push(d);
  diagnostics.push({
    severity: 'info',
    message: `lowpoly: ${parts.length} part(s) -> ${groups.length} component(s), ${tris} tris`,
    detail: {
      pass: issues.length === 0,
      issues,
      union: unionOutcome.union,
      fallback: unionOutcome.union !== 'exact' && unionOutcome.exactError !== undefined,
      ...(unionOutcome.exactError === undefined ? {} : { exactError: unionOutcome.exactError }),
      ...(unionOutcome.voxelSize === undefined ? {} : { voxelSize: unionOutcome.voxelSize }),
      ...(unionOutcome.clusters === undefined ? {} : { clusters: unionOutcome.clusters }),
      ...(unionOutcome.lost === undefined ? {} : { lost: unionOutcome.lost }),
      parts: parts.length,
      partVolumes,
      components: groups,
      tris,
      quadAreaRatio: quality.quadAreaRatio,
      regularValence: quality.regularValence,
      highValence: quality.highValence,
      planarityP99: quality.planarityP99,
      hausdorff: distance.max,
      hausdorffMean: distance.mean,
      signed,
      ...(views.length === 0 ? {} : { iou: views }),
      simplify: info(inner, 'simplify'),
      ...(sliversOutcome === undefined ? {} : { slivers: sliversOutcome }),
    },
  });

  const removed = deleteFaces(mesh, faces);
  if (!removed.ok) return removed;
  const added = append(mesh, work, {}, NO_ATTRIBUTION);
  if (!added.ok) return added;
  return ok({ lowpoly: work.faceCount });
}
