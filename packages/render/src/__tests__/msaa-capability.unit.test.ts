import { multisampleRenderCapability, probeMultisampleRenderCapability } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';

it('never admits Null pixels as MSAA evidence and scopes a single probe to its physical device', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const a = (await adapter.requestDevice()).unwrap();
  const b = (await adapter.requestDevice()).unwrap();
  const createModule = vi.fn(() => {
    throw new Error('Null must reject before shader creation');
  });
  expect(multisampleRenderCapability(a)).toBeUndefined();
  const first = probeMultisampleRenderCapability(a, createModule, 7);
  expect(probeMultisampleRenderCapability(a, createModule, 7)).toBe(first);
  const result = await first;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Null admitted a GPU profile');
  expect(result.error.code).toBe('rhi-texture-format-capability-unavailable');
  expect(result.error.detail).toMatchObject({
    deviceGeneration: 7,
    stage: 'texture-create',
    reason: 'real GPU required',
  });
  expect(multisampleRenderCapability(a)).toBe(result);
  expect(multisampleRenderCapability(b)).toBeUndefined();
  expect(createModule).not.toHaveBeenCalled();
});
