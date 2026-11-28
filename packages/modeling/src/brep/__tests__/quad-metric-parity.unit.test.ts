import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../../../scripts/quad-eval/metrics.ts';
import { box, cylinder, quadrangulate, torus } from '../index';
import type { Shape } from '../types';

type Built = { ok: true; value: Shape } | { ok: false; error: unknown };

function shapeOf(r: Built): Shape {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

// Historical pin from L4 e773fa36; runtime parity is checked against evaluate() below.
const cases = [
  {
    name: 'box',
    shape: shapeOf(box({ size: [1, 1, 1] })),
    size: 0.25,
    meshDigest: '8938c4c0839fae167cb785036cbe5cdc177f4a564f45e35311f337006362af6a',
    historical: { min: 1, mean: 1 },
  },
  {
    name: 'cylinder',
    shape: shapeOf(cylinder({ radius: 0.5, height: 1 })),
    size: 0.05,
    meshDigest: '38bc1e3620790d331f50fed043745f0b9e4edc74ccf43b0be6a63c66aee314db',
    historical: { min: 0.7071067811865472, mean: 0.9936379446401031 },
  },
  {
    name: 'torus',
    shape: shapeOf(torus({ major: 1, minor: 0.3 })),
    size: 0.05,
    meshDigest: 'ccc615a5e4f63e733dd35ffba332fdf861a6d6e374d161a9366c2327d25d4b01',
    historical: { min: 0.9998179222313852, mean: 0.9999082663199463 },
  },
] as const;

describe('quadrangulate scaled Jacobian parity with L4', () => {
  it.each(cases)('$name matches L4 min and mean for the same mesh', ({
    shape,
    size,
    meshDigest,
    historical,
  }) => {
    const result = quadrangulate(shape, { size });
    if (!result.ok) throw new Error(JSON.stringify(result.error));

    const mesh = {
      positions: result.value.mesh.vertices().map((vertex) => result.value.mesh.position(vertex)),
      faces: result.value.mesh.faces().map((face) => result.value.mesh.faceVertices(face)),
    };
    expect(createHash('sha256').update(JSON.stringify(mesh)).digest('hex')).toBe(meshDigest);
    const l4 = evaluate(mesh);
    expect(
      Math.abs(result.value.report.scaledJacobian.min - l4.scaledJacobian.min),
    ).toBeLessThanOrEqual(1e-12);
    expect(
      Math.abs(result.value.report.scaledJacobian.mean - l4.scaledJacobian.mean),
    ).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(l4.scaledJacobian.min - historical.min)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(l4.scaledJacobian.mean - historical.mean)).toBeLessThanOrEqual(1e-12);
  });
});
