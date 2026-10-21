import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { comparePixels, displayPixels, readyFrames, SIZE, verifyReplay } from './render.fixture';

export async function verifyOutput(
  renderer: THREE.WebGPURenderer,
  oracle?: (
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    mode: THREE.ToneMapping,
    exposure: number,
  ) => Uint8Array | Promise<Uint8Array>,
  evidence?: (
    name: string,
    capture: THREE.ThreeFrameCapture,
    expected?: Uint8Array,
  ) => Promise<void>,
) {
  await renderer.init();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x274364);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  camera.updateMatrixWorld();
  const normal = new THREE.Mesh(
    new THREE.PlaneGeometry(1.2, 1.5),
    new THREE.MeshBasicMaterial({ color: 0x8080ff }),
  );
  normal.position.x = -1;
  const physical = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.5, 0.3),
    new THREE.MeshPhysicalMaterial({
      color: 0x50bb80,
      roughness: 0.7,
      clearcoat: 0.6,
      clearcoatRoughness: 0.4,
    }),
  );
  physical.position.x = 1;
  const untoned = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.4),
    new THREE.MeshBasicMaterial({
      color: 0xcc8040,
      toneMapped: false,
    }),
  );
  untoned.position.set(0, 1, 0);
  const overlay = new THREE.Mesh(
    new THREE.PlaneGeometry(3.3, 0.45),
    new THREE.MeshBasicMaterial({
      color: 0xf54284,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    }),
  );
  overlay.position.set(0, -0.4, 0.5);
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(0, 0, 5);
  scene.add(normal, physical, untoned, overlay, light);
  const pixelAt = (pixels: Uint8Array, x: number, y: number) => {
    const point = new THREE.Vector3(x, y, 0).project(camera);
    const column = Math.floor(((point.x + 1) * SIZE) / 2);
    const row = Math.floor(((1 - point.y) * SIZE) / 2);
    return Array.from(pixels.subarray((row * SIZE + column) * 4, (row * SIZE + column) * 4 + 4));
  };
  let baseline: Uint8Array | undefined;
  let previous: Uint8Array | undefined;
  for (const [mode, exposure] of [
    [THREE.NoToneMapping, 1],
    [THREE.ACESFilmicToneMapping, 1],
    [THREE.ACESFilmicToneMapping, 2],
    [THREE.ReinhardToneMapping, 1],
  ] as const) {
    renderer.toneMapping = mode;
    renderer.toneMappingExposure = exposure;
    await readyFrames(renderer, scene, camera);
    const frame = await renderer.captureFrame(scene, camera);
    const pixels = displayPixels(frame);
    const expected = await oracle?.(scene, camera, mode, exposure);
    await evidence?.(`mixed-${mode}-${exposure}`, frame, expected);
    if (expected !== undefined) comparePixels(pixels, expected);
    if (mode === THREE.NoToneMapping)
      expect(pixelAt(pixels, -1, 0.3)).toEqual([128, 128, 255, 255]);
    if (baseline === undefined) baseline = pixels;

    if (previous !== undefined) expect(pixels).not.toEqual(previous);
    previous = pixels;
    await verifyReplay(frame);
  }
  // Native Camera requires positive exposure. Keep this owner boundary explicit;
  // accepting zero would otherwise submit an invalid native Camera.
  renderer.toneMappingExposure = 0;
  expect(() => renderer.render(scene, camera)).toThrow('Zero exposure requires native Camera');
  renderer.toneMappingExposure = 1;
  // r184 WebGPU applies output conversion to the completed frame; toneMapped is ignored.
  const before = displayPixels(await renderer.captureFrame(scene, camera));
  untoned.material.toneMapped = true;
  await readyFrames(renderer, scene, camera);
  const after = displayPixels(await renderer.captureFrame(scene, camera));
  expect(pixelAt(after, 0, 1)).toEqual(pixelAt(before, 0, 1));
  expect(pixelAt(after, -1, 0.3)).toEqual(pixelAt(before, -1, 0.3));
  if (oracle !== undefined)
    comparePixels(
      after,
      await oracle(scene, camera, renderer.toneMapping, renderer.toneMappingExposure),
    );
  for (const mesh of [normal, physical, untoned, overlay]) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}
