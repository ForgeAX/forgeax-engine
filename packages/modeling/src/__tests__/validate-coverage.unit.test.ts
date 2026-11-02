import { describe, expect, it } from 'vitest';
import type { Drawing } from '../drawing';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { type NurbsCurve, nurbs } from '../nurbs';
import { sel } from '../selectors';
import type { ValidateOptions, ValidationCode } from '../validate';
import { expectConserved, expectFalsifiable } from './fixtures/falsifiable';

interface Input {
  readonly build: () => Model;
  readonly options?: ValidateOptions;
}

const unwrapCurve = (points: Tuple3[], degree?: number): NurbsCurve => {
  const c = nurbs.interpolate(points, degree === undefined ? {} : { degree });
  if (!c.ok) throw c.error;
  return c.value;
};

const box = (size: [number, number, number], center: [number, number, number] = [0, 0, 0]) => {
  const m = model();
  m.box({ size, center });
  return m;
};

const withUv = (m: Model): Model => {
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
};

const clean = (): Model => withUv(box([1, 1, 1]));

const gridPlane = (): Model => {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
  m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
  return m;
};

const corrupt = (edit: (m: Model) => void): Input => ({
  build: () => {
    const m = clean();
    edit(m);
    return m;
  },
});

const sheetDrawing: Drawing = {
  name: 'box sheet',
  views: [{ id: 'side', ortho: 'right' }],
  items: [
    {
      id: 'lost@side',
      view: 'side',
      role: 'feature',
      link: 'missing',
      kind: 'curve',
      curve: {
        kind: 'polyline',
        points: [
          [0, 0],
          [0.1, 0],
        ],
      },
    },
  ],
};

const FALSIFIERS: Readonly<Record<ValidationCode, Input>> = {
  'topology-loop': corrupt((m) => {
    const h = m.editMesh.fHalf[m.editMesh.faces()[0] as number] as number;
    m.editMesh.hPrev[m.editMesh.hNext[h] as number] = m.editMesh.hNext[h] as number;
  }),
  'topology-twin': corrupt((m) => {
    const h = m.editMesh.fHalf[m.editMesh.faces()[0] as number] as number;
    m.editMesh.hVert[h ^ 1] = m.editMesh.addVertex(9, 9, 9);
  }),
  'topology-dead-reference': corrupt((m) => {
    m.editMesh.removeVertex(m.editMesh.faceVertices(m.editMesh.faces()[0] as number)[0] as number);
  }),
  'face-degenerate': corrupt((m) => {
    const loop = m.editMesh.faceVertices(m.editMesh.faces()[0] as number);
    for (const v of loop) m.editMesh.setPosition(v, 0, 0, 0);
  }),
  'face-nonplanar': corrupt((m) => {
    const v = m.editMesh.faceVertices(m.editMesh.faces()[0] as number)[0] as number;
    const [x, y, z] = m.editMesh.position(v);
    m.editMesh.setPosition(v, x + 0.2, y + 0.2, z + 0.2);
  }),
  'mesh-open': { build: gridPlane },
  'mesh-inverted': {
    build: () => {
      const m = clean();
      m.flip(sel.all());
      return m;
    },
  },
  'face-flipped': {
    build: () => {
      const m = model();
      m.polygon({
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
        ],
      });
      m.polygon({
        points: [
          [1, 0, 0],
          [1, 1, 0],
          [2, 1, 0],
          [2, 0, 0],
        ],
      });
      return withUv(m);
    },
  },
  'self-intersection': {
    build: () => {
      const m = box([1, 1, 1]);
      m.append(box([1, 1, 1]), { translate: [0.5, 0.25, 0.25] });
      return withUv(m);
    },
  },
  'shell-overlap': {
    build: () => {
      const m = box([1, 1, 1]);
      m.append(box([1, 1, 1]), { translate: [0.5, 0.25, 0.25] });
      return withUv(m);
    },
    options: { shells: { expected: 1 } },
  },
  'designed-contact': {
    build: () => {
      const m = model();
      m.box({ size: [1, 1, 1], tag: 'a' });
      m.box({ size: [1, 1, 1], center: [3, 0, 0], tag: 'b' });
      return withUv(m);
    },
    options: { contacts: [{ parts: ['a', 'b'] }] },
  },
  't-junction': {
    build: () => {
      const m = model();
      m.polygon({
        points: [
          [0, 0, 0],
          [2, 0, 0],
          [2, 1, 0],
          [0, 1, 0],
        ],
      });
      m.polygon({
        points: [
          [0, 1, 0],
          [1, 1, 0],
          [1, 2, 0],
          [0, 2, 0],
        ],
      });
      m.polygon({
        points: [
          [1, 1, 0],
          [2, 1, 0],
          [2, 2, 0],
          [1, 2, 0],
        ],
      });
      m.weld({ distance: 1e-9 });
      return withUv(m);
    },
  },
  'thin-wall': {
    build: () => {
      const m = box([1, 1, 1]);
      const inner = box([0.996, 0.996, 0.996]);
      inner.flip(sel.all());
      m.append(inner);
      return withUv(m);
    },
    options: { minThickness: 0.005 },
  },
  'isolated-vertex': corrupt((m) => {
    m.editMesh.addVertex(5, 5, 5);
  }),
  'uv-missing': {
    build: () => {
      const m = clean();
      m.extrude(sel.facing('+y'), { distance: 1, region: 'merged' });
      return m;
    },
  },
  'uv-degenerate': {
    build: () => {
      const m = model();
      m.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 8 });
      m.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
      return m;
    },
  },
  'uv-overlap': {
    build: () => {
      const m = model();
      m.plane({ width: 1, height: 1, widthSegments: 3, heightSegments: 3 });
      m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
      const other = model();
      other.plane({ width: 1, height: 1, center: [0.5, 0.5, 1] });
      other.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
      m.append(other);
      return m;
    },
    options: { uniqueUv: true },
  },
  'surface-quality': {
    build: () => {
      const m = clean();
      m.featureLine({
        name: 'wavy',
        curve: unwrapCurve(
          Array.from({ length: 12 }, (_, i): Tuple3 => [i * 0.1, 0, 0.002 * Math.sin(i * 1.3)]),
        ),
      });
      return m;
    },
    options: { surfaceQuality: true },
  },
  'edge-flow': {
    build: () => {
      const m = gridPlane();
      m.featureLine({
        name: 'shoulder',
        curve: unwrapCurve(
          [
            [-0.5, 0.18, 0],
            [0.5, 0.18, 0],
          ],
          1,
        ),
      });
      return m;
    },
    options: { edgeFlow: true },
  },
  'mesh-quality': { build: clean, options: { quality: [{ part: 'missing' }] } },
  'patch-layout': {
    build: () => {
      const m = clean();
      m.patchLayout({ patches: [{ id: 'P', role: 'primary' }] });
      return m;
    },
    options: { layout: true },
  },
  'shut-line': {
    build: clean,
    options: { shutLines: { table: [{ id: 'X', parts: ['ghost-1', 'ghost-2'] }] } },
  },
  bake: {
    build: () => {
      const m = gridPlane();
      m.markSharp(sel.side([0, 0, 0], [1, 0, 0], { by: 'centroid' }).boundary());
      return m;
    },
    options: { bake: true },
  },
  'texel-density': {
    build: () => {
      const m = model();
      m.plane({ width: 1, height: 1 });
      m.uv.project({ mode: 'planar', axis: 'z', scale: 1024 / 205 });
      return m;
    },
    options: { texelDensity: { resolution: 1024, target: 320 } },
  },
  drawing: {
    build: () => {
      const m = clean();
      expect(m.drawing(sheetDrawing).status).toBe('ok');
      return m;
    },
    options: { drawing: true },
  },
};

const run = (input: Input) => {
  const report = input.build().validate({ ...input.options });
  return { ...report, pass: report.pass && report.issues.length === 0 };
};

describe('validate coverage (B32 PR B)', () => {
  it('every validation code has an input that fails it, and the clean twin passes', () => {
    expectFalsifiable<Input, ValidationCode>(run, { build: clean }, FALSIFIERS);
  });

  it('the options that turn a check on appear as unchecked until they are given', () => {
    const report = clean().validate();
    expect(report.pass).toBe(true);
    const off = report.coverage.unchecked
      .filter((u) => u.reason === 'not-requested')
      .map((u) => u.code)
      .sort();
    expect(off).toEqual(
      [
        'bake',
        'drawing',
        'edge-flow',
        'mesh-quality',
        'patch-layout',
        'shell-overlap',
        'shut-line',
        'surface-quality',
        'texel-density',
        'thin-wall',
        'uv-overlap',
      ].sort(),
    );
  });

  it('counts every subject once: checked plus unchecked equals the enumerated total', () => {
    const m = clean();
    const report = m.validate({
      quality: [{ part: 'ghost' }],
      shutLines: {
        table: [
          { id: 'A', parts: ['ghost-1', 'ghost-2'] },
          { id: 'B', parts: ['ghost-3', 'ghost-4'] },
        ],
      },
      contacts: [{ parts: ['x', 'y'] }],
    });
    expectConserved(report.coverage, {
      'topology-loop': 6,
      'face-nonplanar': 6,
      'mesh-quality': 1,
      'shut-line': 2,
      'designed-contact': 1,
      'thin-wall': 1,
    });
    const gate = report.coverage.unchecked.find((u) => u.code === 'mesh-quality');
    expect(gate).toMatchObject({ reason: 'missing-input', subjects: 1, sample: ['ghost'] });
    expect(report.coverage.checked.find((c) => c.code === 'shut-line')).toBeUndefined();
  });

  it('a mesh with no faces checks nothing and never passes', () => {
    const report = model().validate();
    expect(report.coverage.checked.some((c) => c.code === 'topology-loop')).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('degenerate faces are not counted as planar-checked', () => {
    const report = run(FALSIFIERS['face-degenerate']);
    expectConserved(report.coverage, { 'face-nonplanar': 6 });
    const left = report.coverage.unchecked.find((u) => u.code === 'face-nonplanar');
    expect(left?.reason).toBe('unsupported');
    expect(left?.subjects).toBeGreaterThanOrEqual(1);
  });
});
