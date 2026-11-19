import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePrimitivePixels, nodeFamilies, verifyNodeFamily } from './node-family.fixture';
import { browserRendererFixture, comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();
it.each(nodeFamilies)('matches independent r187 %s NodeMaterial source and edits', {
  timeout: 120000,
}, async (kind) => {
  await verifyNodeFamily(rendererFor(), kind, async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-node-family-${name}`, frame, reference);
    comparePixels(displayPixels(frame), reference);
    if (['line', 'dashed', 'points'].includes(kind))
      comparePrimitivePixels(displayPixels(frame), reference, 128);
  });
});
