import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { featureCases, required } from './features.fixture';
import { comparePixels, displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

// Every declared case belongs to exactly one browser process, including new cases.
export function testFeaturePartition(partition: 0 | 1 | 2 | 3): void {
  const cases = Object.entries(featureCases(THREE)).filter((_, index) => index % 4 === partition);

  it.each(cases)(
    'projects %s, edits it, and replays the real frame',
    { timeout: 120000 },
    async (name, populate) => {
      const scene = new THREE.Scene(),
        camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      camera.position.z = 5;
      const mutate = populate(scene);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      document.body.append(canvas);
      const renderer = new THREE.WebGPURenderer({ canvas, stencil: name === 'stencil' });
      try {
        await renderer.init();
        for (const phase of ['initial', 'edited'] as const) {
          if (phase === 'edited') mutate();
          await readyFrames(renderer, scene, camera, phase === 'initial' ? 60 : 1);
          const capture = await renderer.captureFrame(scene, camera);
          const reference = await renderReference(scene, camera, { stencil: name === 'stencil' });
          await saveBrowserEvidence(`feature-${name}-${phase}`, capture, reference);
          comparePixels(displayPixels(capture), reference);
          if (['skin', 'skin-lit', 'morph', 'instance-colors-morph', 'batch'].includes(name)) {
            const actual = displayPixels(capture);
            let intersection = 0,
              union = 0;
            for (let offset = 3; offset < actual.length; offset += 4) {
              const a = required(actual[offset]) > 0,
                b = required(reference[offset]) > 0;
              if (a && b) intersection++;
              if (a || b) union++;
            }
            expect(union).toBeGreaterThan(0);
            expect(intersection / union).toBeGreaterThanOrEqual(0.9);
          }
          expect(capture.sources.length).toBeGreaterThan(1);
          if (phase === 'edited') await verifyReplay(capture);
        }
      } finally {
        await renderer.dispose();
        canvas.remove();
      }
    },
  );
}
