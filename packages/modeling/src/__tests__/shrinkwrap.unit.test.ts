import { describe, expect, it } from 'vitest';
import { length, sub, type Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

const R = 0.2;

function body(radius = R, center: Tuple3 = [0, 0, 0]): Model {
  const m = model();
  m.sphere({ radius, widthSegments: 48, heightSegments: 24, center, tag: 'body' });
  return m;
}

function cloth(size = 0.3, z = 0.25, segments = 12): Model {
  const m = model();
  m.plane({
    width: size,
    height: size,
    widthSegments: segments,
    heightSegments: segments,
    center: [0, 0, z],
    tag: 'cloth',
  });
  return m;
}

function radii(m: Model, faces = sel.tag('cloth'), center: Tuple3 = [0, 0, 0]): number[] {
  const mesh = m.editMesh;
  const vertices = new Set(faces.evaluate(mesh).flatMap((f) => mesh.faceVertices(f)));
  return [...vertices].map((v) => length(sub(mesh.position(v), center)));
}

function info(r: OpReport): Record<string, unknown> {
  return r.diagnostics?.find((d) => d.severity === 'info')?.detail ?? {};
}

function warning(r: OpReport, text: string) {
  return r.diagnostics?.find((d) => d.severity === 'warn' && d.message.includes(text));
}

describe('shrinkwrap', () => {
  it('nearest: every vertex lands offset from the surface along its normal', () => {
    const m = cloth();
    const r = m.shrinkwrap(sel.all(), { onto: body(), offset: 0.005 });
    expect(r.status).toBe('ok');
    expect(info(r)).toMatchObject({ mode: 'nearest', wrapped: 169, missed: 0 });
    // Faceted 48 x 24 sphere: the nearest point lies within its chord sag of the circle.
    for (const d of radii(m)) expect(Math.abs(d - (R + 0.005))).toBeLessThan(0.002);
    expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('a negative offset sinks below the surface; FXEM and session targets agree', () => {
    const a = cloth();
    a.shrinkwrap(sel.all(), { onto: body(), offset: -0.01 });
    const b = cloth();
    b.shrinkwrap(sel.all(), { onto: body().snapshot(), offset: -0.01 });
    // Same surface: FXEM rounds the snapshot positions and compaction reorders its triangles.
    const pa = a.editMesh.vertices().map((v) => a.editMesh.position(v));
    const pb = b.editMesh.vertices().map((v) => b.editMesh.position(v));
    for (const [i, p] of pa.entries()) expect(length(sub(p, pb[i] as Tuple3))).toBeLessThan(1e-5);
    for (const d of radii(a)) expect(Math.abs(d - (R - 0.01))).toBeLessThan(0.002);
  });

  it('project: rays along a direction hit the near side, both ways', () => {
    const m = cloth(0.2);
    const r = m.shrinkwrap(sel.all(), { onto: body(), mode: 'project', direction: [0, 0, -1] });
    expect(r.status).toBe('ok');
    const mesh = m.editMesh;
    for (const v of mesh.vertices()) {
      const [x, y, z] = mesh.position(v);
      expect(z).toBeGreaterThan(0);
      expect(Math.abs(Math.hypot(x, y, z) - R)).toBeLessThan(0.002);
    }
    // Inside the body the backward ray reaches the same surface.
    const inner = cloth(0.1, 0.05, 4);
    expect(
      inner.shrinkwrap(sel.all(), { onto: body(), mode: 'project', direction: [0, 0, -1] }).status,
    ).toBe('ok');
    for (const d of radii(inner)) expect(Math.abs(d - R)).toBeLessThan(0.002);
  });

  it('project along vertex normals wraps a cap onto a sphere', () => {
    const m = body(0.25);
    m.delete(sel.inBox([-1, -1, -1], [1, 0.1, 1], { by: 'any' }));
    const r = m.shrinkwrap(sel.all(), { onto: body(), mode: 'project' });
    expect(r.status).toBe('ok');
    for (const d of radii(m, sel.all())) expect(Math.abs(d - R)).toBeLessThan(0.002);
  });

  it('a target miss leaves the vertex and reports it; all misses are no effect', () => {
    const m = cloth(0.6);
    const r = m.shrinkwrap(sel.all(), {
      onto: body(),
      mode: 'project',
      direction: [0, 0, -1],
      maxDistance: 1,
    });
    expect(r.status).toBe('ok');
    const missed = warning(r, 'no surface point');
    expect(missed?.detail).toMatchObject({ missed: 120 });
    expect((missed?.detail?.vertices as number[]).length).toBe(32);
    const far = cloth();
    const none = far.shrinkwrap(sel.all(), { onto: body(), maxDistance: 0.001 });
    expect(none.status).toBe('failed');
    expect(none.error?.code).toBe('model-op-no-effect');
    expect(none.error?.detail).toMatchObject({ missed: 169 });
  });

  it('a falloff blends unselected neighbours by weight; outside the radius nothing moves', () => {
    const m = cloth(0.3, 0.25, 30);
    const before = m.editMesh.clone();
    const center = sel.inBox([-0.011, -0.011, 0], [0.011, 0.011, 1], { by: 'all' });
    const r = m.shrinkwrap(center, {
      onto: body(),
      falloff: { radius: 0.08, curve: 'linear' },
    });
    expect(r.status).toBe('ok');
    const mesh = m.editMesh;
    let partial = 0;
    for (const v of mesh.vertices()) {
      const p0 = before.position(v);
      const moved = length(sub(mesh.position(v), p0));
      const r2 = Math.hypot(p0[0], p0[1]);
      if (r2 > 0.08 + 0.011 * Math.SQRT2) expect(moved).toBe(0);
      else if (r2 < 0.01) expect(Math.abs(length(mesh.position(v)) - R)).toBeLessThan(0.002);
      else if (moved > 0 && Math.abs(length(mesh.position(v)) - R) > 0.002) partial++;
    }
    expect(partial).toBeGreaterThan(20);
    expect(info(r).blended).toBeGreaterThan(0);
  });

  it('wraps faces of the same session; touching target faces or bad options are rejected', () => {
    const m = body();
    m.append(cloth(), { tag: 'skirt' });
    const ok = m.shrinkwrap(sel.tag('skirt'), { onto: sel.tag('body'), offset: 0.004 });
    expect(ok.status).toBe('ok');
    const touching = body();
    const bad = touching.shrinkwrap(sel.extreme('+z'), { onto: sel.tag('body') });
    expect(bad.error?.code).toBe('model-invalid-argument');
    for (const options of [
      { direction: [0, 0, 1] as Tuple3 },
      { mode: 'project' as const, direction: [0, 0, 0] as Tuple3 },
      { maxDistance: -1 },
      { offset: Number.NaN },
      { falloff: { radius: 0 } },
      { mode: 'ray' as never },
    ]) {
      const s = cloth();
      expect(s.shrinkwrap(sel.all(), { onto: body(), ...options }).error?.code).toBe(
        'model-invalid-argument',
      );
    }
    const poisoned = body();
    poisoned.extrude(sel.tag('missing'), { distance: 1, region: 'merged' });
    expect(cloth().shrinkwrap(sel.all(), { onto: poisoned }).error?.code).toBe(
      'model-precondition',
    );
  });

  it('an empty selection is model-selection-empty and poisons the session', () => {
    const m = cloth();
    const r = m.shrinkwrap(sel.tag('nothing'), { onto: body() });
    expect(r.error?.code).toBe('model-selection-empty');
    expect(m.poisoned?.code).toBe('model-selection-empty');
  });

  it('property: random cloth grids wrapped onto random spheres stay valid', () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 12; trial++) {
      const radius = 0.1 + random() * 0.2;
      const center: Tuple3 = [0, 0, random() * 0.1];
      // Cloth within the cap: wider sheets fold past the silhouette in nearest mode.
      const m = cloth(
        0.04 + random() * radius * 0.6,
        center[2] + radius + random() * 0.2,
        6 + trial,
      );
      const r = m.shrinkwrap(sel.all(), {
        onto: body(radius, center),
        offset: random() * 0.01,
        ...(trial % 2 === 0 ? {} : { mode: 'project' as const, direction: [0, 0, -1] as Tuple3 }),
      });
      expect(r.status, `trial ${trial}`).toBe('ok');
      const errors = m.validate().issues.filter((i) => i.severity === 'error');
      expect(errors, `trial ${trial} ${JSON.stringify(errors).slice(0, 300)}`).toEqual([]);
    }
  });

  it('is deterministic', () => {
    const build = () => {
      const m = cloth();
      m.shrinkwrap(sel.all(), { onto: body(), offset: 0.003, falloff: { radius: 0.05 } });
      return m.snapshot();
    };
    expect(build()).toEqual(build());
  });
});
