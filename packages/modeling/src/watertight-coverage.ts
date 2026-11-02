import { err, ok, type Result } from '@forgeax/engine-types';
import { refineSoup, type Soup, sampleDistances, surfaceSampleAreas } from './compute/mesh-query';
import { type ModelingError, modelingError } from './errors';
import { decodeSnapshot } from './fxem';
import { add, cross, dot, length, newell, scale, sub, type Tuple3, triangulateLoop } from './geom';
import { type EditMesh, FACE_EDGE_ROUND } from './mesh';
import type { Model } from './model';
import type { Issue } from './report';
import { DTS_ZONES, type DtsRow } from './shut-lines';
import type { DesignedBoundary } from './watertight';

/**
 * The design surface the skin must cover (`watertight.reference`): a model or FXEM snapshot,
 * every face. Its samples farther than `tolerance` from every skin face are uncovered unless
 * a designed boundary excuses them (see `CoverageReport.excluded`).
 */
export interface CoverageReference {
  readonly surface: Model | Uint8Array;
  /**
   * Largest distance from a reference sample to the skin, m: the bound on the reference's
   * own deviation from the designed skin, measured for the reference at hand (no default;
   * `CoverageReport.covered` shows the margin). It also sets the smallest visible hole: with
   * the reference `d` from the skin, a hole narrower than about `2 sqrt(tolerance^2 - d^2)`
   * keeps every sample within `tolerance` of its rim (8 mm with `d` = 6.7 mm: about 8.7 mm),
   * and a hole narrower than `spacing` can fall between samples.
   */
  readonly tolerance: number;
  /** Largest edge of the refined reference triangles, m (default 0.01). */
  readonly spacing?: number;
}

export interface CoverageReport {
  readonly tolerance: number;
  readonly spacing: number;
  readonly samples: number;
  /** Area of the reference, m^2. */
  readonly area: number;
  /** Area-weighted distance quantiles of the samples outside every exclusion band, m. */
  readonly interior: { readonly p50: number; readonly p95: number; readonly max: number };
  /**
   * Distance quantiles of the interior samples within `tolerance` (the margin to it), m, and
   * per part of their closest skin face.
   */
  readonly covered: CoveredDistances & {
    readonly parts: readonly (CoveredDistances & { readonly part: string | null })[];
  };
  /** Area of the interior samples farther than `tolerance`, m^2. */
  readonly uncovered: number;
  /**
   * Area of the samples a designed boundary excuses, per reason (and DTS row). The closest
   * skin point of an excused sample lies on a designed free or rim edge (within the width of
   * the `FACE_EDGE_ROUND` faces it lies on, `w`): `shut-line`, the sample is within the row's
   * widest gap + `w` of the edge; `clearance`, within `radius` + `w`; `trim` and `open`, the
   * sample lies on the opening side of the edge's in-surface normal (to within `w`) and inside
   * the sphere around the bounds of the edge's chain grown by `tolerance` + `w`.
   */
  readonly excluded: readonly {
    readonly reason: DesignedBoundary;
    readonly row?: string;
    readonly area: number;
    readonly share: number;
  }[];
}

export interface CoveredDistances {
  readonly p95: number;
  readonly max: number;
}

/** A free or rim edge of the skin with its classification, as `checkWatertight` walks it. */
export interface CoverageEdge {
  readonly from: Tuple3;
  readonly to: Tuple3;
  readonly face: number;
  readonly designed: DesignedBoundary | undefined;
  readonly row: DtsRow | undefined;
  readonly chain: number;
}

const SPACING = 0.01;
/** Largest reference sample count (about 4.5 per refined triangle). */
const MAX_SAMPLES = 4_000_000;
/** Distance within which a closest point lies on a boundary edge, m. */
const ON_EDGE = 1e-5;
/** Over-tolerance samples this many spacings apart join one region. */
const LINK = 1.5;
const NEIGHBORS = [0, -1, 1] as const;
const MAX_LISTED = 32;

function point(p: ArrayLike<number>, i: number): Tuple3 {
  return [p[i * 3] as number, p[i * 3 + 1] as number, p[i * 3 + 2] as number];
}

function meshSoup(mesh: EditMesh, faces: readonly number[]): { soup: Soup; face: Int32Array } {
  const corners: number[] = [];
  const face: number[] = [];
  for (const f of faces) {
    const vs = mesh.faceVertices(f);
    const local =
      triangulateLoop(vs.map((v) => mesh.position(v))) ??
      vs.slice(2).flatMap((_, i) => [0, i + 1, i + 2]);
    for (let k = 0; k < local.length; k += 3) {
      for (let j = 0; j < 3; j++) corners.push(vs[local[k + j] as number] as number);
      face.push(f);
    }
  }
  return {
    soup: { points: mesh.pos, corners: Int32Array.from(corners) },
    face: Int32Array.from(face),
  };
}

function budget(spacing: number): ModelingError {
  return modelingError(
    'model-work-budget',
    `at most ${MAX_SAMPLES} reference samples`,
    { spacing },
    'raise watertight.reference.spacing',
  );
}

function referenceSoup(
  surface: CoverageReference['surface'],
  spacing: number,
): Result<Soup, ModelingError> {
  const mesh = surface instanceof Uint8Array ? decodeSnapshot(surface) : ok(surface.editMesh);
  if (!mesh.ok) return err(mesh.error);
  const { soup } = meshSoup(mesh.value, mesh.value.faces());
  let triangles = 0;
  for (let t = 0; t < soup.corners.length / 3; t++) {
    let longest = 0;
    for (let k = 0; k < 3; k++) {
      const a = point(soup.points, soup.corners[t * 3 + k] as number);
      const b = point(soup.points, soup.corners[t * 3 + ((k + 1) % 3)] as number);
      longest = Math.max(longest, length(sub(b, a)));
    }
    const n = Math.max(1, Math.ceil(longest / spacing));
    triangles += n * n;
  }
  if (triangles * 4.5 > MAX_SAMPLES) return err(budget(spacing));
  return ok(refineSoup(soup, spacing));
}

/** Top of a gap row's band: the loosest of its zone, limits and exception. */
function gapTop(row: DtsRow): number {
  return Math.max(
    DTS_ZONES[row.zone ?? 'A'].gap[1],
    row.limits?.gap?.[1] ?? 0,
    row.exception?.limits.gap?.[1] ?? 0,
  );
}

/** Area-weighted quantile of the values with positive weight (sorted by value). */
function quantile(
  order: readonly number[],
  values: Float64Array,
  w: Float64Array,
  q: number,
): number {
  let total = 0;
  for (const i of order) total += w[i] as number;
  let acc = 0;
  for (const i of order) {
    acc += w[i] as number;
    if (acc >= q * total) return values[i] as number;
  }
  return order.length === 0 ? 0 : (values[order.at(-1) as number] as number);
}

/**
 * Reference coverage of the skin (`checkWatertight` with `reference`): uncovered regions are
 * `mesh-open` errors (`check: 'uncovered'`), regions wholly inside exclusion bands infos.
 */
export function checkCoverage(
  mesh: EditMesh,
  skin: readonly number[],
  partOf: ReadonlyMap<number, string>,
  edges: readonly CoverageEdge[],
  chains: readonly { readonly bounds: readonly [Tuple3, Tuple3] }[],
  radius: number,
  reference: CoverageReference,
): Result<{ report: CoverageReport; issues: Issue<'mesh-open'>[] }, ModelingError> {
  const tolerance = reference.tolerance;
  const spacing = reference.spacing ?? SPACING;
  for (const [name, value] of [
    ['tolerance', tolerance],
    ['spacing', spacing],
  ] as const)
    if (!(Number.isFinite(value) && value > 0))
      return err(
        modelingError(
          'model-invalid-argument',
          `watertight.reference.${name} is a positive number of meters`,
          { [name]: value },
        ),
      );
  const ref = referenceSoup(reference.surface, spacing);
  if (!ref.ok) return err(ref.error);
  const model = meshSoup(mesh, skin);
  const sampled = sampleDistances(ref.value, model.soup);
  const weight = surfaceSampleAreas(ref.value.points, ref.value.corners);
  const n = sampled.samples.length;
  const distance = Float64Array.from(sampled.distance, (d) =>
    Number.isNaN(d) ? Number.POSITIVE_INFINITY : d,
  );

  const boundary = new BoundaryIndex(edges, radius);
  const widths = new RoundWidths(mesh, partOf, boundary, radius);
  // Exclusion per sample: -1 interior, else an index into `bands`.
  const bands: { reason: DesignedBoundary; row?: string }[] = [];
  const bandOf = new Map<string, number>();
  const band = (reason: DesignedBoundary, row?: string) => {
    const key = `${reason}\n${row ?? ''}`;
    let b = bandOf.get(key);
    if (b === undefined) {
      b = bands.length;
      bands.push(row === undefined ? { reason } : { reason, row });
      bandOf.set(key, b);
    }
    return b;
  };
  const excluded = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const t = sampled.closest[i] as number;
    if (t < 0) continue;
    const f = model.face[t] as number;
    const q = point(sampled.point, i);
    const w = widths.of(f);
    const hit = boundary.nearest(q, w + ON_EDGE);
    if (hit === undefined) continue;
    const s = sampled.samples[i] as Tuple3;
    const e = edges[hit.edge] as CoverageEdge;
    if (e.designed === undefined) continue;
    let excused: boolean;
    switch (e.designed) {
      case 'shut-line':
        excused = length(sub(s, hit.at)) <= (e.row === undefined ? 0 : gapTop(e.row)) + w;
        break;
      case 'clearance':
        excused = length(sub(s, hit.at)) <= radius + w;
        break;
      case 'trim':
      case 'open': {
        // The chain's extent is its bounding sphere: an opening's surface bulges out of the
        // chain's box (a dome over a circular trim) but not out of the sphere around it.
        // A sample across the opening lies more beyond the edge than off the surface; one
        // merely lifted off the surface at the edge (an offset skin) is not. Along the edge
        // (past a chain's end) counts as neither.
        const [lo, hi] = (chains[e.chain] as { bounds: readonly [Tuple3, Tuple3] }).bounds;
        const center = scale(add(lo, hi), 0.5);
        const d = sub(s, hit.at);
        const run = sub(e.to, e.from);
        const runLength = length(run);
        const along = runLength > 0 ? dot(d, run) / runLength : 0;
        const across = dot(d, boundary.outward(mesh, hit.edge));
        const off = Math.sqrt(Math.max(0, dot(d, d) - across * across - along * along));
        excused =
          across >= -w &&
          (across >= off || off <= tolerance + w) &&
          length(sub(s, center)) <= length(sub(hi, center)) + tolerance + w;
        break;
      }
    }
    if (excused) excluded[i] = band(e.designed, e.row?.id);
  }

  let area = 0;
  let uncovered = 0;
  const bandArea = new Float64Array(bands.length);
  const interior: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = weight[i] as number;
    area += w;
    const b = excluded[i] as number;
    if (b >= 0) bandArea[b] = (bandArea[b] as number) + w;
    else {
      if (w > 0) interior.push(i);
      if ((distance[i] as number) > tolerance) uncovered += w;
    }
  }
  interior.sort((a, b) => (distance[a] as number) - (distance[b] as number) || a - b);

  const issues = coverageRegions(
    sampled.samples,
    distance,
    weight,
    excluded,
    tolerance,
    spacing,
  ).map((members): Issue<'mesh-open'> => {
    const lo: Tuple3 = [Infinity, Infinity, Infinity];
    const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
    const at: Tuple3 = [0, 0, 0];
    let total = 0;
    let open = 0;
    let worst = members[0] as number;
    const share = new Map<number, number>();
    for (const i of members) {
      const p = sampled.samples[i] as Tuple3;
      const w = weight[i] as number;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] as number, p[k] as number);
        hi[k] = Math.max(hi[k] as number, p[k] as number);
        at[k] = (at[k] as number) + (p[k] as number) * w;
      }
      total += w;
      const b = excluded[i] as number;
      if (b < 0) {
        open += w;
        if (
          (distance[i] as number) > (distance[worst] as number) ||
          (excluded[worst] as number) >= 0
        )
          worst = i;
      } else share.set(b, (share.get(b) ?? 0) + w);
    }
    const centroid = (total > 0 ? at.map((x) => x / total) : sampled.samples[worst]) as Tuple3;
    const t = sampled.closest[worst] as number;
    const detail = {
      check: 'uncovered',
      area: total,
      maxDistance: Number.isFinite(distance[worst] as number) ? distance[worst] : null,
      at: centroid,
      bounds: [lo, hi],
      part: t < 0 ? null : (partOf.get(model.face[t] as number) ?? null),
      excluded: [...share]
        .sort((a, b) => a[0] - b[0])
        .map(([b, a]) => ({ ...bands[b], area: a, share: total > 0 ? a / total : 0 })),
    };
    return open > 0
      ? { code: 'mesh-open', severity: 'error', detail: { ...detail, uncovered: open } }
      : { code: 'mesh-open', severity: 'info', detail };
  });

  const top = (q: number) => quantile(interior, distance, weight, q);
  const within = interior.filter((i) => (distance[i] as number) <= tolerance);
  const byPart = new Map<string | null, number[]>();
  for (const i of within) {
    const t = sampled.closest[i] as number;
    const part = t < 0 ? null : (partOf.get(model.face[t] as number) ?? null);
    const list = byPart.get(part);
    if (list === undefined) byPart.set(part, [i]);
    else list.push(i);
  }
  const spread = (order: readonly number[]): CoveredDistances => ({
    p95: quantile(order, distance, weight, 0.95),
    max: order.length === 0 ? 0 : (distance[order.at(-1) as number] as number),
  });
  return ok({
    report: {
      tolerance,
      spacing,
      samples: n,
      area,
      interior: {
        p50: top(0.5),
        p95: top(0.95),
        max: interior.length === 0 ? 0 : (distance[interior.at(-1) as number] as number),
      },
      covered: {
        ...spread(within),
        parts: [...byPart]
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
          .map(([part, order]) => ({ part, ...spread(order) })),
      },
      uncovered,
      excluded: bands.map((b, k) => ({
        ...b,
        area: bandArea[k] as number,
        share: area > 0 ? (bandArea[k] as number) / area : 0,
      })),
    },
    issues: issues.slice(0, MAX_LISTED),
  });
}

/** @internal Over-tolerance samples linked within LINK spacings, largest area first. */
export function coverageRegions(
  samples: readonly Tuple3[],
  distance: Float64Array,
  weight: Float64Array,
  excluded: Int32Array,
  tolerance: number,
  spacing: number,
): number[][] {
  const over: number[] = [];
  for (let i = 0; i < samples.length; i++) if ((distance[i] as number) > tolerance) over.push(i);
  const parent = new Int32Array(over.length).map((_, k) => k);
  const find = (k: number): number => {
    while (parent[k] !== k) {
      parent[k] = parent[parent[k] as number] as number;
      k = parent[k] as number;
    }
    return k;
  };
  const link = LINK * spacing;
  const cells = new Map<string, number[][]>();
  const cellOf = (p: Tuple3) => p.map((x) => Math.floor(x / link)) as Tuple3;
  for (const [k, i] of over.entries()) {
    const p = samples[i] as Tuple3;
    const c = cellOf(p);
    let root = k;
    for (const dx of NEIGHBORS)
      for (const dy of NEIGHBORS)
        for (const dz of NEIGHBORS)
          for (const members of cells.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
            const other = find(members[0] as number);
            if (root === other) continue;
            for (const m of members) {
              if (!(length(sub(samples[over[m] as number] as Tuple3, p)) <= link)) continue;
              const previous = root;
              root = Math.min(root, other);
              parent[Math.max(previous, other)] = root;
              break;
            }
          }
    const key = `${c[0]},${c[1]},${c[2]}`;
    const bucket = cells.get(key) ?? [];
    // Every list is already connected, so one new edge joins all its members.
    const members = bucket.find((list) => find(list[0] as number) === root);
    if (members === undefined) bucket.push([k]);
    else members.push(k);
    cells.set(key, bucket);
  }
  const groups = new Map<number, number[]>();
  for (const [k, i] of over.entries()) {
    const r = find(k);
    const g = groups.get(r);
    if (g === undefined) groups.set(r, [i]);
    else g.push(i);
  }
  const size = (g: readonly number[]) => g.reduce((s, i) => s + (weight[i] as number), 0);
  const open = (g: readonly number[]) => g.some((i) => (excluded[i] as number) < 0);
  return [...groups.values()].sort(
    (a, b) =>
      Number(open(b)) - Number(open(a)) || size(b) - size(a) || (a[0] as number) - (b[0] as number),
  );
}

/** The skin's boundary edges bucketed by `radius`. */
class BoundaryIndex {
  private readonly cells = new Map<string, number[]>();
  private readonly normals = new Map<number, Tuple3>();

  readonly edges: readonly CoverageEdge[];
  private readonly cell: number;

  constructor(edges: readonly CoverageEdge[], cell: number) {
    this.edges = edges;
    this.cell = cell;
    for (const [i, e] of edges.entries()) {
      const d = sub(e.to, e.from);
      const pieces = Math.max(1, Math.ceil(length(d) / cell));
      const seen = new Set<string>();
      for (let k = 0; k <= pieces; k++) {
        const p = e.from.map((x, j) => x + ((d[j] as number) * k) / pieces) as Tuple3;
        const key = p.map((x) => Math.floor(x / cell)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const list = this.cells.get(key);
        if (list === undefined) this.cells.set(key, [i]);
        else list.push(i);
      }
    }
  }

  /** Each edge within about one cell of `p`, once. */
  near(p: Tuple3, visit: (i: number) => void): void {
    const c = p.map((x) => Math.floor(x / this.cell)) as Tuple3;
    const seen = new Set<number>();
    for (let x = c[0] - 1; x <= c[0] + 1; x++)
      for (let y = c[1] - 1; y <= c[1] + 1; y++)
        for (let z = c[2] - 1; z <= c[2] + 1; z++)
          for (const i of this.cells.get(`${x},${y},${z}`) ?? [])
            if (!seen.has(i)) {
              seen.add(i);
              visit(i);
            }
  }

  /** The closest edge to `p` within `within` (ties keep the lower index). */
  nearest(p: Tuple3, within: number): { edge: number; at: Tuple3; distance: number } | undefined {
    let best: { edge: number; at: Tuple3; distance: number } | undefined;
    this.near(p, (i) => {
      const e = this.edges[i] as CoverageEdge;
      const d = sub(e.to, e.from);
      const span = dot(d, d);
      const t = span > 0 ? Math.min(1, Math.max(0, dot(sub(p, e.from), d) / span)) : 0;
      const at = e.from.map((x, j) => x + (d[j] as number) * t) as Tuple3;
      const distance = length(sub(p, at));
      if (distance > within) return;
      if (
        best === undefined ||
        distance < best.distance ||
        (distance === best.distance && i < best.edge)
      )
        best = { edge: i, at, distance };
    });
    return best;
  }

  /** The in-surface direction across edge `i`, away from its face. */
  outward(mesh: EditMesh, i: number): Tuple3 {
    let out = this.normals.get(i);
    if (out !== undefined) return out;
    const e = this.edges[i] as CoverageEdge;
    const ring = mesh.faceVertices(e.face).map((v) => mesh.position(v));
    const across = cross(sub(e.to, e.from), newell(ring));
    const centre = ring
      .reduce<Tuple3>((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0])
      .map((x) => x / ring.length) as Tuple3;
    const mid = e.from.map((x, j) => (x + (e.to[j] as number)) / 2) as Tuple3;
    const len = length(across);
    const sign = dot(across, sub(mid, centre)) < 0 ? -1 : 1;
    out = len > 0 ? (across.map((x) => (sign * x) / len) as Tuple3) : [0, 0, 0];
    this.normals.set(i, out);
    return out;
  }
}

/**
 * Width of the edge round a skin face belongs to: the farthest vertex of its connected
 * `FACE_EDGE_ROUND` region (same part) from the region's nearest boundary edge, at most
 * `radius`; 0 for other faces.
 */
class RoundWidths {
  private readonly width = new Map<number, number>();

  private readonly mesh: EditMesh;
  private readonly partOf: ReadonlyMap<number, string>;
  private readonly boundary: BoundaryIndex;
  private readonly radius: number;

  constructor(
    mesh: EditMesh,
    partOf: ReadonlyMap<number, string>,
    boundary: BoundaryIndex,
    radius: number,
  ) {
    this.mesh = mesh;
    this.partOf = partOf;
    this.boundary = boundary;
    this.radius = radius;
  }

  private isRound(f: number): boolean {
    return ((this.mesh.fFlags[f] as number) & FACE_EDGE_ROUND) !== 0;
  }

  of(f: number): number {
    if (!this.isRound(f)) return 0;
    const known = this.width.get(f);
    if (known !== undefined) return known;
    const mesh = this.mesh;
    const part = this.partOf.get(f);
    const region = [f];
    const inside = new Set(region);
    for (let k = 0; k < region.length; k++)
      for (const h of mesh.faceHalves(region[k] as number)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (g < 0 || inside.has(g) || !this.isRound(g) || this.partOf.get(g) !== part) continue;
        inside.add(g);
        region.push(g);
      }
    const vertices = new Set(region.flatMap((g) => mesh.faceVertices(g)));
    let width = 0;
    for (const v of vertices) {
      const hit = this.boundary.nearest(mesh.position(v), this.radius);
      if (hit !== undefined) width = Math.max(width, hit.distance);
    }
    for (const g of region) this.width.set(g, width);
    return width;
  }
}
