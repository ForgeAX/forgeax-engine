import * as THREE from '@forgeax/engine/three';
import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it.each([
  { kind: 'directional', width: 128, height: 128 },
  { kind: 'spot', width: 128, height: 128 },
  { kind: 'directional', width: 256, height: 128 },
  { kind: 'spot', width: 128, height: 256 },
] as const)('starts with $kind variance shadows ($width x $height)', { timeout: 180000 }, async ({
  kind,
  width,
  height,
}) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new THREE.WebGPURenderer({ canvas });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x405060);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(5, 5, 7);
  camera.lookAt(0, 0.5, 0);
  const material = new THREE.MeshStandardMaterial({ color: 0xc0b090, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), material);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 1.5), material);
  cube.position.y = 1;
  cube.castShadow = cube.receiveShadow = true;
  const light =
    kind === 'directional'
      ? new THREE.DirectionalLight(0xffffff, 3)
      : new THREE.SpotLight(0xffffff, 200);
  light.position.set(-3, 6, 4);
  light.castShadow = true;
  light.shadow.mapSize.set(width, height);
  scene.add(ground, cube, light, new THREE.AmbientLight(0xffffff, 0.4));
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    const capture = await renderer.captureFrame(scene, camera);
    const reference = await renderReference(scene, camera, { shadowMap: renderer.shadowMap });
    await saveBrowserEvidence(`variance-${kind}-${width}x${height}-startup`, capture, reference);
    comparePixels(displayPixels(capture), reference);
    await verifyReplay(capture);
  } catch (error) {
    throw new Error(`${kind} variance: ${JSON.stringify(error)}`, { cause: error });
  } finally {
    await renderer.dispose();
    material.dispose();
  }
});
