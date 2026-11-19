import * as THREE from '@forgeax/engine/three';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { saveBrowserBytes } from './browser-evidence.fixture';
import { browserRendererFixture } from './render.fixture';

const rendererOf = browserRendererFixture();

it('updates Basic vertex colors in a completed native target capture', {
  timeout: 120000,
}, async () => {
  const renderer = rendererOf();
  await renderer.init();
  const target = new THREE.RenderTarget(32, 32, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
  });
  const geometry = new THREE.PlaneGeometry(8, 8);
  const material = new THREE.MeshBasicMaterial();
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  try {
    renderer.setRenderTarget(target);
    await renderer.renderAsync(scene, camera);
    const values = new Float32Array(12);
    for (let vertex = 0; vertex < 4; vertex++) values.set([0.25, 0.5, 0.75], vertex * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
    material.vertexColors = true;
    material.needsUpdate = true;
    const recorder = Reflect.get(renderer, 'recorder') as RecorderAttachment;
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    try {
      await renderer.renderAsync(scene, camera);
    } finally {
      (await recorder.frameBoundary()).unwrap();
      const capture = await pending;
      if (capture.ok) await saveBrowserBytes('target-vertex-colors.rhitape', capture.value.bytes);
    }
    const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 32);
    const pixel = [0, 1, 2].map((channel) =>
      THREE.DataUtils.fromHalfFloat(raw[(16 * 32 + 16) * 4 + channel] ?? 0),
    );
    await commands.writeFile(
      'artifacts/three-compat/target-vertex-colors.json',
      JSON.stringify({ pixel }),
    );
    [0.25, 0.5, 0.75].forEach((expected, channel) => {
      expect(pixel[channel]).toBeCloseTo(expected, 2);
    });
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    geometry.dispose();
    material.dispose();
  }
});
