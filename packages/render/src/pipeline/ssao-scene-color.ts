import type {
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { RenderGraphError as GraphFailure } from '@forgeax/engine-render-graph';
import type { BindGroup, Buffer, TextureView } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type { RenderPipelineTopology } from '../render-pipeline';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import { buildSsaoUniformPayload, SSAO_UNIFORM_BYTES } from '../ssao-uniform';
import { renderInternalCopySize } from './render-extent';

/** A filtered visibility target and its exact depth owner, before lighting consumes either. */
export interface SceneColorAo {
  readonly ao: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly linearDepth?: RenderPipelineTarget | undefined;
  readonly parameters?: GraphBuffer | undefined;
}

/** Apply to the completed HDR scene once, before temporal, Meter and neighborhood post. */
export function addSsaoSceneColorPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  input: SceneColorAo,
  previousExposure?: GraphBuffer,
): Result<RenderPipelineTarget, RenderGraphError> {
  const spiral = topology.config?.ssao?.algorithm === 'spiral-ssao';
  const multisampledDepth = input.depth.sampleCount > 1;
  if (
    (spiral && (input.linearDepth === undefined || input.parameters === undefined)) ||
    scene.sampleCount !== 1 ||
    (multisampledDepth && !spiral) ||
    input.ao.sampleCount !== 1
  )
    return err(
      new GraphFailure({
        code: 'resource-descriptor-invalid',
        expected:
          'single-sample HDR scene and AO, with shared linear depth and parameters for spiral SSAO; only spiral accepts multisampled depth',
        hint: 'resolve the scene before application and prepare the selected AO depth contract',
      }),
    );
  const output = createRenderPipelineTarget(graph, 'ssao-scene-color', {
    format: scene.format,
    size: renderInternalCopySize(topology),
    usage: GPU_TEXTURE_USAGE_COPY_SRC,
  });
  if (!output.ok) return output;
  const depth = graph.view(input.depth.texture, {
    label: 'ssao-scene-color-depth',
    aspect: 'depth-only',
  });
  if (!depth.ok) return depth;
  const uniform = input.parameters === undefined ? addSsaoParameters(graph) : ok(input.parameters);
  if (!uniform.ok) return uniform;
  let retained:
    | {
        readonly scene: TextureView;
        readonly depth: TextureView;
        readonly ao: TextureView;
        readonly uniform: Buffer;
        readonly exposure: Buffer;
        readonly linearDepth: TextureView;
        readonly group: BindGroup;
      }
    | undefined;
  const added = graph.addRasterPass('ssao-scene-color', {
    accesses: [
      { resource: scene.view, usage: 'sampled-read' },
      { resource: depth.value, usage: 'sampled-read' },
      { resource: input.ao.view, usage: 'sampled-read' },
      ...(input.linearDepth === undefined
        ? []
        : [{ resource: input.linearDepth.view, usage: 'sampled-read' as const }]),
      { resource: uniform.value, usage: 'uniform-read' },
      ...(previousExposure === undefined
        ? []
        : [{ resource: previousExposure, usage: 'uniform-read' as const }]),
      { resource: output.value.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: output.value.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      const c = frame as _InternalRenderPipelineContext;
      const program = c.pipelineState.perPassResources.ssaoScenePipeline?.(
        'scene-color',
        scene.format,
        multisampledDepth,
      );
      if (program === undefined)
        throw new GraphFailure({
          code: 'resource-resolution-failed',
          expected: 'the selected native scene-color AO program',
          hint: 'include the engine SSAO module in this shader generation',
        });
      const source = resources.textureView(scene.view).unwrap();
      const sampledDepth = resources.textureView(depth.value).unwrap();
      const ao = resources.textureView(input.ao.view).unwrap();
      const linearDepth =
        input.linearDepth === undefined
          ? ao
          : resources.textureView(input.linearDepth.view).unwrap();
      const buffer = resources.buffer(uniform.value).unwrap();
      // The uniform is a harmless bound placeholder for manual exposure; the
      // shader reads accepted exposure only when its explicit auto flag is set.
      const exposure =
        previousExposure === undefined ? buffer : resources.buffer(previousExposure).unwrap();
      if (
        retained?.scene !== source ||
        retained.depth !== sampledDepth ||
        retained.ao !== ao ||
        retained.uniform !== buffer ||
        retained.exposure !== exposure ||
        retained.linearDepth !== linearDepth
      ) {
        const group = c.runtime.device
          .createBindGroup({
            label: 'ssao-scene-color',
            layout: program.layout,
            entries: [
              {
                binding: 0,
                resource: { kind: 'buffer', value: { buffer, size: SSAO_UNIFORM_BYTES } },
              },
              {
                binding: multisampledDepth ? 13 : 5,
                resource: { kind: 'textureView', value: sampledDepth },
              },
              { binding: 7, resource: { kind: 'textureView', value: ao } },
              { binding: 12, resource: { kind: 'textureView', value: linearDepth } },
              { binding: 10, resource: { kind: 'textureView', value: source } },
              { binding: 11, resource: { kind: 'buffer', value: { buffer: exposure, size: 16 } } },
            ],
          })
          .unwrap();
        retained = {
          scene: source,
          depth: sampledDepth,
          ao,
          uniform: buffer,
          exposure,
          linearDepth,
          group,
        };
      }
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(0, retained.group);
      pass.draw(3, 1, 0, 0);
    },
  });
  return added.ok ? ok(output.value) : added;
}

/** One immutable parameter allocation per compiled view, uploaded before its AO work. */
export function addSsaoParameters(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): Result<GraphBuffer, RenderGraphError> {
  const parameters = graph.createBuffer('ssao-parameters', { size: SSAO_UNIFORM_BYTES });
  if (!parameters.ok) return parameters;
  const uploaded = graph.addCopyPass('ssao-parameters', {
    accesses: [{ resource: parameters.value, usage: 'copy-dst' }],
    encodeDirect: (_encoder, frame, resources) => {
      const c = frame as _InternalRenderPipelineContext;
      c.runtime.device.queue
        .writeBuffer(
          resources.buffer(parameters.value).unwrap(),
          0,
          buildSsaoUniformPayload(c.camera, c.frameState.installedPipelineConfig?.ssao),
        )
        .unwrap();
    },
  });
  return uploaded.ok ? parameters : uploaded;
}

/** Shared linear half depth, sampled by the estimator, both filters and upsampling. */
export function addSsaoLinearDepthPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  depth: RenderPipelineTarget,
  size: { readonly width: number; readonly height: number },
): Result<
  { readonly linearDepth: RenderPipelineTarget; readonly parameters: GraphBuffer },
  RenderGraphError
> {
  const parameters = addSsaoParameters(graph);
  if (!parameters.ok) return parameters;
  const output = createRenderPipelineTarget(graph, 'ssao-linear-depth', {
    format: 'r16float',
    size,
    usage: GPU_TEXTURE_USAGE_COPY_SRC,
  });
  if (!output.ok) return output;
  const sampled = graph.view(depth.texture, {
    label: 'ssao-linear-depth-input',
    aspect: 'depth-only',
  });
  if (!sampled.ok) return sampled;
  let retained:
    | { readonly depth: TextureView; readonly uniform: Buffer; readonly group: BindGroup }
    | undefined;
  const added = graph.addRasterPass('ssao-linear-depth', {
    accesses: [
      { resource: sampled.value, usage: 'sampled-read' },
      { resource: parameters.value, usage: 'uniform-read' },
      { resource: output.value.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: output.value.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 300.1, g: 0, b: 0, a: 0 },
      },
    ],
    encodeDirect: (pass, frame, resources) => {
      const c = frame as _InternalRenderPipelineContext;
      const program = c.pipelineState.perPassResources.ssaoScenePipeline?.(
        'linear-depth',
        'r16float',
        depth.sampleCount > 1,
      );
      if (program === undefined)
        throw new GraphFailure({
          code: 'resource-resolution-failed',
          expected: 'the native linear AO depth program',
          hint: 'include the engine SSAO module in this shader generation',
        });
      const source = resources.textureView(sampled.value).unwrap();
      const buffer = resources.buffer(parameters.value).unwrap();
      if (retained?.depth !== source || retained.uniform !== buffer) {
        const group = c.runtime.device
          .createBindGroup({
            label: 'ssao-linear-depth',
            layout: program.layout,
            entries: [
              {
                binding: 0,
                resource: { kind: 'buffer', value: { buffer, size: SSAO_UNIFORM_BYTES } },
              },
              {
                binding: depth.sampleCount > 1 ? 13 : 5,
                resource: { kind: 'textureView', value: source },
              },
            ],
          })
          .unwrap();
        retained = { depth: source, uniform: buffer, group };
      }
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(0, retained.group);
      pass.draw(3, 1, 0, 0);
    },
  });
  return added.ok ? ok({ linearDepth: output.value, parameters: parameters.value }) : added;
}
