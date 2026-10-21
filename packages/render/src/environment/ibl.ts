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
import { writeAllPrefilterUniforms } from '../device/gpu-residency';
import { IBL_UNIFORM_SLOT_STRIDE, iblPrefilterGroup0Entries } from '../ibl/IblPipelineCache';
import {
  createPmremPipeline,
  type PmremPipeline,
  pmremExtent,
  pmremLevelCount,
  pmremViewport,
} from '../ibl/pmrem';
import type { RenderPipelineFrame } from '../render-pipeline';
import { atmosphereStorage } from './storage';

export interface GraphEnvironment {
  readonly atmosphere?: import('./luts').GraphAtmosphere;
  readonly sky: GraphTextureView;
  readonly irradiance: GraphTextureView;
  readonly prefilter: GraphTextureView;
}

/** Atmosphere supplies the source cube; the shared PMREM kernel owns specular filtering. */
export function addAtmosphereIbl(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  sky: GraphTextureView,
  vertices: GraphBuffer,
  dirty: (frame: RenderPipelineFrame) => boolean,
): Result<GraphEnvironment, RenderGraphError> {
  const size = 64,
    levels = pmremLevelCount(size);
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
      size: pmremExtent(size),
      usage: 0x17,
    },
    (frame) => atmosphereStorage(frame).prefilter,
  );
  if (!prefilter.ok) return prefilter;
  const scratch = graph.importTexture(
    'atmosphere-prefilter-scratch',
    {
      format: 'rgba16float',
      size: pmremExtent(size),
      usage: 0x17,
    },
    (frame) => atmosphereStorage(frame).prefilterScratch,
  );
  if (!scratch.ok) return scratch;
  const irradianceView = graph.view(irradiance.value, { dimension: 'cube', arrayLayerCount: 6 });
  if (!irradianceView.ok) return irradianceView;
  const prefilterView = graph.view(prefilter.value, { dimension: '2d' });
  if (!prefilterView.ok) return prefilterView;
  const scratchView = graph.view(scratch.value, { dimension: '2d' });
  if (!scratchView.ok) return scratchView;
  const parameters = graph.importBuffer(
    'atmosphere-ibl-params',
    {
      size: levels * 6 * IBL_UNIFORM_SLOT_STRIDE,
      usage: 0x48,
    },
    (frame) => atmosphereStorage(frame).iblParams,
  );
  if (!parameters.ok) return parameters;
  const upload = graph.addCopyPass('atmosphere-ibl-prepare', {
    accesses: [{ resource: parameters.value, usage: 'copy-dst' }],
    executeIf: dirty,
    encode: ({ frame, resources }) => {
      writeAllPrefilterUniforms(
        frame.runtime.device,
        resources.buffer(parameters.value).unwrap(),
        size,
      ).unwrap();
    },
  });
  if (!upload.ok) return upload;
  let state:
    | {
        irradiance: RenderPipeline;
        diffuseInputs: BindGroupLayout;
        sampler: Sampler;
        prefilter: PmremPipeline;
        parameters: BindGroup[];
      }
    | undefined;
  const ensureState = (frame: RenderPipelineFrame) => {
    if (state !== undefined) return state;
    const device = frame.runtime.device,
      factory = frame.runtime.shaderModuleFactory;
    const diffuseCode = frame.atmosphereShaders?.ibl,
      prefilterCode = frame.atmosphereShaders?.prefilter;
    if (factory === undefined || diffuseCode === undefined || prefilterCode === undefined)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'compiled Atmosphere irradiance and shared PMREM programs',
        hint: 'rebuild the Engine shader manifest before selecting Atmosphere lighting',
      });
    const diffuse = factory
      .createShaderModule({ code: diffuseCode, label: 'atmosphere_ibl' })
      .unwrap();
    const specular = factory
      .createShaderModule({ code: prefilterCode, label: 'ibl-prefilter' })
      .unwrap();
    const diffuseInputs = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: 'cube' } },
          { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        ],
      })
      .unwrap();
    state = {
      diffuseInputs,
      irradiance: device
        .createRenderPipeline({
          label: 'atmosphere_irradiance_fs',
          layout: device.createPipelineLayout({ bindGroupLayouts: [diffuseInputs] }).unwrap(),
          vertex: {
            module: diffuse,
            entryPoint: 'atmosphere_ibl_vs',
            buffers: [
              {
                arrayStride: 12,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
              },
            ],
          },
          fragment: {
            module: diffuse,
            entryPoint: 'atmosphere_irradiance_fs',
            targets: [{ format: 'rgba16float' }],
          },
          primitive: { topology: 'triangle-list' },
        })
        .unwrap(),
      prefilter: createPmremPipeline(device, specular, 'rgba16float').unwrap(),
      sampler: device
        .createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })
        .unwrap(),
      parameters: [],
    };
    return state;
  };
  for (let face = 0; face < 6; face++) {
    const target = graph.view(irradiance.value, {
      dimension: '2d',
      baseArrayLayer: face,
      arrayLayerCount: 1,
    });
    if (!target.ok) return target;
    const added = graph.addRasterPass(`atmosphere-irradiance-${face}`, {
      accesses: [
        { resource: sky, usage: 'sampled-read' },
        { resource: vertices, usage: 'vertex-read' },
        { resource: target.value, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view: target.value, loadOp: 'clear', storeOp: 'store' }],
      executeIf: dirty,
      encode: ({ frame, resources, pass }) => {
        const current = ensureState(frame);
        const group = frame.runtime.device
          .createBindGroup({
            layout: current.diffuseInputs,
            entries: [
              {
                binding: 0,
                resource: { kind: 'textureView', value: resources.textureView(sky).unwrap() },
              },
              { binding: 1, resource: { kind: 'sampler', value: current.sampler } },
            ],
          })
          .unwrap();
        pass.setPipeline(current.irradiance);
        pass.setBindGroup(0, group);
        pass.setVertexBuffer(0, resources.buffer(vertices).unwrap());
        pass.draw(3, 1, face * 3);
      },
    });
    if (!added.ok) return added;
  }
  for (let level = 0; level < levels; level++) {
    const added = graph.addRasterPass(`atmosphere-prefilter-${level}`, {
      accesses: [
        { resource: sky, usage: 'sampled-read' },
        { resource: scratchView.value, usage: 'sampled-read' },
        { resource: parameters.value, usage: 'uniform-read' },
        { resource: prefilterView.value, usage: 'color-attachment' },
      ],
      colorAttachments: [
        { view: prefilterView.value, loadOp: level === 0 ? 'clear' : 'load', storeOp: 'store' },
      ],
      executeIf: dirty,
      encode: ({ frame, resources, pass }) => {
        const current = ensureState(frame);
        const inputs = frame.runtime.device
          .createBindGroup({
            layout: current.prefilter.inputLayout,
            entries: [
              {
                binding: 0,
                resource: { kind: 'textureView', value: resources.textureView(sky).unwrap() },
              },
              { binding: 1, resource: { kind: 'sampler', value: current.sampler } },
              {
                binding: 2,
                resource: {
                  kind: 'textureView',
                  value: resources.textureView(scratchView.value).unwrap(),
                },
              },
            ],
          })
          .unwrap();
        pass.setPipeline(current.prefilter.pipeline);
        pass.setBindGroup(1, inputs);
        for (let face = 0; face < 6; face++) {
          const index = level * 6 + face;
          current.parameters[index] ??= frame.runtime.device
            .createBindGroup({
              layout: current.prefilter.parametersLayout,
              entries: iblPrefilterGroup0Entries(
                resources.buffer(parameters.value).unwrap(),
                level,
                face,
              ),
            })
            .unwrap();
          const group = current.parameters[index];
          const viewport = pmremViewport(size, level, face);
          pass.setBindGroup(0, group);
          pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
          pass.setScissorRect(viewport.x, viewport.y, viewport.width, viewport.height);
          pass.draw(3);
        }
      },
    });
    if (!added.ok) return added;
    const copied = graph.addCopyPass(`atmosphere-prefilter-copy-${level}`, {
      accesses: [
        { resource: prefilterView.value, usage: 'copy-src' },
        { resource: scratchView.value, usage: 'copy-dst' },
      ],
      executeIf: dirty,
      encode: ({ frame, encoder, resources }) => {
        for (let face = 0; face < 6; face++) {
          const viewport = pmremViewport(size, level, face);
          encoder.copyTextureToTexture(
            {
              texture: resources.texture(prefilter.value).unwrap(),
              origin: [viewport.x, viewport.y, 0],
            },
            {
              texture: resources.texture(scratch.value).unwrap(),
              origin: [viewport.x, viewport.y, 0],
            },
            { width: viewport.width, height: viewport.height, depthOrArrayLayers: 1 },
          );
        }
        if (level === levels - 1) atmosphereStorage(frame).recordedEncoder = frame.encoder;
      },
    });
    if (!copied.ok) return copied;
  }
  return ok({ sky, irradiance: irradianceView.value, prefilter: prefilterView.value });
}
