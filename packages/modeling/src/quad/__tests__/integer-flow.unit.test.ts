import { describe, expect, it } from 'vitest';
import {
  bracket,
  brepSphere,
  brepTorus,
  chamferBox,
  flangedTee,
  lumpy,
} from '../../../examples/quad-field/models';
import { alignedPositionField } from '../../../examples/quad-flow/aligned-field';
import { solveIntegerOffsets } from '../integer-flow';
import type { TriMesh } from '../trimesh';

function solve(mesh: TriMesh, flowDisabled = false) {
  const result = solveIntegerOffsets(alignedPositionField(mesh), { flowDisabled, maxCapacity: 64 });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe('QuadriFlow integer offset consistency', () => {
  const cases: readonly [string, () => TriMesh][] = [
    ['sphere', brepSphere],
    ['torus', brepTorus],
    ['lumpy sphere', lumpy],
    ['chamfer box', chamferBox],
    ['bracket', bracket],
    ['flanged tee', flangedTee],
  ];

  for (const [name, make] of cases) {
    it(`${name}: flow removes all triangle charge and retains a valid edge table`, () => {
      const { offsets, report } = solve(make());
      expect(offsets).toHaveLength(report.edges);
      expect(report.finalChargeL1).toBe(0);
      expect(report.finalSingularities).toBe(0);
      expect(report.edges).toBeGreaterThan(0);
      expect(report.boundaryEdges).toBe(0);
    });
  }

  it('flow-disabled falsifier preserves nonzero triangle charge while flow eliminates it', () => {
    const mesh = brepSphere();
    const input = alignedPositionField(mesh, 0.1, 0.037);
    const raw = solveIntegerOffsets(input, { flowDisabled: true });
    const fixed = solveIntegerOffsets(input, { maxCapacity: 64 });
    if (!raw.ok || !fixed.ok) throw new Error('falsifier fixture must be solvable');
    expect(raw.value.report.initialChargeL1).toBeGreaterThan(0);
    expect(fixed.value.report.finalChargeL1).toBe(0);
    expect(fixed.value.report.finalSingularities).toBeLessThan(
      raw.value.report.initialSingularities,
    );
  });

  it('returns structured partial for an insufficient capacity bound', () => {
    const result = solveIntegerOffsets(alignedPositionField(brepTorus()), { maxCapacity: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.detail).toMatchObject({ reason: 'integer-flow-capacity-range' });
  });
});
