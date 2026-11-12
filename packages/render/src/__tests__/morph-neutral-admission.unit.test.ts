import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import { morphSnapshotFor } from '../render-system-extract-tail';

it('idle morph authoring preserves the source stream; activating and clearing it changes admission', () => {
  const box = createBoxGeometry(1, 1, 1).unwrap();
  const mesh = {
    ...box,
    morphTargets: [
      { position: new Float32Array((box.attributes.position as Float32Array).length).fill(1) },
    ],
  };
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

it('extracts normal-only Morph and rejects a malformed channel before rendering', () => {
  const box = createBoxGeometry(1, 1, 1).unwrap();
  const count = (box.attributes.position as Float32Array).length;
  const mesh = { ...box, morphTargets: [{ normal: new Float32Array(count) }] };
  expect(morphSnapshotFor(mesh, [0.5])?.weights).toEqual(new Float32Array([0.5]));
  expect(
    morphSnapshotFor({ ...mesh, morphTargets: [{ normal: new Float32Array(count - 1) }] }, [0.5]),
  ).toBeUndefined();
});
