import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { addTypedDebugOverlayPass } from '../debug-draw-glue.js';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline.js';

describe('debug overlay exact-zero graph execution', () => {
  it('does not open a raster pass when the overlay has no staged work', async () => {
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
    const encode = vi.fn();
    const encoder = device.createCommandEncoder({ label: 'empty-debug-overlay' }).unwrap();

    const executed = compiled.execute({
      encoder,
      runtime: { debugOverlay: { hasWork: () => false, encode } },
    } as unknown as RenderPipelineFrame);

    expect(executed.ok).toBe(true);
    expect((encoder as RhiCommandEncoder).finish().ok).toBe(true);
    expect(device.framePassNames).toEqual(['initialize']);
    expect(encode).not.toHaveBeenCalled();
    expect((await compiled.retire()).ok).toBe(true);
  });
});
