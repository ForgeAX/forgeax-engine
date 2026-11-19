import * as THREE from '@forgeax/engine/three';
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { featureCases, required } from './features.fixture';
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
  SIZE,
  verifyReplay,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

function renderStockPointsReference(scene: THREE.Scene, camera: THREE.Camera): Uint8Array {
  // Stock PointsMaterial projects the r187 WebGL size and attenuation contract.
  // Three WebGPU draws a one-pixel primitive regardless of those material fields.
  const reference = new WebGLRenderer({ alpha: true, preserveDrawingBuffer: true });
  try {
    reference.setSize(SIZE, SIZE, false);
    reference.render(scene.clone(), camera.clone());
    const readback = document.createElement('canvas');
    readback.width = readback.height = SIZE;
    const context = readback.getContext('2d');
    if (context === null) throw new Error('Stock PointsMaterial reference requires pixel readback');
    context.drawImage(reference.domElement, 0, 0);
    return new Uint8Array(context.getImageData(0, 0, SIZE, SIZE).data);
  } finally {
    reference.dispose();
    reference.forceContextLoss();
  }
}

// Every declared case belongs to exactly one browser process, including new cases.
export function testFeaturePartition(partition: 0 | 1 | 2 | 3): void {
  const rendererFor = browserRendererFixture();
  const cases = Object.entries(featureCases(THREE)).filter((_, index) => index % 4 === partition);

  it.each(cases)(
    'projects %s, edits it, and replays the real frame',
    { timeout: 120000 },
    async (name, populate) => {
      const scene = new THREE.Scene(),
        camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      camera.position.z = 5;
      const mutate = populate(scene);
      const renderer = rendererFor({ stencil: name === 'stencil' });
      await renderer.init();
      for (const phase of ['initial', 'edited'] as const) {
        if (phase === 'edited') mutate();
        await readyFrames(renderer, scene, camera, phase === 'initial' ? 60 : 1);
        const capture = await renderer.captureFrame(scene, camera);
        const reference =
          name === 'points'
            ? renderStockPointsReference(scene, camera)
            : await renderReference(scene, camera, { stencil: name === 'stencil' });
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
    },
  );
}
