import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { SDF_SURFACE_CANDIDATES_WGSL } from '../../../../shader/src/sdf-surface-candidates-wgsl';
import { SDF_SURFACE_TRACE_WGSL } from '../../../../shader/src/sdf-surface-trace-wgsl';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { SDF_INSTANCE_WGSL } from '../../raytracing/sdf-instance-wgsl';
import type { SdfMeshInstance } from '../../raytracing/sdf-query';
import type { SdfSurfaceCoverage } from '../../raytracing/sdf-surface-coverage';
import { SDF_SCENE_SURFACE_TRACE_WGSL } from '../../raytracing/sdf-surface-trace';
import { endpointFunction } from './sdf-surface-endpoint-aggregation.fixture';

type V3 = readonly [number, number, number];
type Composition = Extract<ReturnType<typeof packGlobalSdfComposition>, { ok: true }>['value'];
interface CoverageCase {
  readonly name: string;
  readonly composition: Composition;
  readonly fieldWords: number;
  readonly origin: V3;
  readonly state: 0 | 1 | 2 | 3;
  readonly row: number;
  readonly primitive?: number;
  readonly expectedWords: readonly [number, number] | undefined;
  readonly budget: number;
  readonly expectedEpoch: number;
  readonly ready: boolean;
  readonly last: number;
  readonly frontFace: 0 | 1;
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const grid = {
  origin: [-2, -2, -2] as const,
  dimensions: [5, 5, 5] as const,
  spacing: 1,
  maxDistance: 2,
  coverageDistance: 0.5,
};
const partial = (...words: number[]): SdfSurfaceCoverage => ({
  kind: 'partial',
  opaquePrimitives: Uint32Array.from(words),
});

async function geometry(z: readonly number[], separated = false, reverse = false) {
  const positions = new Float32Array(
    z.flatMap((height, primitive) => {
      const x = separated ? primitive * 4 : 0;
      return reverse
        ? [x - 1, -1, height, x, 1, height, x + 1, -1, height]
        : [x - 1, -1, height, x + 1, -1, height, x, 1, height];
    }),
  );
  const indices = Uint32Array.from({ length: positions.length / 3 }, (_, index) => index);
  return (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: separated ? 2 : 0.5,
      triangleSidedness: new Uint8Array(z.length),
    })
  ).unwrap();
}

export async function preparePartialCoverage() {
  const field = await geometry([1, 2]);
  const reverse = await geometry([2, 1]);
  const equal = await geometry([1, 1]);
  const front = await geometry([1, 2], false, true);
  const wide64 = await geometry(new Array<number>(64).fill(1), true);
  const wide33 = await geometry(new Array<number>(33).fill(1), true);
  const compose = (
    geometry: typeof field,
    coverages: readonly SdfSurfaceCoverage[],
    masks: readonly number[] = [],
  ) => {
    const source: SdfMeshInstance[] = coverages.map((surfaceCoverage, row) => {
      const transform = [...identity];
      transform[12] = row * 4;
      return {
        instanceId: row + 1,
        geometryId: 0,
        mask: masks[row] ?? 255,
        transform,
        field: geometry,
        surfaceCoverage,
      };
    });
    const composition = packGlobalSdfComposition(source, grid, {
      capacity: source.length,
      index: false,
      sourceEpoch: 1,
    }).unwrap();
    if (!(composition.data.fields instanceof Uint8Array))
      throw Error('The real Global byte container must be exercised');
    return composition;
  };
  const cases: CoverageCase[] = [];
  const add = (
    name: string,
    composition: CoverageCase['composition'],
    state: CoverageCase['state'],
    options: Partial<
      Pick<
        CoverageCase,
        | 'origin'
        | 'row'
        | 'primitive'
        | 'expectedWords'
        | 'budget'
        | 'expectedEpoch'
        | 'ready'
        | 'last'
        | 'frontFace'
      >
    > = {},
  ) => {
    cases.push({
      name,
      composition,
      fieldWords: composition.data.fields.byteLength / 4,
      origin: [0, 0, 0],
      state,
      row: 0,
      expectedWords: undefined,
      budget: 256,
      expectedEpoch: 1,
      ready: true,
      last: 4,
      frontFace: 0,
      ...options,
    });
  };
  add('opaque-near', compose(field, ['opaque']), 1, { primitive: 0 });
  add('opaque-front-facing', compose(front, ['opaque']), 1, { primitive: 0, frontFace: 1 });
  add('unknown-before-opaque', compose(field, [partial(2)]), 2, { expectedWords: [2, 0] });
  add('opaque-before-unknown', compose(field, [partial(1)]), 1, {
    primitive: 0,
    expectedWords: [1, 0],
  });
  add('unknown-at-equal-time', compose(equal, [partial(1)]), 2, { expectedWords: [1, 0] });
  add('unknown-at-closed-end', compose(field, [partial(2)]), 2, { expectedWords: [2, 0], last: 1 });
  add('opaque-at-closed-end', compose(field, [partial(1)]), 1, {
    expectedWords: [1, 0],
    primitive: 0,
    last: 1,
  });
  add('unknown-hit', compose(field, ['unknown']), 2);
  add('unknown-miss', compose(field, ['unknown']), 0, { origin: [3, 0, 0] });
  add('partial-miss', compose(field, [partial(1)]), 0, {
    origin: [3, 0, 0],
    expectedWords: [1, 0],
  });
  add('unqualified-geometry-is-not-a-miss', compose(field, ['unavailable']), 2, { ready: false });
  add('closer-unknown-after-known-primitive', compose(reverse, [partial(1)]), 2, {
    expectedWords: [1, 0],
  });
  add('closer-opaque-after-unknown-primitive', compose(reverse, [partial(2)]), 1, {
    primitive: 1,
    expectedWords: [2, 0],
  });
  const placements = compose(field, [partial(2), 'opaque']);
  add('placement-unknown', placements, 2, { expectedWords: [2, 0] });
  add('placement-opaque', placements, 1, { row: 1, origin: [4, 0, 0], primitive: 0 });
  add(
    'tombstone-unavailable-is-not-selected',
    compose(field, ['unavailable', 'opaque'], [0, 255]),
    1,
    { row: 1, origin: [4, 0, 0], primitive: 0 },
  );
  add('stale-expected-epoch', compose(field, [partial(1)]), 2, {
    expectedEpoch: 2,
    ready: false,
    expectedWords: [1, 0],
  });
  add('zero-original-budget', compose(field, [partial(1)]), 3, {
    budget: 0,
    expectedWords: [1, 0],
  });
  add('insufficient-original-budget', compose(field, [partial(1)]), 3, {
    budget: 1,
    expectedWords: [1, 0],
  });
  for (const [name, change] of [
    [
      'missing-coverage',
      (words: Uint32Array, _record: number) => {
        words[7] = 0;
      },
    ],
    [
      'wrong-coverage-owner',
      (words: Uint32Array, record: number) => {
        words[record] = 1;
      },
    ],
    [
      'bad-coverage-mode',
      (words: Uint32Array, record: number) => {
        words[record + 2] = 3;
      },
    ],
    [
      'missing-partial-words',
      (words: Uint32Array, record: number) => {
        words[(words[record + 3] ?? 0) + 2] = 0;
      },
    ],
    [
      'bad-partial-tail',
      (words: Uint32Array, record: number) => {
        words[(words[record + 3] ?? 0) + 4] = 5;
      },
    ],
  ] as const) {
    const broken = compose(field, [partial(1)]);
    const words = new Uint32Array(
      broken.data.fields.buffer,
      broken.data.fields.byteOffset,
      broken.data.fields.byteLength / 4,
    );
    change(words, words[7] ?? 0);
    add(name, broken, 2, { ready: false });
  }
  const allWords = compose(wide64, [partial(0xffffffff, 0x80000000)]);
  for (const [primitive, state] of [
    [31, 1],
    [32, 2],
    [63, 1],
  ] as const)
    add(`uint64-primitive-${primitive}`, allWords, state, {
      origin: [primitive * 4, 0, 0],
      primitive,
      expectedWords: [0xffffffff, 0x80000000],
    });
  const crossing = compose(wide33, [partial(0x80000000, 1)]);
  for (const [primitive, state] of [
    [30, 2],
    [31, 1],
    [32, 1],
  ] as const)
    add(`uint33-primitive-${primitive}`, crossing, state, {
      origin: [primitive * 4, 0, 0],
      primitive,
      expectedWords: [0x80000000, 1],
    });
  const tail = compose(wide33, [partial(0x80000000, 1)]);
  const tailWords = new Uint32Array(
    tail.data.fields.buffer,
    tail.data.fields.byteOffset,
    tail.data.fields.byteLength / 4,
  );
  tailWords[(tailWords[(tailWords[7] ?? 0) + 3] ?? 0) + 5] = 3;
  add('uint33-unused-tail', tail, 2, { origin: [128, 0, 0], ready: false });

  let next = 4 + cases.length * 32;
  const total =
    next +
    cases.reduce(
      (sum, entry) =>
        sum +
        entry.composition.data.instances.byteLength / 4 +
        entry.composition.data.fields.byteLength / 4,
      0,
    );
  const input = new Uint32Array(total),
    floats = new Float32Array(input.buffer);
  input[0] = cases.length;
  cases.forEach((entry, index) => {
    const data = entry.composition.data,
      at = 4 + index * 32;
    const instances = new Uint32Array(
      data.instances.buffer,
      data.instances.byteOffset,
      data.instances.length / 4,
    );
    // The real Global owner carries Uint8Array bytes. Read those same bits as
    // u32 without boxing arbitrary coverage words as JS float values.
    const fields = new Uint32Array(
      data.fields.buffer,
      data.fields.byteOffset,
      data.fields.byteLength / 4,
    );
    input.set(
      [
        next,
        instances.length,
        next + instances.length,
        fields.length,
        entry.composition.sources.length,
        255,
        entry.budget,
        entry.row,
      ],
      at,
    );
    floats.set([...entry.origin, 0, 0, 0, 1, entry.last], at + 8);
    const actual = entry.composition.sourceExpected;
    if (actual === undefined) throw Error('Independent accepted source facts required');
    input.set(actual, at + 16);
    input.set([actual[0], actual[1], actual[2], entry.expectedEpoch], at + 20);
    input.set(instances, next);
    next += instances.length;
    input.set(fields, next);
    next += fields.length;
  });
  return { cases, input: new Uint8Array(input.buffer), code: partialCoverageKernel };
}

const functions = [
  ...['sdfInstanceMask', 'sdfInstanceFloatUsable', 'sdfInstanceValid'].map((name) =>
    endpointFunction(SDF_INSTANCE_WGSL, name),
  ),
  ...['sdfSceneSurfaceReady', 'sdfSceneSurfaceTraceRows'].map((name) =>
    endpointFunction(SDF_SCENE_SURFACE_TRACE_WGSL, name),
  ),
].join('\n');
export const partialCoverageKernel = `${SDF_SURFACE_TRACE_WGSL}
${SDF_SURFACE_CANDIDATES_WGSL}
@group(0) @binding(0) var<storage,read> inputWords:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputWords:array<vec4u>;
var<private> spans:vec4u;
fn sdfFieldWordCount()->u32{return spans.w;}
fn sdfFieldWord(index:u32)->u32{if(index>=spans.w){return 0u;}return inputWords[spans.z+index];}
fn sdfInstanceRowCount()->u32{return spans.y/36u;}
fn sdfInstanceWord(row:u32,word:u32)->u32{if(row>=sdfInstanceRowCount() || word>=36u){return 0u;}return inputWords[spans.x+row*36u+word];}
struct Ray { origin:vec3f,tMin:f32,direction:vec3f,tMax:f32,mask:vec4u }
${functions}
@compute @workgroup_size(1) fn verifyCoverage(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=inputWords[0]){return;}let at=4u+id.x*32u;
 spans=vec4u(inputWords[at],inputWords[at+1u],inputWords[at+2u],inputWords[at+3u]);
 let count=inputWords[at+4u];let mask=inputWords[at+5u];var remaining=inputWords[at+6u];let row=inputWords[at+7u];
 let origin=bitcast<vec3f>(vec3u(inputWords[at+8u],inputWords[at+9u],inputWords[at+10u]));
 let direction=bitcast<vec3f>(vec3u(inputWords[at+12u],inputWords[at+13u],inputWords[at+14u]));
 let range=vec2u(inputWords[at+11u],inputWords[at+15u]);
 let actual=vec4u(inputWords[at+16u],inputWords[at+17u],inputWords[at+18u],inputWords[at+19u]);
 let expected=vec4u(inputWords[at+20u],inputWords[at+21u],inputWords[at+22u],inputWords[at+23u]);
 let world=SdfSurfaceRay(bitcast<vec3u>(origin),bitcast<vec3u>(origin),bitcast<vec3u>(direction),bitcast<vec3u>(direction),range,1u);
 var candidates=sdfSurfaceSceneCandidates(world,count,mask,actual,expected);
 let ready=sdfSceneSurfaceReady(count,mask) && candidates.state!=2u;
 var hit=sdfSurfaceTraceEmpty(bitcast<f32>(range.y));
 if(ready){hit=sdfSceneSurfaceTraceRows(Ray(origin,bitcast<f32>(range.x),direction,bitcast<f32>(range.y),vec4u(mask,0u,0u,0u)),count,&remaining,&candidates);}
 else{hit.state=2u;hit.lower=bitcast<f32>(range.x);}
 let packet=sdfSurfacePacket(row);var words=vec2u(0u);
 if(packet.valid==1u && packet.coverage.x==2u){words.x=sdfFieldWord(packet.coverage.y);if(packet.triangles.y>32u){words.y=sdfFieldWord(packet.coverage.y+1u);}}
 outputWords[id.x*4u]=vec4u(hit.state,hit.row,hit.primitive,hit.frontFace);
 outputWords[id.x*4u+1u]=vec4u(bitcast<u32>(hit.lower),bitcast<u32>(hit.upper),remaining,select(0u,1u,ready));
 outputWords[id.x*4u+2u]=vec4u(packet.valid,packet.coverage.x,words);
 outputWords[id.x*4u+3u]=vec4u(sdfFieldWordCount(),actual.w,expected.w,candidates.nodeVisits);
}`;

export function assessPartialCoverage(
  cases: readonly Omit<CoverageCase, 'composition'>[],
  raw: Uint32Array,
): string[] {
  if (raw.length !== cases.length * 16) throw Error('Complete coverage GPU records required');
  const failures: string[] = [],
    floats = new Float32Array(raw.buffer, raw.byteOffset, raw.length);
  cases.forEach((entry, index) => {
    const at = index * 16;
    const fail = (message: string) => failures.push(`${entry.name}: ${message}`);
    if (raw[at] !== entry.state) fail(`state ${raw[at]} expected ${entry.state}`);
    if (raw[at + 7] !== Number(entry.ready)) fail('source readiness');
    if (
      raw[at + 12] !== entry.fieldWords ||
      raw[at + 13] !== 1 ||
      raw[at + 14] !== entry.expectedEpoch
    )
      fail('source window/epoch echo');
    if ((raw[at + 6] ?? Infinity) > entry.budget) fail('remaining exceeds original budget');
    if (entry.state === 1) assessCoverageHit(entry, raw, floats, at, fail);
    if (
      entry.expectedWords !== undefined &&
      (raw[at + 10] !== entry.expectedWords[0] || raw[at + 11] !== entry.expectedWords[1])
    )
      fail('raw u32 coverage transport');
  });
  return failures;
}

function assessCoverageHit(
  entry: Omit<CoverageCase, 'composition'>,
  raw: Uint32Array,
  floats: Float32Array,
  at: number,
  fail: (message: string) => void,
) {
  if (raw[at + 1] !== entry.row || raw[at + 2] !== entry.primitive)
    fail('canonical row/primitive identity');
  if (raw[at + 3] !== entry.frontFace) fail('canonical front/back face');
  if (
    !(
      Number.isFinite(floats[at + 4]) &&
      Number.isFinite(floats[at + 5]) &&
      (floats[at + 4] ?? Infinity) <= 1 &&
      (floats[at + 5] ?? -Infinity) >= 1
    )
  )
    fail('interval does not enclose the independent dyadic plane t=1');
}
