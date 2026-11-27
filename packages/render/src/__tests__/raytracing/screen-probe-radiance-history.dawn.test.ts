import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packIrradianceFieldUniform } from '../../raytracing/irradiance-field';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_HISTORY_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import {
  canonicalVisibilityPublisher,
  visibilityPlaneField,
} from './irradiance-field-visibility.fixture';
import { rayShaderTestImports } from './ray-shader-imports.fixture';
import {
  distributionPhase,
  packPointRadiance,
  unpackRadianceAmplitudes,
  verifyMixturePacket,
  writeDistributionSamples,
} from './screen-probe-radiance.fixture';

function retainHistoryReadback(
  mode: string,
  result: Float32Array,
  current: Float32Array,
  history: Float32Array,
): void {
  const directory = process.env.FORGEAX_GI_RAW_READBACK_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  for (const [name, values] of [
    ['gpu', result],
    ['current-input', current],
    ['history-input', history],
  ] as const)
    writeFileSync(
      join(directory, `history-${mode}.${name}.bin`),
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    );
}

const PROBE_FLOATS = SCREEN_PROBE_RECORD_BYTES / Float32Array.BYTES_PER_ELEMENT;
const LOGICAL_HISTORY_FLOATS = PROBE_FLOATS + 64 * 8;
type BorderHistoryCase = {
  position: [number, number];
  retainsHistory: boolean;
  clipW?: number;
  translationX?: number;
  uv?: [number, number];
};
function borderHistoryCases(): Map<string, BorderHistoryCase> {
  const cases = new Map<string, BorderHistoryCase>();
  const edges = [
    ['right', 1, 0],
    ['left', -1, 0],
    ['top', 0, 1],
    ['bottom', 0, -1],
    ['corner', 1, 1],
    ['top-left', -1, 1],
    ['bottom-left', -1, -1],
    ['bottom-right', 1, -1],
  ] as const;
  // Preserve the original +/-1.2 receivers as newly exposed, out-of-view geometry.
  for (const kind of ['open', 'black', 'wall', 'missing', 'reset']) {
    for (const [edge, x, y] of edges.slice(0, 5)) {
      cases.set(`border-${kind}-${edge}`, {
        position: [x * 1.2, y * 1.2],
        retainsHistory: false,
      });
    }
  }
  cases.set('border-beyond-right', { position: [2.1, 0], retainsHistory: false });
  cases.set('border-beyond-left', { position: [-2.1, 0], retainsHistory: false });
  for (const kind of ['open', 'black']) {
    // UV .03125/.96875 lies beyond the outer probe centers .0625/.9375,
    // but inside the previous view. Closed UV 0/1 also retains uniform history.
    for (const [region, coordinate] of [
      ['in-view', 0.9375],
      ['closed', 1],
    ] as const) {
      for (const [edge, x, y] of edges) {
        cases.set(`border-${kind}-${region}-${edge}`, {
          position: [x * coordinate, y * coordinate],
          retainsHistory: true,
          uv: [0.5 + x * coordinate * 0.5, 0.5 - y * coordinate * 0.5],
        });
      }
    }
  }
  // These are binary32 world coordinates, not nominal UV labels. In particular,
  // the first world value above +1 projects to closed UV 1 by ties-to-even.
  for (const [name, x, uv, retainsHistory] of [
    ['right-inner', 1 - 2 ** -23, 1 - 2 ** -24, true],
    ['right-rounded-edge', 1 + 2 ** -23, 1, true],
    ['right-outer', 1 + 2 ** -22, 1 + 2 ** -23, false],
    ['left-inner', -1 + 2 ** -24, 2 ** -25, true],
    ['left-outer', -1 - 2 ** -23, -(2 ** -24), false],
  ] as const) {
    cases.set(`border-open-f32-${name}`, { position: [x, 0], retainsHistory, uv: [uv, 0.5] });
    cases.set(`border-open-f32-vertical-${name}`, {
      position: [0, -x],
      retainsHistory,
      uv: [0.5, uv],
    });
  }
  cases.set('border-open-near-positive-w', {
    position: [0, 0],
    retainsHistory: true,
    clipW: 2 ** -126,
    uv: [0.5, 0.5],
  });
  cases.set('border-zero-w', { position: [0, 0], retainsHistory: false, clipW: 0 });
  cases.set('border-negative-w', {
    position: [0, 0],
    retainsHistory: false,
    clipW: -(2 ** -126),
  });
  cases.set('border-nan-uv', {
    position: [0, 0],
    retainsHistory: false,
    translationX: NaN,
    uv: [NaN, 0.5],
  });
  return cases;
}
const BORDER_CASES = borderHistoryCases();
const BORDER_MODES = [...BORDER_CASES.keys()];
function historyPixelIdentity(mode: string, probe: number): number {
  // Uniform border fallback cannot claim the unoccupied adaptive slot.
  return (mode === 'empty-tap' && probe === 3) || (BORDER_CASES.has(mode) && probe === 4)
    ? 0xffffffff
    : probe;
}

function historyReceiver(mode: string): [number, number] {
  return BORDER_CASES.get(mode)?.position ?? [mode === 'wall' ? -0.875 : 0, 0];
}
function historyVisibility(mode: string, x: number, y: number): [number, number] {
  const vertical = mode.endsWith('top') || mode.endsWith('bottom');
  const receiver = historyReceiver(mode);
  const center = mode.startsWith('border-') ? Math.sign(receiver[vertical ? 1 : 0]) : 0;
  const blocked = mode === 'wall' || mode.startsWith('border-wall-');
  return [
    blocked ? Math.abs((vertical ? y : x) - center) - 0.02 : 4,
    Number(mode !== 'missing-coverage' && !mode.startsWith('border-missing-')),
  ];
}
function historyVisibilitySource(
  mode: string,
  fields: readonly Awaited<ReturnType<typeof visibilityPlaneField>>[],
) {
  const blocked = mode === 'wall' || mode.startsWith('border-wall-');
  const missing = mode === 'missing-coverage' || mode.startsWith('border-missing-');
  if (!blocked && !missing) return [];
  const axis = mode.endsWith('top') || mode.endsWith('bottom') ? 1 : 0;
  const receiver = historyReceiver(mode);
  const center = mode.startsWith('border-') ? Math.sign(receiver[axis]) : 0;
  const field = fields[axis];
  if (!field) throw new Error('canonical history wall source is absent');
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  transform[12 + axis] = center;
  return [
    {
      instanceId: 7,
      geometryId: 9,
      mask: 255,
      surfaceCoverage: 'opaque' as const,
      transform,
      field: missing
        ? {
            missing: true as const,
            bounds: { min: [-4, -4, -4] as const, max: [4, 4, 4] as const },
          }
        : field,
    },
  ];
}
function expectBorderHistory(close: (mode: string, value: number, age: number) => void): void {
  for (const mode of BORDER_MODES) {
    if (!BORDER_CASES.get(mode)?.retainsHistory) {
      close(mode, 2, 1);
      continue;
    }
    const [x, y] = historyReceiver(mode);
    const fx = Math.max(0, Math.min(1, (x + 0.875) / 1.75));
    const fy = Math.max(0, Math.min(1, (0.875 - y) / 1.75));
    const history = mode.startsWith('border-black-') ? 0 : 4 * (fx + 2 * fy);
    close(mode, 0.2 * 2 + 0.8 * history, 5);
  }
}
function historyShaderSource(source: string): string {
  if (process.env.FORGEAX_GI_HISTORY_BORDER_MUTATION !== '1') return source;
  const anchor = 'if(probeHistoryUvValid(uv)){';
  expect(source.split(anchor)).toHaveLength(2);
  // Deliberately admit the original out-of-view receivers. A numeric history
  // assertion must fail after actual dispatch, not because an old anchor vanished.
  return source.replace(
    anchor,
    'if(probeHistoryUvValid(uv)||(all(uv>=vec2f(-0.5))&&all(uv<=vec2f(1.5)))){',
  );
}
function configureVisibilityGrid(
  mode: string,
  bytes: Uint8Array,
): { origin: number; spacing: number } {
  const origin = mode.includes('beyond') ? -3 : -2;
  const spacing = (-2 * origin) / 32;
  const floats = new Float32Array(bytes.buffer);
  floats.set([origin, origin, origin, spacing]);
  floats[9] = spacing * 0.5;
  return { origin, spacing };
}
function configureHistoryFrame(mode: string, bytes: Uint8Array): void {
  const words = new Uint32Array(bytes.buffer),
    floats = new Float32Array(bytes.buffer);
  words[10] =
    mode === 'disabled' || mode === 'adaptive-disabled' ? 0 : mode === 'shared-budget' ? 6 : 4;
  words[11] = mode === 'one-frame' ? 1 : 8;
  floats[43] =
    mode === 'geometric-reset' || mode === 'adaptive-reset' || mode.startsWith('border-reset')
      ? 0
      : 1;
  floats[36] = BORDER_CASES.get(mode)?.translationX ?? (mode === 'out-of-view' ? 3 : 0);
  floats[39] = BORDER_CASES.get(mode)?.clipW ?? 1;
}

function expectBorderProjection(
  mode: string,
  records: Uint8Array,
  frame: Uint8Array,
): number[] | undefined {
  const control = BORDER_CASES.get(mode);
  if (!control) return;
  const position = new Float32Array(records.buffer).slice(0, 3);
  expect(Array.from(position.slice(0, 2)), mode).toEqual(control.position.map(Math.fround));
  const matrix = new Float32Array(frame.buffer).subarray(24, 40);
  const f = Math.fround;
  const clip = Array.from({ length: 4 }, (_, row) =>
    f(
      f(
        f(
          f((matrix[row] ?? 0) * (position[0] ?? 0)) +
            f((matrix[4 + row] ?? 0) * (position[1] ?? 0)),
        ) + f((matrix[8 + row] ?? 0) * (position[2] ?? 0)),
      ) + (matrix[12 + row] ?? 0),
    ),
  );
  const [x = 0, y = 0, , w = 0] = clip;
  expect(w, mode).toBe(control.clipW ?? 1);
  if (!(w > 0)) {
    expect(control.retainsHistory, mode).toBe(false);
    return;
  }
  const uv = [f(f(f(x / w) * 0.5) + 0.5), f(f(f(y / w) * -0.5) + 0.5)];
  if (control.uv) expect(uv, mode).toEqual(control.uv);
  expect(
    uv.every((axis) => axis >= 0 && axis <= 1),
    mode,
  ).toBe(control.retainsHistory);
  return uv;
}

function seedAdaptiveHistory(mode: string, records: Uint8Array, history: Uint8Array): void {
  if (!mode.startsWith('adaptive-')) return;
  // Identity projection maps the exact current world point to pixel (4,4).
  // The adaptive record follows this pixel, independently of its physical slot.
  const key = 4 | (4 << 16),
    offset = 4 * LOGICAL_HISTORY_FLOATS;
  new Uint32Array(records.buffer)[4 * PROBE_FLOATS + 7] = key;
  const floats = new Float32Array(history.buffer),
    words = new Uint32Array(history.buffer);
  floats.set(
    [
      mode === 'adaptive-near-hit' ? 0.1 : 0,
      0,
      0,
      1,
      0,
      0,
      mode === 'adaptive-normal-reject' ? -1 : 1,
    ],
    offset,
  );
  words[offset + 7] = mode === 'adaptive-wrong-pixel' ? key + 1 : key;
  for (let texel = 0; texel < 64; texel++) {
    const value = mode === 'adaptive-black' ? 0 : 16;
    floats.set(
      [value, value, value, mode === 'adaptive-missing' ? 0 : 4, -1, 1],
      offset + PROBE_FLOATS + texel * 8,
    );
  }
}

function expectAdaptiveHistory(
  controls: Record<string, { output: number[]; adaptive: number[] }>,
): void {
  for (const [mode, expected] of [
    ['adaptive-exact', 13.2],
    ['adaptive-black', 0.4],
    ['adaptive-missing', 5.2],
    ['adaptive-normal-reject', 5.2],
    ['adaptive-wrong-pixel', 5.2],
    ['adaptive-disabled', 2],
    ['adaptive-reset', 2],
    ['adaptive-near-hit', 2],
  ] as const) {
    const result = controls[mode];
    if (!result) throw new Error(`Missing ${mode}`);
    for (const value of result.adaptive.slice(0, 3)) expect(value, mode).toBeCloseTo(expected, 5);
    const uniform = ['adaptive-disabled', 'adaptive-reset', 'adaptive-near-hit'].includes(mode)
      ? 2
      : 5.2;
    for (const value of result.output.slice(0, 3))
      expect(value, `${mode}:uniform`).toBeCloseTo(uniform, 5);
    expect(result.adaptive[3]).toBe(1);
  }
}

type HistoryControls = Record<
  string,
  {
    receiver: number[];
    previousUv: number[] | undefined;
    visibilityGrid: number[];
    output: number[];
    retained: number[];
    adaptive: number[];
  }
>;
function expectHistoryResults(controls: HistoryControls): void {
  const close = (mode: string, value: number, age: number, support = 1) => {
    const control = controls[mode];
    if (!control) throw new Error(`Missing ${mode}`);
    for (const lane of [control.output, control.adaptive]) {
      for (const channel of lane.slice(0, 3)) expect(channel, mode).toBeCloseTo(value, 5);
      expect(lane[3], mode).toBe(support);
    }
    expect(control.retained[3], mode).toBe(age);
  };
  // Four equal geometric taps describe the 27th octahedral direction.
  // Their endpoint cone only partially covers the current transport. That
  // fraction must bound retained effective samples as well as choose RGB.
  const weightedControl = (mode: string, distance: number) => {
    const x = -0.125,
      y = -0.125,
      z = 0.75;
    const length = Math.hypot(x, y, z);
    const direction = [x / length, y / length, z / length];
    const cone = Math.acos(1 - 0.0625 / length ** 3 / (2 * Math.PI));
    let confidence = 0;
    for (let tap = 0; tap < 4; tap++) {
      const endpoint = [
        (tap % 2 ? 0.875 : -0.875) + (direction[0] ?? 0) * distance,
        (tap < 2 ? 0.875 : -0.875) + (direction[1] ?? 0) * distance,
        (direction[2] ?? 0) * distance,
      ];
      const cosine =
        endpoint.reduce((sum, value, axis) => sum + value * (direction[axis] ?? 0), 0) /
        Math.hypot(...endpoint);
      confidence += 0.25 * (1 - Math.min(Math.acos(Math.max(-1, Math.min(1, cosine))) / cone, 1));
    }
    const age = 1 + 4 * confidence;
    const expected = 6 + (2 - 6) / age;
    const control = controls[mode];
    if (!control) throw new Error(`Missing ${mode}`);
    for (const lane of [control.output, control.adaptive]) {
      for (const channel of lane.slice(0, 3)) expect(channel, mode).toBeCloseTo(expected, 4);
      expect(lane[3], mode).toBe(1);
    }
    // f32 acos near a far endpoint amplifies input ulps in fractional age;
    // RGB remains at four digits, and support/endpoints stay exact.
    expect(control.retained[3], mode).toBeCloseTo(age, 3);
    expect(control.retained[4], mode).toBe(distance);
  };
  weightedControl('partial-hit', 6);
  expectAdaptiveHistory(controls);
  close('near-hit', 2, 1);
  close('source-near', 2, 1);
  close('zero-hit', 2, 1);
  close('near-black', 0, 1);
  close('coincident-hit', 5.2, 5);
  weightedControl('far-hit', 100);
  const far = controls['far-hit'];
  if (!far) throw new Error('Missing far-hit');
  expect(far.retained[4]).toBe(100);
  expect(controls['near-hit']?.retained[4]).toBeCloseTo(0.02, 6);
  expect(controls['source-near']?.retained[4]).toBe(100);
  expect(controls['missing-current']?.retained[4]).toBe(-1);
  close('all', 5.2, 5);
  expectBorderHistory(close);
  close('normal-reject', 3.6, 5);
  close('plane-reject', 3.6, 5);
  close('empty-tap', 3.6, 5);
  close('all-reject', 2, 1);
  close('black', 0.4, 5);
  close('constant', 2, 5);
  const measured = controls['constant-varying-measure'];
  if (!measured) throw new Error('Varying-measure history control required');
  // Four equal taps: mean retained M=(.5+1+3+5)/4=2.375,
  // age=5; current M=2. Expected M=.8*2.375+.2*2=2.3.
  for (const lane of [measured.output, measured.retained, measured.adaptive]) {
    expect(lane[5]).toBeCloseTo(2.3, 5);
    for (const channel of lane.slice(0, 3)) {
      expect(channel).toBeCloseTo(4.6, 5);
      expect(channel / (lane[5] ?? NaN)).toBeCloseTo(2, 5);
    }
  }
  expect(measured.output[3]).toBe(1);
  expect(measured.retained[3]).toBe(5);
  close('incomplete-current', 2, 0, -1);
  close('missing-current', 2, 0, 0);
  close('young-tap', 4, 2);
  close('disabled', 2, 1);
  close('geometric-reset', 2, 1);
  close('out-of-view', 2, 1);
  close('one-frame', 2, 1);
  // The wall rejects the two bright right-side taps, retaining only 0 and 8.
  close('wall', 3.6, 5);
  close('missing-coverage', 2, 1);
  close('shared-budget', 5, 4);
}

it('retains only supported probe radiance before spatial filtering', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const originalSource = read('ray-screen-probe');
  const source = historyShaderSource(originalSource);
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-radiance-history',
      imports: await rayShaderTestImports(),
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Probe radiance history requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint8Array, usage = 128) => {
    const value = device.createBuffer({
      size: data.byteLength,
      usage: usage | (usage === 1 ? 8 : 12),
    });
    owned.push(value);
    device.queue.writeBuffer(value, 0, data);
    return value;
  };
  const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const frameBytes = packScreenProbeFrame({
    worldSource: { traversal: 'unused' },
    layout: {
      width: 8,
      height: 8,
      tilesX: 2,
      tilesY: 2,
      uniformCount: 4,
      adaptiveCapacity: 1,
      probeCount: 5,
    },
    downsample: 4,
    frameIndex: 1,
    importance: 'uniform',
    screenSteps: 0,
    thickness: 0.02,
    environment: [0, 0, 0],
    maxDistance: 100,
    shortRangeAo: 0,
    maxFrames: 8,
    sceneHistory: false,
    pixelHistory: false,
    probeHistory: true,
    worldBias: 0.25,
    cardMargin: 0.125,
    query: new Uint8Array(8),
    reprojection: { viewProjection: projection, cameraPosition: [0, 0, 1] },
  });
  const frame = buffer(frameBytes, 64),
    probesIn = buffer(new Uint8Array(5 * SCREEN_PROBE_RECORD_BYTES)),
    radianceIn = buffer(new Uint8Array(5 * 64 * 40)),
    radianceOut = buffer(new Uint8Array(5 * 64 * 40)),
    probeHistoryIn = buffer(new Uint8Array(5 * SCREEN_PROBE_HISTORY_BYTES)),
    probeHistoryOut = buffer(new Uint8Array(5 * SCREEN_PROBE_HISTORY_BYTES));
  const field = buffer(
    packIrradianceFieldUniform(
      { origin: [-1, -1, -1], spacing: 2, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
      [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
    ),
    64,
  );
  const gridBytes = new Uint8Array(48);
  new Float32Array(gridBytes.buffer).set([-2, -2, -2, 0.125]);
  new Uint32Array(gridBytes.buffer).set([33, 33, 33, 33 ** 3], 4);
  new Float32Array(gridBytes.buffer).set([4, 0.0625, 0, 0], 8);
  const retained = buffer(new Uint8Array(8 * 144 * 16)),
    moments = buffer(new Uint8Array(8 * 64 * 8)),
    meta = buffer(new Uint8Array(8 * 16));
  const visibility = device.createTexture({
    size: [33, 33, 33],
    dimension: '3d',
    format: 'rg32float',
    usage: 4 | 2,
  });
  const resources = { frame, probesIn, radianceIn, radianceOut, probeHistoryIn, probeHistoryOut };
  const layout = device.createBindGroupLayout({
    entries: SCREEN_PROBE_STAGES.temporalProbeRadiance.slots.map((slot) => ({
      binding: SCREEN_PROBE_BINDINGS[slot][0],
      visibility: 4,
      buffer: {
        type:
          SCREEN_PROBE_BINDINGS[slot][1] === 'uniform'
            ? ('uniform' as const)
            : SCREEN_PROBE_BINDINGS[slot][1] === 'storage'
              ? ('storage' as const)
              : ('read-only-storage' as const),
      },
    })),
  });
  const group = device.createBindGroup({
    layout,
    entries: SCREEN_PROBE_STAGES.temporalProbeRadiance.slots.map((slot) => ({
      binding: SCREEN_PROBE_BINDINGS[slot][0],
      resource: { buffer: resources[slot] },
    })),
  });
  // Production field group plus five stage storage buffers stays within the
  // default eight-buffer limit. No elevated device limit is requested.
  const sampleLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      ...[1, 2, 3].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: 'read-only-storage' as const },
      })),
      { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
      {
        binding: 5,
        visibility: 4,
        texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
      },
      { binding: 6, visibility: 4, texture: { sampleType: 'uint', viewDimension: '2d' } },
    ],
  });
  const sample = (
    canonical: ReturnType<Awaited<ReturnType<typeof canonicalVisibilityPublisher>>>,
  ) =>
    device.createBindGroup({
      layout: sampleLayout,
      entries: [
        ...[field, retained, moments, meta, canonical.settings].map((value, binding) => ({
          binding,
          resource: { buffer: value },
        })),
        { binding: 5, resource: visibility.createView() },
        { binding: 6, resource: canonical.view },
      ],
    });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sampleLayout] }),
    compute: {
      module: device.createShaderModule({ code: compiled.wgsl }),
      entryPoint: 'temporalProbeRadiance',
    },
  });
  const readback = buffer(new Uint8Array(radianceOut.size + probeHistoryOut.size), 1);
  const controls: HistoryControls = {};
  const mixedDirections: number[][] = [];
  const publish = await canonicalVisibilityPublisher(device);
  const wallFields = await Promise.all([visibilityPlaneField(0), visibilityPlaneField(1)]);
  let canonical: ReturnType<typeof publish> | undefined;
  function verifyTemporalMoments(
    currentPackets: Float32Array,
    historyPackets: Float32Array,
    result: Float32Array,
    records: Uint8Array,
  ): void {
    const pixels = new Uint32Array(records.buffer);
    for (const p of [0, 4])
      for (let t = 0; t < 64; t++) {
        const inputs = Array.from({ length: 4 }, (_, tap) => ({
          data: historyPackets,
          offset: (tap * SCREEN_PROBE_HISTORY_BYTES) / 4 + PROBE_FLOATS + t * 10,
          weight: 0.2,
        }));
        inputs.push({ data: currentPackets, offset: (p * 64 + t) * 10, weight: 0.2 });
        const phase = distributionPhase(
          pixels[p * PROBE_FLOATS + 7] ?? NaN,
          t,
          0x741c9,
          1,
          new Uint32Array(frameBytes.buffer)[7] ?? NaN,
        );
        for (const at of [
          (p * 64 + t) * 10,
          radianceOut.size / 4 + (p * SCREEN_PROBE_HISTORY_BYTES) / 4 + PROBE_FLOATS + t * 10,
        ]) {
          const actual = verifyMixturePacket(result, at, t, inputs, phase);
          mixedDirections.push([phase, ...actual]);
        }
      }
  }
  let status = 'running';
  try {
    for (const mode of [
      'all',
      ...BORDER_MODES,
      'adaptive-exact',
      'adaptive-black',
      'adaptive-missing',
      'adaptive-normal-reject',
      'adaptive-wrong-pixel',
      'adaptive-disabled',
      'adaptive-reset',
      'adaptive-near-hit',
      'mixed-directions',
      'normal-reject',
      'plane-reject',
      'empty-tap',
      'all-reject',
      'black',
      'constant',
      'constant-varying-measure',
      'incomplete-current',
      'missing-current',
      'young-tap',
      'disabled',
      'geometric-reset',
      'out-of-view',
      'one-frame',
      'wall',
      'missing-coverage',
      'shared-budget',
      'near-hit',
      'source-near',
      'far-hit',
      'zero-hit',
      'coincident-hit',
      'near-black',
      'partial-hit',
    ] as const) {
      const records = new Uint8Array(5 * SCREEN_PROBE_RECORD_BYTES),
        history = new Uint8Array(5 * LOGICAL_HISTORY_FLOATS * Float32Array.BYTES_PER_ELEMENT);
      const rf = new Float32Array(records.buffer),
        ru = new Uint32Array(records.buffer),
        hf = new Float32Array(history.buffer),
        hu = new Uint32Array(history.buffer);
      // Unit angular measure isolates the existing geometric/history assertions.
      const input = new Float32Array(5 * 64 * 8);
      function currentRadianceData(): number[] {
        return [
          ...Array<number>(3).fill(mode === 'near-black' ? 0 : 2),
          mode === 'incomplete-current' ? -1 : mode === 'missing-current' ? 0 : 1,
          mode === 'partial-hit'
            ? 6
            : mode === 'near-hit' || mode === 'near-black' || mode === 'adaptive-near-hit'
              ? 0.02
              : mode === 'zero-hit' || mode === 'coincident-hit'
                ? 0
                : mode === 'source-near' || mode === 'far-hit'
                  ? 100
                  : -1,
          1,
        ];
      }
      function historyGeometry(p: number): number[] {
        return [
          mode === 'coincident-hit' ? 0 : p % 2 ? 0.875 : -0.875,
          mode === 'coincident-hit' ? 0 : p < 2 ? 0.875 : -0.875,
          mode === 'plane-reject' && p === 3 ? 1 : 0,
          1,
          0,
          0,
          mode === 'normal-reject' && p === 3 ? -1 : 1,
        ];
      }
      function historyAmplitude(p: number): number {
        return mode === 'black' || mode === 'near-black' || mode.startsWith('border-black')
          ? 0
          : mode === 'constant' || mode === 'constant-varying-measure'
            ? 2
            : mode === 'far-hit' || mode === 'partial-hit'
              ? 6
              : p * 4;
      }
      function historyRadianceData(p: number, value: number): number[] {
        return [
          value,
          value,
          value,
          mode === 'all-reject' ? 0 : mode === 'young-tap' && p === 0 ? 1 : 4,
          mode === 'partial-hit'
            ? 6
            : mode === 'source-near'
              ? 0.02
              : mode === 'coincident-hit'
                ? 0
                : ['near-hit', 'far-hit', 'zero-hit', 'near-black'].includes(mode)
                  ? 100
                  : -1,
          1,
        ];
      }
      for (let p = 0; p < 5; p++) {
        // The boundary-anchored 2x2 grid places at pixels 0/7 of the 8x8 view:
        // world x = -0.875/0.875 and y = 0.875/-0.875. Project the
        // mean receiver between them; the wall case stays on the left column.
        rf.set([...historyReceiver(mode), 0, 1, 0, 0, 1], p * PROBE_FLOATS);
        ru[p * PROBE_FLOATS + 7] = p;
        for (let t = 0; t < 64; t++) input.set(currentRadianceData(), (p * 64 + t) * 8);
        const offset = p * LOGICAL_HISTORY_FLOATS;
        hf.set(historyGeometry(p), offset);
        // Border cases exercise uniform-lattice fallback. Its unoccupied adaptive
        // slot must not accidentally claim pixel (4,0) for a top-edge receiver.
        hu[offset + 7] = historyPixelIdentity(mode, p);
        const value = historyAmplitude(p);
        for (let t = 0; t < 64; t++)
          hf.set(historyRadianceData(p, value), offset + PROBE_FLOATS + t * 8);
      }
      if (mode === 'constant-varying-measure') {
        // Equal physical L=2, independently varying current/history projected
        // areas. Both numerator and measure must travel through identical taps.
        for (let p = 0; p < 5; p++) {
          for (let t = 0; t < 64; t++) {
            const current = (p * 64 + t) * 8;
            const retained = p * LOGICAL_HISTORY_FLOATS + PROBE_FLOATS + t * 8;
            const measure = [0.5, 1, 3, 5, 7][p];
            if (measure === undefined) throw new Error('Measure control required');
            input.set([4, 4, 4], current);
            input[current + 5] = 2;
            hf.set([2 * measure, 2 * measure, 2 * measure], retained);
            hf[retained + 5] = measure;
          }
        }
      }
      configureHistoryFrame(mode, frameBytes);
      const previousUv = expectBorderProjection(mode, records, frameBytes);
      // Beyond-border controls must remain well inside covered clear space:
      // otherwise missing coverage, rather than the viewport guard, could reject them.
      const { origin: visibilityOrigin, spacing: visibilitySpacing } = configureVisibilityGrid(
        mode,
        gridBytes,
      );
      canonical?.dispose();
      canonical = publish(historyVisibilitySource(mode, wallFields), {
        origin: [visibilityOrigin, visibilityOrigin, visibilityOrigin],
        dimensions: [33, 33, 33],
        spacing: visibilitySpacing,
        maxDistance: 4,
        coverageDistance: visibilitySpacing * 0.5,
      });
      const sdf = new Float32Array(33 ** 3 * 2);
      for (let i = 0; i < 33 ** 3; i++)
        sdf.set(
          historyVisibility(
            mode,
            visibilityOrigin + (i % 33) * visibilitySpacing,
            visibilityOrigin + (Math.floor(i / 33) % 33) * visibilitySpacing,
          ),
          i * 2,
        );
      device.queue.writeTexture(
        { texture: visibility },
        sdf,
        { bytesPerRow: 33 * 8, rowsPerImage: 33 },
        [33, 33, 33],
      );
      seedAdaptiveHistory(mode, records, history);
      device.queue.writeBuffer(frame, 0, frameBytes);
      device.queue.writeBuffer(probesIn, 0, records);
      const currentPackets = packPointRadiance(input, 5);
      const historyPackets = packPointRadiance(
        new Float32Array(history.buffer),
        5,
        PROBE_FLOATS,
        LOGICAL_HISTORY_FLOATS,
      );
      expect(historyPackets.byteLength).toBe(probeHistoryIn.size);
      if (mode === 'mixed-directions') {
        for (let p = 0; p < 5; p++)
          for (let t = 0; t < 64; t++) {
            writeDistributionSamples(currentPackets, (p * 64 + t) * 10, p + 5, t);
            writeDistributionSamples(
              historyPackets,
              (p * SCREEN_PROBE_HISTORY_BYTES) / 4 + PROBE_FLOATS + t * 10,
              p,
              t,
            );
          }
      }
      device.queue.writeBuffer(radianceIn, 0, currentPackets);
      device.queue.writeBuffer(probeHistoryIn, 0, historyPackets);
      const encoder = device.createCommandEncoder();
      canonical.record(encoder);
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setBindGroup(1, sample(canonical));
      pass.dispatchWorkgroups(5);
      pass.end();
      encoder.copyBufferToBuffer(radianceOut, 0, readback, 0, radianceOut.size);
      encoder.copyBufferToBuffer(
        probeHistoryOut,
        0,
        readback,
        radianceOut.size,
        probeHistoryOut.size,
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const result = new Float32Array(readback.getMappedRange()).slice();
      readback.unmap();
      retainHistoryReadback(mode, result, currentPackets, historyPackets);
      if (mode === 'all-reject') {
        // Compare the actual packed observations, including their direction
        // and depth. Equal RGB alone would miss extra mixture re-encoding.
        const observed = new Uint32Array(result.buffer);
        const currentWords = new Uint32Array(currentPackets.buffer);
        for (let p = 0; p < 5; p++) {
          const first = p * 64 * 10;
          const retained =
            radianceOut.size / 4 + (p * SCREEN_PROBE_HISTORY_BYTES) / 4 + PROBE_FLOATS;
          const expected = currentWords.subarray(first, first + 64 * 10);
          expect(observed.subarray(first, first + 64 * 10)).toEqual(expected);
          expect(observed.subarray(retained, retained + 64 * 10)).toEqual(expected);
        }
      }
      if (mode === 'mixed-directions') {
        verifyTemporalMoments(currentPackets, historyPackets, result, records);
      }
      unpackRadianceAmplitudes(result.subarray(0, radianceOut.size / 4), 5);
      unpackRadianceAmplitudes(
        result.subarray(radianceOut.size / 4),
        5,
        PROBE_FLOATS,
        LOGICAL_HISTORY_FLOATS,
      );
      const start = radianceOut.size / 4 + PROBE_FLOATS;
      // Texel 27 points forward; all four displaced near endpoints are outside
      // its directional footprint. Preserve the original lane-0 controls too.
      const texel = [
        'near-hit',
        'source-near',
        'far-hit',
        'zero-hit',
        'coincident-hit',
        'near-black',
        'partial-hit',
      ].includes(mode)
        ? 27
        : 0;
      const directionalStart = texel * 8;
      controls[mode] = {
        receiver: Array.from(rf.slice(0, 3)),
        previousUv,
        visibilityGrid: Array.from(new Float32Array(gridBytes.buffer).slice(0, 4)),
        output: Array.from(result.slice(directionalStart, directionalStart + 6)),
        retained: Array.from(result.slice(start + directionalStart, start + directionalStart + 6)),
        adaptive: Array.from(
          result.slice(4 * 64 * 8 + directionalStart, 4 * 64 * 8 + directionalStart + 6),
        ),
      };
    }
    expectHistoryResults(controls);
    expect(errors).toEqual([]);
    status = 'PASS';
  } catch (error) {
    status = 'FAIL';
    throw error;
  } finally {
    mkdirSync('artifacts/screen-probe/radiance-history', { recursive: true });
    writeFileSync(
      'artifacts/screen-probe/radiance-history/result.json',
      `${JSON.stringify({ status, sourceSha256: createHash('sha256').update(source).digest('hex'), originalSourceSha256: createHash('sha256').update(originalSource).digest('hex'), compiledShaderSha256: createHash('sha256').update(compiled.wgsl).digest('hex'), mutation: { enabled: process.env.FORGEAX_GI_HISTORY_BORDER_MUTATION === '1', viewportGateMatches: originalSource.split('if(probeHistoryUvValid(uv)){').length - 1 }, adapterInfo: adapter.info, errors, controls, mixedDirections }, null, 2)}\n`,
    );
    canonical?.dispose();
    for (const value of owned) value.destroy();
    visibility.destroy();
    device.destroy();
  }
}, 120_000);
