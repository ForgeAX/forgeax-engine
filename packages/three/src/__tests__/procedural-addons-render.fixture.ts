import * as THREE from '@forgeax/engine/three';
import { LWOLoader } from '@forgeax/engine/three/addons/loaders/LWOLoader.js';
import { USDLoader } from '@forgeax/engine/three/addons/loaders/USDLoader.js';
import { Gyroscope } from '@forgeax/engine/three/addons/misc/Gyroscope.js';
import { MorphAnimMesh } from '@forgeax/engine/three/addons/misc/MorphAnimMesh.js';
import { MorphBlendMesh } from '@forgeax/engine/three/addons/misc/MorphBlendMesh.js';
import { MarchingCubes } from '@forgeax/engine/three/addons/objects/MarchingCubes.js';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { lwoTriangle, morphTriangle, usdTriangle } from './procedural-addons.fixture';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';
import {
  disposeScene,
  type SceneEvidence,
  supportedMaterials,
} from './scene-format-addons-render.fixture';

function requireCells(frame: THREE.ThreeFrameCapture, count: number) {
  const pixels = displayPixels(frame);
  for (let cell = 0; cell < count; cell++) {
    let visible = 0;
    for (let y = 0; y < 128; y++)
      for (
        let x = Math.floor((cell * 128) / count);
        x < Math.floor(((cell + 1) * 128) / count);
        x++
      )
        if ((pixels[(y * 128 + x) * 4 + 3] ?? 0) > 0) visible++;
    expect(visible, `gallery cell ${cell}`).toBeGreaterThan(10);
  }
}

export function proceduralGallery() {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 6;
  const cubes = new MarchingCubes(
    12,
    new THREE.MeshBasicMaterial({ color: 0x33cc66 }),
    false,
    false,
    2000,
  );
  cubes.addBall(0.5, 0.5, 0.5, 0.8, 12);
  cubes.update();
  cubes.position.x = -1.8;
  cubes.scale.setScalar(1.2);
  const geometry = morphTriangle(),
    animated = new MorphAnimMesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: 0x3399ff, side: THREE.DoubleSide }),
    );
  animated.animations = [
    THREE.AnimationClip.CreateFromMorphTargetSequence(
      'idle',
      geometry.morphAttributes.position ?? [],
      3,
      false,
    ),
  ];
  animated.playAnimation('idle', 1);
  animated.updateAnimation(0.05);
  animated.position.x = -0.6;
  const blend = new MorphBlendMesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0xff9933, side: THREE.DoubleSide }),
  );
  blend.autoCreateAnimations(3);
  blend.playAnimation('idle');
  blend.update(0.05);
  blend.position.x = 0.6;
  const parent = new THREE.Object3D(),
    gyro = new Gyroscope(),
    box = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.8, 0.4),
      new THREE.MeshBasicMaterial({ color: 0xdd44cc }),
    );
  parent.position.x = 1.8;
  parent.rotation.z = 0.4;
  gyro.position.y = 0.3;
  gyro.add(box);
  parent.add(gyro);
  scene.add(cubes, animated, blend, parent);
  return { scene, camera, cubes, animated, blend, parent };
}

export async function verifyProceduralGallery(
  renderer: THREE.WebGPURenderer,
  evidence: SceneEvidence,
) {
  await renderer.init();
  const { scene, camera, cubes, animated, blend, parent } = proceduralGallery();
  try {
    await readyFrames(renderer, scene, camera, 60);
    const initial = await renderer.captureFrame(scene, camera);
    await evidence('procedural-initial', initial, scene, camera);
    requireCells(initial, 4);
    animated.updateAnimation(0.1);
    blend.update(0.2);
    parent.rotation.z = -0.6;
    cubes.reset();
    cubes.addBall(0.65, 0.45, 0.5, 0.6, 12);
    cubes.update();
    await readyFrames(renderer, scene, camera, 60);
    const edited = await renderer.captureFrame(scene, camera);
    await evidence('procedural-edited', edited, scene, camera);
    requireCells(edited, 4);
    expect(equalBytes(displayPixels(initial), displayPixels(edited))).toBe(false);
    await verifyReplay(edited, 'r187-procedural-addons');
  } finally {
    animated.mixer.stopAllAction();
    animated.mixer.uncacheRoot(animated);
    disposeScene(scene);
  }
}

export function assetGallery() {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const usd = supportedMaterials(new USDLoader().parse(usdTriangle));
  const lwo = new THREE.Group();
  lwo.add(...new LWOLoader().parse(lwoTriangle(), '', 'fixture').meshes);
  supportedMaterials(lwo);
  usd.position.x = -1.1;
  lwo.position.x = 1.1;
  usd.scale.setScalar(0.65);
  lwo.scale.setScalar(0.65);
  scene.add(usd, lwo);
  return { scene, camera, usd };
}

export async function verifyAssetGallery(renderer: THREE.WebGPURenderer, evidence: SceneEvidence) {
  await renderer.init();
  const { scene, camera, usd } = assetGallery();
  try {
    await readyFrames(renderer, scene, camera, 60);
    const initial = await renderer.captureFrame(scene, camera);
    await evidence('assets-initial', initial, scene, camera);
    requireCells(initial, 2);
    usd.position.y = 0.5;
    const edited = await renderer.captureFrame(scene, camera);
    await evidence('assets-edited', edited, scene, camera);
    expect(equalBytes(displayPixels(initial), displayPixels(edited))).toBe(false);
    await verifyReplay(edited, 'r187-usd-lwo-addons');
  } finally {
    disposeScene(scene);
  }
}

export const PROCEDURAL_RENDER_CASES = [
  ['procedural gallery', verifyProceduralGallery],
  ['USD and LWO gallery', verifyAssetGallery],
] as const;
