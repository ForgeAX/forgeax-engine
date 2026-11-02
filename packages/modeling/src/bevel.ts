import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import {
  cornersMatch,
  partitionRegion,
  planeFrame,
  project,
  regionBoundary,
  regionHolds,
} from './bevel-region';
import { patchPositions, patchTopology, roundProfile } from './bevel-shape';
import { type ModelingError, modelingError } from './errors';
import {
  add,
  cross,
  dot,
  faceCentroid,
  length,
  newell,
  normalize,
  scale,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { contactPairs, crossingDiagnostic, faceContacts, pairKey } from './intersect';
import { EDGE_SEAM, EDGE_SHARP, type EditMesh, FACE_EDGE_ROUND, NONE } from './mesh';
import {
  type Attribution,
  type OpDiagnostic,
  type RoleCounts,
  requirePositive,
  requireSegments,
  setEdgeFlags,
} from './ops';
import { attributeKey } from './planar';
import { type CornerSource, type FaceRewrite, rewriteFaces } from './rewrite';

export interface BevelOptions {
  /** Distance of the new edges from the bevelled edge, measured in each adjacent face. */
  readonly width: number;
  /** 1 = flat chamfer; more = a round profile tangent to both faces. */
  readonly segments: number;
}

/** Face roles of a bevel's strips and of its corner caps: edge treatment, not panel skin. */
export const BEVEL_ROLES = ['bevel', 'corner'] as const;
const MAX_SEGMENTS = 64;
/** Share of every edge a bevel leaves, so moved points never meet or cross. */
const KEEP = 0.02;
/** A point slides along an edge only where the offset line crosses it at this sine or more. */
const MIN_SINE = 0.05;
/**
 * Bevelled edges whose offset lines meet at this cosine or more (inward normals within
 * about 53 degrees) clamp together: their corner point moves by the width difference over
 * the sine of the angle, so unequal widths along a smooth chain (a hole rim) would throw it
 * far across the face.
 */
const SMOOTH_COSINE = 0.6;
/** Faces whose normals are within about 11 degrees of a bevelled face continue its offset line. */
const CONTINUED_COSINE = 0.98;
/** Faces whose unit normals differ by less than this (1 - cos, about 0.08 degrees) are coplanar. */
const FLAT_COSINE = 1e-6;
/**
 * Faces bent so little that the corner point, placed in one of them, leaves the other's plane
 * by at most this many model tolerances also share a slot (a triangulated cell of a curved
 * skin): apart, each would slide the point along their shared diagonal by its own offset line.
 */
const BENT_TOLERANCE = 5;
/** A planar region keeps its vertices within this many model tolerances of one plane. */
const PLANAR_TOLERANCE = 5;
/** Share of the narrower face's UV width by which joined faces' UV maps may differ. */
const VALUE_FOLD = 0.02;
/** Bevelled edges at a vertex from which its corners may use only half of each edge. */
const HIGH_VALENCE = 5;
/** Width-halving rounds for faces that fold or cross after the fill; the last accepts crossings. */
const MAX_ROUNDS = 16;
/** Clamped and degenerate edges listed in diagnostics. */
const LIST_LIMIT = 16;

/** Position as `base + sum(width[e] * terms[e])` over bevelled edges `e`. */
interface Linear {
  readonly base: Tuple3;
  readonly terms: ReadonlyMap<number, Tuple3>;
}

/**
 * A point of the result: an existing vertex kept in place, a point placed by the
 * widths (corner or slide), or a profile/patch point placed by shape.
 */
interface Node {
  id: number;
  pos: Tuple3;
  readonly lin?: Linear;
  readonly vertex?: number;
  /** Ends of the unbevelled edge a sliding point runs along. */
  readonly along?: readonly [number, number];
}

type Link =
  | { readonly kind: 'edge'; readonly half: number }
  | { readonly kind: 'face'; readonly slot: number };

interface Profile {
  readonly half: number;
  /** From the side of face(half ^ 1) to the side of face(half), ends included. */
  readonly nodes: Node[];
  /** Halves whose strips share this chain (two at a pass-through vertex). */
  readonly halves: readonly number[];
  /** Face whose plane the chain lies in, when the chain borders it (terminator). */
  readonly plane?: number;
  /** Centre of the round arc, once placed. */
  center?: Tuple3;
}

/** The edges and faces around one affected vertex, in rotation order. */
interface Fan {
  readonly v: number;
  /** Outgoing halves; the face between halves i and i + 1 is face(halves[i]). */
  readonly halves: readonly number[];
  readonly closed: boolean;
  readonly bevelled: readonly boolean[];
  readonly slots: number;
  /** First face of each slot. */
  readonly slotFaces: readonly number[];
  /** Every face around v, including those merged into a slot across flat edges. */
  readonly faces: readonly number[];
  /** Pairs of bevelled edges meeting at a corner point at a shallow angle (one chain). */
  readonly smooth: readonly (readonly [number, number])[];
  /** Flat edges merged into a slot whose corner point leaves their line (planar regions). */
  readonly dissolve: readonly number[];
  /** Flat edges merged into a slot whose corner point stays on their line (they shorten). */
  readonly slide: readonly number[];
  /** Per unbevelled half: its sliding point, or the kept vertex. */
  readonly point: (Node | undefined)[];
  /** Per face slot: the corner point when both its edges at v are bevelled. */
  readonly corner: (Node | undefined)[];
  /** Boundary points in rotation order and the links after each. */
  nodes: Node[];
  links: Link[];
  /** Face id -> its corner chain at v, in face loop order. */
  readonly chains: Map<number, Node[]>;
}

function linear(base: Tuple3, terms: Iterable<readonly [number, Tuple3]> = []): Linear {
  const map = new Map<number, Tuple3>();
  for (const [e, t] of terms) map.set(e, add(map.get(e) ?? [0, 0, 0], t));
  return { base, terms: map };
}

function evaluate(lin: Linear, widths: ReadonlyMap<number, number>): Tuple3 {
  let p = lin.base;
  for (const [e, t] of lin.terms) p = add(p, scale(t, widths.get(e) ?? 0));
  return p;
}

function unit(a: Tuple3, b: Tuple3): Tuple3 {
  return normalize(sub(b, a));
}

function faceNormalOf(mesh: EditMesh, f: number): Tuple3 {
  return normalize(newell(mesh.faceVertices(f).map((v) => mesh.position(v))));
}

function edgeEnds(mesh: EditMesh, e: number): { from: Tuple3; to: Tuple3 } {
  const [a, b] = mesh.edgeVertices(e);
  return { from: mesh.position(a), to: mesh.position(b) };
}

/** Outgoing halves of `v` in rotation order, or undefined at a pinched vertex. */
function walkFan(
  mesh: EditMesh,
  outgoing: readonly number[],
): { halves: number[]; closed: boolean } | undefined {
  const open = outgoing.find((o) => (mesh.hFace[o ^ 1] as number) === NONE);
  const start = open ?? (outgoing[0] as number);
  const halves = [start];
  let o = start;
  while ((mesh.hFace[o] as number) !== NONE) {
    const next = (mesh.hPrev[o] as number) ^ 1;
    if (next === start) break;
    if (halves.length >= outgoing.length) return undefined;
    halves.push(next);
    o = next;
  }
  if (halves.length !== outgoing.length) return undefined;
  return { halves, closed: open === undefined };
}

/**
 * Bevel interior edges (design 8, P1a). Every selected edge becomes a strip of
 * `segments` faces (role `bevel`) between two new edges, each `width` from the edge
 * inside one adjacent face. All geometry is computed first,
 * then the touched faces are disconnected, the new points placed and the gaps filled.
 *
 * Around each vertex of a selected edge, an unbevelled edge gets a point sliding
 * along it (open fans keep the vertex where no bevel reaches); the points form the
 * corner's boundary. One bevelled edge ends there (terminator): a three-edge corner
 * cuts the far face, more edges leave an n-gon corner face. Two bevelled edges pass
 * through (their strips share the end chain). Three or more leave a corner face
 * (role `corner`): a triangle or quad patch for round three- and four-edge corners,
 * otherwise one n-gon. Non-planar new faces are split into triangles.
 *
 * Coplanar faces split only by flat edges (holed caps cut into convex pieces or strips)
 * are bevelled as one planar region and partitioned again. Widths are clamped so every
 * edge keeps KEEP of its length and no touched face or region inverts or stops being
 * simple; a written face that still folds, or a bevel face that crosses another, halves
 * the widths that place it (the wider ones toward the narrowest while they differ) and the
 * fill repeats. Clamped edges and their actual widths are reported in diagnostics. A
 * selected boundary edge is `model-precondition`. Effect assertion
 * (hard): every selected edge is replaced by faces of non-zero area.
 */
export function bevel(
  mesh: EditMesh,
  selected: readonly number[],
  options: BevelOptions,
  attribution: Attribution,
  material: number | undefined,
  tolerance: number,
  diagnostics: OpDiagnostic[],
  created?: Map<string, number[]>,
  /**
   * Per-edge widths (each > 0) overriding `options.width`, which stays their largest, and
   * roles of their strips (default `bevel`); a corner whose edges share a role takes it.
   */
  perEdge?: ReadonlyMap<number, { readonly width: number; readonly role?: string }>,
): Result<RoleCounts, ModelingError> {
  const width = requirePositive('width', options.width);
  if (!width.ok) return width;
  const requested = (e: number) => perEdge?.get(e)?.width ?? options.width;
  const segmentsOk = requireSegments('segments', options.segments, 1);
  if (!segmentsOk.ok) return segmentsOk;
  if (options.segments > MAX_SEGMENTS) {
    return err(
      modelingError('model-invalid-argument', `segments is at most ${MAX_SEGMENTS}`, {
        segments: options.segments,
      }),
    );
  }
  const n = options.segments;
  const edges = [...new Set(selected)].sort((a, b) => a - b);
  const bevelled = new Set(edges);
  const boundary = edges.filter((e) => mesh.isBoundaryEdge(e));
  if (boundary.length > 0) {
    return err(
      modelingError(
        'model-precondition',
        'every bevelled edge has a face on both sides',
        {
          boundaryEdges: boundary.length,
          at: boundary.slice(0, LIST_LIMIT).map((e) => edgeEnds(mesh, e)),
        },
        'deselect open boundary edges (for example with .minus(sel.edges.meshBoundary())), or close the hole first',
      ),
    );
  }
  const folded = edges.filter((e) => mesh.hFace[e * 2] === mesh.hFace[e * 2 + 1]);
  if (folded.length > 0) {
    return err(
      modelingError('model-precondition', 'every bevelled edge separates two different faces', {
        edges: folded.length,
      }),
    );
  }
  const affected = new Set<number>();
  for (const e of edges) for (const v of mesh.edgeVertices(e)) affected.add(v);
  const outgoing = new Map<number, number[]>();
  for (const e of mesh.edges()) {
    for (const h of [e * 2, e * 2 + 1]) {
      const v = mesh.hVert[h] as number;
      if (!affected.has(v)) continue;
      const list = outgoing.get(v) ?? [];
      list.push(h);
      outgoing.set(v, list);
    }
  }
  const normals = new Map<number, Tuple3>();
  const normal = (f: number): Tuple3 => {
    let nf = normals.get(f);
    if (nf === undefined) {
      nf = faceNormalOf(mesh, f);
      normals.set(f, nf);
    }
    return nf;
  };
  const fixedNodes = new Map<number, Node>();
  const fixed = (v: number): Node => {
    let node = fixedNodes.get(v);
    if (node === undefined) {
      const p = mesh.position(v);
      node = { id: v, pos: p, lin: linear(p), vertex: v };
      fixedNodes.set(v, node);
    }
    return node;
  };

  // ---- 1. compute: fans, sliding and corner points as linear forms of the widths ----
  const fans = new Map<number, Fan>();
  for (const v of [...affected].sort((a, b) => a - b)) {
    const walked = walkFan(
      mesh,
      (outgoing.get(v) ?? []).sort((a, b) => a - b),
    );
    if (walked === undefined) {
      return err(
        modelingError(
          'model-precondition',
          'every bevelled edge ends at a manifold vertex (one fan of faces)',
          { vertex: mesh.position(v) },
          'split or weld the pinched vertex first',
        ),
      );
    }
    const fan = buildFan(mesh, v, walked, bevelled, normal, fixed, requested, tolerance);
    if (!fan.ok) return fan;
    fans.set(v, fan.value);
  }
  const profiles = new Map<string, Profile>();
  const profileKey = (v: number, e: number) => `${v}/${e}`;
  const caps: Fan[] = [];
  for (const fan of fans.values()) {
    linkFan(fan, n, profiles, profileKey);
    if (fan.closed && fan.nodes.length >= 3) caps.push(fan);
  }

  // ---- material and tag inference (before any change) ----
  const sameMaterial = (faces: readonly number[]) =>
    faces.every((f) => mesh.fMaterial[f] === mesh.fMaterial[faces[0] as number]);
  if (material === undefined) {
    const mixed =
      edges.filter(
        (e) => !sameMaterial([mesh.hFace[e * 2] as number, mesh.hFace[e * 2 + 1] as number]),
      ).length + caps.filter((fan) => !sameMaterial(fanFaces(fan))).length;
    if (mixed > 0) {
      return err(
        modelingError(
          'model-invalid-argument',
          'the faces around each bevel use one material slot, or `material` names the slot',
          { mixed },
          'pass `material` to choose the slot of the bevel faces',
        ),
      );
    }
  }

  // ---- planar regions: coplanar faces joined across flat edges that only partition them ----
  const touched = [...new Set([...fans.values()].flatMap((fan) => fanFaces(fan)))].sort(
    (a, b) => a - b,
  );
  const chainOf = (f: number, v: number): Node[] => fans.get(v)?.chains.get(f) ?? [fixed(v)];
  const flatEnd = (v: number, e: number) => {
    const fan = fans.get(v);
    if (fan === undefined) return 'free';
    return fan.dissolve.includes(e) ? 'free' : 'held';
  };
  const joined = new Set<number>();
  for (const fan of fans.values()) {
    for (const e of fan.dissolve) {
      if (mesh.edgeVertices(e).every((v) => flatEnd(v, e) === 'free')) joined.add(e);
    }
  }
  const regions = planarRegions(mesh, touched, joined, chainOf, normal, tolerance);
  const inRegion = new Set(regions.flatMap((region) => region.faces));

  // ---- 2. clamp the widths so every touched face keeps its edges, orientation and shape ----
  const chain = chains(
    edges,
    [...fans.values()].flatMap((fan) => fan.smooth),
  );
  const constraints: { readonly length: number; readonly k: Map<number, number> }[] = [];
  /** Shape checks: a sound face or region keeps its orientation and stays simple. */
  const checks: {
    readonly terms: ReadonlySet<number>;
    holds(w: ReadonlyMap<number, number>): boolean;
  }[] = regions.map((region) => ({
    terms: region.terms,
    holds: (w) => {
      if (!region.sound) return true;
      const loops = region.loops.map((loop) =>
        project(
          loop
            .filter(({ node }) => node.lin !== undefined)
            .map(({ node }) => evaluate(node.lin as Linear, w)),
          region.frame,
        ),
      );
      return regionHolds(loops, region.signs, tolerance * tolerance);
    },
  }));
  for (const f of touched) {
    const loop: Node[] = [];
    for (const h of mesh.faceHalves(f)) {
      const a = mesh.hVert[h] as number;
      const b = mesh.hVert[mesh.hNext[h] as number] as number;
      pushAll(
        loop,
        chainOf(f, a).filter((node) => node.lin !== undefined),
      );
      if (joined.has(h >> 1)) continue;
      const from = chainOf(f, a).at(-1) as Node;
      const to = chainOf(f, b)[0] as Node;
      const pa = mesh.position(a);
      const pb = mesh.position(b);
      const t = unit(pa, pb);
      const k = new Map<number, number>();
      for (const [e, term] of from.lin?.terms ?? []) k.set(e, (k.get(e) ?? 0) + dot(term, t));
      for (const [e, term] of to.lin?.terms ?? []) k.set(e, (k.get(e) ?? 0) - dot(term, t));
      const l = length(sub(pb, pa));
      constraints.push({ length: l, k });
      if (bevelled.has(h >> 1)) {
        // Offset overlap: at a vertex joining many bevelled edges, each corner may use
        // half of the edge it runs along, so a sharp apex cannot run down its whole side.
        for (const [node, v, sign] of [
          [from, a, 1],
          [to, b, -1],
        ] as const) {
          const fan = fans.get(v);
          if (fan === undefined || fan.bevelled.filter(Boolean).length < HIGH_VALENCE) continue;
          const half = new Map<number, number>();
          for (const [e, term] of node.lin?.terms ?? []) {
            half.set(e, (half.get(e) ?? 0) + sign * dot(term, t));
          }
          constraints.push({ length: l / 2, k: half });
        }
      }
    }
    if (inRegion.has(f)) continue;
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    const before = newell(points);
    const sound = simple(points, tolerance);
    checks.push({
      terms: new Set(loop.flatMap((node) => [...(node.lin?.terms.keys() ?? [])])),
      holds: (w) => {
        if (!sound) return true;
        const moved = loop.map((node) => evaluate(node.lin as Linear, w));
        return dot(newell(moved), before) > 0 && simple(moved, tolerance);
      },
    });
  }
  const keeps = (w: ReadonlyMap<number, number>, k: ReadonlyMap<number, number>, l: number) => {
    let retract = 0;
    for (const [e, c] of k) retract += c * (w.get(e) as number);
    return retract <= l * (1 - KEEP) ? 0 : retract;
  };
  // Uniform floor: one scale of all widths that every constraint accepts (faces return to
  // their input shape as the scale shrinks), so the per-edge clamp never collapses below it.
  const uniform = (s: number) => new Map(edges.map((e) => [e, requested(e) * s] as const));
  let scaleFloor = 1;
  const full = uniform(1);
  for (const { length: l, k } of constraints) {
    const retract = keeps(full, k, l);
    if (retract > 0) scaleFloor = Math.min(scaleFloor, (l * (1 - KEEP)) / retract);
  }
  for (let i = 0; i < 64; i++) {
    const at = uniform(scaleFloor);
    if (checks.every((check) => check.holds(at))) break;
    scaleFloor *= 0.5;
  }
  const floorWidth = (e: number) => requested(e) * scaleFloor;
  const clamp = (widths: Map<number, number>, floor: (e: number) => number): void => {
    const scaleChains = (involved: Iterable<number>, factor: number) => {
      const members = new Set<number>();
      for (const e of involved) for (const x of chain.get(e) as number[]) members.add(x);
      for (const e of members) {
        widths.set(e, Math.max(floor(e), (widths.get(e) as number) * factor));
      }
    };
    const above = (e: number) => (widths.get(e) as number) > floor(e);
    for (let pass = 0; pass < 64; pass++) {
      let changed = false;
      for (const { length: l, k } of constraints) {
        const retract = keeps(widths, k, l);
        if (retract === 0) continue;
        const involved = [...k].filter(([e, c]) => c !== 0 && above(e)).map(([e]) => e);
        if (involved.length === 0) continue;
        scaleChains(involved, (l * (1 - KEEP)) / retract);
        changed = true;
      }
      for (const check of checks) {
        if (check.holds(widths)) continue;
        const involved = [...check.terms].filter(above);
        if (involved.length === 0) continue;
        scaleChains(involved, 0.5);
        changed = true;
      }
      if (!changed) break;
    }
    const valid =
      constraints.every(({ length: l, k }) => keeps(widths, k, l) === 0) &&
      checks.every((check) => check.holds(widths));
    if (!valid) for (const e of edges) widths.set(e, Math.min(widths.get(e) as number, floor(e)));
  };
  const widths = new Map(edges.map((e) => [e, requested(e)] as const));
  clamp(widths, floorWidth);

  // ---- 3-5. place, fill and check; faces that fold or cross shrink their widths ----
  const backup = mesh.clone();
  // Face pairs already in contact (overlapping bodies of an assembly, faces touching within
  // the tolerance) may cross at any width, so only crossings the bevel creates shrink it.
  // Measured on the unchanged backup, and only once a fill crosses something.
  let metBefore: ReadonlySet<string> | undefined;
  const metBeforeBevel = (): ReadonlySet<string> => {
    metBefore ??= contactPairs(backup, new Set(touched), tolerance);
    return metBefore;
  };
  const allNodes = (capLoops: ReadonlyMap<Fan, Node[][]>) => {
    const out = new Set<Node>();
    for (const fan of fans.values()) {
      for (const chain of fan.chains.values()) for (const node of chain) out.add(node);
      for (const node of fan.nodes) out.add(node);
    }
    for (const profile of profiles.values()) for (const node of profile.nodes) out.add(node);
    for (const loops of capLoops.values())
      for (const loop of loops) for (const node of loop) out.add(node);
    return out;
  };
  const collapsedError = (collapsed: readonly number[]) =>
    modelingError(
      'model-degenerate',
      'the clamped bevel width stays above the model tolerance on every edge',
      {
        width: options.width,
        edges: collapsed.length,
        at: collapsed.slice(0, LIST_LIMIT).map((e) => edgeEnds(backup, e)),
      },
      'reduce width, or bevel the crowded edges in a separate call',
    );
  for (let round = 0; ; round++) {
    const collapsed = edges.filter((e) => (widths.get(e) as number) <= tolerance);
    if (collapsed.length > 0) {
      mesh.assign(backup);
      return err(collapsedError(collapsed));
    }
    const built = fill(round === MAX_ROUNDS);
    if (built.ok) {
      const clamped = edges.filter((e) => (widths.get(e) as number) < requested(e) * (1 - 1e-9));
      if (clamped.length > 0) {
        const actual = clamped.map((e) => widths.get(e) as number);
        diagnostics.push({
          severity: 'warn',
          message: `${clamped.length} of ${edges.length} bevelled edge(s) were clamped below width ${options.width} (smallest ${minOf(actual)}) so no face inverts, folds or crosses`,
          detail: {
            requested: options.width,
            clamped: clamped.length,
            minWidth: minOf(actual),
            edges: clamped
              .slice(0, LIST_LIMIT)
              .map((e) => ({ ...edgeEnds(backup, e), width: widths.get(e) as number })),
          },
        });
      }
      pushAll(diagnostics, built.value.diagnostics);
      if (created !== undefined) {
        for (const [role, faces] of built.value.created) {
          created.set(role, [...(created.get(role) ?? []), ...faces]);
        }
      }
      return ok(built.value.counts);
    }
    mesh.assign(backup);
    if (built.error.shrink === undefined) return err(built.error.cause);
    const before = new Map(widths);
    const members = new Set<number>();
    for (const e of built.error.shrink) for (const x of chain.get(e) as number[]) members.add(x);
    // A crossing between faces placed by unequal widths depends on their ratio, not their
    // scale (round profiles from one corner point to ends a narrow strip apart), so halving
    // all of them never resolves it: the wider widths first halve toward the narrowest.
    const least = minOf([...members].map((e) => widths.get(e) as number));
    const even = [...members].every((e) => (widths.get(e) as number) <= least * (1 + 1e-9));
    for (const e of members) {
      const w = widths.get(e) as number;
      widths.set(e, even ? w * 0.5 : Math.max(least, w * 0.5));
    }
    clamp(widths, (e) => Math.min(floorWidth(e), before.get(e) as number, widths.get(e) as number));
  }

  /** One placement and fill at the current widths; `final` fails instead of shrinking. */
  function fill(final: boolean): Result<
    {
      counts: RoleCounts;
      diagnostics: OpDiagnostic[];
      created: Map<string, number[]>;
    },
    { cause: ModelingError; shrink?: ReadonlySet<number> }
  > {
    const notes: OpDiagnostic[] = [];
    const made = new Map<string, number[]>();
    for (const fan of fans.values()) {
      for (const node of [...fan.nodes, ...fan.point, ...fan.corner]) {
        if (node?.lin !== undefined) node.pos = evaluate(node.lin, widths);
      }
    }
    for (const profile of profiles.values()) {
      const nodes = profile.nodes;
      const x = nodes[0] as Node;
      const y = nodes.at(-1) as Node;
      // A shared chain is stored once per strip; place it from its first owner only.
      if (x === y || n === 1 || profile.half !== profile.halves[0]) continue;
      const [h0, h1] = [profile.halves[0] as number, profile.halves[1]];
      let nx = normal(backup.hFace[h0 ^ 1] as number);
      let ny = normal(backup.hFace[h0] as number);
      if (h1 !== undefined) {
        nx = add(nx, normal(backup.hFace[h1] as number));
        ny = add(ny, normal(backup.hFace[h1 ^ 1] as number));
      }
      const { points, center } = roundProfile(x.pos, y.pos, nx, ny, n);
      if (center !== undefined) profile.center = center;
      for (let i = 1; i < n; i++) {
        let p = points[i] as Tuple3;
        if (profile.plane !== undefined) {
          const np = normal(profile.plane);
          p = sub(p, scale(np, dot(sub(p, x.pos), np)));
        }
        (nodes[i] as Node).pos = p;
      }
    }
    const capLoops = new Map(
      caps.map((fan) => [fan, capFaces(fan, n, profiles, profileKey)] as const),
    );

    // Effect assertion (hard): every selected edge is replaced by faces with area.
    const strips = edges.map((e) => ({
      e,
      loops: stripLoops(backup, e, n, profiles, profileKey),
    }));
    const lost = strips.filter(
      ({ loops }) =>
        loops.reduce((sum, loop) => sum + loopArea(loop.map((node) => node.pos)), 0) <=
        tolerance * tolerance,
    );
    if (lost.length > 0) {
      return err({
        cause: modelingError(
          'model-op-no-effect',
          'every selected edge is replaced by bevel faces of non-zero area',
          {
            edges: lost.length,
            at: lost.slice(0, LIST_LIMIT).map(({ e }) => edgeEnds(backup, e)),
          },
          'a bevel that ends at vertices with no room to slide collapses; select the whole edge chain or reduce width',
        ),
      });
    }

    // Disconnect, displace and fill.
    const nodes = allNodes(capLoops);
    for (const node of nodes) node.id = node.vertex ?? NONE;
    const parent = new Map<number, readonly [number, number]>();
    for (const node of nodes) {
      if (node.vertex !== undefined) continue;
      node.id = mesh.addVertex(...node.pos);
      if (node.along !== undefined) parent.set(node.id, node.along);
    }
    const rewrites: FaceRewrite[] = [];
    const placedBy: ReadonlySet<number>[] = [];
    for (const [f, check] of touched
      .filter((g) => !inRegion.has(g))
      .map((g, i) => [g, i] as const)) {
      const loop: CornerSource[] = [];
      for (const h of mesh.faceHalves(f)) {
        const v = mesh.hVert[h] as number;
        const fan = fans.get(v);
        if (fan === undefined) {
          loop.push({ v, corner: h });
          continue;
        }
        for (const node of fan.chains.get(f) as Node[]) {
          loop.push(node.vertex === v ? { v, corner: h } : cornerSource(mesh, h, node));
        }
      }
      rewrites.push({ face: f, loops: [loop] });
      placedBy.push((checks[regions.length + check] as (typeof checks)[number]).terms);
    }
    for (const region of regions) {
      const flat = region.loops.flat();
      const pieces = partitionRegion(
        region.loops.map((loop) =>
          project(
            loop.map(({ node }) => node.pos),
            region.frame,
          ),
        ),
        tolerance,
      );
      if (!pieces.ok) {
        return err({
          cause: modelingError(
            'model-degenerate',
            'every face the bevel writes is a simple polygon with positive area',
            { faces: region.faces.length, at: [faceCentroid(mesh, region.faces[0] as number)] },
          ),
          ...(final ? {} : { shrink: region.terms }),
        });
      }
      const source = ({ node, corner }: { node: Node; corner: number }): CornerSource => {
        const v = mesh.hVert[corner] as number;
        return node.vertex === v ? { v, corner } : cornerSource(mesh, corner, node);
      };
      for (const [i, f] of region.faces.entries()) {
        rewrites.push({
          face: f,
          loops:
            i === 0
              ? pieces.value.map((piece) =>
                  piece.map((k) => source(flat[k] as (typeof flat)[number])),
                )
              : [],
        });
        placedBy.push(region.terms);
      }
    }
    const rewritten = rewriteFaces(mesh, rewrites, parent);
    if (!rewritten.ok) return err({ cause: rewritten.error });
    /** Written face -> the bevelled edges whose widths place it. */
    const owners = new Map<number, ReadonlySet<number>>();
    /** Written face -> the input faces it comes from. */
    const origin = new Map<number, readonly number[]>();
    // Region pieces only shrink inside their input plane region, so new crossings with
    // them always involve another written face; the crossing check skips them as seeds.
    const pieces = new Set<number>();
    const firstRegionRewrite = rewrites.length - regions.reduce((n, r) => n + r.faces.length, 0);
    for (const [i, faces] of rewritten.value.entries()) {
      for (const g of faces) {
        owners.set(g, placedBy[i] as ReadonlySet<number>);
        origin.set(g, [(rewrites[i] as FaceRewrite).face]);
        if (i >= firstRegionRewrite) pieces.add(g);
      }
    }
    const counts: RoleCounts = {};
    const planarized = { faces: 0 };
    const addNew = (
      loop: readonly Node[],
      role: string,
      sources: readonly number[],
      by: ReadonlySet<number>,
    ) => {
      const ids = dedupe(loop.map((node) => node.id));
      if (ids.length < 3) return ok(undefined);
      for (const piece of planarize(mesh, ids, tolerance, planarized)) {
        const added = mesh.addFace(piece);
        if (!added.ok) return added;
        const g = added.value;
        owners.set(g, by);
        origin.set(g, sources);
        backup.copyFaceAttributesTo(sources[0] as number, mesh, g);
        mesh.fFlags[g] = (mesh.fFlags[g] as number) | FACE_EDGE_ROUND;
        mesh.fMaterial[g] = material ?? (backup.fMaterial[sources[0] as number] as number);
        mesh.fTags.fill(0, g * mesh.tagWords, (g + 1) * mesh.tagWords);
        for (let t = 0; t < backup.tagNames.length; t++) {
          if (sources.every((f) => backup.hasTag(f, t))) mesh.addTag(g, t);
        }
        if (attribution.tag >= 0) mesh.addTag(g, attribution.tag);
        mesh.fLabel[g] = attribution.label;
        mesh.fRole[g] = attribution.label === 0 ? 0 : mesh.nameIndex(mesh.roleNames, role);
        counts[role] = (counts[role] ?? 0) + 1;
        const list = made.get(role);
        if (list === undefined) made.set(role, [g]);
        else list.push(g);
      }
      return ok(undefined);
    };
    for (const { e, loops } of strips) {
      const sources = [backup.hFace[e * 2] as number, backup.hFace[e * 2 + 1] as number];
      const by = new Set([e]);
      for (const loop of loops) {
        for (const node of loop) for (const x of node.lin?.terms.keys() ?? []) by.add(x);
      }
      const role = perEdge?.get(e)?.role ?? BEVEL_ROLES[0];
      for (const loop of loops) {
        const added = addNew(loop, role, sources, by);
        if (!added.ok) return err({ cause: added.error });
      }
    }
    for (const [fan, loops] of capLoops) {
      const sources = fanFaces(fan);
      const by = new Set(fan.halves.filter((_, i) => fan.bevelled[i]).map((h) => h >> 1));
      const roles = new Set([...by].map((e) => perEdge?.get(e)?.role));
      const [shared] = roles;
      const role = roles.size === 1 && shared !== undefined ? shared : BEVEL_ROLES[1];
      for (const loop of loops) {
        const added = addNew(loop, role, sources, by);
        if (!added.ok) return err({ cause: added.error });
      }
    }
    for (const e of edges) {
      const flags = backup.eFlags[e] as number;
      if (flags === 0) continue;
      const ends = endProfiles(backup, e, profiles, profileKey);
      const set = (a: Node | undefined, b: Node | undefined, value: number) => {
        if (a !== undefined && b !== undefined && value !== 0) {
          setEdgeFlags(mesh, a.id, b.id, value);
        }
      };
      set(ends[0][0], ends[1][0], n === 1 ? flags : flags & EDGE_SEAM);
      if (n === 1) set(ends[0][1], ends[1][1], flags);
      for (const [i, v] of backup.edgeVertices(e).entries()) {
        const fan = fans.get(v) as Fan;
        const facing =
          fan.closed && fan.nodes.length === 2 && fan.links.some((l) => l.kind === 'face');
        if (n > 1 && !facing) continue;
        const end = ends[i] as Node[];
        for (let j = 0; j < n; j++) set(end[j], end[j + 1], flags & EDGE_SHARP);
      }
    }
    const used = new Set<number>();
    for (const f of mesh.faces()) for (const v of mesh.faceVertices(f)) used.add(v);
    for (const v of affected) if (!used.has(v)) mesh.removeVertex(v);

    // Postconditions: every written face is a simple polygon with area, and none crosses.
    const written = new Set(owners.keys());
    const shrink = (faces: Iterable<number>) => {
      const out = new Set<number>();
      for (const f of faces) for (const e of owners.get(f) ?? []) out.add(e);
      return out;
    };
    const broken = [...written].filter(
      (f) =>
        !simple(
          mesh.faceVertices(f).map((v) => mesh.position(v)),
          tolerance,
        ),
    );
    if (broken.length > 0) {
      return err({
        cause: modelingError(
          'model-degenerate',
          'every face the bevel writes is a simple polygon with positive area',
          {
            faces: broken.length,
            at: broken.slice(0, LIST_LIMIT).map((f) => faceCentroid(mesh, f)),
          },
          'a narrow face between bevelled edges folds over itself; reduce width or bevel fewer edges at once',
        ),
        ...(final ? {} : { shrink: shrink(broken) }),
      });
    }
    const seeds = new Set([...written].filter((f) => !pieces.has(f)));
    const crossings = faceContacts(mesh, Number.MAX_SAFE_INTEGER, tolerance, seeds).contacts.filter(
      (c) => c.contact === 'cross',
    );
    const fresh = crossings.filter((c) => {
      const [a, b] = c.faces.map((f) => origin.get(f) ?? [f]) as [number[], number[]];
      const met = metBeforeBevel();
      return !a.some((x) => b.some((y) => met.has(pairKey(x, y))));
    });
    if (fresh.length > 0) {
      const cause = modelingError(
        'model-degenerate',
        'no bevel face crosses another face',
        {
          pairs: fresh.length,
          at: fresh
            .slice(0, LIST_LIMIT)
            .map(({ faces: [a, b] }) =>
              scale(add(faceCentroid(mesh, a), faceCentroid(mesh, b)), 0.5),
            ),
        },
        'the bevel still crosses nearby geometry at the narrowest width it tries; move the parts apart near detail.at, or bevel fewer edges',
      );
      return err(final ? { cause } : { cause, shrink: shrink(fresh.flatMap((c) => c.faces)) });
    }
    if (crossings.length > 0) {
      const crossing = crossingDiagnostic(mesh, seeds, tolerance, 'bevel', crossings);
      if (crossing !== undefined) notes.push(crossing);
    }
    if (planarized.faces > 0) {
      notes.push({
        severity: 'info',
        message: `${planarized.faces} non-planar bevel face(s) were split into triangles`,
        detail: { faces: planarized.faces },
      });
    }
    if (mesh.channels.size > 0) {
      notes.push({
        severity: 'info',
        message: 'bevel and corner faces have no corner values (UVs); project them again',
        detail: { channels: [...mesh.channels.keys()] },
      });
    }
    return ok({ counts, diagnostics: notes, created: made });
  }
}

/** Sliding points, corner points and per-face corner chains of one affected vertex. */
function buildFan(
  mesh: EditMesh,
  v: number,
  walked: { readonly halves: number[]; readonly closed: boolean },
  selected: ReadonlySet<number>,
  normal: (f: number) => Tuple3,
  fixed: (v: number) => Node,
  /** Requested width of each bevelled edge. */
  requested: (e: number) => number,
  tolerance: number,
): Result<Fan, ModelingError> {
  const reach = Math.max(
    ...walked.halves.filter((h) => selected.has(h >> 1)).map((h) => requested(h >> 1)),
  );
  const { halves, groups, flats } = mergeFlat(
    mesh,
    walked,
    selected,
    normal,
    (bend) => bend * reach <= tolerance * BENT_TOLERANCE,
  );
  const slide = (form: ReadonlyMap<number, number>) => {
    let sum = 0;
    for (const [e, c] of form) sum += c * requested(e);
    return sum;
  };
  const closed = walked.closed;
  const m = halves.length;
  const slots = closed ? m : m - 1;
  const bevelled = halves.map((h) => selected.has(h >> 1));
  const p = mesh.position(v);
  const far = (i: number) => mesh.position(mesh.hVert[(halves[i] as number) ^ 1] as number);
  const face = (i: number) => mesh.hFace[halves[i % m] as number] as number;
  const edgeOf = (i: number) => (halves[((i % m) + m) % m] as number) >> 1;
  /** Inward unit normal, inside face slot i, of its outgoing (i) or incoming (i + 1) edge. */
  const inward = (i: number, outgoing: boolean): Tuple3 => {
    const d = outgoing ? unit(p, far(i)) : unit(far((i + 1) % m), p);
    return normalize(cross(normal(face(i)), d));
  };
  const corner: (Node | undefined)[] = [];
  const smooth: [number, number][] = [];
  for (let i = 0; i < slots; i++) {
    if (!(bevelled[i] && bevelled[(i + 1) % m])) {
      corner.push(undefined);
      continue;
    }
    const io = inward(i, true);
    const ii = inward(i, false);
    const c = dot(io, ii);
    const det = 1 - c * c;
    if (det < 1e-6 && c < 0) {
      return err(
        modelingError('model-degenerate', 'no face folds back on itself at a bevelled corner', {
          vertex: p,
          face: face(i),
        }),
      );
    }
    const terms: [number, Tuple3][] =
      det < 1e-6
        ? [
            [edgeOf(i), scale(io, 0.5)],
            [edgeOf(i + 1), scale(ii, 0.5)],
          ]
        : [
            [edgeOf(i), scale(sub(io, scale(ii, c)), 1 / det)],
            [edgeOf(i + 1), scale(sub(ii, scale(io, c)), 1 / det)],
          ];
    corner.push({ id: NONE, pos: p, lin: linear(p, terms) });
    if (c > SMOOTH_COSINE) smooth.push([edgeOf(i), edgeOf(i + 1)]);
  }
  // Slide distance along each unbevelled edge, as a linear form of the widths.
  const distance: (Map<number, number> | undefined)[] = halves.map((_, i) => {
    if (bevelled[i]) return undefined;
    const t = unit(p, far(i));
    const candidates: Map<number, number>[] = [];
    const before = (i - 1 + m) % m;
    if ((closed || i >= 1) && bevelled[before]) {
      const s = dot(t, inward(before, true));
      if (s > MIN_SINE) candidates.push(new Map([[edgeOf(before), 1 / s]]));
    }
    if (i < slots && bevelled[(i + 1) % m]) {
      const s = dot(t, inward(i, false));
      if (s > MIN_SINE) candidates.push(new Map([[edgeOf(i + 1), 1 / s]]));
    }
    return candidates.length === 0 ? undefined : mean(candidates);
  });
  if (closed && m > 2) {
    // An edge past a flat edge (a triangulated cell beside the bevel) slides to where the
    // offset line, continued across the faces near its plane, crosses it; other edges no
    // offset line reaches slide like the reachable edges of their run.
    for (let i = 0; i < m; i++) {
      if (bevelled[i] || distance[i] !== undefined) continue;
      const t = unit(p, far(i));
      const continued: Map<number, number>[] = [];
      const run: Map<number, number>[] = [];
      for (const step of [1, -1]) {
        const crossed: number[] = [];
        let reached = false;
        for (let j = i + step, k = 0; k < m; j += step, k++) {
          const at = ((j % m) + m) % m;
          const slot = step > 0 ? (at - 1 + m) % m : at;
          crossed.push(face(slot));
          if (bevelled[at]) {
            const plane = normal(face(slot));
            const s = dot(t, inward(slot, step < 0));
            if (s > MIN_SINE && crossed.every((f) => dot(normal(f), plane) >= CONTINUED_COSINE)) {
              continued.push(new Map([[edgeOf(at), 1 / s]]));
            }
            break;
          }
          const d = distance[at];
          if (d !== undefined && !reached) {
            run.push(d);
            reached = true;
          }
        }
      }
      const bevels = halves.filter((_, j) => bevelled[j]).map((h) => h >> 1);
      const like = run.length > 0 ? mean(run) : new Map(bevels.map((e) => [e, 1 / bevels.length]));
      // The continued line is the actual crossing; it replaces the run's slide only where
      // that would run off the edge (a cell's diagonal much shorter than its side).
      const room = length(sub(far(i), p)) * (1 - KEEP);
      const crossing = continued.length > 0 ? mean(continued) : undefined;
      distance[i] =
        crossing !== undefined && slide(like) > room && slide(crossing) <= room ? crossing : like;
    }
  }
  const kept = fixed(v);
  const point = halves.map((h, i): Node | undefined => {
    if (bevelled[i]) return undefined;
    const d = distance[i];
    if (d === undefined) return kept;
    const t = unit(p, far(i));
    return {
      id: NONE,
      pos: p,
      lin: linear(
        p,
        [...d].map(([e, c]) => [e, scale(t, c)] as const),
      ),
      along: [v, mesh.hVert[h ^ 1] as number],
    };
  });
  const chains = new Map<number, Node[]>();
  for (let i = 0; i < slots; i++) {
    const j = (i + 1) % m;
    let chain: Node[];
    if (bevelled[i] && bevelled[j]) chain = [corner[i] as Node];
    else if (bevelled[i]) chain = [point[j] as Node];
    else if (bevelled[j]) chain = [point[i] as Node];
    else
      chain = closed
        ? [point[j] as Node, point[i] as Node]
        : [point[j] as Node, kept, point[i] as Node];
    const nodes = dedupe(chain);
    for (const f of groups[i] as number[]) chains.set(f, nodes);
  }
  const slotFaces = Array.from({ length: slots }, (_, i) => face(i));
  return ok({
    v,
    halves,
    closed,
    bevelled,
    slots,
    slotFaces,
    faces: groups.slice(0, slots).flat(),
    smooth,
    ...flatEnds(mesh, v, flats, corner),
    point,
    corner,
    nodes: [],
    links: [],
    chains,
  });
}

/**
 * Drop the flat edges of a fan that only partition a plane between two bevelled
 * edges: unbevelled, unflagged edges between coplanar faces of one material, in a run
 * of such edges bounded by bevelled edges (holed caps are cut into convex pieces or
 * strips through the hole). Those faces then share one slot: the corner point the
 * bevel derives for the whole plane becomes the end of every flat edge, so slits and
 * partition diagonals neither clamp the width nor leave corner faces. Other operators'
 * faces are untouched; the merge exists only inside this computation. Faces bent by less
 * than `slight` admits (a triangulated cell of a curved skin) share the slot too, but keep
 * their edge: it slides with the corner point instead of dissolving.
 */
function mergeFlat(
  mesh: EditMesh,
  walked: { readonly halves: number[]; readonly closed: boolean },
  selected: ReadonlySet<number>,
  normal: (f: number) => Tuple3,
  /** Does a bend (angle between face normals, radians) leave the faces flat enough to merge? */
  slight: (bend: number) => boolean,
): { halves: number[]; groups: number[][]; flats: number[][] } {
  const all = walked.halves;
  const m = all.length;
  const bevelled = all.map((h) => selected.has(h >> 1));
  const faceOf = (i: number) => mesh.hFace[all[i] as number] as number;
  const single = { halves: all, groups: all.map((_, i) => [faceOf(i)]), flats: all.map(() => []) };
  if (!walked.closed || bevelled.filter(Boolean).length < 2) return single;
  const bent = all.map(() => false);
  const flat = all.map((h, i) => {
    if (bevelled[i] || (mesh.eFlags[h >> 1] as number) !== 0) return false;
    const a = mesh.hFace[h] as number;
    const b = mesh.hFace[h ^ 1] as number;
    if (a === NONE || b === NONE || a === b || attributeKey(mesh, a) !== attributeKey(mesh, b)) {
      return false;
    }
    const c = dot(normal(a), normal(b));
    if (c <= 1 - FLAT_COSINE) {
      bent[i] = true;
      if (!slight(Math.sqrt(Math.max(0, 2 * (1 - c))))) return false;
    }
    return cornersMatch(mesh, h);
  });
  const merged = all.map(() => false);
  const start = bevelled.indexOf(true);
  for (let k = 1, run: number[] = []; k <= m; k++) {
    const i = (start + k) % m;
    if (!bevelled[i]) {
      run.push(i);
      continue;
    }
    if (run.length > 0 && run.every((j) => flat[j])) for (const j of run) merged[j] = true;
    run = [];
  }
  if (!merged.includes(true)) return single;
  // Keep the walked rotation; a merged face joins the slot of the kept half before it.
  const halves: number[] = [];
  const groups: number[][] = [];
  const flats: number[][] = [];
  for (let i = 0; i < m; i++) {
    if (merged[i]) continue;
    halves.push(all[i] as number);
    const group = [faceOf(i)];
    const flat: number[] = [];
    for (let j = (i + 1) % m; merged[j]; j = (j + 1) % m) {
      group.push(faceOf(j));
      // A bent pair shares the corner point but keeps its edge: joined, it would not be planar.
      if (!bent[j]) flat.push(all[j] as number);
    }
    groups.push(group);
    flats.push(flat);
  }
  return { halves, groups, flats };
}

/** Split the merged flat edges at v by whether the slot's corner point stays on their line. */
function flatEnds(
  mesh: EditMesh,
  v: number,
  flats: readonly (readonly number[])[],
  corner: readonly (Node | undefined)[],
): { dissolve: number[]; slide: number[] } {
  const dissolve: number[] = [];
  const slide: number[] = [];
  const p = mesh.position(v);
  for (const [i, run] of flats.entries()) {
    const terms = corner[i]?.lin?.terms;
    if (terms === undefined) continue;
    let d: Tuple3 = [0, 0, 0];
    for (const t of terms.values()) d = add(d, t);
    const dir = normalize(d);
    for (const h of run) {
      const t = unit(p, mesh.position(mesh.hVert[h ^ 1] as number));
      const on = dot(dir, t) > 0 && length(cross(dir, t)) < 1e-9;
      (on ? slide : dissolve).push(h >> 1);
    }
  }
  return { dissolve, slide };
}

interface Region {
  readonly faces: number[];
  /** Boundary loops: each point with the face corner (boundary half) it replaces. */
  readonly loops: { readonly node: Node; readonly corner: number }[][];
  readonly frame: readonly [Tuple3, Tuple3];
  readonly signs: number[];
  readonly terms: ReadonlySet<number>;
  /** The input region is a valid polygon with holes (only then is its shape checked). */
  readonly sound: boolean;
}

/**
 * Faces joined across `joined` edges, with their boundary loops. A group whose boundary
 * pinches leaves its edges unjoined, so its faces are rewritten one by one.
 */
function planarRegions(
  mesh: EditMesh,
  touched: readonly number[],
  joined: Set<number>,
  chainOf: (f: number, v: number) => Node[],
  normal: (f: number) => Tuple3,
  tolerance: number,
): Region[] {
  const root = new Map(touched.map((f) => [f, f] as const));
  const find = (f: number): number => {
    let r = f;
    while (root.get(r) !== r) r = root.get(r) as number;
    root.set(f, r);
    return r;
  };
  // Neighbours within FLAT_COSINE can still bend a long chain of faces (walls along a
  // curve) out of one plane: a group stays within the face planarity tolerance of its root.
  const members = new Map(touched.map((f) => [f, mesh.faceVertices(f)] as const));
  const flat = (r: number, vertices: readonly number[]) => {
    const n = normal(r);
    const origin = mesh.position(mesh.faceVertices(r)[0] as number);
    return vertices.every(
      (v) => Math.abs(dot(sub(mesh.position(v), origin), n)) <= tolerance * PLANAR_TOLERANCE,
    );
  };
  for (const e of [...joined].sort((a, b) => a - b)) {
    const a = find(mesh.hFace[e * 2] as number);
    const b = find(mesh.hFace[e * 2 + 1] as number);
    if (a === b) continue;
    const [keep, join] = a < b ? [a, b] : [b, a];
    const vertices = [...(members.get(keep) ?? []), ...(members.get(join) ?? [])];
    if (
      !flat(keep, vertices) ||
      !sameValueMap(mesh, mesh.hFace[e * 2] as number, mesh.hFace[e * 2 + 1] as number, normal)
    ) {
      joined.delete(e);
      continue;
    }
    root.set(join, keep);
    members.set(keep, vertices);
  }
  const groups = new Map<number, number[]>();
  for (const f of touched) {
    const list = groups.get(find(f)) ?? [];
    list.push(f);
    groups.set(find(f), list);
  }
  const regions: Region[] = [];
  for (const faces of groups.values()) {
    if (faces.length < 2) continue;
    const boundary = regionBoundary(mesh, faces, joined);
    if (boundary === undefined) {
      for (const f of faces) for (const h of mesh.faceHalves(f)) joined.delete(h >> 1);
      continue;
    }
    const frame = planeFrame(normal(faces[0] as number));
    const loops = boundary.map((loop) =>
      loop.flatMap((h) =>
        chainOf(mesh.hFace[h] as number, mesh.hVert[h] as number).map((node) => ({
          node,
          corner: h,
        })),
      ),
    );
    const original = boundary.map((loop) =>
      project(
        loop.map((h) => mesh.position(mesh.hVert[h] as number)),
        frame,
      ),
    );
    const signs = original.map((loop) => {
      let a = 0;
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i] as readonly [number, number];
        const q = loop[(i + 1) % loop.length] as readonly [number, number];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return Math.sign(a);
    });
    const terms = new Set(loops.flat().flatMap(({ node }) => [...(node.lin?.terms.keys() ?? [])]));
    const sound = regionHolds(original, signs, tolerance * tolerance);
    regions.push({ faces, loops, frame, signs, terms, sound });
  }
  return regions;
}

/**
 * Do two coplanar faces carry one affine map of UVs, as far as the narrower one can tell? A
 * merged region is rewritten with each corner's own values, so where the narrower face's
 * UVs leave the wider face's map by a visible share of its own UV width (a sliver cell whose
 * copy moved a few micrometers off its UVs), the merged polygon's UVs fold along its short
 * edge. Smoothly curved UV layouts differ far less across one face.
 */
function sameValueMap(
  mesh: EditMesh,
  a: number,
  b: number,
  normal: (f: number) => Tuple3,
): boolean {
  if (mesh.channels.size === 0) return true;
  const frame = planeFrame(normal(a));
  const corners = (f: number) => {
    const halves = mesh.faceHalves(f);
    const points = project(
      halves.map((h) => mesh.position(mesh.hVert[h] as number)),
      frame,
    );
    return halves.map((h, i) => ({ h, p: points[i] as P2 }));
  };
  type Corner = ReturnType<typeof corners>[number];
  const area = (loop: readonly P2[]) =>
    Math.abs(loop.reduce((sum, p, i) => sum + cross2(p, loop[(i + 1) % loop.length] as P2), 0));
  const [base, other] = [corners(a), corners(b)].sort(
    (x, y) => area(y.map((c) => c.p)) - area(x.map((c) => c.p)),
  ) as [Corner[], Corner[]];
  const o = base[0] as Corner;
  const rel = (c: Corner): P2 => [c.p[0] - o.p[0], c.p[1] - o.p[1]];
  const farthest = (score: (c: Corner) => number) =>
    base.reduce((best, c) => (score(c) > score(best) ? c : best));
  const x = farthest((c) => dot2(rel(c), rel(c)));
  const y = farthest((c) => Math.abs(cross2(rel(x), rel(c))));
  const det = cross2(rel(x), rel(y));
  if (det === 0) return true;
  for (const name of mesh.channels.keys()) {
    const uv = (c: Corner): P2 | undefined => {
      const v = mesh.corner(name, c.h);
      return v === undefined || v.length !== 2 ? undefined : [v[0] as number, v[1] as number];
    };
    const own = other.map(uv);
    const [uo, ux, uy] = [o, x, y].map(uv);
    if (uo === undefined || ux === undefined || uy === undefined) continue;
    if (own.some((v) => v === undefined)) continue;
    const loop = own as P2[];
    let longest = 0;
    for (const [i, p] of loop.entries()) {
      const q = loop[(i + 1) % loop.length] as P2;
      const d: P2 = [q[0] - p[0], q[1] - p[1]];
      longest = Math.max(longest, Math.sqrt(dot2(d, d)));
    }
    if (longest === 0) continue;
    const width = area(loop) / longest;
    for (const [k, c] of other.entries()) {
      const s = cross2(rel(c), rel(y)) / det;
      const t = cross2(rel(x), rel(c)) / det;
      const v = loop[k] as P2;
      const off = [0, 1].map(
        (i) =>
          (uo[i] as number) +
          s * ((ux[i] as number) - (uo[i] as number)) +
          t * ((uy[i] as number) - (uo[i] as number)) -
          (v[i] as number),
      ) as [number, number];
      if (Math.sqrt(dot2(off, off)) > width * VALUE_FOLD) return false;
    }
  }
  return true;
}

function cross2(a: P2, b: P2): number {
  return a[0] * b[1] - a[1] * b[0];
}

function dot2(a: P2, b: P2): number {
  return a[0] * b[0] + a[1] * b[1];
}

type P2 = readonly [number, number];

/** Ring order of a fan and the profiles of its bevelled edges (topology only). */
function linkFan(
  fan: Fan,
  n: number,
  profiles: Map<string, Profile>,
  key: (v: number, e: number) => string,
): void {
  const m = fan.halves.length;
  const items: (Node | Link)[] = [];
  for (let i = 0; i < m; i++) {
    const h = fan.halves[i] as number;
    items.push(fan.bevelled[i] ? { kind: 'edge', half: h } : (fan.point[i] as Node));
    if (i >= fan.slots) continue;
    const j = (i + 1) % m;
    if (fan.bevelled[i] && fan.bevelled[j]) items.push(fan.corner[i] as Node);
    else if (!fan.bevelled[i] && !fan.bevelled[j]) items.push({ kind: 'face', slot: i });
  }
  if (fan.closed) {
    const first = items.findIndex((item) => !isLink(item));
    pushAll(items, items.splice(0, first));
  }
  fan.nodes = items.filter((item): item is Node => !isLink(item));
  fan.links = items.filter(isLink);
  const k = fan.nodes.length;
  for (const [j, link] of fan.links.entries()) {
    if (link.kind !== 'edge') continue;
    const x = fan.nodes[j] as Node;
    const y = fan.nodes[(j + 1) % k] as Node;
    const e = link.half >> 1;
    const other = fan.closed && k === 2 ? fan.links[1 - j] : undefined;
    const shared = other?.kind === 'edge' ? profiles.get(key(fan.v, other.half >> 1)) : undefined;
    if (shared !== undefined) {
      profiles.set(key(fan.v, e), {
        ...shared,
        half: link.half,
        nodes: [...shared.nodes].reverse(),
      });
      continue;
    }
    const nodes: Node[] =
      x === y
        ? Array.from({ length: n + 1 }, () => x)
        : [x, ...Array.from({ length: n - 1 }, (): Node => ({ id: NONE, pos: x.pos })), y];
    const profile: Profile = {
      half: link.half,
      nodes,
      halves: other?.kind === 'edge' ? [link.half, other.half] : [link.half],
      ...(other?.kind === 'face' ? { plane: fan.slotFaces[other.slot] as number } : {}),
    };
    if (profile.plane !== undefined && n > 1) {
      const chain = fan.chains.get(profile.plane) as Node[];
      const interior = nodes.slice(1, -1);
      fan.chains.set(profile.plane, [
        chain[0] as Node,
        ...(chain[0] === x ? interior : [...interior].reverse()),
        chain.at(-1) as Node,
      ]);
    }
    profiles.set(key(fan.v, e), profile);
  }
}

function isLink(item: Node | Link): item is Link {
  return 'kind' in item;
}

function fanFaces(fan: Fan): number[] {
  return [...fan.faces];
}

/** Strip faces of edge `e`: quads between its end profiles, in strip order. */
function stripLoops(
  mesh: EditMesh,
  e: number,
  n: number,
  profiles: ReadonlyMap<string, Profile>,
  key: (v: number, e: number) => string,
): Node[][] {
  const [pa, pb] = endProfiles(mesh, e, profiles, key);
  const loops: Node[][] = [];
  for (let i = 0; i < n; i++) {
    loops.push([pb[i] as Node, pa[i] as Node, pa[i + 1] as Node, pb[i + 1] as Node]);
  }
  return loops;
}

/** End profiles of edge `e` at its two vertices, from the side of face(2e) to face(2e + 1). */
function endProfiles(
  mesh: EditMesh,
  e: number,
  profiles: ReadonlyMap<string, Profile>,
  key: (v: number, e: number) => string,
): [Node[], Node[]] {
  const [a, b] = mesh.edgeVertices(e);
  const atA = profiles.get(key(a, e)) as Profile;
  const atB = profiles.get(key(b, e)) as Profile;
  return [[...atA.nodes].reverse(), atB.nodes];
}

/**
 * Corner faces of a closed fan with three or more boundary points: a patch for
 * round three- and four-sided corners whose sides are all profiles, else one n-gon.
 */
function capFaces(
  fan: Fan,
  n: number,
  profiles: ReadonlyMap<string, Profile>,
  key: (v: number, e: number) => string,
): Node[][] {
  const k = fan.nodes.length;
  const sides = fan.links.map((link, j) =>
    link.kind === 'face'
      ? [fan.nodes[j] as Node, fan.nodes[(j + 1) % k] as Node]
      : (profiles.get(key(fan.v, link.half >> 1)) as Profile).nodes,
  );
  const ring: Node[] = [];
  for (const side of sides) pushAll(ring, side.slice(0, -1));
  const patterned = n > 1 && (k === 3 || k === 4) && fan.links.every((l) => l.kind === 'edge');
  if (!patterned) return [ring];
  const topology = patchTopology(k as 3 | 4, n);
  const centers = fan.links.map(
    (link) => (profiles.get(key(fan.v, (link as { half: number }).half >> 1)) as Profile).center,
  );
  const center = centers.every((c) => c !== undefined)
    ? scale(
        centers.reduce<Tuple3>((sum, c) => add(sum, c as Tuple3), [0, 0, 0]),
        1 / centers.length,
      )
    : undefined;
  const positions = patchPositions(
    k as 3 | 4,
    n,
    ring.map((node) => node.pos),
    topology,
    center,
  );
  const nodes: Node[] = [...ring];
  for (let i = ring.length; i < positions.length; i++) {
    nodes.push({ id: NONE, pos: positions[i] as Tuple3 });
  }
  return topology.faces.map((face) => face.map((i) => nodes[i] as Node));
}

/** Corner source of a new point in face corner `h`: mix the corner and its two neighbours. */
function cornerSource(mesh: EditMesh, h: number, node: Node): CornerSource {
  const next = mesh.hNext[h] as number;
  const prev = mesh.hPrev[h] as number;
  const o = mesh.position(mesh.hVert[h] as number);
  const e1 = sub(mesh.position(mesh.hVert[next] as number), o);
  const e2 = sub(mesh.position(mesh.hVert[prev] as number), o);
  const d = sub(node.pos, o);
  const a = dot(e1, e1);
  const b = dot(e1, e2);
  const c = dot(e2, e2);
  const det = a * c - b * b;
  if (det <= a * c * 1e-12) return { v: node.id, corner: h };
  const alpha = (dot(d, e1) * c - dot(d, e2) * b) / det;
  const beta = (dot(d, e2) * a - dot(d, e1) * b) / det;
  return {
    v: node.id,
    weights: [
      [h, 1 - alpha - beta],
      [next, alpha],
      [prev, beta],
    ],
  };
}

/** Each edge's chain: the edges linked to it through smooth pairs, in edge order. */
function chains(
  edges: readonly number[],
  pairs: readonly (readonly [number, number])[],
): Map<number, number[]> {
  const root = new Map(edges.map((e) => [e, e] as const));
  const find = (e: number): number => {
    let r = e;
    while (root.get(r) !== r) r = root.get(r) as number;
    root.set(e, r);
    return r;
  };
  for (const [a, b] of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) root.set(Math.max(ra, rb), Math.min(ra, rb));
  }
  const members = new Map<number, number[]>();
  for (const e of edges) {
    const r = find(e);
    const list = members.get(r) ?? [];
    list.push(e);
    members.set(r, list);
  }
  return new Map(edges.map((e) => [e, members.get(find(e)) as number[]] as const));
}

function mean(forms: readonly Map<number, number>[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const form of forms) {
    for (const [e, c] of form) out.set(e, (out.get(e) ?? 0) + c / forms.length);
  }
  return out;
}

function dedupe<T>(items: readonly T[]): T[] {
  const out: T[] = [];
  for (const item of items) if (out.at(-1) !== item) out.push(item);
  while (out.length > 1 && out[0] === out.at(-1)) out.pop();
  return out;
}

function loopArea(points: readonly Tuple3[]): number {
  return length(newell(points)) / 2;
}

/** A polygon with area that triangulates (the validate and export face test). */
function simple(points: readonly Tuple3[], tolerance: number): boolean {
  return loopArea(points) > tolerance * tolerance && triangulateLoop(points) !== undefined;
}

/**
 * Split a loop that is not planar within ten tolerances (the validate threshold)
 * into triangles: quads along their shorter diagonal, larger loops by the export
 * triangulation.
 */
function planarize(
  mesh: EditMesh,
  ids: readonly number[],
  tolerance: number,
  counter: { faces: number },
): number[][] {
  const points = ids.map((v) => mesh.position(v));
  const nrm = normalize(newell(points));
  const origin = points[0] as Tuple3;
  const deviation = maxOf(points.map((q) => Math.abs(dot(sub(q, origin), nrm))));
  if (ids.length === 3 || deviation <= tolerance * 10) return [[...ids]];
  counter.faces++;
  if (ids.length === 4) {
    const [a, b, c, d] = ids as [number, number, number, number];
    const ac = length(sub(points[2] as Tuple3, points[0] as Tuple3));
    const bd = length(sub(points[3] as Tuple3, points[1] as Tuple3));
    return ac <= bd
      ? [
          [a, b, c],
          [a, c, d],
        ]
      : [
          [b, c, d],
          [b, d, a],
        ];
  }
  const triangles = triangulateLoop(points);
  if (triangles === undefined) return [[...ids]];
  const out: number[][] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    out.push([0, 1, 2].map((k) => ids[triangles[i + k] as number] as number));
  }
  return out;
}
