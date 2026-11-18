import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
  verifyReplay,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it('renders storage-backed grouped objects and a reusable fullscreen triangle on r187', {
  timeout: 120000,
}, async () => {
  const renderer = rendererFor();
  await renderer.init();
  const group = new THREE.BundleGroup(),
    scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const position = geometry.getAttribute('position');
  const storage = new THREE.StorageBufferAttribute(position.array as Float32Array, 3);
  geometry.setAttribute('position', storage);
  const index = new THREE.IndirectStorageBufferAttribute(
    new Uint32Array(geometry.index?.array ?? []),
    1,
  );
  geometry.setIndex(index);
  const material = new THREE.MeshBasicMaterial({ color: 0x44aaff });
  const mesh = new THREE.InstancedMesh(geometry, material, 2);
  mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(2, 16);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-0.7, 0, 0));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0.7, 0, 0));
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  scene.add(group);
  await readyFrames(renderer, scene, camera, 60);
  const capture = await renderer.captureFrame(scene, camera);
  const initialReference = await renderReference(scene, camera);
  await saveBrowserEvidence('r187-storage-initial', capture, initialReference);
  comparePixels(displayPixels(capture), initialReference);
  expect(storage.itemSize).toBe(3);
  storage.setX(0, -0.25);
  storage.needsUpdate = true;
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0.7, 0.4, 0));
  mesh.instanceMatrix.needsUpdate = true;
  group.needsUpdate = true;
  await readyFrames(renderer, scene, camera, 1);
  const edited = await renderer.captureFrame(scene, camera);
  await saveBrowserEvidence('r187-storage-edited', edited);
  comparePixels(displayPixels(edited), await renderReference(scene, camera));
  expect(displayPixels(edited)).not.toEqual(displayPixels(capture));
  await saveBrowserEvidence('r187-storage-bundle', edited);
  await verifyReplay(edited, 'r187-storage-bundle');
  const quad = new THREE.QuadMesh(new THREE.MeshBasicMaterial({ color: 0xff3344 }));
  await readyFrames(renderer, quad, quad.camera, 60);
  quad.render(renderer);
  await renderer.waitForGPU();
  const full = await renderer.captureFrame(quad, quad.camera);
  await saveBrowserEvidence('r187-fullscreen-initial', full);
  const pixels = displayPixels(full);
  for (const pixel of [0, 127, 128 * 127, 128 * 128 - 1])
    expect(Array.from(pixels.subarray(pixel * 4, pixel * 4 + 4))).toEqual([255, 51, 68, 255]);
  comparePixels(pixels, await renderReference(quad, quad.camera));
  quad.material = new THREE.MeshBasicMaterial({ color: 0x22ff55 });
  await quad.renderAsync(renderer);
  renderer.resetState();
  await renderer.waitForGPU();
  expect(renderer.hasCompatibility('texture-compare')).toBe(true);
  expect(renderer.hasCompatibility('unknown-hint')).toBe(false);
  await readyFrames(renderer, quad, quad.camera, 1);
  const final = await renderer.captureFrame(quad, quad.camera);
  comparePixels(displayPixels(final), await renderReference(quad, quad.camera));
  await saveBrowserEvidence('r187-fullscreen', final);
  geometry.dispose();
  material.dispose();
  quad.material.dispose();
  mesh.dispose();
});

it('honors and resets a caller transparent comparator using source render items', {
  timeout: 120000,
}, async () => {
  const renderer = rendererFor();
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const red = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const blue = new THREE.MeshBasicMaterial({
    color: 0x0000ff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const far = new THREE.Mesh(geometry, red),
    near = new THREE.Mesh(geometry, blue);
  far.position.z = -0.1;
  scene.add(far, near);
  let calls = 0;
  const reverse = (a: THREE.RenderItem, b: THREE.RenderItem) => {
    calls++;
    expect(a.object).toBeInstanceOf(THREE.Mesh);
    expect(a.geometry).toBe(geometry);
    expect(a.material === red || a.material === blue).toBe(true);
    if (a.object === null) throw new Error('missing source object');
    const expected = new THREE.Vector4(0, 0, 0, 1)
      .applyMatrix4(a.object.matrixWorld)
      .applyMatrix4(camera.matrixWorldInverse)
      .applyMatrix4(camera.projectionMatrix);
    expect(a.z).toBeCloseTo(expected.z, 6);
    return (a.z ?? 0) - (b.z ?? 0);
  };
  renderer.setTransparentSort(reverse);
  await readyFrames(renderer, scene, camera, 60);
  expect(calls).toBeGreaterThan(0);
  const custom = await renderer.captureFrame(scene, camera);
  const customReference = await renderReference(scene, camera, {
    transparentSort: (a, b) => (a.z ?? 0) - (b.z ?? 0),
  });
  await saveBrowserEvidence('r187-transparent-custom', custom, customReference);
  comparePixels(displayPixels(custom), customReference);
  calls = 0;
  renderer.sortObjects = false;
  await readyFrames(renderer, scene, camera, 1);
  expect(calls).toBe(0);
  renderer.sortObjects = true;
  renderer.setTransparentSort(null);
  await readyFrames(renderer, scene, camera, 1);
  const defaults = await renderer.captureFrame(scene, camera);
  comparePixels(displayPixels(defaults), await renderReference(scene, camera));
  expect(displayPixels(custom)).not.toEqual(displayPixels(defaults));
  await saveBrowserEvidence('r187-transparent-sort', defaults);
  const empty = new THREE.Scene();
  for (const alpha of [0, 0.5, 1]) {
    renderer.setClearColor(0x336699, alpha);
    await readyFrames(renderer, empty, camera, 1);
    const clear = await renderer.captureFrame(empty, camera);
    const expected = await renderReference(empty, camera, {
      clearColor: 0x336699,
      clearAlpha: alpha,
    });
    await saveBrowserEvidence(`r187-clear-${alpha}`, clear, expected);
    comparePixels(displayPixels(clear), expected);
  }
  renderer.setClearColor(0, 0);
  geometry.dispose();
  red.dispose();
  blue.dispose();
});
