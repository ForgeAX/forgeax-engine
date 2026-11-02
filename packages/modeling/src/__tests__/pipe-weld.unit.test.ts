import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { regen } from '../regen';
import { sel } from '../selectors';

const R = 0.1;
const RB = 0.07;
const RHO = 0.01;
const APOTHEM = Math.cos(Math.PI / 16);

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
  edgeRadius: [R, R, RB],
};

const CROSS = {
  nodes: [...TEE.nodes, [0, -1, 0]] as Tuple3[],
  edges: [...TEE.edges, [1, 4]] as [number, number][],
  edgeRadius: [R, R, RB, RB],
};

function weld(net: object, extra: object = {}, radius = RHO) {
  const m = model();
  const report = m.pipeNetwork({
    radius: R,
    ...net,
    weld: { radius, segments: 4, ...extra },
  } as never);
  return { m, report };
}

function names(m: Model) {
  const mesh = m.editMesh;
  const per: Record<string, number> = {};
  for (const f of mesh.faces()) {
    const key = `${mesh.labelNames[mesh.fLabel[f] as number]}/${mesh.roleNames[mesh.fRole[f] as number]}`;
    per[key] = (per[key] ?? 0) + 1;
  }
  return per;
}

function manifold(m: Model) {
  const mesh = m.editMesh;
  return mesh.edges().every((e) => !mesh.isBoundaryEdge(e));
}

describe('pipeNetwork weld (hard joint)', () => {
  it('welds a tee watertight and manifold with weld, strut and node labels', () => {
    const { m, report } = weld(TEE);
    expect(report.status).toBe('ok');
    expect(m.validate({ watertight: true }).pass).toBe(true);
    expect(manifold(m)).toBe(true);
    const per = names(m);
    expect(Object.keys(per).some((k) => k.startsWith('weld:1/'))).toBe(true);
    expect(Object.keys(per).some((k) => k.startsWith('strut:2/'))).toBe(true);
    expect(per['node:0/cap']).toBe(1);
    expect(per['node:3/cap']).toBe(1);
  });

  it('welds a cross and a mitered bend watertight', () => {
    const cross = weld(CROSS);
    expect(cross.report.status).toBe('ok');
    expect(cross.m.validate({ watertight: true }).pass).toBe(true);
    const bend = weld({
      nodes: [
        [-1, 0, 0],
        [0, 0, 0],
        [0.7, 0.7, 0],
      ],
      edges: [
        [0, 1],
        [1, 2],
      ],
    });
    expect(bend.report.status).toBe('ok');
    expect(bend.m.validate({ watertight: true }).pass).toBe(true);
  });

  it('rolls the fillet at the requested radius in the symmetry plane (within 5 %)', () => {
    const { m } = weld(TEE, {}, 0.01);
    const mesh = m.editMesh;
    const deviations: number[] = [];
    for (const f of mesh.faces()) {
      if (!String(mesh.labelNames[mesh.fLabel[f] as number]).startsWith('weld:')) continue;
      const loop = mesh.faceVertices(f);
      for (let i = 0; i < loop.length; i++) {
        const p = mesh.position(loop[i] as number);
        const q = mesh.position(loop[(i + 1) % loop.length] as number);
        if (!((p[2] <= 0 && q[2] > 0) || (p[2] > 0 && q[2] <= 0))) continue;
        const t = p[2] / (p[2] - q[2]);
        const x = p[0] + (q[0] - p[0]) * t;
        const y = p[1] + (q[1] - p[1]) * t;
        if (y < R * APOTHEM - 1e-9 || Math.abs(x) < 1e-9) continue;
        const d = Math.hypot(x - Math.sign(x) * (RB * APOTHEM + RHO), y - (R * APOTHEM + RHO));
        if (d < 2 * RHO) deviations.push(Math.abs(d - RHO) / RHO);
      }
    }
    expect(deviations.length).toBeGreaterThan(0);
    expect(Math.max(...deviations)).toBeLessThanOrEqual(0.05);
  });

  it('refuses a fillet larger than the smallest tube radius', () => {
    const { report } = weld(TEE, {}, RB * 1.01);
    expect(report.status).toBe('failed');
    if (report.status === 'failed') {
      expect(report.error?.code).toBe('model-precondition');
      expect(report.error?.detail).toMatchObject({ reason: 'weld-radius' });
    }
  });

  it('refuses a fillet the tube facets cannot carry instead of shrinking it', () => {
    const { report } = weld({ ...TEE, edgeRadius: undefined }, { segments: 2 }, 0.05);
    expect(report.status).toBe('failed');
    if (report.status === 'failed') {
      expect(report.error?.detail).toMatchObject({ reason: expect.stringMatching(/^weld-/) });
    }
  });

  it('reports the strip path, and the explicit fallback reason where it does not apply', () => {
    const pathOf = (net: object) =>
      weld(net, {}, 0.01).report.diagnostics?.find((d) => d.detail?.path !== undefined)?.detail;
    expect(pathOf(TEE)).toMatchObject({ path: 'ball' });
    expect(pathOf({ ...TEE, edgeRadius: undefined })).toMatchObject({
      path: 'bevel',
      fallback: 'hub',
    });
  });

  it('refuses branches under 15 degrees with branch-angle, accepts them just over', () => {
    const at = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return {
        nodes: [
          [-1, 0, 0],
          [0, 0, 0],
          [Math.cos(a), Math.sin(a), 0],
          [1, 0, 0],
        ] as Tuple3[],
        edges: [
          [0, 1],
          [1, 2],
          [1, 3],
        ] as [number, number][],
        edgeRadius: [R, RB, R],
      };
    };
    const tight = weld(at(14.5));
    expect(tight.report.status).toBe('failed');
    if (tight.report.status === 'failed') {
      expect(tight.report.error?.detail).toMatchObject({ reason: 'branch-angle' });
    }
    const near = weld(at(16), {}, 0.005);
    if (near.report.status === 'failed') {
      expect(near.report.error?.detail).not.toMatchObject({ reason: 'branch-angle' });
    } else {
      expect(near.m.validate({ watertight: true }).pass).toBe(true);
    }
  });

  it('rejects levels, bad end and bad segments with model-invalid-argument', () => {
    for (const bad of [
      { levels: 2, weld: { radius: 0.01 } },
      { weld: { radius: 0.01, end: 'x' } },
    ]) {
      const m = model();
      const r = m.pipeNetwork({ radius: R, ...TEE, ...bad } as never);
      expect(r.status).toBe('failed');
      if (r.status === 'failed') expect(r.error?.code).toBe('model-invalid-argument');
    }
    expect(weld(TEE, { segments: 0 }).report.status).toBe('failed');
    expect(weld(TEE, {}, -1).report.status).toBe('failed');
  });

  it('is deterministic: identical snapshot bytes', () => {
    expect(weld(CROSS).m.snapshot()).toEqual(weld(CROSS).m.snapshot());
  });

  it('is mirror symmetric in x for a symmetric tee', () => {
    const { m } = weld({
      nodes: [
        [-1, 0, 0],
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ] as Tuple3[],
      edges: TEE.edges,
      edgeRadius: TEE.edgeRadius,
    });
    const mesh = m.editMesh;
    const points = mesh.vertices().map((v) => mesh.position(v));
    let worst = 0;
    for (const p of points) {
      const nearest = Math.min(
        ...points.map((q) => Math.hypot(q[0] + p[0], q[1] - p[1], q[2] - p[2])),
      );
      worst = Math.max(worst, nearest);
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('keeps labels, roles and per-label counts when the size changes (regen)', () => {
    const job = (k: number) => {
      const m = model();
      m.pipeNetwork({
        nodes: TEE.nodes.map((p) => p.map((c) => c * k) as Tuple3),
        edges: TEE.edges,
        radius: R * k,
        edgeRadius: TEE.edgeRadius.map((r) => r * k),
        weld: { radius: RHO * k, segments: 4 },
      });
      m.extrude(sel.createdBy('node:3', 'cap'), { distance: 0.05, region: 'merged', label: 'tip' });
      return m;
    };
    const result = regen(job, [1, 0.8, 1.25]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings.map((f) => f.message)).toEqual([]);
    expect(Object.keys(names(job(0.8))).sort()).toEqual(Object.keys(names(job(1.25))).sort());
  });
});
