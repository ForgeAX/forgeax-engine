import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { addTypedDebugOverlayPass } from '../debug-draw-glue.js';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline.js';
import { RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM } from '../world/debug-overlay-systems.js';
import { createRenderWorld } from '../world/render-world.js';

async function compileOverlayGraph() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const output = createRenderPipelineTarget(graph, 'output', {
    format: 'rgba8unorm',
    size: { width: 1, height: 1 },
  }).unwrap();
  graph
    .addRasterPass('initialize', {
      accesses: [{ resource: output.view, usage: 'color-attachment' }],
      colorAttachments: [{ view: output.view, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    })
    .unwrap();
  addTypedDebugOverlayPass(graph, output).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const encoder = device.createCommandEncoder({ label: 'debug-overlay' }).unwrap();
  return { device, compiled, encoder };
}

describe('debug overlay exact-zero graph execution', () => {
  it('does not open a raster pass when no overlay source is installed', async () => {
    const { device, compiled, encoder } = await compileOverlayGraph();
    const executed = compiled.execute({
      encoder,
      runtime: {},
    } as unknown as RenderPipelineFrame);

    expect(executed.ok).toBe(true);
    expect((encoder as RhiCommandEncoder).finish().ok).toBe(true);
    expect(device.framePassNames).toEqual(['initialize']);
    expect((await compiled.retire()).ok).toBe(true);
  });

  it('fails naming the prepare system when an installed overlay was not prepared', async () => {
    const { compiled, encoder } = await compileOverlayGraph();
    const executed = compiled.execute({
      encoder,
      runtime: {
        debugOverlay: { take: () => null, shader: {} },
        renderWorld: createRenderWorld(),
        viewEntity: undefined,
      },
    } as unknown as RenderPipelineFrame);

    expect(executed.ok).toBe(false);
    const error = (executed as { error: { detail: { cause: unknown } } }).error;
    expect(String(error.detail.cause)).toContain(RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM);
  });
});
