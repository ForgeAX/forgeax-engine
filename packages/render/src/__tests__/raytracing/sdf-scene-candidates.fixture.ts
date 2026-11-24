import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import {
  SDF_INSTANCE_WORD_GUARDS_WGSL,
  SDF_SURFACE_CANDIDATES_WGSL,
  SDF_SURFACE_POOL_WGSL,
} from '@forgeax/engine-shader';
import { packSdfScene } from '../../raytracing/sdf-query';
import {
  appendSdfSceneCandidates,
  readSdfSceneCandidateDirectory,
} from '../../raytracing/sdf-scene-candidates';
import type { SdfPlacementBounds } from '../../raytracing/sdf-transform-certificate';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import {
  authoredMissingBounds,
  type PlacementRay,
  segmentIntersectsBox,
} from './sdf-placement-bounds.fixture';

export interface SceneCandidateCase {
  readonly name: string;
  readonly fields: Uint32Array;
  readonly instances: Uint32Array;
  readonly expected: Uint32Array;
  readonly actual: Uint32Array;
  readonly bounds: readonly (SdfPlacementBounds | undefined)[];
  readonly ray: PlacementRay;
  readonly mask: number;
  readonly rowLimit: number;
  readonly state: 0 | 1 | 2;
  readonly associated: number;
  readonly directory: 0 | 1;
  readonly preflight: boolean;
}
const near: PlacementRay = { origin: [0, 0, 0], direction: [0, 0, 1], first: 0, last: 8 };
const far: PlacementRay = { ...near, origin: [4, 0, 0] };
const clear: PlacementRay = { ...near, origin: [8, 0, 0] };
const pose = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 3, 1];

/** Production geometry/packet/index builders; authored full-roster exact slab
 * below never reads candidate nodes or calls the candidate query implementation. */
export async function sceneCandidateCases(): Promise<SceneCandidateCase[]> {
  const field = (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 0.5,
      triangleSidedness: [1],
    })
  ).unwrap();
  const source = [
    { instanceId: 1, geometryId: 0, mask: 1, transform: pose(0), field },
    {
      instanceId: 2,
      geometryId: 0,
      mask: 2,
      transform: pose(4),
      field: { missing: true as const, bounds: authoredMissingBounds },
    },
  ];
  const base = packSdfScene(source, 64, 4).unwrap();
  const indexed = packSdfScene(source, 64, 4, 7).unwrap();
  const make = (name: string, ray = near, useBase = false): SceneCandidateCase => {
    const data = useBase ? base : indexed;
    const fields = new Uint32Array(data.fields.slice().buffer),
      instances = new Uint32Array(data.instances.slice().buffer);
    // Independent reader facts are captured from the owned producer's source
    // allocations/highwater/epoch, never decoded from the observed Grid tuple.
    const expected = Uint32Array.of(instances.length, fields.length, source.length, 7);
    return {
      name,
      fields,
      instances,
      expected,
      actual: expected.slice(),
      bounds: data.placementBounds,
      ray,
      mask: 3,
      rowLimit: 2,
      state: useBase ? 1 : 0,
      associated: 1,
      directory: 1,
      preflight: false,
    };
  };
  const cases: SceneCandidateCase[] = [
    make('indexed-near'),
    make('retained-missing', far),
    make('indexed-clear', clear),
  ];
  const bounds = indexed.placementBounds[1];
  if (!bounds) throw Error('Authored missing row must retain its certified enclosure');
  cases.push(
    make('closed-end', { ...far, last: bounds.min[2] }),
    make('clear-before-end', { ...far, last: bounds.min[2] - 0.5 }),
  );
  cases.push({ ...make('mask-selects-only-sampled', far), mask: 1 });
  const unknown = make('unknown-enclosure-always-retained', clear);
  const unknownBounds = [indexed.placementBounds[0], undefined];
  const appended = appendSdfSceneCandidates(
    new Uint32Array(base.fields.buffer),
    base.instances,
    unknownBounds,
    7,
  ).unwrap();
  const unknownFields = appended.words.slice();
  const unknownExpected = Uint32Array.of(unknown.instances.length, unknownFields.length, 2, 7);
  cases.push({
    ...unknown,
    fields: unknownFields,
    expected: unknownExpected,
    actual: unknownExpected.slice(),
    bounds: unknownBounds,
  });
  cases.push(make('complete-base-fallback', clear, true));
  const unused = make('highwater-excludes-capacity-garbage');
  unused.instances[3 * 36] = 0x7fc00000;
  cases.push(unused);
  for (const [name, mode] of [
    ['retained-wrong-mode-zero', 0],
    ['retained-wrong-mode-one', 0x3f800000],
  ] as const) {
    const row = make(name);
    row.instances[35] = mode;
    cases.push({ ...row, associated: 0 });
  }
  const address = make('retained-wrong-packet-address');
  address.instances[20] = 24;
  cases.push({ ...address, associated: 0 });
  const invalid = make('selected-invalid-before-cull');
  invalid.instances[36] = 0x7fc00000;
  cases.push({ ...invalid, state: 2, preflight: true });
  const mask = make('selected-invalid-mask-before-cull');
  mask.instances[36 + 19] = 257;
  cases.push({ ...mask, state: 2, preflight: true });
  for (let axis = 0; axis < 4; axis++) {
    const observed = make(`actual-source-word-${axis}`);
    observed.actual[axis] = (observed.actual[axis] ?? 0) + 1;
    cases.push({ ...observed, state: 2, preflight: true });
    const expected = make(`expected-source-word-${axis}`);
    expected.expected[axis] = (expected.expected[axis] ?? 0) + 1;
    cases.push({ ...expected, state: 2, directory: 0, preflight: true });
  }
  const directory = readSdfSceneCandidateDirectory(new Uint32Array(indexed.fields.buffer)).unwrap();
  if (!directory) throw Error('Indexed source required');
  const footer = (new Uint32Array(indexed.fields.buffer)[3] ?? 0) - 8;
  const first = directory.first + 4 * 8;
  for (const [name, at, value, validDirectory] of [
    ['stale-directory-epoch', footer + 6, 6, 0],
    ['stale-directory-highwater', footer + 5, 3, 0],
    ['bad-directory-node-count', footer + 4, 8, 0],
    ['bad-root-escape', first + 7, 0, 1],
    [
      'bad-root-flags',
      first + 3,
      (new Uint32Array(indexed.fields.buffer)[first + 3] ?? 0) | 1024,
      1,
    ],
    ['bad-child-escape', first + 8 + 7, directory.nodeCount, 1],
    ['bad-leaf-row', first + 8 + 3, 0xc0000002, 1],
    ['bad-leaf-enclosure', first + 8, 0x7f800000, 1],
    ['header-capacity-mismatch', 2, 3, 0],
  ] as const) {
    const row = make(name);
    row.fields[at] = value;
    cases.push({ ...row, state: 2, directory: validDirectory, preflight: validDirectory === 0 });
  }
  const hole = make('zero-mask-hole');
  hole.instances[36 + 19] = 0;
  cases.push(hole);
  const highwater = make('highwater-over-capacity');
  highwater.expected[2] = 5;
  highwater.actual[2] = 5;
  cases.push({ ...highwater, rowLimit: 5, state: 2, directory: 0, preflight: true });
  if (cases.length !== 33) throw Error(`Explicit complete case inventory changed: ${cases.length}`);
  return cases;
}

export function fullRosterMask(row: SceneCandidateCase): number {
  if (row.state === 2) return 0;
  let result = 0;
  for (let index = 0; index < row.rowLimit; index++) {
    if (((row.instances[index * 36 + 19] ?? 0) & row.mask) === 0) continue;
    const bounds = row.bounds[index];
    if (row.state === 1 || bounds === undefined || segmentIntersectsBox(row.ray, bounds))
      result |= 1 << index;
  }
  return result;
}

/** Two storage slots are only byte addressing adapters over each case's actual
 * physical allocations. Source tuples are independent of these physical spans. */
export function sceneCandidateInput(cases: readonly SceneCandidateCase[]) {
  const fields = Math.max(...cases.map((row) => row.fields.length));
  const stride = 32 + 144 + fields;
  const words = new Uint32Array(4 + cases.length * stride);
  words[0] = stride;
  const floats = new Float32Array(words.buffer);
  for (const [index, row] of cases.entries()) {
    const at = 4 + index * stride;
    words.set([row.fields.length, row.instances.length / 36, row.rowLimit, row.mask], at);
    words.set(row.actual, at + 4);
    words.set(row.expected, at + 8);
    floats.set(row.ray.origin, at + 12);
    floats.set(row.ray.direction, at + 16);
    floats.set([row.ray.first, row.ray.last], at + 20);
    words.set(row.instances, at + 32);
    words.set(row.fields, at + 32 + 144);
  }
  return new Uint8Array(words.buffer);
}

function uniqueStart(source: string, marker: string) {
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + 1) >= 0)
    throw Error(`Unique owning source required: ${marker}`);
  return start;
}

export function sceneCandidateFragments() {
  const factory = worldTraversalWgsl('global-sdf');
  const parts: { name: string; start: number; end: number; source: string }[] = [];
  const block = (marker: string) => {
    const start = uniqueStart(factory, marker),
      opening = factory.indexOf('{', start);
    if (opening < 0) throw Error('Owning source body required');
    let depth = 1,
      end = opening + 1;
    for (; depth > 0 && end < factory.length; end++) {
      if (factory[end] === '{') depth++;
      if (factory[end] === '}') depth--;
    }
    if (depth !== 0) throw Error('Complete owning source body required');
    parts.push({ name: marker, start, end, source: factory.slice(start, end) });
  };
  for (const name of ['SdfRealInterval', 'SdfIntervalVector', 'SdfSurfaceRay', 'SdfSurfaceBounds'])
    block(`struct ${name} {`);
  const start = uniqueStart(factory, 'fn sdfIntervalInvalid('),
    end = uniqueStart(factory, 'fn sdfSurfaceTriangle(');
  if (end <= start) throw Error('Owning interval operations boundaries required');
  parts.push({ name: 'interval-operations', start, end, source: factory.slice(start, end) });
  block('fn sdfSurfaceSlab(');
  block('fn sdfSurfaceRayUsable(');
  for (const [name, source] of [
    ['pool', SDF_SURFACE_POOL_WGSL],
    ['raw-admission', SDF_INSTANCE_WORD_GUARDS_WGSL],
    ['candidates', SDF_SURFACE_CANDIDATES_WGSL],
  ] as const) {
    const first = uniqueStart(factory, source);
    parts.push({ name, start: first, end: first + source.length, source });
  }
  parts.sort((a, b) => a.start - b.start);
  return { factory, parts };
}

export function sceneCandidateKernel(variant: 'original' | 'skip-raw-admission') {
  const anchor = 'if(!sdfInstanceValid(row)){return sdfSurfaceCandidatesUnknown(0u);}selected++;';
  if (SDF_SURFACE_CANDIDATES_WGSL.split(anchor).length !== 2)
    throw Error('Unique actual candidate admission anchor required');
  const candidate =
    variant === 'original'
      ? SDF_SURFACE_CANDIDATES_WGSL
      : SDF_SURFACE_CANDIDATES_WGSL.replace(anchor, 'selected++;');
  const pieces = sceneCandidateFragments()
    .parts.map((part) => (part.name === 'candidates' ? candidate : part.source))
    .join('\n');
  return `${pieces}
@group(0) @binding(0) var<storage,read> input:array<u32>;
@group(0) @binding(1) var<storage,read_write> output:array<u32>;
var<private> caseBase:u32;
fn sdfFieldWordCount()->u32{return input[caseBase];}
fn sdfFieldWord(word:u32)->u32{if(word>=sdfFieldWordCount()){return 0u;}return input[caseBase+176u+word];}
fn sdfInstanceRowCount()->u32{return input[caseBase+1u];}
fn sdfInstanceWord(row:u32,word:u32)->u32{if(row>=sdfInstanceRowCount() || word>=36u){return 0u;}return input[caseBase+32u+row*36u+word];}
fn readFour(at:u32)->vec4u{return vec4u(input[at],input[at+1u],input[at+2u],input[at+3u]);}
@compute @workgroup_size(1) fn candidateTest(@builtin(global_invocation_id) id:vec3u){
 caseBase=4u+id.x*input[0];let out=id.x*8u;
 let origin=readFour(caseBase+12u).xyz;let direction=readFour(caseBase+16u).xyz;
 let ray=SdfSurfaceRay(origin,origin,direction,direction,readFour(caseBase+20u).xy,1u);
 let expected=readFour(caseBase+8u);let limit=input[caseBase+2u];
 var actual=sdfSurfaceSceneCandidates(ray,limit,input[caseBase+3u],readFour(caseBase+4u),expected);
 output[out]=actual.state;output[out+1u]=actual.nodeVisits;output[out+2u]=actual.rows[0];
 var associated=0u;var packets=0u;var high=0u;
 for(var row=0u;row<4u;row++){
  if(sdfSurfaceCandidateContains(&actual,row)){
   if(sdfSurfaceRowAssociated(row)){associated|=1u<<row;}
   if(sdfSurfacePacket(row).valid==1u){packets|=1u<<row;}
  }
 }
 for(var word=1u;word<32u;word++){high|=actual.rows[word];}
 output[out+3u]=associated;output[out+4u]=packets;
 output[out+5u]=sdfSurfaceExpectedDirectory(limit,expected).valid;
 output[out+6u]=limit;output[out+7u]=high;
}`;
}

export function assessSceneCandidates(cases: readonly SceneCandidateCase[], actual: Uint32Array) {
  if (actual.length !== cases.length * 8) throw Error('Complete actual records required');
  const failures: string[] = [];
  for (const [index, row] of cases.entries()) {
    const record = actual.subarray(index * 8, index * 8 + 8),
      mask = fullRosterMask(row);
    const expected = [
      row.state,
      mask,
      mask & row.associated,
      mask & 1,
      row.directory,
      row.rowLimit,
      0,
    ];
    const observed = [record[0], record[2], record[3], record[4], record[5], record[6], record[7]];
    if (
      observed.some((value, at) => value !== expected[at]) ||
      (record[1] ?? 8) > 7 ||
      (row.preflight && record[1] !== 0)
    )
      failures.push(row.name);
  }
  return failures;
}
