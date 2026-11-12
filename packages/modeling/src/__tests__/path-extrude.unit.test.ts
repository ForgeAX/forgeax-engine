import { describe, expect, it } from 'vitest';
import { path } from '../curve';
import { faceArea, faceCentroid, length, sub, type Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { isClosed } from '../ops';
import { sel } from '../selectors';

function block(): Model {
  const m = model();
  m.box({ size: [0.2, 0.2, 0.2], tag: 'trunk' });
  return m;
}

const top = () => sel.tag('trunk').and(sel.facing('+y'));

function errors(m: Model) {
  return m.validate().issues.filter((i) => i.severity === 'error');
}

describe('extrude along a path (region, stations)', () => {
  it('a straight path along the normal equals extrude by its length, with one ring per station', () => {
    const a = block();
    const r = a.extrude(top(), {
      path: [
        [0, 0.1, 0],
        [0, 0.2, 0],
        [0, 0.3, 0],
      ],
      label: 'limb',
    });
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({ top: 1, side: 8 });
    const b = block();
    b.extrude(top(), { distance: 0.2, region: 'merged', label: 'limb' });
    const at = (m: Model) =>
      faceCentroid(m.editMesh, sel.createdBy('limb', 'top').evaluate(m.editMesh)[0] as number);
    expect(length(sub(at(a), at(b)))).toBeLessThan(1e-12);
    expect(isClosed(a.editMesh)).toBe(true);
    expect(errors(a)).toEqual([]);
  });

  it('follows a curved path: the end ring sits at the path end, facing along it', () => {
    const m = block();
    const curve = path.catmullRom(
      [
        [0, 0.1, 0],
        [0, 0.3, 0.02],
        [0.1, 0.45, 0.05],
        [0.3, 0.5, 0.05],
      ],
      4,
    );
    const r = m.extrude(top(), { path: curve, label: 'limb' });
    expect(r.status).toBe('ok');
    const mesh = m.editMesh;
    const end = sel.createdBy('limb', 'top').evaluate(mesh)[0] as number;
    const c = faceCentroid(mesh, end);
    expect(length(sub(c, [0.3, 0.5, 0.05]))).toBeLessThan(1e-9);
    expect(faceArea(mesh, end)).toBeCloseTo(0.04, 9);
    expect(isClosed(mesh)).toBe(true);
    expect(errors(m)).toEqual([]);
  });

  it('scale tapers and twist turns the section; per-station lists set each station', () => {
    const m = block();
    m.extrude(top(), {
      path: [
        [0, 0.1, 0],
        [0, 0.2, 0],
        [0, 0.3, 0],
      ],
      scale: [1, 0.25],
      twist: 90,
      label: 'tip',
    });
    const mesh = m.editMesh;
    const end = sel.createdBy('tip', 'top').evaluate(mesh)[0] as number;
    expect(faceArea(mesh, end)).toBeCloseTo(0.04 * 0.0625, 12);
    // A corner of the 0.2 square rotated by 90 degrees about +y stays a corner of the
    // 0.05 square: |x| = |z| = 0.025.
    for (const v of mesh.faceVertices(end)) {
      const [x, , z] = mesh.position(v);
      expect(Math.abs(x)).toBeCloseTo(0.025, 12);
      expect(Math.abs(z)).toBeCloseTo(0.025, 12);
    }
    const listed = block();
    listed.extrude(top(), {
      path: [
        [0, 0.1, 0],
        [0, 0.2, 0],
        [0, 0.3, 0],
      ],
      scale: [1, 1.5, 0.5],
      label: 'bulge',
    });
    const ring = sel.createdBy('bulge', 'side').evaluate(listed.editMesh);
    const widest = Math.max(
      ...ring.flatMap((f) =>
        listed.editMesh.faceVertices(f).map((v) => listed.editMesh.position(v)[0]),
      ),
    );
    expect(widest).toBeCloseTo(0.15, 12);
  });

  it('grows a clump from a curved region (hair from a scalp) and validates', () => {
    const m = model();
    m.sphere({ radius: 0.1, widthSegments: 24, heightSegments: 12, tag: 'scalp' });
    const region = sel
      .tag('scalp')
      .and(sel.inBox([-0.03, 0.09, -0.03], [0.03, 1, 0.03], { by: 'all' }));
    const r = m.extrude(region, {
      path: path.catmullRom(
        [
          [0, 0.1, 0],
          [0.02, 0.16, 0.03],
          [0.06, 0.18, 0.09],
          [0.08, 0.12, 0.14],
        ],
        3,
      ),
      scale: [1, 0.15],
      label: 'clump',
    });
    expect(r.status).toBe('ok');
    expect(isClosed(m.editMesh)).toBe(true);
    expect(errors(m)).toEqual([]);
  });

  it('rejects bad scales and degenerate paths; warns when the path starts against the normal', () => {
    for (const options of [
      {
        path: [
          [0, 0.1, 0],
          [0, 0.2, 0],
          [0, 0.3, 0],
        ] as Tuple3[],
        scale: [1, 0.5, 0.2, 0.1],
      },
      {
        path: [
          [0, 0.1, 0],
          [0, 0.2, 0],
        ] as Tuple3[],
        scale: [1, 0],
      },
      {
        path: [
          [0, 0.1, 0],
          [0, 0.2, 0],
        ] as Tuple3[],
        twist: Number.NaN,
      },
    ]) {
      expect(block().extrude(top(), options).error?.code).toBe('model-invalid-argument');
    }
    expect(
      block().extrude(top(), {
        path: [
          [0, 0.1, 0],
          [0, 0.1, 0],
        ],
      }).error?.code,
    ).toBe('model-degenerate');
    const back = block();
    const r = back.extrude(top(), {
      path: [
        [0, 0.1, 0],
        [0, 0.05, 0],
      ],
    });
    expect(r.diagnostics?.some((d) => d.severity === 'warn' && d.message.includes('against'))).toBe(
      true,
    );
    expect(
      block().extrude(sel.tag('none'), {
        path: [
          [0, 0, 0],
          [0, 1, 0],
        ],
      }).error?.code,
    ).toBe('model-selection-empty');
  });

  it('is deterministic', () => {
    const build = () => {
      const m = block();
      m.extrude(top(), {
        path: path.catmullRom(
          [
            [0, 0.1, 0],
            [0.1, 0.3, 0],
            [0.3, 0.35, 0.1],
          ],
          5,
        ),
        twist: 30,
        scale: [1, 0.5],
      });
      return m.snapshot();
    };
    expect(build()).toEqual(build());
  });
  it('warns when a scale near zero collapses faces', () => {
    const m = block();
    const r = m.extrude(top(), {
      path: [
        [0, 0.1, 0],
        [0, 0.2, 0],
        [0, 0.3, 0],
      ],
      scale: 1e-6,
    });
    expect(r.status).toBe('ok');
    expect(errors(m).length).toBeGreaterThan(0);
    expect(
      r.diagnostics?.some((d) => d.severity === 'warn' && d.message.includes('collapse')),
    ).toBe(true);
  });

  it('warns when a span twists by half a turn or more (B11c P2)', () => {
    const steep = block().extrude(top(), {
      path: [
        [0, 0.1, 0],
        [0, 0.3, 0],
      ],
      twist: 200,
    });
    expect(steep.diagnostics?.some((d) => d.severity === 'warn' && d.message.includes('180'))).toBe(
      true,
    );
    const fine = block().extrude(top(), {
      path: [
        [0, 0.1, 0],
        [0, 0.2, 0],
        [0, 0.3, 0],
        [0, 0.4, 0],
      ],
      twist: 200,
    });
    expect(fine.diagnostics?.some((d) => d.message.includes('180'))).toBe(false);
  });

  it('a labeled extrude tags each span ring (B11c S1)', () => {
    const m = block();
    m.extrude(top(), {
      path: [
        [0, 0.1, 0],
        [0, 0.2, 0],
        [0, 0.3, 0],
        [0, 0.4, 0],
      ],
      label: 'arm',
    });
    for (const k of [0, 1, 2]) expect(m.count(sel.tag(`arm:ring:${k}`))).toBe(4);
    // The middle ring sits between y 0.2 and 0.3.
    const box = m.bounds(sel.tag('arm:ring:1'));
    if (!box.ok) throw box.error;
    expect(box.value.min[1]).toBeCloseTo(0.2, 12);
    expect(box.value.max[1]).toBeCloseTo(0.3, 12);
    // Rings drive a later soft edit: bulge only the middle ring.
    expect(m.scale(sel.tag('arm:ring:1'), [1.3, 1, 1.3], [0, 0.25, 0]).status).toBe('ok');
  });
});

describe('regions whose faces touch only at a vertex (F2 G4 triangle rows)', () => {
  // A 4 x 4 grid triangulated, then a diagonal chain of triangles that meet only at
  // corners: one moved copy of a pinch vertex carried two rungs in one direction.
  function pinched(): Model {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4, tag: 'sheet' });
    m.triangulate(sel.all());
    return m;
  }
  const chain = () =>
    sel
      .near([-0.4, -0.3, 0], 1)
      .or(sel.near([-0.1, -0.05, 0], 1))
      .or(sel.near([0.15, 0.2, 0], 1));

  it('the chain touches only at vertices', () => {
    const m = pinched();
    const mesh = m.editMesh;
    const faces = chain().evaluate(mesh);
    expect(faces).toHaveLength(3);
    const set = new Set(faces);
    for (const f of faces) {
      expect(mesh.faceHalves(f).some((h) => set.has(mesh.hFace[h ^ 1] as number))).toBe(false);
    }
  });

  for (const form of ['distance', 'path'] as const) {
    it(`extrudes by ${form} into one closed, valid surface`, () => {
      const m = pinched();
      const r =
        form === 'distance'
          ? m.extrude(chain(), { distance: 0.1, region: 'merged', label: 'chain' })
          : m.extrude(chain(), {
              path: [
                [0, 0, 0],
                [0, 0, 0.05],
                [0, 0.02, 0.1],
              ],
              label: 'chain',
            });
      expect(r.status, JSON.stringify(r.error)).toBe('ok');
      expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    });
  }
});

describe('bends tighter than the section (handoff D5)', () => {
  it('reports per folded span the turn, its length and the section reach', () => {
    // A 2.6 cm plate (normal +z) lifted 4 mm, then turned about 60 degrees toward +x: the
    // section reaches 1.8 cm from the path.
    const m = model();
    m.plane({ width: 0.026, height: 0.026, widthSegments: 4, heightSegments: 4, tag: 'plate' });
    const r = m.extrude(sel.tag('plate'), {
      path: [
        [0, 0, 0],
        [0, 0, 0.004],
        [0.009, 0, 0.009],
        [0.03, 0, 0.013],
        [0.05, 0, 0.014],
      ],
      label: 'clump',
    });
    expect(r.status).toBe('ok');
    const fold = r.diagnostics?.find((d) => d.message.includes('fold over'));
    expect(fold?.severity).toBe('warn');
    const spans = (
      fold?.detail as { spans: { turnDegrees: number; length: number; reach: number }[] }
    ).spans;
    expect(spans.length).toBeGreaterThan(0);
    // The folding span turns sharply and is shorter than the section reaches from the path.
    for (const s of spans) {
      expect([s.turnDegrees > 10, s.reach > s.length]).toEqual([true, true]);
    }
  });
});
