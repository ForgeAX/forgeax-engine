import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { createInteropJourney } from './interop.fixture';
import { SIZE } from './render.fixture';

for (const kind of ['occlusion', 'shadows'] as const)
  it(`shares real ${kind}, native resources and one submitted world`, {
    timeout: 120000,
  }, async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    document.body.append(canvas);
    const journey = await createInteropJourney(canvas);
    try {
      if (kind === 'occlusion') await journey.verifyOcclusion(saveBrowserEvidence);
      else await journey.verifyShadows(saveBrowserEvidence);
    } finally {
      await journey.dispose();
      canvas.remove();
    }
  });
