import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { Selector, sel } from '../selectors';

function asset(tool = false) {
  const m = model();
  m.box({ size: [4, 4, 4], tag: 'shell' });
  m.box({ size: [0.4, 0.4, 0.4], center: [0, 0, 2.2], tag: 'bolt' });
  m.box({ size: [0.4, 0.4, 0.4], center: [0, 0, 0], tag: 'core' });
  m.box({ size: [0.4, 0.4, 0.4], center: tool ? [0, 2.2, 0] : [0, -1, 0], tag: 'cutter' });
  m.markRole(sel.tag('bolt'), 'detail');
  m.markRole(sel.tag('core'), 'form');
  m.markRole(sel.tag('cutter'), 'tool');
  return m;
}

const byTag = (
  audit: {
    parts: readonly {
      tags: readonly string[];
      visible: number;
      role: string;
      faces: number;
      area: number;
    }[];
  },
  tag: string,
) => audit.parts.find((p) => p.tags.includes(tag));

describe('auditVisibility: BK64', () => {
  it('a detail bolt outside is seen, a form core and a tool inside a closed shell are hidden', () => {
    const m = asset();
    const r = m.auditVisibility();
    if (!r.ok) throw r.error;
    expect(byTag(r.value, 'bolt')?.visible).toBeGreaterThan(0.2);
    expect(byTag(r.value, 'core')?.visible).toBe(0);
    expect(byTag(r.value, 'cutter')?.visible).toBe(0);
    expect(r.value.findings.map((f) => `${f.code}:${f.role}`).sort()).toEqual([
      'detail-seen:detail',
      'form-hidden:form',
    ]);
    expect(r.value.byRole.detail.parts).toBe(1);
  });

  it('a tool standing outside the shell is tool-seen', () => {
    const r = asset(true).auditVisibility();
    if (!r.ok) throw r.error;
    expect(r.value.findings.some((f) => f.code === 'tool-seen')).toBe(true);
  });

  it('a tool blocks sight only when listed as an occluder', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'form' });
    m.box({ size: [3, 3, 0.2], center: [0, 0, 0.9], tag: 'cutter' });
    m.markRole(sel.tag('cutter'), 'tool');
    const plain = m.auditVisibility();
    const blocked = m.auditVisibility({ occluders: ['form', 'detail', 'tool'] });
    if (!plain.ok || !blocked.ok) throw new Error('audit');
    expect(byTag(plain.value, 'form')?.visible).toBeGreaterThan(
      byTag(blocked.value, 'form')?.visible ?? 1,
    );
  });

  it('leaves the session untouched and is deterministic', () => {
    const m = asset();
    const before = m.snapshot();
    const a = m.auditVisibility({ views: 64, samples: 4 });
    const b = m.auditVisibility({ views: 64, samples: 4 });
    expect(m.snapshot()).toEqual(before);
    expect(a).toEqual(b);
  });

  it('validates its options', () => {
    const m = asset();
    for (const options of [
      { views: 3 },
      { views: 1.5 },
      { samples: 2 },
      { minVisible: 2 },
      { occluders: ['bogus'] },
    ]) {
      const r = m.auditVisibility(options as never);
      expect(r.ok).toBe(false);
    }
  });

  it('a lone box is fully exposed to every viewpoint that faces one of its faces', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'a' });
    const r = m.auditVisibility({ views: 96 });
    if (!r.ok) throw r.error;
    expect(r.value.parts[0]?.visible).toBeCloseTo(1, 9);
    expect(r.value.parts[0]?.views).toBe(96);
  });

  it('a one-sided plane is seen only from the half space above the facing threshold', () => {
    const m = model();
    m.plane({ width: 2, height: 2 });
    const r = m.auditVisibility({ views: 96 });
    if (!r.ok) throw r.error;
    const part = r.value.parts[0];
    expect(part?.visible).toBe(1);
    expect(part?.views).toBeGreaterThanOrEqual(38);
    expect(part?.views).toBeLessThanOrEqual(44);
  });

  it('minVisible is inclusive for detail and tool and exclusive for form', () => {
    const lone = (role: 'detail' | 'tool' | 'form') => {
      const m = model();
      m.plane({ width: 2, height: 2, tag: 'p' });
      m.markRole(sel.tag('p'), role);
      return m;
    };
    const codes = (role: 'detail' | 'tool' | 'form', minVisible: number) => {
      const r = lone(role).auditVisibility({ minVisible });
      if (!r.ok) throw r.error;
      return r.value.findings.map((f) => f.code);
    };
    expect(codes('detail', 1)).toEqual(['detail-seen']);
    expect(codes('tool', 1)).toEqual(['tool-seen']);
    const hidden = asset();
    const r = hidden.auditVisibility({ minVisible: 0 });
    if (!r.ok) throw r.error;
    expect(byTag(r.value, 'core')?.visible).toBe(0);
    expect(r.value.findings.some((f) => f.code === 'form-hidden')).toBe(false);
  });

  it('detail blocks sight by default and a form-only occluder set lets the core be seen', () => {
    const m = model();
    m.box({ size: [4, 4, 4], tag: 'skin' });
    m.box({ size: [0.4, 0.4, 0.4], tag: 'core' });
    m.markRole(sel.tag('skin'), 'detail');
    const covered = m.auditVisibility();
    const open = m.auditVisibility({ occluders: ['form'] });
    if (!covered.ok || !open.ok) throw new Error('audit');
    expect(byTag(covered.value, 'core')?.visible).toBe(0);
    expect(covered.value.findings.map((f) => f.code)).toContain('form-hidden');
    expect(byTag(open.value, 'core')?.visible).toBeGreaterThan(0.5);
  });

  it('samples: 4 sees around a partial occluder that hides the centroid', () => {
    const m = model();
    m.plane({ width: 4, height: 4, tag: 'floor' });
    m.box({ size: [0.5, 0.5, 0.1], center: [0, 0, 0.3], tag: 'cap' });
    m.markRole(sel.tag('cap'), 'detail');
    const one = m.auditVisibility({ views: 96, samples: 1 });
    const four = m.auditVisibility({ views: 96, samples: 4 });
    if (!one.ok || !four.ok) throw new Error('audit');
    const a = byTag(one.value, 'floor')?.visible ?? 0;
    const b = byTag(four.value, 'floor')?.visible ?? 0;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThanOrEqual(1);
  });

  it('visibility is area-weighted: a large exposed face outweighs a small hidden one', () => {
    const m = model();
    m.plane({ width: 4, height: 1, widthSegments: 2, tag: 'strip' });
    m.translate(
      new Selector('vert', 'mid', (mesh) =>
        mesh.vertices().filter((v) => Math.abs(mesh.position(v)[0] as number) < 1e-9),
      ),
      [1, 0, 0],
    );
    m.box({ size: [1.4, 3, 0.1], center: [1.5, 0, 0.2], tag: 'cap' });
    m.markRole(sel.tag('cap'), 'detail');
    const r = m.auditVisibility({ views: 96 });
    if (!r.ok) throw r.error;
    const strip = byTag(r.value, 'strip');
    expect(strip?.faces).toBe(2);
    expect(strip?.area).toBeCloseTo(4, 9);
    expect(strip?.visible).toBeGreaterThan(0.72);
    expect(strip?.visible).toBeLessThan(0.9);
    expect(r.value.byRole.form.visibleArea).toBeCloseTo((strip?.visible ?? 0) * 4, 9);
  });

  it('findings list at most 32 faces of a large part', () => {
    const m = model();
    m.box({ size: [4, 4, 4], tag: 'shell' });
    m.sphere({ radius: 0.5, widthSegments: 12, heightSegments: 8, tag: 'ball' });
    const r = m.auditVisibility();
    if (!r.ok) throw r.error;
    const ball = byTag(r.value, 'ball');
    expect(ball?.faces ?? 0).toBeGreaterThan(32);
    const finding = r.value.findings.find((f) => f.code === 'form-hidden');
    expect(finding?.faces.length).toBe(32);
  });

  it('a core under a skin thinner than any ray offset is still hidden', () => {
    const m = model();
    m.box({ size: [100, 100, 100], tag: 'shell' });
    m.box({ size: [10, 10, 10], center: [0, 0, -44.9995], tag: 'core' });
    const r = m.auditVisibility();
    if (!r.ok) throw r.error;
    expect(byTag(r.value, 'core')?.visible).toBe(0);
    expect(r.value.findings.map((f) => f.code)).toEqual(['form-hidden']);
  });

  it('a part has one role: a detail boss welded to a form body is its own part and is audited', () => {
    const m = model();
    m.box({ size: [2, 2, 2], tag: 'body' });
    m.extrude(sel.side([0, 0, 1], [0, 0, 1], { by: 'centroid' }), {
      distance: 0.3,
      region: 'perFace',
      label: 'boss',
    });
    m.markRole(sel.side([0, 0, 1.1], [0, 0, 1], { by: 'centroid' }), 'detail');
    const r = m.auditVisibility();
    if (!r.ok) throw r.error;
    expect(r.value.parts.map((p) => p.role)).toEqual(['form', 'detail']);
    expect(r.value.parts.map((p) => p.faces)).toEqual([5, 5]);
    expect(r.value.findings.map((f) => f.code)).toEqual(['detail-seen']);
  });
  it('falsifier: a recess of one part is shadowed by that part own adjacent faces', () => {
    const flat = model();
    flat.box({ size: [3, 3, 1], segments: [3, 3, 1], tag: 'body' });
    const pitted = model();
    pitted.box({ size: [3, 3, 1], segments: [3, 3, 1], tag: 'body' });
    const centre = sel
      .side([0, 0, 0.5], [0, 0, 1], { by: 'centroid' })
      .and(sel.inBox([-0.5, -0.5, 0.4], [0.5, 0.5, 0.6]));
    expect(pitted.extrude(centre, { distance: -0.9, region: 'perFace' }).status).toBe('ok');
    const a = flat.auditVisibility({ views: 192 });
    const b = pitted.auditVisibility({ views: 192 });
    if (!a.ok || !b.ok) throw new Error('audit');
    expect(b.value.parts).toHaveLength(1);
    expect(a.value.parts[0]?.visible).toBeCloseTo(1, 6);
    expect(b.value.parts[0]?.visible).toBeLessThan(0.97);
    expect(b.value.parts[0]?.visible).toBeGreaterThan(0.5);
  });
});
