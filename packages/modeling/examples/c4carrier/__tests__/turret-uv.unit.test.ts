import { measureUv } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildTurretAsset, unwrapLow } from '../asset';

/** Measured on the same checkout before island hygiene (BK60): the v1.1 chain. */
const BASELINE = { islands: 79, stretch: 1.59, utilization: 0.679, texelsPerMeter: 12.57, thin: 6 };

interface Box {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

describe('C-600 turret UV island hygiene', () => {
  it('has fewer islands, no worse stretch and utilization, and no overlap than the baseline chain', {
    timeout: 600000,
  }, () => {
    const asset = buildTurretAsset();
    const unwrapped = unwrapLow(asset.low);
    const mesh = asset.low.editMesh;
    const measured = measureUv(mesh);
    if (!measured.ok) throw measured.error;
    const boxes = new Map<number, Box>();
    for (const f of mesh.faces()) {
      const id = measured.value.faceIsland[f] as number;
      const box = boxes.get(id) ?? { u0: 1e9, v0: 1e9, u1: -1e9, v1: -1e9 };
      for (const h of mesh.faceHalves(f)) {
        const c = mesh.corner('uv0', h) as Float32Array;
        box.u0 = Math.min(box.u0, c[0] as number);
        box.v0 = Math.min(box.v0, c[1] as number);
        box.u1 = Math.max(box.u1, c[0] as number);
        box.v1 = Math.max(box.v1, c[1] as number);
      }
      boxes.set(id, box);
    }
    const thin = [...boxes.values()].filter((b) => {
      const w = (b.u1 - b.u0) * 1024;
      const h = (b.v1 - b.v0) * 1024;
      return Math.min(w, h) < 6 || Math.max(w, h) / Math.max(1e-9, Math.min(w, h)) >= 6;
    });
    const metrics = (unwrapped.report.diagnostics ?? [])
      .map((d) => d.detail as { metrics?: Record<string, number> } | undefined)
      .find((d) => d?.metrics?.texelsPerMeter !== undefined)?.metrics as Record<string, number>;

    expect(measured.value.islands.length).toBeLessThan(BASELINE.islands);
    expect(Math.max(...measured.value.islands.map((i) => i.stretchLinf))).toBeLessThanOrEqual(
      BASELINE.stretch + 0.005,
    );
    expect(measured.value.flipped).toBe(0);
    expect(measured.value.zeroArea).toBe(0);
    expect(metrics.rectUtilization).toBeGreaterThanOrEqual(BASELINE.utilization);
    expect(metrics.texelsPerMeter).toBeGreaterThanOrEqual(BASELINE.texelsPerMeter);
    expect(thin.length).toBeLessThan(BASELINE.thin);
    expect(unwrapped.overlapPairs.at(-1)).toBe(0);
  });
});
