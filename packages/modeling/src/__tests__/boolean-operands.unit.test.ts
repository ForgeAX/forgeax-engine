import { describe, expect, it } from 'vitest';
import { components, faceContacts } from '../intersect';
import { model } from '../model';
import { sel } from '../selectors';

const hollow = (size: number, inner: number) => {
  const t = model();
  t.box({ size: [size, size, size] });
  t.box({ size: [inner, inner, inner], tag: 'inner' });
  t.flip(sel.tag('inner'));
  return t;
};

describe('boolean operand components fail closed', () => {
  it('intersects with a hollow tool: the cavity stays a void in the result', () => {
    const m = model();
    m.box({ size: [0.8, 0.8, 0.8] });
    const r = m.intersection(hollow(1, 0.5));
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(0.512 - 0.125, 6);
    expect(m.validate().closed).toBe(true);
  });

  it('subtracts a hollow tool: only the cavity cube is left', () => {
    const m = model();
    m.box({ size: [0.8, 0.8, 0.8] });
    const r = m.difference(hollow(1, 0.5));
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(0.125, 6);
  });

  it('accepts a hollow target with a solid tool in or across its wall', () => {
    const inside = hollow(1, 0.5);
    const island = model();
    island.box({ size: [0.2, 0.2, 0.2] });
    const joined = inside.union(island, { onPartial: 'error' });
    expect(joined.status, joined.error?.message).toBe('ok');
    expect(inside.validate().volume).toBeCloseTo(0.875 + 0.008, 6);
    const wall = hollow(1, 0.5);
    const tool = model();
    tool.box({ size: [0.2, 0.2, 0.2], center: [0.4, 0, 0] });
    const r = wall.difference(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(wall.validate().volume).toBeCloseTo(0.875 - 0.008, 6);
  });

  it('rejects a cavity nested inside another cavity of the same tool', () => {
    const tool = model();
    tool.box({ size: [3, 3, 3] });
    tool.box({ size: [2, 2, 2], tag: 'a' });
    tool.flip(sel.tag('a'));
    tool.box({ size: [1, 1, 1], tag: 'b' });
    tool.flip(sel.tag('b'));
    const m = model();
    m.box({ size: [0.5, 0.5, 0.5] });
    const r = m.difference(tool);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.detail).toMatchObject({ fault: 'nested' });
    expect(r.error?.hint).toMatch(/inside another cavity/);
  });

  it('accepts a solid inside a cavity: the nested cavity belongs to its own shell', () => {
    const tool = hollow(3, 2);
    tool.union(hollow(1, 0.5));
    const m = model();
    m.box({ size: [0.2, 0.2, 0.2], center: [3, 0, 0] });
    const r = m.union(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
  });

  it('accepts a cavity that touches its shell wall', () => {
    const tool = model();
    tool.box({ size: [1, 1, 1] });
    tool.box({ size: [0.5, 0.5, 0.5], center: [0.25, 0, 0], tag: 'a' });
    tool.flip(sel.tag('a'));
    const m = model();
    m.box({ size: [0.8, 0.8, 0.8] });
    const r = m.difference(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(0.1, 6);
  });

  it('rejects a zero-thickness sheet component of the tool', () => {
    const tool = model();
    tool.box({ size: [1, 1, 1] });
    const mesh = tool.editMesh;
    const sheet = [
      mesh.addVertex(3, 0, 0),
      mesh.addVertex(4, 0, 0),
      mesh.addVertex(4, 1, 0),
      mesh.addVertex(3, 1, 0),
    ];
    expect(mesh.addFace(sheet).ok).toBe(true);
    expect(mesh.addFace([...sheet].reverse()).ok).toBe(true);
    const m = model();
    m.box({ size: [0.8, 0.8, 0.8] });
    const r = m.difference(tool);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.detail).toMatchObject({ fault: 'flat' });
  });

  it('fails closed on a cavity that crosses its shell wall and leaves the target unchanged', () => {
    for (const cx of [0.6, 0.45]) {
      const tool = model();
      tool.box({ size: [1, 1, 1] });
      tool.box({ size: [0.5, 0.5, 0.5], center: [cx, 0, 0], tag: 'a' });
      tool.flip(sel.tag('a'));
      const m = model();
      m.box({ size: [4, 1, 1], center: [1, 0, 0] });
      const r = m.difference(tool, { onPartial: 'error' });
      expect(r.status, String(cx)).toBe('failed');
      expect(m.validate().volume, String(cx)).toBeCloseTo(4, 9);
    }
  });

  it('rejects a cavity that no shell contains and leaves the target unchanged', () => {
    for (const operation of ['difference', 'intersection'] as const) {
      const tool = model();
      tool.box({ size: [1, 1, 1] });
      tool.box({ size: [0.5, 0.5, 0.5], center: [2, 0, 0], tag: 'a' });
      tool.flip(sel.tag('a'));
      const m = model();
      m.box({ size: [4, 1, 1], center: [1, 0, 0] });
      const r = m[operation](tool, { onPartial: 'error' });
      expect(r.status, operation).toBe('failed');
      expect(r.error?.code).toBe('model-precondition');
      expect(r.error?.detail).toMatchObject({ fault: 'orphan' });
      expect(m.validate().volume).toBeCloseTo(4, 9);
    }
  });

  it('rejects overlapping target components with a hint that does not blame coplanar faces', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.box({ size: [1, 1, 1], center: [0.5, 0, 0] });
    const tool = model();
    tool.cylinder({
      radiusTop: 0.1,
      radiusBottom: 0.1,
      height: 2,
      radialSegments: 16,
      center: [0.25, 0, 0],
    });
    const r = m.difference(tool);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.hint).not.toMatch(/coplanar/);
    expect(r.error?.hint).toMatch(/union/);
  });

  it('still accepts disjoint target components and overlapping tool components', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.box({ size: [1, 1, 1], center: [3, 0, 0] });
    const tool = model();
    tool.box({ size: [0.4, 0.4, 3], center: [0.2, 0, 0] });
    tool.box({ size: [0.4, 0.4, 3], center: [-0.2, 0, 0] });
    const r = m.difference(tool);
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().closed).toBe(true);
  });

  it('unions a target that covers the whole cavity with a hollow tool (the cavity is filled)', () => {
    for (const size of [0.8, 0.5, 0.999]) {
      const m = model();
      m.box({ size: [size, size, size] });
      const r = m.union(hollow(1, 0.5));
      expect(r.status, `${size}: ${r.error?.message}`).toBe('ok');
      expect(m.validate().volume).toBeCloseTo(1, 6);
      expect(m.validate().closed).toBe(true);
    }
  });

  it('unions a hollow tool whose cavity the target covers only in part: the rest stays a void', () => {
    for (const size of [0.49, 0.3]) {
      const m = model();
      m.box({ size: [size, size, size] });
      const r = m.union(hollow(1, 0.5));
      expect(r.status, `${size}: ${r.error?.message}`).toBe('ok');
      expect(m.validate().volume, String(size)).toBeCloseTo(0.875 + size ** 3, 6);
      expect(m.validate().closed).toBe(true);
    }
    const far = model();
    far.box({ size: [0.2, 0.2, 0.2], center: [5, 0, 0] });
    expect(far.union(hollow(1, 0.5)).status).toBe('ok');
    expect(far.validate().volume).toBeCloseTo(0.875 + 0.008, 6);
  });

  it('unions a hollow tool with a slotted target: the slot stays open through the cavity', () => {
    const m = model();
    m.box({ size: [2, 2, 2] });
    const slot = model();
    slot.box({ size: [0.05, 0.05, 3], center: [0.3, 0.3, 0] });
    expect(m.difference(slot).status).toBe('ok');
    const before = m.validate().volume;
    expect(before).toBeCloseTo(8 - 0.05 * 0.05 * 2, 9);
    const r = m.union(hollow(1, 0.8));
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo((before as number) + 0.05 * 0.05 * 0.2, 6);
    expect(m.validate().closed).toBe(true);
  });

  it('does not read a crossing inside one target component as two bodies crossing', () => {
    const pinched = () => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.extrude(sel.facing('+x'), { distance: 2, region: 'perIsland' });
      for (const v of m.editMesh.vertices()) {
        const p = m.editMesh.position(v);
        if (p[0] > 1.4) m.editMesh.setPosition(v, p[0] - 2.8, p[1] + 0.3, p[2]);
      }
      return m;
    };
    const m = pinched();
    m.box({ size: [1, 1, 1], center: [8, 0, 0] });
    expect(faceContacts(m.editMesh, 1000, 1e-5).contacts.some((c) => c.contact === 'cross')).toBe(
      true,
    );
    expect(components(m.editMesh).faces).toHaveLength(2);
    const far = model();
    far.box({ size: [0.2, 0.2, 0.2], center: [8, 0, 0] });
    expect(m.difference(far).error?.message ?? '').not.toMatch(/target components do not overlap/);
    // A second body overlapping the first is still found behind the self crossing.
    const two = pinched();
    two.box({ size: [1, 1, 1], center: [0.5, 0.5, 0.3] });
    const cut = model();
    cut.box({ size: [0.2, 0.2, 0.2], center: [0.5, 0.5, 0.3] });
    expect(two.difference(cut).error?.message).toMatch(/target components do not overlap/);
  });

  it('reads target components that overlap by more than the tolerance, not within it', () => {
    const cut = () => {
      const t = model();
      t.box({ size: [0.3, 0.3, 3], center: [-0.2, 0, 0] });
      return t;
    };
    const pair = (dx: number) => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.box({ size: [1, 1, 1], center: [dx, 0, 0] });
      return m.difference(cut());
    };
    expect(pair(1 - 4e-4).error?.code).toBe('model-precondition');
    expect(pair(1 - 4e-4).error?.message).toMatch(/target components do not overlap/);
    for (const dx of [1, 1 - 4e-6]) {
      const r = pair(dx);
      expect(r.error?.message ?? '', String(dx)).not.toMatch(/target components do not overlap/);
    }
  });

  it('leaves a zero-volume operand component to the later degenerate-face check', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const t = model();
    t.box({ size: [0.4, 0.4, 3] });
    t.box({ size: [0.2, 0.2, 0.2], center: [3, 0, 0] });
    for (const v of t.editMesh.vertices()) {
      const p = t.editMesh.position(v);
      if (p[0] > 2) t.editMesh.setPosition(v, p[0], p[1], 0);
    }
    const r = m.difference(t);
    expect(r.error?.message ?? '').not.toMatch(/positive volume/);
  });

  it('does not drop a zero-volume component of a hollow tool as if it were a covered cavity', () => {
    const m = model();
    m.box({ size: [0.8, 0.8, 0.8] });
    const t = hollow(1, 0.5);
    t.box({ size: [0.1, 0.1, 0.1], center: [0.1, 0.1, 0.1], tag: 'flat' });
    for (const v of t.editMesh.vertices()) {
      const p = t.editMesh.position(v);
      if (Math.abs(p[0] - 0.1) < 0.06 && Math.abs(p[1] - 0.1) < 0.06 && Math.abs(p[2] - 0.1) < 0.06)
        t.editMesh.setPosition(v, p[0], p[1], 0.1);
    }
    const r = m.union(t);
    expect(r.status).toBe('failed');
  });
});
