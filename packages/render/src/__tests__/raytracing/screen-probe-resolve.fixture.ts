import shaderSource from '../../../../shader/src/ray-screen-probe.wgsl?raw';
import { SCREEN_PROBE_CURRENT_SUPPORT_MASK } from '../../../../shader/src/screen-probe-reconstruction';
import {
  type PlanReceiver,
  plannedCull,
  policyCullPacket,
} from './screen-probe-angular-plan.fixture';

type V3 = readonly [number, number, number];
interface V4 {
  x: number;
  y: number;
  z: number;
  w: number;
  readonly xyz: V3;
}
export interface ResolveSnapshot {
  readonly weighted: readonly [number, number, number, number];
  readonly direction: V3;
  readonly age: number;
  readonly policyCullTexel?: number;
}
function vector(a: number | V3, b?: number, c?: number, d?: number): V4 {
  const v = typeof a === 'number' ? [a, b ?? a, c ?? a, d ?? a] : [...a, b ?? 0];
  return {
    x: v[0] ?? 0,
    y: v[1] ?? 0,
    z: v[2] ?? 0,
    w: v[3] ?? 0,
    get xyz(): V3 {
      return [this.x, this.y, this.z];
    },
  };
}
const multiply = (v: V4, n: number) => vector(v.x * n, v.y * n, v.z * n, v.w * n);
const add = (a: V4, b: V4) => vector(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w);
const select = <T>(a: T, b: T, c: boolean) => (c ? b : a);
function direction(texel: number): V3 {
  const p = [((texel % 8) + 0.5) / 4 - 1, (Math.floor(texel / 8) + 0.5) / 4 - 1];
  let x = p[0] ?? 0,
    y = p[1] ?? 0;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0)
    [x, y] = [(1 - Math.abs(y)) * Math.sign(x || 1), (1 - Math.abs(x)) * Math.sign(y || 1)];
  const r = Math.hypot(x, y, z);
  return [Math.fround(x / r), Math.fround(y / r), Math.fround(z / r)];
}
function body(name: string) {
  const at = shaderSource.indexOf(`fn ${name}(`);
  if (at < 0) throw Error(`Missing production function ${name}`);
  const first = shaderSource.indexOf('{', at);
  let end = first + 1,
    depth = 1;
  for (; depth; end++) {
    if (end >= shaderSource.length) throw Error('Unclosed production function');
    if (shaderSource[end] === '{') depth++;
    if (shaderSource[end] === '}') depth--;
  }
  return shaderSource.slice(first + 1, end - 1);
}
function executable<T>(text: string, args: string, deps: Record<string, unknown>): T {
  const lower = text
    .replace(/\blet\b/g, 'const')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1');
  return Function(
    ...Object.keys(deps),
    `return function(${args}){${lower}}`,
  )(...Object.values(deps)) as T;
}
export interface ResolveRayInput {
  readonly info: number;
  readonly direction: V3;
  readonly radiance: V3;
  readonly hitDistance: number;
}

/** Runs the production resolver control in barrier-separated workgroup phases.
 * Atomics only build integer membership; this is not GPU execution or rounding. */
export function resolveRayCells(
  input: readonly ResolveRayInput[],
  reconstruct = true,
  fallback: readonly [number, number, number, number] = [0, 0, 0, 0],
  live = true,
  capacity = 1,
  policy?: { readonly receiver: PlanReceiver; readonly ready?: boolean; readonly brdf?: boolean },
) {
  if (input.length !== 64) throw Error('A probe has exactly sixty-four physical ray slots');
  const output: ResolveSnapshot[] = [];
  const loaded: number[] = [];
  const masks = {
    resolveRayMaskLo: Array<number>(64).fill(0xffffffff),
    resolveRayMaskHi: Array<number>(64).fill(0xffffffff),
  };
  const source = body('resolveProbeRays')
    .replace('var beams:array<DistributionBeam,4>', 'var beams=Array(4)')
    .replace(/vec4f\(([^;\n]+)\)\*beam.measure/g, 'mul4(vec4f($1),beam.measure)')
    .replace(/vec4f\(([^;\n]+)\)\*beams\[i\].measure/g, 'mul4(vec4f($1),beams[i].measure)')
    .replace('weighted+=', 'weighted=add4(weighted,')
    .replace(
      'mul4(vec4f(beams[i].radiance,1.0),beams[i].measure);',
      'mul4(vec4f(beams[i].radiance,1.0),beams[i].measure));',
    )
    .replace(
      'all(beams[i].direction==beams[0].direction)',
      'same3(beams[i].direction,beams[0].direction)',
    )
    .replace('weighted/f32(assigned)', 'div4(weighted,assigned)')
    .replace(
      'vec4f(fallback.xyz,1.0)*screenProbeAngularMeasure(direction)',
      'mul4(vec4f(fallback.xyz,1.0),screenProbeAngularMeasure(direction))',
    )
    .replace('&packet', 'packet')
    .replace(
      'all((bitcast<vec4u>(fallback)&vec4u(0x7fffffffu))<vec4u(bitcast<u32>(1e30)))',
      'finiteFallback(fallback)',
    )
    .replace(/atomicStore\(&(resolveRayMask\w+)\[texel\],0u\)/g, 'atomicStore($1,texel,0)')
    .replace(/atomicOr\(&(resolveRayMask\w+)\[([^\]]+)\],([^;]+)\)/g, 'atomicOr($1,$2,$3)')
    .replace(/atomicLoad\(&(resolveRayMask\w+)\[texel\]\)/g, '$1[texel]');
  const dependencies = {
    probeFrame: { probes: { x: capacity, y: 0 }, control: { z: reconstruct ? 8 : 0 } },
    probesIn: [{ position: [0, 0, 0], normal: [0, 0, 1] }],
    raysIn: new Proxy(input, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) loaded.push(Number(key));
        return Reflect.get(target, key);
      },
    }),
    radianceOut: output,
    spGroupId: () => 0,
    probeLive: () => live,
    probePolicyCull: (_probe: number, texel: number) =>
      policy !== undefined && plannedCull(policy.receiver, texel, policy.ready, policy.brdf),
    distributionPolicyCull: (texel: number): ResolveSnapshot => {
      const packet = policyCullPacket(texel);
      return {
        weighted: [0, 0, 0, 0],
        direction: direction(texel),
        age: packet.support,
        policyCullTexel: texel,
      };
    },
    finiteFallback: (v: V4) => [v.x, v.y, v.z, v.w].every((n) => Math.abs(n) < 1e30),
    ...masks,
    atomicStore: (array: number[], index: number, value: number) => {
      array[index] = value >>> 0;
    },
    atomicOr: (array: number[], index: number, value: number) => {
      array[index] = ((array[index] ?? 0) | value) >>> 0;
    },
    firstTrailingBit: (word: number) => 31 - Math.clz32((word & -word) >>> 0),
    spCurrentSupport: (flags: number) => (flags & SCREEN_PROBE_CURRENT_SUPPORT_MASK) !== 0,
    RAY_USED: 512,
    STATUS_INCOMPLETE: 4,
    STATUS_FALLBACK: 2,
    STATUS_RESOLVED: 0,
    rayStatus: (info: number) => (info >>> 12) & 7,
    screenProbeAngularMeasure: (v: V3) => (Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2])) ** 3,
    sampleRadianceCacheAt: () => vector(...fallback),
    DistributionBeam: (radiance: V3, availability: number, direction: V3, measure: number) => ({
      radiance,
      availability,
      direction,
      measure,
    }),
    distributionPoint: (value: V4, direction: V3, age: number): ResolveSnapshot => ({
      weighted: [value.x, value.y, value.z, value.w],
      direction,
      age,
    }),
    distributionSet: (
      beams: { direction: V3; measure: number }[],
      age: number,
    ): ResolveSnapshot => ({
      weighted: [
        0,
        0,
        0,
        beams.filter(Boolean).reduce((sum, beam) => sum + beam.measure, 0) /
          beams.filter(Boolean).length,
      ],
      direction: beams[0]?.direction ?? [0, 0, 1],
      age,
    }),
    setDistributionMetadata: () => {},
    vec3f: (x: number) => [x, x, x],
    vec4f: vector,
    f32: Math.fround,
    select,
    texelDirection: direction,
    mul4: multiply,
    add4: add,
    div4: (v: V4, s: number) => multiply(v, 1 / s),
    same3: (a: V3, b: V3) => a.every((n, i) => n === b[i]),
  };
  const phases = source.split('workgroupBarrier();');
  if (phases.length !== 1 && phases.length !== 3)
    throw Error('Unexpected production resolver barrier phases');
  const common = phases.length === 3 ? source.slice(0, source.indexOf('atomicStore(')) : '';
  for (const [index, phase] of phases.entries()) {
    const evaluate = executable<(wid: number, texel: number, groups: number) => void>(
      (index === 0 ? '' : common) + phase,
      'wid,texel,groups',
      dependencies,
    );
    for (let texel = 0; texel < 64; texel++) evaluate(0, texel, 1);
  }
  return { output, loaded };
}
