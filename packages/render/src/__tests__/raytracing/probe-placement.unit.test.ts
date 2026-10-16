import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { createRasterProbePlacement } from '../../raytracing/probe-placement';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';

async function structuralDevice() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  assert(device instanceof RhiNullDevice);
  // RhiNull deliberately reports no numeric limits. Supply a declared test
  // device profile so these are admission tests, never GPU capability claims.
  Object.defineProperty(device, 'limits', {
    value: {
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 1000,
      maxStorageBuffersPerShaderStage: 8,
      maxSampledTexturesPerShaderStage: 16,
      maxUniformBuffersPerShaderStage: 12,
      maxUniformBufferBindingSize: 65536,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupStorageSize: 16384,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBufferBindingSize: 134217728,
      maxBufferSize: 268435456,
      minUniformBufferOffsetAlignment: 256,
    },
  });
  return device;
}

it('rejects invalid ranges and output aliasing before recording commands', async () => {
  const device = await structuralDevice();
  const placement = createRasterProbePlacement(
    device,
    (await createShaderModule(device, { code: '' })).unwrap(),
  ).unwrap();
  const buffer = (size: number) => device.createBuffer({ size, usage: 0xcc }).unwrap();
  const texture = device
    .createTexture({ size: { width: 1, height: 1 }, format: 'r32uint', usage: 4 })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const input = {
    depth: view,
    normal: view,
    identity: view,
    records: { buffer: buffer(128), size: 64 },
    view: { buffer: buffer(VIEW_UNIFORM_BYTES), size: VIEW_UNIFORM_BYTES },
    probes: buffer(32),
    accepted: buffer(32),
    candidate: buffer(32),
    diagnostics: buffer(16),
    viewRect: buffer(16),
  };
  const pass = device.createCommandEncoder({}).unwrap().beginComputePass({});
  for (const count of [0, -1, NaN, Infinity, 1.5, 65536])
    expect(placement.record(pass, input, count).ok).toBe(false);
  for (const size of [0, 1, 63, 65, NaN, Infinity, 2 ** 53]) {
    expect(placement.record(pass, { ...input, records: { ...input.records, size } }, 1).ok).toBe(
      false,
    );
  }
  expect(placement.record(pass, { ...input, view: { buffer: input.view.buffer } }, 1).ok).toBe(
    false,
  );
  for (const size of [0, VIEW_UNIFORM_BYTES - 16, VIEW_UNIFORM_BYTES + 16])
    expect(placement.record(pass, { ...input, view: { ...input.view, size } }, 1).ok).toBe(false);
  for (const offset of [-1, 1, NaN, Infinity, 256.5])
    expect(placement.record(pass, { ...input, view: { ...input.view, offset } }, 1).ok).toBe(false);
  for (const aliased of [
    input.accepted,
    input.probes,
    input.records.buffer,
    input.view.buffer,
    input.viewRect,
    input.diagnostics,
  ]) {
    expect(placement.record(pass, { ...input, candidate: aliased }, 1).ok).toBe(false);
  }
  for (const aliased of [
    input.accepted,
    input.probes,
    input.records.buffer,
    input.view.buffer,
    input.viewRect,
  ]) {
    expect(placement.record(pass, { ...input, diagnostics: aliased }, 1).ok).toBe(false);
  }
  expect(device.totalDispatchCount).toBe(0);
  expect(device.totalBindGroupCount).toBe(0);
  // This is only a structural positive control. Real pixels are covered by
  // the browser/Dawn raster fixture, never inferred from RhiNull.
  placement.record(pass, input, 1).unwrap();
  expect(device.totalDispatchCount).toBe(1);
  pass.end();
});

it('checks actual device capabilities and limits before layouts or dispatch', async () => {
  const device = await structuralDevice();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const createLayout = vi.spyOn(device, 'createBindGroupLayout');
  const limited = (limits: Partial<RhiDevice['limits']>, caps: Partial<RhiDevice['caps']> = {}) => {
    const result = Object.create(device) as RhiDevice;
    Object.defineProperty(result, 'limits', { value: { ...device.limits, ...limits } });
    Object.defineProperty(result, 'caps', { value: { ...device.caps, ...caps } });
    return result;
  };
  for (const caps of [{ compute: false }, { storageBuffer: false }])
    expect(createRasterProbePlacement(limited({}, caps), module)).toMatchObject({
      ok: false,
      error: { code: 'rhi-not-available' },
    });
  for (const limits of [
    { maxStorageBuffersPerShaderStage: 4 },
    { maxSampledTexturesPerShaderStage: 2 },
    { maxUniformBuffersPerShaderStage: 1 },
    { maxComputeWorkgroupSizeX: 32 },
    { maxComputeInvocationsPerWorkgroup: 32 },
    { maxComputeWorkgroupStorageSize: 12 },
    { maxUniformBufferBindingSize: 1024 },
    { maxBindingsPerBindGroup: 9 },
  ])
    expect(createRasterProbePlacement(limited(limits), module)).toMatchObject({
      ok: false,
      error: { code: 'limit-exceeded' },
    });
  expect(createLayout).not.toHaveBeenCalled();
  const placement = createRasterProbePlacement(
    limited({ maxComputeWorkgroupsPerDimension: 2 }),
    module,
  ).unwrap();
  const pass = device.createCommandEncoder({}).unwrap().beginComputePass({});
  // Count admission precedes access to input bindings, so no dummy resources
  // can accidentally turn this reduced-limit failure into a GPU command.
  expect(placement.record(pass, {} as Parameters<typeof placement.record>[1], 3)).toMatchObject({
    ok: false,
    error: { code: 'limit-exceeded' },
  });
  expect(device.totalDispatchCount).toBe(0);
  expect(device.totalBindGroupCount).toBe(0);
  pass.end();
});

it('owns persistent roles, stages fresh resets and retains submitted allocations until completion', async () => {
  const { RendererProbePlacement } = await import('../../raytracing/renderer-probe-placement');
  const device = await structuralDevice();
  const destroyed = vi.spyOn(device, 'destroyBuffer');
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  let seeds = [{ id: 7, generation: 1, position: [0, 0, -3] as const, cellSize: 2, traced: true }];
  const runtime = {
    device,
    deviceScope: { generation: 1 },
    canvas: { width: 32, height: 32 },
    standardProfile: { probePlacement: { seeds } },
    shaderRegistry: { entries: () => [{ wgsl: 'fn placeRasterProbes(' }] },
    createShaderModule,
    errorRegistry: {
      fire: (error: unknown) => {
        throw error;
      },
    },
  } as unknown as import('../../record/render-context').RenderSystemInternals;
  const owner = new RendererProbePlacement();
  expect(writes).not.toHaveBeenCalled();
  const texture = device
    .createTexture({ size: { width: 32, height: 32 }, format: 'r32uint', usage: 4 })
    .unwrap();
  const textureView = device.createTextureView(texture, {}).unwrap();
  const view = device.createBuffer({ size: VIEW_UNIFORM_BYTES, usage: 64 | 8 }).unwrap();
  const encode = (
    frame: import('../../raytracing/renderer-probe-placement').PreparedProbePlacement,
    encoder = device.createCommandEncoder({}).unwrap(),
  ) => {
    const pass = encoder.beginComputePass({});
    frame
      .record(
        pass,
        {
          ...frame,
          depth: textureView,
          normal: textureView,
          identity: textureView,
          records: { buffer: frame.records, size: frame.recordBytes },
          view: { buffer: view, size: VIEW_UNIFORM_BYTES },
        },
        frame.count,
      )
      .unwrap();
    pass.end();
  };
  const world = {};
  const prepare = (width = 32, camera = 11) =>
    owner.prepare({
      runtime,
      seeds,
      camera,
      world,
      records: new Uint32Array(16),
      width,
      height: 32,
    });
  expect(prepare()).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const first = prepare();
  assert(first);
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  encode(first);
  first.track(completion);
  first.commit();
  const acceptedGeneration = owner.inspect().generation;
  expect(owner.inspect().submittedFrames).toBe(1);
  const retry = prepare();
  assert(retry);
  expect(retry.accepted).toBe(first.candidate);
  expect(retry.candidate).toBe(first.accepted);
  retry.abort();
  const resized = prepare(48);
  assert(resized);
  expect(resized.accepted).toBe(first.candidate);
  resized.abort();
  const stale = prepare();
  assert(stale);
  encode(stale);
  const nextExtent = prepare(64);
  assert(nextExtent);
  stale.commit();
  expect(owner.inspect().submittedFrames).toBe(1);
  nextExtent.abort();
  const unrecorded = prepare();
  assert(unrecorded);
  unrecorded.commit();
  expect(owner.inspect().submittedFrames).toBe(1);
  const changedCanvas = prepare();
  assert(changedCanvas);
  encode(changedCanvas);
  runtime.canvas.width = 48;
  expect(changedCanvas.fence.currentGeneration()).toBe(-1);
  changedCanvas.commit();
  expect(owner.inspect().submittedFrames).toBe(1);
  const count = writes.mock.calls.length;
  assert(seeds[0]);
  seeds = [{ ...seeds[0], generation: 2 }];
  Object.assign(runtime, { standardProfile: { probePlacement: { seeds } } });
  const reset = prepare();
  assert(reset);
  expect(reset.accepted).not.toBe(first.accepted);
  expect(reset.accepted).not.toBe(first.candidate);
  expect(
    writes.mock.calls
      .slice(count)
      .every(([buffer]) => buffer !== first.accepted && buffer !== first.candidate),
  ).toBe(true);
  reset.abort();
  expect(owner.inspect().generation).toBe(acceptedGeneration);
  expect(owner.inspect().submittedFrames).toBe(1);
  expect(destroyed.mock.calls.some(([buffer]) => buffer === first.candidate)).toBe(false);
  const replacement = prepare();
  assert(replacement);
  encode(replacement);
  replacement.commit();
  expect(owner.inspect().generation).toBeGreaterThan(acceptedGeneration);
  expect(destroyed.mock.calls.some(([buffer]) => buffer === first.candidate)).toBe(false);
  finish();
  await completion;
  expect(destroyed.mock.calls.filter(([buffer]) => buffer === first.candidate)).toHaveLength(1);
  const switched = prepare(48, 12);
  assert(switched);
  expect(switched.accepted).not.toBe(replacement.candidate);
  switched.abort();
  owner.disable();
  expect(owner.inspect().state).toBe('disabled');
  const enabled = prepare();
  assert(enabled);
  expect(enabled.accepted).not.toBe(replacement.candidate);
  const { recordFrameTransaction, submitFrameRecordings } = await import(
    '../../assembly/frame-recording'
  );
  let completeSubmitted!: () => void;
  const submittedDone = new Promise<void>((resolve) => {
    completeSubmitted = resolve;
  });
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(async () => {
    await submittedDone;
    return undefined;
  });
  const submittedFrame = enabled;
  const encoder = device.createCommandEncoder({}).unwrap();
  function* recording(): import('../../assembly/frame-recording').FrameRecording {
    const result = yield* recordFrameTransaction(
      {
        build: () => ({ ok: true, value: undefined }),
        execute: () => {
          encode(submittedFrame, encoder);
          return { ok: true, value: undefined };
        },
        finish: () => ({ ok: true, value: undefined }),
        generationFence: submittedFrame.fence,
        commit: () => submittedFrame.commit(),
        abort: () => submittedFrame.abort(),
      },
      {
        encoder,
        device,
        reportError: () => undefined,
        onSubmittedWork: (done) => {
          submittedFrame.track(done);
          owner.disable();
        },
      },
    );
    return result.ok;
  }
  expect(submitFrameRecordings([recording()])).toBe(true);
  expect(destroyed.mock.calls.some(([buffer]) => buffer === enabled.candidate)).toBe(false);
  completeSubmitted();
  await submittedDone;
  await Promise.resolve();
  expect(destroyed.mock.calls.filter(([buffer]) => buffer === enabled.candidate)).toHaveLength(1);
  owner.dispose();
  expect(prepare()).toBeUndefined();
});

it('preserves the shader producer error code and detail without allocating placement storage', async () => {
  const { RendererProbePlacement } = await import('../../raytracing/renderer-probe-placement');
  const device = await structuralDevice();
  const create = vi.spyOn(device, 'createBuffer');
  const fire = vi.fn();
  const failure = new RhiError({
    code: 'shader-compile-failed',
    expected: 'published kernel compiles',
    hint: 'repair the shader producer',
    detail: {
      compilerMessages: [
        {
          type: 'error',
          message: 'invalid kernel',
          lineNum: 7,
          linePos: 2,
          offset: 20,
          length: 4,
        } as GPUCompilationMessage,
      ],
    },
  });
  const seeds = [
    { id: 1, generation: 1, position: [0, 0, -3] as const, cellSize: 2, traced: true },
  ];
  const runtime = {
    device,
    deviceScope: { generation: 1 },
    canvas: { width: 32, height: 32 },
    standardProfile: { probePlacement: { seeds } },
    shaderRegistry: { entries: () => [{ wgsl: 'fn placeRasterProbes(' }] },
    createShaderModule: async () => err(failure),
    errorRegistry: { fire },
  } as unknown as import('../../record/render-context').RenderSystemInternals;
  const owner = new RendererProbePlacement();
  owner.prepare({
    runtime,
    seeds,
    camera: 1,
    world: {},
    records: new Uint32Array(16),
    width: 32,
    height: 32,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(owner.inspect()).toMatchObject({
    state: 'failed',
    generation: 0,
    submittedFrames: 0,
    error: { code: 'shader-compile-failed', detail: failure.detail },
  });
  expect(fire).toHaveBeenCalledWith(failure);
  expect(create).not.toHaveBeenCalled();
  owner.dispose();
});

it('admits a cooked native Standard hash only through its matching accepted source projection', async () => {
  const { isNativePlacementMaterial } = await import('../../raytracing/scene-field-projection');
  const { DEFAULT_STANDARD_SURFACE_MODULE } = await import('@forgeax/engine-shader');
  const pass = {
    name: 'forward',
    module: 'forgeax_material::standard',
    moduleSlots: { surface: DEFAULT_STANDARD_SURFACE_MODULE },
    programs: [{ specializationKey: 'cooked-forward' }],
  };
  const projection = {
    passes: [pass],
  } as unknown as import('@forgeax/engine-assets-runtime').MaterialRenderProjection;
  const material = {
    materialShaderId: 'cooked-forward',
    materialProgramKeys: { forward: 'cooked-forward' },
  };
  expect(isNativePlacementMaterial(material, projection)).toBe(true);
  expect(
    isNativePlacementMaterial({ ...material, materialShaderId: 'unlit-or-stale' }, projection),
  ).toBe(false);
  expect(isNativePlacementMaterial(material, undefined)).toBe(false);
  const { Materials } = await import('../../materials');
  const nativeSource = Materials.standard({ baseColor: [1, 1, 1, 1] });
  expect(
    isNativePlacementMaterial(
      { materialShaderId: 'forgeax::default-standard-pbr' },
      undefined,
      nativeSource,
    ),
  ).toBe(true);
  expect(
    isNativePlacementMaterial(
      { ...material, materialProgramKeys: { forward: 'stale' } },
      projection,
    ),
  ).toBe(false);
  for (const changed of [
    { ...pass, module: 'forgeax_material::unlit' },
    { ...pass, moduleSlots: { surface: 'custom::surface' } },
    { ...pass, renderState: { tags: { SurfaceKind: 'full-custom' } } },
  ])
    expect(
      isNativePlacementMaterial(material, {
        ...projection,
        passes: [changed],
      } as unknown as typeof projection),
    ).toBe(false);
});
