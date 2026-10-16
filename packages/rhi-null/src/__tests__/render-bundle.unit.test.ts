import { describe, expect, it } from 'vitest';
import { rhi } from '../index';

describe('render bundles', () => {
  it('records once, executes repeatedly, and refuses a consumed encoder', async () => {
    const adapter = await rhi.requestAdapter();
    if (!adapter.ok) throw adapter.error;
    const created = await adapter.value.requestDevice();
    if (!created.ok) throw created.error;
    const device = created.value;
    const encoded = device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw encoded.error;
    encoded.value.draw(3);
    encoded.value.drawIndexed(6);
    const bundle = encoded.value.finish();
    if (!bundle.ok) throw bundle.error;
    expect(encoded.value.finish().ok).toBe(false);
    const command = device.createCommandEncoder();
    if (!command.ok) throw command.error;
    const pass = command.value.beginRenderPass({ colorAttachments: [] });
    expect(pass.executeBundles([bundle.value]).ok).toBe(true);
    expect(pass.executeBundles([bundle.value, bundle.value]).ok).toBe(true);
    expect((pass as unknown as { drawCount: number }).drawCount).toBe(6);
  });
});

it('rejects foreign bundles and directly referenced destroyed buffers before counting draws', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const a = (await adapter.requestDevice()).unwrap();
  const b = (await adapter.requestDevice()).unwrap();
  const buffer = a.createBuffer({ size: 16, usage: 0x28 }).unwrap();
  const encoder = a.createRenderBundleEncoder({ colorFormats: [] }).unwrap();
  encoder.setVertexBuffer(0, buffer);
  encoder.draw(3);
  const bundle = encoder.finish().unwrap();
  const foreign = b.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  expect(foreign.executeBundles([bundle])).toMatchObject({
    ok: false,
    error: { code: 'rhi-not-available' },
  });
  a.destroyBuffer(buffer).unwrap();
  const pass = a.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  expect(pass.executeBundles([bundle])).toMatchObject({
    ok: false,
    error: { code: 'destroy-after-destroy' },
  });
  expect((pass as unknown as { drawCount: number }).drawCount).toBe(0);
});
