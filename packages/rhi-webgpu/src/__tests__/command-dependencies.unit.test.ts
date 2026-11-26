import type { CommandBuffer, RenderPipeline } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { makeRhiDevice } from '../device';
import { createMockGpu } from './__mocks__/gpu-device';

it('consumes the submitted commands once and retries a failed native submission', async () => {
  const adapter = await createMockGpu().requestAdapter();
  if (adapter === null) throw new Error('Missing adapter');
  const raw = await adapter.requestDevice();
  const batches: unknown[][] = [];
  let fail = true;
  raw.queue.submit = (commands) => {
    batches.push(Array.from(commands));
    if (fail) throw new Error('native submission failed');
  };
  const { device } = makeRhiDevice(raw as unknown as GPUDevice);
  const encoder = device.createCommandEncoder().unwrap();
  const pass = encoder.beginRenderPass({ colorAttachments: [] });
  pass.setPipeline({} as RenderPipeline);
  pass.end();
  const command = encoder.finish().unwrap();
  let visits = 0;
  const sequence = Object.assign([command], {
    *[Symbol.iterator]() {
      if (++visits > 2) throw new Error('submitted commands consumed twice');
      yield command;
    },
  }) satisfies readonly CommandBuffer[];
  expect(device.queue.submit(sequence).ok).toBe(false);
  fail = false;
  expect(device.queue.submit(sequence).ok).toBe(true);
  expect(visits).toBe(2);
  expect(batches).toEqual([[command], [command]]);
});
