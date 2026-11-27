import { readFileSync } from 'node:fs';
import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { SDF_SURFACE_INTERSECTION_WGSL as publishedPrimitive } from '@forgeax/engine-shader';
import { SDF_SURFACE_CANDIDATES_WGSL } from '../../../../shader/src/sdf-surface-candidates-wgsl';
import { SDF_SURFACE_INTERSECTION_WGSL } from '../../../../shader/src/sdf-surface-intersection-wgsl';
import { SDF_SURFACE_TRACE_WGSL } from '../../../../shader/src/sdf-surface-trace-wgsl';
import { SDF_INSTANCE_WGSL } from '../../raytracing/sdf-instance-wgsl';
import { packSdfScene, SDF_INSTANCE_STRIDE } from '../../raytracing/sdf-query';
import { SDF_SCENE_SURFACE_TRACE_WGSL } from '../../raytracing/sdf-surface-trace';
import {
  exactSurface,
  runSurfaceBufferWork,
  surfaceInputBytes,
  surfaceKernel,
} from './sdf-surface-intersection.fixture';

type V3 = readonly [number, number, number];
type Triangle = readonly [V3, V3, V3];
type Contract = 'clear' | 'hit' | 'unknown' | 'primitive';
interface EndpointCase {
  readonly name: string;
  readonly meshes: readonly (readonly Triangle[])[];
  readonly origin: V3;
  readonly end: number;
  readonly probeRow: number;
  readonly probePrimitive: number;
  readonly row: Contract;
  readonly scene: Contract;
  readonly nearest: number | null;
}
interface EndpointPrimitiveCase {
  readonly name: string;
  readonly triangle: Triangle;
  readonly origin: V3;
  readonly direction: V3;
  readonly range: readonly [number, number];
  readonly expected: 'oracle';
}
const edge = (z: number): Triangle => [
  [0, 0, z],
  [1, 1, z],
  [0, 1, z],
];
const broad = (z: number): Triangle => [
  [-1, -1, z],
  [3, -1, z],
  [-1, 3, z],
];
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const origin: V3 = [Math.fround(0.1), 1, 0];

/** Exact locally recorded getter tuple; never infer identity from a display name. */
export function requireEndpointPhysicalAdapter(
  info: Partial<Pick<GPUAdapterInfo, 'vendor' | 'architecture' | 'device' | 'description'>>,
) {
  if (
    info.vendor !== 'nvidia' ||
    info.architecture !== 'lovelace' ||
    info.device !== 'nvidia-geforce-rtx-4080' ||
    info.description !== 'D3D12 driver version 32.0.16.1742'
  )
    throw new Error(`Required recorded physical RTX 4080 tuple missing: ${JSON.stringify(info)}`);
}

export function endpointCases(): readonly EndpointCase[] {
  const base = { origin, end: 1, probeRow: 0, probePrimitive: 0 };
  return [
    {
      ...base,
      name: 'edge-at-closed-end',
      meshes: [[edge(1)]],
      row: 'primitive',
      scene: 'primitive',
      nearest: 1,
    },
    {
      ...base,
      name: 'clear-before-end',
      end: 0.5,
      meshes: [[edge(1)]],
      row: 'clear',
      scene: 'clear',
      nearest: null,
    },
    {
      ...base,
      name: 'interior-at-closed-end',
      origin: [0.25, 0.75, 0],
      meshes: [[edge(1)]],
      row: 'hit',
      scene: 'hit',
      nearest: 1,
    },
    {
      ...base,
      name: 'real-triangle-miss',
      origin: [0.75, 0.25, 0],
      meshes: [[edge(1)]],
      row: 'clear',
      scene: 'clear',
      nearest: null,
    },
    {
      ...base,
      name: 'row-unknown-before-known',
      end: 2,
      meshes: [[edge(1), broad(1.5)]],
      row: 'primitive',
      scene: 'primitive',
      nearest: 1,
    },
    {
      ...base,
      name: 'scene-unknown-before-known',
      end: 2,
      meshes: [[edge(1)], [broad(1.5)]],
      row: 'primitive',
      scene: 'primitive',
      nearest: 1,
    },
    {
      ...base,
      name: 'row-unknown-behind-earlier-hit',
      probePrimitive: 1,
      meshes: [[broad(0.5), edge(1)]],
      row: 'hit',
      scene: 'hit',
      nearest: 0.5,
    },
    {
      ...base,
      name: 'scene-unknown-behind-earlier-hit',
      probeRow: 1,
      meshes: [[broad(0.5)], [edge(1)]],
      row: 'primitive',
      scene: 'hit',
      nearest: 0.5,
    },
    {
      ...base,
      name: 'row-endpoint-identity-ambiguity',
      probePrimitive: 1,
      meshes: [[broad(1), edge(1)]],
      row: 'unknown',
      scene: 'unknown',
      nearest: 1,
    },
    {
      ...base,
      name: 'scene-endpoint-identity-ambiguity',
      probeRow: 1,
      meshes: [[broad(1)], [edge(1)]],
      row: 'primitive',
      scene: 'unknown',
      nearest: 1,
    },
  ];
}

export function endpointOracle(row: EndpointCase) {
  return row.meshes
    .flatMap((mesh, rowIndex) =>
      mesh.flatMap((triangle, primitive) => {
        const exact = exactSurface({
          name: row.name,
          triangle,
          origin: row.origin,
          direction: [0, 0, 1],
          range: [0, row.end],
          expected: 'oracle',
        });
        return exact.kind === 'hit'
          ? [{ row: rowIndex, primitive, time: exact.time, det: exact.det, u: exact.u, v: exact.v }]
          : [];
      }),
    )
    .sort((a, b) =>
      a.time * b.det < b.time * a.det ? -1 : a.time * b.det > b.time * a.det ? 1 : 0,
    );
}

/** Extract exact owning functions, including their bodies; never rewrite a DUT tail. */
export function endpointFunction(source: string, name: string): string {
  const anchor = `fn ${name}(`;
  if (source.split(anchor).length !== 2)
    throw new Error(`Unique owning function required: ${name}`);
  const start = source.indexOf(anchor),
    body = source.indexOf('{', start);
  let depth = 1,
    end = body + 1;
  while (depth > 0 && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth !== 0) throw new Error(`Incomplete owning function: ${name}`);
  return source.slice(start, end);
}

export const endpointOwningFunctions = [
  endpointStruct(SDF_SURFACE_CANDIDATES_WGSL, 'SdfSurfaceCandidates'),
  endpointFunction(SDF_SURFACE_CANDIDATES_WGSL, 'sdfSurfaceCandidateContains'),
  endpointFunction(SDF_INSTANCE_WGSL, 'sdfInstanceMask'),
  endpointFunction(SDF_INSTANCE_WGSL, 'sdfInstanceFloatUsable'),
  endpointFunction(SDF_INSTANCE_WGSL, 'sdfInstanceValid'),
  endpointFunction(SDF_SCENE_SURFACE_TRACE_WGSL, 'sdfSceneSurfaceReady'),
  endpointFunction(SDF_SCENE_SURFACE_TRACE_WGSL, 'sdfSceneSurfaceTraceRows'),
  endpointFunction(SDF_SCENE_SURFACE_TRACE_WGSL, 'sdfSceneSurfaceTrace'),
] as const;

// The two-buffer work helper receives only source-owner bytes plus addresses.
const adapter = `
@group(0) @binding(0) var<storage,read> inputWords:array<u32>;
@group(0) @binding(1) var<storage,read_write> resultWords:array<vec4u>;
var<private> endpointSpans:vec4u;
fn sdfFieldWordCount()->u32{return endpointSpans.w;}
fn sdfFieldWord(index:u32)->u32{if(index>=endpointSpans.w){return 0u;}return inputWords[endpointSpans.z+index];}
fn sdfInstanceRowCount()->u32{return endpointSpans.y/${SDF_INSTANCE_STRIDE / 4}u;}
fn sdfInstanceWord(row:u32,word:u32)->u32{
 if(row>=sdfInstanceRowCount() || word>=${SDF_INSTANCE_STRIDE / 4}u){return 0u;}
 return inputWords[endpointSpans.x+row*${SDF_INSTANCE_STRIDE / 4}u+word];
}
struct Ray { origin:vec3f,tMin:f32,direction:vec3f,tMax:f32,mask:vec4u }
`;
export const endpointAggregationKernel = `${SDF_SURFACE_TRACE_WGSL}
${adapter}
${endpointOwningFunctions.join('\n')}
@compute @workgroup_size(1) fn endpointAggregation(@builtin(global_invocation_id) id:vec3u){
 let count=inputWords[0];if(id.x>=count){return;}
 let at=4u+id.x*16u;
 endpointSpans=vec4u(inputWords[at],inputWords[at+1u],inputWords[at+2u],inputWords[at+3u]);
 let rows=inputWords[at+4u];let mask=inputWords[at+5u];let row=inputWords[at+6u];let primitive=inputWords[at+7u];
 let origin=bitcast<vec3f>(vec3u(inputWords[at+8u],inputWords[at+9u],inputWords[at+10u]));
 let direction=bitcast<vec3f>(vec3u(inputWords[at+12u],inputWords[at+13u],inputWords[at+14u]));
 let range=vec2u(inputWords[at+11u],inputWords[at+15u]);
 let world=SdfSurfaceRay(bitcast<vec3u>(origin),bitcast<vec3u>(origin),bitcast<vec3u>(direction),bitcast<vec3u>(direction),range,1u);
 let packet=sdfSurfacePacket(row);let first=packet.triangles.x+primitive*3u;
 let p=sdfSurfaceTriangle(world,sdfSurfaceVertex(packet,sdfFieldWord(first)),sdfSurfaceVertex(packet,sdfFieldWord(first+1u)),sdfSurfaceVertex(packet,sdfFieldWord(first+2u)));
 var rowRemaining=256u;let r=sdfSurfaceTraceRow(row,world,&rowRemaining);
 var sceneRemaining=256u;let s=sdfSceneSurfaceTrace(Ray(origin,bitcast<f32>(range.x),direction,bitcast<f32>(range.y),vec4u(mask,0u,0u,0u)),rows,&sceneRemaining);
 let ready=sdfSceneSurfaceReady(rows,mask);
 resultWords[id.x*4u]=vec4u(p.state,bitcast<u32>(p.tLower),bitcast<u32>(p.tUpper),p.frontFace);
 resultWords[id.x*4u+1u]=vec4u(r.state,bitcast<u32>(r.lower),bitcast<u32>(r.upper),r.primitive);
 resultWords[id.x*4u+2u]=vec4u(s.state,bitcast<u32>(s.lower),bitcast<u32>(s.upper),s.row);
 resultWords[id.x*4u+3u]=vec4u(rowRemaining,sceneRemaining,packet.valid,select(0u,1u,ready));
}`;

function words(bytes: Uint8Array) {
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
async function packEndpoint(row: EndpointCase) {
  const sources = [];
  for (const [index, mesh] of row.meshes.entries()) {
    const positions = new Float32Array(
      mesh.flatMap((triangle) => triangle.flatMap((vertex) => [...vertex])),
    );
    const indices = Uint32Array.from({ length: mesh.length * 3 }, (_, i) => i);
    const field = (
      await buildVisibilityDistanceField(positions, indices, {
        voxelSize: 0.25,
        triangleSidedness: new Uint8Array(mesh.length),
      })
    ).unwrap();
    sources.push({
      instanceId: index + 1,
      geometryId: index,
      mask: 255,
      transform: identity,
      surfaceCoverage: 'opaque' as const,
      field,
    });
  }
  return packSdfScene(sources).unwrap();
}
export async function prepareEndpointAggregation() {
  const cases = endpointCases(),
    packed: Awaited<ReturnType<typeof packEndpoint>>[] = [];
  for (const row of cases) packed.push(await packEndpoint(row));
  const first = 4 + cases.length * 16;
  const total =
    first +
    packed.reduce(
      (sum, value) => sum + value.instances.byteLength / 4 + value.fields.byteLength / 4,
      0,
    );
  const input = new Uint32Array(total),
    floats = new Float32Array(input.buffer);
  input[0] = cases.length;
  let offset = first;
  cases.forEach((row, index) => {
    const value = packed[index];
    if (value === undefined) throw new Error('Complete canonical packed rows required');
    const instances = words(value.instances),
      fields = words(value.fields),
      at = 4 + index * 16;
    input.set(
      [
        offset,
        instances.length,
        offset + instances.length,
        fields.length,
        row.meshes.length,
        255,
        row.probeRow,
        row.probePrimitive,
      ],
      at,
    );
    floats.set([...row.origin, 0, 0, 0, 1, row.end], at + 8);
    input.set(instances, offset);
    offset += instances.length;
    input.set(fields, offset);
    offset += fields.length;
  });
  return { cases, input: new Uint8Array(input.buffer), code: endpointAggregationKernel };
}

const expectedState = (contract: Contract, primitive: number) =>
  contract === 'primitive' ? primitive : contract === 'clear' ? 0 : contract === 'hit' ? 1 : 2;
function assessEndpointStages(
  cases: readonly EndpointCase[],
  raw: Uint32Array,
  canonical: boolean,
) {
  if (raw.length !== cases.length * 16) throw new Error('Complete endpoint stage records required');
  const failures: string[] = [],
    floats = new Float32Array(raw.buffer, raw.byteOffset, raw.length);
  cases.forEach((row, index) => {
    const at = index * 16,
      primitive = raw[at];
    if (primitive === undefined || primitive > 2)
      throw new Error('Actual primitive state required');
    const exact = endpointOracle(row),
      probe = exact.find((hit) => hit.row === row.probeRow && hit.primitive === row.probePrimitive);
    if (probe && primitive === 0)
      failures.push(`${row.name}: primitive falsely cleared an exact authored hit`);
    if (!probe && primitive === 1)
      failures.push(`${row.name}: primitive falsely hit an exact authored miss`);
    if (raw[at + 4] !== expectedState(row.row, primitive))
      failures.push(`${row.name}: Row did not preserve primitive uncertainty/nearest state`);
    if (raw[at + 8] !== expectedState(row.scene, primitive))
      failures.push(`${row.name}: Scene did not preserve primitive uncertainty/nearest state`);
    if (canonical && (raw[at + 14] !== 1 || raw[at + 15] !== 1))
      failures.push(`${row.name}: canonical source was not actually admitted`);
    const rowHit = exact.find((hit) => hit.row === row.probeRow);
    for (const [stage, nearest] of [
      [4, rowHit],
      [8, exact[0]],
    ] as const) {
      const lower = floats[at + stage + 1],
        upper = floats[at + stage + 2];
      if (lower === undefined || upper === undefined) throw new Error('Complete interval required');
      if (
        raw[at + stage] === 1 &&
        nearest &&
        !(
          lower <= Number(nearest.time) / Number(nearest.det) &&
          upper >= Number(nearest.time) / Number(nearest.det)
        )
      )
        failures.push(`${row.name}: nearest hit escaped its reported interval`);
    }
  });
  return { failures, endpointWitness: raw[0] === 2 && floats[1] === 1, records: cases.length };
}
export function assessEndpointAggregation(cases: readonly EndpointCase[], raw: Uint32Array) {
  return assessEndpointStages(cases, raw, true);
}
export function runEndpointAggregation(
  device: GPUDevice,
  code: string,
  prepared: Awaited<ReturnType<typeof prepareEndpointAggregation>>,
) {
  return runSurfaceBufferWork(
    device,
    code,
    prepared.input,
    'endpointAggregation',
    prepared.cases.length,
    64,
  );
}

export interface EndpointCompositionSource {
  readonly primitive: string;
  readonly trace: string;
  readonly scene: string;
}
export const endpointCurrentCompositionSource: EndpointCompositionSource = {
  primitive: SDF_SURFACE_INTERSECTION_WGSL,
  trace: SDF_SURFACE_TRACE_WGSL,
  scene: SDF_SCENE_SURFACE_TRACE_WGSL,
};

export function endpointCompositionSource(): EndpointCompositionSource {
  const path = process.env.FORGEAX_ENDPOINT_COMPOSITION_SOURCE;
  if (path === undefined) return endpointCurrentCompositionSource;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('primitive' in parsed) ||
    typeof parsed.primitive !== 'string' ||
    !('trace' in parsed) ||
    typeof parsed.trace !== 'string' ||
    !('scene' in parsed) ||
    typeof parsed.scene !== 'string'
  )
    throw new Error('Exact complete frozen composition source required');
  return { primitive: parsed.primitive, trace: parsed.trace, scene: parsed.scene };
}

function endpointStruct(source: string, name: string) {
  const anchor = `struct ${name} {`;
  if (source.split(anchor).length !== 2) throw new Error(`Unique structure required: ${name}`);
  const start = source.indexOf(anchor),
    end = source.indexOf('}', start);
  if (end < start) throw new Error(`Complete structure required: ${name}`);
  return source.slice(start, end + 1);
}

export function endpointCompositionParts(source: EndpointCompositionSource) {
  const trace = endpointStruct(source.trace, 'SdfSurfaceTrace');
  const body = trace.slice(trace.indexOf('{') + 1, -1).replace(/\/\/[^\n]*/g, '');
  const members = body.split(',').map((field) => {
    const match = /^\s*(\w+)\s*:\s*(u32|f32)\s*$/.exec(field);
    if (!match)
      throw new Error('Only actual scalar trace words are supported by this test adapter');
    return { name: match[1] as string, type: match[2] as 'u32' | 'f32' };
  });
  const row = endpointFunction(source.trace, 'sdfSurfaceTraceRow');
  const tail = row.slice(row.lastIndexOf('\n if(best.'), row.lastIndexOf('}'));
  if (!tail.includes('return best;') || !tail.startsWith('\n if(best.'))
    throw new Error('Unique actual Row final tail required');
  return {
    trace,
    members,
    tail,
    empty: endpointFunction(source.trace, 'sdfSurfaceTraceEmpty'),
    accept: endpointFunction(source.trace, 'sdfSurfaceAccept'),
    scene: endpointFunction(source.scene, 'sdfSceneSurfaceTrace'),
    sceneRows: endpointFunction(source.scene, 'sdfSceneSurfaceTraceRows'),
    candidates: endpointStruct(SDF_SURFACE_CANDIDATES_WGSL, 'SdfSurfaceCandidates'),
    contains: endpointFunction(SDF_SURFACE_CANDIDATES_WGSL, 'sdfSurfaceCandidateContains'),
    ray: endpointStruct(source.primitive, 'SdfSurfaceRay'),
    axisTie: source.trace.includes('fn sdfSurfaceAcceptAxisTie(')
      ? [
          endpointStruct(source.trace, 'SdfSurfacePacket'),
          endpointFunction(source.trace, 'sdfSurfaceBitsUsable'),
          endpointFunction(source.trace, 'sdfSurfacePrimitiveOpaque'),
          endpointFunction(source.trace, 'sdfSurfacePrimitiveAxisPlane'),
          endpointFunction(source.trace, 'sdfSurfaceAcceptAxisTie'),
        ].join('\n')
      : null,
  };
}

export interface EndpointCompositionRow {
  readonly caseIndex: number;
  readonly row: number;
  readonly first: number;
  readonly count: number;
  readonly end: number;
  readonly mesh: readonly Triangle[];
  readonly primitiveIds?: readonly number[];
  readonly opaque?: readonly boolean[];
}

export function prepareEndpointComposition(source: EndpointCompositionSource) {
  const cases = endpointCases();
  const primitives: EndpointPrimitiveCase[] = [];
  const rows: EndpointCompositionRow[] = [];
  for (const [caseIndex, entry] of cases.entries()) {
    for (const [row, mesh] of entry.meshes.entries()) {
      rows.push({
        caseIndex,
        row,
        first: primitives.length,
        count: mesh.length,
        end: entry.end,
        mesh,
      });
      for (const [primitive, triangle] of mesh.entries())
        primitives.push({
          name: `${entry.name}/row-${row}/primitive-${primitive}`,
          triangle,
          origin: entry.origin,
          direction: [0, 0, 1],
          range: [0, entry.end],
          expected: 'oracle',
        });
    }
  }
  if (!surfaceKernel.startsWith(publishedPrimitive))
    throw new Error('Original primitive work entry required');
  const parts = endpointCompositionParts(source);
  return {
    cases,
    primitives,
    rows,
    parts,
    primitiveInput: surfaceInputBytes(primitives),
    primitiveCode: source.primitive + surfaceKernel.slice(publishedPrimitive.length),
  };
}

const compositionBindings = `
@group(0) @binding(0) var<storage,read> inputWords:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputs:array<SdfSurfaceTrace>;
`;

export function endpointRowCompositionCode(parts: ReturnType<typeof endpointCompositionParts>) {
  const certificate =
    parts.axisTie === null
      ? ''
      : `${parts.axisTie}
fn sdfFieldWord(index:u32)->u32{if(index>=arrayLength(&inputWords)){return 0u;}return inputWords[index];}
`;
  return `${parts.trace}\n${parts.empty}\n${parts.accept}\n${certificate}\n${compositionBindings}
fn endpointComposeRow(index:u32)->SdfSurfaceTrace {
 let at=4u+index*12u;let first=inputWords[at];let count=inputWords[at+1u];
 let last=bitcast<f32>(inputWords[at+2u]);let row=inputWords[at+3u];
${
  parts.axisTie === null
    ? ''
    : ` // Component geometry is authored; this does not qualify canonical storage.
 let vertices=inputWords[at+8u]*3u;
 let packet=SdfSurfacePacket(1u,vec2u(0),vec2u(0),vec2u(inputWords[at+4u],vertices),vec2u(inputWords[at+5u],inputWords[at+8u]),vec2u(0),vec2u(0),vec2u(0),vec3u(0),0u,vec2u(2u,inputWords[at+7u]));`
}
 var best=sdfSurfaceTraceEmpty(last);best.row=row;
 for(var slot=0u;slot<count;slot++){
  let record=first+slot*8u;var hit=sdfSurfaceTraceEmpty(last);
  hit.state=inputWords[record];hit.lower=bitcast<f32>(inputWords[record+1u]);
  hit.upper=bitcast<f32>(inputWords[record+2u]);hit.frontFace=inputWords[record+3u];
  hit.primitive=inputWords[inputWords[at+6u]+slot];
  ${parts.axisTie === null ? 'sdfSurfaceAccept(&best,hit);' : 'if(!sdfSurfaceAcceptAxisTie(&best,hit,packet)){sdfSurfaceAccept(&best,hit);}'}best.row=row;
 }
${parts.tail}
}
@compute @workgroup_size(1) fn endpointRows(@builtin(global_invocation_id) id:vec3u){
 if(id.x<inputWords[0]){outputs[id.x]=endpointComposeRow(id.x);}
}`;
}

export function endpointRowCompositionInput(
  rows: readonly EndpointCompositionRow[],
  primitive: Uint32Array,
) {
  if (primitive.length !== rows.reduce((count, row) => count + row.count, 0) * 8)
    throw new Error('Complete original primitive GPU records required');
  const prefix = 4 + rows.length * 12;
  const geometryWords = rows.reduce(
    (sum, row) => sum + row.mesh.length * 12 + row.count + Math.ceil(row.mesh.length / 32),
    0,
  );
  const words = new Uint32Array(prefix + primitive.length + geometryWords),
    floats = new Float32Array(words.buffer);
  words[0] = rows.length;
  let next = prefix + primitive.length;
  rows.forEach((row, i) => {
    const positions = next,
      triangles = positions + row.mesh.length * 9;
    const ids = triangles + row.mesh.length * 3,
      coverage = ids + row.count;
    words.set(
      [
        prefix + row.first * 8,
        row.count,
        0,
        row.row,
        positions,
        triangles,
        ids,
        coverage,
        row.mesh.length,
        0,
        0,
        0,
      ],
      4 + i * 12,
    );
    floats[6 + i * 12] = row.end;
    floats.set(
      row.mesh.flatMap((triangle) => triangle.flatMap((vertex) => [...vertex])),
      positions,
    );
    words.set(
      Uint32Array.from({ length: row.mesh.length * 3 }, (_, index) => index),
      triangles,
    );
    words.set(
      row.primitiveIds ?? Uint32Array.from({ length: row.count }, (_, index) => index),
      ids,
    );
    row.mesh.forEach((_triangle, primitive) => {
      if (row.opaque?.[primitive] !== false)
        words[coverage + (primitive >> 5)] =
          (words[coverage + (primitive >> 5)] ?? 0) | (1 << (primitive & 31));
    });
    next = coverage + Math.ceil(row.mesh.length / 32);
  });
  words.set(primitive, prefix);
  return new Uint8Array(words.buffer);
}

export function endpointSceneCompositionCode(parts: ReturnType<typeof endpointCompositionParts>) {
  const restore = parts.members
    .map((member, index) => {
      const word = `inputWords[endpointRowsAt+row*${parts.members.length}u+${index}u]`;
      return `out.${member.name}=${member.type === 'f32' ? `bitcast<f32>(${word})` : word};`;
    })
    .join('\n');
  return `${parts.trace}\n${parts.empty}\n${parts.ray}\n${parts.candidates}\n${parts.contains}\n${compositionBindings}
struct Ray {origin:vec3f,tMin:f32,direction:vec3f,tMax:f32,mask:vec4u}
var<private> endpointRowsAt:u32;var<private> endpointMask:u32;var<private> endpointRowCount:u32;
fn sdfInstanceMask(row:u32)->u32{return endpointMask;}
fn sdfInstanceRowCount()->u32{return endpointRowCount;}
// This aggregation component receives actual already-admitted Row tuples.
// It does not qualify raw canonical storage or claim traversal coverage.
fn sdfSurfaceRowAssociated(row:u32)->bool{return row<endpointRowCount;}
fn sdfSurfaceTraceRow(row:u32,world:SdfSurfaceRay,remaining:ptr<function,u32>)->SdfSurfaceTrace{
 var out=sdfSurfaceTraceEmpty(bitcast<f32>(world.tRange.y));
 ${restore}
 return out;
}
${parts.sceneRows}
${parts.scene}
@compute @workgroup_size(1) fn endpointScenes(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=inputWords[0]){return;}
 let at=4u+id.x*16u;endpointRowsAt=inputWords[at];endpointMask=inputWords[at+10u];endpointRowCount=inputWords[at+1u];
 let origin=bitcast<vec3f>(vec3u(inputWords[at+2u],inputWords[at+3u],inputWords[at+4u]));
 let direction=bitcast<vec3f>(vec3u(inputWords[at+6u],inputWords[at+7u],inputWords[at+8u]));
 var remaining=256u;
 outputs[id.x]=sdfSceneSurfaceTrace(Ray(origin,bitcast<f32>(inputWords[at+5u]),direction,bitcast<f32>(inputWords[at+9u]),vec4u(endpointMask,0,0,0)),inputWords[at+1u],&remaining);
}`;
}

export function endpointSceneCompositionInput(
  prepared: ReturnType<typeof prepareEndpointComposition>,
  raw: Uint32Array,
) {
  const stride = prepared.parts.members.length;
  if (raw.length !== prepared.rows.length * stride)
    throw new Error('Complete actual Row GPU tuples required');
  const prefix = 4 + prepared.cases.length * 16;
  const words = new Uint32Array(prefix + raw.length),
    floats = new Float32Array(words.buffer);
  words[0] = prepared.cases.length;
  prepared.cases.forEach((entry, i) => {
    const first = prepared.rows.findIndex((row) => row.caseIndex === i);
    words.set([prefix + first * stride, entry.meshes.length], 4 + i * 16);
    floats.set([...entry.origin, 0, 0, 0, 1, entry.end], 6 + i * 16);
    words[14 + i * 16] = 255;
  });
  words.set(raw, prefix);
  return new Uint8Array(words.buffer);
}

export function assessEndpointComposition(
  prepared: ReturnType<typeof prepareEndpointComposition>,
  primitive: Uint32Array,
  rows: Uint32Array,
  scenes: Uint32Array,
) {
  const stride = prepared.parts.members.length,
    raw = new Uint32Array(prepared.cases.length * 16);
  const read = (records: Uint32Array, index: number, field: string) => {
    const word = prepared.parts.members.findIndex((member) => member.name === field);
    const value = records[index * stride + word];
    if (word < 0 || value === undefined) throw new Error('Complete actual trace field required');
    return value;
  };
  prepared.cases.forEach((entry, i) => {
    const rowIndex = prepared.rows.findIndex(
      (row) => row.caseIndex === i && row.row === entry.probeRow,
    );
    const row = prepared.rows[rowIndex];
    if (!row) throw new Error('Original selected row required');
    raw.set(
      primitive.subarray(
        (row.first + entry.probePrimitive) * 8,
        (row.first + entry.probePrimitive) * 8 + 4,
      ),
      i * 16,
    );
    raw.set(
      ['state', 'lower', 'upper', 'primitive'].map((field) => read(rows, rowIndex, field)),
      i * 16 + 4,
    );
    raw.set(
      ['state', 'lower', 'upper', 'row'].map((field) => read(scenes, i, field)),
      i * 16 + 8,
    );
  });
  return {
    ...assessEndpointStages(prepared.cases, raw, false),
    scope:
      'Actual primitive/Accept/Row-tail/Scene aggregation only; traversal, canonical admission and budget qualification remain missing',
    raw,
  };
}
