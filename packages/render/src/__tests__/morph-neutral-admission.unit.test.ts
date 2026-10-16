import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { morphSnapshotFor } from '../render-system-extract-tail';

it('idle morph authoring preserves the source stream; activating and clearing it changes admission', () => {
  const mesh = {
    vertices: new Float32Array(12),
    morphTargets: [{ position: new Float32Array([1, 2, 3]) }],
  } satisfies Pick<MeshAsset, 'vertices' | 'morphTargets'>;
  const weights = new Float32Array([0]);
  expect(morphSnapshotFor(mesh, weights)).toBeUndefined();
  weights[0] = 0.25;
  expect(morphSnapshotFor(mesh, weights)).toMatchObject({
    weights: new Float32Array([0.25]),
    targetCount: 1,
  });
  weights[0] = 0;
  expect(morphSnapshotFor(mesh, weights)).toBeUndefined();
});
