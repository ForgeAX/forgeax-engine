import { performance } from 'node:perf_hooks';
import { arch, cpus, platform } from 'node:os';
import { buildMeshCollision, createBoxGeometry, createSphereGeometry } from '@forgeax/engine-geometry';
import { loadRapier3D } from '../dist/index.mjs';

const rapier = await loadRapier3D();
if ('code' in rapier) throw rapier;
const measurements = [];
for (const [sourceName, mesh] of [
  ['subdivided-box', createBoxGeometry(2, 2, 2, 32, 32, 32).unwrap()],
  ['sphere', createSphereGeometry(1, 64, 32).unwrap()],
]) {
  const collision = buildMeshCollision(mesh).unwrap();
  for (const kind of ['convexHull', 'trimesh']) {
    const samples = [];
    for (let run = 0; run < 25; run++) {
      const native = new rapier.World({ x: 0, y: 0, z: 0 });
      try {
        const start = performance.now();
        const descriptor = kind === 'convexHull'
          ? rapier.ColliderDesc.convexHull(collision.positions)
          : rapier.ColliderDesc.trimesh(
              collision.positions,
              collision.indices,
              rapier.TriMeshFlags.FIX_INTERNAL_EDGES,
            );
        if (descriptor === null) throw new Error('native shape admission failed');
        const collider = native.createCollider(descriptor);
        const elapsedMs = performance.now() - start;
        if (run >= 5) samples.push(elapsedMs);
        // Read native geometry after admission; descriptor construction alone is insufficient.
        if (collider.vertices().length < 9) throw new Error('native geometry is empty');
      } finally {
        native.free();
      }
    }
    samples.sort((a, b) => a - b);
    measurements.push({
      sourceName,
      kind,
      sourceTriangles: mesh.indices.length / 3,
      collisionTriangles: collision.indices.length / 3,
      collisionVertices: collision.positions.length / 3,
      samples: samples.length,
      medianMs: samples[10],
      p95Ms: samples[19],
    });
  }
}
console.log(JSON.stringify({
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, rapier: rapier.version(), timestamp: new Date().toISOString() },
  interval: 'descriptor plus actual native collider construction; excludes World creation and free',
  measurements,
}, null, 2));
