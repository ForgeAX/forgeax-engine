import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
  SIZE,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it('renders the camera-visible Y-axis hemisphere with the r187 sky and ground response', {
  timeout: 120000,
}, async () => {
  const renderer = rendererFor();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 4;
  const geometry = new THREE.SphereGeometry(1, 48, 32);
  const material = new THREE.MeshStandardMaterial({ roughness: 1 });
  const light = new THREE.HemisphereLight(0xff3000, 0x0040ff, Math.PI);
  scene.add(new THREE.Mesh(geometry, material), light);
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    const capture = await renderer.captureFrame(scene, camera);
    const actual = displayPixels(capture);
    const expected = await renderReference(scene, camera);
    comparePixels(actual, expected);
    await saveBrowserEvidence('hemisphere-light', capture, expected);

    const top = (40 * SIZE + SIZE / 2) * 4;
    const bottom = (88 * SIZE + SIZE / 2) * 4;
    expect(actual[top] ?? 0).toBeGreaterThan(actual[top + 2] ?? 0);
    expect(actual[bottom + 2] ?? 0).toBeGreaterThan(actual[bottom] ?? 0);

    light.position.y = -1;
    await readyFrames(renderer, scene, camera);
    const inverted = displayPixels(await renderer.captureFrame(scene, camera));
    expect(inverted[top + 2] ?? 0).toBeGreaterThan(inverted[top] ?? 0);
    expect(inverted[bottom] ?? 0).toBeGreaterThan(inverted[bottom + 2] ?? 0);
  } finally {
    geometry.dispose();
    material.dispose();
    light.dispose();
  }
});
