import { SDF_SURFACE_TRACE_WGSL } from '../sdf-surface-trace-wgsl';

/** state, row, primitive, facing, lower, upper, uncertain, sidedness, samples, presence. */
export type SurfaceAcceptTuple = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
interface SurfaceAcceptCase {
  readonly name: string;
  readonly best: SurfaceAcceptTuple;
  readonly hit: SurfaceAcceptTuple;
  readonly expected: SurfaceAcceptTuple;
}
const BEST: SurfaceAcceptTuple = [1, 17, 41, 1, 4, 6, 12, 1, 1, 1];
const HIT: SurfaceAcceptTuple = [1, 99, 42, 0, 2, 3, 15, 0, 0, 0];
/** Authored branch and payload oracle; no geometry or interval math is mocked. */
export function surfaceAcceptCases(): readonly SurfaceAcceptCase[] {
  return [
    {
      name: 'earlier-replacement-keeps-blocker',
      best: BEST,
      hit: HIT,
      expected: [1, 99, 42, 0, 2, 3, 12, 0, 0, 1],
    },
    {
      name: 'empty-selects-later-hit',
      best: [0, 17, 41, 1, 4, 6, 12, 1, 1, 0],
      hit: [1, 99, 42, 0, 7, 8, 15, 0, 0, 0],
      expected: [1, 99, 42, 0, 7, 8, 12, 0, 0, 0],
    },
    {
      name: 'unknown-only-lowers-blocker',
      best: BEST,
      hit: [2, 99, 42, 0, 1, 3, 15, 0, 0, 0],
      expected: [1, 17, 41, 1, 4, 6, 1, 1, 1, 1],
    },
    {
      name: 'clear-is-no-write',
      best: BEST,
      hit: [0, 99, 42, 0, 2, 3, 15, 0, 0, 0],
      expected: BEST,
    },
    {
      name: 'nonhit-state-is-no-write',
      best: BEST,
      hit: [3, 99, 42, 0, 2, 3, 15, 0, 0, 0],
      expected: BEST,
    },
    {
      name: 'strictly-later-is-no-write',
      best: BEST,
      hit: [1, 99, 42, 0, 7, 8, 15, 0, 0, 0],
      expected: BEST,
    },
    {
      name: 'equal-earlier-bound-is-not-replacement',
      best: BEST,
      hit: [1, 99, 42, 0, 2, 4, 15, 0, 0, 0],
      expected: [1, 17, 41, 1, 2, 4, 2, 1, 1, 1],
    },
    {
      name: 'equal-later-bound-is-overlap',
      best: BEST,
      hit: [1, 99, 42, 0, 6, 8, 15, 0, 0, 0],
      expected: [1, 17, 41, 1, 4, 6, 4, 1, 1, 1],
    },
    {
      name: 'same-primitive-narrows-without-new-blocker',
      best: BEST,
      hit: [1, 99, 41, 0, 3, 5, 15, 0, 0, 0],
      expected: [1, 17, 41, 1, 3, 5, 12, 1, 1, 1],
    },
    {
      name: 'different-primitive-overlap-keeps-identity',
      best: BEST,
      hit: [1, 99, 42, 0, 3, 5, 15, 0, 0, 0],
      expected: [1, 17, 41, 1, 3, 5, 3, 1, 1, 1],
    },
    {
      name: 'prior-unknown-survives-nearer-hit',
      best: [1, 17, 41, 1, 4, 6, 0.5, 1, 1, 1],
      hit: HIT,
      expected: [1, 99, 42, 0, 2, 3, 0.5, 0, 0, 1],
    },
    {
      name: 'unused-negative-zero-is-preserved',
      best: [1, 17, 41, 1, -0, 6, 12, 1, 1, 1],
      hit: [0, 99, 42, 0, 2, 3, 15, 0, 0, 0],
      expected: [1, 17, 41, 1, -0, 6, 12, 1, 1, 1],
    },
    {
      name: 'replacement-negative-zero-is-preserved',
      best: [0, 17, 41, 1, 4, 6, 12, 1, 1, 0],
      hit: [1, 99, 42, 0, -0, 2, 15, 0, 0, 0],
      expected: [1, 99, 42, 0, -0, 2, 12, 0, 0, 0],
    },
    {
      name: 'minimum-normal-unknown-lower',
      best: BEST,
      hit: [2, 99, 42, 0, 2 ** -126, 3, 15, 0, 0, 0],
      expected: [1, 17, 41, 1, 4, 6, 2 ** -126, 1, 1, 1],
    },
    {
      name: 'partial-unknown-does-not-copy-payload',
      best: BEST,
      hit: [2, 0, 0xffffffff, 0, 2.5, 0, 0, 0, 0, 0],
      expected: [1, 17, 41, 1, 4, 6, 2.5, 1, 1, 1],
    },
    {
      name: 'equal-certified-points-keep-lower-primitive',
      best: [1, 17, 41, 1, 4, 4, 12, 1, 1, 1],
      hit: [1, 99, 42, 0, 4, 4, 15, 0, 0, 0],
      expected: [1, 17, 41, 1, 4, 4, 12, 1, 1, 1],
    },
    {
      name: 'equal-certified-points-select-lower-primitive',
      best: [1, 17, 42, 0, 4, 4, 12, 1, 1, 1],
      hit: [1, 99, 41, 1, 4, 4, 15, 0, 0, 0],
      expected: [1, 99, 41, 1, 4, 4, 12, 0, 0, 1],
    },
    {
      name: 'equal-point-selection-preserves-prior-unknown',
      best: [1, 17, 42, 0, 4, 4, 2, 1, 1, 1],
      hit: [1, 99, 41, 1, 4, 4, 15, 0, 0, 0],
      expected: [1, 99, 41, 1, 4, 4, 2, 0, 0, 1],
    },
    {
      name: 'wide-hit-beside-point-is-not-an-exact-tie',
      best: [1, 17, 42, 0, 4, 4, 12, 1, 1, 1],
      hit: [1, 99, 41, 1, 4, 6, 15, 0, 0, 0],
      expected: [1, 17, 42, 0, 4, 4, 4, 1, 1, 1],
    },
    {
      name: 'wide-best-beside-point-is-not-an-exact-tie',
      best: [1, 17, 42, 0, 4, 6, 12, 1, 1, 1],
      hit: [1, 99, 41, 1, 4, 4, 15, 0, 0, 0],
      expected: [1, 17, 42, 0, 4, 4, 4, 1, 1, 1],
    },
    {
      name: 'exact-point-selection-preserves-signed-zero',
      best: [1, 17, 42, 0, 0, 0, 12, 1, 1, 1],
      hit: [1, 99, 41, 1, -0, -0, 15, 0, 0, 0],
      expected: [1, 99, 41, 1, -0, -0, 12, 0, 0, 1],
    },
  ];
}

export function surfaceAcceptWords(tuple: SurfaceAcceptTuple): Uint32Array {
  const words = new Uint32Array(12);
  const floats = new Float32Array(words.buffer);
  tuple.forEach((value, lane) => {
    if (lane >= 4 && lane <= 6) floats[lane] = value;
    else words[lane] = value;
  });
  return words;
}
export function surfaceAcceptMismatches(actual: Uint32Array, expected: Uint32Array): number[] {
  if (actual.length !== expected.length) throw Error('Surface tuple spans differ');
  return Array.from(actual.keys()).filter((lane) => actual[lane] !== expected[lane]);
}

const source = SDF_SURFACE_TRACE_WGSL;
const declaration = source.slice(
  source.indexOf('struct SdfSurfaceTrace {'),
  source.indexOf('fn sdfSurfaceTraceEmpty'),
);
export const surfaceAcceptSource = source.slice(
  source.indexOf('fn sdfSurfaceAccept('),
  source.indexOf('fn sdfSurfaceTraceRow('),
);
/** A direct call to the real helper, without the BVH or a second math authority. */
export const surfaceAcceptKernel = `${declaration}${surfaceAcceptSource}
@group(0) @binding(0) var<storage,read> input:array<vec4u>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4u>;
fn acceptTuple(first:u32)->SdfSurfaceTrace {
 let a=input[first];let b=input[first+1u];let c=input[first+2u];
 return SdfSurfaceTrace(a.x,a.y,a.z,a.w,bitcast<f32>(b.x),bitcast<f32>(b.y),bitcast<f32>(b.z),b.w,c.x,c.y);
}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
 let first=id.x*6u;if(first+5u>=arrayLength(&input)){return;}
 var best=acceptTuple(first);let hit=acceptTuple(first+3u);
 sdfSurfaceAccept(&best,hit);
 output[id.x*3u]=vec4u(best.state,best.row,best.primitive,best.frontFace);
 output[id.x*3u+1u]=vec4u(bitcast<u32>(best.lower),bitcast<u32>(best.upper),bitcast<u32>(best.uncertain),best.reserved);
 output[id.x*3u+2u]=vec4u(best.prefixSamples,best.hasUncertainty,0u,0u);
}`;

const tupleFields = [
  'state',
  'row',
  'primitive',
  'frontFace',
  'lower',
  'upper',
  'uncertain',
  'reserved',
  'prefixSamples',
  'hasUncertainty',
] as const;
function tupleValueFits(value: number, lane: number) {
  if (lane >= 4 && lane <= 6)
    return (
      Number.isFinite(value) &&
      Object.is(value, Math.fround(value)) &&
      (value === 0 || Math.abs(value) >= 2 ** -126)
    );
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
function checkedTuple(tuple: readonly number[]): SurfaceAcceptTuple {
  if (tuple.length !== 10 || !tuple.every(tupleValueFits))
    throw Error('Only normal-or-zero f32 and u32 tuple words are supported');
  return tuple as unknown as SurfaceAcceptTuple;
}
function tupleRecord(tuple: SurfaceAcceptTuple): Record<string, number> {
  checkedTuple(tuple);
  return Object.fromEntries(
    tupleFields.map((field, index) => {
      const value = tuple[index];
      if (value === undefined) throw Error('Missing tuple field');
      return [field, value];
    }),
  );
}
function restrictedBody(text: string) {
  if (
    !text.startsWith(
      'fn sdfSurfaceAccept(best:ptr<function,SdfSurfaceTrace>,hit:SdfSurfaceTrace) {',
    )
  )
    throw Error('Unsupported surface accumulator signature');
  const body = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}')).replace(/\/\/[^\n]*/g, '');
  const allowed = new Set([...tupleFields, 'best', 'hit', 'if', 'let', 'return', 'min', 'false']);
  for (const token of body.matchAll(/\b[A-Za-z_]\w*\b/g))
    if (!allowed.has(token[0])) throw Error('Unsupported accumulator token');
  for (const literal of body.matchAll(/\b\d[\w.]*/g))
    if (!['0u', '1u', '2u'].includes(literal[0])) throw Error('Unsupported accumulator literal');
  for (const call of body.matchAll(/\b(\w+)\s*\(/g))
    if (call[1] !== 'if' && call[1] !== 'min') throw Error('Unsupported accumulator call');
  for (const returned of body.matchAll(/\breturn([^;]*);/g))
    if (returned[1]?.trim()) throw Error('Only void returns are supported');
  if (
    /[^\s\w().,;{}=!<>|*]/.test(body) ||
    /<<|>>/.test(body) ||
    body.replaceAll('||', '').includes('|')
  )
    throw Error('Unsupported accumulator operation');
  return body;
}

/** Closed, copy/comparison/min-only source evaluation for maintained CPU tests.
 * It is not a WGSL interpreter or a GPU result; unsupported syntax fails closed.
 * Input floats are already normal-or-zero f32, so comparisons/min introduce no
 * additional rounding. The actual current function, not a hand-copied model,
 * supplies every branch and write. */
export function createSurfaceAcceptEvaluator(text = surfaceAcceptSource) {
  const body = restrictedBody(text)
    .replaceAll('(*best).', 'best.')
    .replaceAll('*best=hit;', 'copy(best,hit);')
    .replaceAll(/\b(\d+)u\b/g, '$1');
  if (body.includes('*')) throw Error('Unsupported accumulator dereference');
  const invoke = new Function('best', 'hit', 'min', 'copy', body) as (
    best: Record<string, number>,
    hit: Readonly<Record<string, number>>,
    minimum: typeof Math.min,
    copy: typeof Object.assign,
  ) => void;
  return (best: SurfaceAcceptTuple, hit: SurfaceAcceptTuple): SurfaceAcceptTuple => {
    const value = tupleRecord(best);
    invoke(value, Object.freeze(tupleRecord(hit)), Math.min, Object.assign);
    return checkedTuple(
      tupleFields.map((field) => {
        const component = value[field];
        if (component === undefined) throw Error('Missing tuple field');
        return component;
      }),
    );
  };
}

/** These are deliberately wrong versions of the executed function itself. */
export function surfaceAcceptMutants() {
  const header = surfaceAcceptSource.slice(0, surfaceAcceptSource.indexOf('{') + 2);
  const changes = [
    [
      'drop-old-blocker',
      '*best=hit;(*best).uncertain=uncertain;(*best).hasUncertainty=hasUncertainty;return;',
      '*best=hit;(*best).hasUncertainty=hasUncertainty;return;',
    ],
    [
      'drop-old-presence',
      '*best=hit;(*best).uncertain=uncertain;(*best).hasUncertainty=hasUncertainty;return;',
      '*best=hit;(*best).uncertain=uncertain;return;',
    ],
    ['loose-earlier-tie', 'hit.upper<(*best).lower', 'hit.upper<=(*best).lower'],
    ['omit-primitive-ambiguity', 'if(hit.primitive!=(*best).primitive)', 'if(false)'],
    ['overwrite-owner-fields', header, `${header} (*best).row=0u;(*best).prefixSamples=0u;\n`],
    ['drop-exact-point-ties', 'if(hit.lower==hit.upper){', 'if(false){'],
    ['accept-wide-hit-as-point', 'if(hit.lower==hit.upper){', 'if(1u==1u){'],
  ] as const;
  return changes.map(([name, before, after]) => {
    if (surfaceAcceptSource.split(before).length !== 2) throw Error('Mutant target is not unique');
    return { name, source: surfaceAcceptSource.replace(before, after) };
  });
}
