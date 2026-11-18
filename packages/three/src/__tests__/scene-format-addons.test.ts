import * as THREE from '@forgeax/engine/three';
import { AnimationPathHelper } from '@forgeax/engine/three/addons/helpers/AnimationPathHelper.js';
import { SelectionBox } from '@forgeax/engine/three/addons/interactive/SelectionBox.js';
import { GCodeLoader } from '@forgeax/engine/three/addons/loaders/GCodeLoader.js';
import { RGBELoader } from '@forgeax/engine/three/addons/loaders/RGBELoader.js';
import { TDSLoader } from '@forgeax/engine/three/addons/loaders/TDSLoader.js';
import {
  buildData3DTexture,
  buildMesh,
  VOXLoader,
} from '@forgeax/engine/three/addons/loaders/VOXLoader.js';
import { VRMLLoader } from '@forgeax/engine/three/addons/loaders/VRMLLoader.js';
import { SceneOptimizer } from '@forgeax/engine/three/addons/utils/SceneOptimizer.js';
import { expect, it } from 'vitest';
import * as fixture from './scene-format-addons.fixture';
export function disposeScene(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Line ||
      object instanceof THREE.Points
    ) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
      if (object instanceof THREE.BatchedMesh) object.dispose();
    }
  });
}
it('parses binary VOX into original meshes, vertex colors and CPU volume descriptors', () => {
  const result = new VOXLoader().parse(fixture.vox());
  if (result === undefined) throw Error('missing VOX result');
  expect(result.scene).toBeNull();
  expect(result.chunks).toHaveLength(1);
  const chunk = result.chunks[0];
  if (chunk === undefined) throw Error('missing voxel');
  const mesh = buildMesh(chunk),
    volume = buildData3DTexture(chunk);
  try {
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(mesh.geometry.getAttribute('color').count).toBeGreaterThan(0);
    expect(volume).toBeInstanceOf(THREE.Data3DTexture);
  } finally {
    disposeScene(mesh);
    if (result.scene !== null) disposeScene(result.scene);
    volume.dispose();
  }
});
it('parses actual GCode, legacy VRML and binary 3DS geometry', () => {
  const groups = [
    new GCodeLoader().parse(fixture.gcode),
    new VRMLLoader().parse(fixture.vrml, ''),
    new TDSLoader().parse(fixture.tds(), ''),
  ];
  try {
    for (const root of groups) {
      expect(root).toBeInstanceOf(THREE.Object3D);
      let vertices = 0;
      root.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line)
          vertices += o.geometry.getAttribute('position').count;
      });
      expect(vertices).toBeGreaterThan(0);
    }
  } finally {
    for (const root of groups) disposeScene(root);
  }
});
it('retains deprecated RGBE compatibility through the original HDR float parser', () => {
  const header = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),
    data = new Uint8Array(header.length + 4);
  data.set(header);
  data.set([128, 64, 32, 129], header.length);
  const parsed = new RGBELoader().setDataType(THREE.FloatType).parse(data.buffer);
  expect([parsed.width, parsed.height]).toEqual([1, 1]);
  expect(parsed.data).toBeInstanceOf(Float32Array);
  if (!(parsed.data instanceof Float32Array)) throw Error('missing HDR pixels');
  expect(parsed.data[0]).toBeCloseTo(256 / 255, 6);
});
it('selects public mesh objects through the original CPU frustum query', () => {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100),
    geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshBasicMaterial(),
    inside = new THREE.Mesh(geometry, material),
    outside = new THREE.Mesh(geometry, material);
  camera.position.z = 5;
  outside.position.x = 4;
  scene.add(inside, outside);
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  try {
    const box = new SelectionBox(camera, scene, 100),
      selected = box.select(new THREE.Vector3(-0.2, 0.2, 0), new THREE.Vector3(0.2, -0.2, 0));
    expect(selected).toContain(inside);
    expect(selected).not.toContain(outside);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});
it('builds a real animated path without installing an animation tick', () => {
  const root = new THREE.Group(),
    object = new THREE.Object3D();
  object.name = 'Ball';
  root.add(object);
  const clip = new THREE.AnimationClip('path', 1, [
    new THREE.VectorKeyframeTrack(`${object.uuid}.position`, [0, 1], [-1, 0, 0, 1, 0, 0]),
  ]);
  const helper = new AnimationPathHelper(root, clip, object, { divisions: 8 });
  try {
    expect(helper).toBeInstanceOf(THREE.Object3D);
    expect(helper.line).toBeInstanceOf(THREE.Line);
    if (helper.line === undefined) throw Error('missing helper path');
    expect(helper.line.geometry.getAttribute('position').count).toBeGreaterThan(2);
    expect(helper.points).toBeInstanceOf(THREE.Points);
    helper.setColor(0xff0000);
    expect(helper.line.material.color.r).toBe(1);
  } finally {
    helper.dispose();
  }
});
it('explicitly rewrites compatible static meshes to original BatchedMesh data', () => {
  const scene = new THREE.Scene(),
    geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshBasicMaterial({ color: 0x22cc44 });
  for (const x of [-0.8, 0.8]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = x;
    scene.add(mesh);
  }
  scene.updateMatrixWorld(true);
  const optimizer = new SceneOptimizer(scene);
  try {
    expect(optimizer.toBatchedMesh()).toBe(scene);
    const batches: THREE.BatchedMesh[] = [];
    scene.traverse((o) => {
      if (o instanceof THREE.BatchedMesh) batches.push(o);
    });
    expect(batches).toHaveLength(1);
    const matrix = new THREE.Matrix4();
    batches[0]?.getMatrixAt(0, matrix);
    expect(matrix.elements.every(Number.isFinite)).toBe(true);
  } finally {
    disposeScene(scene);
  }
});
