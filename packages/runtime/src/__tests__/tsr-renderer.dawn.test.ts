import { mkdir, writeFile } from 'node:fs/promises';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { verifyTsrRenderer } from './tsr-renderer.fixture';

it.each([
  'forward',
  'deferred',
] as const)('submits sixty %s TSR frames and fresh-device replays seeded analysis and reconstruction', {
  timeout: 240_000,
}, async (renderPath) => {
  const surface = offscreenCanvas(64);
  const output = process.env.FORGEAX_TSR_EVIDENCE
    ? `${process.env.FORGEAX_TSR_EVIDENCE}/${renderPath}`
    : undefined;
  if (output) await mkdir(output, { recursive: true });
  try {
    await verifyTsrRenderer(
      surface.canvas,
      shaderManifestUrl(await buildEngineShaderManifest()),
      output ? (name, bytes) => writeFile(`${output}/${name}`, bytes) : undefined,
      renderPath,
    );
  } finally {
    surface.destroy();
  }
});
