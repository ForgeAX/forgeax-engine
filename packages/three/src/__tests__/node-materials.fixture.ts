import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

export async function verifyNodeMaterials(
  renderer: THREE.WebGPURenderer,
  evidence: (
    name: string,
    capture: THREE.ThreeFrameCapture,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => Promise<void>,
) {
  expect(await renderer.init()).toBe(renderer);
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.BoxGeometry(1, 1.3, 0.6);
  const basic = new THREE.MeshBasicNodeMaterial({ color: 0xe54735 });
  const standard = new THREE.MeshStandardNodeMaterial({
    color: 0x4466dd,
    metalness: 0.15,
    roughness: 0.55,
  });
  const physical = new THREE.MeshPhysicalNodeMaterial({
    color: 0x44bb55,
    metalness: 0.1,
    roughness: 0.4,
    clearcoat: 0.5,
    clearcoatRoughness: 0.25,
  });
  const materials = [basic, standard, physical];
  for (const [index, material] of materials.entries()) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = (index - 1) * 1.35;
    scene.add(mesh);
  }
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(1, 2, 4);
  scene.add(light, new THREE.AmbientLight(0xffffff, 0.35));
  const texture = new THREE.DataTexture(
    new Uint8Array([255, 64, 255, 255, 64, 255, 128, 255, 128, 64, 255, 255, 255, 255, 128, 255]),
    2,
    2,
  );
  texture.needsUpdate = true;
  const capture = async (name: string) => {
    await readyFrames(renderer, scene, camera, 1);
    const frame = await renderer.captureFrame(scene, camera);
    await evidence(name, frame, scene, camera);
    return frame;
  };
  try {
    await readyFrames(renderer, scene, camera, 60);
    const first = await capture('ordinary');
    basic.color.setHex(0x3388ff);
    standard.roughness = 0.8;
    physical.clearcoat = 0.9;
    for (const material of materials) material.map = texture;
    const textured = await capture('textured-edited');
    expect(equalBytes(displayPixels(textured), displayPixels(first))).toBe(false);
    for (const material of materials) {
      material.transparent = true;
      material.opacity = 0.6;
      material.depthWrite = false;
    }
    const transparent = await capture('transparent');
    expect(equalBytes(displayPixels(transparent), displayPixels(textured))).toBe(false);
    const receipt = renderer.inspect().receipt;
    basic.colorNode = new THREE.ConstNode<'float', number>(1, 'float');
    expect(() => renderer.render(scene, camera)).toThrow('NodeMaterial.colorNode');
    expect(renderer.inspect().receipt).toBe(receipt);
    basic.colorNode = null;
    const restored = await capture('restored');
    expect(equalBytes(displayPixels(restored), displayPixels(transparent))).toBe(true);
    await verifyReplay(restored, 'r187-node-materials');
  } finally {
    geometry.dispose();
    texture.dispose();
    for (const material of materials) material.dispose();
  }
}
