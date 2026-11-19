import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { expect, it, vi } from 'vitest';
import { addStandardTransparentPasses } from '../pipeline/standard-transparency';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';

it.each([
  false,
  true,
])('declares a mandatory final resolve without a redundant execution predicate (conditional=%s)', (conditional) => {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const color = createRenderPipelineTarget(graph, 'color', {
    size: 'surface',
    format: 'rgba16float',
    sampleCount: 4,
  }).unwrap();
  const resolve = createRenderPipelineTarget(graph, 'resolve', {
    size: 'surface',
    format: 'rgba16float',
  }).unwrap();
  const depth = createRenderPipelineTarget(graph, 'depth', {
    size: 'surface',
    format: 'depth32float-stencil8',
    sampleCount: 4,
  }).unwrap();
  const add = vi.spyOn(graph, 'addRasterPass');
  const executeIf = vi.fn(() => false);
  addStandardTransparentPasses(graph, {
    color,
    resolve,
    depth,
    size: 'surface',
    transparency: undefined,
    template: conditional ? { executeIf } : {},
  }).unwrap();
  const descriptor = add.mock.calls.at(-1)?.[1];
  expect(descriptor).toBeDefined();
  expect(descriptor?.colorAttachments[0]?.resolveTarget).toBe(resolve.view);
  if (conditional) expect(typeof descriptor?.executeIf).toBe('function');
  else expect(descriptor?.executeIf).toBeUndefined();
});
