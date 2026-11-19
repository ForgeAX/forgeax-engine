import * as THREE from '@forgeax/engine/three';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';
import { targetSurfaceExample } from './target-surface.recipe.fixture';

/** Exercise the combined target owner, cooked Surface and ordinary-map route. */
export async function verifyTargetSurface(
  renderer: THREE.WebGPURenderer,
  recipe: THREE.ThreeSurfaceRecipe,
  evidence: (name: string, capture: THREE.ThreeFrameCapture) => Promise<void>,
  targetEvidence: (tape: Uint8Array) => Promise<void>,
) {
  const options = { type: THREE.HalfFloatType, generateMipmaps: false } as const;
  const input = new THREE.RenderTarget(32, 32, options);
  const output = new THREE.RenderTarget(32, 32, options);
  const example = targetSurfaceExample();
  example.material.map = input.texture;
  THREE.bindThreeSurface(example.material, recipe).unwrap();
  const geometry = new THREE.PlaneGeometry(8, 8);
  const sourceMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.5, 0.75) });
  const displayMaterial = new THREE.MeshBasicMaterial({ map: output.texture });
  const source = new THREE.Scene();
  source.add(new THREE.Mesh(geometry, sourceMaterial));
  const middle = new THREE.Scene();
  middle.add(new THREE.Mesh(geometry, example.material));
  const display = new THREE.Scene();
  display.add(new THREE.Mesh(geometry, displayMaterial));
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const write = async () => {
    renderer.setRenderTarget(output);
    await renderer.renderAsync(middle, camera);
    renderer.setRenderTarget(null);
    await readyFrames(renderer, display, camera, 1);
  };
  try {
    await renderer.init();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(input);
    await renderer.renderAsync(source, camera);
    const recorder = Reflect.get(renderer, 'recorder') as RecorderAttachment;
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    try {
      await write();
    } finally {
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pending).unwrap();
      await targetEvidence(captured.bytes);
    }
    for (let frame = 0; frame < 60; frame++) {
      renderer.setRenderTarget(input);
      await renderer.renderAsync(source, camera);
      await write();
    }
    const first = await renderer.captureFrame(display, camera);
    await evidence('target-surface-initial', first);
    const raw = await renderer.readRenderTargetPixelsAsync(output, 0, 0, 32, 32);
    expect(raw).toBeInstanceOf(Uint16Array);
    [0.25, 0.5, 0.75].forEach((expected, channel) => {
      expect(THREE.DataUtils.fromHalfFloat(raw[(16 * 32 + 16) * 4 + channel] ?? 0)).toBeCloseTo(
        expected,
        2,
      );
    });
    example.threshold.value = 3;
    await write();
    const clipped = await renderer.captureFrame(display, camera);
    await evidence('target-surface-clipped', clipped);
    const center = (64 * 128 + 64) * 4;
    expect(Array.from(displayPixels(clipped).subarray(center, center + 3))).toEqual([0, 0, 0]);
    example.threshold.value = 0;
    output.setSize(16, 16);
    await write();
    output.dispose();
    await write();
    const restored = await renderer.captureFrame(display, camera);
    await evidence('target-surface-restored', restored);
    expect(equalBytes(displayPixels(restored), displayPixels(first))).toBe(true);
    await verifyReplay(restored, 'three-target-surface');
  } finally {
    renderer.setRenderTarget(null);
    input.dispose();
    output.dispose();
    geometry.dispose();
    sourceMaterial.dispose();
    displayMaterial.dispose();
    example.material.dispose();
    example.map.dispose();
  }
}
