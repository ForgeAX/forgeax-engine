import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from '../arrays';
import { atan2 } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { cross, dot, length, type Tuple3 } from '../geom';
import { NONE } from '../mesh';
import { type AnalyticRules, solveSample } from './bake-analytic';
import {
  allRows,
  BAKE_TILE,
  type BakeRows,
  baseSurfaceAt,
  counters,
  ensureGroupBvhs,
  finishBake,
  finishTexture,
  GROUP_COUNTERS,
  type GroupBake,
  gridOf,
  guided,
  type PreparedBake,
  positionBounds,
  rowSpan,
  STACK_ANGLE,
  STACK_HEIGHT,
  triangleSide,
} from './bake-ts';
import type { BackendOutput, BakeHandedness, BakeJobParams, WorkMeter } from './job';

/** Decoupled CPU sample correspondence buffers (computed once, evaluated across any map set). */
export interface CpuCorrespondenceData {
  readonly prepared: PreparedBake;
  readonly grid: ReturnType<typeof gridOf>;
  readonly count: number;
  readonly texel: Uint32Array;
  readonly sampleIdx: Uint32Array;
  readonly group: Int32Array;
  readonly tri: Int32Array;
  readonly uv: Float64Array;
  readonly q: Float64Array;
  readonly nd: Float64Array;
  readonly baseNormal: Float64Array;
  readonly baseTangent: Float64Array;
  readonly height: Float64Array;
  readonly hit: Uint8Array;
  readonly exactMask: Uint8Array;
  readonly weight: Float64Array;
  readonly island: Int32Array;
  readonly covered: number;
  readonly counts: Float64Array;
  readonly findings: Float64Array;
  readonly stack: Float64Array;
  readonly handedness: BakeHandedness;
}

class SampleWriter {
  cap = 1024;
  len = 0;
  texel = new Uint32Array(this.cap);
  sampleIdx = new Uint32Array(this.cap);
  group = new Int32Array(this.cap);
  tri = new Int32Array(this.cap);
  uv = new Float64Array(this.cap * 2);
  q = new Float64Array(this.cap * 3);
  nd = new Float64Array(this.cap * 3);
  baseNormal = new Float64Array(this.cap * 3);
  baseTangent = new Float64Array(this.cap * 4);
  height = new Float64Array(this.cap);
  hit = new Uint8Array(this.cap);
  exactMask = new Uint8Array(this.cap);

  private grow(next: number): void {
    const growU32 = (a: Uint32Array) => {
      const b = new Uint32Array(next);
      b.set(a);
      return b;
    };
    const growI32 = (a: Int32Array) => {
      const b = new Int32Array(next);
      b.set(a);
      return b;
    };
    const growF64 = (a: Float64Array, k: number) => {
      const b = new Float64Array(next * k);
      b.set(a);
      return b;
    };
    const growU8 = (a: Uint8Array) => {
      const b = new Uint8Array(next);
      b.set(a);
      return b;
    };
    this.texel = growU32(this.texel);
    this.sampleIdx = growU32(this.sampleIdx);
    this.group = growI32(this.group);
    this.tri = growI32(this.tri);
    this.uv = growF64(this.uv, 2);
    this.q = growF64(this.q, 3);
    this.nd = growF64(this.nd, 3);
    this.baseNormal = growF64(this.baseNormal, 3);
    this.baseTangent = growF64(this.baseTangent, 4);
    this.height = growF64(this.height, 1);
    this.hit = growU8(this.hit);
    this.exactMask = growU8(this.exactMask);
    this.cap = next;
  }

  push(
    texel: number,
    sampleIdx: number,
    g: number,
    tri: number,
    u: number,
    v: number,
    q: Tuple3,
    nd: Tuple3,
    n: Tuple3,
    tan: Tuple3,
    hand: number,
    height: number,
    hit: boolean,
    exact: boolean,
  ): void {
    if (this.len === this.cap) this.grow(this.cap * 2);
    const i = this.len++;
    this.texel[i] = texel;
    this.sampleIdx[i] = sampleIdx;
    this.group[i] = g;
    this.tri[i] = tri;
    this.uv[i * 2] = u;
    this.uv[i * 2 + 1] = v;
    this.q[i * 3] = q[0];
    this.q[i * 3 + 1] = q[1];
    this.q[i * 3 + 2] = q[2];
    this.nd[i * 3] = nd[0];
    this.nd[i * 3 + 1] = nd[1];
    this.nd[i * 3 + 2] = nd[2];
    this.baseNormal[i * 3] = n[0];
    this.baseNormal[i * 3 + 1] = n[1];
    this.baseNormal[i * 3 + 2] = n[2];
    this.baseTangent[i * 4] = tan[0];
    this.baseTangent[i * 4 + 1] = tan[1];
    this.baseTangent[i * 4 + 2] = tan[2];
    this.baseTangent[i * 4 + 3] = hand;
    this.height[i] = height;
    this.hit[i] = hit ? 1 : 0;
    this.exactMask[i] = exact ? 1 : 0;
  }
}

/**
 * Run primary correspondence rasterization + raycasting once across every texel subsample,
 * storing the hit record for repeated map evaluations on CPU without redoing BVH rays.
 */
export function bakeCorrespondCpu(
  prepared: PreparedBake,
  work: WorkMeter,
): Result<CpuCorrespondenceData, ModelingError> {
  const { params, baker, groups, triangles, directions, hard, analytic } = prepared;
  if (params.target !== 'texture' || prepared.atlas === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'bakeCorrespond expects a texture-target bake with valid base uv0',
        { target: params.target },
      ),
    );
  }
  const { surface: b, islands, tiles, bins } = prepared.atlas;
  const gridDesc = gridOf(params);
  const { w: width, h: height } = gridDesc;
  const texels = width * height;
  const grid = Math.round(Math.sqrt(params.samples));
  const perTexel = grid * grid;
  const weight = new Float64Array(texels);
  const island = new Int32Array(texels).fill(NONE);
  const before = groups.map(counters);
  const [inner, outer] = prepared.encoding.heightRange;
  const heightTolerance = STACK_HEIGHT * (outer - inner);
  const stack = [0, 0, 0, -1, -1, 0, 0, -1];
  const uvOf = (t: number, k: number): [number, number] => {
    const i = b.indices[t * 3 + k] as number;
    return [(b.uv[i * 2] as number) * width, (b.uv[i * 2 + 1] as number) * height];
  };
  const mixed = (t: number) => {
    let sign = 0;
    for (let k = 0; k < 3; k++) {
      const w = b.tangent[(b.indices[t * 3 + k] as number) * 4 + 3] as number;
      const own = w < 0 ? -1 : 1;
      if (sign !== 0 && own !== sign) return true;
      sign = own;
    }
    return false;
  };
  const surfaceAt = baseSurfaceAt(b, triangles, directions, hard);
  const stackSample = (t: number, px: number, py: number) => {
    const [p0, p1, p2] = [0, 1, 2].map((k) => uvOf(t, k)) as [
      [number, number],
      [number, number],
      [number, number],
    ];
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    const w1 = ((px - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (py - p0[1])) / area;
    const w2 = ((p1[0] - p0[0]) * (py - p0[1]) - (px - p0[0]) * (p1[1] - p0[1])) / area;
    const at = surfaceAt(t, [1 - w1 - w2, w1, w2]);
    return baker.stackSample(at.pos, at.nrm, at.ray, [at.tan, at.hand], at.g, at.averaged);
  };
  const writer = new SampleWriter();
  for (const ty of allRows(params)) {
    const [y0, y1] = rowSpan(ty, height);
    const claimed = new Uint16Array((y1 - y0) * width);
    const claimant = new Int32Array((y1 - y0) * width * perTexel);
    for (let tx = 0; tx < tiles; tx++) {
      for (const t of bins[ty * tiles + tx] as number[]) {
        const [p0, p1, p2] = [0, 1, 2].map((k) => uvOf(t, k)) as [
          [number, number],
          [number, number],
          [number, number],
        ];
        const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
        if (area === 0) continue;
        const xs = [p0[0], p1[0], p2[0]];
        const ys = [p0[1], p1[1], p2[1]];
        const xa = Math.max(tx * BAKE_TILE, Math.floor(minOf(xs)));
        const xb = Math.min((tx + 1) * BAKE_TILE - 1, width - 1, Math.floor(maxOf(xs)));
        const ya = Math.max(y0, Math.floor(minOf(ys)));
        const yb = Math.min(y1 - 1, Math.floor(maxOf(ys)));
        for (let y = ya; y <= yb; y++) {
          for (let x = xa; x <= xb; x++) {
            const local = (y - y0) * width + x;
            const texel = y * width + x;
            for (let s = 0; s < perTexel; s++) {
              const taken = ((claimed[local] as number) & (1 << s)) !== 0;
              const px = x + ((s % grid) + 0.5) / grid;
              const py = y + (Math.floor(s / grid) + 0.5) / grid;
              const w1 = ((px - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (py - p0[1])) / area;
              const w2 = ((p1[0] - p0[0]) * (py - p0[1]) - (px - p0[0]) * (p1[1] - p0[1])) / area;
              const w0 = 1 - w1 - w2;
              if (w0 < 0 || w1 < 0 || w2 < 0) continue;
              if (taken) {
                if (w0 > 0 && w1 > 0 && w2 > 0) {
                  const first = claimant[local * perTexel + s] as number;
                  const a = stackSample(first, px, py);
                  const c = stackSample(t, px, py);
                  const angle =
                    (atan2(length(cross(a.normal, c.normal)), dot(a.normal, c.normal)) * 180) /
                    Math.PI;
                  const gap = Math.abs(a.height - c.height);
                  stack[0] = (stack[0] as number) + 1;
                  stack[5] = Math.max(stack[5] as number, gap);
                  if (angle > STACK_ANGLE || gap > heightTolerance) {
                    stack[1] = (stack[1] as number) + 1;
                    if (stack[3] === -1 || texel < (stack[3] as number)) {
                      stack[3] = texel;
                      stack[4] = b.triangleFace[t] as number;
                    }
                  }
                  stack[2] = Math.max(stack[2] as number, angle);
                }
                continue;
              }
              claimed[local] = (claimed[local] as number) | (1 << s);
              claimant[local * perTexel + s] = t;
              if (mixed(t)) {
                stack[6] = (stack[6] as number) + 1;
                const face = b.triangleFace[t] as number;
                if (stack[7] === -1 || face < (stack[7] as number)) stack[7] = face;
              }
              const at = surfaceAt(t, [w0, w1, w2]);
              baker.face = b.triangleFace[t] as number;
              const group = groups[at.g] as GroupBake;
              const exact =
                analytic !== undefined && analytic.plan.active[at.g] === 1
                  ? solveSample(
                      analytic.plan,
                      t,
                      [w0, w1, w2],
                      at.pos,
                      at.ray,
                      at.nrm,
                      triangleSide(triangles, t),
                      analytic.rules[at.g] as AnalyticRules,
                      at.averaged,
                    )
                  : undefined;
              if (analytic !== undefined) {
                if (exact === undefined) group.raySamples++;
                else group.analyticSamples++;
              }
              let tri = 0;
              let u = 0;
              let v = 0;
              let q: Tuple3 = [0, 0, 0];
              let nd: Tuple3 = at.nrm;
              let h = 0;
              let isHit = true;
              if (exact === undefined || analytic?.needRay) {
                const res = baker.resolveSample(at.pos, at.nrm, at.ray, at.g, at.averaged);
                tri = res.tri;
                u = res.u;
                v = res.v;
                q = res.q;
                nd = res.nd;
                h = res.height;
                isHit = res.hit;
              }
              if (exact !== undefined) {
                q = exact.point;
                nd = exact.normal;
                h = exact.height;
              }
              writer.push(
                texel,
                texel * 16 + s,
                at.g,
                tri,
                u,
                v,
                q,
                nd,
                at.nrm,
                at.tan,
                at.hand,
                h,
                isHit,
                exact !== undefined,
              );
              weight[texel] = (weight[texel] as number) + 1;
              if (island[texel] === NONE) island[texel] = islands[t] as number;
            }
          }
        }
      }
      if (!work.spend(1 + baker.work())) return err(work.failure as ModelingError);
    }
  }
  let covered = 0;
  for (let i = 0; i < texels; i++) if ((weight[i] as number) > 0) covered++;
  if (covered === 0) {
    return err(
      modelingError(
        'model-precondition',
        'the base uv0 covers at least one texel of the [0, 1] atlas',
        { resolution: params.resolution },
        'pack the base UVs into [0, 1] (m.uv.pack or m.uv.auto) before baking',
      ),
    );
  }
  const counts = new Float64Array(groups.length * GROUP_COUNTERS);
  for (const [g, group] of groups.entries()) {
    const was = before[g] as number[];
    counts.set(
      counters(group).map((x, k) => x - (was[k] as number)),
      g * GROUP_COUNTERS,
    );
  }
  const n = writer.len;
  return ok({
    prepared,
    grid: gridDesc,
    count: n,
    texel: writer.texel.slice(0, n),
    sampleIdx: writer.sampleIdx.slice(0, n),
    group: writer.group.slice(0, n),
    tri: writer.tri.slice(0, n),
    uv: writer.uv.slice(0, n * 2),
    q: writer.q.slice(0, n * 3),
    nd: writer.nd.slice(0, n * 3),
    baseNormal: writer.baseNormal.slice(0, n * 3),
    baseTangent: writer.baseTangent.slice(0, n * 4),
    height: writer.height.slice(0, n),
    hit: writer.hit.slice(0, n),
    exactMask: writer.exactMask.slice(0, n),
    weight,
    island,
    covered,
    counts,
    findings: baker.findings.drain(),
    stack: Float64Array.from(stack),
    handedness: { samples: stack[6] as number, face: stack[7] as number },
  });
}

/** Rebind an existing `PreparedBake` with updated map/slot/AO/encoding settings for `evaluateBakeMaps`. */
export function prepareEvalBake(
  prepared: PreparedBake,
  evalParams: BakeJobParams,
  resampleTexture?: { readonly width: number; readonly height: number; readonly data: Uint8Array },
): PreparedBake {
  const evalBaker = prepared.baker.withEvalParams(evalParams, resampleTexture);
  return {
    ...prepared,
    params: evalParams,
    baker: evalBaker,
    encoding: {
      heightRange: evalParams.height.range ?? prepared.encoding.heightRange,
      positionBounds:
        evalParams.position.bounds === prepared.params.position.bounds
          ? prepared.encoding.positionBounds
          : positionBounds(evalBaker.detail.position, evalParams.position.bounds),
      params: evalParams,
    },
  };
}

/**
 * Evaluate any compatible map set over an already-computed `CpuCorrespondenceData`,
 * skipping UV rasterization and primary correspondence raycasting completely.
 */
export function evaluateBakeMapsCpu(
  correspondence: CpuCorrespondenceData,
  evalParams: BakeJobParams,
  resampleTexture:
    | { readonly width: number; readonly height: number; readonly data: Uint8Array }
    | undefined,
  work: WorkMeter,
): Result<BackendOutput<'bake'>, ModelingError> {
  const { prepared, count, grid, weight, island, covered, counts, findings, stack, handedness } =
    correspondence;
  const maps = evalParams.maps;
  const texels = grid.w * grid.h;
  if (maps.includes('ao') || maps.includes('ormh') || maps.includes('thickness')) {
    ensureGroupBvhs(prepared);
  }
  const evalPrepared = prepareEvalBake(prepared, evalParams, resampleTexture);
  const evalBaker = evalPrepared.baker;
  const sums = maps.map(() => new Float64Array(texels * 4));
  const curving = guided(evalParams);
  const pointSum = new Float64Array(curving ? texels * 3 : 0);
  const normalSum = new Float64Array(curving ? texels * 3 : 0);
  const opacity = maps.indexOf('opacity');
  const hits = new Float64Array(opacity >= 0 ? texels : 0);
  const sample = new Float64Array(maps.length * 4);
  for (let k = 0; k < count; k++) {
    const texel = correspondence.texel[k] as number;
    const tri = correspondence.tri[k] as number;
    const u = correspondence.uv[k * 2] as number;
    const v = correspondence.uv[k * 2 + 1] as number;
    const q: Tuple3 = [
      correspondence.q[k * 3] as number,
      correspondence.q[k * 3 + 1] as number,
      correspondence.q[k * 3 + 2] as number,
    ];
    const nd: Tuple3 = [
      correspondence.nd[k * 3] as number,
      correspondence.nd[k * 3 + 1] as number,
      correspondence.nd[k * 3 + 2] as number,
    ];
    const nrm: Tuple3 = [
      correspondence.baseNormal[k * 3] as number,
      correspondence.baseNormal[k * 3 + 1] as number,
      correspondence.baseNormal[k * 3 + 2] as number,
    ];
    const tan: Tuple3 = [
      correspondence.baseTangent[k * 4] as number,
      correspondence.baseTangent[k * 4 + 1] as number,
      correspondence.baseTangent[k * 4 + 2] as number,
    ];
    const hand = correspondence.baseTangent[k * 4 + 3] as number;
    const h = correspondence.height[k] as number;
    const isHit = correspondence.hit[k] === 1;
    evalBaker.evaluateHit(
      tri,
      u,
      v,
      q,
      nd,
      h,
      isHit,
      nrm,
      [tan, hand],
      correspondence.group[k] as number,
      correspondence.sampleIdx[k] as number,
      sample,
      false,
    );
    const opaque = opacity < 0 || isHit;
    if (opacity >= 0 && opaque) hits[texel] = (hits[texel] as number) + 1;
    for (const [m, kind] of maps.entries()) {
      if (!opaque && m !== opacity) continue;
      const sum = sums[m] as Float64Array;
      if (kind === 'materialId') {
        if (sum[texel * 4 + 3] === 0) {
          for (let c = 0; c < 4; c++) sum[texel * 4 + c] = sample[m * 4 + c] as number;
        }
      } else {
        for (let c = 0; c < 4; c++)
          sum[texel * 4 + c] = (sum[texel * 4 + c] as number) + (sample[m * 4 + c] as number);
      }
    }
    if (curving && opaque) {
      for (let c = 0; c < 3; c++) {
        pointSum[texel * 3 + c] = (pointSum[texel * 3 + c] as number) + (q[c] as number);
        normalSum[texel * 3 + c] = (normalSum[texel * 3 + c] as number) + (nd[c] as number);
      }
    }
    if ((k & 4095) === 4095 && !work.spend(1 + evalBaker.work())) {
      return err(work.failure as ModelingError);
    }
  }
  const filtered = finishTexture(evalPrepared, {
    sums,
    pointSum,
    normalSum,
    weight,
    island,
    hits,
    stack: {
      samples: stack[0] as number,
      conflicts: stack[1] as number,
      maxAngle: stack[2] as number,
      maxHeight: stack[5] as number,
      face: stack[4] as number,
    },
    handedness,
    covered,
  });
  const part: BakeRows = {
    rows: allRows(evalParams),
    sums,
    weight,
    island,
    point: pointSum,
    normal: normalSum,
    hits,
    counts,
    findings,
    stack,
  };
  return finishBake(evalPrepared, [part], work, filtered);
}
