import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  RhiDevice,
  RhiError,
  ShaderModule,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok, type Result } from '@forgeax/engine-types';
import { DeviceScope } from '../device/device-scope';
import { addStandardColorLutPass } from '../pipeline/standard-output/lut-gpu';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';

export async function colorStageFixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const scope = DeviceScope.create(1, 'color-stage-owner');
  const modules = new Map<string, ShaderModule>();
  const factory = {
    createShaderModule: (input: {
      code: string;
      label?: string | undefined;
    }): Result<ShaderModule, RhiError> => {
      const key = input.label ?? input.code;
      let module = modules.get(key);
      if (module === undefined) {
        module = rhi.createShaderModuleImmediate(device, input).unwrap();
        modules.set(key, module);
      }
      return ok(module);
    },
  };
  function invalidateModules() {
    modules.clear();
  }
  function lutLayout() {
    return device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '3d' } },
          { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        ],
      })
      .unwrap();
  }
  const layout = lutLayout();
  const texture = device
    .createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 2 },
      dimension: '3d',
      textureBindingViewDimension: '3d',
      format: 'rgba16float',
      usage: 0x06,
    })
    .unwrap();
  const view = device.createTextureView(texture, { dimension: '3d' }).unwrap();
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
  const binding = (bindGroupLayout: BindGroupLayout) =>
    device
      .createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: view } },
          { binding: 1, resource: { kind: 'sampler', value: sampler } },
        ],
      })
      .unwrap();
  async function draw(
    options: {
      unscoped?: boolean;
      repeats?: number;
      strength?: number;
      width?: number;
      layout?: BindGroupLayout;
      device?: RhiDevice;
      scope?: DeviceScope;
      factory?: typeof factory;
      format?: TextureFormat;
    } = {},
  ) {
    const currentDevice = options.device ?? device;
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const input = createRenderPipelineTarget(graph, 'color-input', {
      size: 'surface',
      format: 'rgba16float',
    }).unwrap();
    const output = createRenderPipelineTarget(graph, 'color-output', {
      size: 'surface',
      format: options.format ?? 'rgba8unorm',
    }).unwrap();
    const imported = graph
      .importTexture(
        'color-lut',
        {
          size: { width: 2, height: 2, depthOrArrayLayers: 2 },
          dimension: '3d',
          format: 'rgba16float',
          usage: 0x06,
        },
        () => texture,
      )
      .unwrap();
    const importedView = graph.importView(imported, { dimension: '3d' }, () => view).unwrap();
    // Define the actual source attachment before the LUT's sampled read.
    let inputView: TextureView | undefined;
    graph
      .addRasterPass('color-input', {
        accesses: [{ resource: input.view, usage: 'color-attachment' }],
        colorAttachments: [
          { view: input.view, loadOp: 'clear', storeOp: 'store', clearValue: [0.2, 0.4, 0.8, 0.7] },
        ],
        encode({ resources }) {
          inputView = resources.textureView(input.view).unwrap();
        },
      })
      .unwrap();
    const currentLayout = options.layout ?? layout;
    const currentBinding = binding(currentLayout);
    addStandardColorLutPass(graph, input, output, {
      view: importedView,
      strength: options.strength ?? 0.35,
      bind: () => ({ bindGroupLayout: currentLayout, bindGroup: currentBinding }),
    }).unwrap();
    const compiled = graph
      .compile({ device: currentDevice, surfaceSize: { width: options.width ?? 8, height: 8 } })
      .unwrap();
    async function execute() {
      const encoder = currentDevice.createCommandEncoder().unwrap();
      const pipelines: unknown[] = [],
        groups: { index: number; group: unknown }[] = [];
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (descriptor) => {
        const pass = begin(descriptor),
          setPipeline = pass.setPipeline.bind(pass),
          setBindGroup = pass.setBindGroup.bind(pass);
        pass.setPipeline = (value) => {
          pipelines.push(value);
          setPipeline(value);
        };
        pass.setBindGroup = (index, group, offsets) => {
          groups.push({ index, group });
          setBindGroup(index, group, offsets === undefined ? undefined : Array.from(offsets));
        };
        return pass;
      };
      compiled
        .execute({
          encoder,
          runtime: {
            device: currentDevice,
            ...(options.unscoped ? {} : { deviceScope: options.scope ?? scope }),
            immediateShaderModuleFactory: options.factory ?? factory,
          },
        } as unknown as RenderPipelineFrame)
        .unwrap();
      currentDevice.queue.submit([encoder.finish().unwrap()]).unwrap();
      await currentDevice.queue.onSubmittedWorkDone();
      return { pipeline: pipelines[0], groups, lutBinding: currentBinding, inputView };
    }
    try {
      let result = await execute();
      for (let index = 1; index < (options.repeats ?? 1); index++) result = await execute();
      return result;
    } finally {
      (await compiled.retire()).unwrap();
    }
  }
  return { device, scope, factory, layout, lutLayout, draw, invalidateModules };
}
