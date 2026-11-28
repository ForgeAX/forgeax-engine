import { describe, expect, it } from 'vitest';
import { MODELING_ERROR_HINTS } from '../../errors';
import { box } from '../build';
import { quadrangulate } from '../quad';
import { BREP_HINTS, type BrepDetailCode, brepError } from '../types';

const CODES: readonly BrepDetailCode[] = [
  'brep-bad-argument',
  'brep-pcurve-unsupported',
  'brep-tol-exceeded',
  'brep-index-range',
  'brep-loop-open',
  'brep-edge-use',
  'brep-pcurve-mismatch',
  'brep-vertex-mismatch',
  'brep-orientation',
  'brep-face-unsupported',
  'brep-quad-unsupported-source',
  'brep-seam-mismatch',
  'brep-self-intersection',
  'brep-ssi-tangent',
  'brep-ssi-coincident',
  'brep-ssi-unsupported',
];

describe('B-rep detail hints', () => {
  it('lists every BrepDetailCode with a non-empty hint that differs from the outer generic hint', () => {
    expect(Object.keys(BREP_HINTS).sort()).toEqual([...CODES].sort());
    for (const code of CODES) {
      const hint = BREP_HINTS[code];
      expect(hint.trim().length, code).toBeGreaterThan(0);
      const outer = brepError(code, 'a value').code;
      expect(hint, code).not.toBe(MODELING_ERROR_HINTS[outer]);
    }
  });

  it('carries the B-rep hint on the error built by brepError', () => {
    const error = brepError('brep-loop-open', 'edges that chain head to tail');
    expect(error.hint).toBe(BREP_HINTS['brep-loop-open']);
  });

  it('reports the quad source hint end to end from a real refused call', () => {
    const shape = box({ size: [1, 1, 1] });
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    const result = quadrangulate(shape.value, { size: 0.5, source: 'merge' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.brep).toBe('brep-quad-unsupported-source');
    expect(result.error.hint).toBe(BREP_HINTS['brep-quad-unsupported-source']);
  });
});
