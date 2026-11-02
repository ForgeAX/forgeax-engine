import { describe, expect, it } from 'vitest';
import { EDGE_SHARP } from '../mesh';
import { type Model, model } from '../model';
import { isClosed } from '../ops';
import { sel } from '../selectors';

/** A 1 m square plate (20 x 20 quads) shelled 1 cm upward, optionally tapered. */
function plate(taper?: number): Model {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: 20, heightSegments: 20, label: 'plate' });
  m.shell(sel.createdBy('plate'), {
    thickness: 0.01,
    direction: 'out',
    label: 'plate-wall',
    ...(taper === undefined ? {} : { taper }),
  });
  return m;
}

/** Height of the outer (top) surface above the inner one at a point of the plate. */
function thicknessAt(m: Model, x: number, y: number): number {
  const mesh = m.editMesh;
  const near = (role: string) => {
    let best = Infinity;
    let z = 0;
    for (const f of sel
      .createdBy('plate-wall', role)
      .or(role === 'outer' ? sel.createdBy('plate') : sel.tag('__none__'))
      .evaluate(mesh)) {
      for (const v of mesh.faceVertices(f)) {
        const p = mesh.position(v);
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < best) [best, z] = [d, p[2]];
      }
    }
    return z;
  };
  return near('outer') - near('inner');
}

describe('shell taper: walls that thin to a crease at open edges', () => {
  it('closes the plate with no rim: the boundary is a sharp crease shared by both walls', () => {
    const m = plate(0.1);
    expect(m.poisoned).toBeUndefined();
    expect(isClosed(m.editMesh)).toBe(true);
    expect(m.count(sel.createdBy('plate-wall', 'rim'))).toBe(0);
    // The 80 boundary edges of the plate are creases.
    let sharp = 0;
    for (const e of m.editMesh.edges())
      if (((m.editMesh.eFlags[e] as number) & EDGE_SHARP) !== 0) sharp++;
    expect(sharp).toBe(80);
    // Full thickness inside, half at half the taper, none at the edge.
    expect(thicknessAt(m, 0, 0)).toBeCloseTo(0.01, 6);
    expect(thicknessAt(m, 0.45, 0)).toBeCloseTo(0.005, 6);
    expect(thicknessAt(m, 0.5, 0)).toBeCloseTo(0, 9);
  });

  it('falsifier: without the taper the plate has 4 mm-wide rim strips of long slivers', () => {
    const m = plate();
    expect(m.count(sel.createdBy('plate-wall', 'rim'))).toBe(80);
    m.triangulate(sel.all());
    const rim = m.meshQuality(sel.createdBy('plate-wall', 'rim'));
    expect(rim.ok && rim.value.aspect.p50).toBeGreaterThan(4);
    const tapered = plate(0.1);
    tapered.triangulate(sel.all());
    const all = tapered.meshQuality();
    expect(all.ok && all.value.aspect.max).toBeLessThan(4);
  });

  it('refuses a taper the panel cannot reach, a closed surface, and a taper with a flange', () => {
    const wide = model();
    wide.plane({ width: 1, height: 1, widthSegments: 20, heightSegments: 20, label: 'plate' });
    const long = wide.shell(sel.createdBy('plate'), { thickness: 0.01, taper: 0.6 });
    expect(long.status).toBe('failed');
    expect(long.error?.code).toBe('model-precondition');
    expect((long.error?.detail as { maxTaper: number }).maxTaper).toBeCloseTo(0.5, 6);
    const closed = model();
    closed.box({ size: [1, 1, 1], label: 'box' });
    const r = closed.shell(sel.createdBy('box'), { thickness: 0.01, taper: 0.1 });
    expect(r.error?.code).toBe('model-precondition');
    const both = model();
    both.plane({ width: 1, height: 1, label: 'plate' });
    const f = both.shell(sel.createdBy('plate'), {
      thickness: 0.01,
      taper: 0.1,
      flange: { reach: 0.05, depth: 0.02 },
    });
    expect(f.error?.code).toBe('model-invalid-argument');
  });

  it('narrow strips and outlines across quads: walls never share a chord or a diagonal', () => {
    // One row of quads: every interior edge joins two boundary vertices.
    const strip = model();
    strip.plane({ width: 1, height: 0.2, widthSegments: 10, heightSegments: 1, label: 'strip' });
    expect(
      strip.shell(sel.createdBy('strip'), { thickness: 0.004, direction: 'out', taper: 0.05 })
        .status,
    ).toBe('ok');
    expect(isClosed(strip.editMesh)).toBe(true);
    // Poked into fans already, the strip may be all triangles.
    strip.try((t) => t.triangulate(sel.all()));
    expect(strip.simplify(undefined, { targetFaces: 12 }).status).toBe('ok');
    expect(isClosed(strip.editMesh)).toBe(true);
    // A knife disc: its outline crosses grid quads, leaving boundary vertices at opposite corners.
    const disc = model();
    disc.plane({ width: 1, height: 1, widthSegments: 16, heightSegments: 16, label: 'grid' });
    const ring = Array.from(
      { length: 24 },
      (_, i) =>
        [0.37 * Math.cos((i * Math.PI) / 12), 0.37 * Math.sin((i * Math.PI) / 12), 0] as [
          number,
          number,
          number,
        ],
    );
    disc.knife({ points: ring, closed: true, direction: [0, 0, -1], label: 'disc' });
    disc.delete(sel.all().minus(sel.createdBy('disc', 'inside')));
    expect(
      disc.shell(sel.all(), { thickness: 0.005, direction: 'out', taper: 0.08, label: 'disc-wall' })
        .status,
    ).toBe('ok');
    expect(isClosed(disc.editMesh)).toBe(true);
    disc.try((t) => t.triangulate(sel.all()));
    const simplified = disc.simplify(undefined, { targetFaces: 60, preserve: { labels: true } });
    expect(simplified.status).toBe('ok');
    expect(isClosed(disc.editMesh)).toBe(true);
  });

  it('openings are removed, not walled: an open-top box tapers to a crease around its mouth', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [4, 4, 4], label: 'box' });
    const r = m.shell(sel.createdBy('box'), {
      thickness: 0.02,
      direction: 'in',
      open: sel.createdBy('box').and(sel.facing('+y', 5)),
      taper: 0.2,
    });
    expect(r.status).toBe('ok');
    expect(isClosed(m.editMesh)).toBe(true);
    // Nothing covers the mouth: no face centroid on the top plane.
    const top = sel
      .all()
      .and(sel.inBox([-0.49, 0.499, -0.49], [0.49, 0.501, 0.49], { by: 'centroid' }));
    expect(m.count(top)).toBe(0);
  });

  it('layer passes the taper to its wall', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [10, 10, 10], label: 'body' });
    const r = m.layer(sel.createdBy('body').and(sel.facing('+y', 5)), {
      offset: 0.01,
      thickness: 0.01,
      taper: 0.1,
      label: 'pad',
    });
    expect(r.status).toBe('ok');
    expect(m.count(sel.createdBy('pad', 'rim'))).toBe(0);
    expect(
      m.layer(sel.createdBy('body').and(sel.facing('-y', 5)), {
        offset: 0.01,
        taper: 0.1,
        label: 'bad',
      }).error?.code,
    ).toBe('model-invalid-argument');
  });
});
