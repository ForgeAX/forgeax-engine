import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { compactTape } from '../../../runtime/src/__tests__/compact-tape.fixture';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { displayPixels } from './render.fixture';
import { verifyTargetSurface } from './target-surface.fixture';
import { cookTargetSurface } from './target-surface-cook.fixture';

it('combines cooked Surface expressions with native target maps and fresh Dawn replay', {
  timeout: 120000,
}, async () => {
  const publication = await cookTargetSurface();
  const surface = offscreenCanvas(128);
  const renderer = new WebGPURenderer({
    canvas: surface.canvas as unknown as OffscreenCanvas,
    forgeax: {
      materialPrograms: [publication.publication],
      bundler: { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    },
  });
  try {
    const root =
      process.env.FORGEAX_THREE_TARGET_SURFACE_EVIDENCE_DIR ??
      join(tmpdir(), 'forgeax-three-target-surface');
    await mkdir(root, { recursive: true });
    await verifyTargetSurface(
      renderer,
      publication.recipe,
      async (phase, capture) => {
        await writeFile(join(root, `${phase}.rhitape`), compactTape(capture.tape).bytes);
        await writeFile(join(root, `${phase}.rgba`), displayPixels(capture));
      },
      async (tape) => {
        await writeFile(join(root, 'target-surface-write.rhitape'), tape);
      },
    );
  } finally {
    await renderer.dispose();
    surface.destroy();
  }
});
