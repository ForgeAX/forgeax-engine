import type { RendererOptions } from '@forgeax/engine-render';
import type { RenderPipeline } from '@forgeax/engine-render/authoring';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';

const construct = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer-host', () => ({ constructRuntimeRendererHost: construct }));

const { createRenderer } = await import('../src/createRenderer');

describe('createRenderer options', () => {
  it('forwards every RendererOptions field, including the construction-time pipeline', async () => {
    construct.mockResolvedValue(err(new Error('stop after forwarding')));
    const pipeline: RenderPipeline = { build: () => err(new Error('unused')) as never };
    const options: RendererOptions = { pipeline, captureGpuTimings: true };
    await createRenderer({} as HTMLCanvasElement, options);
    expect(construct).toHaveBeenCalledTimes(1);
    expect(construct.mock.calls[0]?.[1]).toBe(options);
  });
});
