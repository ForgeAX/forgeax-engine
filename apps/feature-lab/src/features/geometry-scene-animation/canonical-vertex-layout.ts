import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexBufferLayout,
  deriveVertexLayoutProjection,
  deriveVertexLayoutProjectionFromMask,
  packInterleavedVertexAttributes,
  SKIN_VERTEX_ATTRIBUTE_MAP,
} from '@forgeax/engine/geometry';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Canonical vertex layout',
  catalog: 'Canonical vertex layout',
  kind: 'headless',
  summary:
    'One attribute map derives the GPU vertex buffer layout, the packing projection and its digest; absent keys reserve no bytes.',
  expect:
    'All checks pass: position/normal/uv/tangent sit at locations 0..3 with a 48-byte stride, skin keys append at 4/5, color lands at 13, and packing interleaves in canonical order.',
  run(checks) {
    const base = deriveVertexBufferLayout(DEFAULT_VERTEX_ATTRIBUTE_MAP)[0];
    checks.equal('default stride', base?.arrayStride, 48);
    checks.equal(
      'default attributes',
      base?.attributes.map((a) => [a.shaderLocation, a.offset, a.format]),
      [
        [0, 0, 'float32x3'],
        [1, 12, 'float32x3'],
        [2, 24, 'float32x2'],
        [3, 32, 'float32x4'],
      ],
    );

    const skin = deriveVertexBufferLayout(SKIN_VERTEX_ATTRIBUTE_MAP)[0];
    checks.equal(
      'skin keys append at locations 4/5',
      skin?.attributes.slice(4).map((a) => [a.shaderLocation, a.offset, a.format]),
      [
        [4, 48, 'uint16x4'],
        [5, 56, 'float32x4'],
      ],
    );
    checks.equal('skin stride', skin?.arrayStride, 72);

    const empty = new Float32Array(0);
    const sparse = deriveVertexBufferLayout({ position: empty, color: empty })[0];
    checks.equal(
      'absent keys reserve no space',
      sparse?.attributes.map((a) => [a.shaderLocation, a.offset]),
      [
        [0, 0],
        [13, 12],
      ],
    );
    checks.equal('sparse stride', sparse?.arrayStride, 28);

    const projection = deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP);
    checks.ok(
      'projection digest is versioned',
      projection.digest.startsWith('vlp-v1-'),
      projection.digest,
    );
    checks.equal(
      'projection digest is stable',
      deriveVertexLayoutProjection({ ...DEFAULT_VERTEX_ATTRIBUTE_MAP }).digest,
      projection.digest,
    );
    const fromMask = deriveVertexLayoutProjectionFromMask(projection.mask);
    checks.equal(
      'mask round-trips to the same digest',
      fromMask.ok ? fromMask.value.digest : fromMask.error.code,
      projection.digest,
    );
    const badMask = deriveVertexLayoutProjectionFromMask(0);
    checks.equal(
      'empty mask is a structured error',
      badMask.ok ? 'ok' : badMask.error.code,
      'vertex-layout-mask-invalid',
    );

    const packed = packInterleavedVertexAttributes(
      {
        position: new Float32Array([1, 2, 3, 4, 5, 6]),
        uv: new Float32Array([0.25, 0.5, 0.75, 1]),
      },
      2,
    );
    checks.equal(
      'pack interleaves position then uv',
      packed.ok ? Array.from(packed.value.vertices) : packed.error.code,
      [1, 2, 3, 0.25, 0.5, 4, 5, 6, 0.75, 1],
    );
    const mismatch = packInterleavedVertexAttributes({ position: new Float32Array(5) }, 2);
    checks.equal(
      'cardinality mismatch is asset-invalid-value',
      mismatch.ok ? 'ok' : mismatch.error.code,
      'asset-invalid-value',
    );
  },
});
