import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { createDiffuseGi } from '../../raytracing/diffuse-gi';
import { prepareDiffuseGiFixture } from './diffuse-gi.commands';
import { giSettings, giSource } from './diffuse-gi.fixture';

it('admits an ordinary perspective GI view and rejects a degenerate camera', async () => {
  const fixture = await prepareDiffuseGiFixture();
  const source = giSource(fixture, 'white', 0, [0, 0, -0.5], [3, 3, 0.5]);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const view = {
    camera: {
      origin: [0, 0, 8] as const,
      target: [0, 0, 0] as const,
      up: [0, 1, 0] as const,
      verticalFov: 0.8,
    },
    near: 0.1,
    far: 30,
  };
  const request = {
    kernel: fixture.kernel,
    sources: [source],
    scene: [{ ...source.instance, field: source.field }],
    lights: [],
    settings: { ...giSettings, view, resolution: 256 },
  };
  const created = await createDiffuseGi(device, createShaderModule, request);
  expect(created.ok).toBe(true);
  if (created.ok) {
    expect(created.value.view.width).toBe(256);
    expect(created.value.record(device.createCommandEncoder({}).unwrap()).ok).toBe(true);
    created.value.dispose();
  }
  for (const invalid of [
    { ...view, near: 0 },
    { ...view, far: 0.05 },
    { ...view, camera: { ...view.camera, target: view.camera.origin } },
    { ...view, camera: { ...view.camera, up: [0, 0, 1] as const } },
  ])
    expect(
      (
        await createDiffuseGi(device, createShaderModule, {
          ...request,
          settings: { ...request.settings, view: invalid },
        })
      ).ok,
    ).toBe(false);
});
