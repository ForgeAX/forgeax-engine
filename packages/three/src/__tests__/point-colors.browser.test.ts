import { WebGPURenderer } from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { pointColorModes, verifyPointColors } from './point-colors.fixture';
import { comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

for (const mode of pointColorModes)
  it(`point colors ${mode} on browser`, { timeout: 120000 }, async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const renderer = new WebGPURenderer({ canvas });
    try {
      await verifyPointColors(renderer, mode, async (name, frame, scene, camera) => {
        const reference = await renderReference(scene, camera);
        await saveBrowserEvidence(`r187-point-colors-${name}`, frame, reference);
        comparePixels(displayPixels(frame), reference);
        expect(
          equalBytes(displayPixels(frame), reference),
          `${name} point pixels match r187 exactly`,
        ).toBe(true);
      });
    } finally {
      await renderer.dispose();
    }
  });
