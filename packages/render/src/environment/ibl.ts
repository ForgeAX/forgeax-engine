import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupLayout,
  type RenderPipeline,
  RhiError,
  type Sampler,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame } from '../render-pipeline';
import { atmosphereStorage } from './storage';

/** Graph views of the shared device-owned sky and its lighting products. */
export interface GraphEnvironment {
  readonly atmosphere?: import('./luts').GraphAtmosphere;
  readonly sky: GraphTextureView;
  readonly irradiance: GraphTextureView;
  readonly prefilter: GraphTextureView;
}

export function addAtmosphereIbl(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  sky: GraphTextureView,
  vertices: GraphBuffer,
  dirty: (frame: RenderPipelineFrame) => boolean,
): Result<GraphEnvironment, RenderGraphError> {
  const irradiance = graph.importTexture(
    'atmosphere-irradiance',
    {
      format: 'rgba16float',
      size: { width: 16, height: 16, depthOrArrayLayers: 6 },
      usage: 0x14,
    },
    (frame) => atmosphereStorage(frame).irradiance,
  );
  if (!irradiance.ok) return irradiance;
  const prefilter = graph.importTexture(
    'atmosphere-prefilter',
    {
      format: 'rgba16float',
      size: { width: 64, height: 64, depthOrArrayLayers: 6 },
      mipLevelCount: 5,
      usage: 0x14,
    },
    (frame) => atmosphereStorage(frame).prefilter,
  );
  if (!prefilter.ok) return prefilter;
  const irradianceView = graph.view(irradiance.value, { dimension: 'cube', arrayLayerCount: 6 });
  if (!irradianceView.ok) return irradianceView;
  const prefilterView = graph.view(prefilter.value, { dimension: 'cube', arrayLayerCount: 6 });
  if (!prefilterView.ok) return prefilterView;
  const parameters = graph.importBuffer(
    'atmosphere-ibl-params',
    { size: 5 * 256, usage: 0x48 },
    (frame) => atmosphereStorage(frame).iblParams,
  );
  if (!parameters.ok) return parameters;
  const upload = graph.addCopyPass('atmosphere-ibl-prepare', {
    accesses: [{ resource: parameters.value, usage: 'copy-dst' }],
    executeIf: dirty,
    encode: ({ frame, resources }) => {
      const values = new Float32Array(5 * 64);
      for (let mip = 0; mip < 5; mip++) values[mip * 64] = mip / 4;
      frame.runtime.device.queue
        .writeBuffer(resources.buffer(parameters.value).unwrap(), 0, values)
        .unwrap();
    },
  });
  if (!upload.ok) return upload;
  let state:
    | {
        layout: BindGroupLayout;
        inputLayout: BindGroupLayout;
        sampler: Sampler;
        irradiance: RenderPipeline;
        prefilter: RenderPipeline;
        inputs?: BindGroup;
        parameters: BindGroup[];
      }
    | undefined;
  const ensureState = (frame: RenderPipelineFrame) => {
    if (state !== undefined) return state;
    const device = frame.runtime.device;
    const source = frame.atmosphereShaders?.ibl;
    const factory = frame.runtime.shaderModuleFactory;
    if (source === undefined || factory === undefined)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'the compiled Atmosphere IBL program is available',
        hint: 'rebuild the Engine shader manifest before selecting Atmosphere lighting',
      });
    const module = factory.createShaderModule({ code: source, label: 'atmosphere_ibl' }).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform', minBindingSize: 64 } }],
      })
      .unwrap();
    const inputLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: 'cube' } },
          { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        ],
      })
      .unwrap();
    const pipelineLayout = device
      .createPipelineLayout({ bindGroupLayouts: [layout, inputLayout] })
      .unwrap();
    const pipeline = (entryPoint: string) =>
      device
        .createRenderPipeline({
          label: entryPoint,
          layout: pipelineLayout,
          vertex: {
            module,
            entryPoint: 'atmosphere_ibl_vs',
            buffers: [
              {
                arrayStride: 12,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
              },
            ],
          },
          fragment: { module, entryPoint, targets: [{ format: 'rgba16float' }] },
          primitive: { topology: 'triangle-list' },
        })
        .unwrap();
    state = {
      layout,
      inputLayout,
      sampler: device
        .createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })
        .unwrap(),
      irradiance: pipeline('atmosphere_irradiance_fs'),
      prefilter: pipeline('atmosphere_prefilter_fs'),
      parameters: [],
    };
    return state;
  };
  for (const product of ['irradiance', 'prefilter'] as const) {
    for (let mip = 0; mip < (product === 'irradiance' ? 1 : 5); mip++)
      for (let face = 0; face < 6; face++) {
        const target = graph.view(product === 'irradiance' ? irradiance.value : prefilter.value, {
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: mip,
          mipLevelCount: 1,
        });
        if (!target.ok) return target;
        const pass = graph.addRasterPass(`atmosphere-${product}-${mip}-${face}`, {
          accesses: [
            { resource: sky, usage: 'sampled-read' },
            { resource: parameters.value, usage: 'uniform-read' },
            { resource: vertices, usage: 'vertex-read' },
            { resource: target.value, usage: 'color-attachment' },
          ],
          colorAttachments: [{ view: target.value, loadOp: 'clear', storeOp: 'store' }],
          executeIf: dirty,
          encode: ({ frame, resources, pass }) => {
            const current = ensureState(frame);
            current.inputs = frame.runtime.device
              .createBindGroup({
                layout: current.inputLayout,
                entries: [
                  {
                    binding: 0,
                    resource: { kind: 'textureView', value: resources.textureView(sky).unwrap() },
                  },
                  { binding: 1, resource: { kind: 'sampler', value: current.sampler } },
                ],
              })
              .unwrap();
            let parameterGroup = current.parameters[mip];
            if (parameterGroup === undefined) {
              parameterGroup = frame.runtime.device
                .createBindGroup({
                  layout: current.layout,
                  entries: [
                    {
                      binding: 0,
                      resource: {
                        kind: 'buffer',
                        value: {
                          buffer: resources.buffer(parameters.value).unwrap(),
                          offset: mip * 256,
                          size: 64,
                        },
                      },
                    },
                  ],
                })
                .unwrap();
              current.parameters[mip] = parameterGroup;
            }
            pass.setPipeline(current[product]);
            pass.setBindGroup(0, parameterGroup);
            pass.setBindGroup(1, current.inputs);
            pass.setVertexBuffer(0, resources.buffer(vertices).unwrap());
            pass.draw(3, 1, face * 3);
            if (product === 'prefilter' && mip === 4 && face === 5)
              atmosphereStorage(frame).recordedEncoder = frame.encoder;
          },
        });
        if (!pass.ok) return pass;
      }
  }
  return ok({ sky, irradiance: irradianceView.value, prefilter: prefilterView.value });
}
