import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import type { _InternalRenderPipelineContext } from '../../record/render-context';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../../render-pipeline';
import { addStandardSceneDataPass } from '../standard-scene-data';

it.each([
  'Deferred',
  'Forward',
])('keeps the GBuffer write and selects only %s temporal geometry', async (lightMode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  if (!(device instanceof RhiNullDevice)) throw new Error('expected the real Null backend');
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const color = createRenderPipelineTarget(graph, 'temporal', {
    format: 'rgba16float',
    size: 'surface',
    sampleCount: 1,
  }).unwrap();
  const depth = createRenderPipelineTarget(graph, 'depth', {
    format: 'depth32float-stencil8',
    size: 'surface',
    sampleCount: 1,
  }).unwrap();
  graph
    .addRasterPass('gbuffer', {
      accesses: [
        { resource: color.view, usage: 'color-attachment' },
        { resource: depth.view, usage: 'depth-stencil-write' },
      ],
      colorAttachments: [
        { view: color.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, -1, 1] },
      ],
      depthStencilAttachment: {
        view: depth.view,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
      encode: () => undefined,
    })
    .unwrap();
  addStandardSceneDataPass(graph, color, depth, undefined, 'forward-only-opaque').unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  let reads = 0;
  const material = {
    materialHandle: 1,
    get materialShaderId(): string {
      reads++;
      throw new Error('selected Forward material contract');
    },
  };
  const frame = {
    encoder: device.createCommandEncoder().unwrap(),
    runtime: { device },
    dispatch: [
      {
        entityIndex: 0,
        renderableIndex: 0,
        materialHandle: 1,
        passIndex: 0,
        queue: 2000,
        layer: 0,
        tags: { LightMode: lightMode },
      },
    ],
    validatedOrdered: [{ renderableIndex: 0, source: { material, materials: [material] } }],
  } as unknown as _InternalRenderPipelineContext;
  try {
    const result = compiled.execute(frame);
    if (lightMode === 'Deferred') {
      expect(device.framePassNames).toEqual(['gbuffer']);
      expect(result.ok).toBe(true);
      expect(reads).toBe(0);
    } else {
      // An unconditional skip would hide a selected producer failure.
      expect(result.ok).toBe(false);
      expect(reads).toBe(1);
      if (!result.ok)
        expect(result.error).toMatchObject({
          code: 'pass-encode-failed',
          detail: { cause: { message: 'selected Forward material contract' } },
        });
    }
  } finally {
    await compiled.retire();
  }
});
