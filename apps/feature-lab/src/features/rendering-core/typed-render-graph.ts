import { RenderGraphBuilder } from '@forgeax/engine/render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine/rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine/rhi-null';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Typed RenderGraph',
  catalog: 'Typed RenderGraph',
  kind: 'headless',
  summary:
    'RenderGraphBuilder declares a typed buffer, texture and view plus copy/compute/raster passes, compiles an immutable graph, and records it on the RhiNull device.',
  expect:
    'All checks pass: compile succeeds, inspect() lists the three passes with their kinds, execute records every pass on one encoder, a duplicate pass name is refused, and retire() succeeds.',
  async run(checks) {
    const adapter = await rhi.requestAdapter();
    if (!adapter.ok) return void checks.ok('requestAdapter ok', false, adapter.error.code);
    const created = await adapter.value.requestDevice();
    if (!created.ok) return void checks.ok('requestDevice ok', false, created.error.code);
    const device = created.value as RhiNullDevice;

    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const data = graph.createBuffer('data', { size: 16 });
    const color = graph.createTexture('color', {
      format: 'rgba8unorm',
      size: { width: 4, height: 4 },
    });
    checks.ok('typed resources declared', data.ok && color.ok);
    if (!data.ok || !color.ok) return;
    const view = graph.view(color.value, { label: 'color.view' });
    if (!view.ok) return void checks.ok('texture view declared', false, view.error.code);

    const seed = graph.addCopyPass('seed', {
      accesses: [{ resource: data.value, usage: 'copy-dst' }],
      encode: ({ encoder, resources }) => {
        const buffer = resources.buffer(data.value);
        if (buffer.ok) encoder.clearBuffer(buffer.value);
      },
    });
    const simulate = graph.addComputePass('simulate', {
      accesses: [{ resource: data.value, usage: 'storage-read-write' }],
      encode: ({ pass }) => pass.dispatchWorkgroups(1),
    });
    const draw = graph.addRasterPass('draw', {
      accesses: [
        { resource: data.value, usage: 'indirect-read' },
        { resource: view.value, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view: view.value, loadOp: 'clear', storeOp: 'store' }],
      encode: ({ pass, resources }) => {
        const args = resources.buffer(data.value);
        if (args.ok) pass.drawIndirect(args.value, 0);
      },
    });
    checks.ok('copy/compute/raster passes declared', seed.ok && simulate.ok && draw.ok);

    const duplicate = graph.addComputePass('simulate', { accesses: [], encode: () => undefined });
    checks.ok('duplicate pass name refused', !duplicate.ok);
    if (!duplicate.ok) checks.equal('duplicate code', duplicate.error.code, 'duplicate-pass-name');

    const compiled = graph.compile({ device, surfaceSize: { width: 4, height: 4 } });
    if (!compiled.ok) return void checks.ok('compile ok', false, compiled.error.code);
    checks.ok('compile ok', true);
    const passes = compiled.value.inspect().passes.map((pass) => `${pass.name}:${pass.kind}`);
    checks.equal('inspect() pass kinds', passes, ['seed:copy', 'simulate:compute', 'draw:raster']);

    const encoder = device.createCommandEncoder({ label: 'typed-graph' });
    if (!encoder.ok) return void checks.ok('encoder created', false, encoder.error.code);
    const executed = compiled.value.execute({ encoder: encoder.value });
    checks.ok('execute ok', executed.ok, executed.ok ? undefined : executed.error.code);
    checks.ok('encoder.finish ok', encoder.value.finish().ok);
    checks.equal('recorded GPU passes', device.framePassNames, ['simulate', 'draw']);
    checks.equal(
      'one dispatch and one draw',
      [device.totalDispatchCount, device.totalDrawCount],
      [1, 1],
    );
    const retired = await compiled.value.retire();
    checks.ok('retire ok', retired.ok);
  },
});
