import { SDF_MESH_MARCH_WGSL } from '../sdf-mesh-march-wgsl';

type Tuple = { x: number; y: number; z: number; w: number };
type RawRay = { tRange: { x: number; y: number }; valid: number };
export interface MarchControl {
  budget: number;
  first?: number;
  last?: number;
  speed?: number;
  origin?: number;
  mask?: number;
  rowMask?: number;
  rawValid?: boolean;
  localValid?: boolean;
  packetValid?: boolean;
  eligible?: boolean;
  layout?: boolean;
  coverage?: readonly [number, number];
  actual?: Tuple;
  expected?: Tuple;
  prefix?: (time: number) => { valid: number; samples: number; end: number };
}
interface MarchRequest {
  state: number;
  row: number;
  instance: number;
  attempts: number;
  originalRange: { x: number; y: number };
  sampledAt: number;
  firstUnresolved: number;
  samples: number;
  remaining: number;
  emptyEndLower: number;
  expectedSource: Tuple;
}
export const marchBits = (value: number) => new Uint32Array(Float32Array.of(value).buffer)[0] ?? 0;
const float = (value: number) => new Float32Array(Uint32Array.of(value).buffer)[0] ?? NaN;

function body(source: string, name: string) {
  const at = source.indexOf(`fn ${name}(`);
  if (at < 0) throw Error('Required actual function missing');
  const start = source.indexOf('{', at);
  let depth = 1;
  let end = start + 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  if (depth !== 0) throw Error('Closed function required');
  return source.slice(start + 1, end - 1).replace(/\/\/[^\n]*/g, '');
}

/** Restricted execution of the actual source's integer admission and loop
 * control. Affine/coverage/sample operations are explicit independent fixture
 * dependencies, not GPU arithmetic emulation. Unsupported source shapes fail. */
function controlFunction(source: string, name: string, dependencies: Record<string, unknown>) {
  let text = body(source, name)
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1')
    .replace(/\blet\b/g, 'const')
    .replace(/\bvar\b/g, 'let')
    .replace(/\*remaining/g, 'remaining.value')
    .replace(/bitcast<f32>\(/g, 'float(')
    .replace(/bitcast<u32>\(/g, 'bits(')
    .replace('any(actual!=expected)', 'different(actual,expected)')
    .replace('let sampleRay=local;', 'let sampleRay=clone(local);')
    .replace(/\bloop\s*\{/g, 'while(tick()){');
  if (/[^\w\s.,;(){}=!<>%&|+*/-]/.test(text) || /\.\w+\s*\(/.test(text))
    throw Error('Unsupported source grammar');
  const names = Object.keys(dependencies);
  for (const match of text.matchAll(/\b(\w+)\s*\(/g)) {
    if (!['if', 'while', ...names].includes(match[1] ?? '')) throw Error('Unsupported source call');
  }
  const argumentsList =
    name === 'sdfMeshMarchSourceReady'
      ? 'actual,expected'
      : 'world,row,mask,actual,expected,remaining';
  text = `"use strict";return function(${argumentsList}){${text}}`;
  // The small closed grammar above deliberately excludes indexing, strings,
  // property calls, arbitrary declarations and any new dependency function.
  return Function(...names, text)(...names.map((key) => dependencies[key])) as (
    world: RawRay,
    row: number,
    mask: number,
    actual: Tuple,
    expected: Tuple,
    remaining: { value: number },
  ) => MarchRequest;
}

export function runMarchControl(input: MarchControl, source = SDF_MESH_MARCH_WGSL) {
  const actual = input.actual ?? { x: 36, y: 128, z: 1, w: 7 };
  const expected = input.expected ?? { x: 36, y: 128, z: 1, w: 7 };
  let ticks = 0;
  let floatingPreparations = 0;
  const sampled: number[] = [];
  const dependencies: Record<string, unknown> = {
    float,
    bits: marchBits,
    clone: structuredClone,
    different: (a: Tuple, b: Tuple) =>
      ['x', 'y', 'z', 'w'].some((key) => a[key as keyof Tuple] !== b[key as keyof Tuple]),
    tick: () => {
      if (++ticks > 1025) throw Error('Control did not terminate under the original budget');
      return true;
    },
    sdfInstanceRowCount: () => 1,
    sdfFieldWordCount: () => 128,
    sdfSurfaceDirectory: () => ({ valid: 1, indexed: 1, epoch: 7, rowLimit: 1 }),
    sdfInstanceMask: () => input.rowMask ?? 255,
    sdfInstanceValid: () => input.rawValid !== false,
    sdfSurfaceRowAssociated: () => true,
    sdfInstanceWord: (_row: number, word: number) => {
      if (word !== 16) throw Error('Unexpected raw word in loop control');
      return 73;
    },
    sdfSurfacePacket: () => ({
      valid: Number(input.packetValid !== false),
      prefixEligible: Number(input.eligible !== false),
      coefficients: { yz: [0, 0] },
    }),
    sdfSurfaceInverse: () => undefined,
    sdfSurfaceLocalRay: (ray: RawRay) => {
      floatingPreparations++;
      return { ...structuredClone(ray), valid: Number(input.localValid !== false) };
    },
    sdfMeshMarchLayout: () => input.layout !== false,
    sdfMeshMarchCoverage: (_row: number, ray: RawRay) => {
      const at = (input.origin ?? 0) + (input.speed ?? 1) * float(ray.tRange.x);
      const [lo, hi] = input.coverage ?? [0, 8];
      return at >= lo && at <= hi;
    },
    sdfSurfaceRootPrefix: (_row: number, _packet: unknown, ray: RawRay) => {
      const at = float(ray.tRange.x);
      sampled.push(at);
      return input.prefix?.(at) ?? { valid: 0, samples: 1, end: 0 };
    },
    SdfMeshMarchRequest: (...values: unknown[]) =>
      Object.fromEntries(
        [
          'state',
          'row',
          'instance',
          'attempts',
          'originalRange',
          'sampledAt',
          'firstUnresolved',
          'samples',
          'remaining',
          'emptyEndLower',
          'expectedSource',
        ].map((key, index) => [key, structuredClone(values[index])]),
      ),
  };
  dependencies.sdfMeshMarchSourceReady = controlFunction(
    source,
    'sdfMeshMarchSourceReady',
    dependencies,
  );
  const invoke = controlFunction(source, 'sdfMeshMarchRow', dependencies);
  const world = {
    tRange: { x: marchBits(input.first ?? 0), y: marchBits(input.last ?? 3) },
    valid: 1,
  };
  const remaining = { value: input.budget };
  const result = invoke(world, 0, input.mask ?? 255, actual, expected, remaining);
  return { result, remaining: remaining.value, sampled, floatingPreparations, world };
}

type Fraction = readonly [bigint, bigint];
function dyadic(value: number): Fraction {
  const raw = marchBits(value),
    exponent = (raw >>> 23) & 255;
  const mantissa = BigInt(raw & 0x7fffff) | (exponent ? 0x800000n : 0n);
  const power = exponent ? exponent - 150 : -149;
  const signed = raw >>> 31 ? -mantissa : mantissa;
  return power >= 0 ? [signed << BigInt(power), 1n] : [signed, 1n << BigInt(-power)];
}
const add = (a: Fraction, b: Fraction): Fraction => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const sub = (a: Fraction, b: Fraction): Fraction => add(a, [-b[0], b[1]]);
const mul = (a: Fraction, b: Fraction): Fraction => [a[0] * b[0], a[1] * b[1]];
const div = (a: Fraction, b: Fraction): Fraction => [a[0] * b[1], a[1] * b[0]];
const abs = (a: Fraction): Fraction => [a[0] < 0n ? -a[0] : a[0], a[1]];
function lowerFloat(value: Fraction) {
  const rounded = Math.fround(Number(value[0]) / Number(value[1]));
  const candidate = dyadic(rounded);
  return candidate[0] * value[1] > value[0] * candidate[1]
    ? float(marchBits(rounded) - 1)
    : rounded;
}

/** Independent exact-rational lower bound for axis-aligned authored planes.
 * It supplies the loop-control dependency, not the WGSL interval implementation. */
export function planePrefix(
  plane: number,
  band: number,
  speed = 1,
  error = 0,
  omitError = false,
  lastCorner = 8,
) {
  return (at: number) => {
    const point = Math.fround(at * speed);
    const corner = Math.max(0, Math.min(lastCorner, Math.floor(point)));
    const stored = Math.min(Math.abs(plane - corner) + error, band);
    const code = Math.round((stored / band) * 32767);
    const quantized = mul([BigInt(code - 1), 32767n], dyadic(band));
    const radius = abs(sub(dyadic(point), dyadic(corner)));
    const lower = sub(sub(quantized, dyadic(omitError ? 0 : error)), radius);
    if (lower[0] <= 0n) return { valid: 0, samples: 1, end: 0 };
    const end = lowerFloat(add(dyadic(at), div(lower, abs(dyadic(speed)))));
    return { valid: Number(end > at), samples: 1, end };
  };
}
