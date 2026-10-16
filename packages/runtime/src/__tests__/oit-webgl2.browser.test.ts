import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { expect, it } from 'vitest';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { loadRhiPack } from '../backend-selection';
import { OIT_SIZE, verifyOit } from './oit.fixture';

// WebGL2 OIT proof (plan section 2.3): the shared accum/weight layout runs on
// rhi-wgpu and meets the same reference and order-independence gates as
// WebGPU and Dawn. Deferred is not admitted on WebGL2 (storage buffers and
// six color attachments), independently of transparency.
it.each([
  { renderPath: 'forward', msaa: false },
  { renderPath: 'forward', msaa: true },
] as const)('weighted blended OIT on rhi-wgpu WebGL2 $renderPath msaa=$msaa', {
  timeout: 240_000,
}, async (options) => {
  await wgpu.ensureReady();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = OIT_SIZE;
  document.body.append(canvas);
  const constructed = await constructRendererHost(
    canvas,
    undefined,
    { shaderManifestUrl: '/shaders/manifest.json' },
    loadRhiPack(wgpu as unknown as Record<string, unknown>),
  );
  if (!constructed.ok) throw new Error(JSON.stringify(constructed.error));
  const { renderer } = constructed.value;
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    const evidence = await verifyOit(renderer, options);
    expect(evidence.oitOrderDelta).toBeLessThanOrEqual(0.01);
    expect(evidence.sortedOrderDelta).toBeGreaterThan(0.1);
  } finally {
    renderer.dispose();
    canvas.remove();
  }
});
