import * as THREE from '@forgeax/engine/three';
import { expect, it, vi } from 'vitest';
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();

it('uploads the latest shared Canvas version on re-entry and keeps unmarked painting private', {
  timeout: 120000,
}, async () => {
  THREE.enableThreeSourceTracking();
  const renderer = rendererFor();
  const canvas = document.createElement('canvas');
  canvas.width = 47;
  canvas.height = 31;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Missing Canvas 2D');
  const paint = (top: string, bottom: string) => {
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, canvas.width, 15);
    ctx.fillStyle = bottom;
    ctx.fillRect(0, 15, canvas.width, canvas.height - 15);
  };
  paint('#653aac', '#39bd47');
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map });
  const geometry = new THREE.PlaneGeometry(1.5, 1.5);
  const first = new THREE.Mesh(geometry, material);
  const second = new THREE.Mesh(geometry, material);
  second.position.x = 10;
  const scene = new THREE.Scene();
  scene.add(first, second);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  let nativeCopies = 0;
  const copy = GPUQueue.prototype.copyExternalImageToTexture;
  const copies = vi
    .spyOn(GPUQueue.prototype, 'copyExternalImageToTexture')
    .mockImplementation(function (this: GPUQueue, src, target, size) {
      const { source } = src;
      if (source instanceof VideoFrame && source.displayWidth === 47 && source.displayHeight === 31)
        nativeCopies++;
      return copy.call(this, src, target, size);
    });
  const offscreen = vi.spyOn(OffscreenCanvasRenderingContext2D.prototype, 'getImageData');
  const dom = vi.spyOn(CanvasRenderingContext2D.prototype, 'getImageData');
  const readbackCount = () =>
    [...offscreen.mock.calls, ...dom.mock.calls].filter(
      ([, , width, height]) => width === 47 && height === 31,
    ).length;
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    expect(nativeCopies).toBe(1);
    expect(readbackCount()).toBe(0);

    camera.position.x = 25;
    paint('#c66527', '#1863e1');
    map.needsUpdate = true;
    await readyFrames(renderer, scene, camera);
    expect(nativeCopies).toBe(1);

    camera.position.x = 10;
    await readyFrames(renderer, scene, camera);
    expect(nativeCopies).toBe(2);
    expect(readbackCount()).toBe(0);

    camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
    camera.updateProjectionMatrix();
    const native = displayPixels(await renderer.captureFrame(scene, camera));
    comparePixels(native, await renderReference(scene, camera), 3 / 255);
    paint('#fafafa', '#fafafa');
    map.colorSpace = THREE.NoColorSpace;
    await readyFrames(renderer, scene, camera);
    expect(displayPixels(await renderer.captureFrame(scene, camera))).toEqual(native);

    // Switching to a linear Canvas leaves the previous dynamic source route.
    map.needsUpdate = true;
    offscreen.mockClear();
    dom.mockClear();
    await readyFrames(renderer, scene, camera);
    expect(readbackCount()).toBeGreaterThan(0);
  } finally {
    copies.mockRestore();
    offscreen.mockRestore();
    dom.mockRestore();
    map.dispose();
    material.dispose();
    geometry.dispose();
  }
});
