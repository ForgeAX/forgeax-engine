import { describe, expect, it } from 'vitest';
import { type Model, model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';

function pairOf(build: (m: Model) => void) {
  const m = model();
  build(m);
  const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
  r.bindRigid(sel.createdBy('a'), 'root', { part: 'a' });
  r.bindRigid(sel.createdBy('b'), 'root', { part: 'b' });
  const t = r.interference({}, { tolerance: 0.001 });
  if (!t.ok) throw t.error;
  return t.value;
}

describe('interference of parts that share face planes (F-1)', () => {
  it('flags identical boxes', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
    expect(report.pairs[0]?.depth).toBeGreaterThan(0.01);
  });

  it('flags a plug as thick as its slab, on both shared planes', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.01, 0.2, 0.2], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.01, 0.05, 0.05], center: [0, 0, 0], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
    expect(report.pairs[0]?.depth).toBeGreaterThan(0.002);
  });

  it('flags a solid pin flush with both faces of a plate', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.1, 0.008, 0.1], center: [0, 0, 0], label: 'a' });
      m.cylinder({
        radiusTop: 0.005,
        radiusBottom: 0.005,
        height: 0.008,
        radialSegments: 16,
        center: [0, 0, 0],
        label: 'b',
      });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
  });

  it('flags an inner box flush with one face of its host', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.05, 0.05, 0.05], center: [0.025, 0, 0], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.depth).toBeCloseTo(0.025, 6);
  });

  it('flags a thin plug flush with a thin sheet as a clash through it', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.004, 2, 2], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.004, 1.6, 1.6], center: [0, 0, 0], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
  });

  it('flags a plug filling the full thickness of a millimetre sheet', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.0015, 0.1, 0.1], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.0015, 0.03, 0.03], center: [0, 0, 0], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
    expect(report.pairs[0]?.reason).toBe('through');
  });

  it('flags two identical millimetre plates', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.0015, 0.1, 0.1], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.0015, 0.1, 0.1], center: [0, 0, 0], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
  });

  it('flags identical boxes whose shared planes are only nearly exact after a joint rotation', () => {
    for (const degrees of [360, 720, 37]) {
      const m = model();
      m.box({ size: [0.1, 0.1, 0.1], center: [0.3, 0, 0], label: 'a' });
      m.box({ size: [0.1, 0.1, 0.1], center: [0.3, 0, 0], label: 'b' });
      const r = rig(m, {
        joints: [
          { name: 'root', parent: null, position: [0, 0, 0] },
          { name: 'j', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
        ],
      });
      r.bindRigid(sel.createdBy('a'), 'j', { part: 'a' });
      r.bindRigid(sel.createdBy('b'), 'j', { part: 'b' });
      const t = r.interference({ j: degrees }, { tolerance: 0.001 });
      if (!t.ok) throw t.error;
      expect(t.value.pass, `joint ${degrees}`).toBe(false);
    }
  });

  it('keeps boxes that only touch face to face a pass', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.1, 0.1, 0.1], center: [0.1, 0, 0], label: 'b' });
    });
    expect(report.pass).toBe(true);
    expect(report.pairs[0]?.status).not.toBe('confirmed');
  });

  it('keeps a seat declared for the pair a seat', () => {
    const m = model();
    m.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'a' });
    m.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'b' });
    const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r.bindRigid(sel.createdBy('a'), 'root', { part: 'a' });
    r.bindRigid(sel.createdBy('b'), 'root', { part: 'b' });
    const t = r.interference(
      {},
      { tolerance: 0.001, contacts: [{ parts: ['a', 'b'], tolerance: 0.1 }] },
    );
    if (!t.ok) throw t.error;
    expect(t.value.pairs[0]?.status).toBe('designed');
  });

  it('measures the same depth however finely the shared face is meshed', () => {
    const depths = [1, 4, 16].map(
      (n) =>
        pairOf((m) => {
          m.box({ size: [0.1, 0.1, 0.1], segments: [n, n, n], center: [0, 0, 0], label: 'a' });
          m.box({ size: [0.1, 0.1, 0.1], segments: [n, n, n], center: [0, 0, 0], label: 'b' });
        }).pairs[0]?.depth ?? 0,
    );
    for (const d of depths) expect(d).toBeGreaterThan(0.03);
    expect(Math.abs((depths[2] as number) - (depths[0] as number))).toBeLessThan(0.01);
  });

  it('flags a finely meshed plug that fills a thin slab as through', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.01, 0.2, 0.2], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.01, 0.05, 0.05], segments: [1, 32, 32], center: [0, 0, 0], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
  });

  it('is not blinded by coplanar but disjoint faces of other triangles', () => {
    const report = pairOf((m) => {
      for (let k = 0; k < 6; k++) {
        const base = { radiusTop: 0.5, radiusBottom: 0.5, height: 0.3, radialSegments: 8 };
        m.cylinder({ ...base, center: [5, k, 0], label: 'a' });
        m.cylinder({ ...base, center: [5.8, k, 0.8], label: 'b' });
      }
      m.box({ size: [1, 1, 1], center: [0, 10, 0], label: 'a' });
      m.box({ size: [1, 1, 1], center: [0, 10, 0], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
  });

  it('flags a plug a hair thinner than its slab', () => {
    for (const gap of [1e-9, 1e-7, 1e-5]) {
      const report = pairOf((m) => {
        m.box({ size: [0.01, 0.2, 0.2], center: [0, 0, 0], label: 'a' });
        m.box({ size: [0.01 - gap, 0.05, 0.05], center: [0, 0, 0], label: 'b' });
      });
      expect(report.pass, `gap ${gap}`).toBe(false);
    }
  });

  it('does not pair flush seats on opposite faces that lie apart', () => {
    const m = model();
    m.box({ size: [10, 0.2, 1], center: [0, 0, 0], label: 'a' });
    m.box({ size: [0.5, 0.1, 0.5], center: [-3, 0.05, 0], label: 'b' });
    m.box({ size: [0.5, 0.1, 0.5], center: [3, -0.05, 0], label: 'b' });
    const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r.bindRigid(sel.createdBy('a'), 'root', { part: 'a' });
    r.bindRigid(sel.createdBy('b'), 'root', { part: 'b' });
    const t = r.interference(
      {},
      { tolerance: 0.001, contacts: [{ parts: ['a', 'b'], tolerance: 0.15 }] },
    );
    if (!t.ok) throw t.error;
    expect(t.value.pairs[0]?.status).toBe('designed');
  });
  it('flags separate plugs through a sheet even when their common centre lies in a gap', () => {
    const report = pairOf((m) => {
      m.box({ size: [0.4, 0.01, 0.2], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.06, 0.01, 0.06], center: [-0.15, 0, 0], label: 'b' });
      m.box({ size: [0.06, 0.01, 0.06], center: [0.15, 0, 0], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
  });
});
