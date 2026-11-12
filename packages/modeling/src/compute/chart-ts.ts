import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import { cos } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { decodeSnapshot } from '../fxem';
import {
  dot,
  faceArea,
  faceCentroid,
  faceNormal,
  length,
  normalize,
  sub,
  type Tuple3,
} from '../geom';
import { EDGE_SEAM, type EditMesh, NONE } from '../mesh';
import type { BackendOutput, ComputeJobRequest, UvChartMetrics, WorkMeter } from './job';
import { expmap, type Island, islandsOf, samplesOf } from './uv-ts';

/**
 * Normal deviation weight of the patch metric: crossing a 90 degree crease costs three
 * times the centroid distance, so seeds spread over differently facing parts first.
 */
const NORMAL_WEIGHT = 2;
const DISTORTION_CLIP = 100;
/** A merged chart is invalid once one triangle exceeds this multiple of the mean limit. */
const MAX_DISTORTION_FACTOR = 4;
/** Normal limits of the merge stages, as fractions of `maxNormalDeviation`. */
const STAGES = [1 / 8, 1 / 4, 1 / 2, 1] as const;
/** Rounds of extra seeds for patches that are not disks (each round splits every such patch). */
const DISK_ROUNDS = 8;

/** Binary min-heap of (key, id), ties settled by the lower id. */
class Heap {
  private readonly keys: number[] = [];
  private readonly ids: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  private less(i: number, j: number): boolean {
    const a = this.keys[i] as number;
    const b = this.keys[j] as number;
    return a < b || (a === b && (this.ids[i] as number) < (this.ids[j] as number));
  }
  private swap(i: number, j: number): void {
    [this.keys[i], this.keys[j]] = [this.keys[j] as number, this.keys[i] as number];
    [this.ids[i], this.ids[j]] = [this.ids[j] as number, this.ids[i] as number];
  }
  push(key: number, id: number): void {
    this.keys.push(key);
    this.ids.push(id);
    let i = this.keys.length - 1;
    while (i > 0 && this.less(i, (i - 1) >> 1)) {
      this.swap(i, (i - 1) >> 1);
      i = (i - 1) >> 1;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.keys[0] as number, this.ids[0] as number];
    const key = this.keys.pop() as number;
    const id = this.ids.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = key;
      this.ids[0] = id;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        let m = i;
        if (l < this.keys.length && this.less(l, m)) m = l;
        if (l + 1 < this.keys.length && this.less(l + 1, m)) m = l + 1;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

/** Face graph across non-hard edges, in CSR form with the patch metric as edge cost. */
interface FaceGraph {
  readonly count: number;
  readonly start: Int32Array;
  readonly next: Int32Array;
  readonly cost: Float64Array;
  readonly normal: Tuple3[];
  readonly area: Float64Array;
  /** Faces with a hard or open edge. */
  readonly bounded: Uint8Array;
}

const hard = (mesh: EditMesh, h: number) =>
  (mesh.hFace[h ^ 1] as number) === NONE || ((mesh.eFlags[h >> 1] as number) & EDGE_SEAM) !== 0;

function faceGraph(mesh: EditMesh): FaceGraph {
  const count = mesh.faceHighWater;
  const centroid = Array.from({ length: count }, (_, f) => faceCentroid(mesh, f));
  const normal = Array.from({ length: count }, (_, f) => faceNormal(mesh, f));
  const area = Float64Array.from({ length: count }, (_, f) => faceArea(mesh, f));
  const start = new Int32Array(count + 1);
  const next: number[] = [];
  const cost: number[] = [];
  const bounded = new Uint8Array(count);
  for (let f = 0; f < count; f++) {
    start[f] = next.length;
    for (const h of mesh.faceHalves(f)) {
      if (hard(mesh, h)) {
        bounded[f] = 1;
        continue;
      }
      const g = mesh.hFace[h ^ 1] as number;
      const turn = 1 - dot(normal[f] as Tuple3, normal[g] as Tuple3);
      next.push(g);
      cost.push(
        length(sub(centroid[f] as Tuple3, centroid[g] as Tuple3)) * (1 + NORMAL_WEIGHT * turn),
      );
    }
  }
  start[count] = next.length;
  return {
    count,
    start,
    next: Int32Array.from(next),
    cost: Float64Array.from(cost),
    normal,
    area,
    bounded,
  };
}

/** Grow `distance` (and `label`) from sources by Dijkstra; returns false on budget failure. */
function grow(
  graph: FaceGraph,
  sources: readonly number[],
  distance: Float64Array,
  label: Int32Array,
  work: WorkMeter,
  options: { readonly base?: number; readonly within?: Int32Array; readonly region?: number } = {},
): boolean {
  const heap = new Heap();
  const base = options.base ?? 0;
  const { within, region } = options;
  for (const [i, s] of sources.entries()) {
    distance[s] = 0;
    label[s] = base + i;
    heap.push(0, s);
  }
  while (heap.size > 0) {
    const [d, f] = heap.pop();
    if (d > (distance[f] as number)) continue;
    if (!work.spend(4)) return false;
    for (let k = graph.start[f] as number; k < (graph.start[f + 1] as number); k++) {
      const g = graph.next[k] as number;
      if (within !== undefined && within[g] !== region) continue;
      const nd = d + (graph.cost[k] as number);
      if (nd < (distance[g] as number)) {
        distance[g] = nd;
        label[g] = label[f] as number;
        heap.push(nd, g);
      }
    }
  }
  return true;
}

/** Connected components of the face graph, as the lowest face of each. */
function components(graph: FaceGraph): Int32Array {
  const component = new Int32Array(graph.count).fill(NONE);
  const stack: number[] = [];
  for (let f = 0; f < graph.count; f++) {
    if (component[f] !== NONE) continue;
    component[f] = f;
    stack.push(f);
    while (stack.length > 0) {
      const a = stack.pop() as number;
      for (let k = graph.start[a] as number; k < (graph.start[a + 1] as number); k++) {
        const b = graph.next[k] as number;
        if (component[b] !== NONE) continue;
        component[b] = f;
        stack.push(b);
      }
    }
  }
  return component;
}

/**
 * Normal-weighted farthest-point seeds: the farthest face from all seeds so far (an
 * unreached face first, so every component gets one), then one more seed in every
 * closed component that has a single seed, so each chart can have a boundary. The
 * distance field is the multi-source one, grown in place: each seed only visits the
 * faces it brings closer.
 */
function seeds(
  graph: FaceGraph,
  component: Int32Array,
  target: number,
  work: WorkMeter,
): number[] | undefined {
  const distance = new Float64Array(graph.count).fill(Infinity);
  const owner = new Int32Array(graph.count).fill(NONE);
  const out: number[] = [];
  const farthest = (within?: number) => {
    let best = NONE;
    for (let f = 0; f < graph.count; f++) {
      if (within !== undefined && component[f] !== within) continue;
      if (best === NONE || (distance[f] as number) > (distance[best] as number)) best = f;
    }
    return best;
  };
  for (;;) {
    const f = farthest();
    if (f === NONE || distance[f] === 0) break;
    if (out.length >= target && distance[f] !== Infinity) break;
    if (!grow(graph, [f], distance, owner, work, { base: out.length })) return undefined;
    out.push(f);
  }
  const perComponent = new Map<number, number>();
  for (const s of out)
    perComponent.set(component[s] as number, (perComponent.get(component[s] as number) ?? 0) + 1);
  const closed = new Set(perComponent.keys());
  for (let f = 0; f < graph.count; f++)
    if (graph.bounded[f] === 1) closed.delete(component[f] as number);
  // In order of each component's first seed.
  const first = new Map<number, number>();
  for (const s of out) if (!first.has(component[s] as number)) first.set(component[s] as number, s);
  for (const c of [...closed].sort((a, b) => (first.get(a) as number) - (first.get(b) as number))) {
    if ((perComponent.get(c) as number) > 1) continue;
    const f = farthest(c);
    if (f !== NONE && (distance[f] as number) > 0) out.push(f);
  }
  return out;
}

interface Patch {
  readonly faces: number[];
  readonly normalSum: Tuple3;
  readonly area: number;
  readonly mean: number;
}

interface Evaluation {
  readonly valid: boolean;
  readonly mean: number;
}

/**
 * The face set as one chart island when it is a topological disk (one island with
 * Euler characteristic 1: a single boundary loop and no handle); undefined otherwise.
 * A band between two loops or a closed part folds when flattened as one chart.
 */
function diskOf(
  mesh: EditMesh,
  faces: readonly number[],
  member: Uint8Array,
  work: WorkMeter,
): Result<Island | undefined, ModelingError> {
  for (const f of faces) member[f] = 1;
  try {
    const joined = (h: number) => !hard(mesh, h) && member[mesh.hFace[h ^ 1] as number] === 1;
    const found = islandsOf(mesh, joined, work, faces);
    if (!found.ok) return found;
    const island = found.value.islands[0];
    if (found.value.islands.length !== 1 || island === undefined) return ok(undefined);
    let halves = 0;
    for (const f of island.faces) halves += mesh.faceHalves(f).length;
    const edges = (halves + island.boundary.length) / 2;
    const euler = island.vertexOf.length - edges + island.faces.length;
    return ok(euler === 1 ? island : undefined);
  } finally {
    for (const f of faces) member[f] = 0;
  }
}

/**
 * ExpMap of a face set as one chart: area-weighted mean of max(rho, 1 / rho) and its
 * largest value, with flipped triangles clipped. A set that is not a disk or
 * collapses is invalid.
 */
function evaluate(
  mesh: EditMesh,
  faces: readonly number[],
  member: Uint8Array,
  maxDistortion: number,
  work: WorkMeter,
): Result<Evaluation, ModelingError> {
  const disk = diskOf(mesh, faces, member, work);
  if (!disk.ok) return disk;
  const island = disk.value;
  if (island === undefined) return ok({ valid: false, mean: Infinity });
  const solved = expmap(mesh, island, work);
  if (!solved.ok) {
    return solved.error.code === 'model-degenerate' ? ok({ valid: false, mean: Infinity }) : solved;
  }
  const uv = island.vertexOf.map((_, k) => [
    solved.value.uv[2 * k] as number,
    solved.value.uv[2 * k + 1] as number,
  ]);
  const samples = samplesOf(mesh, island, uv);
  let area3d = 0;
  let signed = 0;
  for (const s of samples) {
    area3d += s.area3d;
    signed += s.areaUv;
  }
  if (!(area3d > 0) || signed === 0) return ok({ valid: false, mean: Infinity });
  const orient = signed > 0 ? 1 : -1;
  const areaUv = Math.abs(signed);
  let sum = 0;
  let worst = 1;
  for (const s of samples) {
    const a = s.areaUv * orient;
    let d = DISTORTION_CLIP;
    if (a > 0 && s.area3d > 0) {
      const rho = a / areaUv / (s.area3d / area3d);
      d = Math.min(DISTORTION_CLIP, Math.max(rho, 1 / rho));
    }
    sum += d * s.area3d;
    worst = Math.max(worst, d);
  }
  const mean = sum / area3d;
  return ok({ valid: worst <= maxDistortion * MAX_DISTORTION_FACTOR, mean });
}

function invalidParams(params: ComputeJobRequest<'uv.chart'>['params']): ModelingError | undefined {
  if (!Number.isInteger(params.maxCharts) || params.maxCharts < 1 || params.maxCharts > 65536) {
    return modelingError('model-invalid-argument', 'maxCharts is an integer in [1, 65536]', {
      maxCharts: params.maxCharts,
    });
  }
  if (!(params.maxDistortion >= 1 && params.maxDistortion <= DISTORTION_CLIP)) {
    return modelingError('model-invalid-argument', 'maxDistortion is in [1, 100]', {
      maxDistortion: params.maxDistortion,
    });
  }
  if (!(params.maxNormalDeviation > 0 && params.maxNormalDeviation <= 180)) {
    return modelingError('model-invalid-argument', 'maxNormalDeviation is in (0, 180] degrees', {
      maxNormalDeviation: params.maxNormalDeviation,
    });
  }
  return undefined;
}

/**
 * Automatic charts: farthest-point seeds grow into patches by
 * the normal-weighted face distance; neighboring charts then merge, most similar
 * first, while their joint ExpMap keeps the mean area distortion within
 * `maxDistortion` and their average normals within `maxNormalDeviation` (in four
 * stages of growing angle). Seam-flagged and open edges are never crossed.
 * Output: one byte per FXEM edge, 1 where two charts meet across a non-hard edge.
 */
export function runChartJob(
  request: ComputeJobRequest<'uv.chart'>,
  work: WorkMeter,
): Result<BackendOutput<'uv.chart'>, ModelingError> {
  const params = request.params;
  const invalid = invalidParams(params);
  if (invalid !== undefined) return err(invalid);
  if (request.inputs.length !== 1) {
    return err(
      modelingError('model-invalid-argument', 'uv.chart takes one FXEM input', {
        inputs: request.inputs.length,
      }),
    );
  }
  const decoded = decodeSnapshot(request.inputs[0] as Uint8Array);
  if (!decoded.ok) return decoded;
  const mesh = decoded.value;
  if (mesh.faceCount === 0) {
    return err(modelingError('model-precondition', 'uv.chart has faces to chart', {}));
  }
  const graph = faceGraph(mesh);
  if (!work.spend(graph.next.length + graph.count)) return err(work.failure as ModelingError);
  const component = components(graph);
  const seeded = seeds(graph, component, Math.min(params.maxCharts, graph.count), work);
  if (seeded === undefined) return err(work.failure as ModelingError);
  const label = new Int32Array(graph.count).fill(NONE);
  const member = new Uint8Array(graph.count);
  // A patch that is not a disk (a band between two hard loops, a handle) folds when
  // flattened as one chart: it gets another seed at its face farthest from the seeds.
  for (let round = 0; ; round++) {
    const distance = new Float64Array(graph.count).fill(Infinity);
    label.fill(NONE);
    if (!grow(graph, seeded, distance, label, work)) return err(work.failure as ModelingError);
    if (round === DISK_ROUNDS) break;
    const grown: number[][] = seeded.map(() => []);
    for (let f = 0; f < graph.count; f++) {
      if (label[f] !== NONE) (grown[label[f] as number] as number[]).push(f);
    }
    const extra: number[] = [];
    for (const faces of grown) {
      const disk = diskOf(mesh, faces, member, work);
      if (!disk.ok) return disk;
      if (disk.value !== undefined) continue;
      let far = NONE;
      for (const f of faces) {
        if (far === NONE || (distance[f] as number) > (distance[far] as number)) far = f;
      }
      if (far !== NONE && (distance[far] as number) > 0) extra.push(far);
    }
    if (extra.length === 0) break;
    pushAll(seeded, extra);
  }
  const patches = new Map<number, Patch>();
  const faceRegion = new Int32Array(graph.count).fill(NONE);
  const add = (id: number, faces: number[], mean: number) => {
    const normalSum: Tuple3 = [0, 0, 0];
    let area = 0;
    for (const f of faces) {
      const n = graph.normal[f] as Tuple3;
      const a = graph.area[f] as number;
      normalSum[0] += n[0] * a;
      normalSum[1] += n[1] * a;
      normalSum[2] += n[2] * a;
      area += a;
      faceRegion[f] = id;
    }
    patches.set(id, { faces, normalSum, area, mean });
  };
  const initial: number[][] = seeded.map(() => []);
  for (let f = 0; f < graph.count; f++) (initial[label[f] as number] as number[]).push(f);
  // A patch that is no valid chart (an annulus such as a cylinder wall, a closed part, or
  // one over the distortion limit) splits along its own farthest faces until it is valid
  // or one face. Validity outranks maxCharts: LSCM would fold such a patch.
  const within = new Int32Array(graph.count).fill(NONE);
  const scratch = new Float64Array(graph.count).fill(Infinity);
  const half = new Int32Array(graph.count).fill(NONE);
  let region = 0;
  /** Two halves of `faces` (graph-connected) grown from `from` inside them; false on budget. */
  const halves = (faces: readonly number[], from: readonly [number, number]) => {
    region++;
    for (const f of faces) {
      within[f] = region;
      scratch[f] = Infinity;
    }
    if (!grow(graph, from, scratch, half, work, { within, region })) return undefined;
    const parts: [number[], number[]] = [[], []];
    for (const f of faces) parts[half[f] as number]?.push(f);
    return parts;
  };
  const farthestIn = (faces: readonly number[], from: number) => {
    region++;
    for (const f of faces) {
      within[f] = region;
      scratch[f] = Infinity;
    }
    if (!grow(graph, [from], scratch, half, work, { within, region })) return undefined;
    let best = NONE;
    for (const f of faces) {
      if (f !== from && (best === NONE || (scratch[f] as number) > (scratch[best] as number)))
        best = f;
    }
    return best;
  };
  let evaluations = 0;
  let splits = 0;
  let nextId = 0;
  const settle = (start: number[][]): ModelingError | undefined => {
    const queue = start;
    for (let q = 0; q < queue.length; q++) {
      const faces = queue[q] as number[];
      const e = evaluate(mesh, faces, member, params.maxDistortion, work);
      if (!e.ok) return e.error;
      evaluations++;
      if ((e.value.valid && e.value.mean <= params.maxDistortion) || faces.length === 1) {
        add(nextId++, faces, e.value.mean);
        continue;
      }
      const b = farthestIn(faces, faces[0] as number);
      const c = b === undefined ? undefined : farthestIn(faces, b);
      const parts = b === undefined || c === undefined ? undefined : halves(faces, [b, c]);
      if (parts === undefined) return work.failure as ModelingError;
      pushAll(queue, parts);
      splits++;
    }
    return undefined;
  };
  const unsettled = settle(initial);
  if (unsettled !== undefined) return err(unsettled);
  let merges = 0;
  const cache = new Map<string, Evaluation>();
  for (const fraction of STAGES) {
    const limit = cos(((params.maxNormalDeviation * fraction) / 180) * Math.PI);
    for (;;) {
      const candidates: { a: number; b: number; e: Evaluation; score: number }[] = [];
      for (const [a, patch] of patches) {
        const near = new Set<number>();
        for (const f of patch.faces) {
          for (let k = graph.start[f] as number; k < (graph.start[f + 1] as number); k++) {
            const b = faceRegion[graph.next[k] as number] as number;
            if (b > a) near.add(b);
          }
        }
        for (const b of [...near].sort((x, y) => x - y)) {
          const other = patches.get(b) as Patch;
          const turn = dot(normalize(patch.normalSum), normalize(other.normalSum));
          if (turn < limit) continue;
          const key = `${a},${b}`;
          let e = cache.get(key);
          if (e === undefined) {
            const r = evaluate(
              mesh,
              [...patch.faces, ...other.faces].sort((x, y) => x - y),
              member,
              params.maxDistortion,
              work,
            );
            if (!r.ok) return r;
            evaluations++;
            e = r.value;
            cache.set(key, e);
          }
          if (!e.valid || e.mean > params.maxDistortion) continue;
          const score =
            10 * (1 - turn) +
            Math.max(Math.abs(e.mean - patch.mean), Math.abs(e.mean - other.mean));
          candidates.push({ a, b, e, score });
        }
      }
      candidates.sort((x, y) => x.score - y.score || x.a - y.a || x.b - y.b);
      const used = new Set<number>();
      let merged = 0;
      for (const { a, b, e } of candidates) {
        if (used.has(a) || used.has(b)) continue;
        used.add(a);
        used.add(b);
        const faces = [...(patches.get(a) as Patch).faces, ...(patches.get(b) as Patch).faces].sort(
          (x, y) => x - y,
        );
        patches.delete(a);
        patches.delete(b);
        add(nextId++, faces, e.mean);
        merged++;
      }
      merges += merged;
      if (merged === 0) break;
    }
  }
  // A hard edge with one chart on both sides is a slit in it (a crease that dies out, an
  // isolated sharp edge). Even when it reaches the chart's border, the unwrap may leave it
  // closed (a flat chart flattens exactly, both sides on the same UVs), so the chart would
  // cross it. Split that chart between the edge's two faces: every hard edge is a border.
  let slitSplits = 0;
  for (const e of mesh.edges()) {
    const f = mesh.hFace[e * 2] as number;
    const g = mesh.hFace[e * 2 + 1] as number;
    if (f === NONE || g === NONE || !hard(mesh, e * 2)) continue;
    const id = faceRegion[f] as number;
    if (id !== faceRegion[g]) continue;
    const parts = halves((patches.get(id) as Patch).faces, [f, g]);
    if (parts === undefined) return err(work.failure as ModelingError);
    patches.delete(id);
    const failed = settle(parts);
    if (failed !== undefined) return err(failed);
    slitSplits++;
  }
  // Charts in order of their lowest face.
  const order = [...patches.entries()].sort(
    (x, y) => (x[1].faces[0] as number) - (y[1].faces[0] as number),
  );
  const faceChart = new Int32Array(graph.count).fill(NONE);
  const charts: UvChartMetrics[] = [];
  for (const [index, [, patch]] of order.entries()) {
    for (const f of patch.faces) faceChart[f] = index;
    charts.push({ faces: patch.faces.length, area3d: patch.area, meanDistortion: patch.mean });
  }
  const cuts = new Uint8Array(mesh.halfHighWater >> 1);
  let cutCount = 0;
  let hardCount = 0;
  for (const e of mesh.edges()) {
    const h = e * 2;
    if (hard(mesh, h)) {
      if ((mesh.hFace[h ^ 1] as number) !== NONE && (mesh.hFace[h] as number) !== NONE) hardCount++;
      continue;
    }
    if (faceChart[mesh.hFace[h] as number] !== faceChart[mesh.hFace[h ^ 1] as number]) {
      cuts[e] = 1;
      cutCount++;
    }
  }
  let worst = 1;
  for (const c of charts) worst = Math.max(worst, c.meanDistortion);
  return ok({
    status: 'ok',
    outputs: [cuts],
    provenance: { faceChart, charts },
    metrics: {
      faces: graph.count,
      initialPatches: seeded.length,
      charts: charts.length,
      components: new Set(component).size,
      splits,
      merges,
      evaluations,
      slitSplits,
      cuts: cutCount,
      hardEdges: hardCount,
      meanDistortion: worst,
    },
    locations: [],
  });
}
