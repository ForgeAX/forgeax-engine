import { SDF_SURFACE_SEGMENT_BOX_CLEAR_WGSL } from '../sdf-surface-root-request-wgsl';

interface Interval {
  lo: number;
  hi: number;
  valid: number;
}
interface Vector {
  axis: Interval[];
}
export interface SegmentRay {
  originLo: number[];
  originHi: number[];
  directionLo: number[];
  directionHi: number[];
  tRange: { x: number; y: number };
  valid: number;
}

// Source3a's original binding-free predicate, retained as the control oracle.
// Both controls use the same independent small-dyadic interval dependencies;
// this checks control/data reuse, not WGSL rounding or GPU equivalence.
const original = `fn original(ray:SdfSurfaceRay,lo:vec3u,hi:vec3u) -> bool {
 let origin=sdfIntervalVector(ray.originLo,ray.originHi);
 let direction=sdfIntervalVector(ray.directionLo,ray.directionHi);
 let bounds=sdfIntervalVector(lo,hi);let time=sdfIntervalRaw(ray.tRange.x,ray.tRange.y);
 if(!sdfIntervalVectorValid(origin) || !sdfIntervalVectorValid(direction) || !sdfIntervalVectorValid(bounds) || time.valid==0u){return false;}
 for(var axis=0u;axis<3u;axis++){
  let position=sdfIntervalAdd(origin.axis[axis],sdfIntervalMultiply(direction.axis[axis],time));
  if(position.valid!=0u && (position.hi<bounds.axis[axis].lo || position.lo>bounds.axis[axis].hi)){return true;}
 }
 return false;
}`;

export const segmentBits = (value: number) =>
  new Uint32Array(Float32Array.of(value).buffer)[0] ?? 0;
const number = (bits: number) => new Float32Array(Uint32Array.of(bits).buffer)[0] ?? 0;
const invalid = (): Interval => ({ lo: 0, hi: 0, valid: 0 });
const usable = (bits: number) => {
  const magnitude = bits & 0x7fffffff;
  return magnitude === 0 || (magnitude >= 0x00800000 && magnitude <= 0x7f7fffff);
};
function raw(lo: number, hi: number): Interval {
  return usable(lo) && usable(hi) && number(lo) <= number(hi)
    ? { lo: number(lo), hi: number(hi), valid: 1 }
    : invalid();
}
function body(source: string, name: string): string {
  const at = source.indexOf(`fn ${name}(`);
  if (at < 0) throw Error(`Missing production function ${name}`);
  const start = source.indexOf('{', at);
  let end = start + 1;
  let depth = 1;
  while (depth !== 0 && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth !== 0) throw Error('Unclosed production function');
  return source.slice(start + 1, end - 1);
}

export function segmentRay(origin = [0, 0, 0], direction = [1, 0, 0]): SegmentRay {
  return {
    originLo: origin.map(segmentBits),
    originHi: origin.map(segmentBits),
    directionLo: direction.map(segmentBits),
    directionHi: direction.map(segmentBits),
    tRange: { x: segmentBits(0), y: segmentBits(2) },
    valid: 1,
  };
}

export function segmentControl(source = SDF_SURFACE_SEGMENT_BOX_CLEAR_WGSL) {
  const operations = { multiply: 0, add: 0 };
  const vector = (lo: number[], hi: number[]): Vector => ({
    axis: lo.map((value, axis) => raw(value, hi[axis] ?? 0x7f800000)),
  });
  const rounded = (lo: number, hi: number) => raw(segmentBits(lo), segmentBits(hi));
  const deps: Record<string, unknown> = {
    empty: (): Vector => ({ axis: [invalid(), invalid(), invalid()] }),
    sdfIntervalRaw: raw,
    sdfIntervalVector: vector,
    sdfIntervalVectorValid: (value: Vector) => value.axis.every((axis) => axis.valid !== 0),
    sdfIntervalMultiply: (a: Interval, b: Interval) => {
      operations.multiply++;
      if (!a.valid || !b.valid) return invalid();
      const values = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
      return rounded(Math.min(...values), Math.max(...values));
    },
    sdfIntervalAdd: (a: Interval, b: Interval) => {
      operations.add++;
      return a.valid && b.valid ? rounded(a.lo + b.lo, a.hi + b.hi) : invalid();
    },
  };
  function execute<T>(text: string, name: string, args: string): T {
    const lowered = body(text, name)
      .replace(/var segment:SdfIntervalVector;/g, 'var segment=empty();')
      .replace(/\(\*segment\)/g, 'segment')
      .replace(/&segment/g, 'segment')
      .replace(/\b(\d+)u\b/g, '$1')
      .replace(/\blet\b/g, 'const');
    return Function(
      ...Object.keys(deps),
      `return function(${args}){${lowered}}`,
    )(...Object.values(deps)) as T;
  }
  type Prepare = (ray: SegmentRay) => Vector;
  type Clear = (segment: Vector, lo: number[], hi: number[]) => boolean;
  type Wrapper = (ray: SegmentRay, lo: number[], hi: number[]) => boolean;
  const prepare = execute<Prepare>(source, 'sdfSurfaceSegmentEnclosure', 'ray');
  deps.sdfSurfaceSegmentEnclosure = prepare;
  const clear = execute<Clear>(source, 'sdfSurfaceSegmentBoundsClear', 'segment,lo,hi');
  deps.sdfSurfaceSegmentBoundsClear = clear;
  return {
    prepare,
    clear,
    wrapper: execute<Wrapper>(source, 'sdfSurfaceSegmentBoxClear', 'ray,lo,hi'),
    original: execute<Wrapper>(original, 'original', 'ray,lo,hi'),
    operations,
  };
}
