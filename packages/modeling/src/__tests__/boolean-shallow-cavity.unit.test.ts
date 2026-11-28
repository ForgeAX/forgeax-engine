import { describe, expect, it } from 'vitest';
import { type Model, model } from '../model';
import { sel } from '../selectors';

function box(size: number, center: [number, number, number] = [0, 0, 0]): Model {
  const m = model();
  m.box({ size: [size, size, size], center });
  return m;
}

function hollow(size: number, inner: number, island?: number): Model {
  const t = box(size);
  t.box({ size: [inner, inner, inner], tag: 'inner' });
  t.flip(sel.tag('inner'));
  if (island !== undefined) t.box({ size: [island, island, island] });
  return t;
}

describe('boolean at a shallow angle between two faces', () => {
  const operations = ['difference', 'union', 'intersection'] as const;
  for (const deg of [0.003, 0.01, 0.03, 0.1]) {
    for (const operation of operations) {
      it(`closes ${operation} of a cube and a copy rotated by ${deg} deg`, () => {
        const m = box(1);
        const tool = box(1, [0.5, 0, 0]);
        tool.rotate(sel.all(), 'z', deg, [0.5, 0, 0]);
        const r = m[operation](tool, { onPartial: 'error' });
        expect(r.status, r.error?.message).toBe('ok');
        const v = m.validate();
        expect(v.closed).toBe(true);
        const expected = operation === 'union' ? 1.5 : operation === 'difference' ? 0.5 : 0.5;
        expect(v.volume).toBeGreaterThan(expected - 0.002);
        expect(v.volume).toBeLessThan(expected + 0.002);
      });
    }
  }

  it('keeps a clearly separate corner on its own side of a plane that cuts far from it', () => {
    const m = box(1);
    const tool = box(1, [0.5, 0, 0]);
    tool.rotate(sel.all(), 'y', -0.05, [0.5, 0, 0]);
    const r = m.difference(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().closed).toBe(true);
  });

  it('treats a rotation below the tolerance as no rotation', () => {
    const m = box(1);
    const tool = box(1, [0.5, 0, 0]);
    tool.rotate(sel.all(), 'z', 1e-6, [0.5, 0, 0]);
    const r = m.difference(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(0.5, 6);
  });
});

describe('boolean with a hollow tool', () => {
  it('a cube inside the cavity minus the hollow body is the cavity cube', () => {
    const m = box(0.8);
    const r = m.difference(hollow(1, 0.5));
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(0.125, 6);
  });

  it('a cube across the wall united with the hollow body keeps the wall and the stub', () => {
    const m = box(0.3, [0.5, 0, 0]);
    const r = m.union(hollow(1, 0.5), { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    const v = m.validate();
    expect(v.closed).toBe(true);
    expect(v.volume).toBeCloseTo(0.8885, 6);
  });

  it('intersection with the hollow body is the wall part of the cube', () => {
    const m = box(0.8);
    const r = m.intersection(hollow(1, 0.5), { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(0.512 - 0.125, 6);
  });

  it('an island inside the cavity is a solid of its own, not part of the wall', () => {
    const m = box(0.8);
    const r = m.difference(hollow(1, 0.5, 0.2), { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(0.125 - 0.008, 6);
  });

  it('two hollow bodies side by side each keep their own cavity', () => {
    const m = box(3, [0.5, 0, 0]);
    const tool = hollow(1, 0.5);
    const other = hollow(1, 0.5);
    other.translate(sel.all(), [1.2, 0, 0]);
    tool.union(other);
    const r = m.difference(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(27 - 2 * 0.875, 6);
  });

  it('a hollow tool whose wall overlaps a hollow target removes only the shared wall', () => {
    const m = hollow(2, 1.5);
    const tool = hollow(1, 0.5);
    tool.translate(sel.all(), [0.9, 0, 0]);
    const r = m.difference(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(8 - 3.375 - 0.1875, 6);
  });

  it('a target larger than the hollow tool keeps everything outside the tool', () => {
    const m = box(3);
    const r = m.difference(hollow(1, 0.5), { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(27 - 0.875, 6);
  });

  it('a hollow body inside the cavity of another gives each cavity to its own shell', () => {
    const m = box(3);
    const tool = hollow(2, 1.5);
    tool.union(hollow(1, 0.5));
    const r = m.difference(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(27 - 4.625 - 0.875, 6);
  });

  it('a cavity outside every shell is rejected as an orphan', () => {
    const m = model();
    m.box({ size: [4, 1, 1], center: [1, 0, 0] });
    const tool = box(1);
    tool.box({ size: [0.5, 0.5, 0.5], center: [1.4, 0, 0], tag: 'inner' });
    tool.flip(sel.tag('inner'));
    const r = m.intersection(tool, { onPartial: 'error' });
    expect(r.status).toBe('failed');
    expect(r.error?.detail).toMatchObject({ fault: 'orphan' });
  });

  it('a cavity whose first corner lies on the shell still joins that shell', () => {
    const m = box(0.8);
    const tool = box(1);
    tool.box({ size: [0.5, 0.5, 0.5], center: [0.25, 0, 0], tag: 'inner' });
    tool.flip(sel.tag('inner'));
    const r = m.difference(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
  });

  describe('fails closed where the cavity touches its shell', () => {
    function twoCavities(
      outer: number,
      first: [number, number, number],
      second: [number, number, number],
      size: number,
    ): Model {
      const t = box(outer);
      t.box({ size: [size, size, size], center: first, tag: 'a' });
      t.box({ size: [size, size, size], center: second, tag: 'b' });
      t.flip(sel.tag('a'));
      t.flip(sel.tag('b'));
      return t;
    }

    for (const operation of ['difference', 'intersection'] as const) {
      it(`${operation}: a rotated cavity whose edges reach the wall (d1)`, () => {
        const m = box(1.5);
        const tool = box(2);
        tool.box({ size: [Math.SQRT2, Math.SQRT2, Math.SQRT2], tag: 'inner' });
        tool.rotate(sel.tag('inner'), 'z', 45, [0, 0, 0]);
        tool.flip(sel.tag('inner'));
        const r = m[operation](tool, { onPartial: 'error' });
        expect(r.status, operation).toBe('failed');
        expect(r.error?.code).toBe('model-precondition');
        expect(r.error?.detail).toMatchObject({ fault: 'touching' });
        expect(m.validate().volume).toBeCloseTo(3.375, 9);
      });

      it(`${operation}: a cavity flush with three faces of its shell (flush3)`, () => {
        const m = model();
        m.box({ size: [1.5, 1.5, 1], center: [-0.5, 0.5, -0.5] });
        const tool = box(2);
        tool.box({ size: [1, 1, 1], center: [0.5, -0.5, -0.5], tag: 'inner' });
        tool.flip(sel.tag('inner'));
        const r = m[operation](tool, { onPartial: 'error' });
        expect(r.status, operation).toBe('failed');
        expect(r.error?.detail).toMatchObject({ fault: 'touching' });
      });
    }

    it('a duplicate cavity is not a shell/cavity decision and keeps its partial-result failure', () => {
      const m = model();
      m.box({ size: [1.2, 0.7, 0.9], center: [0.3, 0.1, 0] });
      const r = m.difference(twoCavities(2, [0, 0, 0], [0, 0, 0], 1), { onPartial: 'error' });
      expect(r.status).toBe('failed');
      expect(r.error?.code).toBe('model-partial');
    });

    it('an island flush with one wall of the cavity that carries its own cavity is rejected as nested', () => {
      const m = box(3);
      const tool = hollow(2, 1);
      tool.box({ size: [1, 1, 0.6], center: [0, 0, -0.2] });
      tool.box({ size: [0.5, 0.5, 0.2], center: [0, 0, -0.2], tag: 'deep' });
      tool.flip(sel.tag('deep'));
      const r = m.difference(tool, { onPartial: 'error' });
      expect(r.status).toBe('failed');
      expect(r.error?.detail).toMatchObject({ fault: 'nested' });
    });

    it('a solid coincident with a cavity wall is rejected as touching', () => {
      const m = model();
      m.box({ size: [1.2, 0.7, 0.9], center: [0.3, 0.1, 0] });
      const tool = hollow(2, 1);
      tool.box({ size: [1, 1, 1] });
      tool.box({ size: [0.5, 0.5, 0.5], tag: 'deep' });
      tool.flip(sel.tag('deep'));
      const r = m.difference(tool, { onPartial: 'error' });
      expect(r.status).toBe('failed');
      expect(r.error?.detail).toMatchObject({ fault: 'touching' });
    });
  });

  it('two equal-volume overlapping hollow solids give each cavity to its own shell', () => {
    const m = box(1);
    const tool = model();
    for (const [tag, cx] of [
      ['a', -0.3],
      ['b', 0.3],
    ] as const) {
      tool.box({ size: [1.6, 1.6, 1.6], center: [cx, 0, 0] });
      tool.box({ size: [0.8, 0.8, 0.8], center: [cx, 0, 0], tag });
      tool.flip(sel.tag(tag));
    }
    const r = m.intersection(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(0.872, 6);
  });

  describe('fails closed where a cavity crosses a wall', () => {
    function crossingTool(cavities: [[number, number, number], [number, number, number]][]): Model {
      const t = box(2);
      cavities.forEach(([size, center], i) => {
        t.box({ size, center, tag: `c${i}` });
        t.flip(sel.tag(`c${i}`));
      });
      return t;
    }

    it('a union with a cavity that pokes through its shell is rejected as crossing (M-4)', () => {
      const m = model();
      m.box({ size: [0.8, 0.8, 0.4], center: [-0.3, -0.9, -0.9] });
      const tool = crossingTool([
        [
          [1.3, 0.8, 0.4],
          [0, 0.8, -0.3],
        ],
      ]);
      const r = m.union(tool, { onPartial: 'error' });
      expect(r.status).toBe('failed');
      expect(r.error?.code).toBe('model-precondition');
      expect(r.error?.detail).toMatchObject({ fault: 'crossing' });
      expect(m.validate().volume).toBeCloseTo(0.256, 9);
    });

    it('two cavities that overlap each other are rejected as crossing', () => {
      const tool = crossingTool([
        [
          [0.8, 0.8, 0.8],
          [-0.2, 0, 0],
        ],
        [
          [0.8, 0.8, 0.8],
          [0.2, 0, 0],
        ],
      ]);
      for (const operation of ['union', 'difference', 'intersection'] as const) {
        const m = model();
        m.box({ size: [0.8, 0.8, 0.4], center: [-0.3, -0.9, -0.9] });
        const r = m[operation](tool, { onPartial: 'error' });
        expect(r.status, operation).toBe('failed');
        expect(r.error?.detail, operation).toMatchObject({ fault: 'crossing' });
      }
    });

    it('a cavity with all corners strictly inside its shell is not crossing', () => {
      const m = model();
      m.box({ size: [0.8, 0.8, 0.4], center: [-0.3, -0.9, -0.9] });
      const tool = crossingTool([
        [
          [1.3, 0.8, 0.4],
          [0, 0.2, -0.3],
        ],
      ]);
      const r = m.union(tool, { onPartial: 'error' });
      expect(r.status, r.error?.message).toBe('ok');
    });
  });

  it('a union of a hollow target with a hollow tool keeps the target void inside a tool cavity (M-5)', () => {
    const m = hollow(1.6, 0.5);
    const tool = hollow(2, 1);
    const r = m.union(tool, { onPartial: 'error' });
    expect(r.status, r.error?.message).toBe('ok');
    expect(m.validate().volume).toBeCloseTo(7.875, 6);
  });

  it('accepts two disjoint cavities in one shell with a thin gap between them (L-4)', () => {
    const tool = box(2.2);
    for (const [tag, cx] of [
      ['a', -0.425],
      ['b', 0.425],
    ] as const) {
      tool.box({ size: [0.75, 0.8, 0.8], center: [cx, 0, 0], tag });
      tool.flip(sel.tag(tag));
    }
    const cut = box(1);
    const kept = box(1);
    expect(cut.difference(tool, { onPartial: 'error' }).status).toBe('ok');
    expect(cut.validate().volume).toBeCloseTo(0.576, 6);
    expect(kept.intersection(tool, { onPartial: 'error' }).status).toBe('ok');
    expect(kept.validate().volume).toBeCloseTo(0.424, 6);
  });
});
