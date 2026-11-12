import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { mipDimension, ok, type Result } from '@forgeax/engine-types';
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
import { SSR_TEMPORAL_PARAMS_BYTES, type SsrSpatialResources } from './resources';

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

/** The same trace/temporal math writes an atomic MRT cohort on the raster lane. */
export function addSsrFragmentStages<Frame extends RenderGraphFrame>(
  graph: RenderGraphBuilder<Frame>,
  input: Inputs,
  resources: SsrSpatialResources,
  resolved: SsrSpatialResources['resolved'],
  reflectionLevels: readonly GraphTextureView[],
): Result<readonly string[], RenderGraphError> {
  const names: string[] = [];
  const add = (
    name: string,
    source: 'traceFragment' | 'temporalFragment',
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
        const code = (frame as RenderPipelineFrame).ssrShaders?.[source];
        if (
          code === undefined ||
          (entry !== 'ssr_reflection_mip_fragment' && input.view === undefined)
        )
          throw computePipelineError(`${name} published source and View`);
        state ??= createRasterState(
          frame,
          code,
          source === 'traceFragment' ? 'ssr_trace_fragment' : 'ssr_temporal_fragment',
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
                  size: binding === 6 ? SSR_TEMPORAL_PARAMS_BYTES : VIEW_UNIFORM_BYTES,
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
    'traceFragment',
    'ssr_trace_fragment',
    [
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
  const temporal = input.temporal;
  if (temporal === undefined || resolved === undefined) return ok(Object.freeze(names));
  // MRT writes separate history, surface metadata and presented radiance together.
  const scratchTexture = graph.createTexture('ssr-resolved-fragment.scratch', {
    format: 'rgba16float',
    size: { width: input.width, height: input.height },
    domain: 'linear-hdr',
  });
  if (!scratchTexture.ok) return scratchTexture;
  const scratch = graph.view(scratchTexture.value);
  if (!scratch.ok) return scratch;
  const added = add(
    'ssr-temporal',
    'temporalFragment',
    'ssr_temporal_fragment',
    [
      { binding: 0, view: resources.trace.view, sampleType: 'unfilterable-float' },
      { binding: 1, view: input.depth, sampleType: 'depth' },
      { binding: 2, view: input.normal, sampleType: 'uint' },
      { binding: 3, view: temporal.previousHistory, sampleType: 'unfilterable-float' },
      { binding: 4, view: input.currentTemporal, sampleType: 'unfilterable-float' },
      { binding: 9, view: temporal.previousSurface, sampleType: 'unfilterable-float' },
      { binding: 11, view: resources.hitReactivity, sampleType: 'unfilterable-float' },
    ],
    [
      { binding: 6, buffer: temporal.params },
      ...(input.view === undefined ? [] : [{ binding: 8, buffer: input.view }]),
    ],
    [
      { view: temporal.outputHistory, format: 'rgba16float' },
      { view: temporal.outputSurface, format: 'rgba8unorm' },
      { view: scratch.value, format: 'rgba16float' },
    ],
  );
  if (!added.ok) return added;
  let previousTexture = scratchTexture.value;
  let previousView = scratch.value;
  for (let level = 0; level < reflectionLevels.length; level++) {
    const width = mipDimension(input.width, level);
    const height = mipDimension(input.height, level);
    if (level > 0) {
      const texture = graph.createTexture(`ssr-reflection-mip-${level}.scratch`, {
        format: 'rgba16float',
        size: { width, height },
        domain: 'linear-hdr',
      });
      if (!texture.ok) return texture;
      const view = graph.view(texture.value);
      if (!view.ok) return view;
      const reduced = add(
        `ssr-reflection-mip-${level}`,
        'temporalFragment',
        'ssr_reflection_mip_fragment',
        [{ binding: 0, view: previousView, sampleType: 'unfilterable-float' }],
        [],
        [{ view: view.value, format: 'rgba16float' }],
      );
      if (!reduced.ok) return reduced;
      previousTexture = texture.value;
      previousView = view.value;
    }
    const sourceTexture = previousTexture;
    const sourceView = previousView;
    const destination = reflectionLevels[level];
    if (destination === undefined) throw computePipelineError('SSR reflection mip descriptor');
    const name = `ssr-reflection-mip-${level}.publish`;
    const copied = graph.addCopyPass(name, {
      accesses: [
        { resource: sourceView, usage: 'copy-src' },
        { resource: destination, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder, _frame, resolver) =>
        encoder.copyTextureToTexture(
          { texture: resolver.texture(sourceTexture).unwrap() },
          { texture: resolver.texture(resolved.texture).unwrap(), mipLevel: level },
          { width, height, depthOrArrayLayers: 1 },
        ),
    });
    if (!copied.ok) return copied;
    names.push(name);
  }
  return ok(Object.freeze(names));
}
