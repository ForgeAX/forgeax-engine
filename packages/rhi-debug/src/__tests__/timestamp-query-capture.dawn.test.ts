import { rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import { decodeTape } from '../protocol/codec';
import { validateTape } from '../protocol/validation';
import { wrap } from '../recorder';
import { assembleTape } from '../recorder/assemble';

describe('timestamp query capture ownership', () => {
  it.each([
    'render',
    'compute',
    'empty-compute',
  ] as const)('retains a pre-capture QuerySet for %s passes', async (kind) => {
    const recorded = wrap(rhi);
    const adapter = (await recorded.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })
    ).unwrap();
    const querySet = device.createQuerySet({ type: 'timestamp', count: 2 }).unwrap();
    const target = device
      .createTexture({ size: { width: 4, height: 4 }, format: 'rgba8unorm', usage: 0x10 })
      .unwrap();
    const view = device.createTextureView(target, {}).unwrap();
    try {
      recorded.arm(1);
      const encoder = device.createCommandEncoder().unwrap();
      const timestampWrites = { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
      if (kind === 'render')
        encoder
          .beginRenderPass({
            colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
            timestampWrites,
          })
          .end();
      else if (kind === 'compute') encoder.beginComputePass({ timestampWrites }).end();
      else encoder.encodeEmptyComputePass({ timestampWrites });
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      recorded.onFrameEnd();
      const tape = recorded.getTape();
      if (tape === undefined || !('events' in tape)) throw new Error('Missing captured tape');
      const pass = tape.events.find(
        (event) => event.kind === 'beginRenderPass' || event.kind === 'beginComputePass',
      );
      expect(pass).toHaveProperty('timestampQuerySetHandleId');
      if (pass?.kind !== 'beginRenderPass' && pass?.kind !== 'beginComputePass')
        throw new Error('Missing pass');
      expect(pass.desc?.timestampWrites).toEqual({
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      });
      const encoded = assembleTape(recorded).unwrap().bytes;
      const decoded = decodeTape(encoded).unwrap();
      expect(decoded.bootstrap.some((row) => row.kind === 'query-set')).toBe(true);
      expect(validateTape(decoded).ok).toBe(true);
    } finally {
      device.destroyQuerySet(querySet).unwrap();
      device.destroyTexture(target).unwrap();
    }
  });
});
