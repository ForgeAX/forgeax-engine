import {
  decodeMeshBinary,
  packInterleavedVertexAttributes,
  packMeshBin,
} from '@forgeax/engine/geometry';
import type { MeshAsset, MorphTarget } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const POSITION = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const LIFT = new Float32Array([0, 0, 0.5, 0, 0, -0.75, 0.25, 0, 1]);

function morphMesh(targets: readonly MorphTarget[], weights: Float32Array): MeshAsset | undefined {
  const packed = packInterleavedVertexAttributes({ position: POSITION }, 3);
  if (!packed.ok) return undefined;
  return {
    kind: 'mesh',
    vertices: packed.value.vertices,
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: POSITION },
    aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'Default' }],
    morphTargets: targets,
    morphWeights: weights,
  };
}

export default defineFeature({
  title: 'Binary morph targets (mesh-bin v5)',
  catalog: 'Binary morph targets (mesh-bin v5)',
  kind: 'headless',
  summary:
    'packMeshBin writes mesh-bin v5: morph deltas are target-major binary lanes after the vertex block instead of JSON arrays, and all-zero channels are elided by mask while decode restores them.',
  expect:
    'All checks pass: header version is 5, morphBytes counts only the one non-zero channel, the JSON tail carries masks not arrays, decode round-trips deltas, weights and elided zeros, and nine targets are rejected.',
  run(checks) {
    const mesh = morphMesh(
      [{ position: LIFT }, { position: new Float32Array(9), normal: new Float32Array(9) }],
      new Float32Array([0.25, 1]),
    );
    if (mesh === undefined) {
      checks.ok('fixture mesh packs', false);
      return;
    }
    const bytes = packMeshBin(mesh, 'feature-lab/morph');
    checks.ok('packMeshBin succeeds', bytes.ok, bytes.ok ? undefined : bytes.error.code);
    if (!bytes.ok) return;
    const view = new DataView(bytes.value.buffer, bytes.value.byteOffset, bytes.value.byteLength);
    checks.equal('header version', view.getUint32(0, true), 5);
    checks.equal('morphBytes holds only non-zero lanes', view.getUint32(40, true), LIFT.byteLength);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.value);
    checks.ok('metadata carries morphTargetMasks', text.includes('"morphTargetMasks"'));
    checks.ok('metadata has no JSON morph arrays', !text.includes('"morphTargets"'));

    const decoded = decodeMeshBinary(bytes.value, []);
    checks.ok('decode succeeds', decoded !== undefined);
    checks.equal('target count', decoded?.morphTargets?.length, 2);
    checks.equal(
      'target 0 position',
      Array.from(decoded?.morphTargets?.[0]?.position ?? []),
      Array.from(LIFT),
    );
    checks.equal(
      'elided zero normal restored',
      Array.from(decoded?.morphTargets?.[1]?.normal ?? [1]),
      new Array(9).fill(0),
    );
    checks.equal('weights', Array.from(decoded?.morphWeights ?? []), [0.25, 1]);

    const tooMany = morphMesh(
      Array.from({ length: 9 }, () => ({ position: LIFT })),
      new Float32Array(9),
    );
    const rejected =
      tooMany === undefined ? undefined : packMeshBin(tooMany, 'feature-lab/morph-9');
    checks.equal(
      'more than eight targets rejected',
      rejected === undefined || rejected.ok ? 'ok' : rejected.error.code,
      'mesh-bin-payload-invalid',
    );
  },
});
