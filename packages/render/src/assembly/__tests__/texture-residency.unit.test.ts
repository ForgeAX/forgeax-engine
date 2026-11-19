import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import type { AssetHandle, TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { worldRenderResources } from '../../publication/resource-scope';
import { createTextureResidencyPreparer } from '../texture-residency';

const image = (red: number): TextureAsset => ({
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
  format: 'rgba8unorm',
  colorSpace: 'linear',
  mips: { kind: 'none' },
  data: new Uint8Array([red, 0, 0, 255]),
});

it('prepares real residency once, adopts new versions, and keeps borrowed old bytes alive', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry(),
    world = new World({ assets });
  const prepare = createTextureResidencyPreparer(
    new Set([world]),
    () => store,
    () => device,
  );
  const writes = vi.spyOn(device.queue, 'writeTexture');
  const creates = vi.spyOn(device, 'createTexture');
  const handle = assets.create(image(60)).unwrap();
  const scope = worldRenderResources(world);
  try {
    prepare(world, handle).unwrap();
    const original = store
      .ensureResident(handle, scope.resolveAsset<TextureAsset>(handle).unwrap(), scope)
      .unwrap();
    prepare(world, handle).unwrap();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(creates).toHaveBeenCalledTimes(1);
    const lease = store.retainTextureResidency(handle, scope);
    expect(lease).toBeDefined();
    assets.replace(handle, image(150)).unwrap();
    prepare(world, handle).unwrap();
    const next = store
      .ensureResident(handle, scope.resolveAsset<TextureAsset>(handle).unwrap(), scope)
      .unwrap();
    expect(next.texture).not.toBe(original.texture);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(original.texture.isDestroyed).toBe(false);
    await lease?.release(false);
    expect(original.texture.isDestroyed).toBe(true);
  } finally {
    store.destroyAll();
    assets.dispose();
  }
});

it('isolates attached Worlds and rejects foreign handles before GPU work', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const a = new AssetRegistry(),
    b = new AssetRegistry();
  const assets = [a, b];
  const first = new World({ assets: a }),
    second = new World({ assets: b });
  const handle = a.create(image(50)).unwrap(),
    other = b.create(image(180)).unwrap();
  const attached = new Set([first]);
  const prepare = createTextureResidencyPreparer(
    attached,
    () => store,
    () => device,
  );
  const writes = vi.spyOn(device.queue, 'writeTexture');
  try {
    expect(Number(handle)).not.toBe(Number(other));
    const foreign = prepare(first, other);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.detail.reason).toBe('invalid-texture');
    const detached = prepare(second, other);
    expect(detached.ok).toBe(false);
    if (!detached.ok) expect(detached.error.detail.reason).toBe('world-not-attached');
    const invalid = prepare(first, 99999 as AssetHandle<'texture'>);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.detail.reason).toBe('invalid-texture');
    expect(writes).not.toHaveBeenCalled();
    attached.add(second);
    prepare(first, handle).unwrap();
    prepare(second, other).unwrap();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes.mock.calls[0]?.[1]).not.toEqual(writes.mock.calls[1]?.[1]);
  } finally {
    store.destroyAll();
    for (const owner of assets) owner.dispose();
  }
});

it('submits only the selected mip work, preserves siblings, and retries a rejected submit without uploading again', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    (_device, descriptor) => rhi.createShaderModule(device, descriptor),
    device.caps,
  );
  (await store.prewarmMipmapPipeline(device, ['rgba8unorm'])).unwrap();
  const assets = new AssetRegistry(),
    world = new World({ assets });
  const make = (red: number): TextureAsset => ({
    ...image(red),
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    data: new Uint8Array(64).fill(red),
    mips: { kind: 'generate' },
  });
  const handle = assets.create(make(50)).unwrap(),
    sibling = assets.create(make(180)).unwrap();
  const scope = worldRenderResources(world);
  const prepare = createTextureResidencyPreparer(
    new Set([world]),
    () => store,
    () => device,
  );
  store.ensureResident(sibling, scope.resolveAsset<TextureAsset>(sibling).unwrap(), scope).unwrap();
  const submit = vi.spyOn(device.queue, 'submit');
  const writes = vi.spyOn(device.queue, 'writeTexture');
  const actualSubmit = device.queue.submit.bind(device.queue);
  let finish: (() => void) | undefined;
  const completed = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockReturnValue(completed);
  const failure = new RhiError({
    code: 'queue-submit-failed',
    expected: 'injected rejection',
    hint: 'retry the same prepared mip work',
  });
  submit.mockReturnValueOnce(err(failure));
  try {
    const rejected = prepare(world, handle);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.detail.reason).toBe('upload-failed');
    prepare(world, handle).unwrap();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
    prepare(world, handle).unwrap();
    expect(submit).toHaveBeenCalledTimes(2);
    const physical = store
      .ensureResident(handle, scope.resolveAsset<TextureAsset>(handle).unwrap(), scope)
      .unwrap();
    store.invalidateTexture(handle, scope);
    expect(physical.texture.isDestroyed).toBe(false);
    finish?.();
    await completed;
    expect(physical.texture.isDestroyed).toBe(true);
    const remaining = store.prepareTextureMips().unwrap();
    expect(remaining?.buffer).toBeDefined();
    if (remaining?.buffer !== undefined) actualSubmit([remaining.buffer]).unwrap();
    remaining?.complete(true);
    expect(store.prepareTextureMips().unwrap()).toBeUndefined();
  } finally {
    finish?.();
    store.destroyAll();
    assets.dispose();
  }
});
