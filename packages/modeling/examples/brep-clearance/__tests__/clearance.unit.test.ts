import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHousing } from '../../brep-showcase/housing.ts';
import { assemblyClearance, CASES, renderClearance, standoffPin } from '../clearance.ts';

describe('housing vs standoff pin', () => {
  const parts = buildHousing();
  const run = (offset: number) => {
    const r = assemblyClearance(parts, standoffPin(offset));
    if (!r.ok) throw new Error(`${r.part}: ${r.reason}`);
    return r.value;
  };

  it('is clear at +6: the sleeve wall is the nearest part, 6 away, witnesses 6 apart', () => {
    const c = run(6);
    expect(c.kind).toBe('clear');
    expect(c.part).toBe('sleeve');
    expect(c.gap).toBeCloseTo(6, 5);
    expect(Math.abs(c.pointA[0] - c.pointB[0])).toBeCloseTo(6, 5);
  }, 120000);

  it('is touching at 0 and certifies no depth', () => {
    const c = run(0);
    expect(c.kind).toBe('touching');
    expect(c.part).toBe('sleeve');
    expect(c.gap).toBeLessThan(2e-4);
    expect(c.depth).toBe(0);
  }, 120000);

  it('interferes at -2 with a certified depth of about 2 against the sleeve', () => {
    const c = run(-2);
    expect(c.kind).toBe('interfering');
    expect(c.part).toBe('sleeve');
    expect(c.depth).toBeGreaterThan(1.5);
    expect(c.depth).toBeLessThanOrEqual(3 + 1e-6);
  }, 120000);

  it('renders every case', () => {
    const out = process.env.FORGEAX_CLEARANCE_OUT;
    const dir = out ?? mkdtempSync(join(tmpdir(), 'hc-'));
    try {
      const r = renderClearance(dir, out === undefined ? 240 : 720);
      expect(r.failed).toEqual([]);
      expect(r.sheet).toBe('sheet.png');
      expect(r.cases.map((c) => c.kind)).toEqual(['clear', 'touching', 'interfering']);
      for (const c of CASES)
        expect(readFileSync(join(dir, `${c.name}-iso.png`)).length).toBeGreaterThan(1000);
      if (out !== undefined) writeFileSync(join(out, 'report.json'), JSON.stringify(r, null, 1));
    } finally {
      if (out === undefined) rmSync(dir, { recursive: true });
    }
  }, 240000);
});
