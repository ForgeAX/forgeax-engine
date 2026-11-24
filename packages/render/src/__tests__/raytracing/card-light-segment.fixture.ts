import { CARD_RECEIVER_WGSL } from '../../raytracing/card-receiver';

interface Interval {
  lo: number;
  hi: number;
  valid: number;
}
export interface CanonicalPoint {
  readonly axis: readonly Interval[];
}
const storage = new DataView(new ArrayBuffer(4));
const bits = (value: number) => {
  storage.setFloat32(0, value, true);
  return storage.getUint32(0, true);
};
const number = (word: number) => {
  storage.setUint32(0, word, true);
  return storage.getFloat32(0, true);
};
const usable = (word: number) => {
  const m = word & 0x7fffffff;
  return m === 0 || (m >= 0x800000 && m <= 0x7f7fffff);
};
function vector(...values: number[]) {
  return Object.assign(values, { x: values[0], y: values[1], z: values[2], w: values[3] });
}
function outward(value: number, up: boolean) {
  const rounded = Math.fround(value);
  if ((up ? rounded >= value : rounded <= value) || !Number.isFinite(rounded)) return rounded;
  if (rounded === 0) return number(up ? 1 : 0x80000001);
  return number((bits(rounded) + (rounded < 0 === up ? -1 : 1)) >>> 0);
}
function subtract(a: CanonicalPoint, b: CanonicalPoint): CanonicalPoint {
  return {
    axis: a.axis.map((x, i) => {
      const y = b.axis[i];
      if (!y) throw Error('Three axes required');
      // This CPU fixture deliberately supports only finite small dyadics. The
      // independent scalar GPU contract owns overflow and general arithmetic.
      if (![x.lo, x.hi, y.lo, y.hi].every((v) => Number.isFinite(v) && Math.abs(v) <= 128))
        throw Error('Bounded fixture domain required');
      return {
        lo: outward(x.lo - y.hi, false),
        hi: outward(x.hi - y.lo, true),
        valid: x.valid & y.valid,
      };
    }),
  };
}

/** Executes only the actual private segment producer control flow. It does not
 * execute World or claim numerical GPU qualification of the interval library. */
export function executeCardLightSegment(
  point: CanonicalPoint,
  light: readonly number[],
  kind: number,
  incoming: readonly number[],
  limit: number,
  source = CARD_RECEIVER_WGSL,
) {
  const match = /fn cardLightSegment\([\s\S]*?\)\s*->CardLightSegment\s*\{/.exec(source);
  if (!match || source.indexOf('fn cardLightSegment(', match.index + 1) >= 0)
    throw Error('Single actual segment producer required');
  const start = match.index + match[0].length;
  let end = start,
    depth = 1;
  while (end < source.length && depth) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw Error('Closed producer required');
  const zeroRay = () => ({
    originLo: vector(0, 0, 0),
    originHi: vector(0, 0, 0),
    directionLo: vector(0, 0, 0),
    directionHi: vector(0, 0, 0),
    tRange: vector(0, 0),
    valid: 0,
  });
  const valid = (v: CanonicalPoint) =>
    v.axis.length === 3 &&
    v.axis.every((x) => x.valid === 1 && usable(bits(x.lo)) && usable(bits(x.hi)) && x.lo <= x.hi);
  const deps = {
    makeSegment: () => ({ world: zeroRay(), state: 0 }),
    makeVector: () => ({ axis: Array.from({ length: 3 }, () => ({ lo: 0, hi: 0, valid: 0 })) }),
    zeroRay,
    bits,
    bitsVector: (v: readonly number[]) => vector(...v.map(bits)),
    vec2f: vector,
    u32: Math.trunc,
    sdfIntervalVector: (lo: number[], hi: number[]) => ({
      axis: lo.map((word, i) => ({
        lo: number(word),
        hi: number(hi[i] ?? 0),
        valid: Number(usable(word) && usable(hi[i] ?? 0)),
      })),
    }),
    sdfIntervalVectorValid: valid,
    sdfIntervalVectorSubtract: subtract,
    sdfSurfaceBitsUsable: usable,
    sdfSurfaceRayUsable: (ray: ReturnType<typeof zeroRay>) =>
      ray.valid === 1 &&
      [ray.originLo, ray.originHi, ray.directionLo, ray.directionHi, ray.tRange].every((v) =>
        v.every(usable),
      ) &&
      ray.originLo.every((word, i) => number(word) <= number(ray.originHi[i] ?? 0)) &&
      ray.directionLo.every((word, i) => number(word) <= number(ray.directionHi[i] ?? 0)) &&
      ray.directionLo.some(
        (word, i) => number(word) !== 0 || number(ray.directionHi[i] ?? 0) !== 0,
      ) &&
      number(ray.tRange[0] ?? 0) <= number(ray.tRange[1] ?? 0),
    CardLightSegment: (world: ReturnType<typeof zeroRay>, state: number) => ({ world, state }),
  };
  const body = source
    .slice(start, end - 1)
    .replace(/var none:CardLightSegment;/g, 'let none=makeSegment();')
    .replace(/var direction:SdfIntervalVector;/g, 'let direction=makeVector();')
    .replace(/var world:SdfSurfaceRay;/g, 'let world=zeroRay();')
    .replace(/bitcast<vec[23]u>\(/g, 'bitsVector(')
    .replace(/bitcast<u32>\(/g, 'bits(')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1');
  const names = Object.keys(deps);
  const run = new Function(...names, `return function(receiver,light,incoming,limit){${body}}`)(
    ...Object.values(deps),
  );
  const p = Object.assign(vector(...light, kind), { xyz: vector(...light) });
  return run({ point, valid: 1 }, { positionKind: p }, vector(...incoming), limit) as {
    world: ReturnType<typeof zeroRay>;
    state: number;
  };
}

export const rayNumbers = (world: ReturnType<typeof executeCardLightSegment>['world']) => ({
  originLo: world.originLo.map(number),
  originHi: world.originHi.map(number),
  directionLo: world.directionLo.map(number),
  directionHi: world.directionHi.map(number),
  range: world.tRange.map(number),
});
