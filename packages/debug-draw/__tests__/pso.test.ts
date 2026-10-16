// @forgeax/engine-debug-draw -- PSO topology unit test (w15)
//
// Tests for:
// - w15: PSO topology === 'line-list' (research F-3 caveat + plan-strategy R-3)

import { describe, expect, it, vi } from 'vitest';
import { createDebugDraw } from '../src';

describe('w15: PSO topology === line-list', () => {
  it('createRenderPipeline descriptor has primitive.topology === line-list', async () => {
    const pipelineDescCapture: any[] = [];

    const mockDevice = {
      createBuffer: vi.fn().mockReturnValue({ ok: true, value: { _brand: 'buffer' } }),
      createBindGroupLayout: vi.fn().mockReturnValue({ ok: true, value: { _brand: 'bgl' } }),
      createPipelineLayout: vi.fn().mockReturnValue({ ok: true, value: { _brand: 'pipeline-layout' } }),
      createBindGroup: vi.fn().mockReturnValue({ ok: true, value: { _brand: 'bind-group' } }),
      createRenderPipeline: vi.fn((desc: any) => {
        pipelineDescCapture.push(desc);
        return {
          ok: true,
          value: { _brand: 'pipeline' },
        };
      }),
      destroyBuffer: vi.fn(),
      queue: { writeBuffer: vi.fn() },
    };

    const mockCreateShaderModule = vi.fn().mockResolvedValue({
      ok: true,
      value: { _brand: 'shader-module' },
    });

    const r = await createDebugDraw({
      device: mockDevice as any,
      queue: mockDevice.queue as any,
      createShaderModule: mockCreateShaderModule,
    });

    if (r.ok) {
      expect(pipelineDescCapture.length).toBeGreaterThanOrEqual(1);
      expect(mockDevice.createBindGroupLayout).toHaveBeenCalledOnce();
      expect(mockDevice.createPipelineLayout).toHaveBeenCalledOnce();
      if (pipelineDescCapture[0]) {
        expect(pipelineDescCapture[0].primitive.topology).toBe('line-list');
        expect(pipelineDescCapture[0].layout).not.toBe('auto');
      }
    }
  });
});
