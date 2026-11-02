import { describe, expect, it } from 'vitest';
import { add, cross, dot, length, normalize, scale, sub, type Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { regen } from '../regen';
import { sel } from '../selectors';
import { faceSizes } from './contract';

const R = 0.05;

interface Net {
  readonly nodes: Tuple3[];
  readonly edges: [number, number][];
}

const TEE: Net = {
  nodes: [
    [0, 0, 0],
    [0.5, 0, 0],
    [-0.5, 0, 0],
    [0, 0.5, 0],
  ],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
  ],
};

const CROSS: Net = {
  nodes: [
    [0, 0, 0],
    [0.5, 0, 0],
    [-0.5, 0, 0],
    [0, 0.5, 0],
    [0, -0.5, 0],
  ],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
  ],
};

const FIVE: Net = {
  nodes: [
    [0, 0, 0],
    [0.5, 0, 0],
    [-0.5, 0, 0],
    [0, 0.5, 0],
    [0, -0.5, 0],
    [0, 0, 0.5],
  ],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [0, 5],
  ],
};

const Y: Net = {
  nodes: [
    [0, 0, 0],
    [0, 0.5, 0],
    [0.433, -0.25, 0],
    [-0.433, -0.25, 0],
  ],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
  ],
};

function build(net: Net, extra: object = {}): { m: Model; ok: boolean } {
  const m = model();
  const report = m.pipeNetwork({ nodes: net.nodes, edges: net.edges, radius: R, ...extra });
  return { m, ok: report.status === 'ok' };
}

/** Distances from the axis of the intersection points of the mesh with a plane through `at` normal to `axis`. */
function sectionRadii(m: Model, at: Tuple3, axis: Tuple3): number[] {
  const mesh = m.editMesh;
  const out: number[] = [];
  const signed = (v: number) => dot(sub(mesh.position(v), at), axis);
  for (const e of mesh.edges()) {
    const a = mesh.hVert[e * 2] as number;
    const b = mesh.hVert[e * 2 + 1] as number;
    const da = signed(a);
    const db = signed(b);
    if (!((da <= 0 && db > 0) || (da > 0 && db <= 0))) continue;
    const t = da / (da - db);
    const p = add(mesh.position(a), scale(sub(mesh.position(b), mesh.position(a)), t));
    const rel = sub(p, at);
    const radial = sub(rel, scale(axis, dot(rel, axis)));
    const r = length(radial);
    if (r < 1.6 * R) out.push(r);
  }
  return out;
}

function deviation(radii: readonly number[]): number {
  return Math.max(...radii.map((r) => Math.abs(r - R) / R));
}

describe('pipeNetwork', () => {
  for (const [name, net] of [
    ['tee', TEE],
    ['cross', CROSS],
    ['5-way', FIVE],
    ['Y', Y],
  ] as const) {
    it(`builds an all-quad manifold watertight ${name}`, () => {
      const { m, ok: built } = build(net);
      expect(built).toBe(true);
      const sizes = faceSizes(m.editMesh);
      expect(Object.keys(sizes)).toEqual(['4']);
      const report = m.validate({ watertight: true });
      expect(report.closed).toBe(true);
      expect(report.pass).toBe(true);
      expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    });
  }

  it('labels every node and strut and gives them roles', () => {
    const { m } = build(CROSS);
    const mesh = m.editMesh;
    const labels = new Set(mesh.faces().map((f) => mesh.labelNames[mesh.fLabel[f] as number]));
    expect(labels).toEqual(
      new Set([
        'node:0',
        'strut:0',
        'strut:1',
        'strut:2',
        'strut:3',
        'node:1',
        'node:2',
        'node:3',
        'node:4',
      ]),
    );
    const roles = new Set(mesh.faces().map((f) => mesh.roleNames[mesh.fRole[f] as number]));
    expect(roles).toEqual(new Set(['node', 'strut', 'cap']));
  });

  it('keeps the section radius within 3 % along every strut of the tee, cross and 5-way', () => {
    for (const net of [TEE, CROSS, FIVE]) {
      const { m } = build(net);
      for (const [i, j] of net.edges) {
        const from = net.nodes[i] as Tuple3;
        const to = net.nodes[j] as Tuple3;
        const u = normalize(sub(to, from));
        const len = length(sub(to, from));
        for (const s of [0.3, 0.5, 0.7]) {
          const at = add(from, scale(u, len * s));
          expect(deviation(sectionRadii(m, at, u))).toBeLessThanOrEqual(0.03);
        }
        for (const s of [0.24, 0.3]) {
          const at = add(from, scale(u, s));
          const radii = sectionRadii(m, at, u);
          expect(radii.length).toBeGreaterThanOrEqual(8);
          expect(deviation(radii)).toBeLessThanOrEqual(0.03);
        }
      }
    }
  });

  it('is deterministic and also builds with finer rings and two levels', () => {
    const a = build(TEE).m.snapshot();
    const b = build(TEE).m.snapshot();
    expect(a).toEqual(b);
    const fine = build(TEE, { ringSegments: 12, levels: 2 });
    expect(fine.ok).toBe(true);
    expect(fine.m.validate({ watertight: true }).pass).toBe(true);
  });

  it('refuses branches closer than 15 degrees with a structured error', () => {
    const m = model();
    const report = m.pipeNetwork({
      nodes: [
        [0, 0, 0],
        [0.5, 0, 0],
        [0.5, 0.1, 0],
      ],
      edges: [
        [0, 1],
        [0, 2],
      ],
      radius: R,
    });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('model-precondition');
    expect(report.error?.detail?.reason).toBe('branch-angle');
    expect(report.error?.detail?.node).toBe(0);
    expect(m.editMesh.faceCount).toBe(0);
  });

  it('accepts branches just over 15 degrees without self-intersection', () => {
    const angle = (16 * Math.PI) / 180;
    const { m, ok: built } = build({
      nodes: [
        [0, 0, 0],
        [1, 0, 0],
        [Math.cos(angle), Math.sin(angle), 0],
      ],
      edges: [
        [0, 1],
        [0, 2],
      ],
    });
    expect(built).toBe(true);
    expect(m.validate({ watertight: true }).pass).toBe(true);
    expect(m.validate().issues.filter((i) => i.code === 'self-intersection')).toEqual([]);
  });

  it('rejects malformed graphs, short struts and crossing struts', () => {
    const cases: [string, Net, string][] = [
      ['edge-index', { nodes: [[0, 0, 0]], edges: [[0, 1]] }, 'model-invalid-argument'],
      [
        'self-edge',
        {
          nodes: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          edges: [
            [0, 0],
            [0, 1],
          ],
        },
        'model-invalid-argument',
      ],
      [
        'duplicate-edge',
        {
          nodes: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          edges: [
            [0, 1],
            [1, 0],
          ],
        },
        'model-invalid-argument',
      ],
      [
        'unused-node',
        {
          nodes: [
            [0, 0, 0],
            [1, 0, 0],
            [2, 2, 2],
          ],
          edges: [[0, 1]],
        },
        'model-invalid-argument',
      ],
      [
        'edge-short',
        {
          nodes: [
            [0, 0, 0],
            [0.06, 0, 0],
          ],
          edges: [[0, 1]],
        },
        'model-precondition',
      ],
      [
        'strut-collision',
        {
          nodes: [
            [0, 0, 0],
            [1, 0, 0],
            [0.5, -0.5, 0.02],
            [0.5, 0.5, 0.02],
          ],
          edges: [
            [0, 1],
            [2, 3],
          ],
        },
        'model-precondition',
      ],
    ];
    for (const [reason, net, code] of cases) {
      const m = model();
      const report = m.pipeNetwork({ nodes: net.nodes, edges: net.edges, radius: R });
      expect(report.status, reason).toBe('failed');
      expect(report.error?.code, reason).toBe(code);
      if (code === 'model-precondition') expect(report.error?.detail?.reason, reason).toBe(reason);
      expect(m.editMesh.faceCount, reason).toBe(0);
    }
    const m = model();
    expect(m.pipeNetwork({ nodes: TEE.nodes, edges: TEE.edges, radius: 0 }).status).toBe('failed');
    const n = model();
    expect(
      n.pipeNetwork({ nodes: TEE.nodes, edges: TEE.edges, radius: R, ringSegments: 5 }).status,
    ).toBe('failed');
  });

  it('reports the measured section deviation as a diagnostic', () => {
    const m = model();
    const report = m.pipeNetwork({ nodes: TEE.nodes, edges: TEE.edges, radius: R });
    const info = report.diagnostics?.find((d) => d.message.includes('section radius'));
    expect(info).toBeDefined();
    expect(Number(info?.detail?.maxDeviation)).toBeLessThanOrEqual(0.03);
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });
});

function radiiAt(m: Model, at: Tuple3, axis: Tuple3, reach: number): number[] {
  const mesh = m.editMesh;
  const out: number[] = [];
  const signed = (v: number) => dot(sub(mesh.position(v), at), axis);
  for (const e of mesh.edges()) {
    const a = mesh.hVert[e * 2] as number;
    const b = mesh.hVert[e * 2 + 1] as number;
    const da = signed(a);
    const db = signed(b);
    if (!((da <= 0 && db > 0) || (da > 0 && db <= 0))) continue;
    const p = add(mesh.position(a), scale(sub(mesh.position(b), mesh.position(a)), da / (da - db)));
    const rel = sub(p, at);
    const r = length(sub(rel, scale(axis, dot(rel, axis))));
    if (r < reach) out.push(r);
  }
  return out;
}

const MEAN = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Trunk of radius R and two branches of R / 2. */
const FORK = { edgeRadius: [R, R / 2, R / 2] };

describe('pipeNetwork unequal radii', () => {
  it('builds a 1:2 Y-branch all-quad, manifold, watertight and without self-intersection', () => {
    const { m, ok: built } = build(Y, FORK);
    expect(built).toBe(true);
    expect(Object.keys(faceSizes(m.editMesh))).toEqual(['4']);
    const report = m.validate({ watertight: true });
    expect(report.closed).toBe(true);
    expect(report.pass).toBe(true);
    expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('measures each strut at its own radius, 3 % at the sampled sections', () => {
    const { m } = build(Y, FORK);
    for (const [e, [i, j]] of Y.edges.entries()) {
      const from = Y.nodes[i] as Tuple3;
      const to = Y.nodes[j] as Tuple3;
      const u = normalize(sub(to, from));
      const want = (FORK.edgeRadius as number[])[e] as number;
      for (const s of [0.3, 0.4]) {
        const radii = radiiAt(m, add(from, scale(u, s)), u, 1.6 * want);
        expect(radii.length).toBeGreaterThanOrEqual(8);
        expect(Math.max(...radii.map((r) => Math.abs(r - want) / want))).toBeLessThanOrEqual(0.03);
      }
    }
  });

  it('tapers a strut monotonically between its two end radii', () => {
    const net = TEE;
    const { m, ok: built } = build(net, { edgeRadius: [[R, R / 2], R, R] });
    expect(built).toBe(true);
    const from = net.nodes[0] as Tuple3;
    const u: Tuple3 = [1, 0, 0];
    const means: number[] = [];
    for (const s of [0.18, 0.22, 0.26, 0.3, 0.34, 0.38, 0.42]) {
      means.push(MEAN(radiiAt(m, add(from, scale(u, s)), u, 1.6 * R)));
    }
    for (let k = 1; k < means.length; k++) {
      expect(means[k] as number).toBeLessThan((means[k - 1] as number) + 1e-9);
    }
    expect((means[0] as number) / (means[means.length - 1] as number)).toBeGreaterThan(1.3);
    expect(m.validate({ watertight: true }).pass).toBe(true);
  });

  it('derives strut ends from nodeRadius and lets edgeRadius override them', () => {
    const tapered = build(Y, { nodeRadius: [R, R, R / 2, R / 2] });
    expect(tapered.ok).toBe(true);
    const slim = (j: number) => {
      const u = normalize(sub(Y.nodes[j] as Tuple3, Y.nodes[0] as Tuple3));
      return MEAN(radiiAt(tapered.m, add(Y.nodes[0] as Tuple3, scale(u, 0.4)), u, 1.6 * R));
    };
    expect(slim(1)).toBeGreaterThan(0.95 * R);
    expect(slim(1)).toBeLessThan(1.05 * R);
    expect(slim(2)).toBeLessThan(0.62 * R);
    const over = build(Y, { nodeRadius: [R, R, R / 2, R / 2], edgeRadius: [R, R / 2, R / 2] });
    expect(over.m.snapshot()).toEqual(build(Y, FORK).m.snapshot());
  });

  it('is byte-identical to the one-radius build when every radius equals radius', () => {
    const plain = build(TEE).m.snapshot();
    expect(build(TEE, { nodeRadius: [R, R, R, R] }).m.snapshot()).toEqual(plain);
    expect(build(TEE, { edgeRadius: [R, [R, R], R] }).m.snapshot()).toEqual(plain);
  });

  it('is deterministic with unequal radii', () => {
    expect(build(Y, FORK).m.snapshot()).toEqual(build(Y, FORK).m.snapshot());
  });

  it('keeps labels, roles and per-label face counts when the radii change (regen)', () => {
    const job = (scaleBy: number) => {
      const m = model();
      m.pipeNetwork({
        nodes: Y.nodes.map((p) => scale(p, scaleBy)),
        edges: Y.edges,
        radius: R * scaleBy,
        edgeRadius: [R * scaleBy, (R / 2) * scaleBy, (R / 2) * scaleBy],
      });
      m.extrude(sel.createdBy('node:1', 'cap'), { distance: 0.02, region: 'merged', label: 'tip' });
      return m;
    };
    const result = regen(job, [1, 0.8, 1.2]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings.map((f) => f.message)).toEqual([]);
    const count = (scaleBy: number) => {
      const m = build(Y, {
        edgeRadius: [R * scaleBy, (R / 2) * scaleBy, (R / 2) * scaleBy],
      }).m;
      const mesh = m.editMesh;
      const per: Record<string, number> = {};
      for (const f of mesh.faces()) {
        const key = `${mesh.labelNames[mesh.fLabel[f] as number]}/${mesh.roleNames[mesh.fRole[f] as number]}`;
        per[key] = (per[key] ?? 0) + 1;
      }
      return per;
    };
    expect(count(0.8)).toEqual(count(1.2));
  });

  it('keeps mirrored arms equal: bounds, arm sections and face area balance across the mirror plane', () => {
    const { m } = build(Y, FORK);
    const mesh = m.editMesh;
    const faces = mesh.faces();
    const xs = faces.flatMap((f) => mesh.faceVertices(f).map((v) => mesh.position(v)[0] as number));
    expect(Math.abs(Math.max(...xs) + Math.min(...xs))).toBeLessThan(1e-9);
    const section = (j: number, s: number) => {
      const u = normalize(sub(Y.nodes[j] as Tuple3, Y.nodes[0] as Tuple3));
      return MEAN(radiiAt(m, add(Y.nodes[0] as Tuple3, scale(u, s)), u, 1.6 * R));
    };
    for (const s of [0.3, 0.4]) expect(Math.abs(section(2, s) - section(3, s))).toBeLessThan(1e-6);
    let left = 0;
    let right = 0;
    for (const f of faces) {
      const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
      let area = 0;
      for (let k = 1; k + 1 < loop.length; k++) {
        const a = loop[0] as Tuple3;
        area += length(cross(sub(loop[k] as Tuple3, a), sub(loop[k + 1] as Tuple3, a))) / 2;
      }
      const cx = loop.reduce((t, p) => t + (p[0] as number), 0) / loop.length;
      if (cx > 0) right += area;
      else left += area;
    }
    expect(Math.abs(left - right) / (left + right)).toBeLessThan(0.03);
  });

  it('rejects malformed radius lists with model-invalid-argument', () => {
    const bad: object[] = [
      { nodeRadius: [R, R] },
      { nodeRadius: [R, R, 0, R] },
      { edgeRadius: [R, R] },
      { edgeRadius: [R, R, -R] },
      { edgeRadius: [R, [R], R] },
      { edgeRadius: [R, [R, Number.NaN], R] },
    ];
    for (const extra of bad) {
      const m = model();
      const report = m.pipeNetwork({ nodes: TEE.nodes, edges: TEE.edges, radius: R, ...extra });
      expect(report.status, JSON.stringify(extra)).toBe('failed');
      expect(report.error?.code, JSON.stringify(extra)).toBe('model-invalid-argument');
      expect(m.editMesh.faceCount).toBe(0);
    }
  });

  it('applies the clearance checks at the strut radius', () => {
    const net: Net = {
      nodes: [
        [0, 0, 0],
        [1, 0, 0],
        [0.5, -0.5, 0.09],
        [0.5, 0.5, 0.09],
      ],
      edges: [
        [0, 1],
        [2, 3],
      ],
    };
    expect(build(net, { edgeRadius: [R / 2, R / 2] }).ok).toBe(true);
    const m = model();
    const report = m.pipeNetwork({ ...net, radius: R, edgeRadius: [R, 2 * R] });
    expect(report.status).toBe('failed');
    expect(report.error?.detail?.reason).toBe('strut-collision');
    expect(m.editMesh.faceCount).toBe(0);
  });

  it('keeps the 15 degree branch rule with unequal radii', () => {
    const m = model();
    const report = m.pipeNetwork({
      nodes: [
        [0, 0, 0],
        [0.5, 0, 0],
        [0.5, 0.1, 0],
      ],
      edges: [
        [0, 1],
        [0, 2],
      ],
      radius: R,
      edgeRadius: [R, R / 2],
    });
    expect(report.error?.detail?.reason).toBe('branch-angle');
  });
});
