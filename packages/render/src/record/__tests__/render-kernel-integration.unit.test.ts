import { describe, expect, it } from 'vitest';
import { createRenderKernelBridge } from '../render-kernel-bridge';

describe('RenderKernelBridge switchable TS / Rust WASM integration', () => {
  it('supports explicit ts mode and tracks batch cull and sort counters cleanly', () => {
    const bridge = createRenderKernelBridge('ts', 64);
    try {
      expect(bridge.requestedMode).toBe('ts');
      expect(bridge.activeMode).toBe('ts');
      expect(bridge.wasmReady).toBe(false);

      const order = bridge.sortTransparentIndices(3, 0, 0, 0, (pos, layers, ties) => {
        pos.set([0, 0, 1, 0, 0, 5, 0, 0, 3]);
        layers.set([0, 0, 0]);
        ties.set([0, 1, 2]);
      });
      expect(Array.from(order)).toEqual([1, 2, 0]);

      const info = bridge.inspect();
      expect(info.sortCalls).toBe(1);
      expect(info.disposed).toBe(false);
    } finally {
      bridge.dispose();
    }
    expect(bridge.inspect().disposed).toBe(true);
  });

  it('produces identical batch world-AABB frustum culling bitmasks on TS and WASM modes', async () => {
    const tsBridge = createRenderKernelBridge('ts', 64);
    const wasmBridge = createRenderKernelBridge('wasm', 64);
    try {
      const deadline = Date.now() + 2000;
      while (!wasmBridge.wasmReady && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const planes = [
        new Float32Array([
          1, 0, 0, 10, -1, 0, 0, 10, 0, 1, 0, 10, 0, -1, 0, 10, 0, 0, 1, 10, 0, 0, -1, 10,
        ]),
      ];

      const fillAabbs = (dst: Float32Array): void => {
        for (let i = 0; i < 64; i++) {
          const x = i % 2 === 0 ? (i % 5) - 2 : 50 + i;
          const b = i * 6;
          dst[b] = x - 0.5;
          dst[b + 1] = -0.5;
          dst[b + 2] = -0.5;
          dst[b + 3] = x + 0.5;
          dst[b + 4] = 0.5;
          dst[b + 5] = 0.5;
        }
      };

      const tsCull = tsBridge.cullWorldAabbs(64, planes, fillAabbs);
      const wasmCull = wasmBridge.cullWorldAabbs(64, planes, fillAabbs);

      expect(tsCull.visibleCount).toBe(32);
      expect(wasmCull.visibleCount).toBe(tsCull.visibleCount);
      expect(Array.from(wasmCull.bits)).toEqual(Array.from(tsCull.bits));
      expect(tsBridge.inspect().batchCullCalls).toBe(1);
      expect(tsBridge.inspect().batchCullCandidates).toBe(64);
    } finally {
      tsBridge.dispose();
      wasmBridge.dispose();
    }
  });
});
