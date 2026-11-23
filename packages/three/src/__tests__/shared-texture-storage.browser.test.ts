import * as THREE from '@forgeax/engine/three';
import { expect, it, vi } from 'vitest';
import { browserRendererFixture, displayPixels, readyFrames, SIZE } from './render.fixture';

const rendererFor = browserRendererFixture();

it('uploads shared storage once and draws each clone at its own accepted version', {
  timeout: 120000,
}, async () => {
  const renderer = rendererFor();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const edge = 1024;
  const data = new Uint8Array(edge * edge * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 3] = 255;
  }
  const a = new THREE.DataTexture(data, edge, edge);
  a.needsUpdate = true;
  const b = a.clone();
  b.wrapS = THREE.RepeatWrapping;
  const geometry = new THREE.PlaneGeometry(0.85, 1.3);
  const materials = [a, b].map((map) => new THREE.MeshBasicMaterial({ map }));
  for (const [i, material] of materials.entries()) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = i - 0.5;
    scene.add(mesh);
  }
  let copies = 0;
  const write = GPUQueue.prototype.writeTexture;
  const spy = vi.spyOn(GPUQueue.prototype, 'writeTexture').mockImplementation(function (
    this: GPUQueue,
    destination,
    source,
    layout,
    extent,
  ) {
    if (source.byteLength === data.byteLength) copies++;
    return write.call(this, destination, source, layout, extent);
  });
  const pixel = (image: Uint8Array, x: number) => {
    const at = (SIZE * (SIZE / 2) + x) * 4;
    return [...image.subarray(at, at + 3)];
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    expect(copies).toBe(1);

    for (let i = 0; i < data.length; i += 4) {
      data[i] = 0;
      data[i + 1] = 255;
    }
    a.needsUpdate = true;
    await readyFrames(renderer, scene, camera);
    expect(copies).toBe(2);
    const split = displayPixels(await renderer.captureFrame(scene, camera));
    expect(pixel(split, SIZE / 4)).toEqual([0, 255, 0]);
    expect(pixel(split, (SIZE * 3) / 4)).toEqual([255, 0, 0]);
    const counted = copies;

    b.needsUpdate = true;
    await readyFrames(renderer, scene, camera);
    expect(copies).toBe(counted);
    const merged = displayPixels(await renderer.captureFrame(scene, camera));
    expect(pixel(merged, SIZE / 4)).toEqual([0, 255, 0]);
    expect(pixel(merged, (SIZE * 3) / 4)).toEqual([0, 255, 0]);
  } finally {
    spy.mockRestore();
    a.dispose();
    b.dispose();
    geometry.dispose();
    for (const material of materials) material.dispose();
  }
});
