import { type RhiNullDevice, rhi } from '@forgeax/engine/rhi-null';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'RhiNull structural backend',
  catalog: 'RhiNull',
  kind: 'headless',
  summary:
    'The GPU/DOM-free backend records handle, pass, draw, and dispatch lifetimes in a per-device ledger without executing shaders or producing pixels.',
  expect:
    "All checks pass: caps report backendKind 'null' with timestampQuery false, the ledger counts the recorded draws/dispatches and pass names, timestamp queries are refused as 'feature-not-enabled', and a second finish() is refused like the WebGPU backend.",
  async run(checks) {
    const adapter = await rhi.requestAdapter();
    checks.ok('requestAdapter ok', adapter.ok);
    if (!adapter.ok) return;
    const created = await adapter.value.requestDevice();
    checks.ok('requestDevice ok', created.ok);
    if (!created.ok) return;
    const device = created.value as RhiNullDevice;

    checks.equal('caps.backendKind', device.caps.backendKind, 'null');
    checks.equal('caps.timestampQuery', device.caps.timestampQuery, false);
    checks.equal('caps.compute', device.caps.compute, true);
    checks.equal('features is empty', device.features.size, 0);

    const target = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 });
    const encoder = device.createCommandEncoder({ label: 'rhinull-lab' });
    checks.ok('texture + encoder created', target.ok && encoder.ok);
    if (!target.ok || !encoder.ok) return;
    const view = device.createTextureView(target.value, {});
    checks.ok('texture view created', view.ok);
    if (!view.ok) return;
    const render = encoder.value.beginRenderPass({
      label: 'lab-raster',
      colorAttachments: [{ view: view.value, loadOp: 'clear', storeOp: 'store' }],
    });
    render.draw(3);
    render.draw(6);
    render.drawIndexed(12);
    render.end();
    const compute = encoder.value.beginComputePass({ label: 'lab-compute' });
    compute.dispatchWorkgroups(4);
    compute.dispatchWorkgroups(1, 2, 3);
    compute.end();
    const finished = encoder.value.finish();
    checks.ok('encoder.finish ok', finished.ok);
    if (!finished.ok) return;
    checks.ok('queue.submit ok', device.queue.submit([finished.value]).ok);
    const again = encoder.value.finish();
    checks.ok(
      "second finish returns err 'command-encoder-finished' (RhiCommandEncoder lifecycle contract)",
      !again.ok && again.error.code === 'command-encoder-finished',
      again.ok
        ? 'actual=ok (RhiNull finish() never tracks the finished state)'
        : `actual=${again.error.code}`,
    );

    checks.equal('totalDrawCount counts the 3 draws', device.totalDrawCount, 3);
    checks.equal('totalDispatchCount counts the 2 dispatches', device.totalDispatchCount, 2);
    checks.equal('framePassNames in schedule order', device.framePassNames, [
      'lab-raster',
      'lab-compute',
    ]);

    const kinds = device.bookkeeper.allRecords().map((record) => record.kind);
    checks.ok('ledger holds the Texture row', kinds.includes('Texture'), kinds.join(','));

    const timestamps = device.createQuerySet({ type: 'timestamp', count: 2 });
    checks.ok('timestamp QuerySet refused', !timestamps.ok);
    if (!timestamps.ok) checks.equal('refusal code', timestamps.error.code, 'feature-not-enabled');
  },
});
