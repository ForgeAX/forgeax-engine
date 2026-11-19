import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

export const pointColorModes = ['rgb', 'rgba', 'node-normalized'] as const;
export type PointColorMode = (typeof pointColorModes)[number];
export async function verifyPointColors(
  renderer: THREE.WebGPURenderer,
  mode: PointColorMode,
  evidence: (
    name: string,
    frame: THREE.ThreeFrameCapture,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 3;
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.7, 0, 0),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.7, 0, 0),
  ]);
  const colors =
    mode === 'rgba'
      ? new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 1, 0, 0.5, 0, 0, 1, 0.25], 4)
      : mode === 'node-normalized'
        ? new THREE.Uint8BufferAttribute([255, 0, 0, 0, 255, 0, 0, 0, 255], 3, true)
        : new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3);
  geometry.setAttribute('color', colors);
  const material =
    mode === 'node-normalized' ? new THREE.PointsNodeMaterial() : new THREE.PointsMaterial();
  Object.assign(material, {
    size: 1,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: mode === 'rgba',
  });
  if (material instanceof THREE.PointsNodeMaterial)
    material.colorNode = THREE.TSL.uniform(new THREE.Color(1, 1, 1));
  const points = new THREE.Points(geometry, material);
  scene.add(points);
  const capture = async (phase: string) => {
    const frame = await renderer.captureFrame(scene, camera);
    await evidence(`${mode}-${phase}`, frame, scene, camera);
    return frame;
  };
  try {
    await readyFrames(renderer, scene, camera, 60);
    const initial = await capture('initial');
    for (let point = 0; point < 3; point++) {
      const position = new THREE.Vector3()
        .fromBufferAttribute(geometry.getAttribute('position'), point)
        .project(camera);
      const x = Math.floor((position.x * 0.5 + 0.5) * 128),
        y = 64;
      const pixels = displayPixels(initial);
      let colored = false;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const offset = ((y + dy) * 128 + x + dx) * 4;
          colored ||=
            (pixels[offset + point] ?? 0) > 40 && (pixels[offset + ((point + 1) % 3)] ?? 255) < 5;
        }
      expect(colored, `point ${point} retains its RGB channel at its projected location`).toBe(
        true,
      );
    }
    colors.setXYZ(0, 0, 0, 1);
    colors.needsUpdate = true;
    const edited = await capture('edited');
    expect(equalBytes(displayPixels(initial), displayPixels(edited))).toBe(false);
    material.vertexColors = false;
    material.needsUpdate = true;
    const disabled = await capture('disabled');
    expect(equalBytes(displayPixels(edited), displayPixels(disabled))).toBe(false);
    await verifyReplay(disabled, `r187-point-colors-${mode}`);
  } finally {
    geometry.dispose();
    material.dispose();
  }
}
