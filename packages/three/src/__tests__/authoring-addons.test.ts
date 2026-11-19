import * as THREE from '@forgeax/engine/three';
import { AnimationClipCreator } from '@forgeax/engine/three/addons/animation/AnimationClipCreator.js';
import { CCDIKSolver } from '@forgeax/engine/three/addons/animation/CCDIKSolver.js';
import { OBJExporter } from '@forgeax/engine/three/addons/exporters/OBJExporter.js';
import { PLYExporter } from '@forgeax/engine/three/addons/exporters/PLYExporter.js';
import { STLExporter } from '@forgeax/engine/three/addons/exporters/STLExporter.js';
import { OctreeHelper } from '@forgeax/engine/three/addons/helpers/OctreeHelper.js';
import { VertexNormalsHelper } from '@forgeax/engine/three/addons/helpers/VertexNormalsHelper.js';
import { VertexTangentsHelper } from '@forgeax/engine/three/addons/helpers/VertexTangentsHelper.js';
import { HDRLoader } from '@forgeax/engine/three/addons/loaders/HDRLoader.js';
import { MTLLoader } from '@forgeax/engine/three/addons/loaders/MTLLoader.js';
import { OBJLoader } from '@forgeax/engine/three/addons/loaders/OBJLoader.js';
import { PLYLoader } from '@forgeax/engine/three/addons/loaders/PLYLoader.js';
import { STLLoader } from '@forgeax/engine/three/addons/loaders/STLLoader.js';
import { Lut } from '@forgeax/engine/three/addons/math/Lut.js';
import { Octree } from '@forgeax/engine/three/addons/math/Octree.js';
import { frameCorners } from '@forgeax/engine/three/addons/utils/CameraUtils.js';
import { setKelvin } from '@forgeax/engine/three/addons/utils/ColorUtils.js';
import { hilbert2D, hilbert3D } from '@forgeax/engine/three/addons/utils/GeometryUtils.js';
import { expect, it } from 'vitest';
import { authoringGeometries } from './authoring-addons.fixture';

it('produces finite public geometry from all modifiers, surface functions, decals and OBJ', async () => {
  const geometries = await authoringGeometries();
  try {
    for (const g of Object.values(geometries)) {
      expect(g).toBeInstanceOf(THREE.BufferGeometry);
      const p = g.getAttribute('position');
      expect(p.count).toBeGreaterThan(0);
      expect([...p.array].every(Number.isFinite)).toBe(true);
      g.computeBoundingBox();
      expect(g.boundingBox?.isEmpty()).toBe(false);
    }
  } finally {
    Object.values(geometries).forEach((g) => {
      g.dispose();
    });
  }
});
it('round-trips transformed geometry through OBJ, ASCII/binary STL and ASCII/binary PLY', () => {
  const geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshBasicMaterial(),
    mesh = new THREE.Mesh(geometry, material);
  mesh.position.x = 2;
  mesh.updateMatrixWorld();
  const parsed: THREE.BufferGeometry[] = [];
  try {
    const obj = new OBJLoader().parse(new OBJExporter().parse(mesh)),
      first = obj.children[0];
    expect(first).toBeInstanceOf(THREE.Mesh);
    if (!(first instanceof THREE.Mesh)) throw Error('missing OBJ');
    parsed.push(first.geometry);
    if (Array.isArray(first.material))
      first.material.forEach((m) => {
        m.dispose();
      });
    else first.material.dispose();
    parsed.push(new STLLoader().parse(new STLExporter().parse(mesh)));
    parsed.push(
      new STLLoader().parse(new STLExporter().parse(mesh, { binary: true }).buffer as ArrayBuffer),
    );
    const exporter = new PLYExporter();
    const ascii = exporter.parse(mesh),
      binary = exporter.parse(mesh, undefined, { binary: true, littleEndian: true });
    expect(typeof ascii).toBe('string');
    expect(binary).toBeInstanceOf(ArrayBuffer);
    if (ascii === null || binary === null) throw Error('missing PLY');
    parsed.push(new PLYLoader().parse(ascii), new PLYLoader().parse(binary));
    for (const g of parsed) {
      g.computeBoundingBox();
      expect(g.boundingBox?.min.x).toBeCloseTo(1.5);
      expect(g.boundingBox?.max.x).toBeCloseTo(2.5);
    }
  } finally {
    geometry.dispose();
    material.dispose();
    parsed.forEach((g) => {
      g.dispose();
    });
  }
});
it('parses MTL CPU materials and finite HDR data without an implicit render or image request', () => {
  const creator = new MTLLoader().parse('newmtl green\nKd 0 1 0\nNs 20\n', '');
  creator.preload();
  const material = creator.create('green');
  try {
    expect(material).toBeInstanceOf(THREE.MeshPhongMaterial);
    if (!(material instanceof THREE.MeshPhongMaterial)) throw Error('missing Phong material');
    expect(material.color.g).toBe(1);
  } finally {
    material.dispose();
  }
  const header = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n');
  const bytes = new Uint8Array(header.length + 4);
  bytes.set(header);
  bytes.set([128, 64, 32, 129], header.length);
  const loader = new HDRLoader().setDataType(THREE.FloatType),
    result = loader.parse(bytes.buffer);
  expect(loader).toBeInstanceOf(THREE.DataTextureLoader);
  expect(result.width).toBe(1);
  expect(result.height).toBe(1);
  expect(result.data).toBeInstanceOf(Float32Array);
  if (!(result.data instanceof Float32Array)) throw Error('missing Float32 HDR data');
  for (const [i, value] of [256 / 255, 128 / 255, 64 / 255, 1].entries())
    expect(result.data[i]).toBeCloseTo(value, 6);
});
it('updates original normal, tangent and Octree helper geometry from public objects', () => {
  const geometry = new THREE.BoxGeometry();
  geometry.computeTangents();
  const material = new THREE.MeshBasicMaterial(),
    mesh = new THREE.Mesh(geometry, material);
  mesh.updateMatrixWorld();
  const helpers = [
    new VertexNormalsHelper(mesh),
    new VertexTangentsHelper(mesh),
    new OctreeHelper(new Octree().fromGraphNode(mesh)),
  ];
  try {
    for (const helper of helpers) {
      expect(helper).toBeInstanceOf(THREE.LineSegments);
      helper.update();
      expect(helper.geometry.getAttribute('position').count).toBeGreaterThan(0);
    }
  } finally {
    helpers.forEach((h) => {
      h.dispose();
    });
    geometry.dispose();
    material.dispose();
  }
});
it('uses caller-owned colors and public geometry/camera utilities', () => {
  const color = new THREE.Color();
  expect(setKelvin(color, 6500)).toBe(color);
  expect(color.toArray().every(Number.isFinite)).toBe(true);
  const lut = new Lut('cooltowarm', 16).setMin(-1).setMax(1);
  expect(lut.getColor(0)).toBeInstanceOf(THREE.Color);
  for (const points of [hilbert2D(), hilbert3D()]) {
    expect(points.length).toBeGreaterThan(0);
    expect(points[0]).toBeInstanceOf(THREE.Vector3);
  }
  const camera = new THREE.PerspectiveCamera();
  camera.position.z = 2;
  frameCorners(
    camera,
    new THREE.Vector3(-1, -1, 0),
    new THREE.Vector3(1, -1, 0),
    new THREE.Vector3(-1, 1, 0),
  );
  expect(camera.projectionMatrix.elements.every(Number.isFinite)).toBe(true);
});
it('plays generated clips and explicitly solves a skeletal CCD chain', () => {
  const object = new THREE.Object3D(),
    clip = AnimationClipCreator.CreateRotationAnimation(2, 'z'),
    mixer = new THREE.AnimationMixer(object);
  expect(clip).toBeInstanceOf(THREE.AnimationClip);
  mixer.clipAction(clip).play();
  mixer.update(0.5);
  // The original helper writes the literal range 0..360 to the rotation track.
  expect(object.rotation.z).toBe(90);
  mixer.uncacheRoot(object);
  const root = new THREE.Bone(),
    effector = new THREE.Bone(),
    target = new THREE.Bone();
  effector.position.x = 1;
  target.position.y = 1;
  root.add(effector);
  const geometry = new THREE.BufferGeometry(),
    material = new THREE.MeshBasicMaterial(),
    mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.add(root, target);
  mesh.bind(new THREE.Skeleton([root, effector, target]));
  mesh.updateMatrixWorld(true);
  const before = effector
    .getWorldPosition(new THREE.Vector3())
    .distanceTo(target.getWorldPosition(new THREE.Vector3()));
  const solver = new CCDIKSolver(mesh, [
    { target: 2, effector: 1, links: [{ index: 0 }], iteration: 4 },
  ]);
  try {
    expect(solver.update()).toBe(solver);
    mesh.updateMatrixWorld(true);
    expect(
      effector
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(target.getWorldPosition(new THREE.Vector3())),
    ).toBeLessThan(before);
  } finally {
    mesh.skeleton.dispose();
    geometry.dispose();
    material.dispose();
  }
});
