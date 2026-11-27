import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { browserRendererFixture, comparePixels, displayPixels } from './render.fixture';
import {
  verifyAnimationPath,
  verifyLegacySceneGallery,
  verifyStaticBatching,
} from './scene-format-addons-render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it.each([
  ['verifyLegacySceneGallery on browser', verifyLegacySceneGallery],
  ['verifyStaticBatching on browser', verifyStaticBatching],
  ['verifyAnimationPath on browser', verifyAnimationPath],
] as const)('%s', { timeout: 120000 }, async (_name, verify) => {
  await verify(rendererFor(), async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-scene-addons-${name}`, frame, reference);
    comparePixels(displayPixels(frame), reference);
  });
});
