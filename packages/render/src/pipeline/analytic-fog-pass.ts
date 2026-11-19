import {
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { addAtmosphereComposition } from '../environment/compose';
import type { GraphAtmosphere } from '../environment/luts';
import { postProcessShaderModuleLabel } from '../fullscreen-post-process-pass';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { SkyPass } from '../record/gpu-pass-timing/sky-pass-names';
import { registerScenePipelinePreparation } from '../record/scene-pipeline-preparation';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type {
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import { markPipelinePreparationPending } from '../render-system-presentation';
import { addAuthoredVolumetricFogPasses } from '../volume/passes';
import { renderInternalCopySize } from './render-extent';
import type { StandardClusterGraphBuffers } from './standard-lighting/graph';

export const ANALYTIC_FOG_POST_PROCESS_ID = 'forgeax.analytic-fog';

/** Full atmosphere composition still requires single-sample scene depth. */
export function analyticFogSampleCountError(): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-resolution-failed',
    expected: 'full atmosphere composition receives single-sample scene depth',
    hint: 'select single-sample rendering for full Atmosphere; standalone Fog supports native MSAA',
    detail: { resourceLabel: 'scene-depth' },
  });
}

function analyticFogModule(frame: RenderPipelineFrame): Result<ShaderModule, RhiError> {
  const source = frame.runtime.lookupPostProcess?.(ANALYTIC_FOG_POST_PROCESS_ID)?.source;
  const factory = frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
  if (source === undefined || factory === undefined) {
    throw new RenderGraphError({
      code: 'resource-resolution-failed',
      expected: 'the registered forgeax.analytic-fog shader and a shader module factory',
      hint: 'include forgeax::analytic-fog in the engine shader manifest',
      detail: { resourceLabel: 'analytic-fog' },
    });
  }
  return factory.createShaderModule({ code: source, label: postProcessShaderModuleLabel(source) });
}

/**
 * Fog the opaque scene in place before transmission copies and translucent
 * draws. Translucent writers fog themselves at their own depth through the
 * shared View fog lanes (UE `CalculateHeightFog` per translucent vertex/pixel),
 * so blending them afterwards composites fog depth-correctly instead of
 * applying the opaque surface's fog to everything in front of it.
 */
export function addAnalyticFogPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly color: RenderPipelineTarget;
    readonly resolve?: RenderPipelineTarget | undefined;
    readonly depth: GraphTextureView;
  },
): Result<void, RenderGraphError> {
  const multisampled = input.color.sampleCount === 4;
  const view = graph.importBuffer(
    'analytic-fog-view',
    { size: VIEW_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  let pipeline: RenderPipeline | undefined;
  let layout: BindGroupLayout | undefined;
  let bindings:
    | { readonly depth: TextureView; readonly uniform: Buffer; readonly group: BindGroup }
    | undefined;
  const prepare = (frame: RenderPipelineFrame) => {
    if (pipeline === undefined || layout === undefined) {
      const result = analyticFogModule(frame);
      if (!result.ok) {
        if (result.error.code !== 'rhi-not-available') throw result.error;
        return undefined;
      }
      const module = result.value;
      const device = frame.runtime.device;
      layout = device
        .createBindGroupLayout({
          label: 'analytic-fog.bind-group-layout',
          entries: [
            { binding: 0, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
            {
              binding: multisampled ? 2 : 1,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              texture: { sampleType: 'depth', viewDimension: '2d', multisampled },
            },
          ],
        })
        .unwrap();
      const pipelineLayout = device
        .createPipelineLayout({ label: 'analytic-fog.layout', bindGroupLayouts: [layout] })
        .unwrap();
      pipeline = device
        .createRenderPipeline({
          label: 'analytic-fog',
          layout: pipelineLayout,
          vertex: { module, entryPoint: 'vs_main', buffers: [] },
          fragment: {
            module,
            entryPoint: multisampled ? 'fs_msaa' : 'fs_main',
            targets: [
              {
                format: input.color.format,
                // Premultiplied fog over the opaque scene: rgb = scene * T + inscatter.
                // Alpha keeps the scene's coverage lane untouched.
                blend: {
                  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                },
              },
            ],
          },
          primitive: { topology: 'triangle-list' },
          multisample: { count: input.color.sampleCount },
        })
        .unwrap();
    }
    return { pipeline, layout };
  };
  registerScenePipelinePreparation(
    graph,
    (context) => {
      if (prepare(context) === undefined)
        markPipelinePreparationPending(context.frameState, { code: 'scene-pipeline-preparation' });
      return false;
    },
    'utility',
  );
  const pass = graph.addRasterPass(SkyPass.analyticFog, {
    accesses: [
      { resource: input.depth, usage: 'sampled-read' },
      { resource: view.value, usage: 'uniform-read' },
      { resource: input.color.view, usage: 'color-attachment' },
      ...(input.resolve === undefined
        ? []
        : [{ resource: input.resolve.view, usage: 'color-attachment' as const }]),
    ],
    colorAttachments: [
      {
        view: input.color.view,
        ...(input.resolve === undefined ? {} : { resolveTarget: input.resolve.view }),
        loadOp: 'load',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      const prepared = prepare(frame);
      if (prepared === undefined)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'the graph-owned analytic fog pipeline is prepared before encoding',
          hint: 'complete scene pipeline preparation before submitting this graph',
        });
      const depth = resources.textureView(input.depth);
      const uniform = resources.buffer(view.value);
      if (!depth.ok) throw depth.error;
      if (!uniform.ok) throw uniform.error;
      if (bindings?.depth !== depth.value || bindings.uniform !== uniform.value) {
        const group = frame.runtime.device
          .createBindGroup({
            label: 'analytic-fog.bind-group',
            layout: prepared.layout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: { buffer: uniform.value, size: VIEW_UNIFORM_BYTES },
                },
              },
              {
                binding: multisampled ? 2 : 1,
                resource: { kind: 'textureView', value: depth.value as never },
              },
            ],
          })
          .unwrap();
        bindings = { depth: depth.value, uniform: uniform.value, group };
      }
      pass.setPipeline(prepared.pipeline);
      pass.setBindGroup(0, bindings.group);
      pass.draw(3);
    },
  });
  if (!pass.ok) return pass;
  return ok(undefined);
}

interface StandardFogPassInputs {
  readonly topology: RenderPipelineTopology;
  readonly atmosphere?: GraphAtmosphere | undefined;
  readonly color: RenderPipelineTarget;
  readonly resolve?: RenderPipelineTarget | undefined;
  readonly depth: RenderPipelineTarget;
}

function sceneDepthSample(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  depth: RenderPipelineTarget,
  label: string,
  multisampled = false,
): Result<GraphTextureView, RenderGraphError> {
  if (depth.sampleCount !== 1 && !(multisampled && depth.sampleCount === 4))
    return err(analyticFogSampleCountError());
  return graph.view(depth.texture, { label, dimension: '2d', aspect: 'depth-only' });
}

/** Resolve Reverse-Z depth only for the local volume's one-ray-per-pixel integral. */
function addFogDepthResolve(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  depth: RenderPipelineTarget,
  topology: RenderPipelineTopology,
): Result<GraphTextureView, RenderGraphError> {
  const source = graph.view(depth.texture, {
    label: 'fog-msaa-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!source.ok) return source;
  const target = createRenderPipelineTarget(graph, 'fog-resolved-depth', {
    format: 'depth32float',
    size: renderInternalCopySize(topology),
    usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  });
  if (!target.ok) return target;
  let state: { pipeline: RenderPipeline; layout: BindGroupLayout } | undefined;
  let binding: { depth: TextureView; group: BindGroup } | undefined;
  const resolved = graph.addRasterPass('fog-depth-resolve', {
    accesses: [
      { resource: source.value, usage: 'sampled-read' },
      { resource: target.value.view, usage: 'depth-stencil-write' },
    ],
    colorAttachments: [],
    depthStencilAttachment: {
      view: target.value.view,
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
    encodeDirect(pass, frame, resources) {
      const device = frame.runtime.device;
      if (state === undefined) {
        const result = analyticFogModule(frame);
        if (!result.ok) {
          if (result.error.code !== 'rhi-not-available') throw result.error;
          return undefined;
        }
        const module = result.value;
        const layout = device
          .createBindGroupLayout({
            entries: [
              {
                binding: 2,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true },
              },
            ],
          })
          .unwrap();
        state = {
          layout,
          pipeline: device
            .createRenderPipeline({
              label: 'fog-depth-resolve',
              layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
              vertex: { module, entryPoint: 'vs_main', buffers: [] },
              fragment: { module, entryPoint: 'fs_resolve_depth', targets: [] },
              primitive: { topology: 'triangle-list' },
              depthStencil: {
                format: 'depth32float',
                depthWriteEnabled: true,
                depthCompare: 'always',
              },
            })
            .unwrap(),
        };
      }
      const texture = resources.textureView(source.value).unwrap();
      if (binding?.depth !== texture)
        binding = {
          depth: texture,
          group: device
            .createBindGroup({
              layout: state.layout,
              entries: [{ binding: 2, resource: { kind: 'textureView', value: texture } }],
            })
            .unwrap(),
        };
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, binding.group);
      pass.draw(3);
    },
  });
  return resolved.ok ? ok(target.value.view) : resolved;
}

/**
 * Composite atmosphere and analytic height fog onto the opaque scene ahead of
 * translucency in either Standard lane. Both are analytic media that every
 * translucent writer re-evaluates at its own depth through the View lanes.
 */
export function addOpaqueFogPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardFogPassInputs,
): Result<void, RenderGraphError> {
  const analytic = input.topology.analyticFog === true;
  if (!analytic && input.atmosphere === undefined) return ok(undefined);
  const depthSample =
    input.atmosphere === undefined
      ? graph.view(input.depth.texture, {
          label: 'scene-depth.sample',
          dimension: '2d',
          aspect: 'depth-only',
        })
      : sceneDepthSample(graph, input.depth, 'scene-depth.sample');
  if (!depthSample.ok) return depthSample;
  if (input.atmosphere !== undefined) {
    const composed = addAtmosphereComposition(
      graph,
      input.color,
      depthSample.value,
      input.atmosphere,
    );
    if (!composed.ok) return composed;
  }
  if (analytic && input.atmosphere === undefined) {
    const fog = addAnalyticFogPass(graph, {
      color: input.color,
      resolve: input.resolve,
      depth: depthSample.value,
    });
    if (!fog.ok) return fog;
  }
  return ok(undefined);
}

/**
 * Composite the integrated local `VolumetricFog` medium after every
 * translucent writer in either Standard lane.
 *
 * The integrate pass stores one camera-to-opaque-depth integral per pixel. It
 * has no depth slices, so a translucent writer cannot sample "the medium in
 * front of me". Composited before translucency, every blended surface behind
 * the medium (sky cards, cloud decks, distant particles) replaces the medium's
 * in-scatter with its own color and cuts a hard hole of its own shape into the
 * lit haze. Composited after, a surface behind the medium is exact
 * (`T * blend(src, dst) + S` equals fogging each layer) and a surface inside
 * the medium also receives the segment behind it, which is a bounded soft
 * over-fog rather than a missing medium.
 */
export function addTranslucencyVolumetricFogPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardFogPassInputs & {
    readonly directionalShadow: GraphTextureView | undefined;
    readonly spotShadow: GraphTextureView;
    readonly clusterBuffers: StandardClusterGraphBuffers | null;
    readonly cloudShadow: GraphTextureView | undefined;
  },
): Result<void, RenderGraphError> {
  if (input.topology.volumetricFog?.enabled !== true) return ok(undefined);
  const depthSample =
    input.depth.sampleCount === 4
      ? addFogDepthResolve(graph, input.depth, input.topology)
      : sceneDepthSample(graph, input.depth, 'local-volume-scene-depth');
  if (!depthSample.ok) return depthSample;
  return addAuthoredVolumetricFogPasses(
    graph,
    input.topology,
    input.color,
    depthSample.value,
    input.directionalShadow,
    input.spotShadow,
    input.clusterBuffers,
    input.cloudShadow,
    input.atmosphere?.transmittance,
  );
}
