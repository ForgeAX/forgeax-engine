import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GpuResourceAllocationLedger } from '../../gpu-driven/resource-allocation';
import { ViewTargetTextures } from '../../record/view-target-textures';
import { CurrentTransmissionTargets } from '../current-backdrop';

it('keeps one current backdrop across roughness changes, rolls back a broken resize and retires at the view fence', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const ledger = new GpuResourceAllocationLedger();
  const fences: (() => void)[] = [];
  const textures = new ViewTargetTextures(device, ledger, (release) => fences.push(release));
  const view = new CurrentTransmissionTargets(textures);
  const single = view.acquire(7, 3, 'rgba16float', false);
  expect(single.base.currentTextureView()).toBe(single.base.view);
  const chain = view.acquire(7, 3, 'rgba16float', true);
  expect(single.base.currentTextureView()).toBeUndefined();
  const bytes = (7 * 3 + 3 + 1 + 3 + 1) * 8;
  expect(ledger.inspect()).toMatchObject({ liveBytes: bytes, pendingRetirementBytes: 7 * 3 * 8 });
  for (const release of fences.splice(0)) release();
  for (let i = 0; i < 60; i++) {
    view.begin();
    expect(view.acquire(7, 3, 'rgba16float', i % 2 === 0)).toBe(chain);
    expect(view.mipCount).toBe(i % 2 === 0 ? 3 : 1);
    view.finish();
  }
  const failed = vi.spyOn(device, 'createTextureView').mockImplementationOnce(() => {
    throw new Error('partial backdrop');
  });
  try {
    expect(() => view.acquire(9, 5, 'rgba16float', true)).toThrow('partial backdrop');
  } finally {
    failed.mockRestore();
  }
  expect(view.current).toBe(chain);
  expect(chain.chain.currentTextureView()).toBe(chain.chain.view);
  expect(ledger.inspect()).toMatchObject({
    successfulAllocationCount: 4,
    liveBytes: bytes,
    failedAllocationRollbacks: 1,
    pendingRetirementBytes: 0,
  });
  view.begin();
  view.finish();
  expect(view.current).toBeUndefined();
  expect(chain.base.currentTextureView()).toBeUndefined();
  expect(ledger.inspect()).toMatchObject({ liveBytes: 0, pendingRetirementBytes: bytes });
  for (const release of fences) release();
  expect(ledger.inspect().pendingRetirementBytes).toBe(0);
});
