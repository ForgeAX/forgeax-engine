import { mkdir, writeFile } from 'node:fs/promises';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { shaderManifestUrl } from '../../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { prepareDiffuseReconstructionFixture } from './diffuse-reconstruction.commands';
import { verifyDiffuseReconstruction } from './diffuse-reconstruction.fixture';
import { loadPublishedRayKernels } from './published-kernels.fixture';

const published = await loadPublishedRayKernels(
  shaderManifestUrl(await buildEngineShaderManifest()),
);

it('rejects incompatible history and reconstructs raw diffuse with exact history replay', async () => {
  const directory = process.env.FORGEAX_RAY_EVIDENCE ?? 'artifacts/raytracing/iteration-03/kernel';
  await mkdir(directory, { recursive: true });
  await verifyDiffuseReconstruction(
    { ...(await prepareDiffuseReconstructionFixture()), kernel: published.reconstruction },
    (name, bytes) => writeFile(`${directory}/${name}`, bytes),
  );
}, 120000);
