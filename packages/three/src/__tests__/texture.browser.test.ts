import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { flatShadingMaterialTypes, verifyFlatShading } from './flat-shading.fixture';
import { browserRendererFixture } from './render.fixture';
import { verifyTextures } from './texture.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it('matches independently authored r184 WebGPU inputs: textures', {
  timeout: 120000,
}, async () => {
  // Each upstream Renderer keeps independent node/material caches while its
  // file-owned device avoids repeated adapter/device startup per comparison.
  await verifyTextures(rendererFor(), renderReference, saveBrowserEvidence);
});

it.each(
  flatShadingMaterialTypes,
)('matches independently authored r184 WebGPU inputs: flat shading %s', {
  timeout: 120000,
}, async (materialType) => {
  await verifyFlatShading(rendererFor(), renderReference, saveBrowserEvidence, materialType);
});
