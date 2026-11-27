import { mkdirSync, writeFileSync } from 'node:fs';
import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { compactTape } from '../../../runtime/src/__tests__/compact-tape.fixture';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { PROCEDURAL_RENDER_CASES } from './procedural-addons-render.fixture';
import { displayPixels } from './render.fixture';

it.each(PROCEDURAL_RENDER_CASES)(
  '%s submits completed frames on Dawn',
  {
    timeout: 120000,
  },
  async (_name, verify) => {
    const surface = offscreenCanvas(128),
      renderer = new WebGPURenderer({
        canvas: surface.canvas as unknown as OffscreenCanvas,
        forgeax: {
          bundler: {
            shaderManifestUrl: shaderManifestUrl(await buildEngineShaderTemplateManifest()),
          },
        },
      });
    try {
      await verify(renderer, async (name, frame) => {
        mkdirSync('artifacts/three-compat', { recursive: true });
        writeFileSync(
          `artifacts/three-compat/r187-round21-dawn-${name}.rhitape`,
          compactTape(frame.tape).bytes,
        );
        writeFileSync(
          `artifacts/three-compat/r187-round21-dawn-${name}.rgba`,
          displayPixels(frame),
        );
      });
    } finally {
      await renderer.dispose();
      surface.destroy();
    }
  },
);
