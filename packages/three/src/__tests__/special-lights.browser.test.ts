import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();
it('admits the IES base spotlight and rejects unsupported photometry/projector maps', {
  timeout: 120000,
}, async () => {
  const renderer = rendererFor();
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 1 });
  const geometry = new THREE.PlaneGeometry(2, 2);
  scene.add(new THREE.Mesh(geometry, material));
  const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  try {
    for (const Light of [THREE.IESSpotLight]) {
      const light = new Light(0xffffff, 20);
      light.position.set(0, 0, 3);
      scene.add(light, light.target);
      await readyFrames(renderer, scene, camera, 60);
      const capture = await renderer.captureFrame(scene, camera);
      const expected = await renderReference(scene, camera);
      await saveBrowserEvidence(`base-${Light.name}`, capture, expected);
      comparePixels(displayPixels(capture), expected);
      expect(displayPixels(capture).some((value, index) => index % 4 !== 3 && value > 40)).toBe(
        true,
      );
      light.map = map;
      expect(() => renderer.render(scene, camera)).toThrow(/SpotLight map/);
      light.map = null;
      light.iesMap = map;
      expect(() => renderer.render(scene, camera)).toThrow(/iesMap/);
      light.iesMap = null;
      scene.remove(light, light.target);
      light.dispose();
    }
  } finally {
    geometry.dispose();
    material.dispose();
    map.dispose();
  }
});
