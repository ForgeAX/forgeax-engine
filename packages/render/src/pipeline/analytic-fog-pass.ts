import {
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroupLayout, RenderPipeline } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { addAtmosphereComposition } from '../environment/compose';
import type { GraphAtmosphere } from '../environment/luts';
import { postProcessShaderModuleLabel } from '../fullscreen-post-process-pass';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type {
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import { addAuthoredVolumetricFogPasses } from '../volume/passes';
import type { StandardClusterGraphBuffers } from './standard-lighting/graph';

export const ANALYTIC_FOG_POST_PROCESS_ID = 'forgeax.analytic-fog';

/** Single-sample color and depth are required by the opaque analytic fog pass. */
export function analyticFogSampleCountError(): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-resolution-failed',
    expected: 'analytic fog receives single-sample scene depth',
    hint: 'select FXAA, TAA or no AA for analytic fog',
    detail: { resourceLabel: 'scene-depth' },
  });
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
  input: { readonly color: RenderPipelineTarget; readonly depth: GraphTextureView },
): Result<void, RenderGraphError> {
  if (input.color.sampleCount !== 1) return err(analyticFogSampleCountError());
  const view = graph.importBuffer(
    'analytic-fog-view',
    { size: VIEW_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  let pipeline: RenderPipeline | undefined;
  let layout: BindGroupLayout | undefined;
  const pass = graph.addRasterPass('analytic-fog', {
    accesses: [
      { resource: input.depth, usage: 'sampled-read' },
      { resource: view.value, usage: 'uniform-read' },
      { resource: input.color.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: input.color.view,
        loadOp: 'load',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
    encode: ({ pass, frame, resources }) => {
      if (pipeline === undefined || layout === undefined) {
        const source = frame.runtime.lookupPostProcess?.(ANALYTIC_FOG_POST_PROCESS_ID)?.source;
        const factory = frame.runtime.shaderModuleFactory;
        if (source === undefined || factory === undefined) {
          throw new RenderGraphError({
            code: 'resource-resolution-failed',
            expected: 'the registered forgeax.analytic-fog shader and a shader module factory',
            hint: 'include forgeax::analytic-fog in the engine shader manifest',
            detail: { resourceLabel: 'analytic-fog' },
          });
        }
        const module = factory
          .createShaderModule({ code: source, label: postProcessShaderModuleLabel(source) })
          .unwrap();
        const device = frame.runtime.device;
        layout = device
          .createBindGroupLayout({
            label: 'analytic-fog.bind-group-layout',
            entries: [
              { binding: 0, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'depth', viewDimension: '2d' },
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
              entryPoint: 'fs_main',
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
          })
          .unwrap();
      }
      const depth = resources.textureView(input.depth);
      const uniform = resources.buffer(view.value);
      if (!depth.ok) throw depth.error;
      if (!uniform.ok) throw uniform.error;
      const bindings = frame.runtime.device
        .createBindGroup({
          label: 'analytic-fog.bind-group',
          layout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: uniform.value, size: VIEW_UNIFORM_BYTES },
              },
            },
            { binding: 1, resource: { kind: 'textureView', value: depth.value as never } },
          ],
        })
        .unwrap();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
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
  readonly depth: RenderPipelineTarget;
}

function sceneDepthSample(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  depth: RenderPipelineTarget,
  label: string,
): Result<GraphTextureView, RenderGraphError> {
  if (depth.sampleCount !== 1) return err(analyticFogSampleCountError());
  return graph.view(depth.texture, { label, dimension: '2d', aspect: 'depth-only' });
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
  const depthSample = sceneDepthSample(graph, input.depth, 'scene-depth.sample');
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
    const fog = addAnalyticFogPass(graph, { color: input.color, depth: depthSample.value });
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
  const depthSample = sceneDepthSample(graph, input.depth, 'local-volume-scene-depth');
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
