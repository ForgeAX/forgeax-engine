import { describe, expect, it } from 'vitest';
import { PATTERN_CASES } from '../../../examples/brep-pattern/render';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { housing } from '../housing';
import { quadrangulate } from '../quad';
import type { Shape } from '../types';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const CASES: { id: string; size: number; shape: () => Shape }[] = [
  {
    id: 'plate-grid3x4',
    size: 5,
    shape: () => (PATTERN_CASES.grid3x4 as () => { shape: Shape })().shape,
  },
  {
    id: 'box-minus-cyl',
    size: 0.25,
    shape: () =>
      must(
        booleanSolids(
          must(box({ size: [2.6, 1, 1], label: 'box' })),
          must(cylinder({ radius: 0.3, height: 3, label: 'cyl' })),
          'difference',
        ),
      ),
  },
  {
    id: 'housing',
    size: 0.25,
    shape: () =>
      must(
        housing({
          size: [2.6, 1, 1],
          bossX: 0.8,
          bossRadius: 0.3,
          bossHeight: 1.6,
          boreRadius: 0.15,
        }),
      ),
  },
];

const REASONS = ['row-front-odd-count', 'no-perfect-matching'];

describe('blossom-row is an all-quad contract: no triangle leftovers (#604, #611)', () => {
  it.each(CASES)('$id: fails closed without fallback, closes all-quad with split-3', {
    timeout: 600_000,
  }, (c) => {
    const shape = c.shape();
    const plain = quadrangulate(shape, { size: c.size, trimmed: 'blossom-row', source: 'boolean' });
    expect(plain.ok).toBe(false);
    if (plain.ok) return;
    expect(REASONS).toContain((plain.error.detail as { reason?: string } | undefined)?.reason);

    const closed = quadrangulate(shape, {
      size: c.size,
      trimmed: 'blossom-row',
      source: 'boolean',
      fallback: 'split-3',
    });
    expect(closed.ok, closed.ok ? '' : JSON.stringify(closed.error)).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.report.triangles).toBe(0);
    expect(closed.value.report.openEdges).toBe(0);
    expect(closed.value.report.nonManifoldEdges).toBe(0);
  });
});
