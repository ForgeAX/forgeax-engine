import { RenderGraphBuilder } from '@forgeax/engine/render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine/rhi';
import { rhi } from '@forgeax/engine/rhi-null';
import { defineFeature } from '../../lab/feature';

type Frame = { readonly encoder: RhiCommandEncoder };

export default defineFeature({
  title: 'RenderGraph dependencies and barriers',
  catalog: 'RenderGraph dependencies and barriers',
  kind: 'headless',
  summary:
    'Pass order and barriers are derived only from declared access: read-after-write, write-after-read and write-after-write edges appear in inspect() without a caller-owned ledger.',
  expect:
    "All checks pass: consume-x depends on seed-x (RAW), rewrite-x depends on seed-x and consume-x (WAR + WAW), and reading a never-written graph buffer fails compile with 'uninitialized-read'.",
  async run(checks) {
    const adapter = await rhi.requestAdapter();
    if (!adapter.ok) return void checks.ok('requestAdapter ok', false, adapter.error.code);
    const device = await adapter.value.requestDevice();
    if (!device.ok) return void checks.ok('requestDevice ok', false, device.error.code);

    const graph = new RenderGraphBuilder<Frame>();
    const x = graph.createBuffer('x', { size: 16 });
    const y = graph.createBuffer('y', { size: 16 });
    if (!x.ok || !y.ok) return void checks.ok('buffers declared', false);
    graph.addCopyPass('seed-x', {
      accesses: [{ resource: x.value, usage: 'copy-dst' }],
      encode: () => undefined,
    });
    graph.addCopyPass('consume-x', {
      accesses: [
        { resource: x.value, usage: 'copy-src' },
        { resource: y.value, usage: 'copy-dst' },
      ],
      encode: () => undefined,
    });
    graph.addCopyPass('rewrite-x', {
      accesses: [
        { resource: y.value, usage: 'copy-src' },
        { resource: x.value, usage: 'copy-dst' },
      ],
      encode: () => undefined,
    });
    const compiled = graph.compile({ device: device.value, surfaceSize: { width: 1, height: 1 } });
    if (!compiled.ok) return void checks.ok('compile ok', false, compiled.error.code);
    const deps = Object.fromEntries(
      compiled.value.inspect().passes.map((pass) => [pass.name, pass.dependencies]),
    );
    checks.equal('seed-x has no dependency', deps['seed-x'], []);
    checks.equal('RAW: consume-x after seed-x', deps['consume-x'], ['seed-x']);
    checks.equal('WAR + WAW: rewrite-x after seed-x and consume-x', deps['rewrite-x'], [
      'seed-x',
      'consume-x',
    ]);
    await compiled.value.retire();

    const broken = new RenderGraphBuilder<Frame>();
    const never = broken.createBuffer('never-written', { size: 16 });
    if (!never.ok) return void checks.ok('buffer declared', false);
    broken.addCopyPass('read-only', {
      accesses: [{ resource: never.value, usage: 'copy-src' }],
      encode: () => undefined,
    });
    const refused = broken.compile({ device: device.value, surfaceSize: { width: 1, height: 1 } });
    checks.ok('uninitialized read refused at compile', !refused.ok);
    if (!refused.ok) checks.equal('refusal code', refused.error.code, 'uninitialized-read');
  },
});
