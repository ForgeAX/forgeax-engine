import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from './arrays';
import { type ModelingError, modelingError } from './errors';
import { dot, length, sub, type Tuple3 } from './geom';
import { type EditMesh, NONE } from './mesh';
import { regionGroups } from './ops';
import type { Issue } from './report';
import type { EdgeSelector } from './selectors';
import { SHELL_WALL_ROLES } from './shell';
import type { DtsRow } from './shut-lines';
import { type CoverageReference, type CoverageReport, checkCoverage } from './watertight-coverage';

/**
 * What declares an open boundary: a trim or opening loop, a DTS shut line (gap row) or
 * clearance row between two parts, or the `open` selector. A shell rim or flange is designed
 * only through its source.
 */
export type DesignedBoundary = 'trim' | 'shut-line' | 'clearance' | 'open';

/**
 * `free`: edges with one face (naked edges). `rim`: a shelled panel's outer edges, where its
 * skin meets its own shell wall (`inner`, `rim`, `flange`; the edge `measureShutLines` measures):
 * a crack between shelled panels leaves two facing walls and no free edge.
 */
export type ChainKind = 'free' | 'rim';

export interface WatertightOptions {
  /** Edges open by design that no trim or shut line declares. */
  readonly open?: EdgeSelector;
  /** Gap search radius in meters (default 0.04). */
  readonly radius?: number;
  /**
   * The DTS table when `validate` gets no `shutLines` (whose table is used first): a gap row
   * designs its panels' edges within the shut-line reach of each other, a clearance row
   * (`clearance`, a designed separation such as a tyre in its arch) those within `radius`.
   */
  readonly table?: readonly DtsRow[];
  /**
   * The design surface the skin must cover: its samples farther than `tolerance` from every
   * skin face are `mesh-open` errors (`check: 'uncovered'`) outside the shut-line and trim
   * bands (`CoverageExclusion`).
   */
  readonly reference?: CoverageReference;
}

/**
 * A maximal chain of free or outer edges of one part with one classification. `gap` is the
 * largest, over the chain's samples (at most SAMPLE apart), distance to the nearest facing
 * free or outer edge elsewhere within `radius` (facing: the offset within 30 degrees of
 * perpendicular to both edges; on the chain's own loop only farther along it than ALONG
 * times across): the opening of a seam to sew, measured at the skin for outer edges. With
 * no facing edge in reach, `gap` and `partner` are null: a hole to fill.
 */
export interface BoundaryChain {
  readonly id: number;
  readonly kind: ChainKind;
  readonly part: string;
  readonly edges: number;
  readonly length: number;
  readonly closed: boolean;
  readonly designed?: DesignedBoundary;
  readonly gap: number | null;
  readonly partner: { readonly part: string; readonly chain: number } | null;
  /** The point halfway along the chain. */
  readonly at: Tuple3;
  readonly bounds: readonly [Tuple3, Tuple3];
}

/** Chain counts of one kind in a part. */
export interface ChainCounts {
  readonly designed: Readonly<Record<DesignedBoundary, number>>;
  readonly undesigned: number;
  readonly undesignedLength: number;
  /** Undesigned chains with a partner (seams to sew) and without (holes to fill). */
  readonly seams: number;
  readonly holes: number;
  /** Chain ids: the longest undesigned chain and the undesigned chain with the widest gap. */
  readonly longest: number | null;
  readonly widest: number | null;
}

/** Per part (a `part:` face tag, else a connected component `component:<n>`). */
export interface WatertightPart {
  readonly part: string;
  readonly free: ChainCounts;
  readonly rim: ChainCounts;
  readonly tJunctions: number;
}

/**
 * Two parts whose chains face each other (sampled partners within `radius`). `designed` is
 * `shut-line` when a DTS gap row names a tag of each (the gauge owns that seam) and
 * `clearance` for a clearance row (an error while `gap.min` is below its `min`); without a row
 * the seam between them is undesigned, a `mesh-open` error (`check: 'cross-part'`), and its
 * undesigned chains carry `detail.pair`.
 */
export interface CrossPart {
  readonly parts: readonly [string, string];
  readonly designed?: 'shut-line' | 'clearance';
  /** Over the samples of both parts' chains whose nearest facing edge is in the other part, m. */
  readonly gap: { readonly min: number; readonly median: number; readonly max: number };
  /** Length of each part's chains facing the other, m. */
  readonly lengths: readonly [number, number];
  /** The sample with the largest gap. */
  readonly worst: Tuple3;
}

export interface WatertightReport {
  /** Search radius of the gap, m. */
  readonly radius: number;
  readonly chains: readonly BoundaryChain[];
  readonly parts: readonly WatertightPart[];
  readonly crossPart: readonly CrossPart[];
  /** With `reference`. */
  readonly coverage?: CoverageReport;
}

/** Default gap search radius, m: F1 seams reach about 30 mm. */
const RADIUS = 0.04;
/** Facing edges this many radii away are reported as beyond the radius (info). */
const BEYOND = 1.5;
/** Default shut-line reach (as `measureShutLines`), m. */
const SHUT_REACH = 0.012;
/** Largest spacing of the gap samples along an edge, m. */
const SAMPLE = 0.005;
/** Facing edges: the offset between them lies within 30 degrees of perpendicular to both. */
const FACING = 0.5;
/** A free edge of the same loop faces the sample only this many times farther along it than across. */
const ALONG = 4;
/** Share of a loop's length on trim-tagged faces that makes it a trim loop. */
const TRIM_SHARE = 0.5;
/** Located elements listed per issue. */
const MAX_LISTED = 32;

interface Segment {
  readonly a: Tuple3;
  readonly b: Tuple3;
}

/** Segments bucketed in a uniform grid; a query visits the cells within `cell` of a point. */
class SegmentGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly stamp: Uint32Array;
  private round = 0;

  readonly segments: readonly Segment[];
  private readonly cell: number;

  constructor(segments: readonly Segment[], cell: number) {
    this.segments = segments;
    this.cell = cell;
    this.stamp = new Uint32Array(segments.length);
    for (const [i, s] of segments.entries()) {
      const d = sub(s.b, s.a);
      const pieces = Math.max(1, Math.ceil(length(d) / cell));
      for (let k = 0; k < pieces; k++) {
        const p = lerp(s.a, d, k / pieces);
        const q = lerp(s.a, d, (k + 1) / pieces);
        const lo = [0, 1, 2].map((j) =>
          Math.floor(Math.min(p[j] as number, q[j] as number) / cell),
        );
        const hi = [0, 1, 2].map((j) =>
          Math.floor(Math.max(p[j] as number, q[j] as number) / cell),
        );
        for (let x = lo[0] as number; x <= (hi[0] as number); x++)
          for (let y = lo[1] as number; y <= (hi[1] as number); y++)
            for (let z = lo[2] as number; z <= (hi[2] as number); z++) {
              const key = `${x},${y},${z}`;
              const list = this.cells.get(key);
              if (list === undefined) this.cells.set(key, [i]);
              else if (list.at(-1) !== i) list.push(i);
            }
      }
    }
  }

  /** Each segment with a cell within `cell` of `p`, once. */
  near(p: Tuple3, visit: (i: number) => void): void {
    this.round++;
    const c = p.map((x) => Math.floor(x / this.cell)) as Tuple3;
    for (let x = c[0] - 1; x <= c[0] + 1; x++)
      for (let y = c[1] - 1; y <= c[1] + 1; y++)
        for (let z = c[2] - 1; z <= c[2] + 1; z++)
          for (const i of this.cells.get(`${x},${y},${z}`) ?? []) {
            if (this.stamp[i] === this.round) continue;
            this.stamp[i] = this.round;
            visit(i);
          }
  }
}

function lerp(a: Tuple3, d: Tuple3, t: number): Tuple3 {
  return [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
}

/** Parameter of the point of segment `s` closest to `p`. */
function closestOn(s: Segment, p: Tuple3): number {
  const d = sub(s.b, s.a);
  const span = dot(d, d);
  return span > 0 ? Math.min(1, Math.max(0, dot(sub(p, s.a), d) / span)) : 0;
}

/** The part of every face: its first `part:` tag, else its connected component among untagged faces. */
function faceParts(mesh: EditMesh): Map<number, string> {
  const tags = mesh.tagNames.flatMap((name, t) => (name.startsWith('part:') ? [t] : []));
  const out = new Map<number, string>();
  const untagged: number[] = [];
  for (const f of mesh.faces()) {
    const t = tags.find((k) => mesh.hasTag(f, k));
    if (t === undefined) untagged.push(f);
    else out.set(f, mesh.tagNames[t] as string);
  }
  for (const [k, group] of regionGroups(mesh, untagged, 'perIsland').entries())
    for (const f of group) out.set(f, `component:${k}`);
  return out;
}

interface BoundaryEdge {
  readonly edge: number;
  readonly kind: ChainKind;
  /** The face whose tags classify the edge: the only face, or the skin face. */
  readonly face: number;
  readonly part: string;
  designed: DesignedBoundary | undefined;
  /** The DTS row designing a shut-line or clearance edge. */
  readonly row: DtsRow | undefined;
  /** Loop index and arc length at the edge's start along the loop's walk. */
  loop: number;
  start: number;
  from: Tuple3;
  to: Tuple3;
  chain: number;
}

/** The face edges carrying `tag`, bucketed for the shut-line reach. */
function panelGrid(mesh: EditMesh, tag: number, reach: number): SegmentGrid {
  const segments: Segment[] = [];
  for (const e of mesh.edges()) {
    const fa = mesh.hFace[e * 2] as number;
    const fb = mesh.hFace[e * 2 + 1] as number;
    if (!((fa !== NONE && mesh.hasTag(fa, tag)) || (fb !== NONE && mesh.hasTag(fb, tag)))) continue;
    const [va, vb] = mesh.edgeVertices(e);
    segments.push({ a: mesh.position(va), b: mesh.position(vb) });
  }
  return new SegmentGrid(segments, reach);
}

/** A DTS row's tag pair, both ways (tag indices), with its kind and a clearance row's `min`. */
interface DeclaredPair {
  readonly own: number;
  readonly other: number;
  readonly designed: 'shut-line' | 'clearance';
  readonly min: number;
  readonly row: DtsRow;
}

function declaredPairs(mesh: EditMesh, table: readonly DtsRow[]): DeclaredPair[] {
  return table.flatMap((row) => {
    const [a, b] = row.parts.map((p) => mesh.tagIndex(p, false)) as [number, number];
    const designed = row.clearance === undefined ? 'shut-line' : 'clearance';
    const min = row.clearance?.min ?? 0;
    return a < 0 || b < 0
      ? []
      : [
          { own: a, other: b, designed, min, row },
          { own: b, other: a, designed, min, row },
        ];
  });
}

/**
 * Classify a free or outer edge by its (skin) face: a DTS gap-row panel edge within the
 * shut-line reach of the other panel, a clearance-row part edge within `radius` of the other,
 * or a selected `open` edge (trim loops are whole loops, see `checkWatertight`).
 */
function classifier(
  mesh: EditMesh,
  declared: readonly DeclaredPair[],
  reach: number,
  radius: number,
  open: ReadonlySet<number>,
): (edge: number, face: number) => { designed: DesignedBoundary; row?: DtsRow } | undefined {
  const grids = new Map<string, SegmentGrid>();
  const grid = (tag: number, within: number) => {
    const key = `${tag}:${within}`;
    let g = grids.get(key);
    if (g === undefined) {
      g = panelGrid(mesh, tag, within);
      grids.set(key, g);
    }
    return g;
  };
  const near = (g: SegmentGrid, p: Tuple3, within: number) => {
    let hit = false;
    g.near(p, (i) => {
      if (hit) return;
      const s = g.segments[i] as Segment;
      hit = length(sub(lerp(s.a, sub(s.b, s.a), closestOn(s, p)), p)) <= within;
    });
    return hit;
  };
  return (edge, face) => {
    const [va, vb] = mesh.edgeVertices(edge);
    const pa = mesh.position(va);
    const mid = lerp(pa, sub(mesh.position(vb), pa), 0.5);
    for (const d of declared) {
      const within = d.designed === 'shut-line' ? reach : radius;
      if (mesh.hasTag(face, d.own) && near(grid(d.other, within), mid, within))
        return { designed: d.designed, row: d.row };
    }
    return open.has(edge) ? { designed: 'open' } : undefined;
  };
}

/** Boundary loops walked vertex to vertex (closed, or open between branch vertices). */
function loops(
  mesh: EditMesh,
  edges: BoundaryEdge[],
): { members: BoundaryEdge[]; closed: boolean }[] {
  const at = new Map<number, number[]>();
  for (const [i, e] of edges.entries())
    for (const v of mesh.edgeVertices(e.edge)) {
      const list = at.get(v);
      if (list === undefined) at.set(v, [i]);
      else list.push(i);
    }
  const used = new Uint8Array(edges.length);
  const out: { members: BoundaryEdge[]; closed: boolean }[] = [];
  const walk = (first: number, start: number) => {
    const members: BoundaryEdge[] = [];
    let [i, v] = [first, start];
    let arc = 0;
    for (;;) {
      used[i] = 1;
      const e = edges[i] as BoundaryEdge;
      const [va, vb] = mesh.edgeVertices(e.edge);
      const forward = va === v;
      e.loop = out.length;
      e.start = arc;
      e.from = mesh.position(v);
      v = forward ? vb : va;
      e.to = mesh.position(v);
      arc += length(sub(e.to, e.from));
      members.push(e);
      const next = at.get(v) as number[];
      if (next.length !== 2) return out.push({ members, closed: false });
      const j = next.find((k) => used[k] === 0);
      if (j === undefined) return out.push({ members, closed: v === start });
      i = j;
    }
  };
  for (const [v, list] of at)
    if (list.length !== 2) for (const i of list) if (used[i] === 0) walk(i, v);
  for (const [i, e] of edges.entries()) if (used[i] === 0) walk(i, mesh.edgeVertices(e.edge)[0]);
  return out;
}

/** Runs of a loop with one part and classification; a closed loop's run may wrap around. */
function runs(loop: { members: BoundaryEdge[]; closed: boolean }): BoundaryEdge[][] {
  const same = (a: BoundaryEdge, b: BoundaryEdge) =>
    a.kind === b.kind && a.part === b.part && a.designed === b.designed;
  const m = loop.members;
  let first = 0;
  if (loop.closed) {
    first = m.findIndex((e, k) => !same(e, m[(k - 1 + m.length) % m.length] as BoundaryEdge));
    if (first < 0) return [m];
  }
  const out: BoundaryEdge[][] = [];
  for (let k = 0; k < m.length; k++) {
    const e = m[(first + k) % m.length] as BoundaryEdge;
    const last = out.at(-1);
    if (last !== undefined && same(last.at(-1) as BoundaryEdge, e)) last.push(e);
    else out.push([e]);
  }
  return out;
}

/**
 * Free-edge chains per part with their gaps and classification, and the T-junction
 * vertices attributed to their parts (`validate({ watertight })`). Undesigned chains are
 * `mesh-open` errors (`check` 'free-chain' or 'rim-chain'), designed chains infos;
 * T-junctions are errors, one per part (they leak light in raster output).
 */
export function checkWatertight(
  mesh: EditMesh,
  tolerance: number,
  options: WatertightOptions,
  shutLines: { readonly table: readonly DtsRow[]; readonly reach?: number } | undefined,
  tJunctions: readonly number[],
): Result<
  { report: WatertightReport; issues: Issue<'mesh-open' | 't-junction'>[] },
  ModelingError
> {
  const radius = options.radius ?? RADIUS;
  if (!(Number.isFinite(radius) && radius > 0))
    return err(
      modelingError('model-invalid-argument', 'watertight.radius is a positive number of meters', {
        radius,
      }),
    );
  let open = new Set<number>();
  if (options.open !== undefined) {
    const ids = options.open.resolve(mesh);
    if (!ids.ok) return err(ids.error);
    open = new Set(ids.value);
  }
  const partOf = faceParts(mesh);
  const declared = declaredPairs(mesh, shutLines?.table ?? options.table ?? []);
  const classify = classifier(mesh, declared, shutLines?.reach ?? SHUT_REACH, radius, open);
  const wallRoles = new Set<number>(SHELL_WALL_ROLES.map((r) => mesh.roleNames.indexOf(r)));
  wallRoles.delete(-1);
  const isWall = (f: number) => wallRoles.has(mesh.fRole[f] as number);
  const free: BoundaryEdge[] = [];
  const zero: Tuple3 = [0, 0, 0];
  const push = (edge: number, kind: ChainKind, face: number) => {
    const c = classify(edge, face);
    free.push({
      edge,
      kind,
      face,
      part: partOf.get(face) as string,
      designed: c?.designed,
      row: c?.row,
      loop: -1,
      start: 0,
      from: zero,
      to: zero,
      chain: -1,
    });
  };
  for (const e of mesh.edges()) {
    const fa = mesh.hFace[e * 2] as number;
    const fb = mesh.hFace[e * 2 + 1] as number;
    if (fa === NONE || fb === NONE) {
      if (fa !== fb) push(e, 'free', fa === NONE ? fb : fa);
    } else if (isWall(fa) !== isWall(fb) && partOf.get(fa) === partOf.get(fb))
      push(e, 'rim', isWall(fa) ? fb : fa);
  }
  const walked = loops(mesh, free);
  const loopLength = walked.map((l) => {
    const e = l.members.at(-1) as BoundaryEdge;
    return e.start + length(sub(e.to, e.from));
  });
  // `m.surface` tags the faces of the cells its trim cuts (not all of them along the cut), and a
  // cut cell on a patch side owns side edges too: a loop is a trim loop when trim faces own at
  // least TRIM_SHARE of its length.
  const trim = mesh.tagIndex('trim', false);
  if (trim >= 0)
    for (const [k, l] of walked.entries()) {
      const trimmed = l.members.reduce(
        (s, e) => s + (mesh.hasTag(e.face, trim) ? length(sub(e.to, e.from)) : 0),
        0,
      );
      if (trimmed >= TRIM_SHARE * (loopLength[k] as number))
        for (const e of l.members) e.designed = 'trim';
    }
  const groups = walked.flatMap(runs);
  for (const [k, group] of groups.entries()) for (const e of group) e.chain = k;
  const grid = new SegmentGrid(
    free.map((e) => ({ a: e.from, b: e.to })),
    BEYOND * radius,
  );
  const index = new Map(free.map((e, i) => [e, i]));
  const facing = new Map<string, { gap: number; at: Tuple3; first: boolean; weight: number }[]>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);
  const beyond = new Map<number, number>();
  const chains: BoundaryChain[] = groups.map((group, id) => {
    let best: { gap: number; edge: BoundaryEdge } | undefined;
    let total = 0;
    const lo: Tuple3 = [...(group[0]?.from as Tuple3)];
    const hi: Tuple3 = [...lo];
    for (const e of group) {
      const d = sub(e.to, e.from);
      const len = length(d);
      total += len;
      for (const p of [e.from, e.to])
        for (let j = 0; j < 3; j++) {
          lo[j] = Math.min(lo[j] as number, p[j] as number);
          hi[j] = Math.max(hi[j] as number, p[j] as number);
        }
      if (!(len > 0)) continue;
      const t: Tuple3 = [d[0] / len, d[1] / len, d[2] / len];
      const pieces = Math.max(1, Math.ceil(len / SAMPLE));
      const own = index.get(e) as number;
      const closed = walked[e.loop]?.closed === true;
      const around = loopLength[e.loop] as number;
      for (let s = 0; s <= 2 * pieces; s++) {
        const u = s / (2 * pieces);
        const p = lerp(e.from, d, u);
        const arc = e.start + u * len;
        let nearest: { gap: number; edge: BoundaryEdge } | undefined;
        grid.near(p, (i) => {
          if (i === own) return;
          const o = free[i] as BoundaryEdge;
          const seg = grid.segments[i] as Segment;
          const v = closestOn(seg, p);
          const q = lerp(seg.a, sub(seg.b, seg.a), v);
          const gap = length(sub(q, p));
          if (gap > BEYOND * radius || (nearest !== undefined && gap >= nearest.gap)) return;
          if (gap > tolerance) {
            const across = sub(q, p);
            const along = sub(seg.b, seg.a);
            if (
              Math.abs(dot(across, t)) > FACING * gap ||
              Math.abs(dot(across, along)) > FACING * gap * length(along)
            )
              return;
          }
          if (o.loop === e.loop) {
            const along = Math.abs(o.start + v * length(sub(o.to, o.from)) - arc);
            if ((closed ? Math.min(along, around - along) : along) <= ALONG * gap + tolerance)
              return;
          }
          nearest = { gap, edge: o };
        });
        if (nearest === undefined) continue;
        if (nearest.gap > radius) {
          beyond.set(id, Math.min(beyond.get(id) ?? nearest.gap, nearest.gap));
          continue;
        }
        if (best === undefined || nearest.gap > best.gap) best = nearest;
        const other = nearest.edge.part;
        if (other === e.part) continue;
        const key = pairKey(e.part, other);
        const list = facing.get(key) ?? [];
        if (list.length === 0) facing.set(key, list);
        list.push({
          gap: nearest.gap,
          at: p,
          first: e.part < other,
          weight: len / (2 * pieces + 1),
        });
      }
    }
    const first = group[0] as BoundaryEdge;
    return {
      id,
      kind: first.kind,
      part: first.part,
      edges: group.length,
      length: total,
      closed:
        walked[first.loop]?.closed === true && group.length === walked[first.loop]?.members.length,
      ...(first.designed === undefined ? {} : { designed: first.designed }),
      gap: best?.gap ?? null,
      partner: best === undefined ? null : { part: best.edge.part, chain: best.edge.chain },
      at: halfway(group, total),
      bounds: [lo, hi],
    };
  });
  const reasons = pairReasons(mesh, declared, partOf, pairKey);
  const crossPart = [...facing.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([key, samples]): CrossPart => {
      const gaps = samples.map((x) => x.gap).sort((x, y) => x - y);
      const worst = samples.reduce((x, y) => (y.gap > x.gap ? y : x));
      const side = (first: boolean) =>
        samples.reduce((sum, x) => sum + (x.first === first ? x.weight : 0), 0);
      const designed = reasons.get(key)?.designed;
      return {
        parts: key.split('\n') as [string, string],
        ...(designed === undefined ? {} : { designed }),
        gap: {
          min: gaps[0] as number,
          median: gaps[(gaps.length - 1) >> 1] as number,
          max: gaps.at(-1) as number,
        },
        lengths: [side(true), side(false)],
        worst: worst.at,
      };
    });
  const issues: Issue<'mesh-open' | 't-junction'>[] = chains.map((c) => {
    const check = c.kind === 'free' ? 'free-chain' : 'rim-chain';
    if (c.designed !== undefined)
      return { code: 'mesh-open', severity: 'info', detail: { check, ...c } };
    const other = c.partner?.part;
    const reason = other === undefined ? undefined : reasons.get(pairKey(c.part, other))?.designed;
    const pair =
      other === undefined || other === c.part
        ? {}
        : {
            pair: {
              parts: pairKey(c.part, other).split('\n'),
              ...(reason === undefined ? {} : { designed: reason }),
            },
          };
    return {
      code: 'mesh-open',
      severity: 'error',
      detail: { check, ...c, repair: c.partner === null ? 'fill' : 'sew', ...pair },
    };
  });
  for (const x of crossPart) {
    const min = reasons.get(pairKey(...x.parts))?.min ?? 0;
    const clear = x.designed !== 'clearance' || x.gap.min >= min;
    issues.push({
      code: 'mesh-open',
      severity: x.designed === undefined || !clear ? 'error' : 'info',
      detail: { check: 'cross-part', ...x, ...(x.designed === 'clearance' ? { min } : {}) },
    });
  }
  for (const [chain, distance] of beyond)
    if (chains[chain]?.partner === null)
      issues.push({
        code: 'mesh-open',
        severity: 'info',
        detail: { check: 'beyond-radius', chain, part: chains[chain]?.part, distance, radius },
      });
  const tPart = new Map<string, number[]>();
  const vertexPart = new Map<number, string>();
  for (const e of free)
    if (e.kind === 'free')
      for (const v of mesh.edgeVertices(e.edge)) if (!vertexPart.has(v)) vertexPart.set(v, e.part);
  for (const v of tJunctions) {
    const part = vertexPart.get(v) as string;
    const list = tPart.get(part);
    if (list === undefined) tPart.set(part, [v]);
    else list.push(v);
  }
  for (const [part, vertices] of [...tPart].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    issues.push({
      code: 't-junction',
      severity: 'error',
      detail: { part, count: vertices.length, vertices: vertices.slice(0, MAX_LISTED) },
    });
  const names = [...new Set([...chains.map((c) => c.part), ...tPart.keys()])].sort();
  const parts = names.map(
    (part): WatertightPart => ({
      part,
      free: counts(chains.filter((c) => c.part === part && c.kind === 'free')),
      rim: counts(chains.filter((c) => c.part === part && c.kind === 'rim')),
      tJunctions: tPart.get(part)?.length ?? 0,
    }),
  );
  if (options.reference === undefined)
    return ok({ report: { radius, chains, parts, crossPart }, issues });
  const skin: number[] = [];
  for (const f of mesh.faces()) if (!isWall(f)) skin.push(f);
  const coverage = checkCoverage(mesh, skin, partOf, free, chains, radius, options.reference);
  if (!coverage.ok) return err(coverage.error);
  pushAll(issues, coverage.value.issues);
  return ok({
    report: { radius, chains, parts, crossPart, coverage: coverage.value.report },
    issues,
  });
}

function halfway(group: readonly BoundaryEdge[], total: number): Tuple3 {
  let left = total / 2;
  for (const e of group) {
    const d = sub(e.to, e.from);
    const len = length(d);
    if (left <= len && len > 0) return lerp(e.from, d, left / len);
    left -= len;
  }
  return (group.at(-1) as BoundaryEdge).to;
}

/** The DTS row kind (and clearance `min`) of each part pair by `pairKey`; a gap row wins. */
function pairReasons(
  mesh: EditMesh,
  declared: readonly DeclaredPair[],
  partOf: ReadonlyMap<number, string>,
  pairKey: (a: string, b: string) => string,
): Map<string, { readonly designed: 'shut-line' | 'clearance'; readonly min: number }> {
  const parts = new Map<number, Set<string>>(declared.map((d) => [d.own, new Set<string>()]));
  if (parts.size > 0)
    for (const [f, part] of partOf)
      for (const [tag, set] of parts) if (mesh.hasTag(f, tag)) set.add(part);
  const out = new Map<string, { designed: 'shut-line' | 'clearance'; min: number }>();
  for (const d of declared)
    for (const a of parts.get(d.own) ?? [])
      for (const b of parts.get(d.other) ?? [])
        if (a !== b && out.get(pairKey(a, b))?.designed !== 'shut-line')
          out.set(pairKey(a, b), { designed: d.designed, min: d.min });
  return out;
}

function counts(chains: readonly BoundaryChain[]): ChainCounts {
  const undesigned = chains.filter((c) => c.designed === undefined);
  const designed = { trim: 0, 'shut-line': 0, clearance: 0, open: 0 };
  for (const c of chains) if (c.designed !== undefined) designed[c.designed]++;
  const top = (list: readonly BoundaryChain[], key: (c: BoundaryChain) => number) =>
    list.reduce<BoundaryChain | undefined>(
      (a, c) => (a === undefined || key(c) > key(a) ? c : a),
      undefined,
    )?.id ?? null;
  const gapped = undesigned.filter((c) => c.gap !== null);
  return {
    designed,
    undesigned: undesigned.length,
    undesignedLength: undesigned.reduce((s, c) => s + c.length, 0),
    seams: gapped.length,
    holes: undesigned.length - gapped.length,
    longest: top(undesigned, (c) => c.length),
    widest: top(gapped, (c) => c.gap as number),
  };
}
