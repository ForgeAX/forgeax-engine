import { surfaceDyadic } from '../../../render/src/__tests__/raytracing/sdf-surface-intersection.fixture';
import { SDF_SURFACE_LOCAL_RAY_WGSL } from '../sdf-surface-intersection-wgsl';
import {
  type LocalRayExactVector,
  type LocalRayFraction,
  type SurfaceLocalRayCase,
  surfaceLocalRayCases,
} from './sdf-surface-local-ray.data';

interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}
const scale = 1n << 149n;
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Complete local-ray fixture values required');
  return value;
};
function rational(n: bigint, d = 1n): Rational {
  if (d === 0n) throw new Error('Nonzero oracle denominator required');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return { n: n / a, d: d / a };
}
const add = (a: Rational, b: Rational) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const negate = (a: Rational) => rational(-a.n, a.d);
const subtract = (a: Rational, b: Rational) => add(a, negate(b));
const multiply = (a: Rational, b: Rational) => rational(a.n * b.n, a.d * b.d);
const divide = (a: Rational, b: Rational) => rational(a.n * b.d, a.d * b.n);
const less = (a: Rational, b: Rational) => a.n * b.d < b.n * a.d;
const equal = (a: Rational, b: Rational) => a.n * b.d === b.n * a.d;
const absolute = (a: Rational) => rational(a.n < 0n ? -a.n : a.n, a.d);
const fraction = (value: LocalRayFraction) => rational(BigInt(value[0]), BigInt(value[1]));
const rawReal = (value: number) => rational(surfaceDyadic(value), scale);
const maximum = (values: readonly Rational[]) => values.reduce((a, b) => (less(a, b) ? b : a));
const sum = (values: readonly Rational[]) => values.reduce(add, rational(0n));
const rawAt = (values: readonly number[], index: number) => required(values[index]);

function forwardValue(row: SurfaceLocalRayCase, target: readonly Rational[], axis: number) {
  return sum(
    target.map((value, column) => multiply(rawReal(rawAt(row.forward, column * 4 + axis)), value)),
  );
}
function worldCorners(row: SurfaceLocalRayCase, position: boolean): readonly Rational[][] {
  if (!position && row.endpoint) {
    if (row.originHi) throw new Error('Authored segments require point origins');
    return [
      row.endpoint.map((value, axis) => subtract(rawReal(value), rawReal(rawAt(row.origin, axis)))),
    ];
  }
  const low = position ? row.origin : row.direction,
    high = position ? row.originHi : row.directionHi;
  if (!high) return [low.map(rawReal)];
  return Array.from({ length: 8 }, (_, mask) =>
    low.map((value, axis) => rawReal((mask & (1 << axis)) === 0 ? value : rawAt(high, axis))),
  );
}
function expectedCorners(
  row: SurfaceLocalRayCase,
  position: boolean,
): readonly LocalRayExactVector[] {
  return position
    ? (row.exactOriginCorners ?? [row.exactOrigin])
    : (row.exactDirectionCorners ?? [row.exactDirection]);
}
function verifyForwardEquations(row: SurfaceLocalRayCase) {
  for (const position of [true, false]) {
    const world = worldCorners(row, position),
      expected = expectedCorners(row, position);
    if (world.length !== expected.length)
      throw new Error('Complete affine box-corner facts required');
    expected.forEach((corner, index) => {
      const target = corner.map(fraction);
      for (let axis = 0; axis < 3; axis++) {
        const projected = forwardValue(row, target, axis),
          value = position ? add(projected, rawReal(rawAt(row.forward, 12 + axis))) : projected;
        if (!equal(value, required(required(world[index])[axis])))
          throw new Error(
            `Canonical forward equation disagrees with exact expected value: ${row.name}`,
          );
      }
    });
  }
}
function residualElement(row: SurfaceLocalRayCase, i: number, j: number) {
  const product = sum(
    Array.from({ length: 3 }, (_, k) =>
      multiply(rawReal(rawAt(row.inverse, k * 4 + i)), rawReal(rawAt(row.forward, j * 4 + k))),
    ),
  );
  return subtract(rational(BigInt(i === j)), product);
}
function residualNorm(row: SurfaceLocalRayCase) {
  const rowSums = Array.from({ length: 3 }, (_, i) =>
    sum(Array.from({ length: 3 }, (_, j) => absolute(residualElement(row, i, j)))),
  );
  return maximum(rowSums);
}
function translationResidual(row: SurfaceLocalRayCase) {
  return maximum(
    Array.from({ length: 3 }, (_, axis) =>
      absolute(
        add(
          sum(
            Array.from({ length: 3 }, (_, column) =>
              multiply(
                rawReal(rawAt(row.inverse, column * 4 + axis)),
                rawReal(rawAt(row.forward, 12 + column)),
              ),
            ),
          ),
          rawReal(rawAt(row.inverse, 12 + axis)),
        ),
      ),
    ),
  );
}

/** Proves the supplied fractions by the canonical forward map, not the stored inverse. */
export function verifySurfaceLocalRayCase(row: SurfaceLocalRayCase) {
  if (row.forward.length !== 16 || row.inverse.length !== 16)
    throw new Error('Complete column-major affine words required');
  verifyForwardEquations(row);
  const rho = residualNorm(row),
    denominator = subtract(rational(1n), rho);
  if (!equal(rho, fraction(row.rho)) || !less(rho, rational(1n)))
    throw new Error(`Invalid forward/stored-inverse residual: ${row.name}`);
  if (
    less(rawReal(row.certificate[0]), divide(rho, denominator)) ||
    less(rawReal(row.certificate[1]), divide(translationResidual(row), denominator))
  )
    throw new Error(`Certificate does not bound forward/stored-inverse residual: ${row.name}`);
}

export function surfaceLocalRayInputBytes(cases = surfaceLocalRayCases): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(cases.length * 176),
    view = new DataView(bytes.buffer);
  cases.forEach((row, index) => {
    const words = [
      ...row.origin,
      0,
      ...(row.originHi ?? row.origin),
      0,
      ...row.direction,
      0,
      ...(row.directionHi ?? row.direction),
      0,
      ...row.range,
      row.worldValid ?? 1,
      0,
      ...row.inverse,
      ...row.certificate,
      0,
      0,
      ...(row.endpoint ?? [0, 0, 0]),
      row.endpoint ? 1 : 0,
    ];
    if (words.length !== 44) throw new Error('Exact 176-byte local-ray input required');
    words.forEach((value, word) => {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw new Error('Canonical u32 words required');
      view.setUint32(index * 176 + word * 4, value, true);
    });
  });
  return bytes;
}

export const surfaceLocalRayKernel = `${SDF_SURFACE_LOCAL_RAY_WGSL}
struct LocalRayInput { world:SdfSurfaceRay,inverse:array<vec4u,4>,certificate:vec4u,endpoint:vec4u }
@group(0) @binding(0) var<storage,read> inputs:array<LocalRayInput>;
@group(0) @binding(1) var<storage,read_write> outputs:array<vec4u>;
fn localRayTestWorld(row:LocalRayInput) -> SdfSurfaceRay {
 var world=row.world;
 if(row.endpoint.w==0u || world.valid!=1u){return world;}
 let origin=sdfIntervalVector(world.originLo,world.originHi);
 let endpoint=sdfIntervalVector(row.endpoint.xyz,row.endpoint.xyz);
 if(!sdfIntervalVectorValid(origin) || !sdfIntervalVectorValid(endpoint)){world.valid=0u;return world;}
 let direction=sdfIntervalVectorSubtract(endpoint,origin);
 if(!sdfIntervalVectorValid(direction)){world.valid=0u;return world;}
 let effectiveDirection=direction;
 for(var axis=0u;axis<3u;axis++){
  world.directionLo[axis]=bitcast<u32>(effectiveDirection.axis[axis].lo);
  world.directionHi[axis]=bitcast<u32>(effectiveDirection.axis[axis].hi);
 }
 return world;
}
@compute @workgroup_size(1) fn localRayTest(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&inputs)){return;}
 let row=inputs[id.x];let ray=sdfSurfaceLocalRay(localRayTestWorld(row),row.inverse,row.certificate.xy);
 outputs[id.x*5u]=vec4u(ray.originLo,ray.valid);outputs[id.x*5u+1u]=vec4u(ray.originHi,0u);
 outputs[id.x*5u+2u]=vec4u(ray.directionLo,0u);outputs[id.x*5u+3u]=vec4u(ray.directionHi,0u);outputs[id.x*5u+4u]=vec4u(ray.tRange,0u,0u);
}`;

function replaceOnce(source: string, from: string, to: string) {
  if (source.split(from).length !== 2) throw new Error('One source-owned local-ray fault required');
  return source.replace(from, to);
}
export function surfaceLocalRayVariants() {
  return [
    { name: 'local-ray', source: surfaceLocalRayKernel, negative: false },
    {
      name: 'residual-k-omitted',
      negative: true,
      source: replaceOnce(
        surfaceLocalRayKernel,
        'sdfIntervalPoint(certificate.x),sdfIntervalPoint(bitcast<u32>(maximum))',
        'sdfIntervalZero(),sdfIntervalPoint(bitcast<u32>(maximum))',
      ),
    },
    {
      name: 'residual-b-omitted',
      negative: true,
      source: replaceOnce(
        surfaceLocalRayKernel,
        'if(position){radius=sdfIntervalAdd(radius,sdfIntervalPoint(certificate.y));}',
        'if(false){radius=sdfIntervalAdd(radius,sdfIntervalPoint(certificate.y));}',
      ),
    },
    {
      name: 'interval-collapsed',
      negative: true,
      source: replaceOnce(
        surfaceLocalRayKernel,
        'input.axis[column]',
        'sdfIntervalPoint(bitcast<u32>(input.axis[column].lo))',
      ),
    },
    {
      name: 'segment-normalized',
      negative: true,
      source: replaceOnce(
        surfaceLocalRayKernel,
        'let effectiveDirection=direction;',
        'let normalized=normalize(vec3f(direction.axis[0].lo,direction.axis[1].lo,direction.axis[2].lo));let effectiveDirection=sdfIntervalVector(bitcast<vec3u>(normalized),bitcast<vec3u>(normalized));',
      ),
    },
  ] as const;
}

function endpointUsable(bits: number) {
  const magnitude = bits & 0x7fffffff;
  return magnitude === 0 || (magnitude >= 0x00800000 && magnitude <= 0x7f7fffff);
}
function assessVector(
  row: SurfaceLocalRayCase,
  actual: Uint32Array,
  expected: readonly LocalRayFraction[],
  low: number,
  high: number,
  label: string,
) {
  const failures: string[] = [];
  expected.forEach((value, axis) => {
    const lo = required(actual[low + axis]),
      hi = required(actual[high + axis]);
    if (!endpointUsable(lo) || !endpointUsable(hi)) {
      failures.push(`${row.name}: ${label}${axis} endpoint outside normal-or-zero domain`);
      return;
    }
    const target = fraction(value);
    if (less(target, rawReal(lo)) || less(rawReal(hi), target))
      failures.push(`${row.name}: ${label}${axis} not enclosed`);
  });
  return failures;
}
function assessDirectionWidth(row: SurfaceLocalRayCase, actual: Uint32Array) {
  const failures: string[] = [];
  if (row.directionMaximumWidth === undefined) return failures;
  for (let axis = 0; axis < 3; axis++) {
    const lo = required(actual[8 + axis]),
      hi = required(actual[12 + axis]);
    if (!endpointUsable(lo) || !endpointUsable(hi)) continue;
    const width = subtract(rawReal(hi), rawReal(lo));
    if (Number(width.n) / Number(width.d) > row.directionMaximumWidth)
      failures.push(`${row.name}: position residual was added to direction`);
  }
  return failures;
}
function assessLocalRay(row: SurfaceLocalRayCase, actual: Uint32Array) {
  const failures: string[] = [],
    valid = actual[3];
  if (valid !== 0 && valid !== 1) failures.push(`${row.name}: invalid validity flag`);
  if ((valid === 1) !== row.expectedValid) failures.push(`${row.name}: validity`);
  if (actual[16] !== row.range[0] || actual[17] !== row.range[1])
    failures.push(`${row.name}: original ray parameter range changed`);
  if (valid !== 1) return failures;
  for (const corner of expectedCorners(row, true))
    failures.push(...assessVector(row, actual, corner, 0, 4, 'origin'));
  for (const corner of expectedCorners(row, false))
    failures.push(...assessVector(row, actual, corner, 8, 12, 'direction'));
  failures.push(...assessDirectionWidth(row, actual));
  return failures;
}
export function assessSurfaceLocalRays(actual: Uint32Array, cases = surfaceLocalRayCases) {
  if (actual.length !== cases.length * 20)
    throw new Error('Complete 80-byte GPU local-ray records required');
  const failures: string[] = [];
  let valid = 0,
    unavailable = 0;
  cases.forEach((row, index) => {
    const record = actual.subarray(index * 20, (index + 1) * 20);
    if (record[3] === 1) valid++;
    else if (record[3] === 0) unavailable++;
    failures.push(...assessLocalRay(row, record));
  });
  return { cases: cases.length, valid, unavailable, failures };
}
