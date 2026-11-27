import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebGPURenderer } from '@forgeax/engine/three';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { compactTape } from '../../../runtime/src/__tests__/compact-tape.fixture';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { displayPixels, verifyReplay } from './render.fixture';
import { verifySurfaceExpression } from './surface-expression.fixture';
import { cookSurfaceExpression } from './surface-expression-cook.fixture';

let manifestUrl: Promise<string> | undefined;

it.each([
  'standard',
  'unlit',
  'roughness',
] as const)('cooks and submits %s expressions for sixty completed Dawn frames, dynamic values, textures and replay', {
  timeout: 120000,
}, async (kind) => {
  const publication = await cookSurfaceExpression(kind);
  manifestUrl ??= buildEngineShaderTemplateManifest().then(shaderManifestUrl);
  const shaderManifest = await manifestUrl;
  const surface = offscreenCanvas(128);
  const renderer = new WebGPURenderer({
    canvas: surface.canvas as unknown as OffscreenCanvas,
    forgeax: {
      materialPrograms: publication.publications,
      bundler: { shaderManifestUrl: shaderManifest },
    },
  });
  try {
    const evidenceRoot =
      process.env.FORGEAX_THREE_SURFACE_EVIDENCE_DIR ??
      (await mkdtemp(join(tmpdir(), 'forgeax-three-surface-')));
    await mkdir(evidenceRoot, { recursive: true });
    // biome-ignore lint/suspicious/noConsole: Preserve the actual capture location for local and CI diagnosis.
    console.info('[three-surface-evidence]', evidenceRoot);
    await verifySurfaceExpression(
      renderer,
      publication,
      kind,
      async (phase, capture) => {
        await writeFile(join(evidenceRoot, `${phase}.rhitape`), compactTape(capture.tape).bytes);
        await writeFile(
          join(evidenceRoot, `${phase}.json`),
          JSON.stringify({
            frameId: capture.receipt.frameId,
            draws: capture.observation.draws,
            sources: capture.sources,
          }),
        );
        await writeFile(join(evidenceRoot, `${phase}.rgba`), displayPixels(capture));
      },
      async (capture, label) => {
        // Standard covers both sides of a source revision. The other materials
        // preserve all live checks and replay their structurally rebound program.
        if (kind === 'standard' || label.endsWith('-rebound')) await verifyReplay(capture, label);
      },
      kind !== 'roughness',
    );
  } finally {
    await renderer.dispose();
    surface.destroy();
  }
});
