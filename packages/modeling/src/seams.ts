import { err, ok, type Result } from '@forgeax/engine-types';
import { minOf, pushAll } from './arrays';
import { Heap } from './compute/chart-ts';
import { measureUv, uvSelfOverlaps } from './compute/uv-ts';
import { atan2, cos, hypot2 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { isRespectSharp, type NormalMode, shadingHard, UnionFind } from './finish';
import { dot, faceArea, faceCentroid, faceNormal, length, sub, type Tuple3 } from './geom';
import { EDGE_SEAM, EDGE_SHARP, type EditMesh, NONE } from './mesh';
import { copyPairedCorners, mirrorPairs } from './mirror-pairing';
import type { OpDiagnostic, RoleCounts } from './ops';
import type { EdgeSelector } from './selectors';
import { type UvContext, unwrapUv } from './uv';

export interface PlanSeamsOptions {
  /** Edges whose dihedral angle exceeds this many degrees are seams (default 75). */
  readonly hardAngle?: number;
  /** A face group (across soft edges) of at most this many faces gives up its angle-only seams toward a larger neighbor group (default 8; 0 keeps every hard edge). */
  readonly smallGroup?: number;
  /** Largest per-island L-infinity stretch the planner accepts before it cuts the island open (default 1.6). */
  readonly maxStretch?: number;
  /** Unwrap, measure and cut rounds before the planner gives up on the remaining islands (default 30). */
  readonly maxRounds?: number;
  /** Cone or tree-cotree cuts tried on an island before it is bisected (default 2). */
  readonly slitRounds?: number;
  /** Edges between two materials are seams (default true). */
  readonly materialBorders?: boolean;
  /** Edges between faces with different tag sets are seams (default true). */
  readonly tagBorders?: boolean;
  /**
   * Hard edges are seams too, so normal hardening and UV charts agree: `true` takes edges flagged
   * sharp, a `NormalMode` the edges its shading hardens (`edgeKinds` hard, e.g. autoSmooth
   * dihedrals) (default false). The thin-island merge never removes these seams: a hard edge with
   * continuous UVs cannot carry a baked normal map.
   */
  readonly respectSharp?: boolean | NormalMode;
  /** `'slim'`: SLIM-refine every unwrapped island (see `UnwrapOptions.refine`). */
  readonly refine?: 'slim';
  /**
   * Islands narrower than this many model units (mean width 2 * area / perimeter) or smaller than its
   * square in area are merged into the neighbor they share the longest border with, when the merged
   * island still unwraps within `maxStretch` without flips or overlap; a merged island with holes gets
   * one cut graph. Tag, material and angle seams give way; seams marked before the call and
   * `respectSharp` hard edges never do
   * (default 1.5 % of the bounding-box diagonal; 0 keeps every semantic island).
   */
  readonly minWidth?: number;
  /** `true`: only seams marked before the call define islands; angle, material and tag borders are ignored and measured cuts remain the safety net (default false). */
  readonly manual?: boolean;
  /** `true`: thin or small islands may also give up seams marked before the call (default false); the merge keeps its stretch and overlap bounds. */
  readonly mergeMarked?: boolean;
  /** Edges that become seams before planning, like seams marked by a patch network (source `patch`). */
  readonly force?: EdgeSelector;
  /** Edges the planner never cuts: no semantic, measured or arm cut uses them. A forbidden edge that is also forced or already marked is an error. */
  readonly forbid?: EdgeSelector;
  /** Edges cuts prefer to avoid: cone, tree-cotree and path cuts pay `avoidCost` times their length there. */
  readonly avoid?: EdgeSelector;
  /** Cost factor of an `avoid` edge (default 8). */
  readonly avoidCost?: number;
  /** Islands smaller than this area (model units squared) merge like thin ones (default `minWidth` squared). */
  readonly minArea?: number;
  /** Largest geodesic across an island (model units): longer islands are bisected and a merge never builds one (default unbounded). */
  readonly maxLength?: number;
  /**
   * `'mirrored'`: faces flagged `FACE_MIRRORED` that reflect an unflagged face across a coordinate
   * plane (the copies `mirror` makes, paired by position) are not planned; the original half is
   * planned alone and its seams are copied to the copies, with the mirror-plane edges as seams. The
   * copies take their partner's corners (moved aside), so `uv.pack({ stack: 'mirrored' })` can give
   * both halves one set of texels. A flagged face with no partner is planned like any other and
   * reported; `force`, `forbid` and `avoid` name edges of the original half (default `'unique'`).
   */
  readonly mirror?: 'unique' | 'mirrored';
}

/** Where a seam came from, strongest first: between equally long borders a merge gives up the last one first. */
export const SEAM_SOURCES = ['part', 'patch', 'feature', 'curvature'] as const;
export type SeamSourceKind = (typeof SEAM_SOURCES)[number];
const PART = 0;
const PATCH = 1;
const FEATURE = 2;
const CURVATURE = 3;
/** Cost factor that routes every cut around a forbidden edge while keeping the cost finite. */
const FORBID_COST = 1e6;
const AVOID_COST = 8;

/** Islands of at most this many faces are never cut for stretch: a sliver this small has no better layout. */
const MIN_CUT_FACES = 2;
/** Rounds of small-group absorption: giving up one seam can merge two groups below the limit. */
const ABSORB_ROUNDS = 3;
/** Smallest angle defect (radians) at which a disk island is worth a cone cut. */
const MIN_DEFECT = 0.05;
/** Face roles of a round or chamfer strip. */
const STRIP_ROLES = ['bevel', 'corner'] as const;
const COS_CREASE = cos(Math.PI / 4);
/** Default `minWidth` as a fraction of the bounding-box diagonal. */
const MIN_WIDTH_FRACTION = 0.015;
/** Rounds of batched island merging. */
const MERGE_ROUNDS = 6;
/** Perimeter squared over area above which an island is a strip (a 9:1 rectangle is 40; a square is 16). */
const MAX_ELONGATION = 40;
/** Cone cuts a merged island may take before the merge is given up. */
const MERGE_CUTS = 6;
/** Neighbors (longest shared border first) a thin island tries to merge into. */
const MERGE_TARGETS = 3;
/** A merged island may exceed `maxStretch` by this factor (1: a merge never trades distortion for fewer seams). */
const MERGE_SLACK = 1.0;
/** Raster cells across the minimum width when probing an unwrapped island for thin arms. */
const ARM_CELLS = 6;
/** An arm is a stretch of faces at least this many minimum widths long. */
const ARM_LENGTH = 5;

function facesOfRaw(mesh: EditMesh, e: number): [number, number] {
  return [mesh.hFace[e * 2] as number, mesh.hFace[e * 2 + 1] as number];
}

interface Island {
  readonly faces: readonly number[];
}

/**
 * The normal each face is judged by when an edge asks whether it is hard. A face made by a bevel
 * or round (role `bevel` or `corner`) belongs to the flat face its strip grew from: a breadth-first
 * sweep from the surrounding faces gives every strip face the nearest one, so a 90 degree round of
 * several 30 degree facets is one hard edge, cut through the middle of the strip, instead of none.
 */
function stripAnchors(
  mesh: EditMesh,
  faces: readonly number[],
  inPlan: ReadonlySet<number>,
  normal: readonly Tuple3[],
): Tuple3[] {
  const strip = new Set<number>();
  for (const role of STRIP_ROLES) {
    const r = mesh.roleNames.indexOf(role);
    if (r < 0) continue;
    for (const f of faces) if (mesh.fRole[f] === r) strip.add(f);
  }
  const anchor: Tuple3[] = [];
  let frontier: number[] = [];
  for (const f of faces) {
    if (!strip.has(f)) {
      anchor[f] = normal[f] as Tuple3;
      frontier.push(f);
    } else anchor[f] = undefined as unknown as Tuple3;
  }
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const f of frontier) {
      for (const h of mesh.faceHalves(f)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (g === NONE || !inPlan.has(g) || anchor[g] !== undefined) continue;
        anchor[g] = anchor[f] as Tuple3;
        next.push(g);
      }
    }
    frontier = next;
  }
  for (const f of faces) anchor[f] ??= normal[f] as Tuple3;
  return anchor;
}

/** `mirror: 'mirrored'`: plan the original half on a copy of the mesh, then write its seams and corners back and onto the paired copies. */
function planMirrored(
  mesh: EditMesh,
  faces: readonly number[],
  options: PlanSeamsOptions,
  context: UvContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const pairs = mirrorPairs(mesh, faces, context.tolerance);
  const inner: PlanSeamsOptions = { ...options, mirror: 'unique' };
  const copies = new Set(pairs.partner.keys());
  const done = (planned: Result<RoleCounts, ModelingError>) => {
    if (!planned.ok) return planned;
    diagnostics.push({
      severity: 'info',
      message: `uv.plan mirror: ${pairs.partner.size} copy face(s) follow their partner's seams and ${pairs.unpaired.length} flagged face(s) have no partner`,
      detail: {
        pairs: pairs.partner.size,
        unpaired: pairs.unpaired.length,
        asymmetric: pairs.asymmetric.length,
      },
    });
    if (pairs.unpaired.length > 0) {
      diagnostics.push({
        severity: 'warn',
        message: `uv.plan mirror: ${pairs.unpaired.length} mirrored face(s) reflect no unmirrored face (moved or edited after mirroring) and are planned on their own`,
        detail: { faces: pairs.unpaired.slice(0, 32) },
      });
    }
    return planned;
  };
  if (copies.size === 0) return done(planSeams(mesh, faces, inner, context, diagnostics));
  const half = mesh.clone();
  for (const f of copies) half.removeFace(f);
  const original = faces.filter((f) => !copies.has(f));
  const planned = planSeams(half, original, inner, context, diagnostics);
  if (!planned.ok) return planned;
  for (const e of half.edges()) {
    if ((half.hFace[e * 2] as number) === NONE || (half.hFace[e * 2 + 1] as number) === NONE) {
      continue;
    }
    const flags = (mesh.eFlags[e] as number) & ~EDGE_SEAM;
    mesh.eFlags[e] = flags | ((half.eFlags[e] as number) & EDGE_SEAM);
  }
  for (const f of original) {
    for (const h of mesh.faceHalves(f)) {
      const value = half.corner('uv0', h);
      if (value !== undefined) mesh.setCorner('uv0', h, value);
    }
  }
  const inSet = new Set(faces);
  for (const c of [...copies].sort((a, b) => a - b)) {
    for (const h of mesh.faceHalves(c)) {
      const other = mesh.hFace[h ^ 1] as number;
      if (other === NONE || !inSet.has(other)) continue;
      const image = copies.has(other) ? pairs.edgeImage(h) : undefined;
      const seam = image === undefined || ((mesh.eFlags[image] as number) & EDGE_SEAM) !== 0;
      const e = h >> 1;
      mesh.eFlags[e] = seam
        ? (mesh.eFlags[e] as number) | EDGE_SEAM
        : (mesh.eFlags[e] as number) & ~EDGE_SEAM;
    }
  }
  copyPairedCorners(mesh, pairs, original, 'uv0');
  return done(ok({ planned: faces.length, seams: planned.value.seams ?? 0 }));
}

/**
 * Seam planner. Seams come from the surface's semantics first (marked seams, material and tag
 * borders, edges sharper than `hardAngle`), then from measurement: every island is unwrapped
 * and each one whose stretch exceeds `maxStretch` (or that flips, collapses or overlaps itself) is cut open
 * along a geodesic cone cut or a tree-cotree cut graph, and only the changed islands are
 * unwrapped again. The measurement loop is a safety net; the semantic seams do the work.
 * Seams are written as `markSeam` intent; the island layouts are left unpacked.
 */
export function planSeams(
  mesh: EditMesh,
  faces: readonly number[],
  options: PlanSeamsOptions,
  context: UvContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  if (
    options.mirror !== undefined &&
    options.mirror !== 'unique' &&
    options.mirror !== 'mirrored'
  ) {
    return err(
      modelingError('model-invalid-argument', "mirror is 'unique' or 'mirrored'", {
        mirror: options.mirror,
      }),
    );
  }
  if (options.mirror === 'mirrored')
    return planMirrored(mesh, faces, options, context, diagnostics);
  const hardAngle = options.hardAngle ?? 75;
  const smallGroup = options.smallGroup ?? 8;
  const maxStretch = options.maxStretch ?? 1.6;
  const maxRounds = options.maxRounds ?? 30;
  const slitRounds = options.slitRounds ?? 2;
  const manual = options.manual === true;
  let diagonal = 0;
  if (faces.length > 0) {
    const lo: number[] = [Infinity, Infinity, Infinity];
    const hi: number[] = [-Infinity, -Infinity, -Infinity];
    for (const f of faces) {
      for (const v of mesh.faceVertices(f)) {
        const p = mesh.position(v);
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a] as number, p[a] as number);
          hi[a] = Math.max(hi[a] as number, p[a] as number);
        }
      }
    }
    diagonal = length(sub(hi as unknown as Tuple3, lo as unknown as Tuple3));
  }
  const minWidth = options.minWidth ?? MIN_WIDTH_FRACTION * diagonal;
  const minArea = options.minArea ?? minWidth * minWidth;
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  const avoidCost = options.avoidCost ?? AVOID_COST;
  if (options.respectSharp !== undefined && !isRespectSharp(options.respectSharp)) {
    return err(
      modelingError('model-invalid-argument', 'respectSharp is a boolean or a NormalMode', {
        respectSharp: options.respectSharp,
      }),
    );
  }
  for (const [name, value, min] of [
    ['hardAngle', hardAngle, 0],
    ['smallGroup', smallGroup, 0],
    ['maxStretch', maxStretch, 1],
    ['maxRounds', maxRounds, 0],
    ['slitRounds', slitRounds, 0],
    ['minWidth', minWidth, 0],
    ['minArea', minArea, 0],
    ['avoidCost', avoidCost, 1],
  ] as const) {
    if (!Number.isFinite(value) || value < min) {
      return err(
        modelingError('model-invalid-argument', `${name} is a finite number of at least ${min}`, {
          [name]: value,
        }),
      );
    }
  }
  if (!(maxLength > 0)) {
    return err(
      modelingError('model-invalid-argument', 'maxLength is a positive number', { maxLength }),
    );
  }
  const edgeSet = (name: string, selector: EdgeSelector | undefined) => {
    if (selector === undefined) return ok(new Set<number>());
    if (selector.domain !== 'edge') {
      return err(
        modelingError('model-invalid-argument', `${name} is an edge selector`, {
          [name]: selector.description,
        }),
      );
    }
    const found = selector.resolve(mesh);
    return found.ok ? ok(new Set(found.value)) : found;
  };
  const forced = edgeSet('force', options.force);
  if (!forced.ok) return forced;
  const forbidden = edgeSet('forbid', options.forbid);
  if (!forbidden.ok) return forbidden;
  const avoided = edgeSet('avoid', options.avoid);
  if (!avoided.ok) return avoided;
  const forbid = forbidden.value;
  const avoid = avoided.value;
  const inPlan = new Set(faces);
  const edges = mesh.edges().filter((e) => facesOfRaw(mesh, e).some((f) => inPlan.has(f)));
  const normal: Tuple3[] = [];
  for (const f of faces) normal[f] = faceNormal(mesh, f);
  const anchor = stripAnchors(mesh, faces, inPlan, normal);
  const facesOf = (e: number) => facesOfRaw(mesh, e);
  const interior = edges.filter((e) => facesOf(e).every((f) => f !== NONE && inPlan.has(f)));
  const cosHard = cos((hardAngle * Math.PI) / 180);

  const interiorSet = new Set(interior);
  for (const e of forbid) {
    if (
      forced.value.has(e) ||
      (interiorSet.has(e) && ((mesh.eFlags[e] as number) & EDGE_SEAM) !== 0)
    ) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a forbidden edge is also forced or already a seam',
          {
            code: 'conflict',
            edge: e,
          },
        ),
      );
    }
  }
  const snapshot = forbid.size > 0 ? mesh.clone() : undefined;
  const restore = (): void => {
    if (snapshot !== undefined) mesh.assign(snapshot);
  };
  for (const e of [...forced.value].sort((a, b) => a - b)) {
    if (interiorSet.has(e)) mesh.eFlags[e] = (mesh.eFlags[e] as number) | EDGE_SEAM;
  }
  const origin = new Uint8Array(mesh.halfHighWater >> 1);
  const mandatory = new Uint8Array(mesh.halfHighWater >> 1);
  const angular = new Uint8Array(mesh.halfHighWater >> 1);
  const sameTags = (f: number, g: number) => {
    for (let w = 0; w < mesh.tagWords; w++) {
      if (mesh.fTags[f * mesh.tagWords + w] !== mesh.fTags[g * mesh.tagWords + w]) return false;
    }
    return true;
  };
  const explicit = new Set<number>();
  const hard = new Set<number>();
  for (const e of interior) {
    const flags = mesh.eFlags[e] as number;
    const [f, g] = facesOf(e);
    const sharp =
      (options.respectSharp === true && (flags & EDGE_SHARP) !== 0) ||
      (typeof options.respectSharp === 'object' && shadingHard(mesh, e, options.respectSharp));
    if ((flags & EDGE_SEAM) !== 0) {
      mandatory[e] = 1;
      origin[e] = PATCH;
      explicit.add(e);
      if (sharp) hard.add(e);
    } else if (manual || forbid.has(e)) {
    } else if (
      ((options.materialBorders ?? true) && mesh.fMaterial[f] !== mesh.fMaterial[g]) ||
      ((options.tagBorders ?? true) && !sameTags(f, g))
    ) {
      mandatory[e] = 1;
      origin[e] = PART;
      if (sharp) hard.add(e);
    } else if (sharp) {
      mandatory[e] = 1;
      origin[e] = FEATURE;
      hard.add(e);
    } else if (dot(anchor[f] as Tuple3, anchor[g] as Tuple3) < cosHard - 1e-12) {
      angular[e] = 1;
      origin[e] = FEATURE;
    }
  }
  for (let round = 0; round < ABSORB_ROUNDS && smallGroup > 0 && !manual; round++) {
    const groups = new UnionFind(mesh.faceHighWater);
    for (const e of interior) {
      if (mandatory[e] === 0 && angular[e] === 0) {
        const [f, g] = facesOf(e);
        groups.union(f, g);
      }
    }
    const size = new Map<number, number>();
    for (const f of faces) size.set(groups.find(f), (size.get(groups.find(f)) ?? 0) + 1);
    let freed = 0;
    for (const e of interior) {
      if (angular[e] === 0) continue;
      const [f, g] = facesOf(e);
      const a = size.get(groups.find(f)) as number;
      const b = size.get(groups.find(g)) as number;
      if (Math.min(a, b) <= smallGroup && Math.max(a, b) > smallGroup) {
        angular[e] = 0;
        freed++;
      }
    }
    if (freed === 0) break;
  }
  const seamed = (e: number) => ((mesh.eFlags[e] as number) & EDGE_SEAM) !== 0;
  const mark = (ids: Iterable<number>, source: number = CURVATURE): number => {
    let n = 0;
    for (const e of ids) {
      if (!seamed(e)) {
        mesh.eFlags[e] = (mesh.eFlags[e] as number) | EDGE_SEAM;
        origin[e] = source;
        n++;
      }
    }
    return n;
  };
  const planned = interior.filter((e) => mandatory[e] === 1 || angular[e] === 1);
  const removable = new Set(
    planned.filter((e) => !hard.has(e) && (options.mergeMarked === true || !explicit.has(e))),
  );
  let semantic = 0;
  for (const e of planned) {
    if (!seamed(e)) {
      mesh.eFlags[e] = (mesh.eFlags[e] as number) | EDGE_SEAM;
      semantic++;
    }
  }

  const vertexEdges: number[][] = Array.from({ length: mesh.vertexHighWater }, () => []);
  for (const e of edges) for (const v of mesh.edgeVertices(e)) (vertexEdges[v] as number[]).push(e);
  const edgeLength = (e: number) => {
    const [a, b] = mesh.edgeVertices(e);
    return length(sub(mesh.position(a), mesh.position(b)));
  };
  /** Cut cost: edge length, up to 5x on near-flat edges so cuts follow creases. */
  const cutCost = (e: number) => {
    const [f, g] = facesOf(e);
    const c = dot(normal[f] as Tuple3, normal[g] as Tuple3);
    const flat = Math.max(0, Math.min(1, (c - COS_CREASE) / (1 - COS_CREASE)));
    const factor = forbid.has(e) ? FORBID_COST : avoid.has(e) ? avoidCost : 1;
    return edgeLength(e) * (1 + 4 * flat) * factor;
  };
  const other = (e: number, v: number) => {
    const [a, b] = mesh.edgeVertices(e);
    return a === v ? b : a;
  };

  const islandsOf = (): Island[] => {
    const groups = new UnionFind(mesh.faceHighWater);
    for (const e of interior) {
      if (!seamed(e)) {
        const [f, g] = facesOf(e);
        groups.union(f, g);
      }
    }
    const byRoot = new Map<number, number[]>();
    for (const f of faces) {
      const r = groups.find(f);
      const list = byRoot.get(r);
      if (list === undefined) byRoot.set(r, [f]);
      else list.push(f);
    }
    return [...byRoot.values()].map((list) => ({ faces: list }));
  };

  /** Dijkstra over `allowed` edges from `sources`; the path to the nearest vertex of `targets`, or none. */
  const shortest = (
    sources: Iterable<number>,
    targets: ReadonlySet<number>,
    allowed: ReadonlySet<number>,
  ): number[] => {
    const dist = new Map<number, number>();
    const via = new Map<number, [number, number]>();
    const heap = new Heap();
    for (const s of sources) {
      dist.set(s, 0);
      heap.push(0, s);
    }
    let hit = NONE;
    while (heap.size > 0) {
      const [d, v] = heap.pop();
      if (d > (dist.get(v) as number)) continue;
      if (targets.has(v) && d > 0) {
        hit = v;
        break;
      }
      for (const e of vertexEdges[v] as number[]) {
        if (!allowed.has(e)) continue;
        const w = other(e, v);
        const nd = d + cutCost(e);
        if (nd < (dist.get(w) ?? Number.POSITIVE_INFINITY)) {
          dist.set(w, nd);
          via.set(w, [v, e]);
          heap.push(nd, w);
        }
      }
    }
    const path: number[] = [];
    for (let v = hit; v !== NONE && via.has(v); ) {
      const [p, e] = via.get(v) as [number, number];
      path.push(e);
      v = p;
    }
    return path;
  };

  /** Interior vertex of the largest angle defect (the cone singularity) of an island, or NONE. */
  const coneVertex = (island: Island, boundary: ReadonlySet<number>): number => {
    const sum = new Map<number, number>();
    for (const f of island.faces) {
      const vs = mesh.faceVertices(f);
      const p = vs.map((v) => mesh.position(v));
      for (let i = 0; i < vs.length; i++) {
        const prev = p[(i + vs.length - 1) % vs.length] as Tuple3;
        const here = p[i] as Tuple3;
        const next = p[(i + 1) % vs.length] as Tuple3;
        const a = sub(prev, here);
        const b = sub(next, here);
        const cx = a[1] * b[2] - a[2] * b[1];
        const cy = a[2] * b[0] - a[0] * b[2];
        const cz = a[0] * b[1] - a[1] * b[0];
        const angle = atan2(length([cx, cy, cz]), dot(a, b));
        sum.set(vs[i] as number, (sum.get(vs[i] as number) ?? 0) + angle);
      }
    }
    let best = MIN_DEFECT;
    let found = NONE;
    for (const [v, s] of sum) {
      if (boundary.has(v)) continue;
      const defect = Math.abs(2 * Math.PI - s);
      if (defect > best) {
        best = defect;
        found = v;
      }
    }
    return found;
  };

  const cuttable = (e: number) => !forbid.has(e);
  const cutOpen = (island: Island): number[] => {
    const members = new Set(island.faces);
    const inner = new Set<number>();
    const boundary = new Set<number>();
    const loopEdges: number[] = [];
    for (const e of edges) {
      const fs = facesOf(e).filter((f) => f !== NONE && members.has(f));
      if (fs.length === 0) continue;
      if (fs.length === 2 && !seamed(e)) inner.add(e);
      else {
        loopEdges.push(e);
        for (const v of mesh.edgeVertices(e)) boundary.add(v);
      }
    }
    const loops = new UnionFind(mesh.vertexHighWater);
    for (const e of loopEdges) {
      const [a, b] = mesh.edgeVertices(e);
      loops.union(a, b);
    }
    const loopCount = new Set([...boundary].map((v) => loops.find(v))).size;
    if (loopCount <= 1) {
      const cone = coneVertex(island, boundary);
      return cone === NONE ? [] : shortest([cone], boundary, inner).filter(cuttable);
    }
    return treeCotree(island, boundary, inner).filter(cuttable);
  };

  /** Shortest-path forest from the boundary plus a maximum-weight dual cotree: the leftover edges and their tree paths cut a multiply-connected island to a disk. */
  const treeCotree = (
    island: Island,
    boundary: ReadonlySet<number>,
    inner: ReadonlySet<number>,
  ): number[] => {
    const dist = new Map<number, number>();
    const parent = new Map<number, [number, number]>();
    const heap = new Heap();
    for (const v of boundary) {
      dist.set(v, 0);
      heap.push(0, v);
    }
    while (heap.size > 0) {
      const [d, v] = heap.pop();
      if (d > (dist.get(v) as number)) continue;
      for (const e of vertexEdges[v] as number[]) {
        if (!inner.has(e)) continue;
        const w = other(e, v);
        const nd = d + cutCost(e);
        if (nd < (dist.get(w) ?? Number.POSITIVE_INFINITY)) {
          dist.set(w, nd);
          parent.set(w, [v, e]);
          heap.push(nd, w);
        }
      }
    }
    const tree = new Set([...parent.values()].map(([, e]) => e));
    const seen = new Set<number>([island.faces[0] as number]);
    const cotree = new Set<number>();
    const dual = new Heap();
    const push = (f: number) => {
      for (const h of mesh.faceHalves(f)) {
        const e = h >> 1;
        if (inner.has(e) && !tree.has(e)) dual.push(-cutCost(e), h);
      }
    };
    push(island.faces[0] as number);
    while (dual.size > 0) {
      const [, h] = dual.pop();
      const to = mesh.hFace[h ^ 1] as number;
      if (seen.has(to)) continue;
      seen.add(to);
      cotree.add(h >> 1);
      push(to);
    }
    const out = new Set<number>();
    const done = new Set<number>();
    for (const e of [...inner].sort((a, b) => a - b)) {
      if (tree.has(e) || cotree.has(e)) continue;
      out.add(e);
      for (let v of mesh.edgeVertices(e)) {
        while (parent.has(v) && !done.has(v)) {
          done.add(v);
          const [p, te] = parent.get(v) as [number, number];
          out.add(te);
          v = p;
        }
      }
    }
    return [...out];
  };

  /** The two ends of an island's longest centroid geodesic with the distances from each, so one pass serves bisection and the length bound. */
  const spine = (island: Island) => {
    const members = new Set(island.faces);
    const centroid = new Map<number, Tuple3>(island.faces.map((f) => [f, faceCentroid(mesh, f)]));
    const neighbors = (f: number): [number, number][] => {
      const out: [number, number][] = [];
      for (const h of mesh.faceHalves(f)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (g !== NONE && members.has(g) && !seamed(h >> 1)) out.push([g, h >> 1]);
      }
      return out;
    };
    const geodesic = (source: number) => {
      const dist = new Map<number, number>([[source, 0]]);
      const heap = new Heap();
      heap.push(0, source);
      while (heap.size > 0) {
        const [d, f] = heap.pop();
        if (d > (dist.get(f) as number)) continue;
        for (const [g] of neighbors(f)) {
          const nd = d + length(sub(centroid.get(f) as Tuple3, centroid.get(g) as Tuple3));
          if (nd < (dist.get(g) ?? Number.POSITIVE_INFINITY)) {
            dist.set(g, nd);
            heap.push(nd, g);
          }
        }
      }
      return dist;
    };
    const farthest = (dist: ReadonlyMap<number, number>) => {
      let best = -1;
      let at = island.faces[0] as number;
      for (const [f, d] of [...dist].sort((a, b) => a[0] - b[0])) {
        if (d > best) {
          best = d;
          at = f;
        }
      }
      return at;
    };
    const a = farthest(geodesic(island.faces[0] as number));
    const fromA = geodesic(a);
    const b = farthest(fromA);
    const fromB = geodesic(b);
    return { neighbors, fromA, fromB, length: fromA.get(b) ?? 0 };
  };
  const tooLong = (island: Island) =>
    maxLength < Number.POSITIVE_INFINITY &&
    island.faces.length > MIN_CUT_FACES &&
    spine(island).length > maxLength;

  /** Split an island across the middle of its longest geodesic: the fallback that always shortens it. */
  const bisect = (island: Island): number[] => {
    const { neighbors, fromA, fromB } = spine(island);
    const nearA = (f: number) =>
      (fromA.get(f) ?? Number.POSITIVE_INFINITY) <= (fromB.get(f) ?? Number.POSITIVE_INFINITY);
    const cut: number[] = [];
    for (const f of island.faces) {
      for (const [g, e] of neighbors(f))
        if (f < g && nearA(f) !== nearA(g) && cuttable(e)) cut.push(e);
    }
    return cut;
  };

  const unwrapOptions = {
    method: 'lscm',
    seams: 'marked',
    ...(options.refine === undefined ? {} : { refine: options.refine }),
  } as const;

  /** Unwrap `fs` and report whether every island they form is within `maxStretch` and free of flips and overlaps. */
  const unwrapsWell = (fs: readonly number[], limit: number): Result<boolean, ModelingError> => {
    const unwrapped = unwrapUv(mesh, fs, unwrapOptions, [], context, []);
    if (!unwrapped.ok) return unwrapped;
    const measured = measureUv(mesh);
    if (!measured.ok) return measured;
    const folded = uvSelfOverlaps(mesh);
    if (!folded.ok) return folded;
    for (const f of fs) {
      const id = measured.value.faceIsland[f] as number;
      const m = measured.value.islands[id];
      if (
        m === undefined ||
        !(m.stretchLinf <= limit) ||
        m.flipped > 0 ||
        m.zeroArea > 0 ||
        (folded.value[id] as number) > 0
      ) {
        return ok(false);
      }
    }
    return ok(true);
  };

  /**
   * Merge islands that are too thin or too small to be a chart of their own into the neighbor they
   * share the longest removable border with. A merge is kept only when the merged island unwraps
   * within `maxStretch` (a multiply-connected one first gets its cut graph); otherwise its seams
   * return. Seams marked by the caller are never removed.
   */
  let merged = 0;
  let pruned = 0;
  /** Mean width `2A / perimeter` under `minWidth`, or area under `minWidth` squared. */
  const isThin = (island: Island): boolean => {
    const inside = new Set(island.faces);
    let a = 0;
    let perimeter = 0;
    for (const f of island.faces) {
      a += faceArea(mesh, f);
      for (const h of mesh.faceHalves(f)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (g === NONE || !inside.has(g)) perimeter += edgeLength(h >> 1);
      }
    }
    return perimeter > 0 && ((2 * a) / perimeter < minWidth || a < minArea);
  };
  const mergeThin = (): Result<undefined, ModelingError> => {
    if ((minWidth <= 0 && minArea <= 0) || removable.size === 0) return ok(undefined);
    const limit = maxStretch * MERGE_SLACK;
    const area = new Map<number, number>();
    const blocked = new Set<number>();
    for (let round = 0; round < MERGE_ROUNDS; round++) {
      const all = islandsOf();
      const of = new Map<number, number>();
      all.forEach((island, i) => {
        for (const f of island.faces) of.set(f, i);
      });
      const stats = all.map((island, i) => {
        let a = 0;
        for (const f of island.faces) a += faceArea(mesh, f);
        let perimeter = 0;
        const shared = new Map<number, { length: number; weakest: number; edges: number[] }>();
        for (const f of island.faces) {
          for (const h of mesh.faceHalves(f)) {
            const g = mesh.hFace[h ^ 1] as number;
            if (g !== NONE && of.get(g) === i) continue;
            const e = h >> 1;
            const len = edgeLength(e);
            perimeter += len;
            if (g === NONE || !removable.has(e) || !seamed(e)) continue;
            const j = of.get(g) as number;
            const entry = shared.get(j) ?? { length: 0, weakest: PART, edges: [] };
            entry.length += len;
            entry.weakest = Math.max(entry.weakest, origin[e] as number);
            entry.edges.push(e);
            shared.set(j, entry);
          }
        }
        area.set(i, a);
        return { a, perimeter, width: perimeter > 0 ? (2 * a) / perimeter : Infinity, shared };
      });
      const candidates = stats
        .map((s, i) => ({ s, i }))
        .filter(
          ({ s, i }) =>
            (s.width < minWidth ||
              s.a < minArea ||
              (minWidth > 0 && s.perimeter * s.perimeter > MAX_ELONGATION * s.a)) &&
            s.shared.size > 0 &&
            !blocked.has(minOf((all[i] as Island).faces)),
        )
        .sort((x, y) => x.s.width - y.s.width || x.i - y.i);
      if (candidates.length === 0) break;
      let progress = 0;
      const taken = new Set<number>();
      for (const { s, i } of candidates) {
        if (taken.has(i)) continue;
        const order = [...s.shared]
          .filter(([j]) => !taken.has(j))
          .sort((x, y) => y[1].length - x[1].length || y[1].weakest - x[1].weakest || x[0] - y[0])
          .slice(0, MERGE_TARGETS);
        if (order.length === 0) continue;
        let done = false;
        for (const [target, entry] of order) {
          const fs = [...(all[i] as Island).faces, ...(all[target] as Island).faces];
          const gone = entry.edges;
          for (const e of gone) mesh.eFlags[e] = (mesh.eFlags[e] as number) & ~EDGE_SEAM;
          let added: number[] = [];
          let good = unwrapsWell(fs, limit);
          if (!good.ok) return good;
          for (let cut = 0; cut < MERGE_CUTS && !good.value; cut++) {
            const joined = islandsOf().find((isl) => isl.faces.includes(fs[0] as number)) as Island;
            const more = cutOpen(joined).filter((e) => !seamed(e));
            if (more.length === 0) break;
            mark(more);
            added = added.concat(more);
            good = unwrapsWell(fs, limit);
            if (!good.ok) return good;
          }
          if (good.value && maxLength < Number.POSITIVE_INFINITY) {
            const joined = islandsOf().find((isl) => isl.faces.includes(fs[0] as number)) as Island;
            if (tooLong(joined)) good = ok(false);
          }
          if (good.value) {
            for (const e of gone) removable.delete(e);
            for (const e of added) removable.add(e);
            semantic -= gone.length;
            merged++;
            progress++;
            taken.add(i);
            taken.add(target);
            done = true;
            break;
          }
          for (const e of added) mesh.eFlags[e] = (mesh.eFlags[e] as number) & ~EDGE_SEAM;
          for (const e of gone) mesh.eFlags[e] = (mesh.eFlags[e] as number) | EDGE_SEAM;
          const restored = unwrapsWell(fs, limit);
          if (!restored.ok) return restored;
        }
        if (!done) blocked.add(minOf((all[i] as Island).faces));
      }
      if (progress === 0) break;
    }
    return ok(undefined);
  };
  /**
   * Detach thin arms: faces of an island that fall outside its morphological opening by a disc of half
   * `minWidth` and that run at least `ARM_LENGTH` widths. A merge cannot absorb such a band into a wall, and left
   * attached it unfolds to a long spike beside a compact chart; cut off, the arm is a straight strip of its own.
   * A cut stays only when both parts unwrap within `maxStretch` without flips or overlap.
   */
  const pruneArms = (): Result<undefined, ModelingError> => {
    if (minWidth <= 0) return ok(undefined);
    const limit = maxStretch * MERGE_SLACK;
    const unwrapped = unwrapUv(mesh, faces, unwrapOptions, [], context, []);
    if (!unwrapped.ok) return unwrapped;
    for (const island of islandsOf()) {
      const arms = armsOf(island);
      for (const arm of arms) {
        const inArm = new Set(arm);
        const cut: number[] = [];
        for (const f of arm) {
          for (const h of mesh.faceHalves(f)) {
            const g = mesh.hFace[h ^ 1] as number;
            if (g !== NONE && !inArm.has(g) && !seamed(h >> 1) && inPlan.has(g) && cuttable(h >> 1))
              cut.push(h >> 1);
          }
        }
        if (cut.length === 0) continue;
        mark(cut);
        const fs = island.faces;
        const good = unwrapsWell(fs, limit);
        if (!good.ok) return good;
        if (good.value) {
          for (const e of cut) removable.add(e);
          semantic += cut.length;
          pruned++;
        } else {
          for (const e of cut) mesh.eFlags[e] = (mesh.eFlags[e] as number) & ~EDGE_SEAM;
          const restored = unwrapsWell(fs, limit);
          if (!restored.ok) return restored;
        }
      }
    }
    return ok(undefined);
  };

  /** Connected runs of faces outside the opening of `island`'s UV footprint, each long enough to be an arm. */
  const armsOf = (island: Island): number[][] => {
    interface P {
      readonly u: number;
      readonly v: number;
    }
    const tris: P[][] = [];
    let a3 = 0;
    let auv = 0;
    const centers = new Map<number, P>();
    for (const f of island.faces) {
      a3 += faceArea(mesh, f);
      const uv = mesh.faceHalves(f).map((h): P => {
        const c = mesh.corner('uv0', h) as ArrayLike<number>;
        return { u: c[0] as number, v: c[1] as number };
      });
      centers.set(f, {
        u: uv.reduce((q, c) => q + c.u, 0) / uv.length,
        v: uv.reduce((q, c) => q + c.v, 0) / uv.length,
      });
      const first = uv[0] as P;
      for (let k = 1; k + 1 < uv.length; k++) {
        const b = uv[k] as P;
        const c = uv[k + 1] as P;
        tris.push([first, b, c]);
        auv += Math.abs((b.u - first.u) * (c.v - first.v) - (c.u - first.u) * (b.v - first.v)) / 2;
      }
    }
    if (!(auv > 0) || !(a3 > 0)) return [];
    const scale = Math.sqrt(a3 / auv);
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    for (const t of tris) {
      for (const q of t) {
        u0 = Math.min(u0, q.u);
        v0 = Math.min(v0, q.v);
        u1 = Math.max(u1, q.u);
        v1 = Math.max(v1, q.v);
      }
    }
    const radius = ARM_CELLS / 2;
    const h = minWidth / ARM_CELLS / scale;
    const nx = Math.ceil((u1 - u0) / h) + 2 * radius + 1;
    const ny = Math.ceil((v1 - v0) / h) + 2 * radius + 1;
    if (nx * ny > 4e6) return [];
    const grid = new Uint8Array(nx * ny);
    for (const [a, b, c] of tris as [P, P, P][]) {
      const iLo = Math.floor((Math.min(a.u, b.u, c.u) - u0) / h) + radius;
      const iHi = Math.floor((Math.max(a.u, b.u, c.u) - u0) / h) + radius;
      const jLo = Math.floor((Math.min(a.v, b.v, c.v) - v0) / h) + radius;
      const jHi = Math.floor((Math.max(a.v, b.v, c.v) - v0) / h) + radius;
      for (let j = jLo; j <= jHi; j++) {
        for (let i = iLo; i <= iHi; i++) {
          const px = u0 + (i - radius + 0.5) * h;
          const py = v0 + (j - radius + 0.5) * h;
          const side = (p: P, q: P) => (q.u - p.u) * (py - p.v) - (q.v - p.v) * (px - p.u);
          const e0 = side(a, b);
          const e1 = side(b, c);
          const e2 = side(c, a);
          if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0))
            grid[j * nx + i] = 1;
        }
      }
    }
    const disc: number[] = [];
    for (let j = -radius; j <= radius; j++) {
      for (let i = -radius; i <= radius; i++)
        if (i * i + j * j <= radius * radius) disc.push(j * nx + i);
    }
    const morph = (source: Uint8Array, erode: boolean) => {
      const out = new Uint8Array(nx * ny);
      for (let j = radius; j < ny - radius; j++) {
        for (let i = radius; i < nx - radius; i++) {
          let hit = erode;
          for (const d of disc) {
            const set = source[j * nx + i + d] === 1;
            if (erode ? !set : set) {
              hit = !erode;
              break;
            }
          }
          out[j * nx + i] = hit ? 1 : 0;
        }
      }
      return out;
    };
    const open = morph(morph(grid, true), false);
    const armFaces = new Set<number>();
    for (const f of island.faces) {
      const c = centers.get(f) as P;
      const ci = Math.floor((c.u - u0) / h) + radius;
      const cj = Math.floor((c.v - v0) / h) + radius;
      if (open[cj * nx + ci] === 0) armFaces.add(f);
    }
    const out: number[][] = [];
    const seen = new Set<number>();
    for (const start of island.faces) {
      if (!armFaces.has(start) || seen.has(start)) continue;
      const run = [start];
      seen.add(start);
      for (let k = 0; k < run.length; k++) {
        for (const he of mesh.faceHalves(run[k] as number)) {
          const g = mesh.hFace[he ^ 1] as number;
          if (g === NONE || seen.has(g) || !armFaces.has(g) || seamed(he >> 1)) continue;
          seen.add(g);
          run.push(g);
        }
      }
      let lu = Infinity;
      let lv = Infinity;
      let hu = -Infinity;
      let hv = -Infinity;
      for (const f of run) {
        const c = centers.get(f) as P;
        lu = Math.min(lu, c.u);
        lv = Math.min(lv, c.v);
        hu = Math.max(hu, c.u);
        hv = Math.max(hv, c.v);
      }
      if (
        run.length < island.faces.length &&
        hypot2(hu - lu, hv - lv) * scale >= ARM_LENGTH * minWidth
      ) {
        out.push(run);
      }
    }
    return out;
  };

  const closed = islandsOf().filter((island) => {
    const members = new Set(island.faces);
    return island.faces.every((f) =>
      mesh.faceHalves(f).every((h) => {
        const g = mesh.hFace[h ^ 1] as number;
        return g !== NONE && members.has(g) && !seamed(h >> 1);
      }),
    );
  });
  const opened = closed.flatMap((island) => bisect(island));
  if (closed.length > 0 && opened.length === 0 && forbid.size > 0) {
    restore();
    return err(
      modelingError(
        'model-precondition',
        'a closed island needs a cut and every cut edge is forbidden',
        {
          code: 'forbid-closed',
          islands: closed.length,
        },
      ),
    );
  }
  const closedCuts = mark(opened.sort((a, b) => a - b));
  for (const e of opened) removable.add(e);

  const tries = new Map<number, number>();
  let dirty: readonly number[] = faces;
  let cuts = closedCuts;
  let islands = 0;
  let unresolved = 0;
  let stuck = false;
  let peak = 1;
  for (let round = 0; ; round++) {
    const unwrapped = unwrapUv(mesh, dirty, unwrapOptions, [], context, []);
    if (!unwrapped.ok) return unwrapped;
    const measured = measureUv(mesh);
    if (!measured.ok) return measured;
    const folded = uvSelfOverlaps(mesh);
    if (!folded.ok) return folded;
    const all = islandsOf();
    islands = all.length;
    peak = measured.value.stretchLinf;
    const long = new Set<Island>(all.filter((island) => tooLong(island)));
    const bad = all.filter((island) => {
      if (island.faces.length <= MIN_CUT_FACES) return false;
      if (long.has(island)) return true;
      const id = measured.value.faceIsland[island.faces[0] as number] as number;
      const m = measured.value.islands[id];
      if (m === undefined) return false;
      return (
        m.stretchLinf > maxStretch ||
        m.flipped > 0 ||
        m.zeroArea > 0 ||
        (folded.value[id] as number) > 0
      );
    });
    unresolved = bad.length;
    if (bad.length === 0 || round === maxRounds) break;
    const next: number[] = [];
    const added = new Set<number>();
    for (const island of bad) {
      const key = minOf(island.faces);
      const n = (tries.get(key) ?? 0) + 1;
      tries.set(key, n);
      const cut = n > slitRounds || long.has(island) ? bisect(island) : cutOpen(island);
      if (cut.length === 0) continue;
      for (const e of cut) added.add(e);
      pushAll(next, island.faces);
    }
    if (added.size === 0) {
      stuck = true;
      break;
    }
    cuts += mark([...added].sort((a, b) => a - b));
    for (const e of added) removable.add(e);
    dirty = next;
  }
  if (stuck && forbid.size > 0) {
    restore();
    return err(
      modelingError(
        'model-precondition',
        'an island exceeds maxStretch or maxLength and every cut that would split it is forbidden',
        { code: 'forbid-unresolved', unresolved, forbidden: forbid.size },
      ),
    );
  }
  const mergedOk = mergeThin();
  if (!mergedOk.ok) return mergedOk;
  const prunedOk = pruneArms();
  if (!prunedOk.ok) return prunedOk;
  const sources = Object.fromEntries(SEAM_SOURCES.map((name) => [name, 0])) as Record<
    SeamSourceKind,
    number
  >;
  for (const e of interior)
    if (seamed(e)) sources[SEAM_SOURCES[origin[e] as number] as SeamSourceKind]++;
  const finalIslands = islandsOf();
  islands = finalIslands.length;
  const thin =
    minWidth > 0 || minArea > 0 ? finalIslands.filter((island) => isThin(island)).length : 0;
  if (unresolved > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `uv.plan: ${unresolved} island(s) still exceed maxStretch ${maxStretch} or maxLength${stuck ? ' and no cut applies to them' : ` after ${maxRounds} round(s)`}; raise maxStretch, maxLength or maxRounds, or mark seams that cut them`,
      detail: { unresolved, stuck, maxRounds },
    });
  }
  diagnostics.push({
    severity: 'info',
    message: `uv.plan: ${semantic} semantic seam(s), ${merged} merge(s) of thin or small islands, ${pruned} thin arm(s) detached and ${cuts} stretch cut(s) made ${islands} island(s), worst stretch ${peak.toPrecision(3)}${thin > 0 ? `, ${thin} island(s) still thinner than minWidth ${minWidth.toPrecision(3)}` : ''}`,
    detail: {
      semantic,
      merged,
      pruned,
      cuts,
      islands,
      unresolved,
      stretchLinf: peak,
      thin,
      sources,
    },
  });
  return ok({ planned: faces.length, seams: semantic + cuts });
}
