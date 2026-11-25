import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { expect, it, vi } from 'vitest';
import type {
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../../render-pipeline';
import { createRenderPipelineTarget } from '../../render-pipeline';
import { addWaterSlwPasses } from '../slw-graph';

it('clears all optical outputs to zero coverage so non-Water pixels preserve the paired scene', () => {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const size = { width: 16, height: 16 };
  const color = createRenderPipelineTarget(graph, 'scene', {
    format: 'rgba16float',
    size,
  }).unwrap();
  const depth = createRenderPipelineTarget(graph, 'depth', {
    format: 'depth32float-stencil8',
    size,
  }).unwrap();
  const temporal = createRenderPipelineTarget(graph, 'scene-temporal', {
    format: 'rgba16float',
    size,
  }).unwrap();
  const view = graph.createBuffer('view', { size: 2048 }).unwrap();
  const raster = vi.spyOn(graph, 'addRasterPass');
  const result = addWaterSlwPasses({
    graph,
    topology: {} as RenderPipelineTopology,
    context: { graph } as RenderPipelineBuildContext<RenderPipelineFrame>,
    color,
    depth,
    opaqueTemporal: temporal,
    receiver: { sampled: [], spotShadow: depth, extraAccesses: [] },
    view,
    foamSimulation: { kind: 'no-simulation' },
    ...size,
  });
  expect(result.ok).toBe(true);
  const optical = raster.mock.calls.find(([name]) => name === 'water-slw-inner-color')?.[1];
  expect(optical?.colorAttachments).toHaveLength(3);
  for (const attachment of optical?.colorAttachments ?? []) {
    expect(attachment).toMatchObject({ loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 } });
  }
  const prepass = raster.mock.calls.find(([name]) => name === 'water-depth-prepass')?.[1];
  expect(prepass?.colorAttachments).toMatchObject([
    { loadOp: 'clear' },
    { view: temporal.view, loadOp: 'load' },
  ]);
  expect(prepass?.depthStencilAttachment).toBeDefined();
  expect(raster.mock.calls.some(([name]) => name === 'water-scene-temporal')).toBe(false);
});
