import type {
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
import type { DepthPyramid, DepthPyramidGraphInputs, DepthPyramidProjection } from './graph';

/** Separate attachments avoid sampling an attached texture, even across mips. */
export function addFragmentDepthPyramidPasses<Frame extends RenderGraphFrame>(
  graph: RenderGraphBuilder<Frame>,
  input: DepthPyramidGraphInputs,
  pyramid: DepthPyramid,
): Result<DepthPyramidProjection, RenderGraphError> {
  const prefix = input.reduction === 'furthest' ? 'occlusion-depth-pyramid' : 'depth-pyramid';
  const suffix = input.reduction === 'furthest' ? '_furthest' : '';
  const passNames: string[] = [];
  let previous = input.depth;
  for (const level of pyramid.plan.levels) {
    const seed = level.level === 0;
    const name = `${prefix}-${seed ? 'seed' : `reduce-${level.level}`}-fragment`;
    const texture = graph.createTexture(`${name}.scratch`, {
      format: pyramid.plan.format,
      size: { width: level.width, height: level.height },
    });
    if (!texture.ok) return texture;
    const target = graph.view(texture.value);
    if (!target.ok) return target;
    const source = previous;
    let state: RasterState | undefined;
    const added = graph.addRasterPass(name, {
      accesses: [
        { resource: source, usage: 'sampled-read' },
        { resource: target.value, usage: 'color-attachment' },
        ...(seed && input.view !== undefined
          ? [{ resource: input.view, usage: 'uniform-read' as const }]
          : []),
      ],
      colorAttachments: [{ view: target.value, loadOp: 'clear', storeOp: 'store' }],
      encodeDirect: (pass, frame: RenderGraphFrame, resources) => {
        const sources = (frame as RenderPipelineFrame).depthPyramidShaders;
        const code = seed ? sources?.seedFragment : sources?.reduceFragment;
        if (code === undefined || (seed && input.view === undefined))
          throw computePipelineError(`${name} published fragment source and View`);
        const label = `depth_pyramid_${seed ? 'seed' : 'reduce'}_fragment`;
        state ??= createRasterState(
          frame,
          code,
          label,
          [
            {
              binding: 0,
              visibility: 2,
              texture: { sampleType: seed ? 'depth' : 'unfilterable-float', viewDimension: '2d' },
            },
            ...(seed ? [{ binding: 2, visibility: 2, buffer: { type: 'uniform' } }] : []),
          ],
          'depth_pyramid_fullscreen',
          `depth_pyramid_${seed ? 'seed' : 'reduce'}${suffix}_fragment`,
          [pyramid.plan.format],
        );
        pass.setPipeline(state.pipeline);
        pass.setBindGroup(
          0,
          computeBindGroup(frame, state, [
            {
              binding: 0,
              resource: { kind: 'textureView', value: resolvedGraphView(resources, source) },
            },
            ...(seed && input.view !== undefined
              ? [
                  {
                    binding: 2,
                    resource: {
                      kind: 'buffer' as const,
                      value: {
                        buffer: resolvedGraphBuffer(resources, input.view),
                        size: VIEW_UNIFORM_BYTES,
                      },
                    },
                  },
                ]
              : []),
          ]),
        );
        pass.draw(3);
      },
    });
    if (!added.ok) return added;
    passNames.push(name);
    const destination = pyramid.levels[level.level];
    if (destination === undefined) throw computePipelineError('depth pyramid mip descriptor');
    const copied = graph.addCopyPass(`${name}.publish`, {
      accesses: [
        { resource: target.value, usage: 'copy-src' },
        { resource: destination, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder, _frame, resources) => {
        encoder.copyTextureToTexture(
          { texture: resources.texture(texture.value).unwrap() },
          { texture: resources.texture(pyramid.texture).unwrap(), mipLevel: level.level },
          { width: level.width, height: level.height, depthOrArrayLayers: 1 },
        );
      },
    });
    if (!copied.ok) return copied;
    passNames.push(`${name}.publish`);
    previous = target.value;
  }
  return ok({ pyramid, passNames: Object.freeze(passNames) });
}
