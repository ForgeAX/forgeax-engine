import { WebGPURenderer } from '@forgeax/engine/three';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels } from './render.fixture';
import { verifySurfaceExpression } from './surface-expression.fixture';
import { surfaceExpressionReference } from './surface-expression-reference.fixture';

it.each([
  'standard',
  'unlit',
  'roughness',
] as const)('submits %s expression recipes for sixty completed Chromium frames and dynamic updates', {
  timeout: 120000,
}, async (kind) => {
  const publication = await commands.prepareThreeSurfaceExpression(kind);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const renderer = new WebGPURenderer({
    canvas,
    forgeax: { materialPrograms: publication.publications },
  });
  try {
    await verifySurfaceExpression(renderer, publication, kind, async (name, capture) => {
      const reference = await surfaceExpressionReference(kind, name);
      await saveBrowserEvidence(`surface-expression-${name}`, capture, reference);
      if (kind !== 'standard') comparePixels(displayPixels(capture), reference);
    });
  } finally {
    await renderer.dispose();
    canvas.remove();
  }
});
