import * as THREE from '@forgeax/engine/three';
import { SVGLoader } from '@forgeax/engine/three/addons/loaders/SVGLoader.js';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { svg } from './data-addons.fixture';
import { comparePixels, displayPixels, readyFrames, verifyReplay } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it('parses real browser SVG paths into visible public shapes and native mesh geometry', {
  timeout: 120000,
}, async () => {
  const parsed = new SVGLoader().parse(svg);
  expect(parsed.paths).toHaveLength(1);
  expect(parsed.paths[0]).toBeInstanceOf(THREE.ShapePath);
  const path = parsed.paths[0];
  if (path === undefined) throw Error('missing SVG path');
  const shapes = SVGLoader.createShapes(path);
  expect(shapes[0]).toBeInstanceOf(THREE.Shape);
  const geometry = new THREE.ShapeGeometry(shapes).translate(-0.5, -0.5, 0).scale(1.5, 1.5, 1),
    material = new THREE.MeshBasicMaterial({ color: 0x22cc44, side: THREE.DoubleSide }),
    scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  scene.add(new THREE.Mesh(geometry, material));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const renderer = new THREE.WebGPURenderer({ canvas });
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    for (const phase of ['initial', 'edited']) {
      if (phase === 'edited') material.color.setHex(0xdd3344);
      const frame = await renderer.captureFrame(scene, camera),
        reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`r187-svg-addon-${phase}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
      const pixels = displayPixels(frame);
      expect(
        pixels.filter((v, i) => i % 4 === (phase === 'initial' ? 1 : 0) && v > 100).length,
      ).toBeGreaterThan(100);
      if (phase === 'edited') await verifyReplay(frame, 'r187-svg-addon');
    }
  } finally {
    geometry.dispose();
    material.dispose();
    await renderer.dispose();
  }
});
