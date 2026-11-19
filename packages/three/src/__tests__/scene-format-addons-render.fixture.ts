import * as THREE from '@forgeax/engine/three';
import { AnimationPathHelper } from '@forgeax/engine/three/addons/helpers/AnimationPathHelper.js';
import { GCodeLoader } from '@forgeax/engine/three/addons/loaders/GCodeLoader.js';
import { TDSLoader } from '@forgeax/engine/three/addons/loaders/TDSLoader.js';
import { buildMesh, VOXLoader } from '@forgeax/engine/three/addons/loaders/VOXLoader.js';
import { VRMLLoader } from '@forgeax/engine/three/addons/loaders/VRMLLoader.js';
import { SceneOptimizer } from '@forgeax/engine/three/addons/utils/SceneOptimizer.js';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';
import { gcode, tds, vox, vrml } from './scene-format-addons.fixture';
export type SceneEvidence = (
  name: string,
  frame: THREE.ThreeFrameCapture,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
) => Promise<void>;
export function disposeScene(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Line ||
      object instanceof THREE.Points
    ) {
      object.geometry.dispose();
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const m of list) m.dispose();
      if (object instanceof THREE.BatchedMesh) object.dispose();
    }
  });
}
export function supportedMaterials(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const previous = Array.isArray(o.material) ? o.material : [o.material];
      o.material = new THREE.MeshBasicMaterial({
        color: 0x22cc44,
        vertexColors: o.geometry.hasAttribute('color'),
        side: THREE.DoubleSide,
      });
      for (const m of previous) m.dispose();
    }
  });
  return root;
}
export async function verifyLegacySceneGallery(
  renderer: THREE.WebGPURenderer,
  evidence: SceneEvidence,
) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 6;
  const voxel = new VOXLoader().parse(vox()),
    chunk = voxel?.chunks[0];
  if (chunk === undefined) throw Error('missing VOX');
  const mesh = buildMesh(chunk);
  if (voxel?.scene) disposeScene(voxel.scene);
  const groups = [
    supportedMaterials(new TDSLoader().parse(tds(), '')),
    supportedMaterials(new VRMLLoader().parse(vrml, '')),
    supportedMaterials(mesh),
    new GCodeLoader().parse(gcode),
  ];
  groups.forEach((o, i) => {
    o.position.x = (i - 1.5) * 1.2;
    if (i === 3) o.scale.setScalar(0.7);
    scene.add(o);
  });
  try {
    await readyFrames(renderer, scene, camera, 60);
    const initial = await renderer.captureFrame(scene, camera);
    await evidence('legacy-initial', initial, scene, camera);
    expect(displayPixels(initial).filter((v, i) => i % 4 === 3 && v > 0).length).toBeGreaterThan(
      300,
    );
    const pixels = displayPixels(initial);
    for (const [left, right] of [
      [10, 34],
      [36, 61],
      [63, 89],
      [91, 118],
    ]) {
      let visible = 0;
      for (let y = 0; y < 128; y++)
        for (let x = left ?? 0; x < (right ?? 0); x++)
          if ((pixels[(y * 128 + x) * 4 + 3] ?? 0) > 0) visible++;
      expect(visible).toBeGreaterThan(10);
    }
    groups[0]?.position.setY(0.5);
    const edited = await renderer.captureFrame(scene, camera);
    await evidence('legacy-edited', edited, scene, camera);
    expect(equalBytes(displayPixels(initial), displayPixels(edited))).toBe(false);
    await verifyReplay(edited, 'r187-legacy-scene-gallery');
  } finally {
    for (const root of groups) disposeScene(root);
  }
}
export async function verifyStaticBatching(
  renderer: THREE.WebGPURenderer,
  evidence: SceneEvidence,
) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new THREE.BoxGeometry(1, 1, 0.7),
    material = new THREE.MeshBasicMaterial({ color: 0x22cc44 });
  for (const x of [-0.8, 0.8]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = x;
    scene.add(mesh);
  }
  try {
    await readyFrames(renderer, scene, camera, 60);
    const before = await renderer.captureFrame(scene, camera);
    new SceneOptimizer(scene).toBatchedMesh();
    await readyFrames(renderer, scene, camera, 60);
    const after = await renderer.captureFrame(scene, camera);
    expect(equalBytes(displayPixels(before), displayPixels(after))).toBe(true);
    await evidence('batched', after, scene, camera);
    await verifyReplay(after, 'r187-static-batched-scene');
  } finally {
    disposeScene(scene);
  }
}
export async function verifyAnimationPath(renderer: THREE.WebGPURenderer, evidence: SceneEvidence) {
  await renderer.init();
  const scene = new THREE.Scene(),
    object = new THREE.Object3D();
  object.name = 'Ball';
  scene.add(object);
  const clip = new THREE.AnimationClip('path', 1, [
      new THREE.VectorKeyframeTrack(`${object.uuid}.position`, [0, 1], [-1, 0, 0, 1, 0, 0]),
    ]),
    helper = new AnimationPathHelper(scene, clip, object, { divisions: 8 }),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  scene.add(helper);
  try {
    await readyFrames(renderer, scene, camera, 60);
    const frame = await renderer.captureFrame(scene, camera);
    expect(displayPixels(frame).filter((v, i) => i % 4 === 1 && v > 100).length).toBeGreaterThan(
      20,
    );
    // Upstream helper.clone() calls a constructor that requires root/clip/object.
    // Recreate only its transform container; the original Line/Points clone normally.
    const referenceScene = new THREE.Scene(),
      referenceRoot = new THREE.Object3D().copy(helper, false);
    for (const child of helper.children) referenceRoot.add(child.clone());
    referenceScene.add(referenceRoot);
    await evidence('animation-path', frame, referenceScene, camera);
    await verifyReplay(frame, 'r187-animation-path-helper');
  } finally {
    helper.dispose();
  }
}
