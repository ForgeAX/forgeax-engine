// Regression: raw-only WebGL2 surfaces record the overlay into an rgba16float
// post input, so the PSO must follow the pass attachment, not the swapchain format.

import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createDebugDraw } from '../src';

function makeDevice() {
  const targets: string[] = [];
  const device = {
    createBuffer: vi.fn(() => ok({})),
    destroyBuffer: vi.fn(),
    createBindGroupLayout: vi.fn(() => ok({})),
    createPipelineLayout: vi.fn(() => ok({})),
    createBindGroup: vi.fn(() => ok({})),
    createRenderPipeline: vi.fn((desc: { fragment: { targets: { format: string }[] } }) => {
      const format = desc.fragment.targets[0]?.format ?? '';
      targets.push(format);
      return ok({ format });
    }),
    queue: { writeBuffer: vi.fn() },
  };
  return { device, targets };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as any;

describe('debug-draw pipeline follows the encoded color attachment format', () => {
  it('creates and caches one PSO per attachment format', async () => {
    const { device, targets } = makeDevice();
    const dd = (
      await createDebugDraw({
        device: device as any,
        queue: device.queue as any,
        createShaderModule: async () => ok({}) as any,
        format: 'rgba8unorm-srgb',
      })
    ).unwrap();
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
    };

    for (let frame = 0; frame < 2; frame++) {
      dd.line([0, 0, 0] as any, [1, 0, 0] as any, [1, 1, 1, 1]);
      expect(dd.encode(pass as any, IDENTITY, 'rgba16float').ok).toBe(true);
    }
    dd.line([0, 0, 0] as any, [1, 0, 0] as any, [1, 1, 1, 1]);
    expect(dd.encode(pass as any, IDENTITY).ok).toBe(true);

    expect(targets).toEqual(['rgba8unorm-srgb', 'rgba16float']);
    expect(pass.setPipeline.mock.calls.map(([pso]) => pso.format)).toEqual([
      'rgba16float',
      'rgba16float',
      'rgba8unorm-srgb',
    ]);
  });
});
