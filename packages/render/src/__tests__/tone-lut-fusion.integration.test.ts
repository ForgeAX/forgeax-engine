import { readFileSync } from 'node:fs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok, type Result } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { addStandardToneLutPass } from '../pipeline/standard-output/tone-lut';
import { addStandardPost } from '../pipeline/standard-post';
import { STANDARD_OUTPUT_TRANSFORM_FEATURE_ID } from '../render-contract';
import {
  createRenderPipelineTarget,
  type RenderPipelineBuildContext,
  type RenderPipelineFrame,
  type RenderPipelineTopology,
} from '../render-pipeline';

const toneSource = readFileSync(
  new URL('../../../shader/src/tonemap.wgsl', import.meta.url),
  'utf8',
);

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const scope = DeviceScope.create(1, 'tone-lut-owner');
  const modules = new Map<string, ShaderModule>();
  const factory = {
    createShaderModule(input: { code: string; label?: string }): Result<ShaderModule, RhiError> {
      let module = modules.get(input.code);
      if (module === undefined) {
        module = rhi.createShaderModuleImmediate(device, input).unwrap();
        modules.set(input.code, module);
      }
      return ok(module);
    },
  };
  const paramsBuffer = device.createBuffer({ size: 32, usage: 0x48 }).unwrap();
  function lutLayout() {
    return device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { viewDimension: '3d', sampleType: 'float' } },
          { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        ],
      })
      .unwrap();
  }
  const layout = lutLayout();
  const lutTexture = device
    .createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 2 },
      dimension: '3d',
      textureBindingViewDimension: '3d',
      format: 'rgba16float',
      usage: 0x06,
    })
    .unwrap();
  const lutView = device.createTextureView(lutTexture, { dimension: '3d' }).unwrap();
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
  async function build(
    options: {
      antialias?: 'none' | 'fxaa' | 'taa';
      observed?: boolean;
      outline?: boolean;
      rawOnly?: boolean;
      topology?: boolean;
      width?: number;
      extent?: NonNullable<RenderPipelineTopology['extent']>;
      strength?: number;
      format?: 'bgra8unorm' | 'rgba16float';
      scope?: DeviceScope;
      layout?: typeof layout;
    } = {},
  ) {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const input = createRenderPipelineTarget(graph, 'input', {
      size: 'surface',
      format: 'rgba16float',
    }).unwrap();
    const depth = createRenderPipelineTarget(graph, 'depth', {
      size: 'surface',
      format: 'depth32float',
    }).unwrap();
    const output = createRenderPipelineTarget(graph, 'output', {
      size: 'surface',
      format: options.format ?? 'bgra8unorm',
    }).unwrap();
    const temporal =
      options.antialias === 'taa'
        ? createRenderPipelineTarget(graph, 'scene-temporal', {
            size: 'surface',
            format: 'rgba16float',
          }).unwrap()
        : undefined;
    const historyTarget = (label: string, format: 'rgba16float' | 'r8unorm' = 'rgba16float') => {
      const texture = graph
        .importTexture(
          label,
          { size: 'surface', format, usage: 0x17 },
          (frame) => frame.outputTarget().texture,
        )
        .unwrap();
      const view = graph
        .importView(texture, { label: `${label}.view` }, (frame) => frame.outputTarget().view)
        .unwrap();
      return { texture, view, format, sampleCount: 1 as const };
    };
    const taaHistory =
      temporal === undefined
        ? undefined
        : {
            currentColor: historyTarget('taa-current-color'),
            previousColor: historyTarget('taa-previous-color'),
            currentTemporal: historyTarget('taa-current-temporal'),
            previousTemporal: historyTarget('taa-previous-temporal'),
            currentStability: historyTarget('taa-current-stability', 'r8unorm'),
            previousStability: historyTarget('taa-previous-stability', 'r8unorm'),
          };
    graph
      .addRasterPass('input', {
        accesses: [
          { resource: input.view, usage: 'color-attachment' },
          { resource: depth.view, usage: 'depth-stencil-write' },
          ...(temporal ? [{ resource: temporal.view, usage: 'color-attachment' as const }] : []),
        ],
        colorAttachments: [
          { view: input.view, loadOp: 'clear', storeOp: 'store' },
          ...(temporal
            ? [{ view: temporal.view, loadOp: 'clear' as const, storeOp: 'store' as const }]
            : []),
        ],
        depthStencilAttachment: {
          view: depth.view,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
        encode() {},
      })
      .unwrap();
    const imported = graph
      .importTexture(
        'lut',
        {
          size: { width: 2, height: 2, depthOrArrayLayers: 2 },
          dimension: '3d',
          format: 'rgba16float',
          usage: 0x06,
        },
        () => lutTexture,
      )
      .unwrap();
    const view = graph.importView(imported, { dimension: '3d' }, () => lutView).unwrap();
    const selectedLayout = options.layout ?? layout;
    const binding = device
      .createBindGroup({
        layout: selectedLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: lutView } },
          { binding: 1, resource: { kind: 'sampler', value: sampler } },
        ],
      })
      .unwrap();
    const lut = {
      view,
      strength: options.strength ?? 1,
      bind: () => ({ bindGroupLayout: selectedLayout, bindGroup: binding }),
    };
    if (options.topology) {
      addStandardPost(
        {
          graph,
          ...(options.observed ? { observationCaptureDomains: ['linear-ldr'] } : {}),
          standardOutput: { colorLut: lut },
          ...(taaHistory ? { taaHistory } : {}),
          contributeFeatures: () => ok(undefined),
          capabilities: { rgba16floatRenderable: true },
        } as unknown as RenderPipelineBuildContext<RenderPipelineFrame>,
        {
          camera: {
            tonemap: 'aces-filmic',
            antialias: options.antialias ?? 'none',
            bloom: 'off',
            outline: options.outline ?? false,
          },
          surface: {
            width: 8,
            height: 8,
            storageFormat: 'bgra8unorm',
            viewFormat: 'bgra8unorm-srgb',
            ...(options.rawOnly ? { profile: { kind: 'raw-only' } } : {}),
          },
          lane: { compute: true, storageBuffer: true },
          output: { colorLut: true },
          ...(options.extent ? { extent: options.extent } : {}),
        } as unknown as RenderPipelineTopology,
        input,
        depth,
        { storage: output },
        temporal,
      ).unwrap();
    } else addStandardToneLutPass(graph, input, output, lut, false).unwrap();
    const compiled = graph
      .compile({ device, surfaceSize: { width: options.width ?? 8, height: 8 } })
      .unwrap();
    const params = new Uint8Array(32);
    new DataView(params.buffer).setFloat32(0, 0.95, true);
    const frame = {
      postProcessParams: new Map([[STANDARD_OUTPUT_TRANSFORM_FEATURE_ID, params]]),
      runtime: {
        device,
        deviceScope: options.scope ?? scope,
        immediateShaderModuleFactory: factory,
        lookupPostProcess: () => ({ source: toneSource }),
        getPostProcessParamsBuffer: () => paramsBuffer,
      },
    } as unknown as RenderPipelineFrame;
    return { compiled, frame, binding, params };
  }
  async function draw(options: Parameters<typeof build>[0] = {}) {
    const built = await build(options),
      encoder = device.createCommandEncoder().unwrap();
    try {
      built.compiled.execute({ ...built.frame, encoder }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      return built;
    } finally {
      (await built.compiled.retire()).unwrap();
    }
  }
  return { device, scope, factory, modules, lutLayout, build, draw };
}

it('removes only the two unobserved adjacent intermediates and retains spatial AA/observer/outline/raw chains', async () => {
  const f = await fixture();
  for (const options of [
    {},
    { antialias: 'fxaa' as const },
    {
      antialias: 'taa' as const,
      extent: {
        outputWidth: 8,
        outputHeight: 8,
        internalWidth: 4,
        internalHeight: 4,
        scale: 0.5,
        generation: 1,
      },
    },
    { observed: true },
    { outline: true },
    { rawOnly: true },
  ]) {
    const { compiled } = await f.build({ ...options, topology: true });
    const info = compiled.inspect(),
      fused = Object.keys(options).length === 0;
    expect(info.passes.some((pass) => pass.name === 'standard-tone-lut-output')).toBe(fused);
    expect(info.resources.some((resource) => resource.label === 'standard-tone-output')).toBe(
      !fused,
    );
    expect(info.resources.some((resource) => resource.label === 'standard-color-lut')).toBe(!fused);
    expect(info.passes.some((pass) => pass.name === 'standard-output-encoding')).toBe(!fused);
    (await compiled.retire()).unwrap();
  }
  f.scope.retire();
});

it.each([
  undefined,
  {
    outputWidth: 8,
    outputHeight: 8,
    internalWidth: 8,
    internalHeight: 8,
    scale: 1,
    generation: 1,
  },
])('fuses native TAA output while preserving histories and observed boundaries (extent %j)', async (extent) => {
  const f = await fixture();
  for (const observed of [false, true]) {
    const { compiled } = await f.build({
      antialias: 'taa',
      topology: true,
      observed,
      ...(extent ? { extent } : {}),
    });
    try {
      const info = compiled.inspect();
      const names = info.passes.map((pass) => pass.name);
      expect(names).toContain('taa-resolve');
      expect(names.includes('standard-tone-lut-output')).toBe(!observed);
      expect(
        names.indexOf(observed ? 'standard-tone' : 'standard-tone-lut-output'),
      ).toBeGreaterThan(names.indexOf('taa-resolve'));
      expect(info.resources.some((resource) => resource.label === 'standard-tone-output')).toBe(
        observed,
      );
      expect(info.resources.some((resource) => resource.label === 'standard-color-lut')).toBe(
        observed,
      );
      expect(names.includes('standard-output-encoding')).toBe(observed);
      const resolve = info.passes.find((pass) => pass.name === 'taa-resolve');
      const output = info.passes.find(
        (pass) => pass.name === (observed ? 'standard-tone' : 'standard-tone-lut-output'),
      );
      expect(resolve?.accesses.some((access) => access.resource === 'taa-current-color')).toBe(
        true,
      );
      expect(output?.accesses.some((access) => access.resource === 'taa-current-color')).toBe(true);
      for (const label of [
        'taa-current-color',
        'taa-previous-color',
        'taa-current-temporal',
        'taa-previous-temporal',
        'taa-current-stability',
        'taa-previous-stability',
      ]) {
        expect(info.resources.some((resource) => resource.label === label)).toBe(true);
      }
    } finally {
      (await compiled.retire()).unwrap();
    }
  }
  f.scope.retire();
});

it('reuses the exact module/layout/target program while binding current source, LUT, strength and extent', async () => {
  const f = await fixture(),
    pipelines = vi.spyOn(f.device, 'createRenderPipeline'),
    groups = vi.spyOn(f.device, 'createBindGroup');
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  await f.draw();
  const second = await f.draw({ width: 16, strength: 0.25 });
  expect(pipelines).toHaveBeenCalledTimes(1);
  expect(pipelines.mock.calls[0]?.[0]).toMatchObject({
    vertex: { entryPoint: 'vs_main' },
    fragment: { entryPoint: 'fs_tone_lut_encode', targets: [{ format: 'bgra8unorm' }] },
  });
  expect(Array.from(groups.mock.calls.at(-1)?.[0].entries ?? [])[2]?.resource.kind).toBe('buffer');
  const payload = writes.mock.calls.at(-1)?.[2] as Uint8Array;
  const bytes = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  expect(bytes.getFloat32(20, true)).toBe(0.25);
  expect(bytes.getFloat32(24, true)).toBe(16);
  expect(bytes.getFloat32(28, true)).toBe(8);
  expect(second.params.every((value, index) => index < 4 || value === 0)).toBe(true);
  f.scope.retire();
});

it('invalidates for module replacement, exact LUT layout, target format and device generation', async () => {
  const f = await fixture(),
    pipelines = vi.spyOn(f.device, 'createRenderPipeline');
  await f.draw();
  f.modules.clear();
  await f.draw();
  await f.draw({ layout: f.lutLayout() });
  await f.draw({ format: 'rgba16float' });
  const next = DeviceScope.create(2, f.scope.owner);
  await f.draw({ scope: next });
  expect(pipelines).toHaveBeenCalledTimes(5);
  f.scope.retire();
  next.retire();
});

it('does not bypass factory pending or admit a failed program, and releases scope retention', async () => {
  const f = await fixture(),
    pipelines = vi.spyOn(f.device, 'createRenderPipeline');
  const failed = err(
    new RhiError({ code: 'rhi-not-available', expected: 'pending', hint: 'retry' }),
  );
  vi.spyOn(f.factory, 'createShaderModule').mockReturnValueOnce(failed);
  await expect(f.draw()).rejects.toBeDefined();
  expect(pipelines).toHaveBeenCalledTimes(0);
  pipelines.mockReturnValueOnce(failed);
  await expect(f.draw()).rejects.toBeDefined();
  await f.draw();
  await f.draw();
  expect(pipelines).toHaveBeenCalledTimes(2);
  expect(f.scope.resourceDelta()).toBe(1);
  f.scope.retire();
  expect(f.scope.resourceDelta()).toBe(0);
  await f.draw();
  await f.draw();
  expect(pipelines).toHaveBeenCalledTimes(4);
});

it('retains one graph input binding while still uploading parameters and observing factory failures', async () => {
  const f = await fixture();
  const built = await f.build();
  const groups = vi.spyOn(f.device, 'createBindGroup');
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  const execute = async () => {
    const encoder = f.device.createCommandEncoder().unwrap();
    built.compiled.execute({ ...built.frame, encoder }).unwrap();
    f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await f.device.queue.onSubmittedWorkDone();
  };
  try {
    await execute();
    new DataView(built.params.buffer).setFloat32(0, 0.5, true);
    await execute();
    expect(groups).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(2);
    const pending = err(
      new RhiError({ code: 'rhi-not-available', expected: 'pending', hint: 'retry' }),
    );
    vi.spyOn(f.factory, 'createShaderModule').mockReturnValueOnce(pending);
    await expect(execute()).rejects.toBeDefined();
    expect(groups).toHaveBeenCalledTimes(1);
    const replacement = f.device.createBuffer({ size: 32, usage: 0x48 }).unwrap();
    vi.spyOn(built.frame.runtime, 'getPostProcessParamsBuffer').mockReturnValue(replacement);
    groups.mockReturnValueOnce(pending);
    await expect(execute()).rejects.toBeDefined();
    await execute();
    await execute();
    expect(groups).toHaveBeenCalledTimes(3);
    f.modules.clear();
    await execute();
    expect(groups).toHaveBeenCalledTimes(4);
  } finally {
    (await built.compiled.retire()).unwrap();
    f.scope.retire();
  }
});
