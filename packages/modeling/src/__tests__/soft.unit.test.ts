import { describe, expect, it } from 'vitest';
import { length, sub, type Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

/** A 1 x 1 grid in XY (facing +Z), 20 x 20 quads, centered at the origin. */
function sheet(): Model {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: 20, heightSegments: 20, tag: 'sheet' });
  return m;
}

const centerFaces = () => sel.inBox([-0.051, -0.051, -1], [0.051, 0.051, 1], { by: 'all' });

function snapshotPositions(m: Model): Tuple3[] {
  return m.editMesh.vertices().map((v) => m.editMesh.position(v));
}

function info(r: OpReport): Record<string, unknown> {
  return r.diagnostics?.find((d) => d.severity === 'info')?.detail ?? {};
}

const curves = {
  smooth: (x: number) => x * x * (3 - 2 * x),
  linear: (x: number) => x,
  sharp: (x: number) => x * x,
  constant: () => 1,
} as const;

describe('soft selection (proportional translate / rotate / scale)', () => {
  for (const curve of ['smooth', 'linear', 'sharp', 'constant'] as const) {
    it(`translate with a ${curve} falloff moves each vertex by its weight`, () => {
      const m = sheet();
      const before = snapshotPositions(m);
      const r = m.translate(centerFaces(), [0, 0, 0.2], { falloff: { radius: 0.32, curve } });
      expect(r.status).toBe('ok');
      const after = snapshotPositions(m);
      for (const [v, p] of before.entries()) {
        // The seeds are the 3 x 3 vertices within 0.05 of the center (square): distance
        // to the nearest seed.
        const dx = Math.max(0, Math.abs(p[0]) - 0.05);
        const dy = Math.max(0, Math.abs(p[1]) - 0.05);
        const d = Math.hypot(dx, dy);
        const w = d === 0 ? 1 : d < 0.32 ? curves[curve](1 - d / 0.32) : 0;
        expect((after[v] as Tuple3)[2]).toBeCloseTo(0.2 * w, 12);
      }
      expect(info(r)).toMatchObject({ movedVertices: expect.any(Number) });
    });
  }

  it('connected distance stays on its surface; euclidean jumps a gap', () => {
    const otherMoved = (distance: 'euclidean' | 'connected') => {
      const m = sheet();
      m.plane({
        width: 1,
        height: 1,
        widthSegments: 20,
        heightSegments: 20,
        center: [0, 0, 0.02],
        tag: 'other',
      });
      const mesh = m.editMesh;
      const other = sel.tag('other').toVerts('touching').evaluate(mesh);
      const before = other.map((v) => mesh.position(v));
      m.translate(sel.tag('sheet').and(centerFaces()), [0, 0.05, 0], {
        falloff: { radius: 0.2, distance },
      });
      return other.filter((v, i) => length(sub(mesh.position(v), before[i] as Tuple3)) > 0).length;
    };
    expect(otherMoved('euclidean')).toBeGreaterThan(0);
    expect(otherMoved('connected')).toBe(0);
  });

  it("symmetry 'x' mirrors the selection and the move; plane vertices stay on the plane", () => {
    const m = sheet();
    const right = sel.inBox([0.249, -0.051, -1], [0.351, 0.051, 1], { by: 'all' });
    const r = m.translate(right, [0.05, 0.1, 0.02], {
      falloff: { radius: 0.4, curve: 'linear' },
      symmetry: 'x',
    });
    expect(r.status).toBe('ok');
    expect(info(r)).toMatchObject({ symmetry: 'x', mirrored: 9 });
    const mesh = m.editMesh;
    const at = new Map(mesh.vertices().map((v) => [v, mesh.position(v)]));
    const positions = [...at.values()];
    for (const p of positions) {
      const mirror = positions.find(
        (q) =>
          Math.abs(q[0] + p[0]) < 1e-12 &&
          Math.abs(q[1] - p[1]) < 1e-12 &&
          Math.abs(q[2] - p[2]) < 1e-12,
      );
      expect(mirror, `mirror of ${p}`).toBeDefined();
    }
    const plane = positions.filter((p) => Math.abs(p[0]) < 1e-12);
    expect(plane.length).toBe(21);
    expect(plane.some((p) => p[2] > 0)).toBe(true);
  });

  it('rotate and scale interpolate the angle and the factor by weight', () => {
    const m = sheet();
    const before = snapshotPositions(m);
    const r = m.rotate(centerFaces(), 'z', 90, [0, 0, 0], {
      falloff: { radius: 0.2, curve: 'linear' },
    });
    expect(r.status).toBe('ok');
    const after = snapshotPositions(m);
    for (const [v, p] of before.entries()) {
      const q = after[v] as Tuple3;
      expect(Math.hypot(q[0], q[1])).toBeCloseTo(Math.hypot(p[0], p[1]), 12);
    }
    const s = sheet();
    s.scale(centerFaces(), [2, 2, 1], [0, 0, 0], { falloff: { radius: 0.22, curve: 'constant' } });
    const scaled = snapshotPositions(s);
    for (const [v, p] of before.entries()) {
      const d = Math.hypot(Math.max(0, Math.abs(p[0]) - 0.05), Math.max(0, Math.abs(p[1]) - 0.05));
      const f = d < 0.22 ? 2 : 1;
      expect((scaled[v] as Tuple3)[0]).toBeCloseTo(p[0] * f, 12);
    }
    expect(
      sheet().scale(centerFaces(), [0, 1, 1], [0, 0, 0], { falloff: { radius: 0.1 } }).error?.code,
    ).toBe('model-invalid-argument');
  });

  it('a radius covering everything moves the whole part; a constant curve moves it rigidly', () => {
    const m = sheet();
    const before = snapshotPositions(m);
    m.translate(centerFaces(), [0.1, 0, 0], { falloff: { radius: 10, curve: 'constant' } });
    for (const [v, p] of snapshotPositions(m).entries()) {
      expect(length(sub(p, before[v] as Tuple3))).toBeCloseTo(0.1, 12);
    }
  });

  it('works on vertex selectors; the plain transforms keep their journal and result', () => {
    const a = sheet();
    a.translate(sel.all(), [0, 0, 1]);
    const b = sheet();
    b.translate(sel.all().toVerts('touching'), [0, 0, 1]);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.journal.at(-1)?.args).toEqual({ selector: 'all()', offset: [0, 0, 1] });
    const soft = sheet();
    soft.translate(centerFaces(), [0, 0, 1], { falloff: { radius: 0.1 } });
    expect(soft.journal.at(-1)?.args).toMatchObject({
      offset: [0, 0, 1],
      falloff: { radius: 0.1 },
    });
  });

  it('rejects empty selections and bad options; a zero move has no effect', () => {
    expect(
      sheet().translate(sel.tag('none'), [0, 0, 1], { falloff: { radius: 0.1 } }).error?.code,
    ).toBe('model-selection-empty');
    for (const options of [
      { falloff: { radius: 0 } },
      { falloff: { radius: 0.1, curve: 'cubic' as never } },
      { falloff: { radius: 0.1, distance: 'geodesic' as never } },
      { symmetry: 'y' as never },
    ]) {
      expect(sheet().translate(centerFaces(), [0, 0, 1], options).error?.code).toBe(
        'model-invalid-argument',
      );
    }
    expect(
      sheet().translate(centerFaces(), [0, 0, 0], { falloff: { radius: 0.1 } }).error?.code,
    ).toBe('model-op-no-effect');
    const asymmetric = model();
    asymmetric.plane({
      width: 1,
      height: 1,
      widthSegments: 3,
      heightSegments: 3,
      center: [0.3, 0, 0],
    });
    const warned = asymmetric.translate(sel.all(), [0, 0, 0.1], { symmetry: 'x' });
    expect(
      warned.diagnostics?.some((d) => d.severity === 'warn' && d.message.includes('no mirror')),
    ).toBe(true);
  });

  it('property: random soft moves on a sphere stay valid and deterministic', () => {
    let seed = 9;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    // Six trials cover every curve, both distances and symmetry; a coarse sphere keeps the
    // two builds and the exact validate per trial cheap under a loaded gate.
    for (let trial = 0; trial < 6; trial++) {
      const build = () => {
        const m = model();
        m.sphere({ radius: 0.3, widthSegments: 16, heightSegments: 8 });
        return m;
      };
      const center: Tuple3 = [random() - 0.5, random() - 0.5, random() - 0.5];
      const offset: Tuple3 = [
        (random() - 0.5) * 0.05,
        (random() - 0.5) * 0.05,
        (random() - 0.5) * 0.05,
      ];
      const options = {
        falloff: {
          radius: 0.05 + random() * 0.2,
          curve: (['smooth', 'linear', 'sharp', 'constant'] as const)[trial % 4] ?? 'smooth',
          distance: trial % 2 === 0 ? ('connected' as const) : ('euclidean' as const),
        },
        ...(trial % 3 === 0 ? { symmetry: 'x' as const } : {}),
      };
      const a = build();
      const r = a.translate(sel.near(center, 3), offset, options);
      expect(r.status, `trial ${trial}`).toBe('ok');
      expect(a.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
      const b = build();
      b.translate(sel.near(center, 3), offset, options);
      expect(b.snapshot()).toEqual(a.snapshot());
    }
  });
});
