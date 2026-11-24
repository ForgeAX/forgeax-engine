import { SDF_SURFACE_INTERSECTION_WGSL } from '@forgeax/engine-shader';

type V3 = readonly [number, number, number];
interface SurfaceCase {
  readonly name: string;
  readonly triangle: readonly [V3, V3, V3];
  readonly origin: V3;
  readonly direction: V3;
  readonly range: readonly [number, number];
  readonly expected: 'hit' | 'clear' | 'uncertain' | 'oracle';
  readonly originHi?: V3;
  readonly invalidBits?: number;
  readonly invalidAxis?: number;
  readonly valid?: number;
}
const triangle: readonly [V3, V3, V3] = [
  [-1, -1, 0],
  [1, -1, 0],
  [0, 1, 0],
];
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (value: number) => {
  f32[0] = value;
  return u32[0] ?? 0;
};
const fromBits = (value: number) => {
  u32[0] = value;
  return f32[0] ?? 0;
};
const scale = 1n << 149n;
export function surfaceDyadic(raw: number): bigint {
  const exponent = (raw >>> 23) & 255;
  if (exponent === 255) throw new Error('Nonfinite oracle input');
  const mantissa = BigInt(raw & 0x7fffff);
  const magnitude = exponent === 0 ? mantissa : (0x800000n | mantissa) << BigInt(exponent - 1);
  return raw >>> 31 === 0 ? magnitude : -magnitude;
}
const q = (value: number) => surfaceDyadic(bits(value));
const sub = (a: readonly bigint[], b: readonly bigint[]) => a.map((v, i) => v - (b[i] ?? 0n));
const cross = (a: readonly bigint[], b: readonly bigint[]) => [
  (a[1] ?? 0n) * (b[2] ?? 0n) - (a[2] ?? 0n) * (b[1] ?? 0n),
  (a[2] ?? 0n) * (b[0] ?? 0n) - (a[0] ?? 0n) * (b[2] ?? 0n),
  (a[0] ?? 0n) * (b[1] ?? 0n) - (a[1] ?? 0n) * (b[0] ?? 0n),
];
const dot = (a: readonly bigint[], b: readonly bigint[]) =>
  a.reduce((v, x, i) => v + x * (b[i] ?? 0n), 0n);
type Fraction = readonly [bigint, bigint];
const fraction = (n: bigint, d: bigint): Fraction => (d < 0n ? [-n, -d] : [n, d]);
const fractionLess = (a: Fraction, b: Fraction) => a[0] * b[1] < b[0] * a[1];
function exactSurfaceSlab(row: SurfaceCase) {
  let near: Fraction = [q(row.range[0]), scale],
    far: Fraction = [q(row.range[1]), scale];
  for (let axis = 0; axis < 3; axis++) {
    const origin = q(row.origin[axis] ?? 0),
      direction = q(row.direction[axis] ?? 0);
    const values = row.triangle.map((p) => q(p[axis] ?? 0));
    const lo = values.reduce((a, b) => (a < b ? a : b)),
      hi = values.reduce((a, b) => (a > b ? a : b));
    if (direction === 0n) {
      if (origin < lo || origin > hi) return null;
      continue;
    }
    const a = fraction(lo - origin, direction),
      b = fraction(hi - origin, direction);
    const lower = fractionLess(a, b) ? a : b,
      upper = fractionLess(a, b) ? b : a;
    if (fractionLess(near, lower)) near = lower;
    if (fractionLess(upper, far)) far = upper;
    if (fractionLess(far, near)) return null;
  }
  return { near, far };
}
function checkSurfaceSlab(row: SurfaceCase, actual: Uint32Array) {
  const failures: string[] = [];
  if (actual[5] !== 1) return failures;
  const exact = exactSurfaceSlab(row);
  if (actual[4] === 0) {
    if (exact !== null) failures.push(`${row.name}: slab pruned an exact overlap`);
  } else if (exact !== null) {
    if (fractionLess(exact.near, [surfaceDyadic(actual[6] ?? 0), scale]))
      failures.push(`${row.name}: near lower bound is too high`);
    if (fractionLess([surfaceDyadic(actual[7] ?? 0), scale], exact.far))
      failures.push(`${row.name}: far upper bound is too low`);
  }
  return failures;
}
export function exactSurface(caseValue: SurfaceCase) {
  const [a, b, c] = caseValue.triangle.map((p) => p.map(q));
  if (a === undefined || b === undefined || c === undefined)
    throw new Error('Three vertices required');
  const e1 = sub(b, a),
    e2 = sub(c, a),
    d = caseValue.direction.map(q);
  const p = cross(d, e2),
    signedDet = dot(e1, p);
  if (signedDet === 0n) return { kind: 'parallel' as const };
  const s = sub(caseValue.origin.map(q), a),
    vq = cross(s, e1);
  const sign = signedDet > 0n ? 1n : -1n;
  const det = signedDet * sign,
    u = dot(s, p) * sign,
    v = dot(d, vq) * sign,
    time = dot(e2, vq) * sign;
  const hit =
    u >= 0n &&
    v >= 0n &&
    u + v <= det &&
    time * scale >= q(caseValue.range[0]) * det &&
    time * scale <= q(caseValue.range[1]) * det;
  return {
    kind: hit ? ('hit' as const) : ('clear' as const),
    det,
    u,
    v,
    time,
    frontFace: signedDet > 0n ? 1 : 0,
  };
}

export function surfaceCases(): readonly SurfaceCase[] {
  const base = {
    triangle,
    origin: [0, 0, 2] as V3,
    direction: [0, 0, -1] as V3,
    range: [0, 16] as const,
  };
  const rows: SurfaceCase[] = [];
  for (const magnitude of [1 / 65536, 1, 65536])
    for (const speed of [0.5, 1, 2])
      for (const reverse of [false, true]) {
        const translate = magnitude * 16;
        const points = triangle.map(
          (p) => p.map((v, i) => v * magnitude + (i === 0 ? translate : 0)) as unknown as V3,
        ) as unknown as [V3, V3, V3];
        if (reverse) [points[1], points[2]] = [points[2], points[1]];
        rows.push({
          ...base,
          name: `scale-${magnitude}-speed-${speed}-reverse-${reverse}`,
          triangle: points,
          origin: [translate, 0, 2 * magnitude],
          direction: [0, 0, -speed * magnitude],
          expected: 'hit',
        });
      }
  for (const side of [-1, 1])
    for (const delta of [0, 2 ** -24, 2 ** -18, 2 ** -12, 0.01]) {
      rows.push({
        ...base,
        name: `edge-${side}-${delta}`,
        origin: [0.5 + side * delta, 0, 2],
        expected: 'oracle',
      });
    }
  rows.push(
    { ...base, name: 'outside-aabb', origin: [3, 0, 2], expected: 'clear' },
    { ...base, name: 'aabb-overlap-triangle-miss', origin: [0.9, 0.9, 2], expected: 'clear' },
    { ...base, name: 'ray-range-before-hit', range: [0, 1], expected: 'clear' },
    { ...base, name: 'ray-range-after-hit', range: [3, 8], expected: 'clear' },
    // Exact arithmetic certifies this inclusive time endpoint in the strict triangle interior.
    { ...base, name: 'closed-t-boundary', range: [2, 2], expected: 'hit' },
    { ...base, name: 'parallel-outside', direction: [1, 0, 0], expected: 'uncertain' },
    {
      ...base,
      name: 'parallel-coplanar',
      origin: [0, 0, 0],
      direction: [1, 0, 0],
      expected: 'uncertain',
    },
    { ...base, name: 'zero-direction', direction: [0, 0, 0], expected: 'uncertain' },
    {
      ...base,
      name: 'interval-crosses-edge',
      origin: [0.4, 0, 2],
      originHi: [0.6, 0, 2],
      expected: 'uncertain',
    },
    { ...base, name: 'disabled-ray', valid: 0, expected: 'uncertain' },
    { ...base, name: 'invalid-range', range: [4, 1], expected: 'uncertain' },
    { ...base, name: 'subnormal-input', invalidBits: 1, expected: 'uncertain' },
    { ...base, name: 'positive-infinity', invalidBits: 0x7f800000, expected: 'uncertain' },
    { ...base, name: 'negative-infinity', invalidBits: 0xff800000, expected: 'uncertain' },
    { ...base, name: 'nan-input', invalidBits: 0x7fc00001, expected: 'uncertain' },
    {
      ...base,
      name: 'invalid-late-axis-before-slab-prune',
      origin: [3, 0, 2],
      invalidBits: 0x7f800000,
      invalidAxis: 2,
      expected: 'uncertain',
    },
    {
      ...base,
      name: 'overflow-product',
      triangle: [
        [-(2 ** 100), -(2 ** 100), 0],
        [2 ** 100, -(2 ** 100), 0],
        [0, 2 ** 100, 0],
      ],
      expected: 'uncertain',
    },
  );
  return rows;
}

export const surfaceKernel = `${SDF_SURFACE_INTERSECTION_WGSL}
struct SurfaceCase { a:vec4u,b:vec4u,c:vec4u,originLo:vec4u,originHi:vec4u,directionLo:vec4u,directionHi:vec4u,range:vec4u,boxLo:vec4u,boxHi:vec4u }
struct SurfaceOutput { triangle:vec4u,slab:vec4u }
@group(0) @binding(0) var<storage,read> inputs:array<SurfaceCase>;
@group(0) @binding(1) var<storage,read_write> outputs:array<SurfaceOutput>;
@compute @workgroup_size(1) fn surfaceTest(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&inputs)){return;}
 let row=inputs[id.x];let ray=SdfSurfaceRay(row.originLo.xyz,row.originHi.xyz,row.directionLo.xyz,row.directionHi.xyz,row.range.xy,row.range.z);
 let t=sdfSurfaceTriangle(ray,row.a.xyz,row.b.xyz,row.c.xyz);
 let b=sdfSurfaceSlab(ray,row.boxLo.xyz,row.boxHi.xyz);
 outputs[id.x]=SurfaceOutput(vec4u(t.state,bitcast<u32>(t.tLower),bitcast<u32>(t.tUpper),t.frontFace),vec4u(b.possible,b.certified,bitcast<u32>(b.near),bitcast<u32>(b.far)));
}`;

export function surfaceInputBytes(cases: readonly SurfaceCase[]): Uint8Array<ArrayBuffer> {
  const words = new Uint32Array(cases.length * 40);
  cases.forEach((row, i) => {
    const at = i * 40;
    for (let j = 0; j < 3; j++) words.set(row.triangle[j]?.map(bits) ?? [], at + j * 4);
    words.set(row.origin.map(bits), at + 12);
    words.set((row.originHi ?? row.origin).map(bits), at + 16);
    if (row.invalidBits !== undefined) {
      words[at + 12 + (row.invalidAxis ?? 0)] = row.invalidBits;
      words[at + 16 + (row.invalidAxis ?? 0)] = row.invalidBits;
    }
    words.set(row.direction.map(bits), at + 20);
    words.set(row.direction.map(bits), at + 24);
    words.set([bits(row.range[0]), bits(row.range[1]), row.valid ?? 1, 0], at + 28);
    for (let k = 0; k < 3; k++) {
      words[at + 32 + k] = bits(Math.min(...row.triangle.map((p) => p[k] ?? 0)));
      words[at + 36 + k] = bits(Math.max(...row.triangle.map((p) => p[k] ?? 0)));
    }
  });
  return new Uint8Array(words.buffer);
}

export async function runSurfaceBufferWork(
  device: GPUDevice,
  code: string,
  bytes: Uint8Array<ArrayBuffer>,
  entryPoint: string,
  count: number,
  recordBytes: number,
) {
  const input = device.createBuffer({ size: bytes.byteLength, usage: 128 | 8 });
  const output = device.createBuffer({ size: count * recordBytes, usage: 128 | 4 });
  const staging = device.createBuffer({ size: output.size, usage: 1 | 8 });
  try {
    device.queue.writeBuffer(input, 0, bytes);
    const module = device.createShaderModule({ code });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(count);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    const result = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return result;
  } finally {
    input.destroy();
    output.destroy();
    staging.destroy();
  }
}

export function runSurfaceIntervalFixture(device: GPUDevice, code: string, cases = surfaceCases()) {
  return runSurfaceBufferWork(
    device,
    code,
    surfaceInputBytes(cases),
    'surfaceTest',
    cases.length,
    32,
  );
}
export function runIntervalArithmeticFixture(device: GPUDevice, code: string) {
  return runSurfaceBufferWork(
    device,
    code,
    intervalArithmeticBytes(),
    'surfaceArithmetic',
    intervalArithmeticCases.length,
    16,
  );
}

function checkSurfaceHit(
  row: SurfaceCase,
  actual: Uint32Array,
  exact: ReturnType<typeof exactSurface>,
) {
  if (exact.kind !== 'hit') return [`${row.name}: false primitive hit`];
  const failures: string[] = [];
  const lo = surfaceDyadic(actual[1] ?? 0),
    hi = surfaceDyadic(actual[2] ?? 0);
  if (lo * exact.det > exact.time * scale || hi * exact.det < exact.time * scale)
    failures.push(`${row.name}: true t outside reported interval`);
  if (actual[3] !== exact.frontFace) failures.push(`${row.name}: winding mismatch`);
  return failures;
}
export function assessSurfaceIntervals(cases: readonly SurfaceCase[], actual: Uint32Array) {
  if (actual.length !== cases.length * 8) throw new Error('Complete actual records required');
  const failures: string[] = [];
  let hits = 0,
    clear = 0,
    uncertain = 0;
  cases.forEach((row, i) => {
    const state = actual[i * 8];
    if (state === 1) hits++;
    else if (state === 0) clear++;
    else if (state === 2) uncertain++;
    else failures.push(`${row.name}: invalid state`);
    if (row.expected !== 'oracle' && state !== { hit: 1, clear: 0, uncertain: 2 }[row.expected])
      failures.push(`${row.name}: expected ${row.expected}, actual ${state}`);
    if (row.invalidBits !== undefined || row.valid === 0 || row.range[0] > row.range[1]) {
      if (actual[i * 8 + 5] !== 0) failures.push(`${row.name}: invalid input certified by slab`);
      return;
    }
    const exact = exactSurface(row);
    if (row.originHi !== undefined) return;
    failures.push(...checkSurfaceSlab(row, actual.subarray(i * 8, i * 8 + 8)));
    if (state === 0 && exact.kind === 'hit') failures.push(`${row.name}: false clear`);
    if (state === 1)
      failures.push(...checkSurfaceHit(row, actual.subarray(i * 8, i * 8 + 8), exact));
    if (actual[i * 8 + 4] === 0 && exact.kind === 'hit')
      failures.push(`${row.name}: slab pruned a true hit`);
  });
  return { hits, clear, uncertain, failures };
}

interface PermittedScalarCase {
  readonly name: string;
  readonly op: 4 | 5 | 6 | 7;
  readonly a: number;
  readonly b: number;
  readonly roundedBits: number;
  readonly valid: true;
}
function directedScalarCases(): PermittedScalarCase[] {
  const cases: PermittedScalarCase[] = [];
  const basic = [
    { name: 'add-lower', op: 5, a: 1, b: 2 ** -24, roundedBits: 0x3f800000 },
    { name: 'add-upper', op: 5, a: 1, b: 2 ** -24, roundedBits: 0x3f800001 },
    { name: 'subtract-lower', op: 6, a: 1, b: 2 ** -25, roundedBits: 0x3f7fffff },
    { name: 'subtract-upper', op: 6, a: 1, b: 2 ** -25, roundedBits: 0x3f800000 },
    { name: 'multiply-lower', op: 7, a: 1 + 2 ** -23, b: 1 - 2 ** -23, roundedBits: 0x3f7fffff },
    { name: 'multiply-upper', op: 7, a: 1 + 2 ** -23, b: 1 - 2 ** -23, roundedBits: 0x3f800000 },
    { name: 'multiply-ftz', op: 7, a: 2 ** -70, b: 2 ** -70, roundedBits: 0 },
  ] as const;
  for (const sign of [0, 0x80000000])
    for (const row of basic) {
      cases.push({
        ...row,
        name: `permitted-${sign ? 'negative' : 'positive'}-${row.name}`,
        a: sign ? -row.a : row.a,
        b: sign && row.op !== 7 ? -row.b : row.b,
        roundedBits: (row.roundedBits ^ sign) >>> 0,
        valid: true,
      });
    }
  return cases;
}
function directedDivisionCases(): PermittedScalarCase[] {
  const cases: PermittedScalarCase[] = [];
  const values = [
    ['below-binade-lower', 0x3f800000, 0x3f800001, 0x3f7ffffc],
    ['below-binade-upper', 0x3f800000, 0x3f800001, 0x3f800000],
    ['above-binade-lower', 0x3f800000, 0x3f7fffff, 0x3f7ffffd],
    ['above-binade-upper', 0x3f800000, 0x3f7fffff, 0x3f800003],
    ['exact-binade-lower', 0x3f800000, 0x3f800000, 0x3f7ffffe],
    ['exact-binade-upper', 0x3f800000, 0x3f800000, 0x3f800001],
    ['halo-eight', 0x0080000b, 0x3f800001, 0x00800008],
    ['halo-nine', 0x0080000c, 0x3f800001, 0x00800009],
  ] as const;
  for (const sign of [0, 0x80000000])
    for (const [name, a, b, result] of values) {
      cases.push({
        name: `permitted-${sign ? 'negative' : 'positive'}-${name}`,
        op: 4,
        a: fromBits((a ^ sign) >>> 0),
        b: fromBits(b),
        roundedBits: (result ^ sign) >>> 0,
        valid: true,
      });
    }
  return cases;
}
export const intervalArithmeticCases = [
  {
    name: 'permitted-division-rounding-at-min-normal',
    op: 4,
    a: fromBits(0x00800008),
    b: fromBits(0x3f7fffff),
    roundedBits: 0x00800008,
    valid: true,
  },
  { name: 'add-rounding-boundary', op: 0, a: 1, b: 2 ** -24, valid: true },
  { name: 'subtract-rounding-boundary', op: 1, a: 1, b: 2 ** -25, valid: true },
  { name: 'product-rounding', op: 2, a: 1 + 2 ** -23, b: 1 - 2 ** -23, valid: true },
  { name: 'one-third', op: 3, a: 1, b: 3, valid: true },
  { name: 'negative-seventh', op: 3, a: 1, b: -7, valid: true },
  { name: 'division-underflow', op: 3, a: 2 ** -120, b: 2 ** 120, valid: true },
  { name: 'minimum-normal-cancellation', op: 0, a: 2 ** -126, b: -(2 ** -126), valid: true },
  { name: 'large-safe-add', op: 0, a: 2 ** 126, b: 2 ** 126, valid: true },
  { name: 'unsafe-product', op: 2, a: 2 ** 126, b: 4, valid: false },
  { name: 'unsafe-add-before-evaluation', op: 0, a: 2 ** 127, b: 2 ** 127, valid: false },
  { name: 'division-outside-accuracy-domain', op: 3, a: 1, b: 2 ** 127, valid: false },
  { name: 'division-by-zero', op: 3, a: 1, b: 0, valid: false },
  ...directedScalarCases(),
  ...directedDivisionCases(),
] as const;
export const intervalArithmeticKernel = `${SDF_SURFACE_INTERSECTION_WGSL}
@group(0) @binding(0) var<storage,read> inputs:array<vec4u>;
@group(0) @binding(1) var<storage,read_write> outputs:array<vec4u>;
@compute @workgroup_size(1) fn surfaceArithmetic(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&inputs)){return;}
 let row=inputs[id.x];let a=sdfIntervalPoint(row.x);let b=sdfIntervalPoint(row.y);
 var result=sdfIntervalInvalid();
 switch(row.z){
  case 0u:{result=sdfIntervalAdd(a,b);}
  case 1u:{result=sdfIntervalSubtract(a,b);}
  case 2u:{result=sdfIntervalMultiply(a,b);}
  case 3u:{result=sdfIntervalDivide(a,b);}
  case 4u:{result=sdfIntervalOutward(bitcast<f32>(row.w),8u);}
  case 5u,6u,7u:{result=sdfIntervalOutward(bitcast<f32>(row.w),2u);}
  default:{}
 }
 outputs[id.x]=vec4u(result.valid,bitcast<u32>(result.lo),bitcast<u32>(result.hi),0u);
}`;
export function intervalArithmeticBytes() {
  return new Uint8Array(
    Uint32Array.from(
      intervalArithmeticCases.flatMap((r) => [
        bits(r.a),
        bits(r.b),
        r.op,
        'roundedBits' in r ? r.roundedBits : 0,
      ]),
    ).buffer,
  );
}
export function assessIntervalArithmetic(actual: Uint32Array) {
  const failures: string[] = [];
  if (actual.length !== intervalArithmeticCases.length * 4)
    throw new Error('Complete arithmetic records required');
  intervalArithmeticCases.forEach((r, i) => {
    const valid = actual[i * 4] === 1;
    if (valid !== r.valid) failures.push(`${r.name}: incorrect validity`);
    if (!valid) return;
    const { numerator, denominator } = exactScalarOperation(r);
    if ('roundedBits' in r) validatePermittedScalar(r);
    const lo = surfaceDyadic(actual[i * 4 + 1] ?? 0),
      hi = surfaceDyadic(actual[i * 4 + 2] ?? 0);
    if (lo * denominator > numerator * scale || hi * denominator < numerator * scale)
      failures.push(`${r.name}: exact rational outside GPU interval`);
  });
  return { cases: intervalArithmeticCases.length, failures };
}

function exactScalarOperation(row: { op: number; a: number; b: number }) {
  const a = q(row.a),
    b = q(row.b);
  let numerator: bigint, denominator: bigint;
  switch (row.op) {
    case 0:
    case 5:
      numerator = a + b;
      denominator = scale;
      break;
    case 1:
    case 6:
      numerator = a - b;
      denominator = scale;
      break;
    case 2:
    case 7:
      numerator = a * b;
      denominator = scale * scale;
      break;
    case 3:
    case 4:
      numerator = a;
      denominator = b;
      break;
    default:
      throw new Error('Unknown scalar operation');
  }
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  return { numerator, denominator };
}
function scalarUlpGrid(numerator: bigint, denominator: bigint) {
  const n = numerator < 0n ? -numerator : numerator;
  if (n === 0n) return 1n;
  let exponent = n.toString(2).length - denominator.toString(2).length;
  const below =
    exponent >= 0 ? n < denominator << BigInt(exponent) : n << BigInt(-exponent) < denominator;
  if (below) exponent--;
  const power =
    exponent >= 0 ? n === denominator << BigInt(exponent) : n << BigInt(-exponent) === denominator;
  return 1n << BigInt(Math.max(0, exponent + 126 - (power ? 1 : 0)));
}
function scalarAdjacent(bitsValue: number, up: boolean) {
  if ((bitsValue & 0x7fffffff) === 0) return up ? 1 : 0x80000001;
  return (
    ((bitsValue & 0x80000000) !== 0
      ? up
        ? bitsValue - 1
        : bitsValue + 1
      : up
        ? bitsValue + 1
        : bitsValue - 1) >>> 0
  );
}
export function validatePermittedScalar(row: PermittedScalarCase) {
  const { numerator, denominator } = exactScalarOperation(row),
    rounded = surfaceDyadic(row.roundedBits);
  const difference = rounded * denominator - numerator * scale;
  const magnitude = difference < 0n ? -difference : difference;
  if (row.op === 4) {
    if (2n * magnitude > 5n * scalarUlpGrid(numerator, denominator) * denominator)
      throw new Error(`Division rounding outside allowed accuracy: ${row.name}`);
    return;
  }
  if (difference === 0n) return;
  const unsigned = numerator < 0n ? -numerator : numerator;
  if (rounded === 0n && unsigned * scale < (1n << 23n) * denominator) return;
  const adjacent = surfaceDyadic(scalarAdjacent(row.roundedBits, difference < 0n));
  if (
    difference < 0n
      ? adjacent * denominator <= numerator * scale
      : adjacent * denominator >= numerator * scale
  )
    throw new Error(`Basic result is not correctly rounded: ${row.name}`);
}

export function validatePermittedDivisionWitness() {
  const row = intervalArithmeticCases[0];
  if (row.op !== 4) throw new Error('Required permitted-rounding witness missing');
  const numerator = q(row.a),
    denominator = q(row.b),
    rounded = surfaceDyadic(row.roundedBits);
  const delta = rounded * denominator - numerator * scale;
  const magnitude = delta < 0n ? -delta : delta;
  if (
    numerator * scale < (1n << 23n) * denominator ||
    numerator * scale >= (1n << 24n) * denominator
  )
    throw new Error('Witness quotient must remain in the minimum normal binade');
  if (2n * magnitude > 5n * denominator)
    throw new Error('Forced result must be within the permitted 2.5 ULP');
  return {
    normalBinade: true,
    permitted: true,
    errorInMinUlpNumerator: magnitude.toString(),
    errorInMinUlpDenominator: denominator.toString(),
    roundedBits: row.roundedBits,
  };
}

function replaceSurfaceOnce(source: string, before: string, after: string) {
  if (source.split(before).length !== 2)
    throw new Error('Exactly one source-owned negative-control anchor required');
  return source.replace(before, after);
}
export function surfaceShaderVariants() {
  return [
    { name: 'surface', kind: 'surface', negative: false, source: surfaceKernel },
    { name: 'arithmetic', kind: 'arithmetic', negative: false, source: intervalArithmeticKernel },
    {
      name: 'barycentric-ignored',
      kind: 'surface',
      negative: true,
      source: replaceSurfaceOnce(
        surfaceKernel,
        'if(u.hi<0 || v.hi<0 || sum.lo>det.hi){return SdfSurfaceIntersection(0u,0,0,frontFace);}',
        'if(u.hi<0 || v.hi<0 || sum.lo>det.hi){return SdfSurfaceIntersection(1u,0,0,frontFace);}',
      ),
    },
    {
      name: 'division-without-outward-bound',
      kind: 'arithmetic',
      negative: true,
      source: replaceSurfaceOnce(
        intervalArithmeticKernel,
        'sdfIntervalOutward(a/b,8u)',
        'sdfIntervalOutward(a/b,0u)',
      ),
    },
    {
      name: 'ray-validity-ignored',
      kind: 'surface',
      negative: true,
      source: surfaceKernel.replaceAll('ray.valid!=1u', 'false'),
    },
    {
      name: 'ray-parameter-halved',
      kind: 'surface',
      negative: true,
      source: replaceSurfaceOnce(
        surfaceKernel,
        'return SdfSurfaceIntersection(1u,lo,hi,frontFace);',
        'return SdfSurfaceIntersection(1u,lo*0.5f,hi*0.5f,frontFace);',
      ),
    },
    {
      name: 'front-face-flipped',
      kind: 'surface',
      negative: true,
      source: replaceSurfaceOnce(
        surfaceKernel,
        'let frontFace=select(0u,1u,det.lo>0);',
        'let frontFace=select(1u,0u,det.lo>0);',
      ),
    },
    {
      name: 'late-axis-validation-removed',
      kind: 'surface',
      negative: true,
      source: replaceSurfaceOnce(
        surfaceKernel,
        'if(!sdfIntervalVectorValid(origin) || !sdfIntervalVectorValid(direction) || !sdfIntervalVectorValid(boxBounds)){return unknown;}',
        '',
      ),
    },
  ] as const;
}
