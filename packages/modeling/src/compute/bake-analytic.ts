import { atan2 } from '../dmath';
import { exactPatchNormal, patchTags } from '../finish';
import { cross, dot, length, scale, sub, type Tuple3 } from '../geom';
import type { CornerChannelName, EditMesh } from '../mesh';
import { surfaceDerivatives, surfaceDomain, surfacePoint } from '../nurbs';
import type { AnalyticFallback, AnalyticMap, AnalyticPatch } from './job';

/**
 * The analytic bake (BK63): the exact patch answers where the base carries its domain. This
 * module holds the descriptor evaluation, the ray-patch solve with its acceptance rules, the
 * tolerance and the coverage plan; `bake-ts.ts` drives them per sample and runs the verifier.
 * Nothing here imports from `brep/`: a primitive-Shape producer (X6a) supplies `AnalyticPatch`
 * data, and a new `kind` adds one case to `evaluate` and one to `normalAt`.
 */

/** A patch point and its derivatives with respect to the normalized domain (s, t). */
export interface PatchPoint {
  readonly point: Tuple3;
  readonly ds: Tuple3;
  readonly dt: Tuple3;
}

/** The one point evaluation of a descriptor, by kind. */
export function evaluate(patch: AnalyticPatch, s: number, t: number): PatchPoint {
  switch (patch.kind) {
    case 'nurbs': {
      const [[u0, u1], [v0, v1]] = surfaceDomain(patch.surface);
      const d = surfaceDerivatives(patch.surface, u0 + (u1 - u0) * s, v0 + (v1 - v0) * t, 1);
      return {
        point: (d[0] as Tuple3[])[0] as Tuple3,
        ds: scale((d[1] as Tuple3[])[0] as Tuple3, u1 - u0),
        dt: scale((d[0] as Tuple3[])[1] as Tuple3, v1 - v0),
      };
    }
  }
}

/** The unit normal of a descriptor at (s, t) (the limit at a pole), undefined where it has none. */
export function normalAt(patch: AnalyticPatch, s: number, t: number): Tuple3 | undefined {
  switch (patch.kind) {
    case 'nurbs':
      return exactPatchNormal(patch.surface, s, t);
  }
}

/** The acceptance rules of one group: the ray bake's own correspondence limits, as data. */
export interface AnalyticRules {
  /** Cage span of the signed distance along the ray: `[offset - maxRay, offset]`. */
  readonly lo: number;
  readonly hi: number;
  /** Smallest cosine between the oriented patch normal and the ray (the ray bake's 84 degree rule). */
  readonly facingMin: number;
  /** Smallest cosine to the base shading normal under an averaged cage ray; undefined: unchecked. */
  readonly ownSideCos?: number;
  /** Largest residual of the solve, meters. */
  readonly residual: number;
}

/** An accepted exact correspondence: the patch point the ray bake's ray would find. */
export interface PatchSolve {
  readonly patch: number;
  readonly s: number;
  readonly t: number;
  readonly point: Tuple3;
  readonly normal: Tuple3;
  /** `dot(point - P, c)`, the ray bake's height. */
  readonly height: number;
}

const MAX_ITERATIONS = 8;
const BACKTRACK = 5;

function triple(a: Tuple3, b: Tuple3, c: Tuple3): number {
  return dot(a, cross(b, c));
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Solve `S(s, t) = P + lambda c` for the patch (damped Newton from the domain seed, 3x3 Cramer
 * solve, (s, t) clamped to the domain) and accept it under the rules, or return undefined: the
 * sample is then ray-baked. `side` is the base triangle's geometric normal; the patch normal
 * is turned to its side as `surfaceNormals` does, which makes reflected patches exact. A
 * solve that does not converge never yields a value.
 */
export function solveRay(
  patch: AnalyticPatch,
  seed: readonly [number, number],
  p: Tuple3,
  c: Tuple3,
  shading: Tuple3,
  side: Tuple3 | undefined,
  rules: AnalyticRules,
  averaged: boolean,
): Omit<PatchSolve, 'patch'> | undefined {
  let s = clamp01(seed[0]);
  let t = clamp01(seed[1]);
  const cc = dot(c, c);
  if (!(cc > 0)) return undefined;
  let e = evaluate(patch, s, t);
  let lambda = dot(sub(e.point, p), c) / cc;
  const residualOf = (point: Tuple3, l: number) =>
    length([point[0] - p[0] - c[0] * l, point[1] - p[1] - c[1] * l, point[2] - p[2] - c[2] * l]);
  let r = residualOf(e.point, lambda);
  const back: Tuple3 = [-c[0], -c[1], -c[2]];
  for (let it = 0; it < MAX_ITERATIONS && r > rules.residual; it++) {
    const f: Tuple3 = [
      -(e.point[0] - p[0] - c[0] * lambda),
      -(e.point[1] - p[1] - c[1] * lambda),
      -(e.point[2] - p[2] - c[2] * lambda),
    ];
    const det = triple(e.ds, e.dt, back);
    if (!(Math.abs(det) > 1e-12 * length(e.ds) * length(e.dt) * length(c))) return undefined;
    const dS = triple(f, e.dt, back) / det;
    const dT = triple(e.ds, f, back) / det;
    const dL = triple(e.ds, e.dt, f) / det;
    let alpha = 1;
    let moved = false;
    for (let k = 0; k < BACKTRACK; k++, alpha /= 2) {
      const s2 = clamp01(s + alpha * dS);
      const t2 = clamp01(t + alpha * dT);
      const l2 = lambda + alpha * dL;
      const e2 = evaluate(patch, s2, t2);
      const r2 = residualOf(e2.point, l2);
      if (r2 < r) {
        s = s2;
        t = t2;
        lambda = l2;
        e = e2;
        r = r2;
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  if (!(r <= rules.residual)) return undefined;
  const height = dot(sub(e.point, p), c);
  if (!(height >= rules.lo - rules.residual && height <= rules.hi + rules.residual)) {
    return undefined;
  }
  const m = normalAt(patch, s, t);
  if (m === undefined) return undefined;
  const normal: Tuple3 = side !== undefined && dot(m, side) < 0 ? [-m[0], -m[1], -m[2]] : m;
  if (!(dot(normal, c) > rules.facingMin)) return undefined;
  if (averaged && rules.ownSideCos !== undefined && dot(normal, shading) < rules.ownSideCos) {
    return undefined;
  }
  return { s, t, point: e.point, normal, height };
}

/** Quantization steps of the encoded maps: the unit of agreement between the two paths. */
export interface Steps {
  /** Height step `(outer - inner) / (2^bits - 1)`, meters. */
  readonly height: number;
  /** Position step, the largest bounds extent over 255, meters. */
  readonly position: number;
  /** One rgba8 normal component step as an angle, degrees. */
  readonly normal: number;
}

/** The normal step of rgba8: `atan(2 / 255)` in degrees. */
export function normalStep(): number {
  return (atan2(2 / 255, 1) * 180) / Math.PI;
}

/**
 * The allowed disagreement of the detail's facets and the exact patch. Height and position: the
 * patch `chord`. Normal: the verifier compares the exact normal with the normal of the detail
 * facet the ray hit (`Baker.facetNormal`), which differs from the exact normal by less than the
 * turn of the exact normal across that facet. `turn` is the measured largest such turn of the
 * detail, plus one encoded step. Without a measurement (no domain channel on the detail) the
 * recorded declared tolerance `angle` stands in for it. That is not a verified bound on the honest
 * facet deviation: without uv1 the normal check is chord-limited to about `chord * sin(angle)`,
 * so a tilt of up to about 11 degrees at the default angle 12 is accepted there (documented loss,
 * reference/uv-bake.md).
 */
export function allowed(
  patch: AnalyticPatch,
  steps: Steps,
  turn = -1,
): Record<AnalyticMap, number> {
  return {
    height: Math.max(steps.height, patch.chord),
    position: Math.max(steps.position, patch.chord),
    normal: (turn >= 0 ? turn : patch.angle) + steps.normal,
  };
}

/** The allowed disagreement of the plan's patch `k`. */
export function limitOf(plan: AnalyticPlan, k: number, steps: Steps): Record<AnalyticMap, number> {
  return allowed(plan.patches[k] as AnalyticPatch, steps, plan.turn[k]);
}

/** Coverage of an analytic bake: which base triangles, patches and groups are answered exactly. */
export interface AnalyticPlan {
  readonly patches: readonly AnalyticPatch[];
  /** CSR over base triangles: candidate patch indices `candidate[start[t]..start[t + 1])`. */
  readonly start: Int32Array;
  readonly candidate: Int32Array;
  /** Six numbers per base triangle: the (s, t) of its three corners. */
  readonly domain: Float64Array;
  /** Per group: 1 while the group is answered analytically. */
  readonly active: Uint8Array;
  /** Per group: why it is ray-baked, undefined while active. */
  readonly reason: (AnalyticFallback | undefined)[];
  /** Per group: names of the patches describing its detail. */
  readonly names: string[][];
  /** Per patch: the allowed normal turn, see `allowed` (-1: not measured). */
  readonly turn: number[];
  /** Per group: detail corners the guard compared with its patches. */
  readonly guarded: number[];
  /** Patches of an analytic-eligible group whose detail vertices left them (the group is ray-baked). */
  readonly stale: { readonly group: number; readonly patch: number; readonly guard: PatchGuard }[];
}

export interface PlanInput {
  readonly base: EditMesh;
  readonly detail: EditMesh;
  readonly domain: CornerChannelName;
  readonly patches: readonly AnalyticPatch[];
  readonly groups: number;
  /** Base render surface: triangle corners, their FXEM half-edges, faces and group. */
  readonly indices: ArrayLike<number>;
  readonly vertexCorner: ArrayLike<number>;
  readonly triangleFace: ArrayLike<number>;
  readonly triangleGroup: ArrayLike<number>;
  /** Group per FXEM face of the detail (NONE for dead faces) and its floater flag. */
  readonly detailFaceGroup: ArrayLike<number>;
  readonly floater: ArrayLike<number>;
  /** The detail is repeated by a wrap period: the patches describe one tile only. */
  readonly tiled: boolean;
  /** The detail corner channel holding the patch domain (the guard reads it). */
  readonly detailDomain: CornerChannelName;
}

/** Most detail faces of one patch the stale-descriptor guard compares (a deterministic stride over the rest). */
const GUARD_FACES = 2048;

/** What the guard found for one patch: corners compared, corners beyond the chord and the largest distance. */
export interface PatchGuard {
  readonly checked: number;
  readonly moved: number;
  readonly worst: number;
  /** Largest turn of the exact normal between consecutive corners of one detail face, degrees (-1: not measured). */
  readonly turn: number;
}

/**
 * The stale-descriptor guard: a descriptor is trusted only while the detail's own vertices
 * still lie on it. Each detail corner of a face tagged with the patch (its exact name, not a
 * parent's, and no other patch's: a mesh `tag` equal to one patch name tags every face) carries the patch domain (s, t); the patch evaluated there must be within the
 * patch `chord` of the corner's vertex. A transform or edit of the detail after the patch was
 * recorded moves the vertices and not the descriptor, so the patch fails here whatever the
 * verifier mode. A detail without the domain channel is not guarded (`checked` 0).
 */
export function guardPatches(
  detail: EditMesh,
  patches: readonly AnalyticPatch[],
  domain: CornerChannelName,
): PatchGuard[] {
  return patches.map((patch) => {
    const tag = detail.tagIndex(patch.name, false);
    if (tag < 0) {
      return { checked: 0, moved: 0, worst: 0, turn: -1 };
    }
    const [[u0, u1], [v0, v1]] = surfaceDomain(patch.surface);
    const others = patches.flatMap((q) => {
      const t = detail.tagIndex(q.name, false);
      return t < 0 || t === tag ? [] : [t];
    });
    const faces = detail
      .faces()
      .filter((f) => detail.hasTag(f, tag) && !others.some((t) => detail.hasTag(f, t)));
    const stride = Math.max(1, Math.ceil(faces.length / GUARD_FACES));
    let checked = 0;
    let moved = 0;
    let worst = 0;
    let turn = -1;
    for (let i = 0; i < faces.length; i += stride) {
      const f = faces[i] as number;
      const vertices = detail.faceVertices(f);
      const halves = detail.faceHalves(f);
      const normals: (Tuple3 | undefined)[] = [];
      for (const [k, h] of halves.entries()) {
        const st = detail.corner(domain, h);
        if (st === undefined) {
          normals.push(undefined);
          continue;
        }
        normals.push(normalAt(patch, clamp01(st[0] as number), clamp01(st[1] as number)));
        const at = surfacePoint(
          patch.surface,
          u0 + (u1 - u0) * clamp01(st[0] as number),
          v0 + (v1 - v0) * clamp01(st[1] as number),
        );
        const d = length(sub(at, detail.position(vertices[k] as number)));
        checked++;
        worst = Math.max(worst, d);
        if (d > patch.chord) moved++;
      }
      for (let k = 0; k < normals.length; k++) {
        const a = normals[k];
        const b = normals[(k + 1) % normals.length];
        if (a !== undefined && b !== undefined) turn = Math.max(turn, angleBetween(a, b));
      }
    }
    return { checked, moved, worst, turn };
  });
}

/**
 * Plan the coverage: a group is analytic when every detail face of it carries a patch tag and
 * none floats ("fully described"); a base triangle is analytic when the domain is set on its
 * three corners and a patch of its group tags its face. Everything else is ray-baked.
 */
export function planAnalytic(input: PlanInput): AnalyticPlan {
  const { base, detail, patches, groups } = input;
  const detailTags = patches.map((p) => patchTags(detail, p.name));
  const baseTags = patches.map((p) => patchTags(base, p.name));
  const described: boolean[] = Array.from({ length: groups }, () => true);
  const faces = new Array<number>(groups).fill(0);
  const used: Set<number>[] = Array.from({ length: groups }, () => new Set());
  for (const f of detail.faces()) {
    const g = input.detailFaceGroup[f] as number;
    if (g < 0) continue;
    faces[g] = (faces[g] as number) + 1;
    const matched = detailTags.flatMap((tags, k) =>
      tags.some((t) => t >= 0 && detail.hasTag(f, t)) ? [k] : [],
    );
    if (matched.length === 0 || input.floater[f] === 1) described[g] = false;
    for (const k of matched) used[g]?.add(k);
  }
  const triangles = input.indices.length / 3;
  const start = new Int32Array(triangles + 1);
  const candidate: number[] = [];
  const domain = new Float64Array(triangles * 6);
  const analyticTriangles = new Array<number>(groups).fill(0);
  const baseTriangles = new Array<number>(groups).fill(0);
  for (let t = 0; t < triangles; t++) {
    start[t] = candidate.length;
    const g = input.triangleGroup[t] as number;
    if (g < 0) continue;
    baseTriangles[g] = (baseTriangles[g] as number) + 1;
    if (input.tiled || !described[g] || faces[g] === 0) continue;
    const corners: number[] = [];
    for (let k = 0; k < 3; k++) {
      const h = input.vertexCorner[input.indices[t * 3 + k] as number] as number;
      const st = base.corner(input.domain, h);
      if (st === undefined) break;
      corners.push(st[0] as number, st[1] as number);
    }
    if (corners.length !== 6) continue;
    const f = input.triangleFace[t] as number;
    const own = [...(used[g] as Set<number>)].filter((k) =>
      (baseTags[k] as number[]).some((tag) => tag >= 0 && base.hasTag(f, tag)),
    );
    if (own.length === 0) continue;
    for (const k of own) candidate.push(k);
    domain.set(corners, t * 6);
    analyticTriangles[g] = (analyticTriangles[g] as number) + 1;
  }
  start[triangles] = candidate.length;
  const active = new Uint8Array(groups);
  const reason: (AnalyticFallback | undefined)[] = [];
  const guard = guardPatches(detail, patches, input.detailDomain);
  const guarded = new Array<number>(groups).fill(0);
  const stale: AnalyticPlan['stale'][number][] = [];
  const movedGroups = new Set<number>();
  for (let g = 0; g < groups; g++) {
    for (const k of used[g] as Set<number>) {
      const found = guard[k] as PatchGuard;
      guarded[g] = (guarded[g] as number) + found.checked;
      if (found.moved > 0) {
        movedGroups.add(g);
        stale.push({ group: g, patch: k, guard: found });
      }
    }
  }
  for (let g = 0; g < groups; g++) {
    if (input.tiled) reason.push('tiled-detail');
    else if (!described[g] && (baseTriangles[g] as number) > 0) reason.push('detail-not-patches');
    else if ((analyticTriangles[g] as number) === 0) reason.push('no-patches');
    else if (movedGroups.has(g)) {
      reason.push('detail-moved');
    } else {
      reason.push(undefined);
      active[g] = 1;
    }
  }
  return {
    patches,
    start,
    candidate: Int32Array.from(candidate),
    domain,
    active,
    reason,
    names: used.map((set, g) =>
      described[g] ? [...set].map((k) => (patches[k] as AnalyticPatch).name).sort() : [],
    ),
    turn: guard.map((x) => x.turn),
    guarded,
    stale: stale.filter((x) => reason[x.group] === 'detail-moved'),
  };
}

/**
 * The exact correspondence of one base sample (barycentrics `w` in triangle `t`): the nearest
 * accepted candidate patch, or undefined when the sample is ray-baked.
 */
export function solveSample(
  plan: AnalyticPlan,
  t: number,
  w: readonly number[],
  p: Tuple3,
  c: Tuple3,
  shading: Tuple3,
  side: Tuple3 | undefined,
  rules: AnalyticRules,
  averaged: boolean,
): PatchSolve | undefined {
  const d = plan.domain;
  const seed: [number, number] = [
    (w[0] as number) * (d[t * 6] as number) +
      (w[1] as number) * (d[t * 6 + 2] as number) +
      (w[2] as number) * (d[t * 6 + 4] as number),
    (w[0] as number) * (d[t * 6 + 1] as number) +
      (w[1] as number) * (d[t * 6 + 3] as number) +
      (w[2] as number) * (d[t * 6 + 5] as number),
  ];
  let best: PatchSolve | undefined;
  for (let i = plan.start[t] as number; i < (plan.start[t + 1] as number); i++) {
    const k = plan.candidate[i] as number;
    const solved = solveRay(
      plan.patches[k] as AnalyticPatch,
      seed,
      p,
      c,
      shading,
      side,
      rules,
      averaged,
    );
    if (solved === undefined) continue;
    if (best === undefined || Math.abs(solved.height) < Math.abs(best.height))
      best = { ...solved, patch: k };
  }
  return best;
}

/** Van der Corput radical inverse (base 2) in [0, 1). */
function corput(i: number): number {
  let bits = i >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits / 4294967296;
}

/**
 * `count` deterministic points over triangles with the given areas, stratified by area: point
 * k lies in the triangle holding cumulative area `(k + 0.5) / count`, at a low-discrepancy
 * barycentric (fixed sequence, no random seed).
 */
export function stratifiedSamples(
  areas: readonly number[],
  count: number,
): { readonly index: number; readonly w: readonly [number, number, number] }[] {
  const cumulative: number[] = [];
  let total = 0;
  for (const a of areas) {
    total += a;
    cumulative.push(total);
  }
  const out: { index: number; w: [number, number, number] }[] = [];
  if (!(total > 0)) return out;
  let cursor = 0;
  for (let k = 0; k < count; k++) {
    const target = ((k + 0.5) / count) * total;
    while (cursor < areas.length - 1 && (cumulative[cursor] as number) < target) cursor++;
    let u = corput(k + 1);
    let v = ((k + 1) * 0.5698402909980532) % 1;
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    out.push({ index: cursor, w: [1 - u - v, u, v] });
  }
  return out;
}

/** Deviations from the ray bake per map, in the map's units (meters, degrees). */
export class Deviations {
  private readonly values: Record<AnalyticMap, number[]> = { position: [], normal: [], height: [] };

  add(map: AnalyticMap, x: number): void {
    this.values[map].push(x);
  }

  summary(map: AnalyticMap): { verified: number; max: number; p99: number } {
    const sorted = [...this.values[map]].sort((a, b) => a - b);
    if (sorted.length === 0) return { verified: 0, max: 0, p99: 0 };
    return {
      verified: sorted.length,
      max: sorted[sorted.length - 1] as number,
      p99: sorted[Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1)] as number,
    };
  }
}

/** Angle between two unit vectors, degrees. */
export function angleBetween(a: Tuple3, b: Tuple3): number {
  return (atan2(length(cross(a, b)), dot(a, b)) * 180) / Math.PI;
}
