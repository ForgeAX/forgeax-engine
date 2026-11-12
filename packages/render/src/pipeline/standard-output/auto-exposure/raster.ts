import type { GraphTextureView, RenderGraphError } from '@forgeax/engine-render-graph';
import { RenderGraphError as GraphError } from '@forgeax/engine-render-graph';
import { AUTO_EXPOSURE_FRAGMENT_WGSL } from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  computeBindGroup,
  resolvedGraphBuffer,
  resolvedGraphView,
} from '../../../compute-graph-state';
import { createRasterState, type RasterState } from '../../../raster-graph-state';
import type { RenderPipelineBuildContext, RenderPipelineFrame } from '../../../render-pipeline';
import type { AutoExposureGraphProjection } from './gpu';

/** Capacity is frozen independently of observed timings; counts remain exact u32. */
export function planFragmentExposure(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 4096 * 2160
  )
    throw new RangeError(
      'fragment exposure requires positive dimensions <=4096 and <=8847360 pixels',
    );
  const sampleWidth = Math.ceil(width / 4);
  const sampleHeight = Math.ceil(height / 4);
  const tileCount = Math.ceil(sampleWidth / 16) * Math.ceil(sampleHeight / 16);
  const rows = [tileCount];
  while ((rows[rows.length - 1] ?? 0) > 1) rows.push(Math.ceil((rows[rows.length - 1] ?? 0) / 16));
  const bytes =
    sampleWidth * sampleHeight * 16 + rows.reduce((sum, row) => sum + row * 64 * 16, 0) + 16;
  return { sampleWidth, sampleHeight, rows, bytes };
}

/** GPU-only integer histogram, bounded gather reduction and the shared V1 adapt. */
export function addAutoExposureFragmentPasses(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  projection: AutoExposureGraphProjection,
): Result<void, RenderGraphError> {
  const graph = context.graph;
  let plan: ReturnType<typeof planFragmentExposure>;
  try {
    plan = planFragmentExposure(projection.width, projection.height);
  } catch (cause) {
    return err(
      new GraphError({
        code: 'resource-descriptor-invalid',
        expected: 'fragment exposure fits its declared input and integer capacity',
        hint: 'reduce the metered render extent to the qualified portable budget',
        detail: {
          resourceLabel: 'auto-exposure-meter',
          field: 'extent',
          expected: '<=4096 per axis and <=8847360 pixels',
          actual: cause instanceof Error ? cause.message : String(cause),
        },
      }),
    );
  }
  const create = (
    name: string,
    width: number,
    height: number,
    format: 'rgba32uint' | 'rgba32float',
  ) => {
    const texture = graph.createTexture(name, { format, size: { width, height } });
    if (!texture.ok) return texture;
    const view = graph.view(texture.value);
    return view.ok ? ok({ texture: texture.value, view: view.value }) : view;
  };
  const classified = create(
    'auto-exposure-classified',
    plan.sampleWidth,
    plan.sampleHeight,
    'rgba32uint',
  );
  if (!classified.ok) return classified;
  const add = (
    name: string,
    entry: string,
    source: GraphTextureView,
    sourceBinding: number,
    target: GraphTextureView,
    adapt = false,
  ): Result<void, RenderGraphError> => {
    let state: RasterState | undefined;
    const uniformInputs = adapt
      ? [
          { binding: 3, buffer: projection.resources.state },
          { binding: 4, buffer: projection.resources.parameters },
        ]
      : [];
    return graph.addRasterPass(name, {
      accesses: [
        { resource: source, usage: 'sampled-read' },
        { resource: target, usage: 'color-attachment' },
        ...uniformInputs.map(({ buffer }) => ({
          resource: buffer,
          usage: 'uniform-read' as const,
        })),
      ],
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store' }],
      encodeDirect: (pass, frame, resolver) => {
        state ??= createRasterState(
          frame,
          AUTO_EXPOSURE_FRAGMENT_WGSL,
          `auto-exposure.${entry}`,
          [
            {
              binding: sourceBinding,
              visibility: 2,
              texture: {
                sampleType: sourceBinding === 0 ? 'unfilterable-float' : 'uint',
                viewDimension: '2d',
              },
            },
            ...uniformInputs.map(({ binding }) => ({
              binding,
              visibility: 2,
              buffer: { type: 'uniform' },
            })),
          ],
          'auto_exposure_fullscreen',
          entry,
          [adapt ? 'rgba32float' : 'rgba32uint'],
        );
        pass.setPipeline(state.pipeline);
        pass.setBindGroup(
          0,
          computeBindGroup(frame, state, [
            {
              binding: sourceBinding,
              resource: { kind: 'textureView', value: resolvedGraphView(resolver, source) },
            },
            ...uniformInputs.map(({ binding, buffer }) => ({
              binding,
              resource: {
                kind: 'buffer' as const,
                value: { buffer: resolvedGraphBuffer(resolver, buffer) },
              },
            })),
          ]),
        );
        pass.draw(3);
      },
    });
  };
  const classification = add(
    'auto-exposure-classify',
    'auto_exposure_classify',
    projection.source.view,
    0,
    classified.value.view,
  );
  if (!classification.ok) return classification;
  let previous = classified.value.view;
  let finalHistogramTexture: import('@forgeax/engine-render-graph').GraphTexture | undefined;
  for (const [level, rows] of plan.rows.entries()) {
    const histogram = create(`auto-exposure-histogram-${level}`, 64, rows, 'rgba32uint');
    if (!histogram.ok) return histogram;
    const reduced = add(
      level === 0 ? 'auto-exposure-histogram' : `auto-exposure-reduce-${level}`,
      level === 0 ? 'auto_exposure_tile_histogram' : 'auto_exposure_reduce_histogram',
      previous,
      level === 0 ? 1 : 2,
      histogram.value.view,
    );
    if (!reduced.ok) return reduced;
    previous = histogram.value.view;
    finalHistogramTexture = histogram.value.texture;
  }
  const histogramTexture = finalHistogramTexture;
  if (histogramTexture === undefined) throw new Error('exposure histogram plan has no final level');
  const published = graph.addCopyPass('auto-exposure-publish-histogram', {
    accesses: [
      { resource: previous, usage: 'copy-src' },
      { resource: projection.resources.histogram, usage: 'copy-dst' },
    ],
    encodeDirect: (encoder, _frame, resolver) =>
      encoder.copyTextureToBuffer(
        { texture: resolver.texture(histogramTexture).unwrap() },
        { buffer: resolvedGraphBuffer(resolver, projection.resources.histogram) },
        { width: 64, height: 1, depthOrArrayLayers: 1 },
      ),
  });
  if (!published.ok) return published;
  const adapted = create('auto-exposure-adapted', 1, 1, 'rgba32float');
  if (!adapted.ok) return adapted;
  const adapt = add(
    'auto-exposure-adapt',
    'auto_exposure_adapt_fragment',
    previous,
    2,
    adapted.value.view,
    true,
  );
  if (!adapt.ok) return adapt;
  // Copy the GPU result into the existing candidate ABI; there is no map/readback/upload.
  return graph.addCopyPass('auto-exposure-publish-candidate', {
    accesses: [
      { resource: adapted.value.view, usage: 'copy-src' },
      { resource: projection.resources.candidate, usage: 'copy-dst' },
    ],
    encodeDirect: (encoder, _frame, resolver) =>
      encoder.copyTextureToBuffer(
        { texture: resolver.texture(adapted.value.texture).unwrap() },
        { buffer: resolvedGraphBuffer(resolver, projection.resources.candidate) },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      ),
  });
}
