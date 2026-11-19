import * as THREE from '@forgeax/engine/three';
import { GLTFExporter } from '@forgeax/engine/three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from '@forgeax/engine/three/addons/loaders/GLTFLoader.js';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels, readyFrames, verifyReplay } from './render.fixture';
import { disposeScene } from './scene-format-addons-render.fixture';
import { renderReference } from './webgpu-reference.fixture';

for (const binary of [false, true])
  it(`round-trips ${binary ? 'GLB' : 'glTF JSON'} through actual browser FileReader and native draw`, {
    timeout: 120000,
  }, async () => {
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 5;
    const geometry = new THREE.BoxGeometry(1.5, 1.5, 0.7),
      material = new THREE.MeshBasicMaterial({ color: 0x22cc44 }),
      mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = 0.2;
    scene.add(mesh);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const renderer = new THREE.WebGPURenderer({ canvas });
    let loaded: THREE.Group | undefined;
    try {
      await renderer.init();
      await readyFrames(renderer, scene, camera, 60);
      const before = await renderer.captureFrame(scene, camera);
      const exported = await new GLTFExporter().parseAsync(scene, { binary });
      expect(exported instanceof ArrayBuffer).toBe(binary);
      const result = await new GLTFLoader().parseAsync(
        exported instanceof ArrayBuffer ? exported : JSON.stringify(exported),
        '',
      );
      loaded = result.scene;
      expect(loaded).toBeInstanceOf(THREE.Group);
      const output = new THREE.Scene();
      output.add(loaded);
      await readyFrames(renderer, output, camera, 60);
      const frame = await renderer.captureFrame(output, camera),
        reference = await renderReference(output, camera);
      await saveBrowserEvidence(`r187-export-${binary ? 'glb' : 'json'}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
      expect(equalBytes(displayPixels(before), displayPixels(frame))).toBe(true);
      await verifyReplay(frame, `r187-export-${binary ? 'glb' : 'json'}`);
    } finally {
      geometry.dispose();
      material.dispose();
      if (loaded) disposeScene(loaded);
      await renderer.dispose();
    }
  });
