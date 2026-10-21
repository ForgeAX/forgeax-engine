import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { comparePixels, displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

it.each([
  'basic',
  'standard',
] as const)('preserves %s caster map coverage independently of surface opacity', {
  timeout: 180000,
}, async (kind) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const renderer = new THREE.WebGPURenderer({ canvas });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x405060);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(5, 5, 7);
  camera.lookAt(0, 0.5, 0);
  const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xc0b090, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), floorMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const material =
    kind === 'basic' ? new THREE.MeshBasicMaterial() : new THREE.MeshStandardMaterial();
  const cube = new THREE.Mesh<THREE.BufferGeometry, typeof material>(
    new THREE.BoxGeometry(2, 2, 2),
    material,
  );
  cube.position.y = 1;
  cube.castShadow = true;
  cube.layers.set(1);
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-3, 6, 4);
  light.castShadow = true;
  light.shadow.mapSize.set(128, 128);
  light.shadow.camera.layers.set(1);
  scene.add(ground, cube, light, new THREE.AmbientLight(0xffffff, 0.4));
  const texture = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0]),
    2,
    2,
  );
  texture.needsUpdate = true;
  const alphaPixels = new Uint8Array([
    0, 255, 0, 255, 255, 0, 255, 255, 255, 0, 255, 255, 0, 255, 0, 255,
  ]);
  const alphaMap = new THREE.DataTexture(alphaPixels, 2, 2);
  alphaMap.needsUpdate = true;
  try {
    await renderer.init();
    const measure = async (name: string, count = 1) => {
      await readyFrames(renderer, scene, camera, count);
      const capture = await renderer.captureFrame(scene, camera);
      const reference = await renderReference(scene, camera, { shadowMap: renderer.shadowMap });
      await saveBrowserEvidence(`shadow-alpha-${kind}-${name}`, capture, reference);
      const pixels = displayPixels(capture);
      comparePixels(pixels, reference);
      await verifyReplay(capture);
      return pixels;
    };
    const opaque = await measure('opaque', 60);
    material.transparent = true;
    material.opacity = 0.2;
    material.alphaTest = 0.5;
    material.alphaHash = true;
    material.alphaToCoverage = true;
    material.needsUpdate = true;
    expect(await measure('surface-alpha-ignored')).toEqual(opaque);
    material.map = texture;
    material.needsUpdate = true;
    const mapped = await measure('map-alpha');
    expect(mapped).not.toEqual(opaque);
    material.map = null;
    material.alphaMap = alphaMap;
    material.needsUpdate = true;
    expect(await measure('alpha-map-red')).toEqual(mapped);
    alphaPixels.fill(128);
    alphaMap.needsUpdate = true;
    material.alphaTest = 128 / 255;
    const equality = await measure('cutoff-equality');
    cube.castShadow = false;
    expect(await measure('caster-off')).toEqual(equality);
    // A thin sheet separates Front/Back/DoubleSide, while zero vertex alpha
    // proves that the shadow material does not inherit surface vertex opacity.
    cube.geometry.dispose();
    cube.geometry = new THREE.PlaneGeometry(2, 2);
    const colors = new Float32Array(cube.geometry.getAttribute('position').count * 4);
    for (let i = 0; i < colors.length; i += 4) colors.set([1, 1, 1, 0], i);
    cube.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    cube.rotation.x = -Math.PI / 2;
    cube.castShadow = true;
    material.alphaMap = null;
    material.vertexColors = true;
    material.shadowSide = THREE.FrontSide;
    material.needsUpdate = true;
    const front = await measure('front-side-zero-vertex-alpha');
    expect(front).not.toEqual(equality);
    material.shadowSide = THREE.BackSide;
    const back = await measure('back-side');
    expect(back).toEqual(equality);
    material.shadowSide = THREE.DoubleSide;
    expect(await measure('double-side')).toEqual(front);
    material.shadowSide = null;
    expect(await measure('default-shadow-side')).toEqual(back);
  } finally {
    await renderer.dispose();
    cube.geometry.dispose();
    ground.geometry.dispose();
    for (const resource of [material, floorMaterial, texture, alphaMap]) resource.dispose();
  }
});
