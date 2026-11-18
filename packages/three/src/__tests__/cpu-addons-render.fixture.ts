import * as THREE from '@forgeax/engine/three';
import { createMeshesFromInstancedMesh } from '@forgeax/engine/three/addons/utils/SceneUtils.js';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { addonGeometries } from './cpu-addons.fixture';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';

type Evidence = (
  name: string,
  frame: THREE.ThreeFrameCapture,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
) => Promise<void>;
export async function verifyAddonGallery(renderer: THREE.WebGPURenderer, evidence: Evidence) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 6;
  const geometries = addonGeometries(),
    materials: THREE.Material[] = [];
  let first: THREE.Mesh | undefined;
  Object.entries(geometries).forEach(([name, geometry], i) => {
    const material =
      name === 'lines'
        ? new THREE.LineBasicMaterial({ color: 0x44ccdd })
        : name === 'points'
          ? new THREE.PointsMaterial({ vertexColors: true })
          : new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0x22cc44 : 0x3366dd });
    materials.push(material);
    const object =
      name === 'lines'
        ? new THREE.LineSegments(geometry, material)
        : name === 'points'
          ? new THREE.Points(geometry, material)
          : new THREE.Mesh(geometry, material);
    if (i === 0 && object instanceof THREE.Mesh) first = object;
    object.name = name;
    object.position.set(((i % 4) - 1.5) * 1.2, i < 4 ? 0.75 : -0.75, 0);
    scene.add(object);
  });
  try {
    await readyFrames(renderer, scene, camera, 60);
    const initial = await renderer.captureFrame(scene, camera);
    expect(displayPixels(initial).filter((v, i) => i % 4 === 3 && v > 0).length).toBeGreaterThan(
      500,
    );
    verifyPointPixels(scene, camera, displayPixels(initial));
    await evidence('gallery-initial', initial, scene, camera);
    const selected = first;
    if (selected === undefined) throw Error('missing rounded mesh');
    (selected.material as THREE.MeshBasicMaterial).color.setHex(0xdd3344);
    const position = geometries.parametric.getAttribute('position');
    position.setZ(0, position.getZ(0) + 0.4);
    position.needsUpdate = true;
    const edited = await renderer.captureFrame(scene, camera);
    expect(equalBytes(displayPixels(initial), displayPixels(edited))).toBe(false);
    await evidence('gallery-edited', edited, scene, camera);
    await verifyReplay(edited, 'r187-cpu-addon-gallery');
  } finally {
    for (const g of Object.values(geometries)) g.dispose();
    for (const m of materials) m.dispose();
  }
}
export async function verifySceneDecomposition(renderer: THREE.WebGPURenderer, evidence: Evidence) {
  await renderer.init();
  const geometry = new THREE.BoxGeometry(0.9, 0.9, 0.7),
    material = new THREE.MeshBasicMaterial({ color: 0x22cc44 }),
    instanced = new THREE.InstancedMesh(geometry, material, 2);
  instanced.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-0.8, 0, 0));
  instanced.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0.8, 0, 0));
  const group = createMeshesFromInstancedMesh(instanced),
    scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  scene.add(group);
  try {
    await readyFrames(renderer, scene, camera, 60);
    const frame = await renderer.captureFrame(scene, camera);
    expect(displayPixels(frame).filter((v, i) => i % 4 === 1 && v > 80).length).toBeGreaterThan(
      200,
    );
    await evidence('decomposed-instances', frame, scene, camera);
    await verifyReplay(frame, 'r187-addon-scene-decomposition');
  } finally {
    instanced.dispose();
    geometry.dispose();
    material.dispose();
  }
}

function verifyPointPixels(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  pixels: Uint8Array,
): void {
  const points = scene.getObjectByName('points');
  if (!(points instanceof THREE.Points)) throw Error('missing parsed points');
  const position = points.geometry.getAttribute('position'),
    projected = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    projected.fromBufferAttribute(position, i).applyMatrix4(points.matrixWorld).project(camera);
    const x = Math.floor((projected.x * 0.5 + 0.5) * 128),
      y = Math.floor((0.5 - projected.y * 0.5) * 128);
    let covered = false;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if ((pixels[((y + dy) * 128 + x + dx) * 4 + 3] ?? 0) > 0) covered = true;
    expect(covered, `parsed point ${i} is visible at its projected position`).toBe(true);
  }
}
