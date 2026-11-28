import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { triangleAspect } from '../geom';
import { model } from '../model';
import { sel } from '../selectors';

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__') out.push(...sources(p));
    } else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('M-B5 triangle aspect has one owner', () => {
  it('only geom.ts defines the triangle aspect', () => {
    const owners = sources(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return (
        /function\s+(aspectOf|triangleAspect)\b/.test(text) ||
        /s \* \(s - e\[0\]\)/.test(text) ||
        /longest \* longest\) \/ \(2 \* A\)/.test(text)
      );
    });
    expect(owners.map((f) => f.slice(SRC.length + 1))).toEqual(['geom.ts']);
  });

  it('meshQuality of a needle agrees with the cross-product definition', () => {
    const m = model();
    const mesh = m.editMesh;
    const h = 1e-7;
    mesh.addFace([mesh.addVertex(0, 0, 0), mesh.addVertex(2, 0, 0), mesh.addVertex(1, h, 0)]);
    const r = m.meshQuality();
    if (!r.ok) throw new Error(r.error.code);
    const cross = (2 * 2) / (2 * (0.5 * 2 * h));
    expect(Math.abs(r.value.aspect.max - cross) / cross).toBeLessThan(1e-6);
    expect(Math.abs(triangleAspect([0, 0, 0], [2, 0, 0], [1, h, 0]) - cross) / cross).toBeLessThan(
      1e-6,
    );
  });

  it('an equilateral triangle is 1.155 and a degenerate one is infinite', () => {
    expect(triangleAspect([0, 0, 0], [1, 0, 0], [0.5, Math.sqrt(3) / 2, 0])).toBeCloseTo(1.1547, 4);
    expect(triangleAspect([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('M-B6 meshQuality rejects non-finite positions', () => {
  it('fails model-degenerate instead of dropping the triangle', () => {
    const m = model();
    m.sphere({ radius: 1, widthSegments: 12, heightSegments: 6 });
    m.triangulate(sel.all());
    const mesh = m.editMesh;
    mesh.pos[(mesh.vertices()[20] as number) * 3] = Number.NaN;
    const r = m.meshQuality();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-degenerate');
  });
});
