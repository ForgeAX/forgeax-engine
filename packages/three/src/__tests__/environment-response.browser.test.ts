import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it('matches dielectric and metallic environment response across the full metalness interval', {
  timeout: 240000,
}, async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const data = new Float32Array(128 * 64 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([0.18, 0.4, 0.8, 1], offset);
  const environment = new THREE.DataTexture(data, 128, 64, THREE.RGBAFormat, THREE.FloatType);
  environment.mapping = THREE.EquirectangularReflectionMapping;
  environment.needsUpdate = true;
  scene.environment = scene.background = environment;
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(
      1.3,
      testQuality.geometry.sphereWidth,
      testQuality.geometry.sphereHeight,
    ),
    material,
  );
  scene.add(mesh);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas });
  try {
    await renderer.init();
    for (const metalness of [0, 0.3, 0.7, 1]) {
      material.metalness = metalness;
      await readyFrames(renderer, scene, camera, metalness === 0 ? 60 : 1);
      const capture = await renderer.captureFrame(scene, camera);
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`environment-metalness-${metalness}`, capture, reference);
      comparePixels(displayPixels(capture), reference);
      await verifyReplay(capture);
    }
    const physical = new THREE.MeshPhysicalMaterial({
      color: 0x80b0d0,
      roughness: 0.5,
      specularIntensity: 0.25,
    });
    mesh.material = physical;
    for (const metalness of [0, 0.5, 1]) {
      physical.metalness = metalness;
      await readyFrames(renderer, scene, camera);
      const capture = await renderer.captureFrame(scene, camera);
      const reference = await renderReference(scene, camera);
      await saveBrowserEvidence(`environment-specular-${metalness}`, capture, reference);
      comparePixels(displayPixels(capture), reference);
    }
    scene.environment = null;
    await readyFrames(renderer, scene, camera);
    const pixels = displayPixels(await renderer.captureFrame(scene, camera));
    const center = (SIZE * (SIZE / 2) + SIZE / 2) * 4;
    expect(Array.from(pixels.subarray(center, center + 3))).toEqual([0, 0, 0]);
    physical.dispose();
  } finally {
    await renderer.dispose();
    environment.dispose();
    material.dispose();
    canvas.remove();
  }
});
