import { createRenderer } from '@forgeax/engine-runtime';
import { expect, it, vi } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { verifySubsurface } from './subsurface.fixture';

// Dawn owns all three geometry paths; App owns skinned publication through
// both Worker layouts. Keep Browser's direct validation on the rigid fixture.
it('ordinary rigid SSS preserves emission and restores zero on Browser WebGPU', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const modules = vi.spyOn(GPUDevice.prototype, 'createShaderModule');
  const diffusionModules = () =>
    modules.mock.calls.filter(
      ([descriptor]) => descriptor.label === 'forgeax::engine-subsurface-diffusion',
    );
  try {
    const renderer = renderValue(await createRenderer(canvas));
    try {
      expect(diffusionModules()).toHaveLength(0);
      await verifySubsurface(renderer, 'rigid');
      expect(diffusionModules()).toHaveLength(1);
    } finally {
      await renderer.dispose();
    }
  } finally {
    modules.mockRestore();
  }
}, 180_000);
