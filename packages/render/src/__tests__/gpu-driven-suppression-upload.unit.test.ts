import type { Buffer, Result, RhiError } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { patchSuppressedPrimitiveWords } from '../gpu-driven/production-raster-prepare';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_STORAGE } from '../gpu-usage';
import type { RenderableSnapshot } from '../render-system-extract';
import { setSceneRow } from '../scene/__tests__/scene-row-writes';
import { SceneSlots, SlotIdentityKeys } from '../scene/scene-slots';

interface SuppressionInternals {
  suppressionWordCapacity: number;
  suppressionMirror: Uint32Array;
  updateSuppression(buffer: Buffer, reseed: boolean, target?: Uint32Array): Result<void, RhiError>;
  inspect(): { readonly suppressionUploadBytes: number };
}

/** Count element accesses of the view's uploaded-bitmap mirror; a full diff visits every word. */
function counted(words: Uint32Array, visits: { count: number }): Uint32Array {
  const element = (key: string | symbol) => typeof key === 'string' && /^\d+$/.test(key);
  return new Proxy(words, {
    get(target, key) {
      if (element(key)) visits.count++;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) {
      if (element(key)) visits.count++;
      return Reflect.set(target, key, value, target);
    },
  });
}

it('uploads a patched suppression bitmap by visiting only its changed words, at any scene size', async () => {
  const visited: number[] = [];
  for (const count of [32 * 1024, 32 * 16384]) {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap() as unknown as SuppressionInternals;
    const words = count / 32;
    const buffer = device
      .createBuffer({
        size: words * 4,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    view.suppressionWordCapacity = words;
    const slots = new SceneSlots();
    for (let slot = 0; slot < count; slot++)
      setSceneRow(slots, slot, {
        generation: 1,
        worldId: 0,
        entityKey: slot,
        snapshot: { worldId: 0, entityKey: slot } as RenderableSnapshot,
      });
    const before = slots.capture();
    const active = new SlotIdentityKeys(before, [0]);
    const base = new Uint32Array(words);
    view.updateSuppression(buffer, true, base).unwrap();
    // Two rows far apart leave a later roster while the scene frame keeps them.
    slots.remove(3);
    slots.remove(count - 1);
    const inactive = new SlotIdentityKeys(slots.capture(), [0]);
    const patched = patchSuppressedPrimitiveWords(
      { slots: before, worldKeys: [0], activeEntityKeys: active, words: base },
      before,
      [0],
      inactive,
      count,
    );
    expect(patched).toBeDefined();
    const visits = { count: 0 };
    view.suppressionMirror = counted(view.suppressionMirror, visits);
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const uploaded = view.inspect().suppressionUploadBytes;
    view.updateSuppression(buffer, false, patched as Uint32Array).unwrap();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(view.inspect().suppressionUploadBytes - uploaded).toBe(8);
    visited.push(visits.count);
    // The same bitmap again: no visit and no upload.
    writes.mockClear();
    visits.count = 0;
    view.updateSuppression(buffer, false, patched as Uint32Array).unwrap();
    expect(writes).not.toHaveBeenCalled();
    expect(visits.count).toBe(0);
  }
  expect(visited[0]).toBe(visited[1]);
  expect(visited[0]).toBeLessThan(16);
});
