import { describe, expect, it } from 'vitest';
import { model } from '../model';

const maxRssMb = () => process.resourceUsage().maxRSS / 1024;

describe('voxel jobs meter memory before allocating it', () => {
  it('a voxel job over a ~9M-sample grid fails on a tiny budget without allocating the grid', () => {
    const m = model({ budget: { work: 1000 } });
    m.box({ size: [1, 1, 1] });
    m.box({ size: [1, 1, 1], center: [0.5, 0.5, 0.5] });
    const before = maxRssMb();
    const r = m.voxel.union(undefined, { voxelSize: 0.0075, radius: 0 });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-work-budget');
    expect(maxRssMb() - before).toBeLessThan(32);
  });
});
