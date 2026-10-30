import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { comparePixels, displayPixels, readyFrames, verifyReplay } from './render.fixture';

export async function verifyFlatShading(
  renderer: THREE.WebGPURenderer,
  oracle?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<Uint8Array>,
  evidence?: (
    name: string,
    capture: THREE.ThreeFrameCapture,
    expected?: Uint8Array,
  ) => Promise<void>,
) {
  const scene = new THREE.Scene();
  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  orthographic.position.z = 3;
  const perspective = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
  perspective.position.z = 3;
  let camera: THREE.Camera = orthographic;
  const geometry = new THREE.SphereGeometry(0.72, 8, 5);
  const missing = geometry.clone().deleteAttribute('normal');
  const map = new THREE.DataTexture(
    new Uint8Array([190, 130, 90, 255, 80, 140, 200, 255, 120, 180, 100, 255, 210, 180, 100, 255]),
    2,
    2,
  );
  map.needsUpdate = true;
  const materials = [
    new THREE.MeshLambertMaterial({ map }),
    new THREE.MeshStandardMaterial({ map, roughness: 0.25, metalness: 0.2 }),
    new THREE.MeshPhysicalMaterial({
      map,
      roughness: 0.25,
      metalness: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
    }),
  ];
  const mesh = new THREE.Mesh(geometry, materials[0]);
  mesh.rotation.set(0.2, 0.35, 0.1);
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(1, 2, 3);
  scene.add(mesh, light, new THREE.AmbientLight(0xffffff, 0.4));
  const frame = async (name: string) => {
    await readyFrames(renderer, scene, camera);
    const capture = await renderer.captureFrame(scene, camera);
    const expected = await oracle?.(scene, camera);
    await evidence?.(`flat-${name}`, capture, expected);
    const pixels = displayPixels(capture);
    if (expected !== undefined) comparePixels(pixels, expected);
    expect(pixels.some((value, index) => index % 4 !== 3 && value > 80)).toBe(true);
    return { pixels, capture };
  };
  await renderer.init();
  try {
    await readyFrames(renderer, scene, camera, 60);
    for (const material of materials) {
      mesh.material = material;
      mesh.geometry = geometry;
      const smooth = await frame(`${material.type}-smooth`);
      material.flatShading = true;
      material.needsUpdate = true;
      const flat = await frame(`${material.type}-explicit`);
      expect(equalBytes(flat.pixels, smooth.pixels)).toBe(false);
      material.flatShading = false;
      material.needsUpdate = true;
      mesh.geometry = missing;
      expect(equalBytes((await frame(`${material.type}-missing-normal`)).pixels, flat.pixels)).toBe(
        true,
      );
      expect(missing.hasAttribute('normal')).toBe(false);
      mesh.geometry = geometry;
      mesh.position.x = -0.48;
      mesh.scale.set(0.6, 0.85, 0.7);
      const other = new THREE.Mesh(missing, material);
      other.position.x = 0.48;
      other.rotation.copy(mesh.rotation);
      other.scale.copy(mesh.scale);
      scene.add(other);
      const shared = await frame(`${material.type}-shared`);
      await verifyReplay(shared.capture);
      material.dispose();
      expect(
        equalBytes((await frame(`${material.type}-dispose-reuse`)).pixels, shared.pixels),
      ).toBe(true);
      scene.remove(other);
      mesh.position.x = 0;
      mesh.scale.set(-1, 0.8, 1.2);
      material.flatShading = true;
      for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
        material.side = side;
        material.needsUpdate = true;
        await frame(`${material.type}-mirrored-side-${side}`);
      }
      material.side = THREE.FrontSide;
      material.flatShading = false;
      material.needsUpdate = true;
      mesh.scale.setScalar(1);
      expect(equalBytes((await frame(`${material.type}-restored`)).pixels, smooth.pixels)).toBe(
        true,
      );
      orthographic.position.set(0.7, 0.4, 3);
      orthographic.lookAt(0, 0, 0);
      await frame(`${material.type}-rotated-orthographic`);
      orthographic.position.set(0, 0, 3);
      orthographic.quaternion.identity();
      camera = perspective;
      await frame(`${material.type}-perspective`);
      camera = orthographic;
    }
  } finally {
    for (const material of materials) material.dispose();
    geometry.dispose();
    missing.dispose();
    map.dispose();
  }
}
