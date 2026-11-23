import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import {
  computeBindGroup,
  computePipelineError,
  resolvedGraphBuffer,
  resolvedGraphView,
} from '../compute-graph-state';
import { createRasterState, type RasterState } from '../raster-graph-state';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { SsrSpatialGraphInputs } from './graph';
import type { SsrSpatialResources } from './resources';
import { ssrGBufferConstants, ssrShaderGBufferMismatch } from './shader-layout';

type TextureInput = {
  readonly binding: number;
  readonly view: GraphTextureView;
  readonly sampleType: 'depth' | 'uint' | 'unfilterable-float';
};
type BufferInput = { readonly binding: number; readonly buffer: GraphBuffer };
type Output = { readonly view: GraphTextureView; readonly format: GPUTextureFormat };
type Inputs = SsrSpatialGraphInputs &
  Required<
    Pick<
      SsrSpatialGraphInputs,
      'depth' | 'normal' | 'scene' | 'fallback' | 'currentTemporal' | 'depthPyramid'
    >
  >;

/** The same trace math writes an atomic MRT cohort on the raster lane. */
export function addSsrFragmentStages<Frame extends RenderGraphFrame>(
  graph: RenderGraphBuilder<Frame>,
  input: Inputs,
  resources: SsrSpatialResources,
): Result<readonly string[], RenderGraphError> {
  const names: string[] = [];
  const add = (
    name: string,
    entry: string,
    textures: readonly TextureInput[],
    buffers: readonly BufferInput[],
    outputs: readonly Output[],
  ): Result<void, RenderGraphError> => {
    let state: RasterState | undefined;
    const added = graph.addRasterPass(name, {
      accesses: [
        ...textures.map(({ view }) => ({ resource: view, usage: 'sampled-read' as const })),
        ...buffers.map(({ buffer }) => ({ resource: buffer, usage: 'uniform-read' as const })),
        ...outputs.map(({ view }) => ({ resource: view, usage: 'color-attachment' as const })),
      ],
      colorAttachments: outputs.map(({ view }) => ({ view, loadOp: 'clear', storeOp: 'store' })),
      encodeDirect: (pass, frame: RenderGraphFrame, resolver) => {
        const sources = (frame as RenderPipelineFrame).ssrShaders;
        const mismatch = ssrShaderGBufferMismatch(sources, input);
        if (mismatch !== undefined)
          throw computePipelineError(
            `SSR ${mismatch.expected} source contract; rebuild the Engine shader manifest`,
          );
        const code = sources?.traceFragment;
        if (
          code === undefined ||
          (entry !== 'ssr_reflection_mip_fragment' && input.view === undefined)
        )
          throw computePipelineError(`${name} published source and View`);
        state ??= createRasterState(
          frame,
          code,
          'ssr_trace_fragment',
          [
            ...textures.map(({ binding, sampleType }) => ({
              binding,
              visibility: 2,
              texture: { sampleType, viewDimension: '2d' },
            })),
            ...buffers.map(({ binding }) => ({
              binding,
              visibility: 2,
              buffer: { type: 'uniform' },
            })),
          ],
          'ssr_fullscreen',
          entry,
          outputs.map(({ format }) => format),
          {
            ...ssrGBufferConstants(input),
            ...(input.sceneColorMipCount === undefined || input.sceneColorMipCount <= 1
              ? {}
              : { SSR_SCENE_COLOR_MIP_COUNT: input.sceneColorMipCount }),
          },
        );
        pass.setPipeline(state.pipeline);
        pass.setBindGroup(
          0,
          computeBindGroup(frame, state, [
            ...textures.map(({ binding, view }) => ({
              binding,
              resource: { kind: 'textureView' as const, value: resolvedGraphView(resolver, view) },
            })),
            ...buffers.map(({ binding, buffer }) => ({
              binding,
              resource: {
                kind: 'buffer' as const,
                value: {
                  buffer: resolvedGraphBuffer(resolver, buffer),
                  size: VIEW_UNIFORM_BYTES,
                },
              },
            })),
          ]),
        );
        pass.draw(3);
      },
    });
    if (added.ok) names.push(name);
    return added;
  };
  const trace = add(
    'ssr-trace',
    input.compactMaterial === undefined ? 'ssr_trace_fragment' : 'ssr_trace_fragment_compact',
    [
      ...(input.compactMaterial === undefined
        ? []
        : [
            {
              binding: 14,
              view: input.compactMaterial,
              sampleType: 'uint' as const,
            },
          ]),
      { binding: 0, view: input.depth, sampleType: 'depth' },
      { binding: 1, view: input.normal, sampleType: 'uint' },
      { binding: 2, view: input.scene, sampleType: 'unfilterable-float' },
      { binding: 3, view: input.depthPyramid.pyramid, sampleType: 'unfilterable-float' },
      { binding: 6, view: input.fallback, sampleType: 'unfilterable-float' },
      { binding: 7, view: input.currentTemporal, sampleType: 'unfilterable-float' },
    ],
    input.view === undefined ? [] : [{ binding: 5, buffer: input.view }],
    [
      { view: resources.trace.view, format: 'rgba16float' },
      { view: resources.hitReactivity, format: 'r32float' },
    ],
  );
  if (!trace.ok) return trace;
  return ok(Object.freeze(names));
}
