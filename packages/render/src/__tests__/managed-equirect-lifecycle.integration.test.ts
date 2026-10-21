import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { equirectContribution } from '@forgeax/engine-image';
import { rhi } from '@forgeax/engine-rhi-null';
import type { EquirectAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';

function fence() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<undefined>((yes, no) => {
    resolve = () => yes(undefined);
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture() {
  const assets = new AssetRegistry();
  assets.installDecoder(equirectContribution.kind, equirectContribution.decoder);
  const resources = worldRenderResources(new World({ assets }));
  const source = assets
    .create({
      kind: 'equirect',
      width: 4,
      height: 2,
      format: 'rgba16float',
      colorSpace: 'linear',
      data: new Uint8Array(64),
    })
    .unwrap();
  const observer = assets.observe().unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  const scope = DeviceScope.create(0, 'managed-equirect');
  store.configureGpuDevice(device, (d, desc) => rhi.createShaderModule(d, desc), device.caps);
  store.configureIblDevice(device, (d, desc) => rhi.createShaderModule(d, desc));
  store.bindDeviceScope(scope);
  const upload = () =>
    store._uploadCubemapFromEquirect(
      resources,
      source,
      resources.resolveAsset<EquirectAsset>(source).unwrap(),
    );
  const edit = () => {
    assets.update(source, { data: new Uint8Array(64).fill(1) }).unwrap();
    const batch = observer.read().unwrap();
    assert(batch.changes.length === 1);
    for (const change of batch.changes) store.adoptCubemapChange(change, resources);
    batch.accept();
  };
  const close = () => {
    store.destroyAll();
    scope.dispose();
    observer.dispose();
    assets.dispose();
  };
  return { assets, resources, source, device, store, scope, upload, edit, close };
}

it('retires the old cube and all IBL textures after submitted readers complete', async () => {
  const f = await fixture();
  const submitted = fence();
  const destroy = vi.spyOn(f.device, 'destroyTexture');
  const pipelines = vi.spyOn(f.device, 'createRenderPipeline');
  try {
    (await f.upload()).unwrap();
    const oldCube = f.store.getCubemapGpuTexture(f.source, f.resources);
    const oldIbl = f.store.getCubemapIbl(f.source, f.resources);
    assert(oldCube && oldIbl);
    const oldIblTextures = [
      oldIbl.irradianceTexture,
      oldIbl.prefilterTexture,
      oldIbl.brdfLutTexture,
    ];
    const compiled = pipelines.mock.calls.length;
    f.store.trackMeshSubmission(submitted.promise);
    f.edit();
    expect(f.store.getCubemapStatus(f.source, f.resources)).toBeUndefined();
    expect(oldCube.isDestroyed).toBe(false);
    // PMREM's temporary scratch is already retired; submitted IBL readers stay live.
    for (const texture of oldIblTextures) expect(destroy).not.toHaveBeenCalledWith(texture);
    (await f.upload()).unwrap();
    const current = f.store.getCubemapGpuTexture(f.source, f.resources);
    expect(current).not.toBe(oldCube);
    expect(f.store.getCubemapIbl(f.source, f.resources)).not.toBe(oldIbl);
    expect(pipelines).toHaveBeenCalledTimes(compiled);
    submitted.resolve();
    await submitted.promise;
    await Promise.resolve();
    expect(oldCube.isDestroyed).toBe(true);
    for (const texture of oldIblTextures) expect(destroy).toHaveBeenCalledWith(texture);
    expect(current?.isDestroyed).toBe(false);
    for (let version = 0; version < 3; version++) {
      f.assets.update(f.source, { data: new Uint8Array(64).fill(version + 2) }).unwrap();
      // The direct owner consumes the exact changed identity; no dependency sweep.
      f.store.evictCubemap(f.source, f.resources);
      (await f.upload()).unwrap();
      expect(f.scope.childrenSnapshot).toHaveLength(1);
    }
  } finally {
    submitted.resolve();
    f.close();
  }
});

it.each([
  'success',
  'failure',
] as const)('does not publish a stale pending %s over its successor', async (result) => {
  const f = await fixture();
  const completion = fence();
  const done = vi.spyOn(f.device.queue, 'onSubmittedWorkDone').mockReturnValue(completion.promise);
  const created = vi.spyOn(f.device, 'createTexture');
  const destroy = vi.spyOn(f.device, 'destroyTexture');
  try {
    const stale = f.upload();
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    const oldTextures = created.mock.results.flatMap((r) =>
      r.type === 'return' && r.value.ok ? [r.value.value] : [],
    );
    f.edit();
    expect(done).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
    done.mockImplementation(() => Promise.resolve(undefined));
    (await f.upload()).unwrap();
    const successor = f.store.getCubemapIbl(f.source, f.resources);
    assert(successor);
    result === 'success'
      ? completion.resolve()
      : completion.reject(new Error('late fence failure'));
    (await stale).unwrap();
    await Promise.resolve();
    expect(f.store.getCubemapStatus(f.source, f.resources)).toBe('ready');
    expect(f.store.getCubemapIbl(f.source, f.resources)).toBe(successor);
    expect(f.store.getCubemapFailure(f.source, f.resources)).toBeUndefined();
    for (const texture of oldTextures) expect(destroy).toHaveBeenCalledWith(texture);
    expect(f.scope.childrenSnapshot).toHaveLength(1);
  } finally {
    completion.resolve();
    f.close();
  }
});

it('does not republish a pending source after its registry identity is released', async () => {
  const f = await fixture();
  const completion = fence();
  const done = vi.spyOn(f.device.queue, 'onSubmittedWorkDone').mockReturnValue(completion.promise);
  try {
    const stale = f.upload();
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    f.assets.release(f.source).unwrap();
    completion.resolve();
    (await stale).unwrap();
    await Promise.resolve();
    expect(f.store.getCubemapStatus(f.source, f.resources)).toBeUndefined();
    expect(f.scope.childrenSnapshot).toHaveLength(0);
  } finally {
    completion.resolve();
    f.close();
  }
});
