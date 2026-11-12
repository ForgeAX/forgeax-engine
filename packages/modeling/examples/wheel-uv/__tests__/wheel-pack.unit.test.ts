import { type OpReport } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildWheel } from '../wheel';

type Metrics = Record<string, number>;
const metrics = (entry: OpReport) =>
  (entry.diagnostics?.filter((d) => d.severity === 'info').at(-1)?.detail as { metrics: Metrics }).metrics;

describe('C-013 packing efficiency (U39, U42 gates)', () => {
  it('rectified tread strips pack the wheel atlas at >= 0.50 coverage (LSCM arcs: 0.25, falsifier)', { timeout: 120000 }, () => {
    const lscm = buildWheel();
    const before = metrics(lscm.uv.pack({ resolution: 2048, padding: 8 }));
    expect(before.coverage).toBeLessThan(0.3);
    const wheel = buildWheel();
    const unwrap = wheel.uv.unwrap({ method: 'rectify', seams: 'sharp' });
    expect(unwrap.status).toBe('ok');
    const u = metrics(unwrap);
    expect(u.rectified).toBeGreaterThan(900);
    expect(u.areaDistortion).toBeLessThan(1.25);
    const after = metrics(wheel.uv.pack({ resolution: 2048, padding: 8 }));
    expect(after.coverage).toBeGreaterThanOrEqual(0.5);
    expect(wheel.validate({ uniqueUv: true }).issues.filter((i) => i.code === 'uv-overlap')).toEqual([]);
  });
});
