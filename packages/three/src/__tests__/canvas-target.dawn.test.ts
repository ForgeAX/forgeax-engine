import { mkdirSync, writeFileSync } from 'node:fs';
import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it, vi } from 'vitest';
import { compactTape } from '../../../runtime/src/__tests__/compact-tape.fixture';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { verifyCanvasTarget } from './canvas-target.fixture';
import { displayPixels } from './render.fixture';

it('shares CanvasTarget authoring through resize, validation, Dawn submission and replay', {
  timeout: 120000,
}, async () => {
  const surface = offscreenCanvas(128);
  const renderer = new WebGPURenderer({
    canvas: surface.canvas as unknown as OffscreenCanvas,
    forgeax: {
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    },
  });
  try {
    await renderer.init();
    await verifyCanvasTarget(renderer, async (name, capture) => {
      mkdirSync('artifacts/three-compat', { recursive: true });
      writeFileSync(
        `artifacts/three-compat/r187-dawn-canvas-${name}.rhitape`,
        compactTape(capture.tape).bytes,
      );
      writeFileSync(`artifacts/three-compat/r187-dawn-canvas-${name}.rgba`, displayPixels(capture));
    });
    const dispose = vi.fn();
    renderer.getCanvasTarget().addEventListener('dispose', dispose);
    await renderer.dispose();
    await renderer.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    await renderer.dispose();
    surface.destroy();
  }
});
