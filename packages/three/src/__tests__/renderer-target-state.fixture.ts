import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, testScene, verifyReplay } from './render.fixture';
export async function verifyDefaultTargetState(
  renderer: THREE.WebGPURenderer,
  evidence: (
    name: string,
    frame: THREE.ThreeFrameCapture,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
) {
  const s = testScene();
  const rejectedTarget = new THREE.RenderTarget(16, 16);
  try {
    await renderer.init();
    await readyFrames(renderer, s.scene, s.camera, 60);
    const before = await renderer.captureFrame(s.scene, s.camera);
    renderer.setRenderTarget(null, 3, 4);
    expect(renderer.getActiveCubeFace()).toBe(3);
    expect(renderer.getActiveMipmapLevel()).toBe(4);
    const state = THREE.RendererUtils.resetRendererState(renderer);
    // The original reset helper preserves the target selection until the caller changes it.
    expect(renderer.getActiveCubeFace()).toBe(3);
    expect(renderer.getActiveMipmapLevel()).toBe(4);
    renderer.setRenderTarget(null);
    expect(renderer.getActiveCubeFace()).toBe(0);
    expect(renderer.getActiveMipmapLevel()).toBe(0);
    THREE.RendererUtils.restoreRendererState(renderer, state);
    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.getActiveCubeFace()).toBe(3);
    expect(renderer.getActiveMipmapLevel()).toBe(4);
    const target: THREE.RenderTarget | null = rejectedTarget;
    expect(() => renderer.setRenderTarget(target)).toThrow('three-unsupported');
    for (const [face, mip] of [
      [-1, 0],
      [6, 0],
      [0, -1],
      [0, 0.5],
      [NaN, 0],
    ])
      expect(() => renderer.setRenderTarget(null, face, mip)).toThrow('three-invalid-value');
    expect(renderer.getActiveCubeFace()).toBe(3);
    expect(renderer.getActiveMipmapLevel()).toBe(4);
    const after = await renderer.captureFrame(s.scene, s.camera);
    expect(equalBytes(displayPixels(before), displayPixels(after))).toBe(true);
    await evidence('default-target-state', after, s.scene, s.camera);
    await verifyReplay(after, 'r187-default-target-state');
    renderer.setRenderTarget(null);
    expect(renderer.getActiveCubeFace()).toBe(0);
    expect(renderer.getActiveMipmapLevel()).toBe(0);
  } finally {
    rejectedTarget.dispose();
    s.mesh.geometry.dispose();
    s.material.dispose();
  }
}
