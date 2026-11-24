import { readFileSync } from 'node:fs';
import { SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL } from '../../../../shader/src/sdf-surface-trace-wgsl';
import { packFieldReceiverGpuSource } from '../../raytracing/field-receiver-texture';
import { SCREEN_PROBE_ENDPOINT_WGSL } from '../../raytracing/screen-probe-endpoint';
import { sdfSceneSurfaceTraceWgsl } from '../../raytracing/sdf-surface-trace';
import { exactSurface } from './sdf-surface-intersection.fixture';

export interface EndpointTrace {
  state: number;
  row: number;
  primitive: number;
  frontFace: number;
  lower: number;
  upper: number;
  uncertain: number;
  reserved: number;
  prefixSamples: number;
  hasUncertainty: number;
}

export function wgslBody(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  if (start < 0) throw new Error(`Missing production ${name}`);
  const open = source.indexOf('{', start);
  let end = open + 1,
    depth = 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw new Error(`Unclosed production ${name}`);
  return source.slice(open + 1, end - 1).replace(/\/\/[^\n]*/g, '');
}

const bits = (n: number) => new Uint32Array(Float32Array.of(n).buffer)[0] ?? 0;
const number = (n: number) => new Float32Array(Uint32Array.of(n).buffer)[0] ?? 0;
const empty = (last: number): EndpointTrace => ({
  state: 0,
  row: 0xffffffff,
  primitive: 0xffffffff,
  frontFace: 0,
  lower: last,
  upper: last,
  uncertain: last,
  reserved: 0,
  prefixSamples: 0,
  hasUncertainty: 0,
});
const lower = (body: string) =>
  body
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1')
    .replace(/bitcast<f32>\(/g, 'number(')
    .replace(/\*remaining/g, 'remaining.value')
    .replace(/&remaining/g, 'remaining')
    .replace(/&best/g, 'best')
    .replace(/&segment/g, 'segment')
    .replace(/\bloop\s*\{/g, 'while(true){');

/** Actual production Row/reducer control with exact dyadic slab/triangle ports.
 * This does not emulate WGSL permitted rounding or qualify a GPU device. */
export function endpointRowControl(
  budget: number,
  source = SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL,
  options: {
    seed?: EndpointTrace;
    otherTime?: number;
    otherState?: number;
    targetState?: number;
    row?: number;
  } = {},
) {
  const words: number[] = [];
  const other = options.otherTime ?? 9;
  const nodes = [
    [-1, -1, Math.min(1, other), 3, 1, 1, Math.max(1, other), 0],
    [-1, -1, other, 2, 1, 1, other, 1],
    [-1, -1, 1, 3, 1, 1, 1, 5],
  ];
  for (const node of nodes)
    node.forEach((v, i) => {
      words.push(i === 3 || i === 7 ? v : bits(v));
    });
  words.push(0, 1);
  const seed: EndpointTrace = options.seed ?? {
    ...empty(10),
    state: 1,
    row: 0,
    primitive: 1,
    lower: 1,
    upper: 1,
    frontFace: 1,
  };
  const packet = {
    valid: 1,
    nodes: { x: 0, y: 3 },
    order: { x: 24, y: 2 },
    coefficients: { yz: [] },
  };
  const acceptBody = lower(wgslBody(source, 'sdfSurfaceAccept'))
    .replace(/\(\*best\)/g, 'best')
    .replace(/\*best=hit/g, 'Object.assign(best,hit)');
  const accept = new Function('best', 'hit', 'min', acceptBody);
  const axisTieBody = lower(wgslBody(source, 'sdfSurfaceAcceptAxisTie'))
    .replace(/\(\*best\)/g, 'best')
    .replace(/\*best=hit/g, 'Object.assign(best,hit)');
  const axisTie = new Function(
    'best',
    'hit',
    'packet',
    'min',
    'max',
    'sdfSurfacePrimitiveOpaque',
    'sdfSurfacePrimitiveAxisPlane',
    axisTieBody,
  );
  // Independent authored geometry ports for the existing exact +Z ray.
  // The real reducer/certificate body runs unchanged; word equality, including
  // signed zero, supplies its plane interface rather than a forced false stub.
  const geometry = [other, 1].map((z) => [
    [-1, -1, z],
    [1, -1, z],
    [0, 1, z],
  ]);
  const opaque = (p: unknown, primitive: number) => p === packet && primitive < geometry.length;
  const axisPlane = (p: unknown, primitive: number, axis: number) => {
    const triangle = geometry[primitive];
    if (p !== packet || !triangle || axis >= 3) return { x: 0, y: 0 };
    const values = triangle.map((vertex) => Math.fround(vertex[axis] ?? NaN));
    const first = values[0] ?? NaN;
    const finite = Number.isFinite(first) && (first === 0 || Math.abs(first) >= 2 ** -126);
    return finite && values.every((value) => bits(value) === bits(first))
      ? { x: 1, y: bits(first) }
      : { x: 0, y: 0 };
  };
  const remaining = { value: budget };
  const visits: number[] = [];
  const segment = {};
  let segmentPreparations = 0;
  let segmentBounds = 0;
  const scope = {
    number,
    min: Math.min,
    max: Math.max,
    seed,
    remaining,
    row: options.row ?? 0,
    contact: { valid: 0 },
    world: { valid: 1, tRange: { x: bits(0), y: bits(10) } },
    sdfSurfaceRayUsable: () => true,
    sdfSurfacePacket: () => packet,
    sdfSurfaceTraceEmpty: empty,
    sdfSurfaceLocalRay: (ray: unknown) => ray,
    sdfSurfaceInverse: () => [],
    sdfSurfaceCharge: (r: { value: number }) => {
      if (r.value === 0) return false;
      r.value--;
      return true;
    },
    sdfFieldWord: (at: number) => words[at],
    vec3u: (x: number, y: number, z: number) => ({ x, y, z }),
    sdfSurfaceSegmentEnclosure: () => {
      segmentPreparations++;
      return segment;
    },
    sdfSurfaceSegmentBoundsClear: (prepared: unknown) => {
      if (prepared !== segment) throw Error('Row enclosure was not retained');
      segmentBounds++;
      return false;
    },
    sdfSurfaceSlab: (_ray: unknown, lo: { z: number }, hi: { z: number }) => ({
      certified: 1,
      possible: 1,
      near: number(lo.z),
      far: number(hi.z),
    }),
    SdfSurfacePrefix: () => ({ valid: 0, samples: 0, end: 0 }),
    sdfSurfaceRootPrefix: () => ({ valid: 0, samples: 0, end: 0 }),
    sdfSurfaceLeafTrianglePrepared: (
      _packet: unknown,
      slot: number,
      _ray: unknown,
      prepared: unknown,
    ) => {
      if (prepared !== segment) throw Error('Leaf lost the current row enclosure');
      visits.push(slot);
      const t = slot === 0 ? other : 1;
      return {
        ...empty(10),
        state: slot === 0 ? (options.otherState ?? 1) : (options.targetState ?? 1),
        row: 0,
        primitive: slot,
        lower: t,
        upper: t,
        frontFace: 1,
      };
    },
    sdfSurfaceAccept: (best: EndpointTrace, hit: EndpointTrace) => accept(best, hit, Math.min),
    sdfSurfaceAcceptAxisTie: (best: EndpointTrace, hit: EndpointTrace, p: unknown) =>
      axisTie(best, hit, p, Math.min, Math.max, opaque, axisPlane),
  };
  const execute = new Function(
    ...Object.keys(scope),
    lower(wgslBody(source, 'sdfSurfaceTraceRow')).replace('var hit:SdfSurfaceTrace;', 'let hit;'),
  );
  const result = execute(...Object.values(scope)) as EndpointTrace;
  return { result, remaining: remaining.value, visits, segmentPreparations, segmentBounds };
}

/** Real Scene reducer over real Row control, sharing its original work counter. */
export function endpointSceneControl(
  options: { time?: number; state?: number; source?: boolean; seedVisited?: boolean } = {},
) {
  const seed = endpointCandidateControl().trace;
  const remaining = { value: 256 };
  const scope = {
    ray: { tMin: 0, tMax: 10, mask: { x: 1 } },
    count: 2,
    remaining,
    candidates: { state: 1 },
    world: {},
    contact: { valid: 0 },
    seed,
    min: Math.min,
    sdfSurfaceTraceEmpty: empty,
    sdfInstanceRowCount: () => 2,
    sdfSurfaceCandidateContains: (_c: unknown, row: number) =>
      row !== 0 || options.seedVisited !== false,
    sdfSurfaceRowAssociated: (row: number) => row !== 1 || options.source !== false,
    sdfSurfaceTraceRow: (row: number, _world: unknown, counter: { value: number }) => {
      const actual = endpointRowControl(
        counter.value,
        undefined,
        row === 0
          ? { seed }
          : {
              seed,
              row,
              otherTime: options.time ?? 0.5,
              otherState: options.state ?? 1,
              targetState: 0,
            },
      );
      counter.value = actual.remaining;
      return actual.result;
    },
  };
  const code = lower(
    wgslBody(sdfSceneSurfaceTraceWgsl(false, true, true), 'sdfSceneSurfaceTraceRows'),
  ).replace(/\(\*candidates\)/g, 'candidates');
  const result = new Function(...Object.keys(scope), code)(
    ...Object.values(scope),
  ) as EndpointTrace;
  return { result, remaining: remaining.value };
}

function vector(...values: number[]) {
  const v =
    values.length === 1 ? [values[0] ?? 0, values[0] ?? 0, values[0] ?? 0, values[0] ?? 0] : values;
  return Object.assign(v, {
    x: v[0] ?? 0,
    y: v[1] ?? 0,
    z: v[2] ?? 0,
    w: v[3] ?? 0,
    xy: v.slice(0, 2),
    yz: v.slice(1, 3),
  });
}
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export interface EndpointInput {
  readonly frame?: number;
  readonly revision?: number;
  readonly epoch?: number;
  readonly opaque?: boolean;
  readonly identity?: boolean;
  readonly source?: boolean;
  readonly offRay?: boolean;
  readonly direction?: number;
  readonly targetZ?: number;
  readonly acceptedFrame?: number;
  readonly acceptedRevision?: number;
  readonly acceptedEpoch?: number;
  readonly candidateFrame?: number;
  readonly candidateRevision?: number;
  readonly payload?: number[];
  readonly contact?: boolean;
}

const codecSource = readFileSync(
  new URL('../../../../shader/src/ray-screen-candidate.wgsl', import.meta.url),
  'utf8',
);
export function candidateCodec() {
  const scope: Record<string, unknown> = {
    number,
    bits,
    vec3f: vector,
    vec3u: (...v: number[]) => vector(...v.map((x) => x >>> 0)),
    exponents: (v: number[]) => v.map((n) => (bits(n) >>> 23) & 255),
    everyGe: (v: number[], n: number) => v.every((x) => x >= n),
    everyLe: (v: number[], n: number) => v.every((x) => x <= n),
  };
  for (const [name, args] of [
    ['screenCandidateWord', 'word'],
    ['screenCandidateWordBits', 'value'],
    ['screenCandidateValid', 'payload'],
    ['screenCandidatePack', 'pixel,frame,revision'],
    ['screenCandidateUnpack', 'payload'],
  ]) {
    const code = lower(wgslBody(codecSource, name ?? ''))
      .replace(/>>/g, '>>>')
      .replace(/bitcast<u32>\(/g, 'bits(')
      .replace(/\(bitcast<vec3u>\(payload\)>>>vec3u\(23\)\)&vec3u\(255\)/g, 'exponents(payload)')
      .replace(/all\(exponent>=vec3u\(1\)\)/g, 'everyGe(exponent,1)')
      .replace(/all\(exponent<=vec3u\(128\)\)/g, 'everyLe(exponent,128)');
    scope[name ?? ''] = new Function(...Object.keys(scope), `return function(${args}){${code}}`)(
      ...Object.values(scope),
    );
  }
  const unpack = scope.screenCandidateUnpack as (payload: number[]) => number[];
  const valid = scope.screenCandidateValid as (payload: number[]) => boolean;
  return {
    pack: scope.screenCandidatePack as (
      pixel: { readonly x: number; readonly y: number },
      frame: number,
      revision: number,
    ) => number[],
    unpack: (payload: number[]) => unpack(vector(...payload)),
    valid: (payload: number[]) => valid(vector(...payload)),
  };
}

function endpointSource(input: EndpointInput) {
  const expected = [72, 256, 2, input.acceptedEpoch ?? 7] as const;
  const forward = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return packFieldReceiverGpuSource(
    input.source === false
      ? []
      : [
          {
            rasterRow: 1,
            canonicalRow: 0,
            primitiveFirst: 1,
            primitiveCount: 1,
            forward,
            receiverProof: 'opaque-primitive',
          },
        ],
    input.source === false ? 0 : 1,
    expected,
    input.acceptedFrame ?? 11,
    input.acceptedRevision ?? 3,
    { maxTextureDimension2D: 8192, maxBytes: 1024 },
  ).unwrap();
}

/** Executes the actual endpoint, source header, and primitive mapping bodies.
 * Only scalar geometry ports use an independent exact dyadic oracle. */
export function endpointCandidateControl(input: EndpointInput = {}) {
  const source = endpointSource(input);
  const fields = new Uint32Array(256);
  fields.set([0, 1, 2], 103);
  const z = input.targetZ ?? 1;
  const vertices = [
    [-1, -1, z],
    [1, -1, z],
    [0, 1, z],
  ] as const;
  fields.set(vertices.flat().map(bits), 120);
  const packet = {
    valid: 1,
    triangles: { x: 100, y: 2 },
    positions: { x: 120, y: 3 },
    sidedness: { x: 140 },
    coefficients: { yz: [] },
  };
  const origin = [input.offRay ? 4 : 0, 0, 0] as const;
  const direction = [0, 0, input.direction ?? 1] as const;
  let tests = 0;
  const dims = (texture: unknown) =>
    texture === source ? vector(source.width, source.height) : vector(1, 1);
  const scope: Record<string, unknown> = {
    ...Object.fromEntries(
      [...codecSource.matchAll(/const (\w+)\s*=\s*(\d+)u;/g)].map((m) => [m[1], Number(m[2])]),
    ),
    screenCandidateValid: candidateCodec().valid,
    screenCandidateUnpack: candidateCodec().unpack,
    source,
    fields,
    instances: [{}, {}],
    grid: { source: vector(72, 256, 2, input.epoch ?? 7), dimensionsCount: { w: 2 } },
    probeFrame: {
      expectedSource: vector(72, 256, 2, input.epoch ?? 7),
      probes: { w: input.frame ?? 11 },
      query: { z: input.revision ?? 3 },
      extent: { xy: [1, 1] },
      environment: { w: 10 },
    },
    visibleSurface: {},
    receiverSource: source,
    textureDimensions: dims,
    textureLoad: (texture: unknown, pixel: number[]) =>
      texture === source
        ? vector(
            ...source.words.slice(
              ((pixel[1] ?? 0) * source.width + (pixel[0] ?? 0)) * 4,
              ((pixel[1] ?? 0) * source.width + (pixel[0] ?? 0)) * 4 + 4,
            ),
          )
        : vector(input.identity === false ? 0 : 1, 0, 0, 1),
    vec2i: vector,
    i32: Math.trunc,
    vec2u: vector,
    vec3u: vector,
    vec4u: vector,
    vec2f: vector,
    asBits: (v: number[]) => vector(...v.map(bits)),
    arrayLength: (v: unknown[]) => v.length,
    mismatch: (a: number[], b: number[]) => !same(a, b),
    outside: (a: number[], b: number[]) => a.some((v, i) => v >= (b[i] ?? 0)),
    sdfInstanceValid: (row: number) => row < 2,
    sdfInstanceMask: () => 1,
    sdfSurfaceRowAssociated: () => true,
    sdfSurfacePacket: () => packet,
    sdfSurfacePrimitiveOpaque: () => input.opaque !== false,
    sdfSurfaceExpectedDirectory: () => ({ valid: 1 }),
    sdfSurfaceTraceEmpty: empty,
    ScreenEndpoint: (trace: EndpointTrace, tested: number) => ({ trace, tested }),
    SdfSurfaceRay: () => ({ valid: 1 }),
    sdfSurfaceRayUsable: () => true,
    sdfSurfaceLocalRay: () => ({ valid: 1 }),
    sdfSurfaceInverse: () => [],
    sdfFieldWord: (at: number) => fields[at] ?? 0,
    sdfSurfaceVertex: (_packet: unknown, index: number) =>
      vector(...fields.slice(120 + index * 3, 123 + index * 3)),
    sdfSurfaceBitsUsable: (v: number) => {
      const magnitude = v & 0x7fffffff;
      return magnitude === 0 || (magnitude >= 0x00800000 && magnitude <= 0x7f7fffff);
    },
    sdfSurfaceTriangle: () => {
      tests++;
      const exact = exactSurface({
        name: 'canonical-screen-target',
        triangle: vertices,
        origin,
        direction,
        range: [0, 10],
        expected: 'oracle',
      });
      if (exact.kind !== 'hit') return { state: 0 };
      const time = Number(exact.time) / Number(exact.det);
      return { state: 1, tLower: time, tUpper: time, frontFace: exact.frontFace };
    },
  };
  for (const name of [
    'receiverWord',
    'receiverSourceReady',
    'screenReceiverPrimitive',
    'screenProbeEndpoint',
  ]) {
    const code = lower(wgslBody(SCREEN_PROBE_ENDPOINT_WGSL, name))
      .replace(/bitcast<vec[23]u>\(/g, 'asBits(')
      .replace(/any\((expected)!=grid.source\)/g, 'mismatch($1,grid.source)')
      .replace(
        /any\(textureDimensions\(visibleSurface\)!=probeFrame.extent.xy\)/g,
        'mismatch(textureDimensions(visibleSurface),probeFrame.extent.xy)',
      )
      .replace(
        /any\((pixel|indices)>=(probeFrame.extent.xy|vec3u\(packet.positions.y\))\)/g,
        'outside($1,$2)',
      )
      .replace(/&(?=instances|fields)/g, '')
      .replace(/bitcast<vec3u>\(/g, 'asBits(');
    const args =
      name === 'receiverWord'
        ? 'i'
        : name === 'receiverSourceReady'
          ? 'directoryReady'
          : name === 'screenReceiverPrimitive'
            ? 'pixel,directoryReady'
            : 'probe,ray,contact';
    scope[name] = new Function(...Object.keys(scope), `return function(${args}){${code}}`)(
      ...Object.values(scope),
    );
  }
  const run = scope.screenProbeEndpoint as (
    p: unknown,
    r: unknown,
    c: unknown,
  ) => { trace: EndpointTrace; tested: number };
  const result = run(
    {
      receiverRow: 1,
      receiverPrimitive: 0,
      canonicalLo: origin.map(bits),
      canonicalHi: origin.map(bits),
    },
    {
      info: 1024,
      radiance:
        input.payload ??
        candidateCodec().pack(
          vector(0, 0),
          input.candidateFrame ?? 11,
          input.candidateRevision ?? 3,
        ),
      direction,
    },
    { valid: input.contact === false ? 0 : 1, row: 1, primitive: 0 },
  );
  return { ...result, tests };
}
