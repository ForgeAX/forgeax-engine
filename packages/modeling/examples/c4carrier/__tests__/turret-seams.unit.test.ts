import { describe, expect, it } from 'vitest';
import { buildTurretAsset, unwrapLow } from '../asset';

/** Measured at C-BK58 on the unwrapLow chain; the BK50 thin threshold is not moved. */
const MEASURED = { seams: 1688, length: 904.6, hiddenScore: 0.6995, exposed: 59, thin: 2 };

describe('C-BK58 turret seam hidden score', () => {
  it('records the measured score and the two thin islands', { timeout: 600000 }, () => {
    const asset = buildTurretAsset();
    unwrapLow(asset.low);
    const r = asset.low.seamVisibility({ resolution: 1024 });
    if (!r.ok) throw r.error;
    const v = r.value;
    expect(v.seams).toBe(MEASURED.seams);
    expect(v.length).toBeCloseTo(MEASURED.length, 0);
    expect(v.hiddenScore).toBeCloseTo(MEASURED.hiddenScore, 2);
    expect(v.exposed).toBe(MEASURED.exposed);
    const thin = v.byIsland.filter((i) => i.thin);
    expect(thin).toHaveLength(MEASURED.thin);
    // a 2-face mantlet strip and the 34-face apron; both sit mostly under occluders
    expect(thin.map((i) => i.faces).sort((a, b) => a - b)).toEqual([2, 34]);
    for (const i of thin) expect(i.hidden).toBeGreaterThan(0.85);
  });
});
