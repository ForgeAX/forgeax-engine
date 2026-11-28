import { describe, expect, it } from 'vitest';
import { draft } from '../draft';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { expectContract } from './contract';

const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
const sides = sel.all().minus(sel.facing('+y')).minus(sel.facing('-y'));

function block(size: Tuple3): Model {
  const m = model();
  m.box({ size, center: [0, size[1] / 2, 0] });
  return m;
}

function frustum(a1: number, a2: number, h: number): number {
  return (h / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
}

function positionsOn(m: Model, faces: ReturnType<typeof sel.facing>): Tuple3[] {
  const mesh = m.editMesh;
  return faces.evaluate(mesh).flatMap((f) => mesh.faceVertices(f).map((v) => mesh.position(v)));
}

describe('applyDraft', () => {
  it('drafts a square prism about its base into the frustum of the oracle', () => {
    const [s, h, angle] = [0.4, 0.3, 7];
    const m = block([s, h, s]);
    const base = positionsOn(m, sel.facing('-y'));
    const op = m.applyDraft(sides, { angle, direction: [0, 1, 0], neutral: sel.facing('-y') });
    expect(op.status).toBe('ok');
    expectContract(m);
    const top = s - 2 * h * tan(angle);
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(frustum(s * s, top * top, h), 12);
    expect(positionsOn(m, sel.facing('-y'))).toEqual(base);
    for (const p of positionsOn(m, sel.facing('+y'))) {
      expect(Math.abs(p[0])).toBeCloseTo(top / 2, 12);
      expect(Math.abs(p[2])).toBeCloseTo(top / 2, 12);
    }
  });

  it('drafts a rectangle about its top: the prismatoid formula, the base flares', () => {
    const [a, b, h, angle] = [0.5, 0.2, 0.25, 4];
    const m = block([a, h, b]);
    expect(
      m.applyDraft(sides, { angle, direction: [0, 1, 0], neutral: sel.facing('+y') }).status,
    ).toBe('ok');
    const k = 2 * h * tan(angle);
    const bottom: [number, number] = [a + k, b + k];
    const mid: [number, number] = [a + k / 2, b + k / 2];
    const prismatoid = (h / 6) * (a * b + 4 * mid[0] * mid[1] + bottom[0] * bottom[1]);
    expect(m.validate().volume).toBeCloseTo(prismatoid, 12);
  });

  it('agrees with the draft analysis: every wall shows 90 - angle from the direction', () => {
    const angle = 5;
    const m = block([0.3, 0.2, 0.3]);
    const before = draft(m, { direction: [0, 1, 0], faces: sides });
    expect(before.ok && before.value.critical.length).toBe(4);
    m.applyDraft(sides, { angle, direction: [0, 1, 0], neutral: sel.facing('-y') });
    const after = draft(m, { direction: [0, 1, 0], faces: sides });
    if (!after.ok) throw after.error;
    expect(after.value.faces).toHaveLength(4);
    for (const f of after.value.faces) {
      expect(f.angle).toBeCloseTo(90 - angle, 9);
      expect(f.class).toBe('safe');
    }
  });

  it('drafts an L-shaped prism with a concave corner and keeps its base exact', () => {
    const m = model();
    m.box({ size: [0.3, 0.2, 0.3], center: [0, 0.1, 0], segments: [2, 1, 2] });
    m.extrude(sel.near([0.15, 0.1, 0.075]), { distance: 0.15, region: 'merged' });
    const report = m.validate();
    expect(report.closed).toBe(true);
    const base = positionsOn(m, sel.facing('-y'));
    const op = m.applyDraft(sides, { angle: 3, direction: [0, 1, 0], neutral: sel.facing('-y') });
    expect(op.status).toBe('ok');
    expectContract(m);
    expect(positionsOn(m, sel.facing('-y'))).toEqual(base);
    const after = draft(m, { direction: [0, 1, 0], faces: sides });
    if (!after.ok) throw after.error;
    for (const f of after.value.faces) expect(f.angle).toBeCloseTo(87, 9);
    expect(m.validate().volume).toBeLessThan(report.volume);
  });

  it('rejects walls or neutral faces that are not a prism about the direction', () => {
    const tilted = block([0.3, 0.2, 0.3]);
    tilted.rotate(sel.all(), 'x', 10);
    const wall = tilted.applyDraft(sides, {
      angle: 3,
      direction: [0, 1, 0],
      neutral: sel.facing('-z', 30),
    });
    expect(wall.error?.code).toBe('model-precondition');
    expect(wall.error?.detail).toMatchObject({ reason: 'draft-non-prism' });

    const cylinder = model();
    cylinder.cylinder({ radiusTop: 0.1, radiusBottom: 0.1, height: 0.2, radialSegments: 12 });
    const curved = cylinder.applyDraft(sel.all(), {
      angle: 3,
      direction: [0, 1, 0],
      neutral: sel.facing('-y'),
    });
    expect(curved.error?.code).toBe('model-precondition');
    expect(curved.error?.detail).toMatchObject({ reason: 'draft-non-prism' });
  });

  it('rejects a bad angle or direction and walls that would cross', () => {
    for (const options of [
      { angle: 0, direction: [0, 1, 0] as Tuple3 },
      { angle: 45, direction: [0, 1, 0] as Tuple3 },
      { angle: 3, direction: [0, 0, 0] as Tuple3 },
    ]) {
      const m = block([0.3, 0.2, 0.3]);
      expect(m.applyDraft(sides, { ...options, neutral: sel.facing('-y') }).error?.code).toBe(
        'model-invalid-argument',
      );
    }
    const tall = block([0.1, 1, 0.1]);
    expect(
      tall.applyDraft(sides, { angle: 20, direction: [0, 1, 0], neutral: sel.facing('-y') }).error
        ?.code,
    ).toBe('model-degenerate');
  });

  it('records the neutral selector as a description', () => {
    const m = block([0.3, 0.2, 0.3]);
    m.applyDraft(sides, { angle: 2, direction: [0, 1, 0], neutral: sel.facing('-y') });
    const args = m.journal.at(-1)?.args as { neutral: unknown; angle: number };
    expect(typeof args.neutral).toBe('string');
    expect(args.angle).toBe(2);
  });
});
