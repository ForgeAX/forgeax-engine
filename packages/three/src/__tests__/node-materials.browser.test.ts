import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyNodeMaterials } from './node-materials.fixture';
import { browserRendererFixture, comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();
it('matches original r187 ordinary NodeMaterial models, texture edits and alpha without graph compilation', {
  timeout: 120000,
}, async () => {
  await verifyNodeMaterials(rendererFor(), async (name, capture, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-node-materials-${name}`, capture, reference);
    comparePixels(displayPixels(capture), reference);
  });
});
