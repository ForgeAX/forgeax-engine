import { SDF_SURFACE_INTERSECTION_WGSL } from '../sdf-surface-intersection-wgsl';
import { type ExactEndpointCase, exactEndpointCases } from './sdf-surface-exact-endpoints.data';

const scale = 1n << 149n;
export function exactEndpointDyadic(bits: number): bigint {
  const exponent = (bits >>> 23) & 255;
  if (exponent === 255) throw new Error('Finite dyadic oracle input required');
  const fraction = BigInt(bits & 0x7fffff);
  const value = exponent === 0 ? fraction : (0x800000n | fraction) << BigInt(exponent - 1);
  return bits >>> 31 === 0 ? value : -value;
}

/** Complete real operation over canonical raw inputs; not a copy of the endpoint implementation. */
export function exactEndpointFraction(row: ExactEndpointCase): readonly [bigint, bigint] {
  const a = exactEndpointDyadic(row.a),
    b = exactEndpointDyadic(row.b);
  if (row.op === 0) return [a + b, scale];
  if (row.op === 1) return [a * b, scale * scale];
  if (b === 0n) throw new Error('Undefined division has no real oracle');
  return b > 0n ? [a, b] : [-a, -b];
}

function usable(bits: number) {
  const magnitude = bits & 0x7fffffff;
  return magnitude === 0 || (magnitude >= 0x00800000 && magnitude <= 0x7f7fffff);
}

function assessEndpoint(row: ExactEndpointCase, actual: Uint32Array) {
  if (row.expected === 'invalid') return actual[0] === 0 ? [] : ['unsupported domain accepted'];
  const loBits = actual[1] ?? 0,
    hiBits = actual[2] ?? 0;
  if (actual[0] !== 1 || !usable(loBits) || !usable(hiBits)) return ['canonical interval absent'];
  const lo = exactEndpointDyadic(loBits),
    hi = exactEndpointDyadic(hiBits),
    [numerator, denominator] = exactEndpointFraction(row),
    failures: string[] = [];
  if (lo > hi || lo * denominator > numerator * scale || hi * denominator < numerator * scale)
    failures.push('exact real result outside interval');
  if (row.expected === 'point' && (lo !== hi || lo !== exactEndpointDyadic(row.point)))
    failures.push('required representable exact point absent');
  if (row.expected === 'fallback' && lo === hi) failures.push('required outward fallback absent');
  return failures;
}

export function assessExactEndpoints(raw: Uint32Array) {
  if (raw.length !== exactEndpointCases.length * 4)
    throw new Error('Complete endpoint rows required');
  const rows = exactEndpointCases.map((row, index) => ({
    name: row.name,
    expected: row.expected,
    actual: Array.from(raw.subarray(index * 4, index * 4 + 4)),
    failures: assessEndpoint(row, raw.subarray(index * 4, index * 4 + 4)),
  }));
  return {
    rows,
    failures: rows.flatMap((row) => row.failures.map((failure) => `${row.name}: ${failure}`)),
  };
}

export function exactEndpointInput() {
  return new Uint8Array(
    Uint32Array.from(exactEndpointCases.flatMap((row) => [row.a, row.b, row.op, 0])).buffer,
  );
}

const exactEndpointEntry = `
@group(0) @binding(0) var<storage,read> inputs:array<vec4u>;
@group(0) @binding(1) var<storage,read_write> outputs:array<vec4u>;
@compute @workgroup_size(1) fn exactEndpoints(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&inputs)){return;}
 let row=inputs[id.x];let a=sdfIntervalPoint(row.x);let b=sdfIntervalPoint(row.y);
 var result=sdfIntervalInvalid();
 switch(row.z){
  case 0u:{result=sdfIntervalAdd(a,b);}
  case 1u:{result=sdfIntervalMultiply(a,b);}
  case 2u:{result=sdfIntervalDivide(a,b);}
  default:{}
 }
 outputs[id.x]=vec4u(result.valid,bitcast<u32>(result.lo),bitcast<u32>(result.hi),0u);
}`;

export function exactEndpointKernelFor(source: string) {
  return source + exactEndpointEntry;
}
export const exactEndpointKernel = exactEndpointKernelFor(SDF_SURFACE_INTERSECTION_WGSL);

function replaceEndpointOnce(before: string, after: string) {
  if (exactEndpointKernel.split(before).length !== 2)
    throw new Error('One source-owned endpoint negative-control anchor required');
  return exactEndpointKernel.replace(before, after);
}
export function exactEndpointVariants() {
  return [
    { name: 'production', negative: false, source: exactEndpointKernel },
    {
      name: 'discarded-bit-ignored',
      negative: true,
      source: replaceEndpointOnce('if((magnitude&((1u<<shift)-1u))!=0u){return 0x7f800000u;}', ''),
    },
    {
      name: 'power-two-numerator',
      negative: true,
      source: replaceEndpointOnce(
        'if((bb&0x7fffffu)==0u){',
        'if((bb&0x7fffffu)==0u || (ab&0x7fffffu)==0u){',
      ),
    },
    {
      name: 'signed-magnitude',
      negative: true,
      source: replaceEndpointOnce('magnitude=am+bm;', 'magnitude=u32(abs(bitcast<i32>(am+bm)));'),
    },
    {
      name: 'wide-shift-guard-removed',
      negative: true,
      source: replaceEndpointOnce('if(aShift>=32u || bShift>=32u){return 0x7f800000u;}', ''),
    },
    {
      name: 'wide-capacity-guard-removed',
      negative: true,
      source: replaceEndpointOnce(
        'if(am>(0xffffffffu>>aShift) || bm>(0xffffffffu>>bShift)){return 0x7f800000u;}',
        '',
      ),
    },
    {
      name: 'wide-sum-overflow-guard-removed',
      negative: true,
      source: replaceEndpointOnce(
        'if(((a^b)&0x80000000u)==0u && am>0xffffffffu-bm){return 0x7f800000u;}',
        '',
      ),
    },
  ];
}
