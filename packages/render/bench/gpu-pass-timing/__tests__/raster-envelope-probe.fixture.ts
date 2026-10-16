import { expect } from 'vitest';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { createGpuPassTimingSession } from '../../../src/record/gpu-pass-timing/session.js';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
} from '../../../src/gpu-texture-usage.js';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_QUERY_RESOLVE,
} from '../../../src/gpu-usage.js';

const WIDTH = 64;
const HEIGHT = 64;
const FORMAT = 'rgba16float' as const;
const REPETITIONS = 3;
const QUERY_COUNT = 4;
const READBACK_BYTES = 256;
const SEQUENCES = [
  ['L'],
  ['H', 'L'],
  ['L', 'H'],
] as const;

type Sequence = (typeof SEQUENCES)[number];
type PassName = Sequence[number];

interface TickRange {
  readonly passName: PassName;
  readonly beginningTick: bigint;
  readonly endTick: bigint;
}

interface ProbeSample {
  readonly path: 'native-webgpu' | 'rhi-session';
  readonly sequence: Sequence;
  readonly repetition: number;
  readonly ticks: readonly TickRange[];
  readonly output: readonly number[];
  readonly durationTicks: readonly string[];
  readonly overlapPairs: readonly {
    readonly left: string;
    readonly right: string;
    readonly overlapTicks: string;
  }[];
}

function shader(iterations: number): string {
  return `
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let p = positions[index];
  var result: VertexOut;
  result.position = vec4<f32>(p, 0.0, 1.0);
  result.uv = p * 0.5 + vec2<f32>(0.5);
  return result;
}

@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> {
  var value = vec3<f32>(input.uv, 0.37);
  for (var i = 0u; i < ${iterations}u; i = i + 1u) {
    value = fract(value * 1.013 + vec3<f32>(0.017, 0.031, 0.047));
  }
  return vec4<f32>(value, 1.0);
}
`;
}

function intervalsFromTicks(ticks: readonly TickRange[]) {
  const overlaps: ProbeSample['overlapPairs'][number][] = [];
  for (let leftIndex = 0; leftIndex < ticks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ticks.length; rightIndex += 1) {
      const left = ticks[leftIndex];
      const right = ticks[rightIndex];
      const beginning = left.beginningTick > right.beginningTick ? left.beginningTick : right.beginningTick;
      const end = left.endTick < right.endTick ? left.endTick : right.endTick;
      if (end > beginning) {
        overlaps.push({
          left: left.passName,
          right: right.passName,
          overlapTicks: (end - beginning).toString(10),
        });
      }
    }
  }
  return overlaps.sort((left, right) => Number(BigInt(right.overlapTicks) - BigInt(left.overlapTicks)));
}

function readTickPair(buffer: ArrayBuffer, offset: number): [bigint, bigint] {
  const view = new DataView(buffer);
  return [view.getBigUint64(offset, true), view.getBigUint64(offset + 8, true)];
}

function nativeAdapterIdentity(adapter: GPUAdapter) {
  const info = adapter.info;
  return {
    vendor: info.vendor ?? null,
    architecture: info.architecture ?? null,
    device: info.device ?? null,
    description: info.description ?? null,
    isFallbackAdapter: info.isFallbackAdapter ?? null,
  };
}

async function requestNativeDevice() {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null || !adapter.features.has('timestamp-query')) return undefined;
  const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
  return { adapter, device };
}

async function runNative(
  device: GPUDevice,
  sequence: Sequence,
  repetition: number,
  pipelines: Readonly<Record<'L' | 'H', GPURenderPipeline>>,
): Promise<ProbeSample> {
  const texture = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format: FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const querySet = device.createQuerySet({ type: 'timestamp', count: QUERY_COUNT });
  const resolve = device.createBuffer({ size: READBACK_BYTES, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const timingReadback = device.createBuffer({ size: READBACK_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pixelReadback = device.createBuffer({ size: READBACK_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    device.pushErrorScope('validation');
    const encoder = device.createCommandEncoder({ label: `raster-envelope-native-${sequence.join('-')}-${repetition}` });
    for (const [index, passName] of sequence.entries()) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          loadOp: index === 0 ? 'clear' : 'load',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
        timestampWrites: {
          querySet,
          beginningOfPassWriteIndex: index * 2,
          endOfPassWriteIndex: index * 2 + 1,
        },
      });
      pass.setPipeline(pipelines[passName]);
      // Keep H full-screen, but make L cover only the left half. The right
      // pixel then proves whether an earlier H pass survives H -> L.
      if (passName === 'L') pass.setScissorRect(0, 0, WIDTH / 2, HEIGHT);
      pass.draw(3);
      pass.end();
    }
    encoder.resolveQuerySet(querySet, 0, QUERY_COUNT, resolve, 0);
    encoder.copyBufferToBuffer(resolve, 0, timingReadback, 0, 32);
    encoder.copyTextureToBuffer(
      { texture, origin: { x: WIDTH / 2 - 1, y: 0, z: 0 } },
      { buffer: pixelReadback, bytesPerRow: 256, rowsPerImage: HEIGHT },
      { width: 2, height: 1, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const validationError = await device.popErrorScope();
    expect(validationError, 'native WebGPU control must not emit validation errors').toBeNull();
    await timingReadback.mapAsync(GPUMapMode.READ);
    const timingRange = timingReadback.getMappedRange(0, 32).slice(0);
    timingReadback.unmap();
    await pixelReadback.mapAsync(GPUMapMode.READ);
    const pixelRange = pixelReadback.getMappedRange(0, 16).slice(0);
    pixelReadback.unmap();
    const ticks = sequence.map((passName, index) => {
      const [beginningTick, endTick] = readTickPair(timingRange, index * 16);
      return { passName, beginningTick, endTick };
    });
    return {
      path: 'native-webgpu',
      sequence,
      repetition,
      ticks,
      output: Array.from(new Uint16Array(pixelRange)),
      durationTicks: ticks.map((tick) => (tick.endTick - tick.beginningTick).toString(10)),
      overlapPairs: intervalsFromTicks(ticks),
    };
  } finally {
    texture.destroy();
    querySet.destroy();
    resolve.destroy();
    timingReadback.destroy();
    pixelReadback.destroy();
  }
}

async function runRhi(
  device: Awaited<ReturnType<typeof requestRhiDevice>>,
  sequence: Sequence,
  repetition: number,
  pipelines: Readonly<Record<'L' | 'H', import('@forgeax/engine-rhi').RenderPipeline>>,
): Promise<ProbeSample> {
  const texture = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format: FORMAT,
    textureBindingViewDimension: '2d',
    usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
  }).unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const pixelReadback = device.createBuffer({ size: READBACK_BYTES, usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ }).unwrap();
  const session = createGpuPassTimingSession(device, { maxPassesPerFrame: 2, maxFramesInFlight: 1, retentionFrames: 1 }).unwrap();
  try {
    const capture = session.beginFrame({ frameId: repetition + 1, deviceGeneration: 1, graphGeneration: 0 }).unwrap();
    const encoder = device.createCommandEncoder({ label: `raster-envelope-rhi-${sequence.join('-')}-${repetition}` }).unwrap();
    for (const [index, passName] of sequence.entries()) {
      const identity = { passName, passKind: 'raster' as const, executionIndex: index };
      const writes = capture.recordPass(identity);
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view,
          loadOp: index === 0 ? 'clear' : 'load',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
        ...(writes === undefined ? {} : { timestampWrites: writes }),
      });
      pass.setPipeline(pipelines[passName]);
      // Match the native control: L covers only the left half, so the right
      // pixel remains an observable dependency on an earlier H pass.
      if (passName === 'L') pass.setScissorRect(0, 0, WIDTH / 2, HEIGHT);
      pass.draw(3);
      pass.end();
    }
    const tail = capture.encodeTail(encoder);
    expect(tail.ok, 'RHI session must encode timing resolve').toBe(true);
    encoder.copyTextureToBuffer(
      { texture, origin: { x: WIDTH / 2 - 1, y: 0, z: 0 } },
      { buffer: pixelReadback, bytesPerRow: 256, rowsPerImage: HEIGHT },
      { width: 2, height: 1, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    capture.markSubmitted(device.queue.onSubmittedWorkDone());
    const observed = await capture.observe();
    expect(observed.ok, 'RHI timing session must observe the submitted frame').toBe(true);
    if (!observed.ok) throw new Error(observed.error.hint);
    await pixelReadback.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
    const pixel = pixelReadback.getMappedRange(0, 16).unwrap().slice(0);
    pixelReadback.unmap();
    const frame = observed.value;
    const ticks = frame.passes.map((pass) => {
      if (pass.status !== 'measured') throw new Error(`RHI pass ${pass.passName} is unmeasured`);
      return {
        passName: pass.passName as PassName,
        beginningTick: BigInt(pass.beginningTick),
        endTick: BigInt(pass.endTick),
      };
    });
    return {
      path: 'rhi-session',
      sequence,
      repetition,
      ticks,
      output: Array.from(new Uint16Array(pixel)),
      durationTicks: ticks.map((tick) => (tick.endTick - tick.beginningTick).toString(10)),
      overlapPairs: intervalsFromTicks(ticks),
    };
  } finally {
    session.dispose();
    device.destroyTexture(texture);
    device.destroyBuffer(pixelReadback);
  }
}

async function requestRhiDevice() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  if (!adapter.features.has('timestamp-query')) return undefined;
  return (await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })).unwrap();
}

export async function verifyRasterTimestampEnvelope(skip: (reason: string) => never) {
    const native = await requestNativeDevice();
    const rhiDevice = await requestRhiDevice();
    if (native === undefined || rhiDevice === undefined) {
      skip('adapter does not support timestamp-query');
    }
    const nativePipelines = {
      L: native.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: native.device.createShaderModule({ code: shader(1) }), entryPoint: 'vs' },
        fragment: { module: native.device.createShaderModule({ code: shader(1) }), entryPoint: 'fs', targets: [{ format: FORMAT }] },
        primitive: { topology: 'triangle-list' },
      }),
      H: native.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: native.device.createShaderModule({ code: shader(192) }), entryPoint: 'vs' },
        fragment: { module: native.device.createShaderModule({ code: shader(192) }), entryPoint: 'fs', targets: [{ format: FORMAT }] },
        primitive: { topology: 'triangle-list' },
      }),
    } as const;
    const rhiPipelines = {
      L: createRhiPipeline(rhiDevice, 1),
      H: createRhiPipeline(rhiDevice, 192),
    } as const;
    const samples: ProbeSample[] = [];
    try {
      for (const sequence of SEQUENCES) {
        for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
          samples.push(await runNative(native.device, sequence, repetition, nativePipelines));
          samples.push(await runRhi(rhiDevice, sequence, repetition, rhiPipelines));
        }
      }
    } finally {
      native.device.destroy();
    }
    expect(samples).toHaveLength(SEQUENCES.length * REPETITIONS * 2);
    expect(samples.every((sample) => sample.output.length === 8)).toBe(true);
    expect(samples.every((sample) => sample.output.some((value) => value !== 0))).toBe(true);
    expect(samples.every((sample) => sample.ticks.every((tick) => tick.endTick >= tick.beginningTick))).toBe(true);
    const sampleFor = (path: ProbeSample['path'], sequence: Sequence, repetition: number) => {
      const sample = samples.find((candidate) => candidate.path === path
        && candidate.repetition === repetition
        && candidate.sequence.join(',') === sequence.join(','));
      if (sample === undefined) throw new Error(`missing probe sample ${path}:${sequence.join('->')}:${repetition}`);
      return sample;
    };
    for (const sequence of SEQUENCES) {
      for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
        const nativeSample = sampleFor('native-webgpu', sequence, repetition);
        const rhiSample = sampleFor('rhi-session', sequence, repetition);
        expect(rhiSample.output, `RHI/native output mismatch for ${sequence.join('->')} repetition ${repetition}`)
          .toEqual(nativeSample.output);
      }
    }
    for (const path of ['native-webgpu', 'rhi-session'] as const) {
      for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
        const low = sampleFor(path, SEQUENCES[0], repetition);
        const highThenLow = sampleFor(path, SEQUENCES[1], repetition);
        const lowThenHigh = sampleFor(path, SEQUENCES[2], repetition);
        // The right pixel is outside L's scissor. H -> L must therefore keep
        // H's result there, and L -> H must produce the same H result.
        expect(highThenLow.output.slice(4), `${path} H contribution disappeared at repetition ${repetition}`)
          .not.toEqual(low.output.slice(4));
        expect(highThenLow.output.slice(4), `${path} H result changed across ordering at repetition ${repetition}`)
          .toEqual(lowThenHigh.output.slice(4));
        // Conversely, H must replace L in the left pixel for L -> H.
        expect(lowThenHigh.output.slice(0, 4), `${path} H overwrite was not visible at repetition ${repetition}`)
          .not.toEqual(low.output.slice(0, 4));
      }
    }
    return {
      probe: 'raster-stage-envelope',
      adapter: nativeAdapterIdentity(native.adapter),
      resolution: { width: WIDTH, height: HEIGHT },
      format: FORMAT,
      repetitions: REPETITIONS,
      shaderIterations: { L: 1, H: 192 },
      samples: samples.map((sample) => ({
        path: sample.path,
        sequence: sample.sequence,
        repetition: sample.repetition,
        ticks: sample.ticks.map((tick) => ({
          passName: tick.passName,
          beginningTick: tick.beginningTick.toString(10),
          endTick: tick.endTick.toString(10),
        })),
        durationTicks: sample.durationTicks,
        overlapPairs: sample.overlapPairs,
        output: sample.output,
      })),
    };
}

function createRhiPipeline(device: Awaited<ReturnType<typeof requestRhiDevice>>, iterations: number) {
  if (device === undefined) throw new Error('RHI Dawn device is unavailable');
  const module = createShaderModuleImmediate(device, { code: shader(iterations) }).unwrap();
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs', buffers: [] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: FORMAT }] },
    primitive: { topology: 'triangle-list' },
  }).unwrap();
}
