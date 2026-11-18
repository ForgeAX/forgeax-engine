import * as THREE from '@forgeax/engine/three';
import { MeshSurfaceSampler } from '@forgeax/engine/three/addons/math/MeshSurfaceSampler.js';
import {
  mergeGeometries,
  mergeVertices,
} from '@forgeax/engine/three/addons/utils/BufferGeometryUtils.js';
import { clone } from '@forgeax/engine/three/addons/utils/SkeletonUtils.js';
import { expect, it } from 'vitest';

it('merges indexed geometry and groups using the public CPU constructor family', () => {
  const left = new THREE.BoxGeometry(),
    right = new THREE.BoxGeometry().translate(2, 0, 0);
  const merged = mergeGeometries([left, right], true);
  expect(merged).toBeInstanceOf(THREE.BufferGeometry);
  if (merged === null) throw new Error('geometry merge failed');
  expect(merged.getAttribute('position').count).toBe(48);
  expect(merged.index?.count).toBe(72);
  expect(merged.groups).toHaveLength(2);
  const plane = new THREE.PlaneGeometry().toNonIndexed();
  const indexed = mergeVertices(plane);
  expect(indexed).toBeInstanceOf(THREE.BufferGeometry);
  expect(indexed.getAttribute('position').count).toBe(4);
  expect(indexed.index?.count).toBe(6);
  for (const geometry of [left, right, merged, plane, indexed]) geometry.dispose();
});

it('clones a skeletal hierarchy, shares source assets and rebinds bones to the clone', () => {
  const geometry = new THREE.BoxGeometry();
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4),
  );
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(
      Array.from({ length: count * 4 }, (_, lane) => (lane % 4 === 0 ? 1 : 0)),
      4,
    ),
  );
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const bone = new THREE.Bone();
  bone.name = 'root-bone';
  mesh.name = 'body';
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  const root = new THREE.Group();
  root.add(mesh);
  const copied = clone(root),
    body = copied.getObjectByName('body');
  expect(copied).toBeInstanceOf(THREE.Group);
  expect(body).toBeInstanceOf(THREE.SkinnedMesh);
  if (!(body instanceof THREE.SkinnedMesh)) throw new Error('missing cloned skin');
  expect(body.geometry).toBe(geometry);
  expect(body.material).toBe(material);
  expect(body.skeleton).not.toBe(mesh.skeleton);
  expect(body.skeleton.bones[0]).toBeInstanceOf(THREE.Bone);
  expect(body.skeleton.bones[0]).not.toBe(bone);
  expect(body.skeleton.bones[0]?.parent).toBe(body);
  bone.position.x = 4;
  expect(body.skeleton.bones[0]?.position.x).toBe(0);
  body.skeleton.dispose();
  mesh.skeleton.dispose();
  geometry.dispose();
  material.dispose();
});

it('samples source triangles into caller-owned output objects without a renderer', () => {
  const geometry = new THREE.PlaneGeometry(2, 2),
    material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  const sampler = new MeshSurfaceSampler(mesh).setRandomGenerator(() => 0.25).build();
  const position = new THREE.Vector3(100, 100, 100),
    normal = new THREE.Vector3();
  const uv = new THREE.Vector2();
  for (let sample = 0; sample < 4; sample++) {
    sampler.sample(position, normal, undefined, uv);
    expect(Math.abs(position.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(position.y)).toBeLessThanOrEqual(1);
    expect(position.z).toBe(0);
    expect(normal.z).toBeCloseTo(1);
    expect(uv.x).toBeGreaterThanOrEqual(0);
    expect(uv.x).toBeLessThanOrEqual(1);
  }
  geometry.dispose();
  material.dispose();
});
