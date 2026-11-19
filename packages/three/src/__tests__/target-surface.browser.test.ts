import { WebGPURenderer } from '@forgeax/engine/three';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { saveBrowserBytes, saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyTargetSurface } from './target-surface.fixture';

it('combines cooked Surface expressions with ordered target maps, updates and retirement', {
  timeout: 120000,
}, async () => {
  const publication = await commands.prepareThreeTargetSurface();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const renderer = new WebGPURenderer({
    canvas,
    forgeax: { materialPrograms: [publication.publication] },
  });
  try {
    await verifyTargetSurface(renderer, publication.recipe, saveBrowserEvidence, async (tape) => {
      await saveBrowserBytes('target-surface-write.rhitape', tape);
    });
  } finally {
    await renderer.dispose();
    canvas.remove();
  }
});
