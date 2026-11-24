import { SDF_SURFACE_INTERSECTION_WGSL } from '../sdf-surface-intersection-wgsl';
import { exactEndpointDyadic } from './sdf-surface-exact-endpoints.fixture';

type V3 = readonly [number, number, number];
type Triangle = readonly [V3, V3, V3];
interface ClosedCase {
  readonly name: string;
  readonly triangle: Triangle;
  readonly origin: V3;
  readonly direction: V3;
  readonly range: readonly [number, number];
  readonly originHi?: V3;
  readonly directionHi?: V3;
  readonly required: 'hit' | 'unknown' | 'safety';
}
const triangle: Triangle = [
  [1, 1, 0],
  [5, 1, 0],
  [1, 5, 0],
];
const view = new DataView(new ArrayBuffer(4));
function bits(value: number) {
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}
function value(word: number) {
  view.setUint32(0, word, true);
  return view.getFloat32(0, true);
}
const adjacent = (n: number, delta: number) => value(bits(n) + delta);

export function closedBoundaryCases(): readonly ClosedCase[] {
  const result: ClosedCase[] = [];
  const boundary: readonly [string, V3][] = [
    ['edge-AB', [3, 1, 2]],
    ['edge-AC', [1, 3, 2]],
    ['edge-BC', [3, 3, 2]],
    ['vertex-A', [1, 1, 2]],
    ['vertex-B', [5, 1, 2]],
    ['vertex-C', [1, 5, 2]],
  ];
  const base = {
    triangle,
    origin: [2, 2, 2] as V3,
    direction: [0, 0, -1] as V3,
    range: [0, 4] as const,
  };
  for (const transform of ['identity', 'mirror', 'nonuniform'] as const) {
    const point = ([x, y, z]: V3): V3 =>
      transform === 'mirror'
        ? [-x, y, z]
        : transform === 'nonuniform'
          ? [2 * x, y / 2, 4 * z]
          : [x, y, z];
    for (const reverse of [false, true])
      for (const [name, origin] of boundary) {
        const [a, b, c] = triangle.map(point) as [V3, V3, V3];
        result.push({
          ...base,
          name: `${transform}/${reverse ? 'reversed' : 'front'}/${name}`,
          triangle: reverse ? [a, c, b] : [a, b, c],
          origin: point(origin),
          direction: point(base.direction),
          required: 'hit',
        });
      }
  }
  const safety: readonly [string, V3][] = [
    ['edge-AB-in', [3, adjacent(1, 1), 2]],
    ['edge-AB-out', [3, adjacent(1, -1), 2]],
    ['edge-AC-in', [adjacent(1, 1), 3, 2]],
    ['edge-AC-out', [adjacent(1, -1), 3, 2]],
    ['edge-BC-in', [adjacent(3, -1), 3, 2]],
    ['edge-BC-out', [adjacent(3, 1), 3, 2]],
    ['vertex-A-in', [adjacent(1, 1), adjacent(1, 1), 2]],
    ['vertex-A-out', [adjacent(1, -1), 1, 2]],
    ['vertex-B-in', [adjacent(5, -1), adjacent(1, 1), 2]],
    ['vertex-B-out', [adjacent(5, 1), 1, 2]],
    ['vertex-C-in', [adjacent(1, 1), adjacent(5, -1), 2]],
    ['vertex-C-out', [1, adjacent(5, 1), 2]],
  ];
  for (const [name, origin] of safety) result.push({ ...base, name, origin, required: 'safety' });
  result.push(
    {
      ...base,
      name: 'cross-AB',
      origin: [3, adjacent(1, -1), 2],
      originHi: [3, adjacent(1, 1), 2],
      required: 'unknown',
    },
    {
      ...base,
      name: 'cross-AC',
      origin: [adjacent(1, -1), 3, 2],
      originHi: [adjacent(1, 1), 3, 2],
      required: 'unknown',
    },
    {
      ...base,
      name: 'cross-BC',
      origin: [adjacent(3, -1), 3, 2],
      originHi: [adjacent(3, 1), 3, 2],
      required: 'unknown',
    },
    {
      ...base,
      name: 'det-upper',
      origin: [3, 2.75, 2],
      direction: [0.125, 0, -1],
      directionHi: [0.125, 0, -0.5],
      required: 'unknown',
    },
    {
      ...base,
      name: 'time-overlap',
      origin: [2, 2, 1],
      originHi: [2, 2, 2],
      range: [2, 3],
      required: 'unknown',
    },
    {
      ...base,
      name: 'edge-contained-box',
      origin: [2, 1, 2],
      originHi: [4, 1, 2],
      required: 'hit',
    },
    {
      ...base,
      name: 'closed-time-box',
      origin: [2, 2, 1],
      originHi: [2, 2, 2],
      range: [1, 2],
      required: 'hit',
    },
    { ...base, name: 'time-singleton', range: [2, 2], required: 'hit' },
    {
      ...base,
      name: 'degenerate',
      triangle: [triangle[0], triangle[0], triangle[2]],
      required: 'unknown',
    },
    {
      ...base,
      name: 'collinear',
      triangle: [
        [1, 1, 0],
        [3, 3, 0],
        [5, 5, 0],
      ],
      required: 'unknown',
    },
    { ...base, name: 'parallel', direction: [1, 0, 0], required: 'unknown' },
    { ...base, name: 'coplanar', origin: [3, 1, 0], direction: [1, 0, 0], required: 'unknown' },
    {
      ...base,
      name: 'direction-crosses-parallel',
      origin: [2, 2, 0],
      direction: [0, 0, -1],
      directionHi: [0, 0, 1],
      required: 'unknown',
    },
    {
      ...base,
      name: 'nearparallel',
      origin: [2, 2, 2 ** -100],
      direction: [0, 0, -(2 ** -100)],
      range: [0, 2],
      required: 'safety',
    },
  );
  return result;
}

const scale = 1n << 149n;
const q = (n: number) => exactEndpointDyadic(bits(n));
const sub = (a: readonly bigint[], b: readonly bigint[]) => a.map((v, i) => v - (b[i] ?? 0n));
const dot = (a: readonly bigint[], b: readonly bigint[]) =>
  a.reduce((sum, v, i) => sum + v * (b[i] ?? 0n), 0n);
const cross = (a: readonly bigint[], b: readonly bigint[]) => [
  (a[1] ?? 0n) * (b[2] ?? 0n) - (a[2] ?? 0n) * (b[1] ?? 0n),
  (a[2] ?? 0n) * (b[0] ?? 0n) - (a[0] ?? 0n) * (b[2] ?? 0n),
  (a[0] ?? 0n) * (b[1] ?? 0n) - (a[1] ?? 0n) * (b[0] ?? 0n),
];
function vectorCorners(lo: V3, hi: V3) {
  return Array.from({ length: 8 }, (_, mask) =>
    lo.map((v, axis) => q(mask & (1 << axis) ? (hi[axis] ?? v) : v)),
  );
}

/** Plane intersection followed by oriented edge halfspaces, independently of Moller. */
function planeSample(row: ClosedCase, origin: readonly bigint[], direction: readonly bigint[]) {
  const [a = [], b = [], c = []] = row.triangle.map((p) => p.map(q));
  const normal = cross(sub(b, a), sub(c, a)),
    denominator = dot(normal, direction);
  if (denominator === 0n) return undefined;
  const frontFace = denominator < 0n ? 1 : 0,
    sign = denominator > 0n ? 1n : -1n;
  const d = denominator * sign,
    n = dot(normal, sub(a, origin)) * sign;
  const point = origin.map((v, i) => v * d + (direction[i] ?? 0n) * n);
  const halfspaces = [a, b, c].map((v, i, vertices) =>
    dot(
      normal,
      cross(
        sub(vertices[(i + 1) % 3] ?? [], v),
        point.map((p, axis) => p - (v[axis] ?? 0n) * d),
      ),
    ),
  );
  return {
    n,
    d,
    frontFace,
    halfspaces,
    hit:
      halfspaces.every((v) => v >= 0n) &&
      n * scale >= q(row.range[0]) * d &&
      n * scale <= q(row.range[1]) * d,
  };
}

export function closedBoundaryInput(cases = closedBoundaryCases()) {
  const words = new Uint32Array(cases.length * 32);
  cases.forEach((row, i) => {
    let offset = i * 32;
    for (const point of [
      ...row.triangle,
      row.origin,
      row.originHi ?? row.origin,
      row.direction,
      row.directionHi ?? row.direction,
    ]) {
      words.set([...point.map(bits), 0], offset);
      offset += 4;
    }
    words.set([bits(row.range[0]), bits(row.range[1]), 1, 0], offset);
  });
  return new Uint8Array(words.buffer);
}

export function closedBoundaryKernel(source = SDF_SURFACE_INTERSECTION_WGSL) {
  return `${source}
struct ClosedCase{a:vec4u,b:vec4u,c:vec4u,oLo:vec4u,oHi:vec4u,dLo:vec4u,dHi:vec4u,range:vec4u}
@group(0)@binding(0)var<storage,read> inputs:array<ClosedCase>;
@group(0)@binding(1)var<storage,read_write> outputs:array<vec4u>;
@compute @workgroup_size(1)fn closedBoundary(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=arrayLength(&inputs)){return;}let x=inputs[id.x];let ray=SdfSurfaceRay(x.oLo.xyz,x.oHi.xyz,x.dLo.xyz,x.dHi.xyz,x.range.xy,x.range.z);
 let result=sdfSurfaceTriangle(ray,x.a.xyz,x.b.xyz,x.c.xyz);outputs[id.x]=vec4u(result.state,bitcast<u32>(result.tLower),bitcast<u32>(result.tUpper),result.frontFace);
}`;
}

function boundaryFailures(row: ClosedCase, raw: Uint32Array) {
  const [state, lo = 0, hi = 0, facing] = raw,
    failures: string[] = [];
  if (row.required === 'hit' && state !== 1) failures.push('required closed boundary hit absent');
  if (row.required === 'unknown' && state !== 2)
    failures.push('ambiguous interval or singular input certified');
  const samples = vectorCorners(row.origin, row.originHi ?? row.origin).flatMap((o) =>
    vectorCorners(row.direction, row.directionHi ?? row.direction).map((d) =>
      planeSample(row, o, d),
    ),
  );
  if (state === 1) {
    if (samples.some((s) => !s?.hit) || new Set(samples.map((s) => s?.frontFace)).size !== 1)
      failures.push('false universal primitive hit');
    else
      for (const s of samples) {
        if (!s) continue;
        if (facing !== s.frontFace) failures.push('certified facing changed');
        if (
          exactEndpointDyadic(lo) * s.d > s.n * scale ||
          exactEndpointDyadic(hi) * s.d < s.n * scale
        )
          failures.push('reported interval excludes exact plane time');
      }
  }
  if (state === 0 && samples.some((s) => s?.hit))
    failures.push('clear prunes an actual corner hit');
  if (state !== 0 && state !== 1 && state !== 2) failures.push('unknown result state');
  return [...new Set(failures)];
}
export function assessClosedBoundary(raw: Uint32Array, cases = closedBoundaryCases()) {
  if (raw.length !== cases.length * 4) throw new Error('Complete closed-boundary witness required');
  const rows = cases.map((row, i) => ({
    name: row.name,
    required: row.required,
    actual: Array.from(raw.slice(i * 4, i * 4 + 4)),
    failures: boundaryFailures(row, raw.slice(i * 4, i * 4 + 4)),
  }));
  return {
    rows,
    failures: rows.flatMap((row) => row.failures.map((failure) => `${row.name}: ${failure}`)),
  };
}

export function closedBoundaryVariants() {
  const source = closedBoundaryKernel();
  return [
    { name: 'production', negative: false, source },
    {
      name: 'wrong-lower-extrema',
      negative: true,
      source: source.replace(
        'u.lo>=0 && v.lo>=0 && sum.hi<=det.lo',
        'u.hi>=0 && v.hi>=0 && sum.lo<=det.hi',
      ),
    },
    {
      name: 'wrong-det-upper',
      negative: true,
      source: source.replace('sum.hi<=det.lo', 'sum.hi<=det.hi'),
    },
    {
      name: 'wrong-time-overlap',
      negative: true,
      source: source.replace(
        'time.lo>=range.lo && time.hi<=range.hi',
        'time.hi>=range.lo && time.lo<=range.hi',
      ),
    },
    {
      name: 'epsilon-exterior',
      negative: true,
      source: source
        .replace(
          'u.hi<0 || v.hi<0 || sum.lo>det.hi',
          'u.hi<(-0.000001*det.hi) || v.hi<(-0.000001*det.hi) || sum.lo>det.hi+0.000001*det.hi',
        )
        .replace(
          'u.lo>=0 && v.lo>=0 && sum.hi<=det.lo',
          'u.lo>=(-0.000001*det.hi) && v.lo>=(-0.000001*det.hi) && sum.hi<=det.lo+0.000001*det.hi',
        ),
    },
    {
      name: 'facing-flipped',
      negative: true,
      source: source.replace(
        'let frontFace=select(0u,1u,det.lo>0);',
        'let frontFace=select(1u,0u,det.lo>0);',
      ),
    },
  ];
}
