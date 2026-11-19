import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type CommandBuffer, err, type RhiCommandEncoder, RhiError } from '@forgeax/engine-rhi';
import {
  createShaderModuleImmediate,
  RhiNullCommandEncoder,
  RhiNullDevice,
  RhiNullQueue,
} from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { createMockGpu } from '../../../rhi-webgpu/src/__tests__/__mocks__/gpu-device';
import { makeRhiDevice } from '../../../rhi-webgpu/src/device';
import { createShaderModuleImmediate as createWebgpuShaderModule } from '../../../rhi-webgpu/src/index';
import { createComputeStatePreparation } from '../compute-graph-state';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import { scenePipelinePreparations } from '../record/scene-pipeline-preparation';
import { admitSsrSpatial } from '../ssr/admission';
import { addSsrSpatialPasses } from '../ssr/graph';

const WIDTH = 5;
const HEIGHT = 3;

type Frame = { readonly encoder: RhiCommandEncoder };

class RecordingNullQueue extends RhiNullQueue {
  submitCount = 0;
  submitted: readonly CommandBuffer[] = [];

  override submit(commandBuffers: readonly CommandBuffer[]) {
    this.submitCount += 1;
    this.submitted = commandBuffers;
    return super.submit(commandBuffers);
  }
}

function admittedAdmission() {
  return admitSsrSpatial({
    camera: {
      projection: 'perspective',
      near: 0.1,
      far: 100,
      screenSpaceReflection: {
        waterTemporal: 0,
        maxDistance: 40,
        thickness: 0.2,
        maxRoughness: 0.6,
      },
    },
    environment: {
      lane: 'deferred',
      m0: { status: 'admitted' },
      sceneInputs: true,
      temporal: true,
      reflectionFallback: true,
      capabilities: {
        compute: true,
        storageTexture: true,
        rgba16floatRenderable: true,
        r32floatSampledStorage: true,
      },
    },
  });
}

function input(
  graph: RenderGraphBuilder<Frame>,
  label: string,
  format: 'rgba16float' | 'r32float' | 'r32uint',
) {
  const texture = graph
    .createTexture(label, {
      format,
      size: { width: WIDTH, height: HEIGHT },
    })
    .unwrap();
  return graph.view(texture, { label: `${label}.view` }).unwrap();
}

function createDevice(queue: RecordingNullQueue): RhiNullDevice {
  return new RhiNullDevice(
    queue,
    (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
  );
}

it('prepares the declared SSR trace and temporal programs before either compute encode', async () => {
  const graph = new RenderGraphBuilder<Frame>();
  const passes = vi.spyOn(graph, 'addComputePass');
  const depth = input(graph, 'depth', 'r32float');
  const normal = input(graph, 'normal', 'r32uint');
  const scene = input(graph, 'scene', 'rgba16float');
  const pyramid = addDepthPyramidPasses(graph, { depth, width: WIDTH, height: HEIGHT }).unwrap();
  const params = graph.createBuffer('params', { size: 256 }).unwrap();
  addSsrSpatialPasses(graph, {
    admission: admittedAdmission(),
    width: WIDTH,
    height: HEIGHT,
    depth,
    normal,
    scene,
    fallback: scene,
    currentTemporal: scene,
    depthPyramid: pyramid.pyramid,
    view: params,
    temporal: {
      profile: 'opaque',
      previousHistory: scene,
      outputHistory: scene,
      previousSurface: scene,
      outputSurface: scene,
      params,
    },
  }).unwrap();
  const queue = new RecordingNullQueue();
  const device = createDevice(queue);
  const sync = vi.spyOn(device, 'createComputePipeline');
  const completions: (() => void)[] = [];
  const create = vi.fn(
    (descriptor: Parameters<typeof device.createComputePipeline>[0]) =>
      new Promise<ReturnType<typeof device.createComputePipeline>>((resolve) => {
        completions.push(() => resolve(device.createComputePipeline(descriptor)));
      }),
  );
  Object.assign(device, { createComputePipelineAsync: create });
  const frame = {
    frameState: {},
    bindGroupCounts: { createBindGroup: 0, keys: [] as string[] },
    ssrShaders: { trace: 'trace-source', temporal: 'temporal-source' },
    runtime: {
      device,
      shaderModuleFactory: {
        createShaderModule: (descriptor: Parameters<typeof createShaderModuleImmediate>[1]) =>
          createShaderModuleImmediate(device, descriptor),
      },
    },
  };
  const prepare = () => {
    const matches: boolean[] = [];
    for (const program of scenePipelinePreparations(graph as never))
      matches.push(program(frame as never, new Map()));
    expect(matches).toEqual([false]);
  };
  prepare();
  expect(create.mock.calls.map(([descriptor]) => descriptor.compute.entryPoint)).toEqual([
    'ssr_trace',
    'ssr_temporal',
    'ssr_reflection_mip',
  ]);
  expect(sync).not.toHaveBeenCalled();
  expect(frame.frameState).toMatchObject({ pipelinePreparationPending: true });
  for (const complete of completions) complete();
  await Promise.resolve();
  sync.mockClear();
  Object.assign(frame.frameState, { pipelinePreparationPending: false });
  prepare();
  expect(frame.frameState).toMatchObject({ pipelinePreparationPending: false });
  expect(sync).not.toHaveBeenCalled();
  expect(queue.submitCount).toBe(0);
  expect(passes.mock.calls.some(([name]) => name === 'ssr-trace')).toBe(true);
  const texture = device
    .createTexture({ size: { width: WIDTH, height: HEIGHT }, format: 'rgba16float', usage: 4 })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const buffer = device.createBuffer({ size: 4096, usage: 0x40 | 0x80 }).unwrap();
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn() };
  const execute = () => {
    for (const [name, declaration] of passes.mock.calls) {
      if (name.startsWith('ssr-'))
        declaration.encode?.({
          frame,
          pass,
          resources: {
            textureView: () => ({ ok: true, value: view }),
            buffer: () => ({ ok: true, value: buffer }),
          },
        } as never);
    }
  };
  execute();
  expect(pass.setPipeline).toHaveBeenCalledTimes(3);
  expect(pass.dispatchWorkgroups).toHaveBeenCalledTimes(4);
  expect(create).toHaveBeenCalledTimes(3);
  expect(sync).not.toHaveBeenCalled();
  expect(queue.submitCount).toBe(0);
  device.destroyBuffer(buffer).unwrap();
  device.destroyTexture(texture).unwrap();
});

it('replaces SSR preparation on source/device changes and rejects failures without stale acceptance', async () => {
  const device = createDevice(new RecordingNullQueue());
  const otherDevice = createDevice(new RecordingNullQueue());
  const completions: (() => void)[] = [];
  const create = vi.fn(
    (descriptor: Parameters<typeof device.createComputePipeline>[0]) =>
      new Promise<ReturnType<typeof device.createComputePipeline>>((resolve) => {
        completions.push(() => resolve(device.createComputePipeline(descriptor)));
      }),
  );
  Object.assign(device, { createComputePipelineAsync: create });
  const selected = { source: 'first-source' };
  const factory = (device: RhiNullDevice) => ({
    createShaderModule: (descriptor: Parameters<typeof createShaderModuleImmediate>[1]) =>
      createShaderModuleImmediate(device, descriptor),
  });
  const frame = { frameState: {}, runtime: { device, shaderModuleFactory: factory(device) } };
  const prepare = createComputeStatePreparation(
    () => selected.source,
    'ssr_trace',
    [],
    'ssr_trace',
  );
  expect(prepare(frame as never)).toBeUndefined();
  selected.source = 'replacement-source';
  expect(prepare(frame as never)).toBeUndefined();
  completions[0]?.();
  await Promise.resolve();
  expect(prepare(frame as never)).toBeUndefined();
  completions[1]?.();
  await Promise.resolve();
  const replacement = prepare(frame as never);
  expect(replacement).toBeDefined();
  expect(prepare(frame as never)).toBe(replacement);
  frame.runtime = { device: otherDevice, shaderModuleFactory: factory(otherDevice) };
  const recovered = prepare(frame as never);
  expect(recovered).toBeDefined();
  expect(recovered).not.toBe(replacement);
  expect(create).toHaveBeenCalledTimes(2);
  const failure = new RhiError({
    code: 'shader-compile-failed',
    expected: 'SSR failure control',
    hint: 'rejected source',
  });
  const retry = vi.spyOn(otherDevice, 'createComputePipeline').mockReturnValueOnce(err(failure));
  selected.source = 'retry-source';
  expect(() => prepare(frame as never)).toThrow(failure);
  expect(prepare(frame as never)).toBeDefined();
  expect(retry).toHaveBeenCalledTimes(2);
});

it('holds SSR on the actual backend compilation signal and consumes the same completed native recipe', async () => {
  const adapter = await createMockGpu().requestAdapter();
  if (adapter === null) throw new Error('Missing WebGPU adapter fixture');
  const raw = (await adapter.requestDevice()) as unknown as GPUDevice;
  let finish!: (pipeline: GPUComputePipeline) => void;
  const native = vi.fn(
    () =>
      new Promise<GPUComputePipeline>((resolve) => {
        finish = resolve;
      }),
  );
  Object.assign(raw, { createComputePipelineAsync: native });
  const device = makeRhiDevice(raw).device;
  const sync = vi.spyOn(raw, 'createComputePipeline');
  const frame = {
    frameState: {},
    runtime: {
      device,
      shaderModuleFactory: {
        createShaderModule: (descriptor: Parameters<typeof createWebgpuShaderModule>[1]) =>
          createWebgpuShaderModule(device, descriptor),
      },
    },
  };
  const prepare = createComputeStatePreparation(
    () => '@compute @workgroup_size(1) fn ssr_trace() {}',
    'ssr_trace',
    [],
    'ssr_trace',
  );
  expect(prepare(frame as never)).toBeUndefined();
  const completion = device.pipelineLibrary?.pendingRuntimeCompilation?.();
  expect(completion).toBeDefined();
  expect(frame.frameState).toMatchObject({ pipelinePreparationPending: true });
  await Promise.resolve();
  expect(native).toHaveBeenCalledOnce();
  const pipeline = {} as GPUComputePipeline;
  finish(pipeline);
  expect((await completion)?.ok).toBe(true);
  await Promise.resolve();
  Object.assign(frame.frameState, { pipelinePreparationPending: false });
  expect(prepare(frame as never)?.pipeline).toBe(pipeline);
  expect(prepare(frame as never)?.pipeline).toBe(pipeline);
  expect(device.pipelineLibrary?.pendingRuntimeCompilation?.()).toBeUndefined();
  expect(sync).not.toHaveBeenCalled();
  expect(native).toHaveBeenCalledOnce();
});

describe('SSR spatial RhiNull integration', () => {
  it('executes the admitted odd-size topology once through one finish and submit', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const depth = input(graph, 'scene-depth', 'r32float');
    const normal = input(graph, 'gbuffer-normal', 'r32uint');
    const scene = input(graph, 'scene-color', 'rgba16float');
    const fallback = input(graph, 'reflection-fallback', 'rgba16float');
    const currentTemporal = input(graph, 'scene-temporal', 'rgba16float');
    const seeded = graph.addComputePass('seed-inputs', {
      accesses: [
        { resource: depth, usage: 'storage-write' },
        { resource: normal, usage: 'storage-write' },
        { resource: scene, usage: 'storage-write' },
        { resource: fallback, usage: 'storage-write' },
        { resource: currentTemporal, usage: 'storage-write' },
      ],
      encode: () => undefined,
    });
    expect(seeded.ok).toBe(true);

    const pyramid = addDepthPyramidPasses(graph, { depth, width: WIDTH, height: HEIGHT });
    expect(pyramid.ok).toBe(true);
    if (!pyramid.ok) return;
    const projected = addSsrSpatialPasses(graph, {
      admission: admittedAdmission(),
      width: WIDTH,
      height: HEIGHT,
      depth,
      normal,
      scene,
      fallback,
      currentTemporal,
      depthPyramid: pyramid.value.pyramid,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const queue = new RecordingNullQueue();
    const device = createDevice(queue);
    const compiled = graph.compile({ device, surfaceSize: { width: WIDTH, height: HEIGHT } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const encoder = device.createCommandEncoder({ label: 'ssr-spatial-rhinull-frame' });
    expect(encoder.ok).toBe(true);
    if (!encoder.ok) return;
    const executed = compiled.value.execute({ encoder: encoder.value });
    expect(executed.ok).toBe(true);
    const finished = encoder.value.finish();
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    const submitted = device.queue.submit([finished.value]);
    expect(submitted.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();

    expect(queue.submitCount).toBe(1);
    expect(queue.submitted).toHaveLength(1);
    expect(device.framePassNames).toEqual([
      'seed-inputs',
      'depth-pyramid-seed',
      'depth-pyramid-reduce-chain',
      'ssr-trace',
    ]);
    expect(compiled.value.inspect().resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'depth-pyramid', format: 'r32float' }),
        expect.objectContaining({ label: 'ssr-trace', format: 'rgba16float' }),
      ]),
    );
    expect(projected.value.trace).toMatchObject({
      resolution: 'full',
      hizIterations: 64,
      linearIterations: 1024,
      refineSteps: 5,
    });
    expect((await compiled.value.retire()).ok).toBe(true);
  });
});
