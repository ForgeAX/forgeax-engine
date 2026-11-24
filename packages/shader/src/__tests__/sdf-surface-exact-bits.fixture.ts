import { SDF_SURFACE_INTERSECTION_WGSL } from '../sdf-surface-intersection-wgsl';
import { exactEndpointDyadic, exactEndpointFraction } from './sdf-surface-exact-endpoints.fixture';

interface BitCase {
  readonly name: string;
  /** 0..2 are actual outer endpoints; 3/4 witness the private encoding only. */
  readonly op: number;
  readonly a: number;
  readonly b: number;
  readonly c?: number;
  readonly expected: 'point' | 'fallback' | 'invalid' | 'tag';
  readonly bits?: number;
}

export const exactBitCases: readonly BitCase[] = [
  { name: 'sum-positive-zero', op: 0, a: 0, b: 0, expected: 'point', bits: 0 },
  {
    name: 'sum-preserve-negative-zero',
    op: 0,
    a: 0,
    b: 0x80000000,
    expected: 'point',
    bits: 0x80000000,
  },
  { name: 'sum-preserve-positive-zero', op: 0, a: 0x80000000, b: 0, expected: 'point', bits: 0 },
  {
    name: 'sum-two-negative-zero',
    op: 0,
    a: 0x80000000,
    b: 0x80000000,
    expected: 'point',
    bits: 0x80000000,
  },
  { name: 'sum-cancellation', op: 0, a: 0x3f800000, b: 0xbf800000, expected: 'point', bits: 0 },
  {
    name: 'sum-unsigned-carry',
    op: 0,
    a: 0x3fffffff,
    b: 0x3c000080,
    expected: 'point',
    bits: 0x40008000,
  },
  { name: 'sum-dropped-low-bit', op: 0, a: 0x3f800000, b: 0x3c000001, expected: 'fallback' },
  {
    name: 'sum-negative-subnormal-result',
    op: 0,
    a: 0x80800001,
    b: 0x00800000,
    expected: 'fallback',
  },
  {
    name: 'sum-negative-overflow-rejected',
    op: 0,
    a: 0xff000000,
    b: 0xff000000,
    expected: 'invalid',
  },
  { name: 'sum-nan-input', op: 0, a: 0, b: 0x7fc00001, expected: 'invalid' },
  { name: 'sum-subnormal-input', op: 0, a: 0, b: 1, expected: 'invalid' },
  { name: 'multiply-negative-exp-zero', op: 1, a: 0x80800000, b: 0x3f000000, expected: 'fallback' },
  {
    name: 'multiply-negative-underflow',
    op: 1,
    a: 0x80800000,
    b: 0x3e800000,
    expected: 'fallback',
  },
  {
    name: 'multiply-positive-minnormal',
    op: 1,
    a: 0x00800000,
    b: 0x3f800000,
    expected: 'point',
    bits: 0x00800000,
  },
  {
    name: 'multiply-negative-minnormal',
    op: 1,
    a: 0x80800000,
    b: 0x3f800000,
    expected: 'point',
    bits: 0x80800000,
  },
  {
    name: 'multiply-exp255-rejected-before-exact',
    op: 1,
    a: 0xff000000,
    b: 0x40800000,
    expected: 'invalid',
  },
  { name: 'multiply-zero-infinity-input', op: 1, a: 0, b: 0x7f800000, expected: 'invalid' },
  { name: 'divide-negative-exp-zero', op: 2, a: 0x80800000, b: 0x40000000, expected: 'fallback' },
  { name: 'divide-negative-underflow', op: 2, a: 0x80800000, b: 0x40800000, expected: 'fallback' },
  {
    name: 'divide-exp255-rejected-before-exact',
    op: 2,
    a: 0xff000000,
    b: 0x3e800000,
    expected: 'invalid',
  },
  { name: 'divide-zero-subnormal-input', op: 2, a: 0, b: 1, expected: 'invalid' },
  { name: 'divide-negative-zero', op: 2, a: 0x80000000, b: 0x40400000, expected: 'point', bits: 0 },
  {
    name: 'private-magnitude-negative-exp0',
    op: 3,
    a: 0x800000,
    b: 0,
    c: 0x80000000,
    expected: 'tag',
  },
  {
    name: 'private-magnitude-negative-exp255',
    op: 3,
    a: 0x800000,
    b: 255,
    c: 0x80000000,
    expected: 'tag',
  },
  {
    name: 'private-magnitude-zero-is-positive-zero',
    op: 3,
    a: 0,
    b: 255,
    c: 0x80000000,
    expected: 'point',
    bits: 0,
  },
  {
    name: 'private-scale-negative-exp0',
    op: 4,
    a: 0x3f800000,
    b: 0,
    c: 0x80000000,
    expected: 'tag',
  },
  {
    name: 'private-scale-negative-exp255',
    op: 4,
    a: 0x3f800000,
    b: 255,
    c: 0x80000000,
    expected: 'tag',
  },
  {
    name: 'private-scale-negative-normal',
    op: 4,
    a: 0x3f800000,
    b: 127,
    c: 0x80000000,
    expected: 'point',
    bits: 0xbf800000,
  },
];

export function exactBitInput() {
  return new Uint8Array(
    Uint32Array.from(exactBitCases.flatMap((row) => [row.a, row.b, row.c ?? 0, row.op])).buffer,
  );
}

export function exactBitKernel(source = SDF_SURFACE_INTERSECTION_WGSL, bits = true) {
  const encode = bits
    ? 'let encoded=select(sdfIntervalTryExactScale(row.x,i32(row.y),row.z),sdfIntervalTryExactMagnitude(row.x,row.y,row.z),row.w==3u);if(encoded!=0x7f800000u){let v=bitcast<f32>(encoded);result=SdfRealInterval(v,v,1u);}tag=encoded;'
    : 'result=sdfIntervalTryExactScale(row.x,i32(row.y),row.z);if(row.w==3u){result=sdfIntervalTryExactMagnitude(row.x,row.y,row.z);}tag=select(0x7f800000u,bitcast<u32>(result.lo),result.valid==1u);';
  return `${source}
@group(0)@binding(0)var<storage,read> inputs:array<vec4u>;
@group(0)@binding(1)var<storage,read_write> outputs:array<vec4u>;
@compute @workgroup_size(1)fn exactBits(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=arrayLength(&inputs)){return;}let row=inputs[id.x];var result=sdfIntervalInvalid();var tag=0u;
 switch(row.w){
  case 0u:{result=sdfIntervalSumEndpoint(bitcast<f32>(row.x),bitcast<f32>(row.y));}
  case 1u:{result=sdfIntervalProductEndpoint(bitcast<f32>(row.x),bitcast<f32>(row.y));}
  case 2u:{result=sdfIntervalQuotientEndpoint(bitcast<f32>(row.x),bitcast<f32>(row.y));}
  default:{${encode}}
 }
 outputs[id.x]=vec4u(result.valid,bitcast<u32>(result.lo),bitcast<u32>(result.hi),tag);
}`;
}

function assessBitCase(row: BitCase, raw: Uint32Array) {
  const [valid, lo = 0, hi = 0, tag] = raw;
  if (row.expected === 'tag')
    return valid === 0 && lo === 0 && hi === 0 && tag === 0x7f800000
      ? []
      : ['bare failure tag required'];
  if (row.expected === 'invalid') return valid === 0 ? [] : ['outer invalid domain accepted'];
  if (valid !== 1) return ['valid result absent'];
  if (row.expected === 'point')
    return lo === row.bits && hi === row.bits ? [] : ['point raw bits changed'];
  if (lo === hi) return ['outward fallback absent'];
  if (((lo >>> 23) & 255) === 255 || ((hi >>> 23) & 255) === 255)
    return ['nonfinite fallback endpoint'];
  const [numerator, denominator] = exactEndpointFraction({
    ...row,
    expected: 'fallback',
    op: row.op as 0 | 1 | 2,
  });
  const scale = 1n << 149n;
  return exactEndpointDyadic(lo) * denominator <= numerator * scale &&
    exactEndpointDyadic(hi) * denominator >= numerator * scale
    ? []
    : ['fallback excludes exact real result'];
}

export function assessExactBits(raw: Uint32Array) {
  if (raw.length !== exactBitCases.length * 4)
    throw new Error('Complete bit-result witness required');
  const rows = exactBitCases.map((row, i) => ({
    name: row.name,
    op: row.op,
    actual: Array.from(raw.slice(i * 4, i * 4 + 4)),
    failures: assessBitCase(row, raw.slice(i * 4, i * 4 + 4)),
  }));
  return {
    rows,
    failures: rows.flatMap((row) => row.failures.map((failure) => `${row.name}: ${failure}`)),
  };
}

export function exactBitVariants() {
  const source = SDF_SURFACE_INTERSECTION_WGSL;
  const signedFailure = source.replaceAll(
    'if(exponent<1 || exponent>254){return 0x7f800000u;}',
    'if(exponent<1 || exponent>254){return sign|0x7f800000u;}',
  );
  return [
    { name: 'production', negative: false, source: exactBitKernel(source) },
    {
      name: 'zero-is-failure',
      negative: true,
      source: exactBitKernel(
        source.replaceAll('if(exact!=0x7f800000u)', 'if(exact!=0x7f800000u && exact!=0u)'),
      ),
    },
    { name: 'signed-failure-tag', negative: true, source: exactBitKernel(signedFailure) },
  ];
}
