import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyAddonGallery, verifySceneDecomposition } from './cpu-addons-render.fixture';
import { browserRendererFixture, comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it.each([
  ['verifyAddonGallery on browser', verifyAddonGallery],
  ['verifySceneDecomposition on browser', verifySceneDecomposition],
] as const)('%s', { timeout: 120000 }, async (_name, verify) => {
  await verify(rendererFor(), async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-cpu-addons-${name}`, frame, reference);
    comparePixels(displayPixels(frame), reference);
  });
});
