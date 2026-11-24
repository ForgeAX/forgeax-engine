import compositeSource from '../../../../shader/src/ray-diffuse-composite.wgsl?raw';
import shaderSource from '../../../../shader/src/ray-screen-probe.wgsl?raw';
import {
  SCREEN_PROBE_CURRENT_SUPPORT_MASK,
  SCREEN_PROBE_RECONSTRUCTION_WGSL,
} from '../../../../shader/src/screen-probe-reconstruction';
import {
  isPolicyCull,
  POLICY_CULL_SUPPORT,
  projectedCullBound,
} from './screen-probe-angular-plan.fixture';
import { packPointRadiance } from './screen-probe-radiance.fixture';
import { type ResolveSnapshot, resolveRayCells } from './screen-probe-resolve.fixture';

export const screenProbeSupportSource = shaderSource;

type V3 = readonly [number, number, number];
interface V4 {
  x: number;
  y: number;
  z: number;
  w: number;
  readonly xyz: V3;
}
interface Packet {
  samples: { x: number; y: number }[];
  support: number;
  hitDistance?: number;
}

export const supportNormal = (v: V3): V3 => {
  const size = Math.hypot(...v);
  return [Math.fround(v[0] / size), Math.fround(v[1] / size), Math.fround(v[2] / size)];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const select = <T>(a: T, b: T, choose: boolean) => (choose ? b : a);
function oct(x: number, y: number): V3 {
  const z = 1 - Math.abs(x) - Math.abs(y);
  return supportNormal(
    z < 0
      ? [(1 - Math.abs(y)) * Math.sign(x || 1), (1 - Math.abs(x)) * Math.sign(y || 1), z]
      : [x, y, z],
  );
}
const direction = (texel: number) =>
  oct(((texel % 8) + 0.5) / 4 - 1, (Math.floor(texel / 8) + 0.5) / 4 - 1);
function vector(a: number | V3, b?: number, c?: number, d?: number): V4 {
  const values = typeof a === 'number' ? [a, b ?? a, c ?? a, d ?? a] : [a[0], a[1], a[2], b ?? 0];
  return {
    x: values[0] ?? 0,
    y: values[1] ?? 0,
    z: values[2] ?? 0,
    w: values[3] ?? 0,
    get xyz(): V3 {
      return [this.x, this.y, this.z];
    },
  };
}
const add = (a: V4, b: V4) => vector(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w);
const multiply = (a: V4, n: number) => vector(a.x * n, a.y * n, a.z * n, a.w * n);
const float = (n: number) => new Float32Array(Uint32Array.of(n).buffer)[0] ?? NaN;
function body(name: string, source = shaderSource) {
  const at = source.search(new RegExp(`\\bfn\\s+${name}\\b`));
  if (at < 0) throw Error(`Missing production function ${name}`);
  const start = source.indexOf('{', at);
  let end = start + 1,
    depth = 1;
  for (; depth; end++) {
    if (end >= source.length) throw Error('Unclosed production function');
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  return source.slice(start + 1, end - 1);
}
const lower = (text: string) =>
  text
    .replace(/\blet\b/g, 'const')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1')
    .replace(/bitcast<f32>\(/g, 'float(');
function executable<T>(text: string, args: string, dependencies: Record<string, unknown>): T {
  return Function(
    ...Object.keys(dependencies),
    `return function(${args}){${lower(text)}}`,
  )(...Object.values(dependencies)) as T;
}

const reconstructionSourceControl = executable<
  (expected: V4, control: V4, frame: number, revision: number, source: V4, flags: number) => boolean
>(
  body('spReconstructionSource', SCREEN_PROBE_RECONSTRUCTION_WGSL)
    .replaceAll(/all\((source|expected|control)==vec4u\(0u\)\)/g, 'zero4($1)')
    .replace('all(expected==source)', 'same4(expected,source)'),
  'expected,control,frame,revision,source,flags',
  {
    SP_CURRENT_SUPPORT_MASK: SCREEN_PROBE_CURRENT_SUPPORT_MASK,
    zero4: (value: V4) => value.x === 0 && value.y === 0 && value.z === 0 && value.w === 0,
    same4: (a: V4, b: V4) => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w,
  },
);

export function hardwareSourceEligibility(flags: number) {
  const zero = vector(0);
  return reconstructionSourceControl(zero, zero, 0, 0, zero, flags);
}

export function softwareReceiverEligibility(kind: number, flags: number, frame = 11) {
  const source = vector(72, 256, 1, 7);
  return reconstructionSourceControl(source, vector(kind, frame, 1, 3), 11, 3, source, flags);
}

/** Actual production control with independent octahedral arithmetic dependencies.
 * This is a finite Point40/control oracle, not GPU rounding or mixture emulation. */
const mayContribute = executable<(texel: number, normal: V3) => boolean>(
  body('probeCellMayContribute')
    .replace('texel/8u', 'Math.floor(texel/8)')
    .replace(
      '(cell+vec2f(f32(corner&1u),f32(corner>>1u)))/4.0-vec2f(1.0)',
      'cornerUv(cell,corner)',
    ),
  'texel,normal',
  {
    vec2f: (a: number, b = a) => [a, b],
    f32: Math.fround,
    dot,
    spOctDecode: (p: readonly [number, number]) => oct(p[0], p[1]),
    cornerUv: (cell: readonly [number, number], corner: number) => [
      (cell[0] + (corner & 1)) / 4 - 1,
      (cell[1] + (corner >> 1)) / 4 - 1,
    ],
  },
);

export function angularAllocation(
  normal: V3,
  brdf = true,
  guide: readonly [number, number, number, number] = [0, 0, 0, 0],
) {
  const source = body('generateProbeRays'),
    first = source.indexOf('let brdf =');
  const prefix = source.slice(first);
  const roster = body('generateProbeRaySlots');
  const publish = roster.slice(0, roster.indexOf('// Publish eligibility'));
  const rankFirst = roster.indexOf('var culled =');
  const rank = roster
    .slice(rankFirst, roster.indexOf('workgroupBarrier();', rankFirst))
    .replace('culled / 3u', 'Math.floor(culled/3)');
  const priorities = Array<number>(64).fill(-1),
    slots = Array<number>(64).fill(0);
  let cacheQueries = 0;
  const deps = {
    probe: 0,
    probeFrame: { control: { x: Number(brdf) } },
    record: { position: [0, 0, 0], normal },
    live: true,
    texelPdf: priorities,
    texelSlots: slots,
    select,
    max: Math.max,
    dot,
    texelDirection: direction,
    probeCellMayContribute: mayContribute,
    float,
    vec3f: (x: number, y = x, z = x) => [x, y, z],
    // Guide values below are controlled host inputs; this CPU schedule gate
    // does not execute or qualify the GPU visibility preparation cache.
    prepareIrradianceFieldProbeVisibility: () => {},
    probeGuideCache: () => {
      cacheQueries++;
      return vector(...guide);
    },
  };
  const publishPriority = executable<(texel: number, priority: number) => void>(
    publish,
    'texel,priority',
    deps,
  );
  const prepare = executable<(texel: number) => void>(prefix, 'texel', {
    ...deps,
    generateProbeRaySlots: (
      _probe: number,
      texel: number,
      _record: unknown,
      _live: boolean,
      priority: number,
    ) => publishPriority(texel, priority),
    probeGuideLuminance: executable<(rgb: V3) => number>(body('probeGuideLuminance'), 'rgb', {
      dot,
      vec3f: deps.vec3f,
      max: Math.max,
    }),
  });
  const assign = executable<(texel: number) => void>(rank, 'texel', deps);
  for (let t = 0; t < 64; t++) prepare(t);
  for (let t = 0; t < 64; t++) assign(t);
  return {
    priorities,
    slots,
    cacheQueries,
    required: slots.map((_n, t) => !brdf || mayContribute(t, normal)),
    centerCosines: slots.map((_n, t) => dot(direction(t), normal)),
    total: slots.reduce((a, b) => a + b, 0),
  };
}

function points(
  allocation: ReturnType<typeof angularAllocation>,
  unknown?: number | readonly number[],
  radiance: (texel: number) => V3 = () => [1, 1, 1],
): Packet[] {
  const logical = new Float32Array(64 * 8);
  for (let t = 0; t < 64; t++) {
    const missing = typeof unknown === 'number' ? t === unknown : unknown?.includes(t);
    const age = missing ? -2 : (allocation.slots[t] ?? 0) > 0 ? 1 : 0;
    logical.set([...radiance(t), age, -1, 1], t * 8);
  }
  const packed = packPointRadiance(logical, 1),
    words = new Uint32Array(packed.buffer);
  return Array.from({ length: 64 }, (_, t) => ({
    support: packed[t * 10 + 8] ?? 0,
    samples: Array.from({ length: 4 }, (_, i) => ({
      x: words[t * 10 + i * 2] ?? 0,
      y: words[t * 10 + i * 2 + 1] ?? 0,
    })),
  }));
}

export function sameNormalQuadrature(
  normal: V3,
  queryNormal = normal,
  unknown?: number | readonly number[],
  reconstruction = false,
  radiance?: (texel: number) => V3,
  stale: 'source' | 'pose-frame' | undefined = undefined,
  replacements: ReadonlyMap<number, ResolveSnapshot> = new Map(),
  hardware?: {
    readonly flags?: number;
    readonly source?: readonly [number, number, number, number];
    readonly live?: boolean;
    readonly pixelValid?: boolean;
    readonly extentMatches?: boolean;
    readonly depth?: number;
    readonly distance?: number;
  },
) {
  const allocation = angularAllocation(normal),
    packets = points(allocation, unknown, radiance);
  for (const [texel, replacement] of replacements) {
    const code = encodePointDirection(replacement.direction);
    const words = new Uint32Array(Float32Array.from(replacement.weighted).buffer);
    packets[texel] = {
      samples: [
        { x: words[0] ?? 0, y: words[1] ?? 0 },
        { x: words[2] ?? 0, y: words[3] ?? 0 },
        { x: replacement.policyCullTexel ?? code, y: 0 },
        { x: 0, y: 0 },
      ],
      support: replacement.age,
      hitDistance: -1,
    };
  }
  const weighted = (p: Packet) =>
    vector(
      float(p.samples[0]?.x ?? 0),
      float(p.samples[0]?.y ?? 0),
      float(p.samples[1]?.x ?? 0),
      float(p.samples[1]?.y ?? 0),
    );
  const dependencies = {
    probeFrame: {
      control: { z: hardware?.flags ?? (reconstruction ? SCREEN_PROBE_CURRENT_SUPPORT_MASK : 0) },
      probes: { w: 5 },
      query: { z: 7 },
      expectedSource: hardware
        ? vector(...(hardware.source ?? [0, 0, 0, 0]))
        : vector(36, 32, 1, 9),
    },
    cvIs: () => false,
    distributionUnsupported: (p: Packet) => (p.samples[3]?.y ?? 0) >>> 30 === 1,
    distributionIsSet: (p: Packet) => ((p.samples[3]?.y ?? 0) & 0x80000000) !== 0,
    distributionAge: (p: Packet) => p.support,
    distributionPointWeighted: weighted,
    cvMass: (p: Packet) => weighted(p).w,
    distributionOctDecode: (code: number, res: number) =>
      oct((code & res) * (2 / res) - 1, ((code >>> 10) & res) * (2 / res) - 1),
    DistributionQuery: (value: V4, support: number) => ({ weighted: value, support }),
    vec4f: vector,
    length: (v: V3) => Math.hypot(...v),
    dot,
    max: Math.max,
    min: Math.min,
    sqrt: Math.sqrt,
    select,
    mul4: multiply,
  };
  const querySource = body('distributionQuery');
  const pointQuery = querySource
    .slice(0, querySource.indexOf('for(var i=0u;i<distributionCount(p);i++)'))
    .replace(
      'distributionPointWeighted(p) * max(cosine, 0.0)',
      'mul4(distributionPointWeighted(p),max(cosine,0.0))',
    );
  const query = executable<(p: Packet, normal: V3) => { weighted: V4; support: number }>(
    pointQuery,
    'p,normal',
    dependencies,
  );
  const finiteBody = (text: string) =>
    text
      .replace(/all\(value.xyz>=vec3f\(0.0\)\)/g, 'allAtLeast(value.xyz,0)')
      .replace(/all\(value.xyz<vec3f\(1e30\)\)/g, 'allLess(value.xyz,1e30)')
      .replace(/all\(query.weighted>=vec4f\(0.0\)\)/g, 'allAtLeast(query.weighted,0)')
      .replace(/all\(query.weighted<vec4f\(1e30\)\)/g, 'allLess(query.weighted,1e30)');
  const reconstructionDependencies = {
    ...dependencies,
    SP_CURRENT_SUPPORT_MASK: SCREEN_PROBE_CURRENT_SUPPORT_MASK,
    SP_CONFIDENCE_BASE: 2,
    SP_CONFIDENCE_MAX: 3,
    allAtLeast: (v: V3 | V4, n: number) =>
      ('x' in v ? [v.x, v.y, v.z, v.w] : v).every((value) => value >= n),
    allLess: (v: V3 | V4, n: number) =>
      ('x' in v ? [v.x, v.y, v.z, v.w] : v).every((value) => value < n),
    clamp: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
    filteredProbeRadiance: packets,
    probesIn: [
      {
        normal,
        receiverExpected: hardware ? vector(0) : vector(36, 32, 1, stale === 'source' ? 10 : 9),
        receiverControl: hardware ? vector(0) : vector(1, stale === 'pose-frame' ? 4 : 5, 1, 7),
        pixel: hardware?.pixelValid === false ? 0xffffffff : 0,
        distance: hardware?.distance ?? 1,
      },
    ],
    probeCellMayContribute: mayContribute,
    distributionQuery: query,
    add4: add,
    div3: (v: V3, n: number): V3 => [v[0] / n, v[1] / n, v[2] / n],
  };
  const confidence = executable<(value: V4) => number>(
    finiteBody(body('spReconstructionConfidence', SCREEN_PROBE_RECONSTRUCTION_WGSL)),
    'value',
    reconstructionDependencies,
  );
  const signal = executable<(rgb: V3, coverage: number) => V4>(
    body('spReconstructionSignal', SCREEN_PROBE_RECONSTRUCTION_WGSL),
    'rgb,coverage',
    { ...reconstructionDependencies, spReconstructionConfidence: confidence },
  );
  const measure = executable<(record: Packet, direction: V3) => number>(
    body('distributionProjectedMeasure'),
    'record,direction',
    reconstructionDependencies,
  );
  const currentSupport = executable<(probe: number, direction: V3) => V4>(
    finiteBody(body('probeCurrentSupportAt'))
      .replace('weighted+=query.weighted', 'weighted=add4(weighted,query.weighted)')
      .replace('weighted.xyz/weighted.w', 'div3(weighted.xyz,weighted.w)'),
    'probe,direction',
    {
      ...reconstructionDependencies,
      SUPPORT_POLICY_CULL: POLICY_CULL_SUPPORT,
      distributionIsPolicyCull: isPolicyCull,
      probePolicyCullProjectedBound: projectedCullBound,
      distributionProjectedMeasure: measure,
      spReconstructionSignal: signal,
      probeCurrentSupportHardware: executable(
        body('probeCurrentSupportHardware').replace(
          'any(pixel>=extentSize())',
          'pixelOutside(pixel)',
        ),
        'probe',
        {
          probesIn: reconstructionDependencies.probesIn,
          probeLive: () => hardware?.live !== false,
          gbufferMatches: () => hardware?.extentMatches !== false,
          unpackPixel: (pixel: number) => [pixel & 0xffff, pixel >>> 16],
          pixelOutside: (pixel: readonly number[]) => pixel.some((word) => word >= 4),
          validDepth: (depth: number) => depth > 0 && depth < 1,
          textureLoad: () => hardware?.depth ?? 0.5,
          gbufferDepth: {},
          vec2i: (pixel: readonly number[]) => pixel,
        },
      ),
      spReconstructionSource: reconstructionSourceControl,
    },
  );
  const loop = body('probeIrradianceAt')
    .replace('weighted+=query.weighted', 'weighted=add4(weighted,query.weighted)')
    .replace('weighted.xyz/weighted.w', 'div3(weighted.xyz,weighted.w)');
  const evaluate = executable<(probe: number, direction: V3) => V4>(loop, 'probe,direction', {
    ...dependencies,
    spCurrentSupport: (flags: number) => (flags & SCREEN_PROBE_CURRENT_SUPPORT_MASK) !== 0,
    probeCurrentSupportAt: currentSupport,
    filteredProbeRadiance: packets,
    probeCellMayContribute: mayContribute,
    distributionQuery: query,
    add4: add,
    div3: (v: V3, n: number): V3 => [v[0] / n, v[1] / n, v[2] / n],
  });
  return { allocation, value: evaluate(0, queryNormal) };
}

function encodePointDirection(v: V3) {
  const l1 = Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
  let x = v[0] / l1,
    y = v[1] / l1;
  if (v[2] < 0)
    [x, y] = [(1 - Math.abs(y)) * Math.sign(x || 1), (1 - Math.abs(x)) * Math.sign(y || 1)];
  return Math.round((x * 0.5 + 0.5) * 1023) | (Math.round((y * 0.5 + 0.5) * 1023) << 10);
}

/** Execute the actual resolver control with controlled buffer/cache/packet I/O.
 * Packet bit transport and GPU rounding remain separate GPU checks. */
export function resolveFallbackCell(
  texel: number,
  rayDirection: V3,
  reconstruct = true,
  fallback: readonly [number, number, number, number] = [0, 0, 0, 0],
  assigned = true,
  assignedCount = 1,
) {
  const input = Array.from({ length: 64 }, (_, i) => ({
    info: i < assignedCount && assigned ? texel | (i << 6) | 512 | (2 << 12) : 3 << 12,
    direction: rayDirection,
    radiance: [0, 0, 0] as V3,
    hitDistance: -1,
  }));
  const result = resolveRayCells(input, reconstruct, fallback).output[texel];
  if (!result) throw Error('Resolver did not write its actual output');
  return result;
}

/** Executes the actual finite codec and reconstructed-signal consumer, without shading. */
export function compositeCurrentSupport(values: readonly [number, number, number, number]) {
  const confidence = executable<(value: V4) => number>(
    body('spReconstructionConfidence', SCREEN_PROBE_RECONSTRUCTION_WGSL)
      .replace('all(value.xyz>=vec3f(0.0))', 'value.xyz.every(v=>v>=0)')
      .replace('all(value.xyz<vec3f(1e30))', 'value.xyz.every(v=>v<1e30)'),
    'value',
    { SP_CONFIDENCE_BASE: 2, SP_CONFIDENCE_MAX: 3 },
  );
  const value = vector(...values);
  return executable<() => V4>(
    body('reconstructedIrradiance', compositeSource)
      .replace('&accumulation', 'accumulation')
      .replace('in.position.xy', 'null')
      .replace('bitcast<vec4f>', 'identity'),
    '',
    {
      textureDimensions: () => vector(1, 1),
      depth: null,
      arrayLength: (array: unknown[]) => array.length,
      accumulation: [value],
      vec2u: () => vector(0, 0),
      vec4f: vector,
      identity: (v: V4) => v,
      spReconstructionConfidence: confidence,
    },
  )();
}

/** Actual plane/normal gate; visibility needs the live scene query in GPU evidence. */
export function currentSupportAgreement(normal: V3, receiverNormal: V3) {
  return executable<(probe: unknown, position: V3, normal: V3, distance: number) => number>(
    body('probeAgreement').replace(
      'probe.position - position',
      'subtract(probe.position,position)',
    ),
    'probe,position,normal,distance',
    {
      SCREEN_PROBE_NONE: 0xffffffff,
      abs: Math.abs,
      exp: Math.exp,
      max: Math.max,
      dot,
      subtract: (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    },
  )({ pixel: 0, position: [0, 0, 0], normal }, [0, 0, 0], receiverNormal, 1);
}
