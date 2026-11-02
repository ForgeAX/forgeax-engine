import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer } from '../../assembly/factory';
import * as submissionSystems from '../submission-systems';

/**
 * Screen UI textures retire through the Renderer's one submission lifecycle
 * (`retireAfterSubmission`), not through a compositor-private completion fence.
 */
it('retires a resized UI image through the Render World submission lifecycle', async () => {
  const retired = vi.spyOn(submissionSystems, 'retireAfterSubmission');
  const canvas = { width: 8, height: 8, getContext: () => null };
  const renderer = await createRenderer(
    canvas,
    { ui: { kind: 'rgba', paint: (_t, w, h) => new Uint8Array(w * h * 4).fill(255) } },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
    {
      rhi,
      createShaderModule: async (device, descriptor) => rhi.createShaderModule(device, descriptor),
    },
  );
  try {
    const frame = async () => {
      const drawn = renderer.draw({ leases: [], camera: null, environment: null });
      if (!drawn.ok) throw drawn.error;
      if (drawn.value !== undefined) {
        const completed = await drawn.value.completed;
        if (!completed.ok) throw completed.error;
      }
    };
    await frame();
    const before = retired.mock.calls.length;
    canvas.width = 16;
    canvas.height = 16;
    await frame();
    expect(retired.mock.calls.length).toBeGreaterThan(before);
  } finally {
    retired.mockRestore();
    await renderer.dispose();
  }
});

/** The compositor reports failures as data; the Renderer still rejects the draw. */
it('rejects the frame with the published draw contract error and records the outcome', async () => {
  const canvas = { width: 8, height: 8, getContext: () => null };
  const renderer = await createRenderer(
    canvas,
    { ui: { kind: 'rgba', paint: () => new Uint8Array(3) } },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
    {
      rhi,
      createShaderModule: async (device, descriptor) => rhi.createShaderModule(device, descriptor),
    },
  );
  try {
    const drawn = renderer.draw({ leases: [], camera: null, environment: null });
    expect(drawn.ok).toBe(false);
    if (drawn.ok) return;
    // The frame entry surfaces the same RendererContractFailureError('draw') as before.
    expect(drawn.error).toMatchObject({
      detail: {
        error: {
          name: 'RendererContractFailureError',
          message: expect.stringContaining('renderer draw contract failed: UI paint must return'),
        },
      },
    });
  } finally {
    await renderer.dispose();
  }
});
