import { buildMeshAttributeMapForUvSets, deriveVertexBufferLayout } from '@forgeax/engine/geometry';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Multiple UV sets',
  catalog: 'Multiple UV sets',
  kind: 'headless',
  summary:
    'Meshes carry uv plus uv1..uv7 at shader locations 2 and 6..12; a shader that reads more sets than the mesh has aliases the missing ones onto the last real UV.',
  expect:
    'All checks pass: three UV sets widen the stride to 64 bytes with uv1/uv2 at locations 6/7, and a 4-set shader over a 1-set mesh aliases uv1..uv3 at offset 24 with no stride change.',
  run(checks) {
    const three = deriveVertexBufferLayout(buildMeshAttributeMapForUvSets(3))[0];
    checks.equal('three sets stride', three?.arrayStride, 64);
    checks.equal(
      'uv1/uv2 locations and offsets',
      three?.attributes
        .filter((a) => a.shaderLocation >= 6)
        .map((a) => [a.shaderLocation, a.offset, a.format]),
      [
        [6, 48, 'float32x2'],
        [7, 56, 'float32x2'],
      ],
    );

    const single = buildMeshAttributeMapForUvSets(1);
    const aliased = deriveVertexBufferLayout(single, { shaderUvSetCount: 4 })[0];
    checks.equal('alias keeps the mesh stride', aliased?.arrayStride, 48);
    checks.equal(
      'missing sets alias the last real uv offset',
      aliased?.attributes
        .filter((a) => a.shaderLocation >= 6)
        .map((a) => [a.shaderLocation, a.offset]),
      [
        [6, 24],
        [7, 24],
        [8, 24],
      ],
    );

    const noUv = deriveVertexBufferLayout(
      { position: new Float32Array(0) },
      { shaderUvSetCount: 1 },
    )[0];
    checks.equal('mesh without uv grows by one zero uv slot', noUv?.arrayStride, 20);
    checks.equal(
      'clamped to 8 sets',
      Object.keys(buildMeshAttributeMapForUvSets(20)).filter((k) => k.startsWith('uv')).length,
      8,
    );
  },
});
