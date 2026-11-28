import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { type BindGroup, RhiError, type Sampler } from '@forgeax/engine-rhi';
import { ok, type Result, shaderSourceDescriptor } from '@forgeax/engine-types';
import { stockUtilityShaderFactory } from '../assembly/utility-shader-prewarm';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { IBL_UNIFORM_SLOT_STRIDE, iblPrefilterGroup0Entries } from '../ibl/IblPipelineCache';
import {
  createPmremPipeline,
  type PmremPipeline,
  pmremExtent,
  pmremLevelCount,
  pmremViewport,
} from '../ibl/pmrem';
import { SKY_SH_BYTES } from '../ibl/sky-sh';
import { addSkyShProjection } from '../ibl/sky-sh-graph';
import {
  ATMOSPHERE_PREFILTER_SIZE,
  ATMOSPHERE_SKY_FACES,
  atmospherePrefilterCopyPass,
  atmospherePrefilterPass,
} from '../record/gpu-pass-timing/sky-pass-names';
import type { RenderPipelineFrame } from '../render-pipeline';
import { atmosphereStorage } from './storage';

export interface GraphEnvironment {
  readonly atmosphere?: import('./luts').GraphAtmosphere;
  readonly sky: GraphTextureView;
  readonly skySh: GraphBuffer;
  readonly prefilter: GraphTextureView;
}

/** Atmosphere supplies the source cube; the shared PMREM kernel owns specular filtering. */
export function addAtmosphereIbl(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  sky: GraphTextureView,
  computeSkySh: boolean,
  dirty: (frame: RenderPipelineFrame) => boolean,
): Result<GraphEnvironment, RenderGraphError> {
  const size = ATMOSPHERE_PREFILTER_SIZE,
    levels = pmremLevelCount(size);
  const skySh = graph.importBuffer(
    'atmosphere-sky-sh',
    {
      size: SKY_SH_BYTES,
      usage:
        GPU_BUFFER_USAGE_UNIFORM |
        GPU_BUFFER_USAGE_COPY_DST |
        (computeSkySh ? GPU_BUFFER_USAGE_STORAGE : 0),
    },
    (frame) => atmosphereStorage(frame).skySh,
  );
  if (!skySh.ok) return skySh;
  const projected = addSkyShProjection(graph, sky, skySh.value, computeSkySh, dirty);
  if (!projected.ok) return projected;
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
  const prefilterView = graph.importView(
    prefilter.value,
    { dimension: '2d' },
    (frame) => atmosphereStorage(frame).prefilterView,
  );
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
  let state:
    | {
        sampler: Sampler;
        prefilter: PmremPipeline;
        parameters: BindGroup[];
      }
    | undefined;
  const ensureState = (frame: RenderPipelineFrame) => {
    if (state !== undefined) return state;
    const device = frame.runtime.device,
      factory = stockUtilityShaderFactory(frame.runtime);
    const prefilterCode = frame.atmosphereShaders?.prefilter;
    if (factory === undefined || prefilterCode === undefined)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'compiled shared PMREM program',
        hint: 'rebuild the Engine shader manifest before selecting Atmosphere lighting',
      });
    const specular = factory
      .createShaderModule(shaderSourceDescriptor(prefilterCode, 'ibl-prefilter'))
      .unwrap();
    state = {
      prefilter: createPmremPipeline(device, specular, 'rgba16float').unwrap(),
      sampler: device
        .createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })
        .unwrap(),
      parameters: [],
    };
    return state;
  };
  for (let level = 0; level < levels; level++) {
    const added = graph.addRasterPass(atmospherePrefilterPass(level), {
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
      encodeDirect: (pass, frame, resources) => {
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
        for (let face = 0; face < ATMOSPHERE_SKY_FACES; face++) {
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
    const copied = graph.addCopyPass(atmospherePrefilterCopyPass(level), {
      accesses: [
        { resource: prefilterView.value, usage: 'copy-src' },
        { resource: scratchView.value, usage: 'copy-dst' },
      ],
      executeIf: dirty,
      encodeDirect: (encoder, frame, resources) => {
        for (let face = 0; face < ATMOSPHERE_SKY_FACES; face++) {
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
  return ok({ sky, skySh: skySh.value, prefilter: prefilterView.value });
}
