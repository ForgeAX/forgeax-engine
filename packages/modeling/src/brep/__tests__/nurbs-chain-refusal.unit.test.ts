import { describe, expect, it } from 'vitest';
import { refuseOpenChain } from '../nurbs-chain';
import { joinBranches } from '../query/stitch';

describe('NURBS open chains', () => {
  it('refuses a gap chain with brep-ssi-unsupported and reason gap-over-tol', () => {
    // Two branches whose ends are 0.5 apart: no end matches within eps, so the chain has a gap.
    const chains = joinBranches(
      [
        {
          closed: false,
          ends: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
        {
          closed: false,
          ends: [
            [1.5, 0, 0],
            [2, 0, 0],
          ],
        },
      ],
      1e-6,
    );
    const first = chains[0];
    if (first === undefined) throw new Error('no chain');
    const r = refuseOpenChain(first);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.detail).toMatchObject({ brep: 'brep-ssi-unsupported' });
    expect(r.error.detail).toMatchObject({ reason: 'gap-over-tol' });
  });
});
