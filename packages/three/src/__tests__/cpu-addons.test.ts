import * as THREE from '@forgeax/engine/three';
import { GrannyKnot, HelixCurve } from '@forgeax/engine/three/addons/curves/CurveExtras.js';
import { Font, FontLoader } from '@forgeax/engine/three/addons/loaders/FontLoader.js';
import { Capsule } from '@forgeax/engine/three/addons/math/Capsule.js';
import { ConvexHull } from '@forgeax/engine/three/addons/math/ConvexHull.js';
import { ImprovedNoise } from '@forgeax/engine/three/addons/math/ImprovedNoise.js';
import { OBB } from '@forgeax/engine/three/addons/math/OBB.js';
import { Octree } from '@forgeax/engine/three/addons/math/Octree.js';
import { SimplexNoise } from '@forgeax/engine/three/addons/math/SimplexNoise.js';
import { createMeshesFromInstancedMesh } from '@forgeax/engine/three/addons/utils/SceneUtils.js';
import { expect, it } from 'vitest';
import { addonGeometries, fontData } from './cpu-addons.fixture';

it('uses one public constructor family across all new geometry and loader paths', () => {
  const geometries = addonGeometries();
  try {
    for (const geometry of Object.values(geometries)) {
      expect(geometry).toBeInstanceOf(THREE.BufferGeometry);
      const position = geometry.getAttribute('position');
      expect(position.count).toBeGreaterThan(0);
      expect(Array.from(position.array).every(Number.isFinite)).toBe(true);
      geometry.computeBoundingBox();
      expect(geometry.boundingBox).toBeInstanceOf(THREE.Box3);
    }
    expect(geometries.stl.getAttribute('normal').count).toBe(3);
    expect(geometries.ply.index?.count).toBe(3);
    expect(geometries.points.getAttribute('color').count).toBe(3);
    const font = new FontLoader().parse(fontData);
    expect(font).toBeInstanceOf(Font);
    expect(font.generateShapes('A', 1)).toHaveLength(1);
  } finally {
    for (const geometry of Object.values(geometries)) geometry.dispose();
  }
});
it('performs OBB, hull and capsule queries with caller-owned public vectors', () => {
  const obb = new OBB().fromBox3(
    new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
  );
  expect(obb.center).toBeInstanceOf(THREE.Vector3);
  expect(obb.containsPoint(new THREE.Vector3())).toBe(true);
  expect(obb.containsPoint(new THREE.Vector3(3, 0, 0))).toBe(false);
  expect(obb.intersectsSphere(new THREE.Sphere(new THREE.Vector3(), 0.2))).toBe(true);
  const capsule = new Capsule(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0), 0.2),
    center = new THREE.Vector3();
  capsule.translate(new THREE.Vector3(2, 0, 0));
  capsule.getCenter(center);
  expect(center.x).toBe(2);
  expect(capsule.start).toBeInstanceOf(THREE.Vector3);
  const hull = new ConvexHull().setFromPoints([
    new THREE.Vector3(-1, -1, -1),
    new THREE.Vector3(1, -1, -1),
    new THREE.Vector3(0, 1, -1),
    new THREE.Vector3(0, 0, 1),
  ]);
  expect(hull.containsPoint(new THREE.Vector3())).toBe(true);
  expect(hull.containsPoint(new THREE.Vector3(4, 0, 0))).toBe(false);
});
it('builds a CPU Octree from public meshes and intersects real scene triangles', () => {
  const geometry = new THREE.PlaneGeometry(2, 2),
    material = new THREE.MeshBasicMaterial(),
    mesh = new THREE.Mesh(geometry, material);
  try {
    mesh.updateMatrixWorld();
    const octree = new Octree().fromGraphNode(mesh),
      hit = octree.rayIntersect(
        new THREE.Ray(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)),
      );
    expect(hit).not.toBe(false);
    if (hit === false) throw Error('missing hit');
    expect(hit.distance).toBeCloseTo(1);
    expect(hit.position).toBeInstanceOf(THREE.Vector3);
    expect(octree.sphereIntersect(new THREE.Sphere(new THREE.Vector3(0, 0, 0.1), 0.2))).not.toBe(
      false,
    );
  } finally {
    geometry.dispose();
    material.dispose();
  }
});
it('retains deterministic noise, curve output reuse and instanced-scene decomposition', () => {
  const random = () => {
    let seed = 1;
    return {
      random: () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      },
    };
  };
  const a = new SimplexNoise(random()),
    b = new SimplexNoise(random());
  expect(a.noise3d(0.2, 0.3, 0.4)).toBe(b.noise3d(0.2, 0.3, 0.4));
  expect(Number.isFinite(new ImprovedNoise().noise(0.2, 0.3, 0.4))).toBe(true);
  const out = new THREE.Vector3();
  for (const curve of [new GrannyKnot(), new HelixCurve()]) {
    expect(curve.getPoint(0.3, out)).toBe(out);
    expect(out.toArray().every(Number.isFinite)).toBe(true);
  }
  const geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshBasicMaterial(),
    mesh = new THREE.InstancedMesh(geometry, material, 2);
  try {
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-1, 0, 0));
    mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1, 0, 0));
    const group = createMeshesFromInstancedMesh(mesh);
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children).toHaveLength(2);
    expect(group.children[0]).toBeInstanceOf(THREE.Mesh);
    expect((group.children[0] as THREE.Mesh).geometry).toBe(geometry);
    expect(group.children[1]?.position.x).toBe(1);
  } finally {
    mesh.dispose();
    geometry.dispose();
    material.dispose();
  }
});
