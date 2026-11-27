import shaderSource from '../../../../shader/src/ray-screen-probe.wgsl?raw';
import { SCREEN_PROBE_RECONSTRUCTION_WGSL } from '../../../../shader/src/screen-probe-reconstruction';
import gbufferSource from '../../../../shader/src/standard-gbuffer.wgsl?raw';

type V3 = readonly [number, number, number];
interface V4 {
  x: number;
  y: number;
  z: number;
  w: number;
  readonly xyz: V3;
}
const v2 = (x: number | { x: number; y: number }, y?: number) =>
  typeof x === 'number' ? { x, y: y ?? x } : { x: x.x, y: x.y };
const v4 = (x: number | V3, y?: number, z?: number, w?: number): V4 => {
  const a: readonly [number, number, number, number] =
    typeof x === 'number' ? [x, y ?? x, z ?? x, w ?? x] : [...x, y ?? 0];
  return {
    x: a[0],
    y: a[1],
    z: a[2],
    w: a[3],
    get xyz(): V3 {
      return [this.x, this.y, this.z];
    },
  };
};
function body(name: string, source = shaderSource) {
  const at = source.indexOf(`fn ${name}(`);
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
const lower = (s: string) =>
  s
    .replace(/\blet\b/g, 'const')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(\d+)u\b/g, '$1');
function execute<T>(code: string, args: string, dependencies: Record<string, unknown>): T {
  return Function(
    ...Object.keys(dependencies),
    `return function(${args}){${lower(code)}}`,
  )(...Object.values(dependencies)) as T;
}
function wordConstant(name: string, source: string): number {
  const value = new RegExp(
    `\\bconst ${name}(?:\\s*:\\s*u32)?\\s*=\\s*(0x[0-9a-fA-F]+|\\d+)u;`,
  ).exec(source)?.[1];
  if (value === undefined) throw Error(`Missing production constant ${name}`);
  return Number(value);
}
const validReceiverBit = wordConstant('STANDARD_GBUFFER_VALID_BIT', gbufferSource);
const classifiedBit = wordConstant('STANDARD_GBUFFER_SCREEN_TRACE_CLASSIFIED_BIT', gbufferSource);
const backfaceDiffuseBit = wordConstant(
  'STANDARD_GBUFFER_SCREEN_TRACE_BACKFACE_DIFFUSE_BIT',
  gbufferSource,
);
const materialShift = wordConstant('SP_META_MATERIAL_SHIFT', shaderSource);
const standardGBufferValid = execute<(packed: { x: number }) => boolean>(
  body('standardGBufferValid', gbufferSource),
  'packed',
  { STANDARD_GBUFFER_VALID_BIT: validReceiverBit },
);
const confidence = execute<(value: V4) => number>(
  body('spReconstructionConfidence', SCREEN_PROBE_RECONSTRUCTION_WGSL)
    .replace('all(value.xyz>=vec3f(0.0))', 'value.xyz.every(x=>x>=0)')
    .replace('all(value.xyz<vec3f(1e30))', 'value.xyz.every(x=>x<1e30)'),
  'value',
  { SP_CONFIDENCE_BASE: 2, SP_CONFIDENCE_MAX: 3 },
);
const signal = execute<(rgb: V3, coverage: number) => V4>(
  body('spReconstructionSignal', SCREEN_PROBE_RECONSTRUCTION_WGSL),
  'rgb,coverage',
  {
    SP_CONFIDENCE_BASE: 2,
    SP_CONFIDENCE_MAX: 3,
    vec4f: v4,
    spReconstructionConfidence: confidence,
  },
);
const bitFloat = (word: number) => new Float32Array(Uint32Array.of(word).buffer)[0] ?? NaN;
const floatBit = (value: number) => new Uint32Array(Float32Array.of(value).buffer)[0] ?? 0;
const distance = (a: V3, b: V3) => Math.hypot(...a.map((v, i) => v - (b[i] ?? NaN)));
const mix = (a: number | V3, b: number | V3, t: number) =>
  typeof a === 'number' && typeof b === 'number'
    ? a * (1 - t) + b * t
    : (a as V3).map((v, i) => v * (1 - t) + ((b as V3)[i] ?? NaN) * t);

export interface TemporalSupportInput {
  readonly current?: readonly [number, number, number, number];
  readonly previous?: readonly [number, number, number, number];
  readonly flags?: number;
  readonly kind?: number;
  readonly frames?: number;
  readonly maxFrames?: number;
  readonly storedDistance?: number;
  readonly normalMatches?: boolean;
  readonly historyUv?: readonly [number, number];
  readonly depth?: number;
  readonly position?: V3;
  readonly normal?: V3;
  readonly validReceiver?: boolean;
}
/** Execute the actual temporal entry with controlled textures, transforms and buffer I/O.
 * This is a CPU branch/accumulation test, not matrix, packing or GPU evidence. */
export function temporalSupport(input: TemporalSupportInput = {}) {
  const historyOut: V4[] = [],
    metaOut: V4[] = [],
    current = v4(...(input.current ?? [2, 4, 6, 2.5])),
    previous = v4(...(input.previous ?? [4, 8, 12, 3]));
  const meta = v4(
    floatBit(input.storedDistance ?? 1),
    input.normalMatches === false ? 2 : 1,
    input.frames ?? 3,
    input.kind ?? 2,
  );
  const text = body('temporalScreenProbeAt')
    .replace('probeFrame.previousViewProj * vec4f(position, 1.0)', 'vec4f(0,0,0,1)')
    .replace('clip.xy / max(clip.w, 1e-8) * vec2f(0.5, -0.5) + vec2f(0.5)', 'historyUv')
    .replace('all(uv >= vec2f(0.0))', 'inside(uv)')
    .replace('all(uv < vec2f(1.0))', 'true')
    .replace('uv * vec2f(extent) - vec2f(0.5)', 'v2(uv.x*extent.x-.5,uv.y*extent.y-.5)')
    .replace('base + vec2i(offset)', 'v2(base.x+offset.x,base.y+offset.y)')
    .replace('any(previous < vec2i(0))', 'previous.x<0||previous.y<0')
    .replace('any(previous >= vec2i(extent))', 'previous.x>=extent.x||previous.y>=extent.y')
    .replace(
      'length(probeFrame.previousCameraPos.xyz - position)',
      'distance(probeFrame.previousCameraPos.xyz,position)',
    )
    .replace('length(view.cameraPos - position)', 'distance(view.cameraPos,position)')
    .replace(
      /history \+= (historyIn\[index\]\.xyz|retained\.xyz) \* (\w+);/,
      'history=history.map((v,c)=>v+$1[c]*$2);',
    )
    .replaceAll('history / supported', 'history.map(v=>v/supported)')
    .replace(
      'all(current == vec4f(0.0))',
      '(current.x===0 && current.y===0 && current.z===0 && current.w===0)',
    )
    .replace('all(abs(position) < vec3f(1e30))', 'finite3(position)')
    .replace('all(abs(normal) < vec3f(1e30))', 'finite3(normal)')
    .replaceAll('bitcast<f32>', 'bitFloat')
    .replaceAll('bitcast<u32>', 'floatBit');
  const screenProbeMetaAo = execute<(kind: number, ao: number) => number>(
    body('screenProbeMetaAo'),
    'kind,ao',
    {
      pack2x16float: () => {
        throw Error('AO is disabled for the temporal-support fixture');
      },
    },
  );
  const flags = input.flags ?? 26,
    cap = input.maxFrames ?? 10;
  const gbufferDepth = {};
  const gbufferNormal = {};
  const packedReceiver = v2(input.validReceiver === false ? 0 : validReceiverBit, 0);
  const dependencies: Record<string, unknown> = {
    integrated: [current],
    historyIn: Array(4).fill(previous),
    metaIn: Array(4).fill(meta),
    historyOut,
    metaOut,
    spLinearId: () => 0,
    extentSize: () => v2(2, 2),
    gbufferMatches: () => true,
    gbufferDepth,
    gbufferNormal,
    textureLoad: (texture: object) =>
      texture === gbufferNormal ? { rg: packedReceiver } : (input.depth ?? 0.5),
    worldPosition: () => input.position ?? [0, 0, 0],
    standardGBufferValid,
    decodeStandardGBufferNormal: () => v4(input.normal ?? [0, 0, 1], 0),
    STANDARD_GBUFFER_SCREEN_TRACE_MASK: classifiedBit | backfaceDiffuseBit,
    SP_META_MATERIAL_SHIFT: materialShift,
    SP_META_MATERIAL_CLASSIFIED: classifiedBit >>> materialShift,
    SP_META_MATERIAL_BACKFACE_DIFFUSE: backfaceDiffuseBit >>> materialShift,
    validDepth: execute<(z: number) => boolean>(body('validDepth'), 'z', {}),
    finite3: (v: V3) => v.every((x) => Math.abs(x) < 1e30),
    view: { cameraPos: [0, 0, 1] },
    probeFrame: {
      control: v4(0, 0, flags, cap),
      previousCameraPos: v4(0, 0, 1, 1),
      query: v4(0),
    },
    screenProbeMetaAo,
    SCENE_VELOCITY_INVALID_DEPTH: 0xffffffff,
    sceneVelocityPreviousDepth: (word: number) => bitFloat((word & 0x7fffffff) - 1),
    SP_META_KIND_MASK: 3,
    SP_META_AO_VALID: 4,
    SP_META_FAST_UPDATE_SHIFT: wordConstant('SP_META_FAST_UPDATE_SHIFT', shaderSource),
    ceil: Math.ceil,
    round: Math.round,
    u32: Math.trunc,
    spCurrentSupport: (value: number) => (value & 8) !== 0,
    spReconstructionConfidence: confidence,
    spReconstructionSignal: signal,
    pixelHistoryCap: () => Math.max(1, Math.min(64, cap)),
    vec2u: v2,
    vec2i: v2,
    vec2f: v2,
    vec3f: (value: number) => [value, value, value],
    vec4f: v4,
    vec4u: v4,
    v2,
    bitFloat,
    floatBit,
    distance,
    historyUv: v2(...(input.historyUv ?? [0.25, 0.25])),
    inside: (v: { x: number; y: number }) => v.x >= 0 && v.y >= 0 && v.x < 1 && v.y < 1,
    floor: (v: { x: number; y: number }) => v2(Math.floor(v.x), Math.floor(v.y)),
    fract: (v: { x: number; y: number }) => v2(v.x - Math.floor(v.x), v.y - Math.floor(v.y)),
    pixelIndex: (v: { x: number; y: number }) => v.y * 2 + v.x,
    unpackNormal: (word: number) => (word === 2 ? [0, 0, -1] : [0, 0, 1]),
    packNormal: () => 1,
    dot: (a: V3, b: V3) => a.reduce((sum, v, i) => sum + v * (b[i] ?? NaN), 0),
    abs: Math.abs,
    min: Math.min,
    max: Math.max,
    f32: Number,
    mix,
    select: <T>(a: T, b: T, test: boolean) => (test ? b : a),
  };
  if (SCREEN_PROBE_RECONSTRUCTION_WGSL.includes('fn spReconstructionTemporalAlpha('))
    dependencies.spReconstructionTemporalAlpha = execute(
      body('spReconstructionTemporalAlpha', SCREEN_PROBE_RECONSTRUCTION_WGSL),
      'currentConfidence,historyConfidence,count',
      { max: Math.max, f32: Number },
    );
  const temporalScreenProbeAt = execute<
    (i: number, ao: V4, velocity: V4, moving: number, useFastUpdate: boolean) => void
  >(text, 'i,currentAo,velocity,pixelMoving,useFastUpdate', dependencies);
  execute<(gid: number, groups: number) => void>(body('temporalScreenProbes'), 'gid,groups', {
    spLinearId: dependencies.spLinearId,
    temporalScreenProbeAt,
    vec3f: v4,
    vec2u: v4,
  })(0, 1);
  const value = historyOut[0],
    state = metaOut[0];
  if (value === undefined || state === undefined)
    throw Error('Actual temporal entry did not publish its output');
  return {
    value: [value.x, value.y, value.z, value.w] as const,
    meta: [state.x, state.y, state.z, state.w] as const,
    confidence: confidence(value),
  };
}
