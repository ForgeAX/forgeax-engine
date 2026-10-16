import { RenderGraphBuilder } from '@forgeax/engine/render-graph';
import type { QuerySet, RhiCommandEncoder } from '@forgeax/engine/rhi';
import { rhi } from '@forgeax/engine/rhi-null';
import { defineFeature } from '../../lab/feature';

type Frame = { readonly encoder: RhiCommandEncoder; readonly page: QuerySet | undefined };

export default defineFeature({
  title: 'Frame-varying occlusion query sets',
  catalog: 'Frame-varying occlusion query sets',
  kind: 'headless',
  summary:
    'A raster pass declares occlusionQuerySet as a frame callback; the compiled graph resolves it once per execute, so rotating query pages reuse the same compiled topology.',
  expect:
    'All checks pass: one compiled graph executes three frames with page A, page B and no page; the callback runs exactly once per execute and the pass list never changes.',
  async run(checks) {
    const adapter = await rhi.requestAdapter();
    if (!adapter.ok) return void checks.ok('requestAdapter ok', false, adapter.error.code);
    const device = await adapter.value.requestDevice();
    if (!device.ok) return void checks.ok('requestDevice ok', false, device.error.code);
    const pageA = device.value.createQuerySet({ type: 'occlusion', count: 4 });
    const pageB = device.value.createQuerySet({ type: 'occlusion', count: 4 });
    checks.ok('two occlusion query pages created', pageA.ok && pageB.ok);
    if (!pageA.ok || !pageB.ok) return;

    const graph = new RenderGraphBuilder<Frame>();
    const color = graph.createTexture('color', {
      format: 'rgba8unorm',
      size: { width: 2, height: 2 },
    });
    if (!color.ok) return void checks.ok('texture declared', false, color.error.code);
    const view = graph.view(color.value, { label: 'color.view' });
    if (!view.ok) return void checks.ok('view declared', false, view.error.code);
    const resolved: (QuerySet | undefined)[] = [];
    graph.addRasterPass('occlusion-draw', {
      accesses: [{ resource: view.value, usage: 'color-attachment' }],
      colorAttachments: [{ view: view.value, loadOp: 'clear', storeOp: 'store' }],
      occlusionQuerySet: (frame) => {
        resolved.push(frame.page);
        return frame.page;
      },
      encode: ({ pass }) => pass.draw(3),
    });
    const compiled = graph.compile({ device: device.value, surfaceSize: { width: 2, height: 2 } });
    if (!compiled.ok) return void checks.ok('compile ok', false, compiled.error.code);
    const topology = JSON.stringify(compiled.value.inspect().passes);

    for (const page of [pageA.value, pageB.value, undefined]) {
      const encoder = device.value.createCommandEncoder({ label: 'occlusion-frame' });
      if (!encoder.ok) return void checks.ok('encoder created', false, encoder.error.code);
      const executed = compiled.value.execute({ encoder: encoder.value, page });
      checks.ok(`execute with ${page === undefined ? 'no page' : 'a page'}`, executed.ok);
      encoder.value.finish();
    }
    checks.equal('callback ran once per execute', resolved.length, 3);
    checks.ok(
      'page A then page B then none',
      resolved[0] === pageA.value && resolved[1] === pageB.value && resolved[2] === undefined,
    );
    checks.equal('topology unchanged', JSON.stringify(compiled.value.inspect().passes), topology);
    await compiled.value.retire();
  },
});
