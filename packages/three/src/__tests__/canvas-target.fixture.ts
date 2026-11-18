import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { displayPixels, readyFrames, testScene, verifyReplay } from './render.fixture';

export async function verifyCanvasTarget(
  renderer: THREE.WebGPURenderer,
  evidence: (
    name: string,
    capture: THREE.ThreeFrameCapture,
    size: number,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
) {
  const { scene, camera, mesh, material } = testScene();
  const initial = renderer.getCanvasTarget();
  expect(initial).toBeInstanceOf(THREE.CanvasTarget);
  expect(initial.domElement).toBe(renderer.domElement);
  const size = new THREE.Vector2(),
    rectangle = new THREE.Vector4();
  const check = async (name: string, physical: number, frames = 1) => {
    await readyFrames(renderer, scene, camera, frames);
    const capture = await renderer.captureFrame(scene, camera);
    expect(renderer.getDrawingBufferSize(size).toArray()).toEqual([physical, physical]);
    expect(displayPixels(capture).length).toBe(physical * physical * 4);
    await evidence(name, capture, physical, scene, camera);
    return capture;
  };
  try {
    await check('initial', 128, 60);
    initial.setDrawingBufferSize(64, 64, 2);
    initial.setScissor(0, 0, 64, 64);
    initial.setScissorTest(true);
    expect(renderer.getSize(size).toArray()).toEqual([64, 64]);
    expect(renderer.getPixelRatio()).toBe(2);
    expect(renderer.getViewport(rectangle).toArray()).toEqual([0, 0, 64, 64]);
    expect(renderer.getScissorTest()).toBe(true);
    await check('direct-target-dpr', 128);
    renderer.setScissorTest(false);
    renderer.setPixelRatio(1);
    expect(initial.getPixelRatio()).toBe(1);
    const small = await check('resized', 64);
    await verifyReplay(small, 'r187-canvas-small', { width: 64, height: 64 });
    const replacement = new THREE.CanvasTarget(renderer.domElement);
    replacement.setDrawingBufferSize(128, 128, 1);
    renderer.setCanvasTarget(replacement);
    expect(renderer.getCanvasTarget()).toBe(replacement);
    renderer.setSize(128, 128, false);
    expect(replacement.getSize(size).toArray()).toEqual([128, 128]);
    const last = await check('replacement', 128);
    await verifyReplay(last, 'r187-canvas-replacement');
    const receipt = renderer.inspect().receipt;
    replacement.setViewport(1, 0, 127, 128);
    expect(() => renderer.render(scene, camera)).toThrow('Partial viewport');
    expect(() => renderer.clear()).toThrow('Partial viewport');
    replacement.setViewport(0, 0, 128, 128, 0.2, 0.8);
    expect(() => renderer.render(scene, camera)).toThrow('depth ranges');
    replacement.setViewport(0, 0, 128, 128);
    replacement.setScissor(0, 0, 64, 64);
    replacement.setScissorTest(true);
    expect(() => renderer.render(scene, camera)).toThrow('Partial scissor');
    replacement.setScissorTest(false);
    expect(renderer.inspect().receipt).toBe(receipt);
    material.map = replacement.colorTexture;
    expect(() => renderer.render(scene, camera)).toThrow('Texture shape/source kind');
    material.map = null;
    replacement.setDrawingBufferSize(128, 128, Number.NaN);
    expect(() => renderer.render(scene, camera)).toThrow('size/pixelRatio');
    replacement.setDrawingBufferSize(128, 128, 1);
    await check('restored', 128);
  } finally {
    mesh.geometry.dispose();
    material.dispose();
  }
}
