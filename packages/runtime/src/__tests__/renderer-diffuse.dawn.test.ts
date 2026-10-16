import { mkdirSync, writeFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { rayPathCommands } from '../../../render/src/__tests__/raytracing/path-tracer.commands';
import { verifyRendererDiffuse } from './renderer-diffuse.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());

for (const reconstruction of [undefined, 'combined'] as const) {
  it(`submits ordinary Renderer diffuse GI (${reconstruction ?? 'raw'}) with content invalidation and exact RHI replay`, async () => {
    const directory = `${process.env.FORGEAX_RAY_EVIDENCE ?? 'artifacts/raytracing/iteration-03/renderer-diffuse/dawn'}/${reconstruction ?? 'raw'}`;
    mkdirSync(directory, { recursive: true });
    await verifyRendererDiffuse(
      await rayPathCommands.prepareRayPublicationSet(undefined, ['matte', 'emission']),
      (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
      manifest,
      reconstruction,
    );
  }, 180000);
}
