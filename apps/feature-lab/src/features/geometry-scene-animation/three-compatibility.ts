import { decodeImage, toRgba8 } from '@forgeax/engine/rhi-debug';
import * as THREE from '@forgeax/engine/three';
import { CheckList, defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Three.js compatibility',
  catalog: 'Three.js compatibility',
  kind: 'probe',
  summary:
    'Ordinary Three.js r184 scene objects render through ForgeaX. This probe owns and retires an independent renderer; the package example provides interactive controls.',
  expect:
    'At least 60 ready GPU frames complete, a captured green cube has real colored pixels, and changing the same material to red changes the captured output. This is bounded compatibility, not full Three conformance.',
  setup() {
    return {
      async checks() {
        const checks = new CheckList();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        const renderer = new THREE.WebGPURenderer({ canvas });
        const geometry = new THREE.BoxGeometry(1.7, 1.7, 1.7);
        const material = new THREE.MeshBasicMaterial({ color: 0x20dd40 });
        const scene = new THREE.Scene(),
          camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
        camera.position.z = 5;
        scene.add(new THREE.Mesh(geometry, material));
        try {
          await renderer.init();
          let completed = 0;
          const deadline = performance.now() + 120_000;
          while (completed < 60) {
            renderer.render(scene, camera);
            const receipt = renderer.inspect().receipt;
            if (receipt === undefined) throw new Error('Missing native frame receipt');
            const completion = await receipt.completed;
            if (!completion.ok) throw completion.error;
            if (receipt.presentation === 'ready') completed++;
            if (performance.now() > deadline) throw new Error('Three scene readiness deadline');
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          checks.equal('ready native frames completed', completed, 60);
          const pixels = async () => {
            const capture = await renderer.captureFrame(scene, camera);
            const display = capture.observation.observations?.find(
              (entry) => entry.domain === 'final-display',
            );
            if (display === undefined)
              throw new Error('Missing receipt-bound final-display pixels');
            return toRgba8(decodeImage(display.bytes, display.metadata).unwrap());
          };
          const green = await pixels();
          material.color.setHex(0xdd2040);
          const red = await pixels();
          let greenPixels = 0,
            redPixels = 0;
          for (let i = 0; i < green.length; i += 4) {
            if ((green[i + 1] ?? 0) > (green[i] ?? 0) + 30) greenPixels++;
            if ((red[i] ?? 0) > (red[i + 1] ?? 0) + 30) redPixels++;
          }
          checks.ok(
            'captured cube is green before the edit',
            greenPixels > 100,
            `pixels=${greenPixels}`,
          );
          checks.ok('same source material becomes red', redPixels > 100, `pixels=${redPixels}`);
        } finally {
          geometry.dispose();
          material.dispose();
          await renderer.dispose();
        }
        return checks.items;
      },
    };
  },
});
