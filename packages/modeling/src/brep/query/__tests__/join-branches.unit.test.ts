import { describe, expect, it } from 'vitest';
import { type JoinBranch, joinBranches } from '../stitch';

const P = (x: number, y = 0, z = 0) => [x, y, z] as const;

describe('joinBranches', () => {
  it('joins two branches that meet end to end', () => {
    const r = joinBranches(
      [
        { closed: false, ends: [P(0), P(1)] },
        { closed: false, ends: [P(1), P(2)] },
      ],
      1e-6,
    );
    expect(r.length).toBe(1);
    expect(r[0]?.branches.length).toBe(2);
    expect(r[0]?.closed).toBe(false);
  });

  it('reports an unmatched end with its measured gap and gap-over-tol reason', () => {
    const r = joinBranches(
      [
        { closed: false, ends: [P(0), P(1)] },
        { closed: false, ends: [P(1.156), P(2)] },
      ],
      1e-6,
    );
    const open = r.flatMap((c) => c.ends);
    const facing = open.filter((e) => e.point[0] === 1 || e.point[0] === 1.156);
    expect(facing.length).toBe(2);
    for (const e of facing) {
      expect(e.reason).toBe('gap-over-tol');
      expect(e.gap).toBeCloseTo(0.156, 6);
    }
  });

  it('reports a three-way meeting point as junction, never pairing it', () => {
    const r = joinBranches(
      [
        { closed: false, ends: [P(0), P(1)] },
        { closed: false, ends: [P(1), P(2)] },
        { closed: false, ends: [P(1), P(3)] },
      ],
      1e-6,
    );
    const reasons = r.flatMap((c) => c.ends.map((e) => e.reason));
    expect(reasons.filter((x) => x === 'junction').length).toBeGreaterThan(0);
    for (const c of r) expect(c.closed).toBe(false);
  });

  it('keeps a closed branch as its own loop', () => {
    const r = joinBranches([{ closed: true, ends: [P(0), P(0)] } as JoinBranch], 1e-6);
    expect(r).toEqual([{ branches: [0], closed: true, ends: [] }]);
  });
});
