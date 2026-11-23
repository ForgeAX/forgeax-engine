// Run after the package build, with node --expose-gc. Each invocation owns a fresh World.
import { performance } from 'node:perf_hooks';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import { ok } from '@forgeax/engine-types';
import * as THREE from '../dist/index.mjs';

const [sceneKind, mode] = process.argv.slice(2);
if (
  !['meshes', 'mixed', 'lod', 'lod-posed', 'indices', 'custom-indices'].includes(sceneKind) ||
  !['strict', 'tracked', 'tracked-existing'].includes(mode) ||
  !globalThis.gc
) {
  throw new Error(
    'node --expose-gc packages/three/scripts/measure-source-projection.mjs <meshes|mixed|lod|lod-posed|indices|custom-indices> <strict|tracked|tracked-existing>',
  );
}
globalThis.gc();
const baseline = process.memoryUsage().heapUsed;
const releaseScope = mode === 'tracked' ? THREE.enableThreeSourceTracking() : () => {};
const assets = new AssetRegistry();
for (const decoder of defaultAssetDecoderContributions)
  assets.installDecoder(decoder.kind, decoder.decoder);
const world = new World({ assets }),
  scene = new THREE.Scene(),
  camera = new THREE.PerspectiveCamera();
camera.position.z = 5;
const geometry = new THREE.BoxGeometry(),
  solid = new THREE.MeshBasicMaterial();
let movingLevel;
let revisedIndex;
if (sceneKind === 'indices' || sceneKind === 'custom-indices') {
  const triangles = new THREE.BufferGeometry();
  triangles.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3));
  revisedIndex = new THREE.BufferAttribute(Uint16Array.from({ length: 300000 }, (_, i) => i % 3), 1);
  // Same index values and getter behavior, with an own method requiring ordinary dispatch.
  if (sceneKind === 'custom-indices') revisedIndex.getX = THREE.BufferAttribute.prototype.getX;
  triangles.setIndex(revisedIndex);
  scene.add(new THREE.Mesh(triangles, solid));
} else if (sceneKind === 'lod' || sceneKind === 'lod-posed') {
  const glass = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
  for (let i = 0; i < 9999; i++) {
    const mesh = new THREE.Mesh(geometry, glass);
    if (sceneKind === 'lod-posed') {
      mesh.position.x = (i + 1) / 20000;
      mesh.rotation.y = (i + 1) / 10000;
    }
    scene.add(mesh);
  }
  movingLevel = new THREE.Mesh(geometry, glass);
  scene.add(new THREE.LOD().addLevel(movingLevel, 0));
} else if (sceneKind === 'meshes') {
  for (let i = 0; i < 1000; i++) scene.add(new THREE.Mesh(geometry, solid));
} else {
  const points = new THREE.PointsMaterial(),
    lines = new THREE.LineBasicMaterial();
  const sprite = new THREE.SpriteMaterial(),
    glass = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
  for (let i = 0; i < 40; i++) {
    for (const object of [
      new THREE.AmbientLight(),
      new THREE.PointLight(),
      new THREE.SpotLight(),
      new THREE.DirectionalLight(),
      new THREE.RectAreaLight(),
      new THREE.Bone(),
      new THREE.Mesh(geometry, glass),
      new THREE.LineSegments(geometry, lines),
      new THREE.Points(geometry, points),
      new THREE.Sprite(sprite),
      new THREE.InstancedMesh(geometry, solid, 2),
    ]) {
      object.frustumCulled = false;
      scene.add(object);
    }
  }
}
// Only the presentation endpoint is stubbed. World, assets and the mount use the public runtime.
const renderer = { attach: () => ok({ dispose() {} }), subscribe: () => () => {} };
if (mode === 'tracked-existing') THREE.setThreeSceneTracking(scene, true);
globalThis.gc();
const before = process.memoryUsage().heapUsed;
const mount = (await THREE.mountThreeScene({ renderer, world, scene, camera })).unwrap();
globalThis.gc();
const after = process.memoryUsage().heapUsed;
const retainedMiB = (after - before) / 1048576;
const totalMiB = (after - baseline) / 1048576;
try {
  const workloads = revisedIndex
    ? ['index-revision']
    : movingLevel
      ? ['static', 'lod-leaf']
      : sceneKind === 'mixed'
        ? ['static', 'leaf', 'draw-leaf', 'all']
        : ['static', 'leaf', 'all'];
  const drawLeaf = scene.children.find((object) => object.isMesh);
  for (const workload of workloads) {
    const samples = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now(),
        x = (i % 2) / 10;
      if (revisedIndex) {
        revisedIndex.array[0] = i % 2;
        revisedIndex.needsUpdate = true;
      }
      if (workload === 'lod-leaf') movingLevel.position.x = x;
      if (workload === 'leaf') scene.children[0].position.x = x;
      if (workload === 'draw-leaf') drawLeaf.position.x = x;
      if (workload === 'all') for (const child of scene.children) child.position.x = x;
      mount.sync().unwrap();
      if (i >= 10) samples.push(performance.now() - start);
    }
    const sorted = samples.toSorted((a, b) => a - b);
    console.log(
      JSON.stringify({
        sceneKind,
        mode,
        workload,
        retainedMiB,
        totalMiB,
        p50: sorted[14],
        p95: sorted[28],
        work: mount.sourceWork(),
        samples,
      }),
    );
  }
} finally {
  mount.dispose().unwrap();
  releaseScope();
  assets.dispose();
}
