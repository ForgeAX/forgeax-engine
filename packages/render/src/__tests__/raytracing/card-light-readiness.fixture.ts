import { executable, rootBits } from '../../../../shader/src/__tests__/sdf-surface-root.fixture';
import {
  CARD_RADIOSITY_LIGHTING_WGSL,
  cardRadiosityKernelSources,
} from '../../raytracing/card-radiosity-kernels';
import { CARD_RADIOSITY_FINITE_WGSL } from '../../raytracing/card-radiosity-links';
import { cardLinkConsumer } from './card-radiosity-links.fixture';

type V = number[] & { x: number; y: number; z: number; w: number; xyz: V };
export function lightVector(...parts: (number | readonly number[])[]): V {
  const v = parts.flatMap((p) => (typeof p === 'number' ? [p] : [...p])).map(Math.fround) as V;
  for (const [i, name] of ['x', 'y', 'z', 'w'].entries())
    Object.defineProperty(v, name, { get: () => v[i] ?? 0 });
  Object.defineProperty(v, 'xyz', { get: () => lightVector(...v.slice(0, 3)) });
  return v;
}
function sized(count: number, ...parts: (number | readonly number[])[]): V {
  const a = parts.flatMap((p) => (typeof p === 'number' ? [p] : [...p]));
  return lightVector(
    ...(a.length === 1 ? Array<number>(count).fill(a[0] ?? 0) : a.slice(0, count)).map(Math.fround),
  );
}
// WGSL max may choose the non-NaN operand. Exercise that permitted path explicitly.
function maximum(a: number | V, b: number | V): number | V {
  if (typeof a === 'number' && typeof b === 'number')
    return Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b);
  if (typeof a === 'number' || typeof b === 'number')
    throw Error('Matching vector operands required');
  return lightVector(
    ...a.map((v, i) =>
      Number.isNaN(v) ? (b[i] ?? 0) : Number.isNaN(b[i] ?? 0) ? v : Math.max(v, b[i] ?? 0),
    ),
  );
}
export const lightEpoch = (epoch: number) =>
  new Float32Array(Uint32Array.of(epoch).buffer)[0] ?? NaN;
function composition(removeFiniteGate = false, removeRangeGate?: 'product' | 'sum') {
  const original = CARD_RADIOSITY_FINITE_WGSL + CARD_RADIOSITY_LIGHTING_WGSL;
  let source = removeFiniteGate
    ? original.replace('!supported||!cardLightingFiniteRgb(incident)', '!supported')
    : original;
  if (removeRangeGate) {
    const name = removeRangeGate === 'product' ? 'Product' : 'Sum';
    const gate = new RegExp(`if\\(!cardLighting${name}Safe[^\\n]+?\\)\\{return out;\\}`);
    if (!gate.test(source)) throw Error('Actual range gate required');
    source = source.replace(gate, '');
  }
  const deps: Record<string, unknown> = {
    rootBits,
    i32: (value: number) => value | 0,
    float: lightEpoch,
    max: maximum,
    vec3f: (...v: (number | V)[]) => sized(3, ...v),
    vec4f: (...v: (number | V)[]) => sized(4, ...v),
    CardRadiosityLighting: (value: V, history: V) => ({ value, history }),
  };
  for (const [name, args] of [
    ['cardRadiosityFinite', 'value'],
    ['cardLightingFiniteRgb', 'value'],
    ['cardLightingFiniteSh', 'value'],
    ['cardLightingBaseReady', 'valid,direct'],
    ['cardLightingProductSafe', 'a,b'],
    ['cardLightingSumSafe', 'a,b'],
    ['cardLightingChannel', 'albedo,incident'],
    ['cardRadiosityLighting', 'valid,direct,albedo,incident,supported,epoch'],
  ]) {
    if (!name || args === undefined) throw Error('Explicit helper signature required');
    const actual = executable(source, name, args, deps);
    deps[name] =
      name === 'cardLightingChannel'
        ? (...values: unknown[]) => Math.fround(actual(...values) as number)
        : actual;
  }
  return deps;
}
export interface LightReadinessCase {
  readonly direct?: readonly number[];
  readonly valid?: number;
  readonly albedo?: readonly number[];
  readonly incident?: readonly number[];
  readonly weight?: number;
  readonly epoch?: number;
  readonly link?: number;
  readonly linkEpoch?: number;
  readonly linkModel?: number;
  readonly probeEpoch?: number;
  readonly probeModel?: number;
}
/** Execute the actual scalar publication suffix after the actual model/link
 * predicates. Intrinsic vector arithmetic rounds to f32; not GPU emulation. */
export function resolveLighting(
  input: LightReadinessCase,
  removeFiniteGate = false,
  removeRangeGate?: 'product' | 'sum',
) {
  const original = cardRadiosityKernelSources(
    () => '',
    '',
    () => '',
  ).resolveCardRadiosity;
  const source = removeFiniteGate
    ? original.replace('&&cardLightingFiniteRgb(indirect)', '')
    : original;
  const start = source.indexOf(' let reconstructed=');
  if (start < 0) throw Error('Actual publication suffix missing');
  const body = source
    .slice(start, source.lastIndexOf('}'))
    .replace(/\blet\b/g, 'const')
    .replace('indirect/max(weight,1e-20)', 'divide(indirect,max(weight,1e-20))');
  const current = cardLinkConsumer('resolveCardRadiosity', {
    forward: 1,
    reverse: 1,
    texel: input.link ?? 1,
    epoch: input.linkEpoch ?? 3,
    model: input.linkModel ?? 3,
  });
  const guard = source.match(/if\((probeState\[probe\]\.x[^;]+?)\)\{continue;\}/)?.[1];
  if (!guard) throw Error('Actual probe qualification gate missing');
  const accepted = !Function(
    'probeState,probe,radiosity',
    `return ${guard.replace(/\b(\d+)u\b/g, '$1')}`,
  )([{ x: input.probeEpoch ?? 3, z: input.probeModel ?? 4 }], 0, {
    sampling: { w: input.epoch ?? 3 },
  });
  const lit: V[] = [],
    indirectHistory: V[] = [];
  const deps = {
    ...composition(removeFiniteGate, removeRangeGate),
    surface: {
      valid: input.valid ?? 1,
      albedo: lightVector(...(input.albedo ?? [0.25, 0.5, 0.75, 0])),
    },
    direct: [lightVector(...(input.direct ?? [0.5, 0.25, 0.125, 1]))],
    texel: 0,
    indirect: lightVector(...(input.incident ?? [0, 0, 0])),
    weight: current && accepted ? (input.weight ?? 0) : 0,
    radiosity: { sampling: { w: input.epoch ?? 3 } },
    lit,
    indirectHistory,
    divide: (a: V, b: number) => lightVector(...a.map((n) => Math.fround(n / b))),
  };
  Function(...Object.keys(deps), `"use strict";${body}`)(...Object.values(deps));
  return { lit: [...(lit[0] ?? [])], history: [...(indirectHistory[0] ?? [])] };
}
/** Shared production helper used by the next-bounce entry after its exact
 * same-model/epoch metadata gate. Metadata w is deliberately not radiance. */
export function prepareLighting(input: LightReadinessCase, history: readonly number[], model = 4) {
  const source = cardRadiosityKernelSources(
    () => '',
    '',
    () => '',
  ).prepareCardRadiosityBounce;
  const start = source.indexOf(' let model=');
  if (start < 0) throw Error('Actual bounce publication suffix missing');
  const body = source
    .slice(start, source.lastIndexOf('}'))
    .replace(/\blet\b/g, 'const')
    .replace(/\b(\d+)u\b/g, '$1')
    .replace(/bitcast<u32>\(/g, 'rootBits(');
  const bounce: V[] = [];
  const deps = {
    ...composition(),
    surface: {
      valid: input.valid ?? 1,
      albedo: lightVector(...(input.albedo ?? [0.25, 0.5, 0.75, 0])),
    },
    history: lightVector(...history),
    probeState: [{ z: model }],
    tile: 0,
    texel: 0,
    radiosity: { sampling: { x: 1, w: input.epoch ?? 3 } },
    direct: [lightVector(...(input.direct ?? [0.5, 0.25, 0.125, 1]))],
    bounce,
  };
  Function(...Object.keys(deps), `"use strict";${body}`)(...Object.values(deps));
  return [...(bounce[0] ?? [])];
}
/** The same binding-free production composition is directly GPU-reusable. */
export const cardLightReadinessFixture =
  CARD_RADIOSITY_FINITE_WGSL +
  CARD_RADIOSITY_LIGHTING_WGSL +
  `
struct CardLightCase { direct:vec4f,albedo:vec4f,incident:vec4f,control:vec4u }
@group(0) @binding(0) var<storage,read> cases:array<CardLightCase>;
@group(0) @binding(1) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(64) fn auditCardLighting(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=arrayLength(&cases)){return;}let c=cases[i];
 let r=cardRadiosityLighting(c.control.x,c.direct,c.albedo.xyz,c.incident.xyz,c.control.y!=0u,c.control.z);
 results[i*2u]=r.value;results[i*2u+1u]=r.history;
}`;

export {
  irradianceFieldKernelBindings,
  irradianceFieldKernelWgsl,
} from '../../raytracing/irradiance-field';

/** Actual integration publication suffix; SH integration is separately compiled,
 * while this control proves that the producer, rather than a test restamp,
 * supplies the estimator revision consumed by resolve and feedback. */
export function integratedLightingState(complete: boolean) {
  const source = cardRadiosityKernelSources(
    () => '',
    '',
    () => '',
  ).integrateCardRadiosity;
  const assignment = source.match(/probeState\[probe\]=vec4u\([^;]+;/)?.[0];
  if (!assignment) throw Error('Actual integration state publication required');
  const state: V[] = [];
  Function(
    'probeState,probe,radiosity,complete,select,vec4u',
    assignment.replace(/\b(\d+)u\b/g, '$1'),
  )(
    state,
    0,
    { sampling: { w: 3 }, update: { y: 9 } },
    complete,
    (a: number, b: number, p: boolean) => (p ? b : a),
    (...v: number[]) => lightVector(...v),
  );
  const row = state[0];
  if (!row || row.length !== 4) throw Error('Actual four-word publication required');
  return [row.x, row.y, row.z, row.w] as const;
}
