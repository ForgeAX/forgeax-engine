import type { StandardIrradianceFieldGi } from '../../pipeline/standard-profile';
import { packIrradianceFieldFrame } from '../../raytracing/irradiance-field';
import { planIrradianceField } from '../../raytracing/irradiance-field-plan';

export type Point = readonly [number, number, number];
export interface Triangle {
  readonly a: Point;
  readonly b: Point;
  readonly c: Point;
}
export const relocationProbe = 21;
export const relocationRays = 256;
export const relocationScales = [1, 1 / 65536, 32768, 65536] as const;
export const relocationNormalizedTolerance = 0.006;
export const boxHalf: Point = [0.8, 4, 3];
export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function normal(t: Triangle): Point {
  const n = cross(sub(t.b, t.a), sub(t.c, t.a));
  const l = Math.hypot(...n);
  return [n[0] / l, n[1] / l, n[2] / l];
}
/** Complete outward-oriented closed geometry; reflection preserves authored outward orientation. */
export function authoredBox(mirror = false): Triangle[] {
  const vertices: Point[] = [];
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++)
        vertices.push([
          (x ? 1 : -1) * boxHalf[0] * (mirror ? -1 : 1),
          (y ? 1 : -1) * boxHalf[1],
          (z ? 1 : -1) * boxHalf[2],
        ]);
  const quads = [
    [0, 2, 6, 4],
    [1, 5, 7, 3],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 1, 3, 2],
    [4, 6, 7, 5],
  ];
  const result: Triangle[] = [];
  for (const q of quads)
    for (const ids of [
      [q[0], q[1], q[2]],
      [q[0], q[2], q[3]],
    ]) {
      const a = vertices[ids[0] ?? -1],
        b = vertices[ids[1] ?? -1],
        c = vertices[ids[2] ?? -1];
      if (!a || !b || !c) throw new Error('Invalid authored triangle index');
      let t: Triangle = { a, b, c };
      const center: Point = [
        (t.a[0] + t.b[0] + t.c[0]) / 3,
        (t.a[1] + t.b[1] + t.c[1]) / 3,
        (t.a[2] + t.b[2] + t.c[2]) / 3,
      ];
      if (dot(normal(t), center) < 0) t = { a: t.a, b: t.c, c: t.b };
      result.push(t);
    }
  return result;
}
/** Double precision authored-triangle intersection. No SDF, cache lookup or relocation implementation. */
export function nearestTriangle(triangles: readonly Triangle[], origin: Point, direction: Point) {
  let nearest: { distance: number; normal: Point; triangle: number } | undefined;
  for (const [index, t] of triangles.entries()) {
    const e1 = sub(t.b, t.a),
      e2 = sub(t.c, t.a),
      p = cross(direction, e2),
      det = dot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det,
      s = sub(origin, t.a),
      u = dot(s, p) * inv;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1),
      v = dot(direction, q) * inv;
    if (v < 0 || u + v > 1) continue;
    const distance = dot(e2, q) * inv;
    if (distance > 1e-7 && (!nearest || distance < nearest.distance))
      nearest = { distance, normal: normal(t), triangle: index };
  }
  return nearest;
}
/** Independent analytic half-space reference for this axis-aligned closed solid. */
export function insideBox(point: Point): boolean {
  return point.every((v, a) => Math.abs(v) < (boxHalf[a] ?? Number.NaN) - 1e-6);
}
/** Independent interval/half-space intersection checks the full triangle oracle. */
export function nearestHalfspace(origin: Point, direction: Point): number | undefined {
  let enter = -Infinity,
    exit = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const p = origin[axis] ?? Number.NaN,
      d = direction[axis] ?? Number.NaN,
      half = boxHalf[axis] ?? Number.NaN;
    if (Math.abs(d) < 1e-14) {
      if (Math.abs(p) > half) return;
      continue;
    }
    const a = (-half - p) / d,
      b = (half - p) / d;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  }
  if (enter > exit || exit <= 1e-7) return;
  return enter > 1e-7 ? enter : exit;
}
export function relocationPlan(scale: number) {
  const field: StandardIrradianceFieldGi['field'] = {
    region: {
      grid: {
        origin: [0, 0, 0],
        dimensions: [16, 16, 16],
        spacing: scale,
        maxDistance: 4 * scale,
        coverageDistance: 2 * scale,
      },
      maxInstances: 16,
      maxFieldBytes: 16 * 1024 * 1024,
    },
    probeSpacing: 4 * scale,
    raysPerProbe: relocationRays,
    probeBudget: 1,
    hysteresis: 0.9,
    cards: { resolution: 8, maxCaptureBytes: 8 * 1024 * 1024, budget: 1 },
    resolution: 'half',
    radiosity: false,
  };
  return planIrradianceField(field).unwrap();
}
export function relocationFrame(scale: number, frameIndex: number) {
  return packIrradianceFieldFrame({
    worldSource: { traversal: 'unused' },
    probeBudget: 1,
    raysPerProbe: relocationRays,
    frameIndex,
    tileOffset: 0,
    tileBudget: 0,
    tileCount: 0,
    lightCount: 0,
    cardResolution: 1,
    atlasWidth: 1,
    radiosity: false,
    environment: [0, 0, 0],
    hysteresis: 0.9,
    maxDistance: 48 * scale,
    surfaceBias: 0,
    depthClamp: 12 * scale,
    cardMargin: 0,
    gather: [1, 1, 1, 1],
    query: new Uint8Array(8),
    reflections: [0, 0],
  });
}
export function geometryRays(
  directions: Float32Array,
  origin: Point,
  scale: number,
  mirror = false,
  wrongNormals = false,
) {
  const rays = new Float32Array(relocationRays * 8),
    triangles = authoredBox(mirror);
  let backs = 0;
  for (let r = 0; r < relocationRays; r++) {
    const direction: Point = [
      directions[r * 4] ?? Number.NaN,
      directions[r * 4 + 1] ?? Number.NaN,
      directions[r * 4 + 2] ?? Number.NaN,
    ];
    const hit = nearestTriangle(triangles, origin, direction);
    const analytic = nearestHalfspace(origin, direction);
    if (
      (hit === undefined) !== (analytic === undefined) ||
      (hit && analytic !== undefined && Math.abs(hit.distance - analytic) > 1e-8)
    )
      throw new Error('Independent triangle/half-space nearest intersection disagreement');
    const back = hit && dot(direction, hit.normal) * (wrongNormals ? -1 : 1) > 0;
    if (back) backs++;
    const rgb =
      hit && !back
        ? [1 + 0.2 * direction[0], 0.8 + 0.1 * direction[1], 0.6 + 0.1 * direction[2]]
        : [0, 0, 0];
    rays.set(
      [...rgb, hit ? hit.distance * scale : 12 * scale, ...direction, back ? 2 : hit ? 1 : 0],
      r * 8,
    );
  }
  return { rays, backs };
}
export function placementFailures(point: Point, meta: Uint32Array, scale: number, lattice: Point) {
  const failures: string[] = [];
  if (!point.every(Number.isFinite)) failures.push('placed origin is non-finite');
  const offset = sub(point, lattice).map((v) => v / scale);
  if (offset.some((v) => !Number.isFinite(v) || Math.abs(v) > 1.8 + relocationNormalizedTolerance))
    failures.push('normalized offset exceeds relocation bounds');
  const normalized: Point = [
    offset[0] ?? Number.NaN,
    offset[1] ?? Number.NaN,
    offset[2] ?? Number.NaN,
  ];
  if (meta[relocationProbe * 4 + 1] === 1 && insideBox(normalized))
    failures.push('active probe remains inside authored solid');
  return { failures, offset, inside: insideBox(normalized) };
}
