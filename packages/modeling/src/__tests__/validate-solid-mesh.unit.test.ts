import { describe, expect, it } from 'vitest';
import { EditMesh } from '../mesh';
import { validateMesh } from '../validate';

/** Unit cube with outward winding: volume +1, every edge closed. */
function cube(): EditMesh {
  const m = new EditMesh();
  const v = [
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [0.5, 0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
  ].map(([x, y, z]) => m.addVertex(x as number, y as number, z as number));
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
  ];
  for (const q of quads) {
    const [a, b, c, d] = q.map((i) => v[i] as number) as [number, number, number, number];
    for (const t of [
      [a, b, c],
      [a, c, d],
    ]) {
      const r = m.addFace(t as number[]);
      if (!r.ok) throw new Error(`addFace failed: ${r.error.code}`);
    }
  }
  return m;
}

describe('validateMesh: solid facts for a mesh input', () => {
  it('a closed mesh reports solid.source mesh with the signed volume', () => {
    const m = cube();
    const report = validateMesh(m, 1e-6);
    expect(report.closed).toBe(true);
    expect(report.solid?.source).toBe('mesh');
    expect(report.solid?.volume).toBeCloseTo(1, 9);
    expect(report.solid?.volume).toBe(report.volume);
  });

  it('falsifier: an open mesh reports no solid', () => {
    const m = cube();
    const f = [...m.faces()][0] as number;
    m.removeFace(f);
    const report = validateMesh(m, 1e-6);
    expect(report.closed).toBe(false);
    expect(report.solid).toBeUndefined();
  });
});
