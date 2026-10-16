import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { generateMeshLods } from '@forgeax/engine-import/mesh-lod-generator';
import { AssetGuid } from '@forgeax/engine-pack/guid';

const meshGuid = (suffix) => {
  const result = AssetGuid.parse(`019f0000-0000-7000-8000-00000000060${suffix}`);
  if (!result.ok) throw result.error;
  return result.value;
};
const options = {
  maxError: 0.02,
  levels: [
    { mesh: meshGuid(1), triangleRatio: 0.5, screenCoverage: 0.5 },
    { mesh: meshGuid(2), triangleRatio: 0.25, screenCoverage: 0.2 },
  ],
};
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];
const rows = [];
for (const segments of [64, 128, 256]) {
  const source = createSphereGeometry(1, segments, segments / 2).unwrap();
  const times = [];
  let result;
  // One warmup separates WASM startup from steady source-production cost.
  (await generateMeshLods(source, options)).unwrap();
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    result = (await generateMeshLods(source, options)).unwrap();
    times.push(performance.now() - started);
  }
  rows.push({
    inputTriangles: source.indices.length / 3,
    inputBytes: source.vertices.byteLength + source.indices.byteLength,
    sampleCount: times.length,
    medianMs: quantile(times, 0.5),
    p95Ms: quantile(times, 0.95),
    levels: result.meshes.map((mesh, index) => ({
      ...result.reports[index],
      geometryBytes: mesh.vertices.byteLength + mesh.indices.byteLength,
      triangleRatio: mesh.indices.length / source.indices.length,
    })),
  });
}
const evidence = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  algorithm:
    'meshoptimizer 1.1.1; independent source-relative levels; LockBorder; normal/tangent=0.5, UV/color=1',
  maxError: options.maxError,
  rows,
};
mkdirSync('artifacts/generated-lod', { recursive: true });
writeFileSync(
  'artifacts/generated-lod/production-performance.json',
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence, null, 2));
