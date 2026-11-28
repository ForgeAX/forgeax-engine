import { describe, expect, it } from 'vitest';
import { PATTERN_CASES } from '../../../examples/brep-pattern/render';
import { quadrangulate } from '../quad';
import type { Shape } from '../types';

const pattern = (k: string): Shape => (PATTERN_CASES[k] as () => { shape: Shape })().shape;

const CASES: { id: string; size: number; shape: () => Shape }[] = [
  { id: 'flange-bolt6', size: 5, shape: () => pattern('bolt6') },
  { id: 'flange-bolt12', size: 5, shape: () => pattern('bolt12') },
];

describe('blossom-row leftover pairing closes every case all-quad', () => {
  it.each(CASES)('$id: ok with zero triangles, open, non-manifold and folds', (c) => {
    const r = quadrangulate(c.shape(), { size: c.size, trimmed: 'blossom-row', source: 'boolean' });
    expect(r.ok, r.ok ? '' : `code=${r.error.code}`).toBe(true);
    if (!r.ok) return;
    const rep = r.value.report;
    const triangles = r.value.faceQuality.reduce((n, f) => n + f.triangles, 0);
    const folded = r.value.faceQuality.reduce((n, f) => n + f.foldedPairs, 0);
    expect(triangles).toBe(0);
    expect(rep.openEdges).toBe(0);
    expect(rep.nonManifoldEdges).toBe(0);
    expect(folded).toBe(0);
  });
});
