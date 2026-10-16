import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildMeshDistanceField,
  sampleMeshDistanceField,
} from '../../../packages/geometry/src/distance-field.ts';
import {
  decodeMeshDistanceField,
  encodeMeshDistanceField,
} from '../../../packages/geometry/src/distance-field-artifact.ts';
import { triangleDistanceSquared } from '../../../packages/geometry/src/triangle-query.ts';
import { parseGltfFromFile } from '../../../packages/gltf/src/node-file-entry.ts';

// Source-format policy is read from the same glTF material that owns raster sidedness.
// Parser admits triangle primitives only. No fallback converts rejected one-sided geometry into two-sided occluders.
const source = resolve(
  process.argv[2] ?? 'forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf',
);
const output = resolve(process.argv[3] ?? 'artifacts/raytracing/iteration-04/sponza-sdf');
await mkdir(output, { recursive: true });
const started = performance.now();
const document = (await parseGltfFromFile(source)).unwrap();
const rows = [];
for (const [section, mesh] of document.meshes.entries()) {
  const twoSided = document.materials[mesh.materialIndex]?.doubleSided ?? false;
  const begin = performance.now();
  if (mesh.morphTargets || mesh.joints0 || !mesh.indices) {
    rows.push({
      section,
      status: 'excluded',
      reason: 'deformed or non-indexed/non-triangle source',
    });
    continue;
  }
  const built = await buildMeshDistanceField(mesh.positions, mesh.indices, {
    resolution: 24,
    twoSided,
  });
  const cookMs = performance.now() - begin;
  if (!built.ok) {
    rows.push({
      section,
      material: mesh.materialIndex,
      twoSided,
      triangles: mesh.indices.length / 3,
      status: 'excluded',
      code: built.error.code,
      reason: built.error.detail.reason,
      cookMs,
    });
    continue;
  }
  const field = built.value;
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  const loaded = (await decodeMeshDistanceField(bytes, field.meshDigest)).unwrap();
  const triangles = [];
  for (let i = 0; i < mesh.indices.length; i += 3)
    triangles.push(
      Array.from({ length: 3 }, (_, v) =>
        Array.from(mesh.positions.slice(mesh.indices[i + v] * 3, mesh.indices[i + v] * 3 + 3)),
      ),
    );
  let maxError = 0;
  for (let i = 0; i < 64; i++) {
    const p = field.origin.map(
      (value, axis) =>
        value +
        (0.5 + 0.49 * Math.sin((i + 1) * (axis + 1) * 1.713)) *
          (field.dimensions[axis] - 1) *
          field.spacing,
    );
    const sample = sampleMeshDistanceField(loaded, p);
    let nearest = Infinity;
    for (const triangle of triangles)
      nearest = Math.min(nearest, triangleDistanceSquared(p, triangle));
    const error = Math.abs(Math.abs(sample) - Math.sqrt(nearest));
    maxError = Math.max(maxError, error);
    if (sample === null || error > field.policy.errorBound)
      throw new Error(`section ${section}: distance error ${error} > ${field.policy.errorBound}`);
  }
  await writeFile(resolve(output, `section-${section}.bin`), bytes);
  rows.push({
    section,
    material: mesh.materialIndex,
    twoSided,
    triangles: mesh.indices.length / 3,
    status: 'qualified-distance-samples',
    cookMs,
    bytes: bytes.length,
    meshDigest: field.meshDigest,
    artifactSha256: createHash('sha256').update(bytes).digest('hex'),
    dimensions: field.dimensions,
    spacing: field.spacing,
    errorBound: field.policy.errorBound,
    interiorSamples: field.quality.negativeSamples,
    maxSampleError: maxError,
    oracleSamples: 64,
  });
}
const result = {
  source: source.split('/').slice(-2).join('/'),
  sourceSha256: createHash('sha256')
    .update(await readFile(source))
    .digest('hex'),
  resolution: 24,
  elapsedMs: performance.now() - started,
  peakRssKiB: process.resourceUsage().maxRSS,
  sections: rows.length,
  admitted: rows.filter((r) => r.status === 'qualified-distance-samples').length,
  artifactBytes: rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
  limits:
    'CPU distance samples and codec only; no GPU/world coverage, MASK opacity or persistent cache qualification',
  rows,
};
await writeFile(resolve(output, 'report.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
