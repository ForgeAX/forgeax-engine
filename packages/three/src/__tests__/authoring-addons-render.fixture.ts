import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { authoringGeometries } from './authoring-addons.fixture';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';
export async function verifyAuthoringGallery(
  renderer: THREE.WebGPURenderer,
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
  camera.position.z = 7;
  const geometries = await authoringGeometries(),
    materials: THREE.MeshBasicMaterial[] = [];
  Object.values(geometries).forEach((geometry, i) => {
    const material = new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0x22cc44 : 0x3366dd });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(((i % 4) - 1.5) * 1.4, i < 4 ? 0.8 : -0.8, 0);
    scene.add(mesh);
  });
  const capture = async (phase: string) => {
    const frame = await renderer.captureFrame(scene, camera);
    await evidence(phase, frame, scene, camera);
    return frame;
  };
  try {
    await readyFrames(renderer, scene, camera, 60);
    const initial = await capture('initial');
    verifyGalleryCells(displayPixels(initial));
    expect(displayPixels(initial).filter((v, i) => i % 4 === 3 && v > 0).length).toBeGreaterThan(
      500,
    );
    for (const material of materials) material.color.setHex(0xdd3344);
    const edited = await capture('edited');
    expect(equalBytes(displayPixels(initial), displayPixels(edited))).toBe(false);
    await verifyReplay(edited, 'r187-authoring-addon-gallery');
  } finally {
    for (const geometry of Object.values(geometries)) geometry.dispose();
    for (const material of materials) material.dispose();
  }
}

function verifyGalleryCells(pixels: Uint8Array): void {
  for (let i = 0; i < 7; i++) {
    const centerX = Math.floor(
      (((((i % 4) - 1.5) * 1.4) / (7 * Math.tan((50 * Math.PI) / 360))) * 0.5 + 0.5) * 128,
    );
    const centerY = Math.floor(
      (0.5 - ((i < 4 ? 0.8 : -0.8) / (7 * Math.tan((50 * Math.PI) / 360))) * 0.5) * 128,
    );
    let covered = 0;
    for (let y = centerY - 8; y <= centerY + 8; y++)
      for (let x = centerX - 8; x <= centerX + 8; x++)
        if ((pixels[(y * 128 + x) * 4 + 3] ?? 0) > 0) covered++;
    expect(covered, `authoring geometry ${i} is visible in its own cell`).toBeGreaterThan(20);
  }
}
