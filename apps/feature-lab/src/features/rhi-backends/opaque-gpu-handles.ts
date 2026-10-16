import type { RhiDevice } from '@forgeax/engine/rhi';
import { rhi } from '@forgeax/engine/rhi-null';
import { defineFeature } from '../../lab/feature';

const VERTEX = 0x20;

async function device(): Promise<RhiDevice | undefined> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) return undefined;
  const created = await adapter.value.requestDevice();
  return created.ok ? created.value : undefined;
}

export default defineFeature({
  title: 'Opaque GPU handles',
  catalog: 'Opaque GPU handles',
  kind: 'headless',
  summary:
    'Buffer/Texture/Pipeline/Bundle handles hide backend objects; a handle is only meaningful to the device that issued it, and cross-device use is refused structurally.',
  expect:
    "All checks pass: handles expose no backend object fields, destroying device A's buffer through device B and executing A's render bundle in B's pass both return 'rhi-not-available', and the owner device still accepts them.",
  async run(checks) {
    const a = await device();
    const b = await device();
    checks.ok('two independent devices', a !== undefined && b !== undefined && a !== b);
    if (a === undefined || b === undefined) return;

    const buffer = a.createBuffer({ size: 16, usage: VERTEX });
    checks.ok('device A createBuffer ok', buffer.ok);
    if (!buffer.ok) return;
    const keys = Object.keys(buffer.value);
    checks.ok(
      'handle exposes no raw backend object',
      !keys.some((key) => /raw|gpu|native|inner/i.test(key)),
      `own string keys=[${keys.join(',')}]`,
    );

    const foreign = b.destroyBuffer(buffer.value);
    checks.ok('device B refuses A buffer', !foreign.ok);
    if (!foreign.ok)
      checks.equal('cross-device destroy code', foreign.error.code, 'rhi-not-available');

    const bundleEncoder = a.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
    checks.ok('device A createRenderBundleEncoder ok', bundleEncoder.ok);
    if (!bundleEncoder.ok) return;
    bundleEncoder.value.draw(3);
    const bundle = bundleEncoder.value.finish();
    checks.ok('bundle finish ok', bundle.ok);
    if (!bundle.ok) return;

    const target = b.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 });
    const encoder = b.createCommandEncoder();
    if (!target.ok || !encoder.ok) return void checks.ok('device B target + encoder', false);
    const view = b.createTextureView(target.value, {});
    if (!view.ok) return void checks.ok('device B view', false);
    const pass = encoder.value.beginRenderPass({
      colorAttachments: [{ view: view.value, loadOp: 'clear', storeOp: 'store' }],
    });
    const executed = pass.executeBundles([bundle.value]);
    pass.end();
    checks.ok('device B pass refuses A bundle', !executed.ok);
    if (!executed.ok)
      checks.equal('cross-device bundle code', executed.error.code, 'rhi-not-available');

    checks.ok('owner device A still destroys its buffer', a.destroyBuffer(buffer.value).ok);
  },
});
