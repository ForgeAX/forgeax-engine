import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import type { InstanceBufferCacheEntry } from '../../instance-buffer-cache';
import { resolveFoldInstanceBuffer } from '../fold-instance-buffer';

describe('fold draw-slot residency', () => {
  it('keeps real fold buffers in negative draw slots independent of World entity keys', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const instanceBuffers = new Map<number, InstanceBufferCacheEntry>();
    const context = {
      runtime: {
        device,
        errorRegistry: {
          fire: (error: unknown) => {
            throw error;
          },
        },
      },
      frameState: { instanceBuffers },
    } as never;
    const bucket = {
      entries: [],
      bucketSize: 2,
      transforms: new Float32Array(32),
      materialHandle: 1,
      layer: 0,
      sortKey: 0,
    };
    try {
      const first = resolveFoldInstanceBuffer(context, bucket, 0);
      expect(first).not.toBeNull();
      expect(resolveFoldInstanceBuffer(context, bucket, 0)).toBe(first);
      expect(resolveFoldInstanceBuffer(context, bucket, 1)).not.toBe(first);
      expect(resolveFoldInstanceBuffer(context, bucket, 1_000_000)).not.toBe(first);
      expect([...instanceBuffers.keys()]).toEqual([-1, -2, -1_000_001]);
      for (const entity of [0, 1, 1_000_000]) expect(instanceBuffers.has(entity)).toBe(false);
    } finally {
      for (const resident of instanceBuffers.values()) resident.buffer.destroy();
    }
  });
});
