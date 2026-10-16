import { computeTangentVec4 } from '@forgeax/engine/geometry';
import { defineFeature } from '../../lab/feature';

const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const NORMALS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

export default defineFeature({
  title: 'Tangent generation',
  catalog: 'Tangent generation',
  kind: 'headless',
  summary:
    'computeTangentVec4 derives per-vertex vec4 tangents from positions, normals and UVs; w carries handedness so mirrored UVs still normal-map correctly.',
  expect:
    'All checks pass: a +Z quad with u along +X yields tangent (1,0,0,+1), mirrored UVs flip to (-1,0,0,-1), and malformed input returns asset-parse-failed.',
  run(checks) {
    const plain = computeTangentVec4(
      POSITIONS,
      NORMALS,
      new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      INDICES,
    );
    checks.ok('plain quad succeeds', plain.ok);
    if (plain.ok) {
      checks.equal('output is vertexCount * 4', plain.value.length, 16);
      checks.equal('vertex 0 tangent', Array.from(plain.value.subarray(0, 4)), [1, 0, 0, 1]);
      checks.equal('vertex 2 tangent', Array.from(plain.value.subarray(8, 12)), [1, 0, 0, 1]);
    }

    const mirrored = computeTangentVec4(
      POSITIONS,
      NORMALS,
      new Float32Array([1, 0, 0, 0, 0, 1, 1, 1]),
      INDICES,
    );
    checks.ok('mirrored quad succeeds', mirrored.ok);
    if (mirrored.ok) {
      checks.near('mirrored tangent x', mirrored.value[0] as number, -1);
      checks.equal('mirrored handedness w', mirrored.value[3], -1);
    }

    const shortNormals = computeTangentVec4(
      POSITIONS,
      new Float32Array(3),
      new Float32Array(8),
      INDICES,
    );
    checks.equal(
      'short normals rejected',
      shortNormals.ok ? 'ok' : shortNormals.error.code,
      'asset-parse-failed',
    );
    const badIndex = computeTangentVec4(
      POSITIONS,
      NORMALS,
      new Float32Array(8),
      new Uint16Array([0, 1, 9]),
    );
    checks.equal(
      'out-of-range index rejected',
      badIndex.ok ? 'ok' : badIndex.error.code,
      'asset-parse-failed',
    );
  },
});
