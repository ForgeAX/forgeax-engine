import { CANONICAL_RECEIVER_RECONSTRUCTION_WGSL } from '../canonical-receiver-reconstruction-wgsl';
import { exactEndpointDyadic } from './sdf-surface-exact-endpoints.fixture';

type V3 = readonly [number, number, number];
export interface ReceiverCase {
  readonly name: string;
  readonly vertices: readonly [V3, V3, V3];
  readonly forward: readonly number[];
  readonly viewProjection: readonly number[];
  readonly pixel: readonly [number, number];
  readonly extent: readonly [number, number];
  readonly sampleOffset: readonly [number, number];
}
export const receiverIdentity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
export const receiverCases: readonly ReceiverCase[] = [
  {
    name: 'orthographic-center',
    vertices: [
      [-1, -1, 0.5],
      [1, -1, 0.5],
      [0, 1, 0.5],
    ],
    forward: receiverIdentity,
    viewProjection: receiverIdentity,
    pixel: [0, 0],
    extent: [1, 1],
    sampleOffset: [0.5, 0.5],
  },
  {
    name: 'nonuniform-mirror',
    vertices: [
      [-1, -1, 0.25],
      [1, -1, 0.25],
      [0, 1, 0.25],
    ],
    forward: [-2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 2, 0, 0.25, -0.125, 0, 1],
    viewProjection: receiverIdentity,
    pixel: [0, 0],
    extent: [1, 1],
    sampleOffset: [0.5, 0.5],
  },
  {
    name: 'perspective',
    vertices: [
      [-2, -2, 2],
      [2, -2, 2],
      [0, 2, 2],
    ],
    forward: receiverIdentity,
    viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 1, 0, 0, 0, 0],
    pixel: [0, 0],
    extent: [1, 1],
    sampleOffset: [0.5, 0.5],
  },
  {
    name: 'actual-jittered-forward',
    vertices: [
      [-2, -2, 2],
      [2, -2, 2],
      [0, 2, 2],
    ],
    forward: receiverIdentity,
    viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0.125, -0.0625, 0.5, 1, 0, 0, 0, 0],
    pixel: [0, 0],
    extent: [1, 1],
    sampleOffset: [0.5, 0.5],
  },
  {
    name: 'non-square-rational-pixel',
    vertices: [
      [-2, -2, 0.5],
      [2, -2, 0.5],
      [0, 2, 0.5],
    ],
    forward: receiverIdentity,
    viewProjection: receiverIdentity,
    pixel: [3, 1],
    extent: [5, 3],
    sampleOffset: [0.5, 0.5],
  },
];

/** Actual 1600x900 Sponza receivers. Input publications: View
 * 7130268eb8b2bf6e1829ee53f5a08aad685d3517fc935d5c67bb133c584b8d3f;
 * receiver source a43284c86a87f757328e706e13f2344e104356e3627d9e5b8cf1f5c92af38b08.
 * These geometry/forward/camera/pixel facts are independent of the DUT output. */
export const capturedReceiverCases: readonly ReceiverCase[] = [
  {
    name: 'captured-probe-19929',
    vertices: [
      [-323.2189025878906, 18.581199645996094, 192.6260986328125],
      [-319.5719909667969, 0.5871999859809875, 193.9694061279297],
      [-323.4840087890625, 0.7515000104904175, 194.2281036376953],
    ],
    forward: [
      0.00800000037997961, 0, 0, 0, 0, 0.00800000037997961, 0, 0, 0, 0, 0.00800000037997961, 0, 0,
      0, 0, 1,
    ],
    viewProjection: [
      -1.743470434689698e-8, -0.23936989903450012, -0.0004128144064452499, 0.9903417229652405,
      -2.4408584042845405e-9, 1.7097851037979126, -5.7794015447143465e-5, 0.13864783942699432,
      0.9711335301399231, -4.339304027212165e-9, -7.483511206551885e-12, 1.7952942243937287e-8,
      -1.3557226452576288e-7, -4.650615692138672, 0.04681079834699631, 7.700897216796875,
    ],
    pixel: [1033, 796],
    extent: [1600, 900],
    sampleOffset: [0.5, 0.5],
  },
  {
    name: 'captured-probe-19930',
    vertices: [
      [-364.38519287109375, 21.151399612426758, 188.3363037109375],
      [-360.5841979980469, 3.2318999767303467, 185.75100708007812],
      [-364.072509765625, 3.2518999576568604, 188.5424041748047],
    ],
    forward: [
      0.00800000037997961, 0, 0, 0, 0, 0.00800000037997961, 0, 0, 0, 0, 0.00800000037997961, 0, 0,
      0, 0, 1,
    ],
    viewProjection: [
      -1.743470434689698e-8, -0.23936989903450012, -0.0004128144064452499, 0.9903417229652405,
      -2.4408584042845405e-9, 1.7097851037979126, -5.7794015447143465e-5, 0.13864783942699432,
      0.9711335301399231, -4.339304027212165e-9, -7.483511206551885e-12, 1.7952942243937287e-8,
      -1.3557226452576288e-7, -4.650615692138672, 0.04681079834699631, 7.700897216796875,
    ],
    pixel: [1041, 796],
    extent: [1600, 900],
    sampleOffset: [0.5, 0.5],
  },
];

/** Ideal-model overflow stress. The actual WGSL exponent-sum domain rejects
 * this input before reconstruction; this is not a GPU-admitted receiver. */
export const receiverWideEdgeCase: ReceiverCase = {
  name: 'finite-world-edge-overflow',
  vertices: [
    [-2e38, -2e38, 0.5],
    [2e38, -2e38, 0.5],
    [0, 2e38, 0.5],
  ],
  forward: receiverIdentity,
  viewProjection: [2 ** -126, 0, 0, 0, 0, 2 ** -126, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  pixel: [0, 0],
  extent: [1, 1],
  sampleOffset: [0.5, 0.5],
};

export interface Fraction {
  readonly n: bigint;
  readonly d: bigint;
}
function q(n: bigint, d = 1n): Fraction {
  if (d === 0n) throw Error('Undefined exact fraction');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b !== 0n) {
    const r = a % b;
    a = b;
    b = r;
  }
  return { n: n / a, d: d / a };
}
const add = (a: Fraction, b: Fraction) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const neg = (a: Fraction) => q(-a.n, a.d);
const sub = (a: Fraction, b: Fraction) => add(a, neg(b));
const mul = (a: Fraction, b: Fraction) => q(a.n * b.n, a.d * b.d);
const div = (a: Fraction, b: Fraction) => q(a.n * b.d, a.d * b.n);
const cmp = (a: Fraction, b: Fraction) => a.n * b.d - b.n * a.d;
const bits = (value: number) => new Uint32Array(Float32Array.of(value).buffer)[0] ?? 0;
const number = (word: number) => new Float32Array(Uint32Array.of(word).buffer)[0] ?? NaN;
const real = (value: number) => q(exactEndpointDyadic(bits(value)), 1n << 149n);
const sum = (values: readonly Fraction[]) => values.reduce(add, q(0n));
const at = <T>(values: readonly T[], i: number): T => {
  const value = values[i];
  if (value === undefined) throw Error('Complete explicit input required');
  return value;
};
const cross = (a: readonly Fraction[], b: readonly Fraction[]) => [
  sub(mul(at(a, 1), at(b, 2)), mul(at(a, 2), at(b, 1))),
  sub(mul(at(a, 2), at(b, 0)), mul(at(a, 0), at(b, 2))),
  sub(mul(at(a, 0), at(b, 1)), mul(at(a, 1), at(b, 0))),
];
const dot = (a: readonly Fraction[], b: readonly Fraction[]) =>
  sum(a.map((x, i) => mul(x, at(b, i))));

function solve3(rows: Fraction[][]): Fraction[] {
  for (let column = 0; column < 3; column++) {
    const pivot = rows.findIndex((row, i) => i >= column && at(row, column).n !== 0n);
    if (pivot < 0) throw Error('No unique canonical primary receiver');
    [rows[column], rows[pivot]] = [at(rows, pivot), at(rows, column)];
    const original = at(rows, column),
      scale = at(original, column);
    rows[column] = original.map((value) => div(value, scale));
    for (let r = 0; r < 3; r++)
      if (r !== column) {
        const row = at(rows, r),
          factor = at(row, column);
        rows[r] = row.map((value, c) => sub(value, mul(factor, at(at(rows, column), c))));
      }
  }
  return rows.map((row) => at(row, 3));
}

/** Exact affine transform of the independently authored triangle. */
function exactWorldVertices(input: ReceiverCase) {
  return input.vertices.map((vertex) =>
    [0, 1, 2].map((axis) =>
      sum([
        ...vertex.map((v, c) => mul(real(v), real(at(input.forward, c * 4 + axis)))),
        real(at(input.forward, 12 + axis)),
      ]),
    ),
  );
}

/** Independent exact affine triangle extents; no barycentric/DUT arithmetic. */
export function receiverTriangleSpans(input: ReceiverCase): readonly number[] {
  const world = exactWorldVertices(input);
  return [0, 1, 2].map((axis) => {
    const values = world.map((vertex) => at(vertex, axis));
    const lo = values.reduce((a, b) => (cmp(a, b) < 0n ? a : b));
    const hi = values.reduce((a, b) => (cmp(a, b) > 0n ? a : b));
    const span = sub(hi, lo);
    return Number(span.n) / Number(span.d);
  });
}

/** Independent exact 3x3 world-plane solve. The DUT uses a 2x2 barycentric
 * solve, so its determinant and numerator expressions are not mirrored here. */
export function exactReceiverPoint(input: ReceiverCase) {
  const world = exactWorldVertices(input);
  const p0 = at(world, 0),
    ab = at(world, 1).map((v, i) => sub(v, at(p0, i))),
    ac = at(world, 2).map((v, i) => sub(v, at(p0, i))),
    normal = cross(ab, ac);
  const ndc = [0, 1].map((axis) => {
    const coordinate = div(
      add(q(BigInt(at(input.pixel, axis))), real(at(input.sampleOffset, axis))),
      q(BigInt(at(input.extent, axis))),
    );
    return axis === 0 ? sub(mul(q(2n), coordinate), q(1n)) : sub(q(1n), mul(q(2n), coordinate));
  });
  const rows = [0, 1].map((axis) =>
    Array.from({ length: 4 }, (_, c) =>
      sub(
        real(at(input.viewProjection, c * 4 + axis)),
        mul(at(ndc, axis), real(at(input.viewProjection, c * 4 + 3))),
      ),
    ),
  );
  for (const row of rows) row[3] = neg(at(row, 3));
  rows.push([...normal, dot(normal, p0)]);
  return solve3(rows);
}

interface Interval {
  lo: number;
  hi: number;
  valid: number;
}
const invalid = (): Interval => ({ lo: 0, hi: 0, valid: 0 });
function round(value: Fraction, up: boolean) {
  let f = Math.fround(Number(value.n) / Number(value.d));
  if (!Number.isFinite(f)) return f;
  for (let i = 0; i < 4 && (up ? cmp(real(f), value) < 0n : cmp(real(f), value) > 0n); i++) {
    const word = bits(f),
      delta = f < 0 !== up ? 1 : -1;
    f = number(f === 0 ? (up ? 1 : 0x80000001) : (word + delta) >>> 0);
  }
  return f;
}
function interval(values: Fraction[]): Interval {
  const low = values.reduce((a, b) => (cmp(a, b) < 0n ? a : b)),
    high = values.reduce((a, b) => (cmp(a, b) > 0n ? a : b));
  const lo = round(low, false),
    hi = round(high, true);
  return Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi, valid: 1 } : invalid();
}
function operate(
  a: Interval,
  b: Interval,
  op: 'add' | 'subtract' | 'multiply' | 'divide',
): Interval {
  if (!a.valid || !b.valid || (op === 'divide' && b.lo <= 0 && b.hi >= 0)) return invalid();
  if (op === 'add') return interval([add(real(a.lo), real(b.lo)), add(real(a.hi), real(b.hi))]);
  if (op === 'subtract')
    return interval([sub(real(a.lo), real(b.hi)), sub(real(a.hi), real(b.lo))]);
  return interval(
    [a.lo, a.hi].flatMap((x) =>
      [b.lo, b.hi].map((y) => (op === 'multiply' ? mul : div)(real(x), real(y))),
    ),
  );
}

function vector(...values: number[]) {
  const result = values as number[] & { x: number; y: number; z: number; w: number };
  for (const [i, key] of ['x', 'y', 'z', 'w'].entries())
    Object.defineProperty(result, key, { get: () => result[i] ?? 0 });
  return result;
}
function body(source: string, name: string) {
  const at = source.indexOf(`fn ${name}(`),
    open = source.indexOf('{', at);
  if (at < 0 || open < 0) throw Error('Actual producer function required');
  let depth = 1,
    end = open + 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw Error('Closed actual producer body required');
  return source.slice(open + 1, end - 1).replace(/\/\/[^\n]*/g, '');
}
function lower(source: string) {
  return source
    .replace(/var (\w+):CanonicalReceiverResult;/g, 'let $1=makeResult();')
    .replace(/var (\w+):CanonicalReceiverHomogeneous;/g, 'let $1=makeHomogeneous();')
    .replace(
      /var (\w+):array<CanonicalReceiverHomogeneous,3>;/g,
      'let $1=[makeHomogeneous(),makeHomogeneous(),makeHomogeneous()];',
    )
    .replace(/var (\w+):array<SdfRealInterval,2>;/g, 'let $1=[invalid(),invalid()];')
    .replace(/array<SdfRealInterval,3>\(/g, 'intervalWeights(')
    .replace(/var (\w+):SdfIntervalVector;/g, 'let $1={axis:[invalid(),invalid(),invalid()]};')
    .replace(/bitcast<u32>\(/g, 'bits(')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1');
}

/** Executes actual producer control/composition with an independent exact-real
 * outward f32 interval model. It does not model the scalar WGSL authority
 * exponent-domain availability guards, permitted accuracy or backend FTZ.
 * GPU numerical and availability-domain qualification stays separate. */
export function executeReceiver(
  input: ReceiverCase,
  source = CANONICAL_RECEIVER_RECONSTRUCTION_WGSL,
  injection: Record<string, unknown> = {},
) {
  const deps: Record<string, unknown> = {
    bits,
    invalid,
    f32: (v: number) => v,
    vec2u: vector,
    vec3u: vector,
    makeResult: () => ({
      state: 0,
      reason: 0,
      rasterQualified: 0,
      point: { axis: [invalid(), invalid(), invalid()] },
      barycentric: [invalid(), invalid()],
    }),
    makeHomogeneous: () => ({ axis: [invalid(), invalid(), invalid(), invalid()] }),
    intervalWeights: (...values: Interval[]) => values,
    sdfSurfaceBitsUsable: (word: number) => {
      const m = word & 0x7fffffff;
      return m === 0 || (m >= 0x00800000 && m <= 0x7f7fffff);
    },
    sdfIntervalZero: () => ({ lo: 0, hi: 0, valid: 1 }),
    sdfIntervalPoint: (word: number) => ({ lo: number(word), hi: number(word), valid: 1 }),
    sdfIntervalAdd: (a: Interval, b: Interval) => operate(a, b, 'add'),
    sdfIntervalSubtract: (a: Interval, b: Interval) => operate(a, b, 'subtract'),
    sdfIntervalMultiply: (a: Interval, b: Interval) => operate(a, b, 'multiply'),
    sdfIntervalDivide: (a: Interval, b: Interval) => operate(a, b, 'divide'),
    ...injection,
  };
  for (const [name, args] of [
    ['canonicalReceiverUnavailable', 'reason'],
    ['canonicalReceiverRawMatrixValid', 'matrix,affine'],
    ['canonicalReceiverInputValid', 'input'],
    ['canonicalReceiverTransform', 'matrix,point'],
    ['canonicalReceiverPlane', 'clip,coordinate,axis'],
    ['canonicalReceiverReconstruct', 'input'],
  ]) {
    if (!source.includes(`fn ${name}(`)) continue;
    const code = lower(body(source, name ?? ''));
    const names = Object.keys(deps);
    deps[name ?? ''] = new Function(...names, `return function(${args}){${code}};`)(
      ...names.map((key) => deps[key]),
    );
  }
  const v = (values: readonly number[]) => vector(...values.map(bits));
  const matrix = (values: readonly number[]) =>
    Array.from({ length: 4 }, (_, i) => v(values.slice(i * 4, i * 4 + 4)));
  return (deps.canonicalReceiverReconstruct as (i: unknown) => ReceiverResult)({
    vertices: input.vertices.map(v),
    forward: matrix(input.forward),
    viewProjection: matrix(input.viewProjection),
    pixel: vector(...input.pixel),
    extent: vector(...input.extent),
    sampleOffset: v(input.sampleOffset),
  });
}
export interface ReceiverResult {
  readonly state: number;
  readonly reason: number;
  readonly rasterQualified: number;
  readonly point: { readonly axis: readonly Interval[] };
  readonly barycentric: readonly Interval[];
}
export function receiverContains(point: readonly Interval[], expected: readonly Fraction[]) {
  return expected.every((value, i) => {
    const p = at(point, i);
    return p.valid === 1 && cmp(real(p.lo), value) <= 0n && cmp(real(p.hi), value) >= 0n;
  });
}

export function receiverControlKernel(module = CANONICAL_RECEIVER_RECONSTRUCTION_WGSL) {
  return (
    module +
    `
@group(0) @binding(0) var<storage,read> inputs:array<CanonicalReceiverInput>;
@group(0) @binding(1) var<storage,read_write> outputs:array<CanonicalReceiverResult>;
@compute @workgroup_size(1) fn reconstructReceiver(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&inputs) || id.x>=arrayLength(&outputs)){return;}
 outputs[id.x]=canonicalReceiverReconstruct(inputs[id.x]);
}`
  );
}
