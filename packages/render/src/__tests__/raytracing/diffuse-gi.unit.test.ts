import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { createDiffuseGi } from '../../raytracing/diffuse-gi';
import { prepareDiffuseGiFixture } from './diffuse-gi.commands';
import { giSettings, giSource } from './diffuse-gi.fixture';

it('bounds GI allocations and retires both complete and failed frozen generations', async () => {
  const fixture = await prepareDiffuseGiFixture(),
    source = giSource(fixture, 'white', 0, [0, 0, -0.5], [3, 3, 0.5]);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  assert(device instanceof RhiNullDevice);
  const live = () =>
    device.bookkeeper
      .allRecords()
      .filter((r) => (r.kind === 'Buffer' || r.kind === 'Texture') && !r.destroyed);
  const request = {
    kernel: fixture.kernel,
    sources: [source],
    scene: [{ ...source.instance, field: source.field }],
    lights: [],
    settings: { ...giSettings },
  };
  const fail = async () =>
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'injected compilation failure',
        hint: 'retry',
      }),
    );
  expect((await createDiffuseGi(device, fail, request)).ok).toBe(false);
  expect(live()).toHaveLength(0);
  for (const change of [
    { samples: 15 },
    { iterations: 3 },
    { probeSpacing: 0 },
    { environment: [-1, 0, 0] as const },
  ]) {
    expect(
      (
        await createDiffuseGi(device, createShaderModule, {
          ...request,
          settings: { ...request.settings, ...change },
        })
      ).ok,
    ).toBe(false);
    expect(live()).toHaveLength(0);
  }
  const visibility = (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 0.25,
      triangleSidedness: [1],
    })
  ).unwrap();
  const rejectedVisibility = await createDiffuseGi(device, createShaderModule, {
    ...request,
    scene: [{ ...source.instance, field: visibility }],
  });
  expect(rejectedVisibility.ok).toBe(false);
  expect(live()).toHaveLength(0);
  const gi = (await createDiffuseGi(device, createShaderModule, request)).unwrap();
  expect(live().length).toBeGreaterThan(0);
  const encoder = device.createCommandEncoder({}).unwrap();
  expect(gi.record(encoder).ok).toBe(true);
  request.settings.samples = 128;
  expect(gi.record(encoder).ok).toBe(false);
  gi.dispose();
  gi.dispose();
  expect(gi.record(encoder).ok).toBe(false);
  expect(live()).toHaveLength(0);
});
