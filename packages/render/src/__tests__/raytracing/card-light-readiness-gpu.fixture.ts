import {
  cardLightReadinessFixture,
  irradianceFieldKernelWgsl,
} from './card-light-readiness.fixture';

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];
const DIRECT: Rgba = [0.5, 0.25, 0.125, 1];
const BLACK: Rgba = [0, 0, 0, 1];
const UNKNOWN: Rgba = [0, 0, 0, 0];
const ALBEDO: Rgba = [0.25, 0.5, 0.75, 0];
const ZERO: Rgb = [0, 0, 0];

export interface CardLightingGpuProgram {
  name: string;
  source: string;
  cases: readonly string[];
  bindings: { binding: number; bytes: Uint8Array; uniform?: boolean; output?: boolean }[];
  outputs: { binding: number; expected: Uint8Array; tolerantRows: readonly number[] }[];
}
interface HelperCase {
  name: string;
  direct?: Rgba;
  albedo?: Rgba;
  incident?: Rgb;
  valid?: number;
  supported?: boolean;
  epoch?: number;
  value: Rgba;
  history?: Rgb;
}
// Numeric values are independent authored controls, not results of the CPU interpreter.
const helperCases: readonly HelperCase[] = [
  { name: 'ready-direct-without-indirect', value: DIRECT },
  { name: 'known-black-direct', direct: BLACK, value: BLACK },
  { name: 'invalid-surface', valid: 0, supported: true, value: UNKNOWN },
  { name: 'missing-direct', direct: [0.5, 0.25, 0.125, 0], value: UNKNOWN },
  { name: 'nonfinite-direct', direct: [NaN, 0, 0, 1], value: UNKNOWN },
  { name: 'supported-zero', supported: true, value: DIRECT, history: ZERO },
  {
    name: 'supported-positive',
    supported: true,
    incident: [2, 2, 2],
    value: [1, 1.25, 1.625, 1],
    history: [2, 2, 2],
  },
  { name: 'nan-before-clamp', supported: true, incident: [NaN, 0, 0], value: DIRECT },
  {
    name: 'finite-product-overflow',
    supported: true,
    albedo: [2, 1, 1, 0],
    incident: [3e38, 0, 0],
    value: DIRECT,
  },
  {
    name: 'finite-sum-overflow',
    supported: true,
    direct: [3e38, 0, 0, 1],
    albedo: [1, 1, 1, 0],
    incident: [3e38, 0, 0],
    value: [3e38, 0, 0, 1],
  },
  {
    name: 'nan-shaped-epoch-is-metadata',
    supported: true,
    epoch: 0x7fc00001,
    value: DIRECT,
    history: ZERO,
  },
];
function floats(bytes: Uint8Array, offset: number, values: readonly number[]): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [i, value] of values.entries()) view.setFloat32(offset + i * 4, value, true);
}
function words(bytes: Uint8Array, offset: number, values: readonly number[]): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [i, value] of values.entries()) view.setUint32(offset + i * 4, value, true);
}
function history(bytes: Uint8Array, offset: number, value: Rgb, epoch = 3): void {
  floats(bytes, offset, value);
  words(bytes, offset + 12, [epoch]);
}
function helperProgram(): CardLightingGpuProgram {
  const input = new Uint8Array(helperCases.length * 64);
  const expected = new Uint8Array(helperCases.length * 32);
  for (const [i, c] of helperCases.entries()) {
    floats(input, i * 64, c.direct ?? DIRECT);
    floats(input, i * 64 + 16, c.albedo ?? ALBEDO);
    floats(input, i * 64 + 32, [...(c.incident ?? ZERO), 0]);
    words(input, i * 64 + 48, [c.valid ?? 1, c.supported ? 1 : 0, c.epoch ?? 3, 0]);
    floats(expected, i * 32, c.value);
    if (c.history) history(expected, i * 32 + 16, c.history, c.epoch ?? 3);
  }
  return {
    name: 'auditCardLighting',
    source: cardLightReadinessFixture,
    cases: helperCases.map((c) => c.name),
    bindings: [
      { binding: 0, bytes: input },
      { binding: 1, bytes: new Uint8Array(expected.length), output: true },
    ],
    outputs: [{ binding: 1, expected, tolerantRows: [] }],
  };
}
interface ProducerCase {
  name: string;
  valid?: number;
  direct?: Rgba;
  model?: number;
  stateEpoch?: number;
  link?: number;
  linkEpoch?: number;
  prior?: Rgb;
  historyEpoch?: number;
  sh?: number;
  bounce: Rgba;
  lit: Rgba;
  history?: Rgb;
  tolerance?: boolean;
}
const PRIOR: Rgba = [1, 1.25, 1.625, 1];
const C0 = Math.fround(0.2820947918);
const SH_LIT: Rgba = [
  Math.fround(0.5 + 0.25 * C0),
  Math.fround(0.25 + 0.5 * C0),
  Math.fround(0.125 + 0.75 * C0),
  1,
];
const producerCases: readonly ProducerCase[] = [
  { name: 'missing-sh', stateEpoch: 0, bounce: PRIOR, lit: DIRECT },
  {
    name: 'known-black-missing-sh',
    stateEpoch: 0,
    direct: BLACK,
    prior: ZERO,
    bounce: BLACK,
    lit: BLACK,
  },
  {
    name: 'invalid-direct-with-sh',
    direct: [0.5, 0.25, 0.125, 0],
    sh: 1,
    bounce: UNKNOWN,
    lit: UNKNOWN,
  },
  { name: 'invalid-surface-with-sh', valid: 0, sh: 1, bounce: UNKNOWN, lit: UNKNOWN },
  { name: 'blocked-link', link: 2, sh: 1, bounce: PRIOR, lit: DIRECT },
  { name: 'unknown-link', link: 0, sh: 1, bounce: PRIOR, lit: DIRECT },
  { name: 'old-lighting3-with-current-geometry3', model: 3, sh: 1, bounce: DIRECT, lit: DIRECT },
  { name: 'stale-geometry-epoch', linkEpoch: 2, sh: 1, bounce: PRIOR, lit: DIRECT },
  { name: 'model4-supported-zero-sh', bounce: PRIOR, lit: DIRECT, history: ZERO },
  {
    name: 'model4-supported-positive-sh',
    sh: 1,
    bounce: PRIOR,
    lit: SH_LIT,
    history: [C0, C0, C0],
    tolerance: true,
  },
  { name: 'stale-prior-history', historyEpoch: 2, bounce: DIRECT, lit: DIRECT, history: ZERO },
  { name: 'nonfinite-sh', sh: NaN, bounce: PRIOR, lit: DIRECT },
  {
    name: 'nonfinite-prior-history',
    prior: [NaN, 0, 0],
    bounce: DIRECT,
    lit: DIRECT,
    history: ZERO,
  },
  { name: 'nonfinite-direct', direct: [NaN, 0, 0, 1], bounce: UNKNOWN, lit: UNKNOWN },
];
function producerInputs() {
  const n = producerCases.length;
  const frame = new Uint8Array(64),
    surfaces = new Uint8Array(n * 64);
  const direct = new Uint8Array(n * 16),
    prior = new Uint8Array(n * 16);
  const state = new Uint8Array(n * 16),
    origins = new Uint8Array(n * 32);
  const sh = new Uint8Array(n * 48),
    links = new Uint8Array(n * 48);
  words(frame, 0, [1, 1, 1, 3, n, 9, n, 0, n, n, n, 1, 0, 0, 0, 0]);
  for (const [i, c] of producerCases.entries()) {
    floats(surfaces, i * 64, [i * 3, 0, 0, 0, 0, 0, 1]);
    words(surfaces, i * 64 + 28, [c.valid ?? 1]);
    floats(surfaces, i * 64 + 32, ALBEDO);
    floats(direct, i * 16, c.direct ?? DIRECT);
    history(prior, i * 16, c.prior ?? [2, 2, 2], c.historyEpoch ?? 3);
    words(state, i * 16, [c.stateEpoch ?? 3, 9, c.model ?? 4, 0]);
    floats(origins, i * 32, [i * 3, 0, 0]);
    words(origins, i * 32 + 12, [i]);
    floats(origins, i * 32 + 24, [1]);
    words(origins, i * 32 + 28, [1]);
    for (let channel = 0; channel < 3; channel++) floats(sh, i * 48 + channel * 16, [c.sh ?? 0]);
    words(links, i * 16, [c.link ?? 1]);
    words(links, (2 * n + i) * 16, [c.linkEpoch ?? 3, 9, 3, 0]);
  }
  return { frame, surfaces, direct, prior, state, origins, sh, links };
}
function producerProgram(
  name: 'prepareCardRadiosityBounce' | 'resolveCardRadiosity',
): CardLightingGpuProgram {
  const n = producerCases.length;
  const data = producerInputs();
  const expected = new Uint8Array(n * 16),
    committed = new Uint8Array(n * 16);
  const prepare = name === 'prepareCardRadiosityBounce';
  for (const [i, c] of producerCases.entries()) {
    floats(expected, i * 16, prepare ? c.bounce : c.lit);
    if (c.history) history(committed, i * 16, c.history);
  }
  const input = (binding: number, bytes: Uint8Array) => ({ binding, bytes });
  const output = (binding: number) => ({ binding, bytes: new Uint8Array(n * 16), output: true });
  const bindings = [
    { binding: 0, bytes: data.frame, uniform: true },
    input(1, data.surfaces),
    input(2, data.direct),
    ...(prepare
      ? [input(3, data.prior), output(4), input(5, data.state)]
      : [
          output(3),
          input(4, data.sh),
          input(5, data.state),
          input(6, data.origins),
          output(7),
          input(8, data.links),
        ]),
  ];
  const tolerantRows = prepare ? [] : producerCases.flatMap((c, i) => (c.tolerance ? [i] : []));
  return {
    name,
    source: irradianceFieldKernelWgsl('global-sdf')[name],
    cases: producerCases.map((c) => c.name),
    bindings,
    outputs: [
      { binding: prepare ? 4 : 3, expected, tolerantRows },
      ...(prepare ? [] : [{ binding: 7, expected: committed, tolerantRows }]),
    ],
  };
}
/** Authored model4 state is deliberate: this does not claim production minting or World traversal. */
export function cardLightingGpuPrograms(): CardLightingGpuProgram[] {
  return [
    helperProgram(),
    producerProgram('prepareCardRadiosityBounce'),
    producerProgram('resolveCardRadiosity'),
  ];
}
