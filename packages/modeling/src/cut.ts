import { err, ok, type Result } from '@forgeax/engine-types';
import { fillBoundaryLoops, nonplanarCaps, traceBoundaryLoops } from './connect';
import { type ModelingError, modelingError } from './errors';
import { add, cross, dot, faceNormal, length, normalize, scale, sub, type Tuple3 } from './geom';
import { type EditMesh, NONE } from './mesh';
import {
  type Attribution,
  deleteFaces,
  type OpDiagnostic,
  type RoleCounts,
  requireFinite,
  requireSegments,
} from './ops';
import { type CornerSource, type FaceRewrite, rewriteFaces } from './rewrite';
import { type Crossing, edgeRing } from './walk';

/** Vertices inserted along an edge, ordered from hVert[2e] to hVert[2e + 1], with their parameters. */
interface EdgeSplit {
  readonly vertices: readonly number[];
  readonly t: readonly number[];
}

/** Insert split vertices into a face loop, interpolating corner values along each split edge. */
function expandedLoop(
  mesh: EditMesh,
  f: number,
  splits: ReadonlyMap<number, EdgeSplit>,
): { loop: CornerSource[]; runs: Map<number, number> } {
  const loop: CornerSource[] = [];
  const runs = new Map<number, number>();
  for (const h of mesh.faceHalves(f)) {
    loop.push({ v: mesh.hVert[h] as number, corner: h });
    const split = splits.get(h >> 1);
    if (split === undefined) continue;
    runs.set(h, loop.length);
    const forward = (h & 1) === 0;
    const n = split.vertices.length;
    for (let k = 0; k < n; k++) {
      const i = forward ? k : n - 1 - k;
      const t = split.t[i] as number;
      loop.push({
        v: split.vertices[i] as number,
        from: h,
        to: mesh.hNext[h] as number,
        t: forward ? t : 1 - t,
      });
    }
  }
  return { loop, runs };
}

function insertEdgeVertices(
  mesh: EditMesh,
  e: number,
  t: readonly number[],
  parent: Map<number, readonly [number, number]>,
): EdgeSplit {
  const [a, b] = mesh.edgeVertices(e);
  const pa = mesh.position(a);
  const pb = mesh.position(b);
  const vertices = t.map((s) => {
    const v = mesh.addVertex(...add(pa, scale(sub(pb, pa), s)));
    parent.set(v, [a, b]);
    return v;
  });
  return { vertices, t };
}

// ---- loop cut --------------------------------------------------------------------

export interface LoopCutOptions {
  /** Number of parallel cuts (>= 1). */
  readonly cuts: number;
}

/**
 * Cut edge rings through the selected edges with `cuts` evenly spaced loops. The
 * ring crosses even-sided n-gons through their opposite edge and ends at odd-sided
 * faces or boundaries, which only gain the new vertices (an end face may gain them
 * from several rings, and a crossed face keeps the vertices other rings end at).
 * Split edges keep their intent; the new cut edges are smooth.
 */
export function loopCut(
  mesh: EditMesh,
  seeds: readonly number[],
  options: LoopCutOptions,
): Result<RoleCounts, ModelingError> {
  const cuts = requireSegments('cuts', options.cuts, 1);
  if (!cuts.ok) return cuts;
  const c = options.cuts;
  const ringEdges = new Set<number>();
  const crossings = new Map<number, Crossing>();
  let rings = 0;
  for (const seed of seeds) {
    if (ringEdges.has(seed)) continue;
    const ring = edgeRing(mesh, seed);
    rings++;
    for (const e of ring.edges) ringEdges.add(e);
    for (const crossing of ring.crossings) {
      if (crossings.has(crossing.face)) {
        return err(
          modelingError(
            'model-precondition',
            'each face is crossed by at most one cut ring',
            { face: crossing.face },
            'cut intersecting rings in separate loopCut calls',
          ),
        );
      }
      crossings.set(crossing.face, crossing);
    }
  }
  if (crossings.size === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'a cut ring crosses at least one face',
        { rings, seeds: seeds.length },
        'seed the ring with an edge of an even-sided face; odd-sided faces and boundaries end a ring',
      ),
    );
  }
  const touched = new Set<number>();
  for (const e of ringEdges) {
    for (const h of [e * 2, e * 2 + 1]) {
      const f = mesh.hFace[h] as number;
      if (f === NONE || crossings.has(f)) continue;
      touched.add(f);
    }
  }
  const t = Array.from({ length: c }, (_, k) => (k + 1) / (c + 1));
  const parent = new Map<number, readonly [number, number]>();
  const splits = new Map<number, EdgeSplit>();
  for (const e of [...ringEdges].sort((a, b) => a - b)) {
    splits.set(e, insertEdgeVertices(mesh, e, t, parent));
  }
  const rewrites: FaceRewrite[] = [];
  for (const f of [...touched].sort((a, b) => a - b)) {
    rewrites.push({ face: f, loops: [expandedLoop(mesh, f, splits).loop] });
  }
  for (const crossing of [...crossings.values()].sort((a, b) => a.face - b.face)) {
    const { loop, runs } = expandedLoop(mesh, crossing.face, splits);
    const e0 = runs.get(crossing.entry) as number;
    const x0 = runs.get(crossing.exit) as number;
    const at = (i: number) => loop[(i + loop.length) % loop.length] as CornerSource;
    const span = (from: number, to: number) => {
      const out: CornerSource[] = [];
      for (let i = from; ; i++) {
        out.push(at(i));
        if ((i - to) % loop.length === 0) break;
      }
      return out;
    };
    const e = (k: number) => e0 + k - 1;
    const x = (k: number) => x0 + k - 1;
    const loops: CornerSource[][] = [span(x(c), e(1) + loop.length)];
    for (let k = 1; k < c; k++)
      loops.push([at(e(k)), at(e(k + 1)), at(x(c - k)), at(x(c - k + 1))]);
    loops.push(span(e(c), x(1) < e(c) ? x(1) + loop.length : x(1)));
    rewrites.push({ face: crossing.face, loops });
  }
  const done = rewriteFaces(mesh, rewrites, parent);
  if (!done.ok) return done;
  return ok({ rings, crossed: crossings.size });
}

// ---- plane cuts --------------------------------------------------------------------

export interface CutPlane {
  readonly point: Tuple3;
  readonly normal: Tuple3;
}

export function readPlane(
  options: CutPlane,
): Result<{ point: Tuple3; normal: Tuple3 }, ModelingError> {
  for (const c of [...options.point, ...options.normal]) {
    const checked = requireFinite('plane', c);
    if (!checked.ok) return checked;
  }
  if (length(options.normal) === 0) {
    return err(
      modelingError('model-invalid-argument', 'normal is non-zero', { normal: options.normal }),
    );
  }
  return ok({ point: options.point, normal: normalize(options.normal) });
}

/**
 * Split every face the plane crosses (only the faces in `only`, when given; their
 * neighbours just take the inserted edge vertices). Vertices within `tolerance` of
 * the plane count as on it; crossing edges gain one vertex at the intersection.
 * Returns the signed distance of every vertex (inserted vertices are exactly 0), how
 * many edges and faces were split, and the faces each rewritten face became.
 */
export function bisectMesh(
  mesh: EditMesh,
  plane: { point: Tuple3; normal: Tuple3 },
  tolerance: number,
  only?: ReadonlySet<number>,
): Result<
  {
    distance: Map<number, number>;
    edges: number;
    faces: number;
    rewritten: { readonly face: number; readonly faces: readonly number[] }[];
  },
  ModelingError
> {
  const distance = new Map<number, number>();
  for (const v of mesh.vertices()) {
    const d = dot(sub(mesh.position(v), plane.point), plane.normal);
    distance.set(v, Math.abs(d) <= tolerance ? 0 : d);
  }
  const parent = new Map<number, readonly [number, number]>();
  const splits = new Map<number, EdgeSplit>();
  for (const e of mesh.edges()) {
    const [a, b] = mesh.edgeVertices(e);
    const da = distance.get(a) as number;
    const db = distance.get(b) as number;
    if (da * db >= 0) continue;
    if (
      only !== undefined &&
      !only.has(mesh.hFace[e * 2] as number) &&
      !only.has(mesh.hFace[e * 2 + 1] as number)
    )
      continue;
    const split = insertEdgeVertices(mesh, e, [da / (da - db)], parent);
    distance.set(split.vertices[0] as number, 0);
    splits.set(e, split);
  }
  const sign = (v: number) => Math.sign(distance.get(v) as number);
  const rewrites: FaceRewrite[] = [];
  let faces = 0;
  for (const f of mesh.faces()) {
    const { loop } = expandedLoop(mesh, f, splits);
    const signs = loop.map((c) => sign(c.v));
    if (!(signs.includes(1) && signs.includes(-1)) || (only !== undefined && !only.has(f))) {
      if (loop.length !== (mesh.fLen[f] as number)) rewrites.push({ face: f, loops: [loop] });
      continue;
    }
    const n = loop.length;
    const crossing = (i: number) => {
      let before = 0;
      let after = 0;
      for (let k = 1; k < n && before === 0; k++) before = signs[(i - k + n) % n] as number;
      for (let k = 1; k < n && after === 0; k++) after = signs[(i + k) % n] as number;
      return before !== after;
    };
    const direction = cross(plane.normal, faceNormal(mesh, f));
    const ons = loop
      .map((c, i) => ({ i, s: dot(mesh.position(c.v), direction) }))
      .filter(({ i }) => signs[i] === 0 && crossing(i))
      .sort((p, q) => p.s - q.s);
    let pieces: number[][] = [loop.map((_, i) => i)];
    for (let k = 0; k + 1 < ons.length; k += 2) {
      const p = (ons[k] as { i: number }).i;
      const q = (ons[k + 1] as { i: number }).i;
      pieces = pieces.flatMap((piece) => {
        const ip = piece.indexOf(p);
        const iq = piece.indexOf(q);
        const m = piece.length;
        if (ip < 0 || iq < 0 || (ip - iq + m) % m === 1 || (iq - ip + m) % m === 1) return [piece];
        const first: number[] = [];
        for (let i = ip; ; i = (i + 1) % m) {
          first.push(piece[i] as number);
          if (i === iq) break;
        }
        const second: number[] = [];
        for (let i = iq; ; i = (i + 1) % m) {
          second.push(piece[i] as number);
          if (i === ip) break;
        }
        return [first, second];
      });
    }
    if (pieces.length > 1) faces++;
    rewrites.push({
      face: f,
      loops: pieces.map((piece) => piece.map((i) => loop[i] as CornerSource)),
    });
  }
  const done = rewriteFaces(mesh, rewrites, parent);
  if (!done.ok) return done;
  const rewritten = rewrites.map((r, i) => ({ face: r.face, faces: done.value[i] as number[] }));
  return ok({ distance, edges: splits.size, faces, rewritten });
}

/** Split faces along a plane, keeping both sides; the new section edges are smooth. */
export function bisect(
  mesh: EditMesh,
  options: CutPlane,
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const plane = readPlane(options);
  if (!plane.ok) return plane;
  const done = bisectMesh(mesh, plane.value, tolerance);
  if (!done.ok) return done;
  if (done.value.faces === 0) {
    return err(
      modelingError('model-op-no-effect', 'the plane crosses at least one face', {
        point: options.point,
        normal: options.normal,
      }),
    );
  }
  return ok({ splitEdges: done.value.edges, splitFaces: done.value.faces });
}

export interface PlaneCutOptions extends CutPlane {
  /** Which side of the plane survives; `positive` is the side `normal` points to. */
  readonly keep: 'positive' | 'negative';
  /** Close each opening on the plane with an n-gon cap (role `cap`, sharp rim); default false. */
  readonly fillHoles?: boolean;
}

/**
 * Bisect, then delete everything on the other side of the plane. Openings stay
 * open unless `fillHoles` is set. Effect assertion: no vertex remains strictly on
 * the removed side.
 */
export function planeCut(
  mesh: EditMesh,
  options: PlaneCutOptions,
  tolerance: number,
  attribution: Attribution,
  material: number | undefined,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const plane = readPlane(options);
  if (!plane.ok) return plane;
  const done = bisectMesh(mesh, plane.value, tolerance);
  if (!done.ok) return done;
  const removed = options.keep === 'positive' ? -1 : 1;
  const { distance } = done.value;
  const doomed = mesh.faces().filter((f) => {
    const signs = mesh.faceVertices(f).map((v) => Math.sign(distance.get(v) as number));
    return signs.includes(removed) && !signs.includes(-removed);
  });
  if (doomed.length === 0) {
    return err(
      modelingError('model-op-no-effect', 'the plane cuts away at least one face', {
        point: options.point,
        normal: options.normal,
        keep: options.keep,
      }),
    );
  }
  deleteFaces(mesh, doomed);
  for (const v of mesh.vertices()) {
    if (Math.sign(distance.get(v) as number) === removed) {
      return err(
        modelingError('model-degenerate', 'no vertex remains on the removed side', { vertex: v }),
      );
    }
  }
  const counts: RoleCounts = { removed: doomed.length };
  if (options.fillHoles ?? false) {
    const open = mesh
      .edges()
      .filter((e) => mesh.isBoundaryEdge(e))
      .filter((e) => mesh.edgeVertices(e).every((v) => distance.get(v) === 0));
    if (open.length > 0) {
      const loops = traceBoundaryLoops(mesh, open);
      if (!loops.ok) return loops;
      const filled = fillBoundaryLoops(mesh, loops.value, attribution, material);
      if (!filled.ok) return filled;
      Object.assign(counts, filled.value.counts);
      const nonplanar = nonplanarCaps(filled.value.caps, tolerance);
      if (nonplanar > 0) {
        diagnostics.push({
          severity: 'warn',
          message: `${nonplanar} cap(s) are non-planar; export triangulates them in their best-fit plane`,
          detail: { caps: nonplanar },
        });
      }
    }
  }
  return ok(counts);
}

// ---- support loops -----------------------------------------------------------------

export interface SupportLoopOptions {
  /**
   * Distance of each loop from the selected edges, meters (one or two values, typically
   * 0.002 to 0.003; the second loop lies farther out).
   */
  readonly offset: number | readonly number[];
}

/**
 * Subdivision support loops: on both sides of the selected edges, one or
 * two edge loops at `offset` meters measured along the edges that leave the selection
 * (the rungs of its side faces), so subdivision keeps the selected edges crisp. Each side
 * face of a selected edge gains a strip per loop (tagged `support`); faces beyond it only
 * gain the rung vertices, like the ends of a loop cut. A side face holding two selected
 * edges (a corner or a strip one face wide) is `model-precondition`, as is an offset that
 * reaches half a rung.
 */
export function supportLoops(
  mesh: EditMesh,
  selected: readonly number[],
  options: SupportLoopOptions,
): Result<RoleCounts, ModelingError> {
  const offsets = typeof options.offset === 'number' ? [options.offset] : [...options.offset];
  if (
    offsets.length === 0 ||
    offsets.length > 2 ||
    !offsets.every((o) => Number.isFinite(o) && o > 0) ||
    (offsets.length === 2 && !((offsets[0] as number) < (offsets[1] as number)))
  )
    return err(
      modelingError('model-invalid-argument', 'offset is one or two rising positive distances', {
        offset: options.offset as unknown,
      }),
    );
  const chosen = new Set(selected);
  // Side faces and, per rung edge, the selected vertex it is measured from.
  const sides = new Map<number, number>();
  const anchors = new Map<number, number>();
  for (const e of [...chosen].sort((a, b) => a - b)) {
    for (const h of [2 * e, 2 * e + 1]) {
      const f = mesh.hFace[h] as number;
      if (f === NONE) continue;
      if (sides.has(f))
        return err(
          modelingError(
            'model-precondition',
            'each side face touches one selected edge',
            { face: f },
            'support corners and one-face strips with markSharp, or select one chain at a time',
          ),
        );
      sides.set(f, h);
      for (const [rung, anchor] of [
        [mesh.hNext[h] as number, mesh.hVert[mesh.hNext[h] as number] as number],
        [mesh.hPrev[h] as number, mesh.hVert[h] as number],
      ] as const) {
        const edge = rung >> 1;
        if (chosen.has(edge))
          return err(
            modelingError('model-precondition', 'each side face touches one selected edge', {
              face: f,
            }),
          );
        const previous = anchors.get(edge);
        if (previous !== undefined && previous !== anchor)
          return err(
            modelingError('model-precondition', 'a rung joins two selected edges', { edge }),
          );
        anchors.set(edge, anchor);
      }
    }
  }
  if (sides.size === 0)
    return err(modelingError('model-op-no-effect', 'a selected edge has a face', {}));
  const parent = new Map<number, readonly [number, number]>();
  const splits = new Map<number, EdgeSplit>();
  for (const [edge, anchor] of [...anchors].sort((a, b) => a[0] - b[0])) {
    const [a, b] = mesh.edgeVertices(edge);
    const rungLength = length(sub(mesh.position(b), mesh.position(a)));
    const fractions = offsets.map((o) => o / rungLength);
    if ((fractions[fractions.length - 1] as number) >= 0.5)
      return err(
        modelingError(
          'model-precondition',
          'every support offset stays below half of the rung it lies on',
          { edge, rung: rungLength, offsets },
          'lower the offset or add a loop cut first',
        ),
      );
    const t = anchor === a ? fractions : fractions.map((x) => 1 - x).reverse();
    splits.set(edge, insertEdgeVertices(mesh, edge, t, parent));
  }
  const rewrites: FaceRewrite[] = [];
  const strips: number[] = [];
  const touched = new Set<number>();
  for (const edge of anchors.keys())
    for (const h of [2 * edge, 2 * edge + 1]) {
      const f = mesh.hFace[h] as number;
      if (f !== NONE && !sides.has(f)) touched.add(f);
    }
  for (const f of [...touched].sort((a, b) => a - b))
    rewrites.push({ face: f, loops: [expandedLoop(mesh, f, splits).loop] });
  const count = offsets.length;
  for (const [f, h] of [...sides].sort((a, b) => a[0] - b[0])) {
    const { loop, runs } = expandedLoop(mesh, f, splits);
    const n = loop.length;
    const at = (i: number) => loop[((i % n) + n) % n] as CornerSource;
    const start = loop.findIndex((c) => 'corner' in c && c.corner === h);
    // Rung after the selected edge runs outward from b; the one before it ends at a.
    const out = runs.get(mesh.hNext[h] as number) as number;
    const back = (runs.get(mesh.hPrev[h] as number) as number) + count - 1;
    const p = (k: number) => at(out + k);
    const q = (k: number) => at(back - k);
    const loops: CornerSource[][] = [[at(start), at(start + 1), p(0), q(0)]];
    for (let k = 1; k < count; k++) loops.push([q(k - 1), p(k - 1), p(k), q(k)]);
    const rest: CornerSource[] = [];
    for (let i = out + count - 1; ; i++) {
      rest.push(at(i));
      if ((((i - (back - count + 1)) % n) + n) % n === 0) break;
    }
    loops.push(rest);
    rewrites.push({ face: f, loops });
    strips.push(rewrites.length - 1);
  }
  const done = rewriteFaces(mesh, rewrites, parent);
  if (!done.ok) return done;
  const tag = mesh.tagIndex('support', true);
  let support = 0;
  for (const index of strips) {
    const faces = done.value[index] as number[];
    for (const face of faces.slice(0, count)) {
      mesh.addTag(face, tag);
      support++;
    }
  }
  return ok({ support });
}
