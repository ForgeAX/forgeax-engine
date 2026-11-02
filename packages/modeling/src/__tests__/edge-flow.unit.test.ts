import { describe, expect, it } from 'vitest';
import { projectOverlay } from '../diagnostics';
import { checkEdgeFlow, faceAspect } from '../edge-flow';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { nurbs } from '../nurbs';
import { sel } from '../selectors';

const line = (points: Tuple3[]) => {
  const c = nurbs.interpolate(points, { degree: 1 });
  if (!c.ok) throw c.error;
  return c.value;
};

describe('edge flow', () => {
  it('measures face aspect as the ratio of principal extents', () => {
    const square: Tuple3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ];
    expect(faceAspect(square, [0, 0, 1])).toBeCloseTo(1, 12);
    const long = square.map(([x, y, z]): Tuple3 => [4 * x, y, z]);
    expect(faceAspect(long, [0, 0, 1])).toBeCloseTo(4, 12);
    const equilateral: Tuple3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0.5, Math.sqrt(3) / 2, 0],
    ];
    expect(faceAspect(equilateral, [0, 0, 1])).toBeCloseTo(1, 9);
  });

  it('passes a regular grid whose loop follows the feature line and locates the gap of one that does not', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 8, heightSegments: 8 });
    const on = checkEdgeFlow(m.editMesh, [
      {
        name: 'waist',
        curve: line([
          [-0.5, 0.125, 0],
          [0.5, 0.125, 0],
        ]),
      },
    ]);
    if (!on.ok) throw on.error;
    expect(on.value.featureLoops[0]).toMatchObject({
      coverage: 1,
      chains: 1,
      edges: 8,
      pass: true,
    });
    expect(on.value.quads).toBe(64);
    expect(on.value.poles.count).toBe(0);
    expect(on.value.pass).toBe(true);
    const off = checkEdgeFlow(m.editMesh, [
      {
        name: 'shoulder',
        curve: line([
          [-0.5, 0.18, 0],
          [0.5, 0.18, 0],
        ]),
      },
    ]);
    if (!off.ok) throw off.error;
    expect(off.value.featureLoops[0]?.coverage).toBe(0);
    expect(off.value.issues.map((i) => i.code)).toEqual(['feature-loop']);
    expect(off.value.pass).toBe(false);
  });

  it('reports stretched faces, size jumps, triangles and poles with their locations', () => {
    const m = model();
    m.plane({ width: 1, height: 0.1 });
    m.triangulate(sel.all());
    const report = checkEdgeFlow(m.editMesh, []);
    if (!report.ok) throw report.error;
    expect(report.value.triangles).toBe(2);
    expect(report.value.aspect.over).toBe(2);
    expect(report.value.issues.map((i) => i.code).sort()).toEqual(['aspect', 'triangles']);
    const sphere = model();
    sphere.sphere({ radius: 1, widthSegments: 12, heightSegments: 6 });
    const poles = checkEdgeFlow(sphere.editMesh, []);
    if (!poles.ok) throw poles.error;
    expect(poles.value.poles.byValence['12']).toBe(2);
    expect(checkEdgeFlow(m.editMesh, [], { maxAspect: 0 }).ok).toBe(false);
  });
});

describe('V-wire overlay and validate', () => {
  it('draws every n-gon edge, clipped to a close-up frame', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
    const all = projectOverlay(m.editMesh, 'edges');
    if (!all.ok) throw all.error;
    expect((all.value.mesh.attributes.position as Float32Array).length / 6).toBe(40);
    const close = projectOverlay(m.editMesh, 'edges', [-0.6, -0.6, -1, -0.2, -0.2, 1]);
    if (!close.ok) throw close.error;
    expect((close.value.mesh.attributes.position as Float32Array).length / 6).toBeLessThan(40);
    expect(projectOverlay(m.editMesh, 'edges', [5, 5, 5, 6, 6, 6]).ok).toBe(false);
  });

  it('reports edge-flow findings through validate with their feature line source', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 8, heightSegments: 8 });
    m.featureLine({
      name: 'shoulder',
      curve: line([
        [-0.5, 0.18, 0],
        [0.5, 0.18, 0],
      ]),
    });
    expect(m.validate().issues.some((i) => i.code === 'edge-flow')).toBe(false);
    const report = m.validate({ edgeFlow: true });
    const flow = report.issues.filter((i) => i.code === 'edge-flow');
    expect(flow.map((i) => i.detail.check)).toEqual(['feature-loop']);
    expect(flow[0]).toMatchObject({ severity: 'warn', detail: { line: 'shoulder', opIndex: 1 } });
    expect(m.validate({ edgeFlow: { maxAspect: -1 } }).pass).toBe(false);
  });
});

describe('isoparm export with support loops', () => {
  /** Bicubic patch of z = f(x, y), exact for cubic f. */
  const patch = (x0: number, x1: number, f: (x: number, y: number) => number) => {
    const rows = [0, 1, 2, 3].map((i) =>
      [0, 1, 2, 3].map((j): Tuple3 => {
        const x = x0 + ((x1 - x0) * i) / 3;
        const y = -0.5 + j / 3;
        return [x, y, f(x, y)];
      }),
    );
    const s = nurbs.grid(rows, { parametrization: 'uniform' });
    if (!s.ok) throw s.error;
    return s.value;
  };
  const hood = patch(-0.6, 0, (x, y) => 0.05 * (1 - y * y) + 0.02 * x);
  const fender = patch(0, 0.6, (x, y) => 0.05 * (1 - y * y) - 0.25 * x);
  const crease = nurbs.interpolate(
    [-0.5, -0.25, 0, 0.25, 0.5].map((y): Tuple3 => [0, y, 0.05 * (1 - y * y)]),
  );

  it('keeps quads on the isoparms, follows the crease with an edge loop and tags its support strips', () => {
    if (!crease.ok) throw crease.error;
    const m = model();
    m.surface({
      patches: [
        { name: 'hood', surface: hood, support: { sides: ['u1'], offset: [0.002, 0.004] } },
        { name: 'fender', surface: fender, support: { sides: ['u0'], offset: [0.002, 0.004] } },
      ],
      chord: 0.0005,
      nonPlanar: 'keep',
      spacing: 'even',
    });
    m.featureLine({ name: 'crease', curve: crease.value, continuity: 'G0' });
    const flow = checkEdgeFlow(m.editMesh, m.diagnostics().featureLines);
    if (!flow.ok) throw flow.error;
    expect(flow.value.triangles).toBe(0);
    expect(flow.value.featureLoops[0]).toMatchObject({ coverage: 1, chains: 1, pass: true });
    expect(flow.value.aspect.over).toBe(0);
    expect(flow.value.sizeRatio.max).toBeLessThan(2.05);
    const support = m.count(sel.tag('support'));
    expect(support).toBeGreaterThan(0);
    const adaptive = model();
    adaptive.surface({ patches: [{ surface: hood }, { surface: fender }], chord: 0.0005 });
    const plain = checkEdgeFlow(adaptive.editMesh, []);
    if (!plain.ok) throw plain.error;
    expect(plain.value.triangles + plain.value.aspect.over).toBeGreaterThan(0);
  });

  it('rejects malformed support', () => {
    const m = model();
    const bad = m.surface({
      patches: [{ surface: hood, support: { sides: ['x0' as 'u0'], offset: 0.002 } }],
    });
    expect(bad.error?.code).toBe('model-invalid-argument');
    const far = model().surface({
      patches: [{ surface: hood, support: { sides: ['u0'], offset: 5 } }],
    });
    expect(far.error?.code).toBe('model-precondition');
  });
});
