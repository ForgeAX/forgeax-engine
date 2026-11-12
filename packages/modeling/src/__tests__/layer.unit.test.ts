import { describe, expect, it } from 'vitest';
import { length, type Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import { isClosed } from '../ops';
import { sel } from '../selectors';

const R = 0.2;

function body(): Model {
  const m = model();
  m.sphere({ radius: R, widthSegments: 32, heightSegments: 16, tag: 'body' });
  return m;
}

const band = () => sel.tag('body').and(sel.inBox([-1, -0.06, -1], [1, 0.12, 1], { by: 'all' }));

function radiiOf(m: Model, faces = sel.createdBy('dress', 'layer')): number[] {
  const mesh = m.editMesh;
  const vertices = new Set(faces.evaluate(mesh).flatMap((f) => mesh.faceVertices(f)));
  return [...vertices].map((v) => length(mesh.position(v) as Tuple3));
}

function info(r: OpReport): Record<string, unknown> {
  return (
    r.diagnostics?.find((d) => d.severity === 'info' && d.message.startsWith('layer'))?.detail ?? {}
  );
}

describe('layer (region offset shell)', () => {
  it('a sheet offset from a region leaves the source untouched and drops its tags', () => {
    const m = body();
    const mesh = m.editMesh;
    const before = mesh.vertices().map((v) => mesh.position(v));
    const faces = mesh.faces();
    const r = m.layer(band(), { offset: 0.004, label: 'dress', tag: 'dress', material: 'cloth' });
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({ layer: 128 });
    expect(m.count(sel.tag('body'))).toBe(512);
    expect(m.count(sel.tag('dress'))).toBe(128);
    expect(m.count(sel.material('cloth'))).toBe(128);
    expect(before.map((_, v) => mesh.position(v))).toEqual(before);
    expect(
      faces.every((f) => mesh.isFaceAlive(f) && !mesh.hasTag(f, mesh.tagIndex('dress', false))),
    ).toBe(true);
    expect(info(r)).toMatchObject({ faces: 128, offset: 0.004, thickness: 0 });
    // Two open boundary loops of 32 edges.
    expect(info(r).openEdges).toBe(64);
  });

  it('thickness grows a closed wall outward: layer, inner, rim; validate is clean', () => {
    const m = body();
    const r = m.layer(band(), { offset: 0.004, thickness: 0.003, label: 'dress' });
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({ layer: 128, inner: 128, rim: 64 });
    expect(isClosed(m.editMesh)).toBe(true);
    const v = m.validate();
    expect(v.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    // The inner sheet sits at the offset, the layer (outer wall) a thickness beyond it,
    // both within the faceting of a 32 x 16 sphere.
    const inner = radiiOf(m, sel.createdBy('dress', 'inner'));
    const outer = radiiOf(m, sel.createdBy('dress', 'layer'));
    expect(Math.min(...inner)).toBeGreaterThan(R + 0.004 - 1e-4);
    expect(Math.min(...outer)).toBeGreaterThan(Math.max(...inner) - 0.001);
  });

  it("rim 'open' leaves the two sheets apart", () => {
    const m = body();
    const r = m.layer(band(), { offset: 0.004, thickness: 0.003, rim: 'open', label: 'dress' });
    expect(r.roles).toEqual({ layer: 128, inner: 128 });
    expect(m.count(sel.createdBy('dress', 'rim'))).toBe(0);
    expect(m.validate().boundaryEdges).toBe(128);
  });

  it('conform keeps a constant gap over the curved region', () => {
    const plain = body();
    plain.layer(band(), { offset: 0.01, label: 'dress' });
    const wrapped = body();
    const r = wrapped.layer(band(), { offset: 0.01, conform: true, label: 'dress' });
    expect(r.status).toBe('ok');
    const spread = (m: Model) => Math.max(...radiiOf(m)) - Math.min(...radiiOf(m));
    // The facet-plane solve sits a vertex farther than the sphere at the band corners;
    // conform measures the gap to the faceted surface itself.
    expect(spread(wrapped)).toBeLessThanOrEqual(spread(plain) + 1e-12);
    expect(info(r).gap).toBeDefined();
  });

  it('a whole closed part becomes a closed layer without rims', () => {
    const m = body();
    const r = m.layer(sel.tag('body'), { offset: 0.002, thickness: 0.002, label: 'coat' });
    expect(r.roles).toEqual({ layer: 512, inner: 512 });
    expect(isClosed(m.editMesh)).toBe(true);
  });

  it('rejects empty selections, missing magnitudes and bad options', () => {
    const empty = body();
    expect(empty.layer(sel.tag('none'), { offset: 0.01 }).error?.code).toBe(
      'model-selection-empty',
    );
    expect(body().layer(band(), { offset: 0 }).error?.code).toBe('model-op-no-effect');
    for (const options of [
      { offset: Number.NaN },
      { offset: 0.01, thickness: -1 },
      { offset: 0.01, rim: 'open' as const },
      { offset: 0.01, thickness: 0.01, rim: 'flat' as never },
    ]) {
      expect(body().layer(band(), options).error?.code).toBe('model-invalid-argument');
    }
  });

  it('property: random bands, offsets and thicknesses validate clean', () => {
    let seed = 5;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 10; trial++) {
      const m = body();
      const y0 = -0.15 + random() * 0.15;
      const y1 = y0 + 0.03 + random() * 0.12;
      const region = sel.tag('body').and(sel.inBox([-1, y0, -1], [1, y1, 1], { by: 'all' }));
      if (m.count(region) === 0) continue;
      const r = m.layer(region, {
        offset: 0.001 + random() * 0.01,
        thickness: trial % 3 === 0 ? 0 : 0.001 + random() * 0.004,
        conform: trial % 2 === 0,
        label: 'l',
      });
      expect(r.status, `trial ${trial}`).toBe('ok');
      expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });
  it('conform reports the gap it reaches and warns on a concave region', () => {
    const m = model();
    m.revolve({
      points: [
        [0, 0],
        [0.12, 0],
        [0.07, 0.1],
        [0.12, 0.2],
        [0, 0.2],
      ],
      segments: 32,
      tag: 'body',
    });
    const r = m.layer(
      sel.tag('body').and(sel.inBox([-1, 0.02, -1], [1, 0.18, 1], { by: 'centroid' })),
      {
        offset: 0.02,
        conform: true,
        label: 'dress',
      },
    );
    expect(r.status).toBe('ok');
    const gap = info(r).gap as { min: number; max: number };
    expect(gap.min).toBeLessThan(0.018);
    expect(
      r.diagnostics?.some((d) => d.severity === 'warn' && d.message.startsWith('conform')),
    ).toBe(true);
  });
});
