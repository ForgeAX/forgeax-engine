import * as THREE from '@forgeax/engine/three';
import { ThreeMFLoader } from '@forgeax/engine/three/addons/loaders/3MFLoader.js';
import { AMFLoader } from '@forgeax/engine/three/addons/loaders/AMFLoader.js';
import { ColladaLoader } from '@forgeax/engine/three/addons/loaders/ColladaLoader.js';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels, readyFrames, verifyReplay } from './render.fixture';
import { amf, bytes, collada, threeMF } from './scene-format-addons.fixture';
import { disposeScene, supportedMaterials } from './scene-format-addons-render.fixture';
import { renderReference } from './webgpu-reference.fixture';

function load(mode: string) {
  if (mode === 'amf') return new AMFLoader().parse(bytes(amf));
  if (mode === '3mf') return new ThreeMFLoader().parse(threeMF());
  const result = new ColladaLoader().parse(collada, '');
  if (result === null) throw Error('missing Collada');
  return result.scene;
}
for (const mode of ['collada', 'amf', '3mf'])
  it(`loads and renders real DOM ${mode} scene data`, { timeout: 120000 }, async () => {
    const root = supportedMaterials(load(mode)),
      scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 5;
    scene.add(root);
    let meshes = 0;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        meshes++;
        expect(o.geometry).toBeInstanceOf(THREE.BufferGeometry);
        expect(o.geometry.getAttribute('position').count).toBeGreaterThan(0);
      }
    });
    expect(meshes).toBeGreaterThan(0);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const renderer = new THREE.WebGPURenderer({ canvas });
    let before: Uint8Array | undefined;
    try {
      await renderer.init();
      await readyFrames(renderer, scene, camera, 60);
      for (const phase of ['initial', 'edited']) {
        if (phase === 'edited') root.position.x = 0.4;
        const frame = await renderer.captureFrame(scene, camera),
          reference = await renderReference(scene, camera),
          pixels = displayPixels(frame);
        await saveBrowserEvidence(`r187-xml-${mode}-${phase}`, frame, reference);
        comparePixels(pixels, reference);
        expect(pixels.filter((v, i) => i % 4 === 3 && v > 0).length).toBeGreaterThan(100);
        if (before === undefined) before = pixels;
        else {
          expect(equalBytes(before, pixels)).toBe(false);
          await verifyReplay(frame, `r187-xml-${mode}`);
        }
      }
    } finally {
      disposeScene(root);
      await renderer.dispose();
    }
  });
