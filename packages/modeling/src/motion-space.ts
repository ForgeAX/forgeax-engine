import { err, ok, type Result } from '@forgeax/engine-types';
import { type Affine, applyPoint, IDENTITY, invertRigid } from './affine';
import { encodeSdf } from './compute/voxel-ts';
import { hypot3 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { encodeSnapshot } from './fxem';
import type { Tuple3 } from './geom';
import { EditMesh } from './mesh';
import { model } from './model';
import { coverageOf, type Issue } from './report';
import type {
  ClaimConflict,
  JointRecord,
  JointValue,
  PhaseClaim,
  PhaseClaimsCode,
  PhaseClaimsOptions,
  PhaseClaimsReport,
  PoseOptions,
  PosePath,
  ResolvedPart,
  Rig,
  RigSweepOptions,
} from './rig';
import { finite } from './rig';
import { SdfGrid } from './voxel';

/** Cell indices per axis stay within +-2^16, so a cell key fits a double exactly. */
const SPAN = 1 << 16;
const SIDE = 2 * SPAN;

/** @internal The key of lattice cell (i, j, k), or undefined outside the lattice range. */
export function cellKey(i: number, j: number, k: number): number | undefined {
  if (Math.abs(i) >= SPAN || Math.abs(j) >= SPAN || Math.abs(k) >= SPAN) return undefined;
  return ((i + SPAN) * SIDE + (j + SPAN)) * SIDE + (k + SPAN);
}

function cellOf(key: number): Tuple3 {
  const k = (key % SIDE) - SPAN;
  const rest = Math.floor(key / SIDE);
  return [Math.floor(rest / SIDE) - SPAN, (rest % SIDE) - SPAN, k];
}

/**
 * The space parts occupy along a motion: the cells of the world lattice of spacing `voxel`
 * (cell (i, j, k) is the cube from (i, j, k) * voxel to (i + 1, j + 1, k + 1) * voxel). Sweeps of
 * one voxel size share the lattice, so they compare cell by cell.
 */
export class SweptVolume {
  /** @internal */
  readonly _voxel: number;
  /** @internal */
  readonly _cells: ReadonlySet<number>;

  constructor(voxel: number, cells: ReadonlySet<number>) {
    this._voxel = voxel;
    this._cells = cells;
  }

  get count(): number {
    return this._cells.size;
  }

  /** Cubic meters: count x voxel^3. */
  get volume(): number {
    return this._cells.size * this._voxel * this._voxel * this._voxel;
  }

  /** The box of the occupied cells, or null when empty. */
  get bounds(): readonly [Tuple3, Tuple3] | null {
    return boundsOf(this._cells, this._voxel);
  }

  /** True when the cell containing `p` is occupied. */
  has(p: Tuple3): boolean {
    const key = cellKey(
      Math.floor(p[0] / this._voxel),
      Math.floor(p[1] / this._voxel),
      Math.floor(p[2] / this._voxel),
    );
    return key !== undefined && this._cells.has(key);
  }

  /** The cells of both sweeps (one voxel size). */
  union(other: SweptVolume): Result<SweptVolume, ModelingError> {
    const same = sameLattice(this, other);
    if (!same.ok) return same;
    return ok(new SweptVolume(this._voxel, new Set([...this._cells, ...other._cells])));
  }

  /**
   * A distance grid of the occupied cells (-voxel / 2 at their centres, +voxel / 2 elsewhere),
   * for `model.voxel.toMesh` to draw the swept volume.
   */
  sdf(): SdfGrid {
    const box = this.bounds;
    if (box === null) return SdfGrid.empty;
    const h = this._voxel;
    const lo = box[0].map((x) => Math.round(x / h) - 1) as Tuple3;
    const dims = box[1].map((x, d) => Math.round(x / h) - (lo[d] as number) + 1) as [
      number,
      number,
      number,
    ];
    const n = dims[0] * dims[1] * dims[2];
    const values = new Float64Array(n).fill(h / 2);
    for (const key of this._cells) {
      const [i, j, k] = cellOf(key);
      values[i - lo[0] + dims[0] * (j - lo[1] + dims[1] * (k - lo[2]))] = -h / 2;
    }
    const data = {
      origin: lo.map((c) => (c + 0.5) * h) as Tuple3,
      voxelSize: h,
      dims,
      band: 1,
      values,
      nearest: new Int32Array(n).fill(-1),
    };
    // No source faces: the drawn surface carries no tags or materials over.
    return new SdfGrid(data, encodeSdf(data), encodeSnapshot(new EditMesh()));
  }
}

export interface SweepOverlap {
  readonly count: number;
  readonly volume: number;
  /** The box of the shared cells and their centroid, or null without any. */
  readonly bounds: readonly [Tuple3, Tuple3] | null;
  readonly centroid: Tuple3 | null;
}

/** The cells two sweeps of one voxel size share. */
export function sweepOverlap(a: SweptVolume, b: SweptVolume): Result<SweepOverlap, ModelingError> {
  const same = sameLattice(a, b);
  if (!same.ok) return same;
  return ok(overlapOf(intersect(a._cells, b._cells), a._voxel));
}

/** @internal */
export function intersect(a: ReadonlySet<number>, b: ReadonlySet<number>): Set<number> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<number>();
  for (const key of small) if (large.has(key)) out.add(key);
  return out;
}

/** @internal */
export function overlapOf(shared: ReadonlySet<number>, voxel: number): SweepOverlap {
  const sum: Tuple3 = [0, 0, 0];
  for (const key of shared) {
    const c = cellOf(key);
    for (let d = 0; d < 3; d++) sum[d] = (sum[d] as number) + ((c[d] as number) + 0.5) * voxel;
  }
  const n = shared.size;
  return {
    count: n,
    volume: n * voxel * voxel * voxel,
    bounds: boundsOf(shared, voxel),
    centroid: n === 0 ? null : (sum.map((s) => s / n) as Tuple3),
  };
}

function sameLattice(a: SweptVolume, b: SweptVolume): Result<void, ModelingError> {
  if (a._voxel !== b._voxel) {
    return err(
      modelingError(
        'model-invalid-argument',
        'sweeps of one voxel size',
        { voxels: [a._voxel, b._voxel] },
        'sweep both with the same voxel',
      ),
    );
  }
  return ok(undefined);
}

function boundsOf(cells: ReadonlySet<number>, voxel: number): readonly [Tuple3, Tuple3] | null {
  if (cells.size === 0) return null;
  const lo: Tuple3 = [Infinity, Infinity, Infinity];
  const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const key of cells) {
    const c = cellOf(key);
    for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d] as number, c[d] as number);
      hi[d] = Math.max(hi[d] as number, (c[d] as number) + 1);
    }
  }
  return [lo.map((x) => x * voxel) as Tuple3, hi.map((x) => x * voxel) as Tuple3];
}

/** @internal A part ready to sweep: its rest-frame distance field and rest box. */
export interface SweepSource {
  readonly name: string;
  /** Closed parts occupy their inside too; open ones only the band around their faces. */
  readonly closed: boolean;
  readonly sdf: SdfGrid;
  readonly box: readonly [Tuple3, Tuple3];
}

/** Sample budget of one sweep. */
export const SWEEP_SAMPLES = 1 << 14;

function corners(box: readonly [Tuple3, Tuple3]): Tuple3[] {
  const out: Tuple3[] = [];
  for (let c = 0; c < 8; c++) {
    out.push([0, 1, 2].map((d) => ((c >> d) & 1 ? box[1][d] : box[0][d]) as number) as Tuple3);
  }
  return out;
}

/**
 * @internal The samples of u in [u0, u1] (and the keys inside it) refined until no point of
 * any part moves more than `travel` between neighbours: a rigid motion displaces the points
 * of a box at most as far as its farthest corner (the displacement is affine in the point).
 */
export function sweepSamples(
  range: readonly [number, number],
  keys: readonly number[],
  deltasAt: (u: number) => Result<readonly Affine[], ModelingError>,
  boxes: readonly (readonly [Tuple3, Tuple3])[],
  travel: number,
): Result<{ readonly u: number; readonly deltas: readonly Affine[] }[], ModelingError> {
  const [u0, u1] = range;
  const start = new Set<number>([u0, u1]);
  for (let i = 1; i < 32; i++) start.add(u0 + ((u1 - u0) * i) / 32);
  for (const k of keys) if (k > u0 && k < u1) start.add(k);
  const points = boxes.map(corners);
  const at = (u: number) => {
    const d = deltasAt(u);
    return d.ok ? ok({ u, deltas: d.value }) : d;
  };
  const moved = (a: readonly Affine[], b: readonly Affine[]) => {
    let worst = 0;
    for (const [part, cs] of points.entries()) {
      for (const c of cs) {
        const p = applyPoint(a[part] as Affine, c);
        const q = applyPoint(b[part] as Affine, c);
        worst = Math.max(worst, hypot3(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
    }
    return worst;
  };
  const out: { u: number; deltas: readonly Affine[] }[] = [];
  for (const u of [...start].sort((a, b) => a - b)) {
    const s = at(u);
    if (!s.ok) return s;
    out.push(s.value);
  }
  for (let i = 0; i + 1 < out.length; ) {
    const a = out[i] as { u: number; deltas: readonly Affine[] };
    const b = out[i + 1] as { u: number; deltas: readonly Affine[] };
    if (moved(a.deltas, b.deltas) <= travel || b.u - a.u < 1e-9) {
      i++;
      continue;
    }
    if (out.length >= SWEEP_SAMPLES) {
      return err(
        modelingError(
          'model-work-budget',
          `a sweep within ${SWEEP_SAMPLES} samples`,
          { voxelTravel: travel, u: a.u },
          'raise voxel (samples grow with motion / voxel) or sweep a shorter range or fewer parts',
        ),
      );
    }
    const mid = at((a.u + b.u) / 2);
    if (!mid.ok) return mid;
    out.splice(i + 1, 0, mid.value);
  }
  return ok(out);
}

/**
 * @internal Mark the cells a part occupies at `delta` (rest to posed): cells whose centre is
 * within `reach` of the part (inside it, for a closed part).
 */
export function occupy(
  source: SweepSource,
  delta: Affine,
  voxel: number,
  reach: number,
  cells: Set<number>,
): Result<void, ModelingError> {
  const lo: Tuple3 = [Infinity, Infinity, Infinity];
  const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const c of corners(source.box)) {
    const p = applyPoint(delta, c);
    for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d] as number, (p[d] as number) - reach);
      hi[d] = Math.max(hi[d] as number, (p[d] as number) + reach);
    }
  }
  const toRest = invertRigid(delta);
  const [i0, j0, k0] = lo.map((x) => Math.floor(x / voxel - 0.5)) as Tuple3;
  const [i1, j1, k1] = hi.map((x) => Math.ceil(x / voxel - 0.5)) as Tuple3;
  for (let k = k0; k <= k1; k++) {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = cellKey(i, j, k);
        if (key === undefined) {
          return err(
            modelingError(
              'model-invalid-argument',
              `swept cells within ${SPAN} voxels of the origin`,
              { voxel, cell: [i, j, k], part: source.name },
              'raise voxel',
            ),
          );
        }
        if (cells.has(key)) continue;
        const v = source.sdf.sample(
          applyPoint(toRest, [(i + 0.5) * voxel, (j + 0.5) * voxel, (k + 0.5) * voxel]),
        );
        if ((source.closed ? v : Math.abs(v)) <= reach) cells.add(key);
      }
    }
  }
  return ok(undefined);
}

/** @internal The body of `Rig.sweep`. */
export function rigSweep(
  r: Rig,
  path: PosePath,
  options: RigSweepOptions,
): Result<SweptVolume, ModelingError> {
  const all = r._resolve();
  if (!all.ok) return all;
  const parts = options.parts ?? all.value.map((p) => p.name);
  const picked = sweepParts(r, all.value, parts, options.voxel);
  if (!picked.ok) return picked;
  const swept = sweepCells(r, path, picked.value, options.u ?? [0, 1], options);
  if (!swept.ok) return swept;
  const cells = new Set<number>();
  for (const c of swept.value) for (const key of c) cells.add(key);
  return ok(new SweptVolume(options.voxel, cells));
}

/** @internal The body of `Rig.phaseClaims`. */
export function rigPhaseClaims(
  r: Rig,
  path: PosePath,
  options: PhaseClaimsOptions,
): Result<PhaseClaimsReport, ModelingError> {
  const all = r._resolve();
  if (!all.ok) return all;
  const parts = all.value;
  for (const phase of options.phases) {
    const [u0, u1] = phase.u;
    const unknown = (phase.joints ?? []).filter((j) => !r._table.some((t) => t.name === j));
    if (unknown.length > 0) {
      return err(
        modelingError('model-invalid-argument', 'phase joints that exist in the rig', {
          phase: phase.id,
          unknown,
        }),
      );
    }
    if (!(finite(u0, u1) && u0 >= 0 && u1 <= 1 && u0 < u1)) {
      return err(
        modelingError('model-invalid-argument', 'phase windows 0 <= u0 < u1 <= 1', {
          phase: phase.id,
          u: phase.u,
        }),
      );
    }
  }
  const designed = new Set((options.contacts ?? []).map((c) => [...c.parts].sort().join('\u0000')));
  const exempt = (a: string, b: string) => designed.has([a, b].sort().join('\u0000'));
  const sources = sweepParts(
    r,
    parts,
    parts.map((p) => p.name),
    options.voxel,
  );
  if (!sources.ok) return sources;
  // Pass 1: each phase's sweep per part, and which parts move in it.
  const swept: { cells: Set<number>[]; moves: boolean[] }[] = [];
  for (const phase of options.phases) {
    const cells = sweepCells(r, path, sources.value, phase.u, options);
    if (!cells.ok) return cells;
    const still = sweepCells(r, path, sources.value, [phase.u[0], phase.u[0]], options);
    if (!still.ok) return still;
    const moves = cells.value.map((c, k) => c.size > (still.value[k] as Set<number>).size);
    swept.push({
      cells: cells.value.map((c, k) => (moves[k] ? c : (still.value[k] as Set<number>))),
      moves,
    });
  }
  const overlaps = (a: number, b: number) => {
    const [p, q] = [options.phases[a], options.phases[b]] as [
      PhaseClaimsOptions['phases'][number],
      PhaseClaimsOptions['phases'][number],
    ];
    return a === b || (p.u[0] < q.u[1] && q.u[0] < p.u[1]);
  };
  const declared = options.phases.map((phase, i) =>
    sources.value.map(({ part }, k) => {
      if (!(swept[i] as { moves: boolean[] }).moves[k]) return false;
      if (phase.joints === undefined) return true;
      for (let j = part.joint; j >= 0; j = (r._table[j] as JointRecord).parent) {
        // A phase that declares a leader declares its followers.
        for (let k = j; k >= 0; k = (r._table[k] as JointRecord).mimic?.leader ?? -1) {
          if (phase.joints.includes((r._table[k] as JointRecord).name)) return true;
        }
      }
      return false;
    }),
  );
  // Pass 2: a part moving in a window that no overlapping phase declares is still a mover
  // there (`unclaimed`: drive members keyed through extra, loop links).
  const claims: PhaseClaim[] = [];
  const conflicts: ClaimConflict[] = [];
  const own = options.phases.map((_, i) =>
    sources.value.flatMap((_s, k) => ((declared[i] as boolean[])[k] ? [k] : [])),
  );
  const unclaimedOf = options.phases.map((_, i) =>
    sources.value.flatMap((_s, k) =>
      (swept[i] as { moves: boolean[] }).moves[k] &&
      !options.phases.some((_p, q) => overlaps(i, q) && (declared[q] as boolean[])[k])
        ? [k]
        : [],
    ),
  );
  // A phase's movers: its declared parts and the parts nobody declares.
  const movers = options.phases.map((_, i) => [
    ...(own[i] as number[]),
    ...(unclaimedOf[i] as number[]),
  ]);
  const subjects: Record<'static-conflict' | 'concurrent-conflict', string[]> = {
    'static-conflict': [],
    'concurrent-conflict': [],
  };
  const done: Record<'static-conflict' | 'concurrent-conflict', Set<string>> = {
    'static-conflict': new Set(),
    'concurrent-conflict': new Set(),
  };
  for (const [i, phase] of options.phases.entries()) {
    for (const [k, { source }] of sources.value.entries()) {
      const id = `${phase.id}/${source.name}`;
      subjects['static-conflict'].push(id);
      if ((swept[i] as { moves: boolean[] }).moves[k]) subjects['concurrent-conflict'].push(id);
    }
    for (const k of movers[i] as number[]) {
      const id = `${phase.id}/${(sources.value[k] as { source: SweepSource }).source.name}`;
      done['static-conflict'].add(id);
      done['concurrent-conflict'].add(id);
    }
    for (const [k, { source }] of sources.value.entries()) {
      if (!(swept[i] as { moves: boolean[] }).moves[k])
        done['static-conflict'].add(`${phase.id}/${source.name}`);
    }
  }
  for (const [i, phase] of options.phases.entries()) {
    const unclaimed = unclaimedOf[i] as number[];
    const union = new Set<number>();
    for (const k of movers[i] as number[]) {
      for (const key of (swept[i] as { cells: Set<number>[] }).cells[k] as Set<number>)
        union.add(key);
    }
    const summary = overlapOf(union, options.voxel);
    const name = (k: number) => (sources.value[k] as { source: SweepSource }).source.name;
    claims.push({
      phase: phase.id,
      u: phase.u,
      parts: (own[i] as number[]).map(name),
      unclaimed: unclaimed.map(name),
      count: summary.count,
      volume: summary.volume,
      bounds: summary.bounds,
    });
    for (const m of movers[i] as number[]) {
      for (const [k] of sources.value.entries()) {
        if ((swept[i] as { moves: boolean[] }).moves[k] || exempt(name(m), name(k))) continue;
        const shared = intersect(
          (swept[i] as { cells: Set<number>[] }).cells[m] as Set<number>,
          (swept[i] as { cells: Set<number>[] }).cells[k] as Set<number>,
        );
        if (shared.size > 0) {
          conflicts.push({
            kind: 'static',
            phases: [phase.id],
            parts: [name(m), name(k)],
            ...overlapOf(shared, options.voxel),
          });
        }
      }
    }
  }
  // Movers of one phase, or of overlapping phases, that move relative to each other claim
  // their cells at the same time: a timing hazard even when the sampled scan finds them apart.
  const seen = new Set<string>();
  for (let a = 0; a < options.phases.length; a++) {
    for (let b = a; b < options.phases.length; b++) {
      if (!overlaps(a, b)) continue;
      const pa = options.phases[a] as PhaseClaimsOptions['phases'][number];
      const pb = options.phases[b] as PhaseClaimsOptions['phases'][number];
      const shared: readonly [number, number] = [
        Math.max(pa.u[0], pb.u[0]),
        Math.min(pa.u[1], pb.u[1]),
      ];
      const relative = relativeMotion(r, path, parts, shared, options);
      if (!relative.ok) return relative;
      for (const m of movers[a] as number[]) {
        for (const n of movers[b] as number[]) {
          if (m === n || (a === b && n < m)) continue;
          const [x, y] = [
            (sources.value[m] as { source: SweepSource }).source.name,
            (sources.value[n] as { source: SweepSource }).source.name,
          ];
          const key = `${[x, y].sort().join('\u0000')}\u0000${pa.id}\u0000${pb.id}`;
          if (seen.has(key) || exempt(x, y) || !relative.value(m, n)) continue;
          seen.add(key);
          const cells = intersect(
            (swept[a] as { cells: Set<number>[] }).cells[m] as Set<number>,
            (swept[b] as { cells: Set<number>[] }).cells[n] as Set<number>,
          );
          if (cells.size > 0) {
            conflicts.push({
              kind: 'concurrent',
              phases: a === b ? [pa.id] : [pa.id, pb.id],
              parts: [x, y],
              ...overlapOf(cells, options.voxel),
            });
          }
        }
      }
    }
  }
  const coverage = coverageOf(subjects, done);
  const issues: Issue<PhaseClaimsCode>[] = conflicts.map((c) => ({
    code: c.kind === 'static' ? 'static-conflict' : 'concurrent-conflict',
    severity: 'error',
    detail: { phases: c.phases, parts: c.parts, count: c.count, volume: c.volume },
  }));
  if (coverage.checked.length === 0)
    issues.push({ code: 'nothing-checked', severity: 'error', detail: {} });
  return ok({
    voxel: options.voxel,
    claims,
    conflicts,
    pass: issues.length === 0,
    issues,
    coverage,
  });
}

/**
 * Whether two parts can move relative to each other over u in `range`: a joint between them
 * (below their common ancestor) changes value at one of 9 samples. Parts carried by the same
 * moving joints only are rigidly linked and cannot meet by timing.
 */
export function relativeMotion(
  r: Rig,
  path: PosePath,
  parts: readonly ResolvedPart[],
  range: readonly [number, number],
  options: PoseOptions,
): Result<(a: number, b: number) => boolean, ModelingError> {
  const values: (JointValue | null)[][] = [];
  for (let i = 0; i <= 8; i++) {
    const sampled = r.sample(path, range[0] + ((range[1] - range[0]) * i) / 8);
    if (!sampled.ok) return sampled;
    const posed = r.pose(sampled.value, options);
    if (!posed.ok) return posed;
    values.push(posed.value.joints.map((j) => j.value));
  }
  const moving = r._table.map((_, j) =>
    values.some(
      (v) => JSON.stringify(v[j]) !== JSON.stringify((values[0] as (JointValue | null)[])[j]),
    ),
  );
  const chains = parts.map((p) => {
    const chain: number[] = [];
    for (let j = p.joint; j >= 0; j = (r._table[j] as JointRecord).parent) chain.unshift(j);
    return chain;
  });
  return ok((a, b) => {
    const ca = chains[a] as number[];
    const cb = chains[b] as number[];
    let common = 0;
    while (common < ca.length && common < cb.length && ca[common] === cb[common]) common++;
    return [...ca.slice(common), ...cb.slice(common)].some((j) => moving[j]);
  });
}

export function sweepParts(
  r: Rig,
  parts: readonly ResolvedPart[],
  names: readonly string[],
  voxel: number,
): Result<{ part: ResolvedPart; source: SweepSource }[], ModelingError> {
  if (!finite(voxel) || voxel <= 0) {
    return err(modelingError('model-invalid-argument', 'a positive voxel in meters', { voxel }));
  }
  const out: { part: ResolvedPart; source: SweepSource }[] = [];
  for (const name of names) {
    const part = parts.find((p) => p.name === name);
    if (part === undefined) {
      return err(
        modelingError('model-invalid-argument', 'parts bound in the rig', {
          part: name,
          parts: parts.map((p) => p.name),
        }),
      );
    }
    const mesh = r.partMesh(r.source.editMesh, part, IDENTITY);
    const lo: Tuple3 = [Infinity, Infinity, Infinity];
    const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
    for (const v of mesh.vertices()) {
      const p = mesh.position(v);
      for (let d = 0; d < 3; d++) {
        lo[d] = Math.min(lo[d] as number, p[d] as number);
        hi[d] = Math.max(hi[d] as number, p[d] as number);
      }
    }
    const scratch = model();
    scratch.append(encodeSnapshot(mesh));
    // A band of two voxels covers the reach (about 1.4 voxels).
    const sdf = scratch.voxel.fromMesh(undefined, { voxelSize: voxel / 2, band: 4 });
    if (scratch.poisoned !== undefined) return err(scratch.poisoned);
    out.push({ part, source: { name: part.name, closed: part.closed, sdf, box: [lo, hi] } });
  }
  return ok(out);
}

export function sweepCells(
  r: Rig,
  path: PosePath,
  picked: readonly { part: ResolvedPart; source: SweepSource }[],
  range: readonly [number, number],
  options: PoseOptions & { readonly voxel: number },
): Result<Set<number>[], ModelingError> {
  const voxel = options.voxel;
  const [u0, u1] = range;
  if (!(finite(u0, u1) && u0 >= 0 && u1 <= 1 && u0 <= u1)) {
    return err(modelingError('model-invalid-argument', 'a range 0 <= u0 <= u1 <= 1', { u: range }));
  }
  const parts = picked.map((p) => p.part);
  const samples = sweepSamples(
    range,
    path.keys.map((k) => k.u),
    (u) => {
      const sampled = r.sample(path, u);
      if (!sampled.ok) return sampled;
      const posed = r.pose(sampled.value, options);
      return posed.ok ? ok(r.deltas(parts, posed.value)) : posed;
    },
    picked.map((p) => p.source.box),
    voxel / 4,
  );
  if (!samples.ok) return samples;
  // Half the cell diagonal, the trilinear error of a half-voxel grid, and half the travel.
  const reach = voxel * (Math.sqrt(3) / 2 + Math.sqrt(3) / 4 + 1 / 8);
  const out = picked.map(() => new Set<number>());
  const first = samples.value[0]?.deltas ?? [];
  for (const [k, { source }] of picked.entries()) {
    // A part that does not move in the range occupies its cells once.
    const moves = samples.value.some((s) =>
      (s.deltas[k] as Affine).some((x, i) => x !== (first[k] as Affine)[i]),
    );
    for (const s of moves ? samples.value : samples.value.slice(0, 1)) {
      const marked = occupy(source, s.deltas[k] as Affine, voxel, reach, out[k] as Set<number>);
      if (!marked.ok) return marked;
    }
  }
  return ok(out);
}
