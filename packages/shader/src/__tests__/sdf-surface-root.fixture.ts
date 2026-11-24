import { SDF_SURFACE_ROOT_PREPARE_WGSL } from '../sdf-surface-root-request-wgsl';
import { SDF_SURFACE_TRACE_ROOT_WGSL } from '../sdf-surface-trace-wgsl';

type V = { x: number; y: number; z: number; w: number; xy: V; zw: V };
interface RootRequest {
  expected: V;
  control: V;
  payload: [V, V, V, V];
}
export const rootBits = (value: number) => new Uint32Array(Float32Array.of(value).buffer)[0] ?? 0;
const float = (bits: number) => new Float32Array(Uint32Array.of(bits).buffer)[0] ?? NaN;
export function rootVector(...parts: (number | V)[]): V {
  const values = parts.flatMap((p) => (typeof p === 'number' ? [p] : [p.x, p.y, p.z]));
  const v = { x: values[0] ?? 0, y: values[1] ?? 0, z: values[2] ?? 0, w: values[3] ?? 0 } as V;
  Object.defineProperties(v, {
    xy: {
      get: () => rootVector(v.x, v.y),
      set: (n: V) => {
        v.x = n.x;
        v.y = n.y;
      },
    },
    zw: {
      get: () => rootVector(v.z, v.w),
      set: (n: V) => {
        v.z = n.x;
        v.w = n.y;
      },
    },
  });
  return v;
}
const different = (a: V, b: V) =>
  ['x', 'y', 'z', 'w'].some((k) => a[k as keyof V] !== b[k as keyof V]);
function sourceBody(source: string, name: string) {
  const at = source.indexOf(`fn ${name}(`);
  if (at < 0) throw Error('Actual function absent');
  const first = source.indexOf('{', at);
  let depth = 1,
    end = first + 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  if (depth !== 0) throw Error('Unclosed function');
  return source.slice(first + 1, end - 1).replace(/\/\/[^\n]*/g, '');
}
function vectorComparisons(text: string): string {
  for (const name of ['any', 'all']) {
    let start = text.indexOf(`${name}(`);
    while (start >= 0) {
      let end = start + name.length + 1,
        depth = 1;
      for (; depth > 0 && end < text.length; end++) {
        if (text[end] === '(') depth++;
        if (text[end] === ')') depth--;
      }
      const inner = text.slice(start + name.length + 1, end - 1);
      const split = inner.split(/(!=|==)/);
      if (split.length !== 3) throw Error('Unsupported vector predicate');
      const comparison = `different(${split[0]},${split[2]})`;
      if (!((name === 'any' && split[1] === '!=') || (name === 'all' && split[1] === '==')))
        throw Error('Unsupported vector equality reduction');
      const invert = split[1] === '==';
      const replacement = invert ? `(!${comparison})` : comparison;
      text = text.slice(0, start) + replacement + text.slice(end);
      start = text.indexOf(`${name}(`, start + replacement.length);
    }
  }
  return text;
}

/** Executes only actual WGSL control with an allowlisted grammar. Interval,
 * affine, slab and sampler dependencies below are independent authored models;
 * this is not GPU arithmetic emulation or a substitute for actual dispatch. */
export function executable<T = unknown>(
  source: string,
  name: string,
  args: string,
  deps: Record<string, unknown>,
) {
  const body = vectorComparisons(sourceBody(source, name))
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1')
    .replace(/\blet\b/g, 'const')
    .replace(/\bvar\b/g, 'let')
    .replace(/\*remaining/g, 'remaining.value')
    .replace(/\*consumed/g, 'consumed.value')
    .replace(/bitcast<f32>\(/g, 'float(')
    .replace(/bitcast<u32>\(/g, 'rootBits(')
    .replace(/let (\w+):SdfSurfaceRootRequest;/g, 'let $1=empty();')
    .replace(/let (\w+):vec3u;/g, 'let $1=rootVector(0,0,0);')
    .replace('out.expected=expected', 'out.expected=clone(expected)')
    .replace('let sampleRay=local;', 'let sampleRay=clone(local);');
  if (/[^\w\s.[\],;(){}=!<>%&|+*/-]/.test(body) || /\.\w+\s*\(/.test(body))
    throw Error('Unsupported source grammar');
  const names = Object.keys(deps);
  for (const call of body.matchAll(/\b(\w+)\s*\(/g))
    if (!['if', 'for', 'while', 'return', ...names].includes(call[1] ?? ''))
      throw Error(`Unsupported call ${call[1]}`);
  return Function(
    ...names,
    `"use strict";return function(${args}){${body}}`,
  )(...names.map((n) => deps[n])) as (...values: unknown[]) => T;
}

export interface RootControl {
  budget: number;
  entry?: number;
  covered?: boolean;
  oldUnusable?: boolean;
  selected?: boolean;
  rawValid?: boolean;
  packetValid?: boolean;
  sourceValid?: boolean;
  actualEpoch?: number;
  prefixEnd?: number;
  first?: number;
  last?: number;
  rayIndex?: number;
  frameToken?: number;
}
export function rootControl(input: RootControl, source = SDF_SURFACE_ROOT_PREPARE_WGSL) {
  const context = rootVector(input.rayIndex ?? 0, input.frameToken ?? 0);
  const expected = rootVector(36, 512, 1, 7),
    actual = rootVector(36, 512, 1, input.actualEpoch ?? 7);
  const world = {
    valid: 1,
    originLo: rootVector(0, 0, 0),
    originHi: rootVector(0, 0, 0),
    directionLo: rootVector(1, 0, 0),
    directionHi: rootVector(1, 0, 0),
    tRange: rootVector(rootBits(input.first ?? 0), rootBits(input.last ?? 8)),
  };
  const empty = () => ({
    expected: rootVector(0, 0, 0, 0),
    control: rootVector(0, 0, 0, 0),
    payload: Array.from({ length: 4 }, () => rootVector(0, 0, 0, 0)),
  });
  let samples = 0;
  const deps: Record<string, unknown> = {
    empty,
    rootBits,
    float,
    different,
    vec4u: rootVector,
    vec3u: rootVector,
    vec2u: rootVector,
    clone: (v: unknown) => structuredClone(v),
    sdfIntervalPoint: (bits: number) => ({
      valid: Number(Number.isFinite(float(bits))),
      lo: float(bits),
    }),
    sdfMeshMarchSourceReady: (a: V, b: V) =>
      input.sourceValid !== false && !different(a, b) && b.w !== 0,
    sdfInstanceValid: () => input.rawValid !== false,
    sdfInstanceMask: () => (input.selected === false ? 0 : 255),
    sdfSurfaceRowAssociated: () => input.packetValid !== false,
    sdfInstanceWord: (_r: number, w: number) => (w === 16 ? 73 : 0),
    sdfSurfacePacket: () => ({
      valid: Number(input.packetValid !== false),
      nodes: { x: 0, y: 1 },
      prefixEligible: 1,
      coefficients: { yz: [0, 0] },
    }),
    sdfSurfaceInverse: () => [],
    sdfSurfaceLocalRay: (v: unknown) => structuredClone(v),
    sdfFieldWord: (w: number) => (w === 3 ? 1 : 0),
    sdfSurfaceSegmentBoxClear: () => false,
    sdfSurfaceSlab: () => ({ certified: 1, possible: 1, near: input.entry ?? 0, far: 8 }),
    sdfMeshMarchLayout: () => true,
    sdfSurfaceRootOldSampleUnusable: () => input.oldUnusable === true,
    sdfMeshMarchCoverage: () => input.covered !== false,
    sdfSurfaceRootPrefix: (_r: unknown, _p: unknown, ray: { tRange: V }) => {
      samples++;
      return { valid: 1, samples: 1, end: input.prefixEnd ?? float(ray.tRange.x) + 0.5 };
    },
  };
  deps.sdfSurfaceRootRequestEmpty = executable(
    source,
    'sdfSurfaceRootRequestEmpty',
    'world,mask,budget,expected,context',
    deps,
  );
  deps.sdfSurfaceRootRequestMatches = executable(
    source,
    'sdfSurfaceRootRequestMatches',
    'request,world,mask,expected,budget,context',
    deps,
  );
  deps.sdfSurfaceRedeemRoot = executable(
    source,
    'sdfSurfaceRedeemRoot',
    'row,world,request,expected,mask,remaining,consumed,context',
    deps,
  );
  const request = executable<RootRequest>(
    source,
    'sdfSurfacePrepareRoot',
    'world,row,mask,actual,expected,budget,context',
    deps,
  )(world, 0, 1, actual, expected, input.budget, context);
  const remaining = { value: input.budget },
    consumed = { value: 0 };
  const redeem = (row = 0) =>
    (deps.sdfSurfaceRedeemRoot as (...v: unknown[]) => number)(
      row,
      world,
      request,
      expected,
      1,
      remaining,
      consumed,
      context,
    );
  const matches = () =>
    (deps.sdfSurfaceRootRequestMatches as (...v: unknown[]) => boolean)(
      request,
      world,
      1,
      expected,
      input.budget,
      context,
    );
  const payment = (trace = SDF_SURFACE_TRACE_ROOT_WGSL) => {
    const clause = rootPaymentClause(trace);
    const code = `fn payment(){${clause}return paid;}`;
    const best = { state: 0, lower: 0 };
    deps.sdfSurfaceCharge = (value: { value: number }) => {
      if (value.value === 0) return false;
      value.value--;
      return true;
    };
    return executable(
      code,
      'payment',
      'node,row,world,request,expected,mask,remaining,consumed,best,first,context',
      deps,
    )(0, 0, world, request, expected, 1, remaining, consumed, best, 0, context);
  };
  return {
    request,
    world,
    expected,
    context,
    remaining,
    consumed,
    redeem,
    matches,
    payment,
    get samples() {
      return samples;
    },
  };
}

/** Actual generated loop's payment clause, not a separate implementation. */
export function rootPaymentClause(source = SDF_SURFACE_TRACE_ROOT_WGSL) {
  const body = sourceBody(source, 'sdfSurfaceTraceRow');
  const first = body.indexOf('var paid=false;');
  const end = body.indexOf('let at=', first);
  if (first < 0 || end < 0) throw Error('Missing actual root payment clause');
  return body.slice(first, end);
}

/** Exact dyadic controls only. These exercise the actual separation predicate;
 * interval operations are independent exact arithmetic at small dyadic inputs,
 * not a model of GPU permitted rounding. Naga/GPU cover the production body. */
export function rootSeparationControl(position: readonly [number, number, number]) {
  const point = (value: number) => ({ valid: 1, lo: value, hi: value });
  const origin = { axis: position.map(point) },
    direction = { axis: [point(1), point(0), point(0)] };
  const vector = (lo: unknown) => (lo === origin ? origin : direction);
  const add = (a: ReturnType<typeof point>, b: ReturnType<typeof point>) => point(a.lo + b.lo);
  const subtract = (a: ReturnType<typeof point>, b: ReturnType<typeof point>) => point(a.lo - b.lo);
  const multiply = (a: ReturnType<typeof point>, b: ReturnType<typeof point>) => point(a.lo * b.lo);
  const dependencies = {
    rootBits,
    float,
    f32: (v: number) => v,
    sdfIntervalPoint: (v: number) => point(float(v)),
    sdfIntervalZero: () => point(0),
    sdfIntervalVector: vector,
    sdfIntervalAdd: add,
    sdfIntervalSubtract: subtract,
    sdfIntervalMultiply: multiply,
    sdfInstanceWord: (_row: number, word: number) =>
      word === 27 || word === 31 ? rootBits(1) : word >= 21 && word <= 23 ? 3 : rootBits(0),
  };
  return executable<boolean>(
    SDF_SURFACE_ROOT_PREPARE_WGSL,
    'sdfSurfaceRootOldSampleUnusable',
    'row,ray',
    dependencies,
  )(0, {
    originLo: origin,
    originHi: origin,
    directionLo: direction,
    directionHi: direction,
    tRange: { x: rootBits(0) },
  });
}
