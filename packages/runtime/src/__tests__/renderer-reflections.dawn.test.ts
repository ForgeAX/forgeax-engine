import { mkdirSync, writeFileSync } from 'node:fs';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { rayPathCommands } from '../../../render/src/__tests__/raytracing/path-tracer.commands';
import { verifyRendererReflections } from './renderer-reflections.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderTemplateManifest());

const reconstruction = 'combined';
it(`traces Lite reflections (combined) from world radiance with single-count specular and exact RHI replay`, async () => {
  const directory = `${process.env.FORGEAX_RAY_EVIDENCE ?? 'artifacts/raytracing/lite-reflections/dawn'}/combined`;
  mkdirSync(directory, { recursive: true });
  await verifyRendererReflections(
    await rayPathCommands.prepareRayPublicationSet(undefined, [
      'mirror',
      'glossy',
      'metal',
      'matte',
      'emission',
    ]),
    (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
    manifest,
    reconstruction,
  );
}, 300000);
