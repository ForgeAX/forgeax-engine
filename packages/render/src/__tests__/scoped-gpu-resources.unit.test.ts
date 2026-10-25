import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { AssetHandle, TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { ScopedGpuResources } from '../device/scoped-gpu-resources';
import { worldRenderResources } from '../publication/resource-scope';

it('isolates complete numeric handles and retires empty namespace tables during traversal', () => {
  const resources = new ScopedGpuResources<object>();
  const scopes = [0, 1, -1, Symbol(), Symbol()];
  const handles = [1, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER];
  for (const scope of scopes) {
    for (const handle of handles) resources.set(handle, { scope, handle }, scope);
  }
  expect(resources.size).toBe(15);
  for (const scope of scopes) {
    for (const handle of handles) expect(resources.get(handle, scope)).toEqual({ scope, handle });
  }
  for (const [scope, rows] of resources.entries()) {
    for (const handle of rows.keys()) resources.delete(handle, scope);
  }
  expect(resources.size).toBe(0);
  expect([...resources.entries()]).toEqual([]);
  for (const scope of scopes) {
    resources.get(7, scope);
    resources.has(7, scope);
    resources.delete(7, scope);
  }
  expect([...resources.entries()]).toEqual([]);
  resources.set(1, {}, 0);
  resources.clear();
  expect([...resources.values()]).toEqual([]);
  expect([...resources.entries()]).toEqual([]);
});

it('keeps overlapping World and numeric texture owners through replacement, completion and sweeping', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const texture: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    mips: { kind: 'none' },
    data: new Uint8Array([1, 2, 3, 255]),
  };
  const scopes = [
    worldRenderResources(new World({ assets: new AssetRegistry() })),
    worldRenderResources(new World({ assets: new AssetRegistry() })),
    0,
    1,
    -1,
  ];
  const handle = (2 ** 32 + 1) as AssetHandle<'texture'>;
  const entries = scopes.map((scope) => store.ensureResident(handle, texture, scope).unwrap());
  expect(new Set(entries.map((entry) => entry.view)).size).toBe(scopes.length);
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    const lease = store.retainTextureResidency(handle, scopes[0]);
    expect(lease).toBeDefined();
    lease?.track(completion);
    store.invalidateTexture(handle, scopes[0]);
    const replacement = store.ensureResident(handle, texture, scopes[0]).unwrap();
    expect(replacement.view).not.toBe(entries[0]?.view);
    const released = lease?.release(true);
    expect(entries[0]?.texture.isDestroyed).toBe(false);
    store.releaseUnreferenced(new Set([Number(handle)]));
    for (let index = 1; index < scopes.length; index++) {
      expect(store.getTextureGpuView(handle, scopes[index])).toBe(entries[index]?.view);
    }
    finish();
    await released;
    expect(entries[0]?.texture.isDestroyed).toBe(true);
    expect(store.getTextureGpuView(handle, scopes[0])).toBe(replacement.view);
    store.releaseUnreferenced(new Set());
    for (const entry of entries) expect(entry.texture.isDestroyed).toBe(true);
    expect(replacement.texture.isDestroyed).toBe(true);
    expect(store.ensureResident(handle, texture, scopes[0]).unwrap().view).not.toBe(
      replacement.view,
    );
  } finally {
    finish();
    store.destroyAll();
  }
});
