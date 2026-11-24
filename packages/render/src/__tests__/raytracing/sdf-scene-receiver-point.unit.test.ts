import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { assert, expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import { sdfSceneSurfaceTraceWgsl } from '../../raytracing/sdf-surface-trace';

interface Interval {
  lo: number;
  hi: number;
  valid: number;
}
type V3 = readonly [number, number, number];
interface Point {
  position: number[];
  error: number;
  valid: number;
}
const bits = (value: number) => new Uint32Array(Float32Array.of(value).buffer)[0] ?? 0;
const number = (word: number) => new Float32Array(Uint32Array.of(word).buffer)[0] ?? 0;
const raw = (lo: number, hi = lo): Interval => ({ lo, hi, valid: 1 });

/** The authored controls use only exactly representable normal dyadics. This
 * independent exact arithmetic model does not qualify GPU rounding or FTZ. */
function interval(lo: number, hi = lo) {
  assert(Number.isFinite(lo) && Number.isFinite(hi));
  assert(Math.fround(lo) === lo && Math.fround(hi) === hi);
  return raw(lo, hi);
}
function body(source: string, name: string) {
  const at = source.indexOf(`fn ${name}(`),
    open = source.indexOf('{', at);
  assert(at >= 0 && open > at, 'Actual producer function required');
  let end = open + 1,
    depth = 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  assert(depth === 0);
  return source
    .slice(open + 1, end - 1)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/bitcast<vec3u>\(/g, 'vectorBits(')
    .replace(/bitcast<u32>\(/g, 'bits(')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1');
}
function evaluatePoint(receiver: boolean, lo: V3, hi: V3, time: readonly [number, number]) {
  const source = sdfSceneSurfaceTraceWgsl(false, receiver);
  const deps: Record<string, unknown> = {
    bits,
    vectorBits: (v: readonly number[]) => v.map(bits),
    vec3f: (v: number) => [v, v, v],
    SdfScenePoint: (position: number[], error: number, valid: number) => ({
      position,
      error,
      valid,
    }),
    sdfIntervalVector: (a: readonly number[], b: readonly number[]) => ({
      axis: a.map((word, i) => interval(number(word), number(b[i] ?? word))),
    }),
    sdfIntervalRaw: (a: number, b: number) => interval(number(a), number(b)),
    sdfIntervalInvalid: () => ({ lo: 0, hi: 0, valid: 0 }),
    sdfIntervalZero: () => interval(0),
    sdfIntervalPoint: (word: number) => interval(number(word)),
    sdfIntervalAdd: (a: Interval, b: Interval) => interval(a.lo + b.lo, a.hi + b.hi),
    sdfIntervalSubtract: (a: Interval, b: Interval) => interval(a.lo - b.hi, a.hi - b.lo),
    sdfIntervalMultiply: (a: Interval, b: Interval) => {
      const products = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
      return interval(Math.min(...products), Math.max(...products));
    },
    max: Math.max,
    abs: Math.abs,
  };
  const names = Object.keys(deps);
  deps.sdfSceneRepresentative = new Function(
    ...names,
    `return function(value){${body(source, 'sdfSceneRepresentative')}};`,
  )(...names.map((k) => deps[k]));
  const pointNames = Object.keys(deps);
  const run = new Function(
    ...pointNames,
    `return function(ray,best,world){${body(source, 'sdfSceneSurfacePoint')}};`,
  )(...pointNames.map((k) => deps[k])) as (
    ray: { origin: V3; direction: V3 },
    best: { lower: number; upper: number },
    world: { originLo: number[]; originHi: number[]; directionLo: number[]; directionHi: number[] },
  ) => Point;
  return run(
    { origin: [0, 0, 0], direction: lo },
    { lower: time[0], upper: time[1] },
    {
      originLo: [0, 0, 0].map(bits),
      originHi: [0, 0, 0].map(bits),
      directionLo: lo.map(bits),
      directionHi: hi.map(bits),
    },
  );
}

it.each([
  { name: 'positive direction endpoint', lo: [1, 0, 0], hi: [2, 0, 0], time: [1, 1] },
  { name: 'negative direction endpoint', lo: [-2, 0, 0], hi: [-1, 0, 0], time: [1, 1] },
  { name: 'zero direction', lo: [0, 0, 0], hi: [0, 0, 0], time: [1, 1] },
  { name: 'closed origin endpoint', lo: [1, 0, 0], hi: [2, 0, 0], time: [0, 0] },
  { name: 'full closed time interval', lo: [1, 0, 0], hi: [2, 0, 0], time: [0, 1] },
] as const)('encloses receiver hit positions for $name', ({ lo, hi, time }) => {
  const result = evaluatePoint(true, lo, hi, time);
  expect(result.valid).toBe(1);
  // Independent corner oracle for the real O + D*t equation, rather than the
  // producer's representative/radius expressions.
  for (let axis = 0; axis < 3; axis++)
    for (const d of [lo[axis] ?? 0, hi[axis] ?? 0])
      for (const t of time) {
        expect((result.position[axis] ?? 0) - result.error).toBeLessThanOrEqual(d * t);
        expect((result.position[axis] ?? 0) + result.error).toBeGreaterThanOrEqual(d * t);
      }
});

it('retains the nonreceiver singleton path and complete generated bytes', () => {
  expect(evaluatePoint(false, [1, 0, 0], [2, 0, 0], [1, 1])).toEqual({
    position: [1, 0, 0],
    error: 0,
    valid: 1,
  });
  const digest = createHash('sha256').update(sdfSceneSurfaceTraceWgsl()).digest('hex');
  if (process.env.FORGEAX_CARD_POINT_BASELINE)
    expect(digest).toBe(readFileSync(process.env.FORGEAX_CARD_POINT_BASELINE, 'utf8').trim());
  if (process.env.FORGEAX_CARD_POINT_RECORD)
    writeFileSync(process.env.FORGEAX_CARD_POINT_RECORD, digest);
});

it('validates the actual complete Card receiver World composition', async () => {
  const result = await compileShader(irradianceFieldKernelWgsl('global-sdf').cardSurface, {
    id: 'card-receiver-direction-enclosure',
  });
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
});
