import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2 } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { decodeSnapshot } from '../fxem';
import { length, sub, type Tuple3 } from '../geom';
import { EDGE_SEAM, EDGE_SHARP, type EditMesh } from '../mesh';
import type {
  BackendOutput,
  ComputeJobRequest,
  UvStraightenIsland,
  UvStraightenStatus,
  WorkMeter,
} from './job';
import { flipFreeStep, overlapPairs, restOf, type SlimIsland, slim, slimEnergy } from './uv-slim';
import { channelIslands, encodeCornerUvs, type Island, metricsOf, samplesOf } from './uv-ts';

type Uv = [number, number];

const DEGREES = 180 / Math.PI;
/** Most chain-move stages before an island is kept as blocked. */
const MAX_STAGES = 16;
/** Fraction of the flip-free reach a partial chain move takes, leaving the neighbors room to relax. */
const MOVE_MARGIN = 0.5;
/** Smallest chain move worth a stage: below it the chains are blocked by a fold. */
const MIN_MOVE = 1e-3;
const RELAX_PARTIAL = 6;
const RELAX_FINAL = 24;

interface Chain {
  /** Elements from one corner to the next, both included. */
  readonly elements: readonly number[];
  readonly selected: boolean;
}

/** Boundary loops of an island as half-edge runs (island on the left), in element space. */
function boundaryRuns(mesh: EditMesh, island: Island): number[][] {
  const out = new Map<number, number>();
  for (const h of island.boundary) {
    const k = island.element.get(h) as number;
    if (!out.has(k)) out.set(k, h);
  }
  const visited = new Set<number>();
  const loops: number[][] = [];
  for (const start of island.boundary) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let h: number | undefined = start;
    while (h !== undefined && !visited.has(h)) {
      visited.add(h);
      loop.push(h);
      h = out.get(island.element.get(mesh.hNext[h] as number) as number);
    }
    loops.push(loop);
  }
  return loops;
}

function turnDegrees(a: Uv, b: Uv, c: Uv): number {
  const [x0, y0] = [b[0] - a[0], b[1] - a[1]];
  const [x1, y1] = [c[0] - b[0], c[1] - b[1]];
  return Math.abs(atan2(x0 * y1 - y0 * x1, x0 * x1 + y0 * y1)) * DEGREES;
}

/** Largest angle in degrees between an edge of the run and the chord from its first to its last point. */
function chordDeviation(points: readonly Uv[]): number {
  const first = points[0] as Uv;
  const last = points[points.length - 1] as Uv;
  const [cx, cy] = [last[0] - first[0], last[1] - first[1]];
  let worst = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Uv;
    const b = points[i + 1] as Uv;
    const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
    if (ex === 0 && ey === 0) continue;
    worst = Math.max(worst, Math.abs(atan2(cx * ey - cy * ex, cx * ex + cy * ey)) * DEGREES);
  }
  return worst;
}

/** Runs between corners (a boundary turn above `maxAngle`) that have at least two edges and a chord. */
function chainsOf(
  mesh: EditMesh,
  island: Island,
  uv: readonly Uv[],
  maxAngle: number,
): { chains: Chain[]; candidates: number } {
  const chains: Chain[] = [];
  let candidates = 0;
  for (const run of boundaryRuns(mesh, island)) {
    const elements = run.map((h) => island.element.get(h) as number);
    const m = elements.length;
    const corner = elements.map((_, i) => {
      const a = uv[elements[(i + m - 1) % m] as number] as Uv;
      const b = uv[elements[i] as number] as Uv;
      const c = uv[elements[(i + 1) % m] as number] as Uv;
      if ((a[0] === b[0] && a[1] === b[1]) || (b[0] === c[0] && b[1] === c[1])) return true;
      return turnDegrees(a, b, c) > maxAngle;
    });
    const corners = corner.flatMap((c, i) => (c ? [i] : []));
    for (const [j, from] of corners.entries()) {
      const to = corners[(j + 1) % corners.length] as number;
      const count = (to - from + m) % m;
      if (count < 2) continue;
      candidates++;
      const picked = Array.from({ length: count + 1 }, (_, i) => (from + i) % m);
      const points = picked.map((i) => uv[elements[i] as number] as Uv);
      const first = points[0] as Uv;
      const last = points[count] as Uv;
      if (first[0] === last[0] && first[1] === last[1]) continue;
      if (chordDeviation(points) > maxAngle) continue;
      const selected = picked.slice(0, count).some((i) => {
        return ((mesh.eFlags[(run[i] as number) >> 1] as number) & EDGE_SEAM) !== 0;
      });
      chains.push({ elements: picked.map((i) => elements[i] as number), selected });
    }
  }
  return { chains, candidates };
}

/** Largest chord deviation of the chains in a layout. */
function achievedAngle(chains: readonly Chain[], uv: readonly Uv[]): number {
  let worst = 0;
  for (const chain of chains) {
    worst = Math.max(worst, chordDeviation(chain.elements.map((e) => uv[e] as Uv)));
  }
  return worst;
}

/** Elements on boundary edges flagged EDGE_SHARP in the job: they touch faces outside the selection and stay put. */
function frozenElements(mesh: EditMesh, island: Island): Set<number> {
  const out = new Set<number>();
  for (const h of island.boundary) {
    if (((mesh.eFlags[h >> 1] as number) & EDGE_SHARP) === 0) continue;
    out.add(island.element.get(h) as number);
    out.add(island.element.get(mesh.hNext[h] as number) as number);
  }
  return out;
}

interface IslandOutcome {
  readonly status: UvStraightenStatus;
  readonly uv: Uv[];
  readonly info: UvStraightenIsland;
}

/**
 * Why a straightened island must be discarded, or undefined when it may be kept: a flipped or
 * zero-area triangle, max stretch above `maxStretch` times the stretch before, or more
 * overlapping triangle pairs than before. Orientation is positive-area: a mirror-image island
 * is passed reflected.
 * @internal
 */
export function rejection(
  mesh: EditMesh,
  island: Island,
  before: readonly Uv[],
  candidate: readonly Uv[],
  maxStretch: number,
): UvStraightenStatus | undefined {
  const was = metricsOf(samplesOf(mesh, island, before as Uv[]));
  const after = metricsOf(samplesOf(mesh, island, candidate as Uv[]));
  if (after.flipped + after.zeroArea > 0) return 'flipped';
  if (!(after.stretchLinf <= was.stretchLinf * maxStretch)) return 'stretch';
  const flat = (points: readonly Uv[]) => {
    const out = new Float64Array(2 * points.length);
    for (const [k, p] of points.entries()) out.set(p, 2 * k);
    return out;
  };
  if (
    overlapPairs(island.triangles, flat(candidate)) > overlapPairs(island.triangles, flat(before))
  ) {
    return 'overlap';
  }
  return undefined;
}

function straightenIsland(
  mesh: EditMesh,
  island: Island,
  uv: Uv[],
  params: { maxAngle: number; maxStretch: number; selected: boolean },
  work: WorkMeter,
): Result<IslandOutcome, ModelingError> {
  const tris = island.triangles;
  let signed = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => uv[tris[t + j] as number] as Uv) as [Uv, Uv, Uv];
    signed += ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  const mirror = signed < 0 ? -1 : 1;
  const framed = (points: readonly Uv[]): Uv[] =>
    mirror < 0 ? points.map((p) => [p[0], -p[1]]) : (points as Uv[]);
  const before = metricsOf(samplesOf(mesh, island, framed(uv)));
  const { chains: all, candidates } = chainsOf(mesh, island, uv, params.maxAngle);
  const frozen = frozenElements(mesh, island);
  const chains = all.filter(
    (c) => (!params.selected || c.selected) && !c.elements.slice(1, -1).some((e) => frozen.has(e)),
  );
  const base = {
    faces: island.faces.length,
    chains: candidates,
    angleBefore: 0,
    maxAngleError: 0,
    stretchBefore: before.stretchLinf,
    stretchAfter: before.stretchLinf,
  };
  const kept = (status: UvStraightenStatus, straightened = 0, angleBefore = 0): IslandOutcome => ({
    status,
    uv,
    info: { ...base, straightened, status, angleBefore },
  });
  if (chains.length === 0) return ok(kept('none'));
  let angleBefore = 0;
  for (const c of chains) {
    angleBefore = Math.max(angleBefore, chordDeviation(c.elements.map((e) => uv[e] as Uv)));
  }

  const n = island.vertexOf.length;
  const shape: SlimIsland = {
    points: island.vertexOf.map((v) => mesh.position(v)),
    triangles: island.triangles,
    disk: undefined,
  };
  const rest = restOf(shape);
  if (rest === undefined) return ok(kept('unavailable', 0, angleBefore));
  let area3d = 0;
  for (const a of rest.area) area3d += a;
  if (!(Math.abs(signed) > 0)) return ok(kept('flipped', 0, angleBefore));
  const scale = Math.sqrt(area3d / Math.abs(signed));
  const x = new Float64Array(2 * n);
  for (const [k, p] of uv.entries()) {
    x[2 * k] = p[0] * scale;
    x[2 * k + 1] = mirror * p[1] * scale;
  }
  if (slimEnergy(shape, x) === Number.POSITIVE_INFINITY) return ok(kept('flipped', 0, angleBefore));

  const target = x.slice();
  const fixed = new Uint8Array(n);
  for (const e of frozen) fixed[e] = 1;
  const moved = new Set<number>();
  for (const chain of chains) {
    const first = chain.elements[0] as number;
    const last = chain.elements[chain.elements.length - 1] as number;
    const a = [x[2 * first] as number, x[2 * first + 1] as number];
    const b = [x[2 * last] as number, x[2 * last + 1] as number];
    const steps: number[] = [];
    let total = 0;
    for (let i = 0; i + 1 < chain.elements.length; i++) {
      const d = length(
        sub(
          shape.points[chain.elements[i + 1] as number] as Tuple3,
          shape.points[chain.elements[i] as number] as Tuple3,
        ),
      );
      steps.push(d);
      total += d;
    }
    let run = 0;
    for (const [i, e] of chain.elements.entries()) {
      fixed[e] = 1;
      if (i > 0 && i + 1 < chain.elements.length) {
        const s = total > 0 ? run / total : i / (chain.elements.length - 1);
        target[2 * e] = (a[0] as number) + s * ((b[0] as number) - (a[0] as number));
        target[2 * e + 1] = (a[1] as number) + s * ((b[1] as number) - (a[1] as number));
        moved.add(e);
      }
      run += steps[i] ?? 0;
    }
  }

  let done = false;
  for (let stage = 0; stage < MAX_STAGES && !done; stage++) {
    if (!work.spend(tris.length * 16)) return err(work.failure as ModelingError);
    const dir = new Float64Array(2 * n);
    for (const e of moved) {
      dir[2 * e] = (target[2 * e] as number) - (x[2 * e] as number);
      dir[2 * e + 1] = (target[2 * e + 1] as number) - (x[2 * e + 1] as number);
    }
    const reach = flipFreeStep(rest, tris, x, dir);
    const s = reach > 1 ? 1 : MOVE_MARGIN * reach;
    if (!(s >= MIN_MOVE)) break;
    for (const e of moved) {
      x[2 * e] = (x[2 * e] as number) + s * (dir[2 * e] as number);
      x[2 * e + 1] = (x[2 * e + 1] as number) + s * (dir[2 * e + 1] as number);
    }
    if (s === 1) {
      for (const e of moved) {
        x[2 * e] = target[2 * e] as number;
        x[2 * e + 1] = target[2 * e + 1] as number;
      }
    }
    const relaxed = slim(shape, x, work, {
      fixed,
      iterations: s === 1 ? RELAX_FINAL : RELAX_PARTIAL,
    });
    if (!relaxed.ok) return relaxed;
    if (relaxed.value !== undefined) x.set(relaxed.value.uv);
    done = s === 1;
  }
  if (!done) return ok(kept('blocked', 0, angleBefore));

  const candidate: Uv[] = island.vertexOf.map((_, k) => [
    Math.fround((x[2 * k] as number) / scale),
    Math.fround((mirror * (x[2 * k + 1] as number)) / scale),
  ]);
  const verdict = rejection(mesh, island, framed(uv), framed(candidate), params.maxStretch);
  if (verdict !== undefined) return ok(kept(verdict, 0, angleBefore));
  const after = metricsOf(samplesOf(mesh, island, framed(candidate)));
  const straightened = chains.length;
  const status: UvStraightenStatus = straightened === candidates ? 'accepted' : 'partial';
  return ok({
    status,
    uv: candidate,
    info: {
      ...base,
      straightened,
      status,
      angleBefore,
      maxAngleError: achievedAngle(chains, candidate),
      stretchAfter: after.stretchLinf,
    },
  });
}

/**
 * uv.straighten: per uv0 island, the boundary chains between corners are put on their
 * chords and the interior relaxed by SLIM with the chains held; an island keeps the result
 * only when it stays flip-free, within `maxStretch` of its stretch and no more overlapped.
 */
export function runStraightenJob(
  request: ComputeJobRequest<'uv.straighten'>,
  work: WorkMeter,
): Result<BackendOutput<'uv.straighten'>, ModelingError> {
  const { maxAngle, maxStretch } = request.params;
  if (!(Number.isFinite(maxAngle) && maxAngle > 0 && maxAngle < 90)) {
    return err(
      modelingError('model-invalid-argument', 'maxAngle is a number of degrees in (0, 90)', {
        maxAngle,
      }),
    );
  }
  if (!(Number.isFinite(maxStretch) && maxStretch >= 1)) {
    return err(
      modelingError('model-invalid-argument', 'maxStretch is a finite number of at least 1', {
        maxStretch,
      }),
    );
  }
  if (request.inputs.length !== 1) {
    return err(
      modelingError('model-invalid-argument', 'uv.straighten takes one FXEM input', {
        inputs: request.inputs.length,
      }),
    );
  }
  const decoded = decodeSnapshot(request.inputs[0] as Uint8Array);
  if (!decoded.ok) return decoded;
  const mesh = decoded.value;
  const found = channelIslands(mesh, 'uv0', work);
  if (!found.ok) return found;
  const { islands, faceIsland } = found.value;
  const placed: Uv[][] = [];
  const reports: UvStraightenIsland[] = [];
  const params = { maxAngle, maxStretch, selected: request.params.selected === true };
  for (const island of islands) {
    const uv: Uv[] = island.vertexOf.map(() => [0, 0]);
    for (const [h, k] of island.element) {
      const v = mesh.corner('uv0', h) as Float32Array;
      uv[k] = [v[0] as number, v[1] as number];
    }
    const outcome = straightenIsland(mesh, island, uv, params, work);
    if (!outcome.ok) return outcome;
    placed.push(outcome.value.uv);
    reports.push(outcome.value.info);
  }
  const bytes = encodeCornerUvs(mesh, (h) => {
    const i = faceIsland[mesh.hFace[h] as number] as number;
    return (placed[i] as Uv[])[(islands[i] as Island).element.get(h) as number] as Uv;
  });
  const count = (status: UvStraightenStatus) => reports.filter((r) => r.status === status).length;
  const touched = reports.filter((r) => r.straightened > 0);
  return ok({
    status: 'ok',
    outputs: [bytes],
    provenance: { faceIsland: faceIsland.slice(0, mesh.faceHighWater), islands: reports },
    metrics: {
      islands: islands.length,
      chains: reports.reduce((n, r) => n + r.chains, 0),
      straightened: reports.reduce((n, r) => n + r.straightened, 0),
      accepted: count('accepted'),
      partial: count('partial'),
      none: count('none'),
      flipped: count('flipped'),
      blocked: count('blocked'),
      stretchRejected: count('stretch'),
      overlapRejected: count('overlap'),
      unavailable: count('unavailable'),
      maxAngleError: touched.reduce((m, r) => Math.max(m, r.maxAngleError), 0),
      angleBefore: touched.reduce((m, r) => Math.max(m, r.angleBefore), 0),
    },
    locations: [],
  });
}
