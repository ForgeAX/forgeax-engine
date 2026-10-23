import type { BindGroup, Buffer, RenderPipeline, Texture, TextureView } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import type { RenderFrameState } from '../record/frame-snapshot';
import {
  commitTemporalGpuSubmit,
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  retireTemporalGpuState,
  stageTemporalGpuSubmit,
} from '../temporal/gpu';

type TaaScenario = 'feedback' | 'secondary-motion' | 'clipping-recovery';
type Device = Awaited<ReturnType<typeof requestTaaDevice>>;
type TemporalState = ReturnType<typeof getTemporalGpuState>;
type TaaInput = { readonly texture: Texture; readonly view: TextureView };

const FRAME_BYTES = 768;
const PIXEL_EXTENT = { width: 2, height: 1, depthOrArrayLayers: 1 };
const PIXEL_LAYOUT = { bytesPerRow: 16, rowsPerImage: 1 };

async function requestTaaDevice() {
  return (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
}

/** Exact half-float encodings of the per-frame temporal metadata. */
function frameMetadata(frame: number): number[] {
  return [frame === 9 ? 0x3000 : 0, 0, frame >= 14 ? 0x4400 : 0x4000, frame === 12 ? 0x3800 : 0];
}

/** Luminance of the left pixel from frame 16 on; the right pixel complements it. */
function frameColorValue(frame: number, clippingCycle: boolean): number {
  if (!clippingCycle) return frame % 2;
  return frame >= 528 ? 0 : Number(frame % 8 !== 2);
}

function decodeHalf(half: number): number {
  return half < 1024 ? half * 2 ** -24 : (1 + (half & 1023) / 1024) * 2 ** ((half >>> 10) - 15);
}

function writePixels(device: Device, input: TaaInput, data: Uint16Array): void {
  device.queue.writeTexture({ texture: input.texture }, data, PIXEL_LAYOUT, PIXEL_EXTENT).unwrap();
}

interface TaaFeedbackRig {
  readonly device: Device;
  readonly state: TemporalState;
  readonly inputs: ReturnType<typeof getTemporalBindGroupResources>;
  readonly params: ReturnType<typeof getTemporalParamsBuffer>;
  readonly pipeline: RenderPipeline;
  readonly emptyGroup: BindGroup;
  readonly color: TaaInput;
  readonly temporal: TaaInput;
  readonly secondary: TaaInput;
  readonly readback: Buffer;
}

function writeFrameInputs(rig: TaaFeedbackRig, frame: number, scenario: TaaScenario): void {
  const { device, state } = rig;
  const secondaryMotion = scenario === 'secondary-motion';
  const reactive = secondaryMotion && frame === 528;
  const metadata = new Uint16Array(frameMetadata(frame));
  if (frame >= 16) {
    // Complementary neighboring pixels keep the color bounds at [0, 1].
    // Only temporal feedback (not clipping or input quantization) changes
    // the analytic Karis recurrence. All input values are exact in FP16.
    const clippingCycle = scenario === 'clipping-recovery';
    const value = frameColorValue(frame, clippingCycle);
    const neighbor = clippingCycle ? value : 1 - value;
    if (frame === 16) state.valid = false;
    writePixels(
      device,
      rig.color,
      new Uint16Array([
        value * 0x3c00,
        value * 0x3c00,
        value * 0x3c00,
        0x3c00,
        neighbor * 0x3c00,
        neighbor * 0x3c00,
        neighbor * 0x3c00,
        0x3c00,
      ]),
    );
  }
  writePixels(device, rig.temporal, new Uint16Array([...metadata, ...metadata]));
  writePixels(
    device,
    rig.secondary,
    new Uint16Array([reactive ? 0x3c00 : 0, 0, 0, 0, reactive ? 0x3c00 : 0, 0, 0, 0]),
  );
  device.queue
    .writeBuffer(
      rig.params,
      0,
      new Uint32Array([0, 0, Number(state.valid), frame, Number(secondaryMotion), 0, 0, 0]),
    )
    .unwrap();
}

function historyBindGroup(rig: TaaFeedbackRig, index: TemporalState['readIndex']) {
  const { device, state, inputs, color, temporal, secondary } = rig;
  if (inputs.sampler === null || inputs.temporalSampler === null)
    throw new Error('Missing TAA samplers');
  return device
    .createBindGroup({
      layout: inputs.layout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: color.view } },
        { binding: 1, resource: { kind: 'sampler', value: inputs.sampler } },
        { binding: 2, resource: { kind: 'textureView', value: state.color[index].view } },
        { binding: 3, resource: { kind: 'sampler', value: inputs.sampler } },
        { binding: 4, resource: { kind: 'textureView', value: state.temporal[index].view } },
        { binding: 5, resource: { kind: 'sampler', value: inputs.temporalSampler } },
        { binding: 6, resource: { kind: 'textureView', value: temporal.view } },
        { binding: 7, resource: { kind: 'sampler', value: inputs.temporalSampler } },
        { binding: 8, resource: { kind: 'buffer', value: { buffer: rig.params } } },
        { binding: 9, resource: { kind: 'textureView', value: state.stability[index].view } },
        { binding: 10, resource: { kind: 'textureView', value: secondary.view } },
        { binding: 11, resource: { kind: 'textureView', value: temporal.view } },
        { binding: 12, resource: { kind: 'textureView', value: secondary.view } },
      ],
    })
    .unwrap();
}

/** Resolve one frame into the staged history slot and copy its three outputs to readback. */
function submitTaaFrame(rig: TaaFeedbackRig, frame: number): void {
  const { device, state } = rig;
  const group = historyBindGroup(rig, state.readIndex);
  stageTemporalGpuSubmit(state);
  const next = state.pendingIndex;
  if (next === undefined) throw new Error('Missing staged history write');
  const encoder = device.createCommandEncoder().unwrap();
  const targets = [state.color[next], state.temporal[next], state.stability[next]];
  const pass = encoder.beginRenderPass({
    colorAttachments: targets.map(({ view }) => ({
      view,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    })),
  });
  pass.setPipeline(rig.pipeline);
  pass.setBindGroup(0, rig.emptyGroup);
  pass.setBindGroup(1, group);
  pass.draw(3, 1, 0, 0);
  pass.end();
  for (const [slot, surface] of targets.entries())
    encoder.copyTextureToBuffer(
      { texture: surface.texture },
      {
        buffer: rig.readback,
        offset: frame * FRAME_BYTES + slot * 256,
        bytesPerRow: 256,
        rowsPerImage: 1,
      },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  expect(commitTemporalGpuSubmit(state)).toBe(true);
}

/** Independent infinite-precision Karis oracle plus its per-step FP16-history variant. */
interface KarisOracle {
  reference: number;
  previousActual: number;
  stepReference: number;
}

function advanceKarisOracle(oracle: KarisOracle, frame: number, value: number): void {
  const settled = Math.max(0, Math.min(1, (frame - 16 - 64) / 64));
  const steadyWeight = 0.95 + 0.04 * settled * settled * (3 - 2 * settled);
  // The frame-16 rejection starts a fresh local sample cycle. A global
  // frame index must not retain moving/invalid history during its first
  // eight accepted stationary samples; keep the independent Karis oracle.
  const localAge = frame - 16;
  const sampleAge = localAge < 8 ? Math.max(localAge, 1) : frame;
  const weight = Math.min(steadyWeight, sampleAge / (sampleAge + 1));
  const a = (1 - weight) / (1 + value);
  const b = weight / (1 + oracle.reference);
  oracle.reference = frame === 16 ? value : (value * a + oracle.reference * b) / (a + b);
  const previousWeight = weight / (1 + oracle.previousActual);
  oracle.stepReference =
    frame === 16
      ? value
      : (value * a + oracle.previousActual * previousWeight) / (a + previousWeight);
}

function requireHalf(result: Uint16Array, message: string): number {
  const half = result[0];
  if (half === undefined) throw new Error(message);
  return half;
}

/**
 * Stochastic FP16 rounding feeds its error into later frames, so a per-frame
 * formula check must start with the actual stored history. Only the two
 * adjacent FP16 values are legal (plus FP32 arithmetic tolerance). The
 * independent infinite-precision tail still detects accumulated bias; it is
 * not reset to the GPU result.
 */
function expectDelayedAccumulation(oracle: KarisOracle, frame: number, result: Uint16Array): void {
  const actual = decodeHalf(requireHalf(result, 'Missing TAA color readback'));
  const stepReference = oracle.stepReference;
  const spacing = 2 ** Math.max(-24, Math.floor(Math.log2(stepReference)) - 10);
  const lower = Math.floor(stepReference / spacing) * spacing;
  const upper = Math.ceil(stepReference / spacing) * spacing;
  const message = `TAA must follow delayed accumulation: frame=${frame}, actual=${actual}, expected=${stepReference}`;
  expect(actual, message).toBeGreaterThanOrEqual(lower - 0.000001);
  expect(actual, message).toBeLessThanOrEqual(upper + 0.000001);
  oracle.previousActual = actual;
}

/** Steady feedback frames are gray and record their error against the oracle. */
function expectSteadyFeedback(result: Uint16Array, reference: number, errors: number[]): void {
  const half = requireHalf(result, 'Missing TAA color readback');
  // The expected steady values are normal, positive half floats.
  expect(half >>> 10).toBeGreaterThan(0);
  expect(half >>> 10).toBeLessThan(31);
  errors.push(decodeHalf(half) - reference);
  expect(result[1]).toBe(half);
  expect(result[2]).toBe(half);
  expect(result[3]).toBe(0x3c00);
}

function expectEarlyClippingCycle(frame: number, result: Uint16Array, earlyCycle: number[]): void {
  earlyCycle.push(decodeHalf(requireHalf(result, 'Missing early clipping-cycle color')));
  if (frame === 127)
    expect(
      Math.abs(earlyCycle.reduce((sum, value) => sum + value, 0) / earlyCycle.length - 7 / 9),
      'coverage must converge before increasing the stationary history weight',
    ).toBeLessThan(0.03);
}

function expectClippingTail(
  frame: number,
  bytes: ArrayBuffer,
  result: Uint16Array,
  cycleTail: number[],
): void {
  expect(
    new Uint8Array(bytes)[512],
    'color clipping must not discard the accepted stationary reconstruction footprint',
  ).toBeGreaterThanOrEqual(128);
  const actual = decodeHalf(requireHalf(result, 'Missing clipping-cycle color'));
  if (frame < 528) cycleTail.push(actual);
  if (frame === 527)
    expect(
      Math.max(...cycleTail) - Math.min(...cycleTail),
      'phase-local clipping must not repeatedly erase settled history',
    ).toBeLessThan(0.03);
  if (frame >= 536)
    expect(
      actual,
      'persistent unmarked color change must recover within one jitter cycle',
    ).toBeLessThan(0.01);
}

function expectMotionRestart(
  frame: number,
  bytes: ArrayBuffer,
  result: Uint16Array,
  reactive: boolean,
): void {
  if (reactive) {
    expect(
      [...result],
      'secondary motion must reject old radiance on a stationary receiver',
    ).toEqual([0, 0, 0, 0x3c00]);
  }
  if (frame === 529) {
    const half = requireHalf(result, 'Missing post-motion color');
    // One accepted white and one reactive black sample have equal
    // temporal weight; Karis luminance weighting yields 1/3. Stochastic
    // FP16 rounding admits only its two neighboring encodings.
    expect([0x3555, 0x3556]).toContain(half);
  }
  const expectedAge = Math.min(frame - 528, 128);
  expect(new Uint8Array(bytes)[512], 'secondary motion restarts the complete settling cycle').toBe(
    expectedAge,
  );
}

/** Per-scenario observations accumulated across the complete ordered history. */
interface TaaHistoryObservations {
  readonly ages: (number | undefined)[];
  readonly errors: number[];
  readonly cycleTail: number[];
  readonly earlyCycle: number[];
}

function verifyTaaFrame(
  history: ArrayBuffer,
  frame: number,
  scenario: TaaScenario,
  oracle: KarisOracle,
  observed: TaaHistoryObservations,
): void {
  const clippingCycle = scenario === 'clipping-recovery';
  const reactive = scenario === 'secondary-motion' && frame === 528;
  const bytes = history.slice(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES);
  if (frame >= 16) advanceKarisOracle(oracle, frame, frameColorValue(frame, clippingCycle));
  const result = new Uint16Array(bytes, 0, 4);
  if (frame >= 16 && frame < 528 && !clippingCycle)
    expectDelayedAccumulation(oracle, frame, result);
  if (frame < 16) {
    expect([...result]).toEqual([0x3c00, 0x3c00, 0x3c00, 0x3c00]);
    observed.ages.push(new Uint8Array(bytes)[512]);
  } else if (frame >= 464 && frame < 528 && !clippingCycle) {
    expectSteadyFeedback(result, oracle.reference, observed.errors);
  }
  if (clippingCycle && frame >= 120 && frame < 128)
    expectEarlyClippingCycle(frame, result, observed.earlyCycle);
  if (clippingCycle && frame >= 464) expectClippingTail(frame, bytes, result, observed.cycleTail);
  if (frame >= 528 && !clippingCycle) expectMotionRestart(frame, bytes, result, reactive);
  const expectedMetadata = frameMetadata(frame);
  if (reactive) expectedMetadata[3] = 0x3c00;
  expect([...new Uint16Array(bytes, 256, 4)]).toEqual(expectedMetadata);
}

function expectScenarioSummary(scenario: TaaScenario, observed: TaaHistoryObservations): void {
  expect(observed.ages).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 1, 0, 1, 0, 1]);
  if (scenario === 'clipping-recovery') {
    const cycleTail = observed.cycleTail;
    expect(cycleTail).toHaveLength(64);
    expect(
      Math.max(...cycleTail) - Math.min(...cycleTail),
      'phase-local clipping must not repeatedly erase settled history',
    ).toBeLessThan(0.03);
    expect(cycleTail.reduce((a, b) => a + b, 0) / cycleTail.length).toBeCloseTo(7 / 9, 2);
    return;
  }
  const errors = observed.errors;
  expect(errors).toHaveLength(64);
  expect(Math.abs(errors.reduce((sum, error) => sum + error, 0) / errors.length)).toBeLessThan(
    0.0005,
  );
  expect(Math.max(...errors.map(Math.abs))).toBeLessThan(0.001);
}

function createTaaPipeline(
  device: Device,
  source: string,
  layout: ReturnType<typeof getTemporalBindGroupResources>['layout'],
) {
  const module = createShaderModuleImmediate(device, { code: source }).unwrap();
  const empty = device.createBindGroupLayout({ entries: [] }).unwrap();
  const emptyGroup = device.createBindGroup({ layout: empty, entries: [] }).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, layout] }).unwrap(),
      vertex: { module, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'r8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  return { pipeline, emptyGroup };
}

function createTaaInput(device: Device): TaaInput {
  const texture = device
    .createTexture({
      size: PIXEL_EXTENT,
      format: 'rgba16float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  return { texture, view: device.createTextureView(texture, {}).unwrap() };
}

export async function verifyTaaStabilityFeedback(
  source: string,
  scenario: TaaScenario = 'feedback',
) {
  const frameCount = scenario === 'feedback' ? 528 : 658;
  const device = await requestTaaDevice();
  const state = getTemporalGpuState(
    {} as RenderFrameState,
    device,
    DeviceScope.create(23, 'taa-feedback'),
    2,
    1,
  );
  const inputs = getTemporalBindGroupResources(state);
  if (inputs.sampler === null || inputs.temporalSampler === null)
    throw new Error('Missing TAA samplers');
  const params = getTemporalParamsBuffer(state);
  const { pipeline, emptyGroup } = createTaaPipeline(device, source, inputs.layout);
  const current = Array.from({ length: 3 }, () => createTaaInput(device));
  const readback = device
    .createBuffer({
      size: FRAME_BYTES * frameCount,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  try {
    const [color, temporal, secondary] = current;
    if (!color || !temporal || !secondary) throw new Error('Missing current inputs');
    const rig: TaaFeedbackRig = {
      device,
      state,
      inputs,
      params,
      pipeline,
      emptyGroup,
      color,
      temporal,
      secondary,
      readback,
    };
    writePixels(device, color, new Uint16Array(Array(8).fill(0x3c00)));
    // Initial seed, eight stationary frames, motion, stop, reactive material,
    // then depth disocclusion. Values below are exact half-float encodings.
    for (let frame = 0; frame < frameCount; frame++) {
      writeFrameInputs(rig, frame, scenario);
      submitTaaFrame(rig, frame);
    }
    // Preserve every submitted frame and its three outputs, but synchronize
    // with the GPU once. No input depends on CPU readback; the analytic oracle
    // can consume the complete ordered history after the queue finishes.
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const history = mapped.getMappedRange().unwrap().slice(0);
    mapped.unmap();
    const oracle: KarisOracle = { reference: 0, previousActual: 0, stepReference: 0 };
    const observed: TaaHistoryObservations = {
      ages: [],
      errors: [],
      cycleTail: [],
      earlyCycle: [],
    };
    for (let frame = 0; frame < frameCount; frame++)
      verifyTaaFrame(history, frame, scenario, oracle, observed);
    expectScenarioSummary(scenario, observed);
  } finally {
    device.destroyBuffer(readback).unwrap();
    for (const { texture } of current) device.destroyTexture(texture).unwrap();
    retireTemporalGpuState(state);
  }
}
