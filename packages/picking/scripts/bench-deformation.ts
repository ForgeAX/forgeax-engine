import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { MeshFilter } from '@forgeax/engine-render';
import { MorphWeights, Transform, propagateTransforms } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { pickTriangle } from '../src/pick-triangle';
import { skinScene } from '../src/__tests__/skin-scene.fixture';
const records = [];
for (const [segments, jointCount] of [
  [64, 2],
  [1024, 64],
  [4096, 256],
]) {
  const scene = skinScene(segments),
    world = scene.world;
  const joints = new Uint32Array(jointCount);
  const ibm = new Float32Array(jointCount * 16);
  for (let j = 0; j < jointCount; j++) {
    joints[j] = world.spawn({ component: Transform, data: {} }).unwrap();
    ibm.set(mat4.identity(mat4.create()), j * 16);
  }
  const skeleton = world.allocSharedRef('SkeletonAsset', {
    kind: 'skeleton',
    jointCount,
    inverseBindMatrices: ibm,
    jointPaths: Array.from({ length: jointCount }, (_, i) => 'joint-' + i),
    bounds: new Float32Array([-2, -2, -1, 2, 2, 1]),
  });
  const positions = scene.mesh.attributes.position as Float32Array;
  const skinIndex = scene.mesh.attributes.skinIndex as Uint16Array,
    skinWeight = scene.mesh.attributes.skinWeight as Float32Array;
  for (let v = 0; v < positions.length / 3; v++) {
    skinIndex.set([v % jointCount, 0, 0, 0], v * 4);
    skinWeight.set([1, 0, 0, 0], v * 4);
  }
  const delta = new Float32Array(positions.length);
  for (let v = 0; v < positions.length; v += 3) delta[v] = 0.5;
  const mesh = { ...scene.mesh, morphTargets: [{ position: delta }, { position: delta }] };
  world
    .set(scene.entity, MeshFilter, { assetHandle: world.allocSharedRef('MeshAsset', mesh) })
    .unwrap();
  world.set(scene.entity, Skin, { skeleton, joints }).unwrap();
  world
    .addComponent(scene.entity, {
      component: MorphWeights,
      data: { weights: new Float32Array([0, 0]) },
    })
    .unwrap();
  const raw = [];
  let frame = 0;
  for (const morph of [false, true, true, false]) {
    globalThis.gc?.();
    let peakBytes = 0;
    for (let i = -100; i < 300; i++) {
      const x = 0.05 * Math.sin(++frame * 0.1);
      for (const joint of joints)
        world.set(joint as EntityHandle, Transform, { pos: [x, 0, 0] }).unwrap();
      world
        .set(scene.entity, MorphWeights, {
          weights: new Float32Array(
            morph ? [0.2 * Math.sin(frame * 0.08), -0.1 * Math.cos(frame * 0.09)] : [0, 0],
          ),
        })
        .unwrap();
      propagateTransforms(world).unwrap();
      const start = performance.now();
      const result = pickTriangle(world, scene.camera, 64, 64, 128, 128);
      const cpuMs = performance.now() - start;
      if (result.status !== 'hit') throw new Error('live pose benchmark must hit');
      if (i >= 0) raw.push({ morph, frame, cpuMs, point: Array.from(result.hit.point) });
      if (i % 25 === 0) peakBytes = Math.max(peakBytes, process.memoryUsage().arrayBuffers);
    }
    records.push({ segments, joints: jointCount, morph, peakArrayBufferBytes: peakBytes });
  }
  const summary = [false, true].map((morph) => {
    const times = raw
      .filter((v) => v.morph === morph)
      .map((v) => v.cpuMs)
      .sort((a, b) => a - b);
    return {
      morph,
      p50Ms: times[Math.floor(times.length * 0.5)],
      p95Ms: times[Math.floor(times.length * 0.95)],
    };
  });
  records.push({
    vertices: positions.length / 3,
    triangles: segments * 2,
    joints: jointCount,
    scratchBytes: positions.byteLength + ibm.byteLength,
    raw,
    summary,
  });
}
mkdirSync('artifacts/picking-curves', { recursive: true });
writeFileSync(
  'artifacts/picking-curves/deformation-performance.json',
  JSON.stringify(
    {
      cpu: cpus()[0]?.model,
      runtime: process.versions,
      order: 'ABBA',
      warmupPerPhase: 100,
      samplesPerPhase: 300,
      scope:
        'Current joint matrices and morph weights change before every query. Propagation and author updates excluded from CPU query time. No retained pose, no GPU. A=Skin B=Skin+two Morph targets. Same per-size geometry and query.',
      records,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    records.filter((v) => 'summary' in v).map(({ raw, ...v }) => v),
    null,
    2,
  ),
);
