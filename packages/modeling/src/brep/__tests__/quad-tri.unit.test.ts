import { describe, expect, it } from 'vitest';
import { buildBracket } from '../../../examples/planar-boolean/bracket';
import { quadrangulate } from '../quad';
import { triRaises } from '../quad-tri';
import type { Shape } from '../types';

const pocket = (): Shape => {
  const stage = buildBracket().find((s) => s.name === 'pocket');
  if (stage === undefined) throw new Error('pocket');
  return stage.shape;
};

describe('planar triangles as three quad patches', () => {
  it('raises the shortest edge of a triangle that violates the inequality', () => {
    const shape = pocket();
    // Bracket pocket triangle 24: edges 77, 32, 53 with counts (4, 3, 1) break 4 <= 3 + 1 - 2.
    const counts = new Map<number, number>([
      [77, 4],
      [32, 3],
      [53, 1],
    ]);
    const raises = triRaises(shape, counts);
    expect(raises.get(53)).toBe(3);
    expect(raises.has(77)).toBe(false);
  });

  it('leaves counts that already fit alone', () => {
    const shape = pocket();
    const counts = new Map<number, number>([
      [77, 4],
      [32, 4],
      [53, 4],
    ]);
    expect(triRaises(shape, counts).size).toBe(0);
  });

  it('meshes the bracket gusset triangles with no leftover triangle', () => {
    const stage = buildBracket().find((s) => s.name === 'gusset');
    if (stage === undefined) throw new Error('gusset');
    const r = quadrangulate(stage.shape, { size: 0.8, trimmed: 'quad-dominant', isoQuadric: true });
    if (!r.ok) throw new Error(JSON.stringify(r.error.detail));
    expect(r.value.report.triangles).toBe(0);
    expect(r.value.report.scaledJacobian.min).toBeGreaterThan(0.3);
  });
});
