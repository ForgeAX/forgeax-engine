import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import {
  createRenderTargetPhysical,
  destroyRenderTargetPhysical,
  renderTargetMipPhysical,
} from '../targets/physical';

it.each([
  1, 4,
] as const)('owns lazy mip attachments and retires them with a %i-sample cube', async (sampleCount) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const original = createRenderTargetPhysical(
    device,
    {
      shape: 'cube',
      width: 16,
      height: 16,
      mipLevels: 'full',
      format: 'rgba16float',
      sampleCount,
      sampled: true,
      readback: true,
    },
    0,
  );
  if (!original.ok) throw original.error;
  const mip = renderTargetMipPhysical(original.value, 2);
  if (!mip.ok) throw mip.error;
  expect(mip.value.descriptor).toMatchObject({ width: 4, height: 4 });
  expect(mip.value.texture).toBe(original.value.texture);
  expect(mip.value.resolveLayerViews).toHaveLength(6);
  expect(renderTargetMipPhysical(original.value, 2)).toMatchObject({ ok: true, value: mip.value });
  const destroy = vi.spyOn(device, 'destroyTexture');
  expect(destroyRenderTargetPhysical(original.value).ok).toBe(true);
  const destroyed = destroy.mock.calls.map(([texture]) => texture);
  expect(new Set(destroyed).size).toBe(destroyed.length);
  expect(destroyed).toContain(mip.value.depthTexture);
});
