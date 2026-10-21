import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { equirectContribution } from '@forgeax/engine-image';
import { rhi } from '@forgeax/engine-rhi-null';
import { type AssetHandle, type EquirectAsset, pack } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../../../render/src/device/device-scope';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import { worldRenderResources } from '../../../render/src/publication/resource-scope';

const image = (): EquirectAsset => ({
  kind: 'equirect',
  width: 4,
  height: 2,
  format: 'rgba16float',
  colorSpace: 'linear',
  data: new Uint8Array(4 * 2 * 8),
});

async function configuredStore() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  const scope = DeviceScope.create(0, 'runtime-cubemap');
  store.configureGpuDevice(
    device,
    (_device, descriptor) => rhi.createShaderModule(device, descriptor),
    device.caps,
  );
  store.configureIblDevice(device, (device, descriptor) =>
    rhi.createShaderModule(device, descriptor),
  );
  store.bindDeviceScope(scope);
  return { device, store };
}

it('projects an ordinary HDR asset once and preserves its runtime identity', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(equirectContribution.kind, equirectContribution.decoder);
  const resources = worldRenderResources(new World({ assets }));
  const pod = image();
  const source = assets.create(pod).unwrap();
  const { device, store } = await configuredStore();
  const submit = vi.spyOn(device.queue, 'submit');
  try {
    const first = (await store._uploadCubemapFromEquirect(resources, source, pod)).unwrap();
    const submissions = submit.mock.calls.length;
    expect(submissions).toBeGreaterThan(0);
    expect(first).toBe(source);
    expect((await store._uploadCubemapFromEquirect(resources, source, pod)).unwrap()).toBe(first);
    expect(submit).toHaveBeenCalledTimes(submissions);
  } finally {
    store.destroyAll();
    assets.dispose();
  }
});

it('rejects LDR projection before submitting GPU work', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(equirectContribution.kind, equirectContribution.decoder);
  const resources = worldRenderResources(new World({ assets }));
  const pod: EquirectAsset = {
    ...image(),
    format: 'rgba8unorm',
    colorSpace: 'srgb',
    data: new Uint8Array(4 * 2 * 4),
  };
  const source = assets.create(pod).unwrap();
  const store = new GpuResidencyCache();
  expect(await store._uploadCubemapFromEquirect(resources, source, pod)).toMatchObject({
    ok: false,
    error: { code: 'invalid-source-format' },
  });
  assets.dispose();
});

it('keeps complete cubemap identities and resource scopes independent during retirement', async () => {
  const { store } = await configuredStore();
  const firstScope = worldRenderResources(new World());
  const secondScope = worldRenderResources(new World());
  // The residency boundary accepts complete numeric identities. Their low
  // slot bits must never collapse distinct generations supplied by a source.
  const first = pack(1060, 0) as AssetHandle<'equirect'>;
  const next = pack(1060, 3) as AssetHandle<'equirect'>;
  try {
    (await store._uploadCubemapFromEquirect(firstScope, first, image())).unwrap();
    const oldCube = store.getCubemapGpuTexture(first, firstScope);
    expect(oldCube).toBeDefined();
    expect(store.getCubemapGpuTexture(next, firstScope)).toBeUndefined();

    (await store._uploadCubemapFromEquirect(firstScope, next, image())).unwrap();
    (await store._uploadCubemapFromEquirect(secondScope, next, image())).unwrap();
    const newCube = store.getCubemapGpuTexture(next, firstScope);
    const otherCube = store.getCubemapGpuTexture(next, secondScope);
    expect(newCube).toBeDefined();
    expect(otherCube).toBeDefined();
    expect(newCube).not.toBe(oldCube);
    expect(newCube).not.toBe(otherCube);
    expect(store.getCubemapIbl(next, firstScope)).toBeDefined();
    expect(store.getCubemapIbl(next, firstScope)).not.toBe(store.getCubemapIbl(next, secondScope));

    expect(store.releaseUnreferenced(new Set([next]))).toEqual({ freed: 1, errors: [] });
    expect(oldCube?.isDestroyed).toBe(true);
    expect(store.getCubemapGpuTexture(first, firstScope)).toBeUndefined();
    expect(store.getCubemapGpuTexture(next, firstScope)).toBe(newCube);
    expect(store.getCubemapGpuTexture(next, secondScope)).toBe(otherCube);
    expect(newCube?.isDestroyed).toBe(false);
    expect(otherCube?.isDestroyed).toBe(false);

    expect(store.evictCubemap(next, firstScope)).toEqual({ freed: 1, errors: [] });
    expect(store.getCubemapIbl(next, firstScope)).toBeUndefined();
    expect(store.getCubemapGpuTexture(next, secondScope)).toBe(otherCube);
    (await store._uploadCubemapFromEquirect(firstScope, next, image())).unwrap();
    expect(store.getCubemapGpuTexture(next, firstScope)).not.toBe(newCube);
    expect(store.getCubemapStatus(next, firstScope)).toBe('ready');
  } finally {
    store.destroyAll();
  }
});
