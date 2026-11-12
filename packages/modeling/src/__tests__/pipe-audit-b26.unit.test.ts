import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { regen } from '../regen';

const R = 0.1;
const TEE = {
  nodes: [
    [-1, 0, 0],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ] as Tuple3[],
  edges: [
    [0, 1],
    [1, 2],
    [1, 3],
  ] as [number, number][],
};

function run(net: object, weld: unknown, radius = R) {
  const m = model();
  const report = m.pipeNetwork({ radius, ...net, weld } as never) as {
    status: string;
    error?: { code: string; detail?: Record<string, unknown>; hint?: string };
  };
  return { m, report };
}

function labels(m: Model) {
  const mesh = m.editMesh;
  const per: Record<string, number> = {};
  for (const f of mesh.faces()) {
    const key = String(mesh.labelNames[mesh.fLabel[f] as number]);
    per[key] = (per[key] ?? 0) + 1;
  }
  return per;
}

describe('pipeNetwork', () => {
  it('A1: a clamped weld reports the largest radius that works and a truthful hint', () => {
    const y = Math.cos((60 * Math.PI) / 180);
    const x = Math.sin((60 * Math.PI) / 180);
    const net = {
      nodes: [
        [0, -1, 0],
        [0, 0, 0],
        [x, y, 0],
        [-x, y, 0],
      ] as Tuple3[],
      edges: [
        [0, 1],
        [1, 2],
        [1, 3],
      ] as [number, number][],
    };
    const { report } = run(net, { radius: 0.03 });
    expect(report.status).toBe('failed');
    expect(report.error?.detail?.reason).toBe('weld-clamp');
    const max = report.error?.detail?.maxRadius as number;
    expect(max).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(0.03);
    expect(report.error?.hint ?? '').not.toMatch(/raise ringSegments/);
    if (max > 0) expect(run(net, { radius: max }).report.status).toBe('ok');
  });

  it('A5: weld faces carry the owning joint on a short branch', () => {
    const a = (18 * Math.PI) / 180;
    const net = {
      nodes: [
        [-1, 0, 0],
        [0, 0, 0],
        [1, 0, 0],
        [0.5 * Math.cos(a), 0.5 * Math.sin(a), 0],
      ] as Tuple3[],
      edges: [
        [0, 1],
        [1, 2],
        [1, 3],
      ] as [number, number][],
    };
    const { m, report } = run(net, { radius: 0.005 }, 0.05);
    if (report.status === 'ok') {
      const per = labels(m);
      expect(per['weld:3']).toBeUndefined();
      expect(per['weld:2']).toBeUndefined();
    }
  });

  it('A6: regen reports a topology flip between parameter sets', () => {
    const r = regen(
      (rb: number) => {
        const m = model();
        m.pipeNetwork({
          ...TEE,
          radius: R,
          edgeRadius: [R, R, rb],
          weld: { radius: 0.01 },
        } as never);
        return m;
      },
      [0.07, 0.1],
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pass).toBe(false);
  });

  it('A7: weld null and non-objects are invalid-argument, not a throw', () => {
    for (const bad of [null, 3, [], 'x']) {
      const { report } = run(TEE, bad);
      expect(report.status).toBe('failed');
      expect(report.error?.code).toBe('model-invalid-argument');
    }
  });

  it('A9: tiny radii get a precise reason', () => {
    const tiny = run(TEE, { radius: 0.01 }, 1e-9).report;
    expect(tiny.error?.detail?.reason).toBe('radius-small');
    const weldTiny = run(TEE, { radius: 1e-9 }).report;
    expect(weldTiny.error?.detail?.reason).toBe('weld-radius-small');
  });

  it('A3: a large weld network is refused up front with its size', () => {
    const n = 4;
    const nodes: Tuple3[] = [];
    const edges: [number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) nodes.push([i, j, 0]);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (i + 1 < n) edges.push([i * n + j, (i + 1) * n + j]);
        if (j + 1 < n) edges.push([i * n + j, i * n + j + 1]);
      }
    const { report } = run({ nodes, edges }, { radius: 0.01 }, 0.08);
    expect(report.error?.detail?.reason).toBe('weld-size');
  });
});
