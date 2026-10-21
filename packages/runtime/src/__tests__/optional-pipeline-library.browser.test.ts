import type { RhiAdapter, RhiInstance } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createRenderer } from '../createRenderer';

it('initializes on real WebGPU without the optional pipeline library interface', {
  timeout: 120_000,
}, async () => {
  const backend: RhiInstance = {
    ...webgpu.rhi,
    async requestAdapter(options) {
      const requested = await webgpu.rhi.requestAdapter(options);
      if (!requested.ok) return requested;
      const adapter = requested.value;
      const wrapped: RhiAdapter = {
        ...adapter,
        async requestDevice(options) {
          const requested = await adapter.requestDevice(options);
          if (requested.ok) Reflect.deleteProperty(requested.value, 'pipelineLibrary');
          return requested;
        },
      };
      return ok(wrapped);
    },
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const created = await createRenderer(canvas, {
    rhi: backend,
    pipelineLibrary: {
      version: 1,
      backend: 'webgpu',
      shaders: [],
      bindGroupLayouts: [],
      pipelineLayouts: [],
      renderPipelines: [],
      computePipelines: [],
    },
  });
  try {
    if (!created.ok) throw created.error;
    expect(created.value.inspect().state).toBe('alive');
    expect(created.value.inspect().capabilities.backendKind).toBe('webgpu');
    expect(created.value.inspect().pipelineLibrary).toBeUndefined();
  } finally {
    if (created.ok) await created.value.dispose();
    canvas.remove();
  }
});
