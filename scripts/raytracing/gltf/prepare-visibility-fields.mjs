import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { distanceFieldMeshDigest } from '../../../packages/geometry/src/distance-field.ts';
import { encodeMeshDistanceField } from '../../../packages/geometry/src/distance-field-artifact.ts';
import { buildVisibilityDistanceField } from '../../../packages/geometry/src/visibility-distance-field.ts';

const input = resolve(process.argv[2]),
  output = resolve(process.argv[3]);
const worldVoxel = Number(process.argv[4] ?? 0.5);
assert(Number.isFinite(worldVoxel) && worldVoxel > 0);
const bytes = await readFile(input),
  cards = JSON.parse(bytes);
const sha = (b) => createHash('sha256').update(b).digest('hex');
await mkdir(output, { recursive: true });
const rows = [],
  groups = new Map();
for (const source of cards.sources) {
  const { instance } = source;
  const scales = [0, 4, 8].map((a) => Math.hypot(...instance.transform.slice(a, a + 3)));
  assert(scales.every((s) => Number.isFinite(s) && s > 0));
  const voxelSize = worldVoxel / Math.max(...scales);
  const flags = new Uint8Array(instance.indices.length / 3),
    visited = new Uint8Array(flags.length);
  const sections = source.sections ?? [
    { indexOffset: 0, indexCount: instance.indices.length, material: source.material },
  ];
  for (const section of sections) {
    const pass = section.material.asset.passes.find((p) => p.name === 'Forward');
    assert(pass);
    assert(section.indexOffset % 3 === 0 && section.indexCount % 3 === 0);
    const end = (section.indexOffset + section.indexCount) / 3;
    assert(end <= flags.length);
    for (let i = section.indexOffset / 3; i < end; i++) {
      assert.equal(visited[i], 0, 'overlapping material sections');
      visited[i] = 1;
      flags[i] = pass.renderState.cullMode === 'none' ? 1 : 0;
    }
  }
  assert(
    visited.every((v) => v === 1),
    'all geometry must have a sidedness policy',
  );
  const meshDigest = await distanceFieldMeshDigest(instance.positions, instance.indices);
  const policyKey = `${meshDigest}:${sha(flags)}`;
  const group = groups.get(instance.geometryId);
  if (group) {
    assert.equal(
      group.policyKey,
      policyKey,
      'shared geometry must have consistent source and sidedness',
    );
    group.voxelSize = Math.min(group.voxelSize, voxelSize);
    group.instanceIds.push(instance.instanceId);
  } else
    groups.set(instance.geometryId, {
      instance,
      flags,
      policyKey,
      voxelSize,
      instanceIds: [instance.instanceId],
    });
}
for (const { instance, flags, voxelSize, instanceIds } of groups.values()) {
  const start = performance.now();
  const result = await buildVisibilityDistanceField(instance.positions, instance.indices, {
    voxelSize,
    triangleSidedness: flags,
  });
  const row = {
    section: instance.geometryId,
    instanceId: instance.instanceId,
    instanceIds,
    triangles: flags.length,
    worldVoxel,
    voxelSize,
    cookMs: performance.now() - start,
  };
  if (result.ok) {
    const field = result.value,
      artifact = await encodeMeshDistanceField(field);
    if (!artifact.ok) {
      Object.assign(row, { status: 'rejected', error: artifact.error });
      rows.push(row);
      console.log(JSON.stringify(row));
      continue;
    }
    const encoded = artifact.value;
    Object.assign(row, {
      status: 'sampled-visibility',
      meshDigest: field.meshDigest,
      policy: field.policy,
      dimensions: field.dimensions,
      spacing: field.spacing,
      quality: field.quality,
      bytes: encoded.length,
      artifactSha256: sha(encoded),
    });
    await writeFile(resolve(output, `section-${instance.geometryId}.bin`), encoded);
  } else Object.assign(row, { status: 'rejected', error: result.error });
  rows.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(
  resolve(output, 'report.json'),
  `${JSON.stringify(
    {
      scope:
        'Whole input geometry with per-triangle sidedness and explicit voxel size. Approximate sampled visibility; no material alpha, GI, residency or quality acceptance. Rejected inputs remain in the report.',
      sourceSha256: sha(bytes),
      worldVoxel,
      rows,
    },
    null,
    2,
  )}\n`,
);
